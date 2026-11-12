/* DEFENX authenticated browser-to-browser camera streaming.
 * WebRTC carries video peer-to-peer; the existing Durable Object only relays
 * authenticated SDP/ICE signaling. Local preview remains owned by phone-camera.js.
 */
(() => {
  "use strict";
  if (!("RTCPeerConnection" in window) || !("WebSocket" in window)) return;

  const $ = id => document.getElementById(id);
  const makePeerId = () => (window.crypto?.randomUUID?.() || (
    Array.from(crypto.getRandomValues(new Uint8Array(16))).map(x => x.toString(16).padStart(2, "0")).join("")
  )).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  let peerId = makePeerId();
  // Free STUN-only configuration: try independent public STUN services.
  // STUN does not relay media and does not create a TURN usage charge.
  const fallbackIceServers = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ];
  let iceServers = fallbackIceServers.slice();
  let iceConfigPromise = null;
  async function loadIceServers() {
    if (!iceConfigPromise) {
      iceConfigPromise = fetch("/api/rtc/ice-config", {
        credentials: "same-origin",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      }).then(response => {
        if (!response.ok) throw new Error("ICE configuration unavailable");
        return response.json();
      }).then(config => {
        if (Array.isArray(config?.iceServers) && config.iceServers.length) {
          // Strict free-only mode: accept STUN URLs only. Never use TURN relays,
          // even if TURN credentials are later added to the server configuration.
          const combined = [...config.iceServers, ...fallbackIceServers];
          const seen = new Set();
          iceServers = combined.map(server => {
            const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
              .filter(url => typeof url === "string" && url.trim().toLowerCase().startsWith("stun:"));
            return urls.length ? { urls } : null;
          }).filter(server => {
            if (!server) return false;
            const key = server.urls.slice().sort().join("|");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (!iceServers.length) iceServers = fallbackIceServers.slice();
        }
        return iceServers;
      }).catch(() => {
        iceConfigPromise = null; // allow a later retry if the endpoint was temporarily unavailable
        return iceServers;
      });
    }
    return iceConfigPromise;
  }

  let socket = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let retryDelay = 1000;
  const offersInFlight = new Set();
  let localStream = null;
  let stopped = false;
  const peers = new Map();
  let fallbackCameraNode = null;

  function status(message, remote = false) {
    const scene = $("cameraSceneLabel");
    const state = $("cameraStatus");
    if (remote && !localStream && scene) scene.textContent = message;
    if (state) state.textContent = localStream && remote ? "LOCAL + REMOTE CAMERA LIVE" :
      localStream ? "PHONE CAMERA LIVE" : remote ? "REMOTE CAMERA LIVE" : message;
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(payload)); return true; } catch (_) { return false; }
  }

  function updateRemoteLayout(video) {
    if (!video) return;
    const primary = !localStream && video.id === "roverRealCamera";
    if (!primary) {
      video.style.cssText = "display:block!important;position:absolute;top:12px;right:12px;left:auto;bottom:auto;width:36%;height:34%;max-width:240px;max-height:180px;object-fit:cover;background:#02070b;z-index:12;border:2px solid rgba(91,220,185,.9);border-radius:10px;box-shadow:0 8px 24px #0009";
    } else {
      video.style.cssText = "display:block!important;visibility:visible!important;opacity:1!important;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#02070b;z-index:7";
    }
  }

  function promoteRemoteVideo(video) {
    if (!video || localStream) return;
    const current = $("roverRealCamera");
    if (current && current !== video && current.dataset.defenxRemoteCamera !== "1") {
      fallbackCameraNode = current;
      current.id = "defenxFallbackCamera";
      current.style.display = "none";
    } else if (current && current !== video && current.dataset.defenxRemoteCamera === "1") {
      current.id = "defenxRemoteCamera-" + (current.dataset.defenxPeerId || "previous");
      updateRemoteLayout(current);
    }
    video.id = "roverRealCamera";
    updateRemoteLayout(video);
  }

  function restoreFallbackCamera() {
    if (localStream || document.querySelector("[data-defenx-remote-camera='1']")) return;
    const current = $("roverRealCamera");
    if (current && current.dataset.defenxRemoteReused === "1") {
      current.pause();
      current.srcObject = null;
      delete current.dataset.defenxRemoteCamera;
      delete current.dataset.defenxPeerId;
      delete current.dataset.defenxRemoteReused;
      delete current.dataset.defenxLiveStream;
      current.style.display = "none";
      return;
    }
    if (current && current.dataset.defenxRemoteCamera === "1") current.remove();
    if (fallbackCameraNode && fallbackCameraNode.isConnected) {
      fallbackCameraNode.id = "roverRealCamera";
      fallbackCameraNode.style.display = "";
      fallbackCameraNode = null;
    }
  }

  function showRemoteVideo(id, stream) {
    const viewport = $("cameraViewport");
    if (!viewport) return;
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    let video = document.querySelector("[data-defenx-remote-camera='1'][data-defenx-peer-id='" + safeId + "']");
    if (!video) {
      const current = $("roverRealCamera");
      const canReuseEmptySource = !localStream && current && current.tagName === "VIDEO" &&
        current.dataset.defenxLiveStream !== "1" && !current.srcObject && !current.currentSrc && !current.getAttribute("src");
      video = canReuseEmptySource ? current : document.createElement("video");
      video.dataset.defenxLiveStream = "1";
      video.dataset.defenxRemoteCamera = "1";
      video.dataset.defenxPeerId = safeId;
      if (canReuseEmptySource) video.dataset.defenxRemoteReused = "1";
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-label", "Live camera from another authenticated DEFENX device");
      video.title = "Live camera from another DEFENX device";
      if (!canReuseEmptySource) viewport.appendChild(video);
    }
    video.srcObject = stream;
    if (!localStream) promoteRemoteVideo(video);
    else {
      if (video.id === "roverRealCamera") video.id = "defenxRemoteCamera-" + safeId;
      updateRemoteLayout(video);
    }
    window.__defenxRemoteCameraActive = true;
    const scene = $("camera3DScene");
    if (scene && !localStream) scene.style.display = "none";
    const placeholder = $("camPlaceholder");
    if (placeholder) placeholder.hidden = true;
    const badge = document.querySelector("#liveCamera .liveBadge");
    if (badge) { badge.innerHTML = "<i></i> REMOTE LIVE"; badge.classList.remove("mvOff"); }
    status("REMOTE DEVICE CAMERA • LIVE", true);
    const play = video.play();
    if (play && play.catch) play.catch(() => status("REMOTE CAMERA READY • TAP VIDEO TO PLAY", true));
  }

  function setRemoteCameraActive(id, active) {
    const safeId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const video = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxPeerId === safeId);
    if (!video) return;
    video.style.visibility = active ? "visible" : "hidden";
    video.dataset.defenxCameraActive = active ? "1" : "0";
    if (active) {
      updateRemoteLayout(video);
      const play = video.play();
      if (play && play.catch) play.catch(() => {});
      status("REMOTE DEVICE CAMERA • LIVE", true);
    } else if (!localStream && video.id === "roverRealCamera") {
      status("REMOTE DEVICE CAMERA • PAUSED", true);
    }
  }

  function removeRemoteVideo(id) {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const video = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxPeerId === safeId);
    const wasPrimary = !!video && video.id === "roverRealCamera";
    if (video) {
      video.pause();
      video.srcObject = null;
      if (video.dataset.defenxRemoteReused === "1") {
        delete video.dataset.defenxRemoteCamera;
        delete video.dataset.defenxPeerId;
        delete video.dataset.defenxRemoteReused;
        delete video.dataset.defenxLiveStream;
        video.style.display = "none";
      } else video.remove();
    }
    const nextRemote = document.querySelector("[data-defenx-remote-camera='1']");
    if (!localStream && nextRemote && (wasPrimary || !$("roverRealCamera"))) promoteRemoteVideo(nextRemote);
    if (!localStream && !document.querySelector("[data-defenx-remote-camera='1']")) {
      restoreFallbackCamera();
      window.__defenxRemoteCameraActive = false;
      const badge = document.querySelector("#liveCamera .liveBadge");
      if (badge) { badge.innerHTML = "<i></i> CHECKING"; badge.classList.add("mvOff"); }
      const scene = $("camera3DScene");
      if (scene && !$("roverRealCamera")?.dataset?.defenxLiveStream) scene.style.display = "";
      status("REMOTE CAMERA OFFLINE");
    } else {
      window.__defenxRemoteCameraActive = !!document.querySelector("[data-defenx-remote-camera='1']");
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    try { peer.pc.close(); } catch (_) {}
    removeRemoteVideo(id);
  }

  async function createPeer(id) {
    if (peers.has(id)) return peers.get(id);
    await loadIceServers();
    if (peers.has(id)) return peers.get(id);
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });
    const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
    const entry = { pc, transceiver, pendingIce: [], restartAttempts: 0 };
    peers.set(id, entry);

    if (localStream) {
      const track = localStream.getVideoTracks()[0];
      if (track) transceiver.sender.replaceTrack(track).catch(() => {});
    }
    pc.onicecandidate = event => {
      if (event.candidate) send({
        type: "rtc_signal",
        target: id,
        signal: { type: "ice", candidate: event.candidate.toJSON() }
      });
    };
    pc.ontrack = event => {
      const stream = event.streams && event.streams[0]
        ? event.streams[0] : new MediaStream([event.track]);
      showRemoteVideo(id, stream);
      event.track.addEventListener("unmute", () => setRemoteCameraActive(id, true));
      event.track.addEventListener("mute", () => setRemoteCameraActive(id, false));
      event.track.addEventListener("ended", () => removeRemoteVideo(id), { once: true });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "checking") {
        status("CAMERA LINK • CHECKING FREE DIRECT ROUTE");
      } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        status(localStream ? "LOCAL + REMOTE CAMERA LIVE" : "REMOTE CAMERA LIVE", true);
      } else if (pc.iceConnectionState === "disconnected") {
        status("CAMERA LINK INTERRUPTED • RETRYING");
      } else if (pc.iceConnectionState === "failed") {
        status("DIRECT CAMERA LINK FAILED • FREE STUN RETRY");
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && entry.restartAttempts < 2 && peerId < id) {
        entry.restartAttempts++;
        try { pc.restartIce(); } catch (_) {}
        makeOffer(id, true).catch(() => {});
      } else if (pc.connectionState === "connected") {
        retryDelay = 1000;
        status(localStream ? "LOCAL + REMOTE DEVICE LINK LIVE" : "REMOTE DEVICE LINK LIVE", true);
      } else if (pc.connectionState === "failed") {
        status("CAMERA LINK FAILED • NETWORK RELAY MAY BE REQUIRED");
      }
    };
    return entry;
  }

  async function makeOffer(id, iceRestart = false) {
    if (offersInFlight.has(id)) return;
    offersInFlight.add(id);
    try {
      const entry = await createPeer(id);
      if (entry.pc.signalingState !== "stable") return;
      const offer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await entry.pc.setLocalDescription(offer);
      send({ type: "rtc_signal", target: id, signal: {
        type: "offer", sdp: entry.pc.localDescription.sdp
      }});
    } finally {
      offersInFlight.delete(id);
    }
  }

  async function handleSignal(from, signal) {
    if (!from || from === peerId || !signal || typeof signal !== "object") return;
    const entry = await createPeer(from);
    const pc = entry.pc;
    if (signal.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      for (const candidate of entry.pendingIce.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch (_) {}
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "rtc_signal", target: from, signal: {
        type: "answer", sdp: pc.localDescription.sdp
      }});
    } else if (signal.type === "answer") {
      if (pc.signalingState === "have-local-offer") {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        for (const candidate of entry.pendingIce.splice(0)) {
          try { await pc.addIceCandidate(candidate); } catch (_) {}
        }
      }
    } else if (signal.type === "ice" && signal.candidate) {
      const candidate = new RTCIceCandidate(signal.candidate);
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else entry.pendingIce.push(candidate);
    }
  }

  function attachLocalStream(stream) {
    localStream = stream || null;
    for (const [id, entry] of peers) {
      const track = localStream && localStream.getVideoTracks()[0] || null;
      entry.transceiver.sender.replaceTrack(track).catch(() => {});
    }
    send({ type: "rtc_camera", active: !!localStream });
    const remoteVideos = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"));
    if (localStream) {
      remoteVideos.forEach(video => {
        if (video.id === "roverRealCamera") video.id = "defenxRemoteCamera-" + (video.dataset.defenxPeerId || "remote");
        updateRemoteLayout(video);
      });
      status(remoteVideos.length ? "LOCAL + REMOTE CAMERA LIVE" : "PHONE CAMERA LIVE", true);
    } else if (remoteVideos.length) {
      promoteRemoteVideo(remoteVideos[0]);
      remoteVideos.slice(1).forEach(updateRemoteLayout);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "pong") {
      clearTimeout(pongTimer);
      pongTimer = null;
      return;
    }
    if (message.type === "rtc_peer_list") {
      (message.peers || []).forEach(peer => {
        if (!peer || !peer.id || peer.id === peerId) return;
        if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
        else createPeer(peer.id).catch(() => {});
      });
    } else if (message.type === "rtc_peer_joined") {
      const peer = message.peer || {};
      if (!peer.id || peer.id === peerId) return;
      if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
      else createPeer(peer.id).catch(() => {});
    } else if (message.type === "rtc_peer_left") {
      closePeer(message.peer_id);
    } else if (message.type === "rtc_camera") {
      setRemoteCameraActive(message.peer_id, !!message.active);
    } else if (message.type === "rtc_signal") {
      handleSignal(message.from, message.signal).catch(() => status("CAMERA CONNECTION RETRYING"));
    } else if (message.type === "rtc_error") {
      status("CAMERA SYNC: " + String(message.error || "connection error").toUpperCase());
    }
  }

  function connect() {
    if (stopped || socket || !navigator.onLine) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(scheme + "//" + location.host + "/api/ws");
    socket = ws;
    ws.onopen = () => {
      retryDelay = 1000;
      send({ type: "rtc_join", peer_id: peerId });
      if (localStream) send({ type: "rtc_camera", active: true });
      status(localStream ? "LOCAL CAMERA • CONNECTING TO DEVICES" : "CAMERA SYNC CONNECTED");
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        send({ type: "ping", t: Date.now() });
        clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          try { ws.close(4000, "Camera sync heartbeat timeout"); } catch (_) {}
        }, 10000);
      }, 20000);
    };
    ws.onmessage = event => {
      try { handleMessage(JSON.parse(event.data)); } catch (_) {}
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onclose = () => {
      clearInterval(heartbeatTimer);
      clearTimeout(pongTimer);
      heartbeatTimer = null;
      pongTimer = null;
      if (socket === ws) socket = null;
      for (const id of Array.from(peers.keys())) closePeer(id);
      peerId = makePeerId();
      if (!stopped) {
        status("CAMERA SYNC RECONNECTING");
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 1.8, 15000);
      }
    };
  }

  window.addEventListener("defenx-camera-stream", event => {
    const detail = event.detail || {};
    attachLocalStream(detail.active ? detail.stream : null);
  });
  window.addEventListener("online", connect);
  window.addEventListener("offline", () => status("CAMERA SYNC OFFLINE"));
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(heartbeatTimer);
    clearTimeout(pongTimer);
    for (const id of Array.from(peers.keys())) closePeer(id);
    if (socket) { try { socket.close(1000, "page hidden"); } catch (_) {} }
    socket = null;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect, { once: true });
  } else {
    connect();
  }
})();
