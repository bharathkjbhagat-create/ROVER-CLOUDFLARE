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
          // TURN is used only when the authenticated server explicitly enables it.
          // Cloudflare issues short-lived credentials; never accept unauthenticated
          // relay URLs or expose a long-lived TURN key to this browser.
          const combined = [...config.iceServers, ...fallbackIceServers];
          const seen = new Set();
          const turnEnabled = config.turnEnabled === true;
          iceServers = combined.map(server => {
            if (!server || typeof server !== "object") return null;
            const sourceUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
            const urls = sourceUrls.filter(url =>
              typeof url === "string" && /^(stun|stuns|turn|turns):/i.test(url.trim())
            );
            const hasCredentials = typeof server.username === "string" && server.username.length > 0
              && typeof server.credential === "string" && server.credential.length > 0;
            const safeUrls = urls.filter(url => {
              const isRelay = /^turns?:/i.test(url.trim());
              return !isRelay || (turnEnabled && hasCredentials);
            });
            if (!safeUrls.length) return null;
            const entry = { urls: safeUrls };
            if (turnEnabled && hasCredentials && safeUrls.some(url => /^turns?:/i.test(url.trim()))) {
              entry.username = server.username;
              entry.credential = server.credential;
            }
            return entry;
          }).filter(server => {
            if (!server) return false;
            const key = JSON.stringify([
              server.urls.slice().sort(),
              server.username || "",
              server.credential || ""
            ]);
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
  let roomJoined = false;
  let lastSentCameraState = null;
  let retryTimer = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let retryDelay = 1000;
  const offersInFlight = new Set();
  let localStream = null;
  let stopped = false;
  const peers = new Map();
  // Share in-progress peer creation. Multiple room/signal events can arrive
  // while ICE configuration is loading; without this lock they can create
  // competing RTCPeerConnections for the same remote device.
  const peerCreations = new Map();
  // Serialize SDP/ICE operations per peer. WebSocket messages can arrive while
  // setRemoteDescription is still pending; concurrent handlers can otherwise
  // apply ICE too early or race an answer against an offer.
  const signalQueues = new Map();
  const remoteCameraStates = new Map();
  let fallbackCameraNode = null;

  function status(message, remote = false) {
    const scene = $("cameraSceneLabel");
    const state = $("cameraStatus");
    if (remote && !localStream && scene) scene.textContent = message;
    if (state) state.textContent = localStream && remote ? "LOCAL + REMOTE CAMERA LIVE" :
      localStream ? "PHONE CAMERA LIVE" : remote ? "REMOTE CAMERA LIVE" : message;
    updateSyncStatus();
  }

  function updateSyncStatus() {
    const node = $("cameraSyncStatus");
    if (!node) return;
    const connected = Array.from(peers.values()).filter(entry => entry.pc.connectionState === "connected").length;
    const failed = Array.from(peers.values()).some(entry => entry.pc.connectionState === "failed");
    let message, state;
    if (!navigator.onLine) { message = "DEVICE SYNC OFFLINE"; state = "error"; }
    else if (!socket || socket.readyState !== WebSocket.OPEN) { message = "DEVICE SYNC RECONNECTING"; state = "error"; }
    else if (!roomJoined) { message = "DEVICE SYNC CONNECTING"; state = "waiting"; }
    else if (failed) { message = "CAMERA LINK FAILED • CHECK NETWORK / TURN"; state = "error"; }
    else if (connected) { message = localStream ? "CAMERA SYNC LIVE • " + connected + " OTHER DEVICE" + (connected === 1 ? "" : "S") : "REMOTE CAMERA SYNC LIVE"; state = "connected"; }
    else if (peers.size) { message = "OTHER DEVICE FOUND • CONNECTING CAMERA"; state = "waiting"; }
    else { message = "DEVICE SYNC ONLINE • WAITING FOR SECOND DEVICE"; state = "waiting"; }
    node.textContent = message;
    node.dataset.state = state;
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
    if (localStream) return;
    const remoteVideos = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"));
    const hasActiveRemoteVideo = remoteVideos.some(video => video.dataset.defenxCameraActive === "1");
    const hasActiveRemoteSignal = Array.from(remoteCameraStates.values()).some(Boolean);
    if (hasActiveRemoteVideo || hasActiveRemoteSignal) return;

    const current = $("roverRealCamera");
    if (current && current.dataset.defenxRemoteCamera === "1") {
      current.id = "defenxRemoteCamera-" + (current.dataset.defenxPeerId || "paused");
      current.style.visibility = "hidden";
      updateRemoteLayout(current);
    }
    if (fallbackCameraNode && fallbackCameraNode.isConnected) {
      fallbackCameraNode.id = "roverRealCamera";
      fallbackCameraNode.style.display = "";
      const viewport = $("cameraViewport");
      if (viewport && fallbackCameraNode.parentElement === viewport) {
        // Reinsert to notify the live-camera and AI source observers of the hand-off.
        viewport.appendChild(fallbackCameraNode);
      }
      fallbackCameraNode = null;
    } else if (!$("roverRealCamera")) {
      const scene = $("camera3DScene");
      if (scene) scene.style.display = "";
    }
  }

  function showRemoteVideo(id, stream) {
    const viewport = $("cameraViewport");
    if (!viewport) return;
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    let video = document.querySelector("[data-defenx-remote-camera='1'][data-defenx-peer-id='" + safeId + "']");
    if (!video) {
      // Always append a distinct stream element. Reusing the pre-existing empty
      // placeholder would not trigger ai-vision.js's child-list observer.
      video = document.createElement("video");
      video.dataset.defenxLiveStream = "1";
      video.dataset.defenxRemoteCamera = "1";
      video.dataset.defenxPeerId = safeId;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("aria-label", "Live camera from another authenticated DEFENX device");
      video.title = "Live camera from another DEFENX device";
      viewport.appendChild(video);
    }
    video.srcObject = stream;
    const tracks = typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks() : [];
    const trackIsLive = tracks.some(track => track.readyState === "live" && track.enabled && !track.muted);
    video.dataset.defenxCameraActive = (remoteCameraStates.get(safeId) === true || trackIsLive) ? "1" : "0";
    if (trackIsLive) remoteCameraStates.set(safeId, true);
    if (!localStream && video.dataset.defenxCameraActive === "1") promoteRemoteVideo(video);
    else {
      if (video.id === "roverRealCamera") video.id = "defenxRemoteCamera-" + safeId;
      updateRemoteLayout(video);
    }
    video.style.visibility = video.dataset.defenxCameraActive === "1" ? "visible" : "hidden";
    const remoteActive = updateRemoteCameraActiveFlag();
    const scene = $("camera3DScene");
    if (scene && !localStream && remoteActive) scene.style.display = "none";
    const placeholder = $("camPlaceholder");
    if (placeholder && remoteActive) placeholder.hidden = true;
    const badge = document.querySelector("#liveCamera .liveBadge");
    if (badge) {
      badge.innerHTML = remoteActive ? "<i></i> REMOTE LIVE" : "<i></i> CONNECTING";
      badge.classList.toggle("mvOff", !remoteActive);
    }
    status(remoteActive ? "REMOTE DEVICE CAMERA • LIVE" : "REMOTE DEVICE CAMERA • CONNECTING", remoteActive);
    const play = video.play();
    if (play && play.catch) play.catch(() => status("REMOTE CAMERA READY • TAP VIDEO TO PLAY", true));
  }

  function updateRemoteCameraActiveFlag() {
    const activeFromSignal = Array.from(remoteCameraStates.values()).some(Boolean);
    const activeFromVideo = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .some(video => video.dataset.defenxCameraActive === "1");
    window.__defenxRemoteCameraActive = activeFromSignal || activeFromVideo;
    return window.__defenxRemoteCameraActive;
  }

  function setRemoteCameraActive(id, active) {
    const safeId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!safeId) return;
    remoteCameraStates.set(safeId, active === true);
    const video = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxPeerId === safeId);
    if (video) {
      video.dataset.defenxCameraActive = active ? "1" : "0";
      video.style.visibility = active ? "visible" : "hidden";
      if (active) {
        if (!localStream) promoteRemoteVideo(video);
        updateRemoteLayout(video);
        const play = video.play();
        if (play && play.catch) play.catch(() => {});
      }
    }
    const remoteActive = updateRemoteCameraActiveFlag();
    if (!localStream && remoteActive) {
      const activeVideo = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
        .find(node => node.dataset.defenxCameraActive === "1");
      if (activeVideo) promoteRemoteVideo(activeVideo);
    } else if (!localStream && !remoteActive) {
      restoreFallbackCamera();
    }
    if (active) {
      if (video) {
        const placeholder = $("camPlaceholder");
        if (placeholder) placeholder.hidden = true;
        const badge = document.querySelector("#liveCamera .liveBadge");
        if (badge) { badge.innerHTML = "<i></i> REMOTE LIVE"; badge.classList.remove("mvOff"); }
      }
      status(video ? "REMOTE DEVICE CAMERA • LIVE" : "REMOTE DEVICE CAMERA • CONNECTING", !!video);
    } else if (localStream) {
      status(remoteActive ? "LOCAL + REMOTE CAMERA LIVE" : "PHONE CAMERA LIVE");
    } else if (!remoteActive) {
      status("REMOTE DEVICE CAMERA • PAUSED");
      const badge = document.querySelector("#liveCamera .liveBadge");
      if (badge) { badge.innerHTML = "<i></i> PAUSED"; badge.classList.add("mvOff"); }
    }
  }

  function removeRemoteVideo(id) {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    remoteCameraStates.delete(safeId);
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
    const nextActiveRemote = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxCameraActive === "1");
    if (!localStream && nextActiveRemote && (wasPrimary || !$("roverRealCamera"))) promoteRemoteVideo(nextActiveRemote);
    const remoteActive = updateRemoteCameraActiveFlag();
    if (!localStream && !document.querySelector("[data-defenx-remote-camera='1']")) {
      restoreFallbackCamera();
      const badge = document.querySelector("#liveCamera .liveBadge");
      if (badge) { badge.innerHTML = "<i></i> CHECKING"; badge.classList.add("mvOff"); }
      const scene = $("camera3DScene");
      if (scene && !$("roverRealCamera")?.dataset?.defenxLiveStream) scene.style.display = "";
      status("REMOTE CAMERA OFFLINE");
    } else if (!localStream && !remoteActive) {
      restoreFallbackCamera();
      const badge = document.querySelector("#liveCamera .liveBadge");
      if (badge) { badge.innerHTML = "<i></i> PAUSED"; badge.classList.add("mvOff"); }
      status("REMOTE DEVICE CAMERA • PAUSED");
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (peer) {
      peers.delete(id);
      try { peer.pc.close(); } catch (_) {}
    }
    remoteCameraStates.delete(id);
    removeRemoteVideo(id);
  }

  async function createPeer(id) {
    if (peers.has(id)) return peers.get(id);
    if (peerCreations.has(id)) return peerCreations.get(id);
    const creation = (async () => {
      await loadIceServers();
      if (peers.has(id)) return peers.get(id);
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all",
        iceCandidatePoolSize: 4,
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
      pc.onconnectionstatechange = () => {
        updateSyncStatus();
        if (pc.connectionState === "failed" && entry.restartAttempts < 2 && peerId < id) {
          entry.restartAttempts++;
          try { pc.restartIce(); } catch (_) {}
          makeOffer(id, true).catch(() => {});
        } else if (pc.connectionState === "connected") {
          retryDelay = 1000;
          status(localStream ? "LOCAL + REMOTE DEVICE LINK LIVE" : "REMOTE DEVICE LINK LIVE", true);
        } else if (pc.connectionState === "failed") {
          setRemoteCameraActive(id, false);
          status("CAMERA LINK FAILED • CHECK NETWORK CONNECTION");
        }
      };
      return entry;
    })();
    peerCreations.set(id, creation);
    try {
      return await creation;
    } finally {
      if (peerCreations.get(id) === creation) peerCreations.delete(id);
    }
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

  function handleSignal(from, signal) {
    if (!from || from === peerId || !signal || typeof signal !== "object") return Promise.resolve();
    const previous = signalQueues.get(from) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => processSignal(from, signal));
    signalQueues.set(from, next);
    return next.finally(() => {
      if (signalQueues.get(from) === next) signalQueues.delete(from);
    });
  }

  async function processSignal(from, signal) {
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
    const cameraActive = !!localStream;
    if (roomJoined && lastSentCameraState !== cameraActive) {
      send({ type: "rtc_camera", active: cameraActive });
      lastSentCameraState = cameraActive;
    }
    const remoteVideos = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"));
    const activeRemoteVideos = remoteVideos.filter(video => video.dataset.defenxCameraActive === "1");
    if (localStream) {
      remoteVideos.forEach(video => {
        if (video.id === "roverRealCamera") video.id = "defenxRemoteCamera-" + (video.dataset.defenxPeerId || "remote");
        updateRemoteLayout(video);
        video.style.visibility = video.dataset.defenxCameraActive === "1" ? "visible" : "hidden";
      });
      status(activeRemoteVideos.length ? "LOCAL + REMOTE CAMERA LIVE" : "PHONE CAMERA LIVE");
    } else if (activeRemoteVideos.length) {
      promoteRemoteVideo(activeRemoteVideos[0]);
      remoteVideos.filter(video => video !== activeRemoteVideos[0]).forEach(updateRemoteLayout);
    } else if (updateRemoteCameraActiveFlag()) {
      remoteVideos.forEach(video => { video.style.visibility = "hidden"; });
      status("REMOTE DEVICE CAMERA • CONNECTING");
    } else if (remoteVideos.length) {
      remoteVideos.forEach(video => { video.style.visibility = "hidden"; });
      restoreFallbackCamera();
      status("REMOTE DEVICE CAMERA • PAUSED");
    } else {
      restoreFallbackCamera();
    }
    updateRemoteCameraActiveFlag();
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "pong") {
      clearTimeout(pongTimer);
      pongTimer = null;
      return;
    }
    if (message.type === "rtc_peer_list") {
      roomJoined = true;
      remoteCameraStates.clear();
      (message.peers || []).forEach(peer => {
        if (!peer || !peer.id || peer.id === peerId) return;
        remoteCameraStates.set(String(peer.id), peer.camera === true);
        if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
        else createPeer(peer.id).catch(() => {});
      });
      updateRemoteCameraActiveFlag();
      const cameraActive = !!localStream;
      if (lastSentCameraState !== cameraActive) {
        send({ type: "rtc_camera", active: cameraActive });
        lastSentCameraState = cameraActive;
      }
      updateSyncStatus();
    } else if (message.type === "rtc_peer_joined") {
      const peer = message.peer || {};
      if (!peer.id || peer.id === peerId) return;
      remoteCameraStates.set(String(peer.id), peer.camera === true);
      updateRemoteCameraActiveFlag();
      if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
      else createPeer(peer.id).catch(() => {});
      updateSyncStatus();
    } else if (message.type === "rtc_peer_left") {
      remoteCameraStates.delete(String(message.peer_id || ""));
      closePeer(message.peer_id);
      updateRemoteCameraActiveFlag();
      updateSyncStatus();
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
      roomJoined = false;
      lastSentCameraState = null;
      updateSyncStatus();
      send({ type: "rtc_join", peer_id: peerId });
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
      roomJoined = false;
      lastSentCameraState = null;
      remoteCameraStates.clear();
      for (const id of Array.from(peers.keys())) closePeer(id);
      updateRemoteCameraActiveFlag();
      updateSyncStatus();
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
  window.addEventListener("offline", () => { status("CAMERA SYNC OFFLINE"); updateSyncStatus(); });
  window.addEventListener("online", updateSyncStatus);
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

