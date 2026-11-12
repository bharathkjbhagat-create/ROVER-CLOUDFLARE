/* DEFENX authenticated browser-to-browser camera streaming.
 * WebRTC carries video peer-to-peer; the existing Durable Object only relays
 * authenticated SDP/ICE signaling. Local preview remains owned by phone-camera.js.
 */
(() => {
  "use strict";
  if (!("RTCPeerConnection" in window) || !("WebSocket" in window)) return;

  const $ = id => document.getElementById(id);
  const peerId = (window.crypto?.randomUUID?.() || (
    Array.from(crypto.getRandomValues(new Uint8Array(16))).map(x => x.toString(16).padStart(2, "0")).join("")
  )).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const iceServers = Array.isArray(window.DEFENX_RTC_ICE_SERVERS) && window.DEFENX_RTC_ICE_SERVERS.length
    ? window.DEFENX_RTC_ICE_SERVERS
    : [{ urls: "stun:stun.l.google.com:19302" }];

  let socket = null;
  let retryTimer = null;
  let retryDelay = 1000;
  let localStream = null;
  let stopped = false;
  const peers = new Map();

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
    if (localStream) {
      video.style.cssText = "display:block!important;position:absolute;top:12px;right:12px;left:auto;bottom:auto;width:36%;height:34%;max-width:240px;max-height:180px;object-fit:cover;background:#02070b;z-index:12;border:2px solid rgba(91,220,185,.9);border-radius:10px;box-shadow:0 8px 24px #0009";
    } else {
      video.style.cssText = "display:block!important;position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#02070b;z-index:8";
    }
  }

  function showRemoteVideo(id, stream) {
    const viewport = $("cameraViewport");
    if (!viewport) return;
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const primarySource = !localStream && !$("roverRealCamera");
    const videoId = primarySource ? "roverRealCamera" : "defenxRemoteCamera-" + safeId;
    let video = document.querySelector("[data-defenx-remote-camera='1'][data-defenx-peer-id='" + safeId + "']");
    if (!video) {
      video = document.createElement("video");
      video.id = videoId;
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
    updateRemoteLayout(video);
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

  function removeRemoteVideo(id) {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const video = Array.from(document.querySelectorAll("[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxPeerId === safeId);
    if (video) { video.pause(); video.srcObject = null; video.remove(); }
    const nextRemote = document.querySelector("[data-defenx-remote-camera='1']");
    if (nextRemote && !$("roverRealCamera") && !localStream) nextRemote.id = "roverRealCamera";
    if (!document.querySelector("[data-defenx-remote-camera='1']")) {
      const badge = document.querySelector("#liveCamera .liveBadge");
      if (badge && !localStream) { badge.innerHTML = "<i></i> CHECKING"; badge.classList.add("mvOff"); }
      if (!localStream) {
        const scene = $("camera3DScene");
        if (scene) scene.style.display = "";
        status("REMOTE CAMERA OFFLINE");
      }
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    peers.delete(id);
    try { peer.pc.close(); } catch (_) {}
    removeRemoteVideo(id);
  }

  function createPeer(id) {
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
      event.track.addEventListener("ended", () => removeRemoteVideo(id), { once: true });
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
    const entry = createPeer(id);
    const offer = await entry.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await entry.pc.setLocalDescription(offer);
    send({ type: "rtc_signal", target: id, signal: {
      type: "offer", sdp: entry.pc.localDescription.sdp
    }});
  }

  async function handleSignal(from, signal) {
    if (!from || from === peerId || !signal || typeof signal !== "object") return;
    const entry = createPeer(from);
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
    remoteVideos.forEach(video => {
      if (localStream && video.id === "roverRealCamera") video.id = "defenxRemoteCamera-" + (video.dataset.defenxPeerId || "remote");
      updateRemoteLayout(video);
    });
    if (!localStream && !$("roverRealCamera") && remoteVideos[0]) remoteVideos[0].id = "roverRealCamera";
    if (localStream) status("LOCAL + REMOTE CAMERA LIVE", true);
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "rtc_peer_list") {
      (message.peers || []).forEach(peer => {
        if (!peer || !peer.id || peer.id === peerId) return;
        createPeer(peer.id);
        if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
      });
    } else if (message.type === "rtc_peer_joined") {
      const peer = message.peer || {};
      if (!peer.id || peer.id === peerId) return;
      createPeer(peer.id);
      if (peerId < peer.id) makeOffer(peer.id).catch(() => {});
    } else if (message.type === "rtc_peer_left") {
      closePeer(message.peer_id);
    } else if (message.type === "rtc_camera") {
      if (!message.active) removeRemoteVideo(message.peer_id);
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
    };
    ws.onmessage = event => {
      try { handleMessage(JSON.parse(event.data)); } catch (_) {}
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      for (const id of Array.from(peers.keys())) closePeer(id);
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
