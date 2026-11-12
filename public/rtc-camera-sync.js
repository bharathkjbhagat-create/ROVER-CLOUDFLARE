/* DEFENX browser-to-browser live camera transport.
 * The Cloudflare Durable Object relays authenticated SDP/ICE signaling only.
 * Video frames travel directly between browsers using WebRTC. */
(() => {
  "use strict";
  const peers = new Map();
  const queuedIce = new Map();
  let localStream = null;
  let remoteVideo = null;
  const rtcConfig = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
  };
  const socket = () => window.roverWS;
  const send = (to, signal) => {
    const ws = socket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "rtc_signal", to, signal }));
    return true;
  };
  function ensureRemoteVideo() {
    if (remoteVideo?.isConnected) return remoteVideo;
    const viewport = document.getElementById("cameraViewport");
    if (!viewport) return null;
    remoteVideo = document.createElement("video");
    remoteVideo.id = "defenxRemoteCamera";
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    remoteVideo.muted = true;
    remoteVideo.setAttribute("aria-label", "Live camera from connected DEFENX device");
    remoteVideo.style.cssText = "display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#02070b;z-index:8";
    viewport.appendChild(remoteVideo);
    return remoteVideo;
  }
  function showRemote(stream) {
    const video = ensureRemoteVideo();
    if (!video) return;
    video.srcObject = stream;
    video.style.display = "block";
    video.play().catch(() => {});
    const placeholder = document.getElementById("camPlaceholder");
    if (placeholder) placeholder.hidden = true;
    const scene = document.getElementById("camera3DScene");
    if (scene) scene.style.display = "none";
    const label = document.getElementById("cameraSceneLabel");
    if (label) label.textContent = "LIVE CAMERA • CONNECTED DEVICE";
    const status = document.getElementById("cameraStatus");
    if (status) status.textContent = "REMOTE CAMERA LIVE";
  }
  function hideRemote() {
    if (!remoteVideo) return;
    try { remoteVideo.pause(); remoteVideo.srcObject = null; } catch (_) {}
    remoteVideo.style.display = "none";
  }
  function closePeer(id) {
    const pc = peers.get(id);
    if (pc) { try { pc.close(); } catch (_) {} }
    peers.delete(id);
    queuedIce.delete(id);
    if (!peers.size) hideRemote();
  }
  function makePeer(id) {
    if (!id || id === window.__defenxRtcPeerId) return null;
    let pc = peers.get(id);
    if (pc) return pc;
    pc = new RTCPeerConnection(rtcConfig);
    peers.set(id, pc);
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    pc.onicecandidate = event => {
      if (event.candidate) send(id, { type: "ice", candidate: event.candidate });
    };
    pc.ontrack = event => {
      const stream = event.streams && event.streams[0];
      if (stream) showRemote(stream);
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) closePeer(id);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        // STUN-only connections can fail behind restrictive NATs; do not claim live.
        const status = document.getElementById("cameraStatus");
        if (status) status.textContent = "REMOTE CAMERA CONNECTION FAILED";
      }
    };
    return pc;
  }
  async function offerTo(id) {
    if (!localStream) return;
    const pc = makePeer(id);
    if (!pc || pc.signalingState !== "stable") return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send(id, { type: "offer", sdp: pc.localDescription });
    } catch (_) {
      closePeer(id);
    }
  }
  async function applySignal(message) {
    const id = String(message.from || "");
    const signal = message.signal || {};
    if (!id) return;
    const pc = makePeer(id);
    if (!pc) return;
    try {
      if (signal.type === "offer") {
        await pc.setRemoteDescription(signal.sdp);
        const pending = queuedIce.get(id) || [];
        queuedIce.delete(id);
        for (const candidate of pending) await pc.addIceCandidate(candidate);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send(id, { type: "answer", sdp: pc.localDescription });
      } else if (signal.type === "answer") {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(signal.sdp);
          const pending = queuedIce.get(id) || [];
          queuedIce.delete(id);
          for (const candidate of pending) await pc.addIceCandidate(candidate);
        }
      } else if (signal.type === "ice" && signal.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
        else {
          const pending = queuedIce.get(id) || [];
          if (pending.length < 64) pending.push(signal.candidate);
          queuedIce.set(id, pending);
        }
      }
    } catch (_) {
      closePeer(id);
    }
  }
  window.addEventListener("defenx-rtc-message", event => {
    const message = event.detail || {};
    if (message.type === "rtc_peers") {
      (message.peer_ids || []).forEach(id => { if (localStream) offerTo(String(id)); });
    } else if (message.type === "rtc_peer_joined") {
      if (localStream) offerTo(String(message.peer_id || ""));
    } else if (message.type === "rtc_peer_left") {
      closePeer(String(message.peer_id || ""));
    } else if (message.type === "rtc_signal") {
      applySignal(message);
    } else if (message.type === "rtc_signal_error") {
      const status = document.getElementById("cameraStatus");
      if (status) status.textContent = "REMOTE DEVICE DISCONNECTED";
    }
  });
  window.DefenxRtcCamera = {
    setLocalStream(stream) {
      localStream = stream || null;
      if (localStream) {
        for (const id of peers.keys()) closePeer(id);
        // A new camera source creates fresh peer connections with the current peers.
        const ws = socket();
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Server sends the current peer list on connection; ask it to re-announce
          // peers by reconnecting only when needed is avoided to preserve state sync.
          window.dispatchEvent(new CustomEvent("defenx-rtc-publish-started"));
        }
      } else {
        for (const id of peers.keys()) closePeer(id);
      }
    }
  };
  window.addEventListener("pagehide", () => {
    for (const id of peers.keys()) closePeer(id);
  });
})();
