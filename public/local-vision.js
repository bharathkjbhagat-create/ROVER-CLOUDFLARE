/* Render synchronized detection boxes from the single browser AI scanner.
 * This module does not open a camera, load models, or call localhost.
 * Images and face descriptors are never sent; only normalized box/status metadata
 * arrives from the authenticated vision owner through camera-webrtc.js.
 */
(() => {
  "use strict";
  const snapshots = new Map();
  const overlays = new Map();
  const demoMode = location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  if (demoMode) return;

  function removePeer(peerId) {
    const id = String(peerId || "");
    snapshots.delete(id);
    const canvas = overlays.get(id);
    if (canvas) canvas.remove();
    overlays.delete(id);
  }

  function drawPeer(snapshot) {
    const peerId = String(snapshot.peer_id || "");
    if (!peerId) return;
    const video = Array.from(document.querySelectorAll("video[data-defenx-remote-camera='1']"))
      .find(node => node.dataset.defenxPeerId === peerId);
    let canvas = overlays.get(peerId);
    if (!video || !video.getBoundingClientRect().width) {
      if (canvas) canvas.hidden = true;
      return;
    }
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "localRemoteVisionCanvas";
      canvas.setAttribute("aria-label", "Synchronized browser AI detections");
      canvas.style.cssText = "position:fixed;pointer-events:none;z-index:30";
      document.body.appendChild(canvas);
      overlays.set(peerId, canvas);
    }
    const rect = video.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.hidden = false;
    canvas.style.left = rect.left + "px";
    canvas.style.top = rect.top + "px";
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = Math.max(2, canvas.width / 220);
    context.font = "600 " + Math.max(11, canvas.width / 25) + "px system-ui";
    const drawBox = (box, color, label) => {
      if (!box) return;
      const x = Number(box.x1) * canvas.width, y = Number(box.y1) * canvas.height;
      const width = (Number(box.x2) - Number(box.x1)) * canvas.width;
      const height = (Number(box.y2) - Number(box.y1)) * canvas.height;
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
      context.strokeStyle = context.fillStyle = color;
      context.strokeRect(x, y, width, height);
      context.fillText(label, x + 2, Math.max(12, y - 3));
    };
    for (const detection of snapshot.detections || []) {
      const name = String(detection.class_name || "object").slice(0, 32).toUpperCase();
      drawBox(detection.box, name === "PERSON" ? "#20d5c2" : "#f7c948",
        name + " " + Math.round((Number(detection.confidence) || 0) * 100) + "%");
    }
    for (const face of snapshot.faces || []) {
      const status = ["recognized", "unknown", "unverified"].includes(face.match_status) ? face.match_status : "unknown";
      drawBox(face.box, status === "recognized" ? "#5be37d" : "#ff6b6b",
        status === "recognized" ? "KNOWN FACE" : status === "unverified" ? "UNVERIFIED" : "UNKNOWN");
    }
  }

  function redraw() { for (const snapshot of snapshots.values()) drawPeer(snapshot); }

  window.addEventListener("defenx-remote-camera-left", event => {
    removePeer(event.detail && event.detail.peer_id);
  });
  window.addEventListener("defenx-remote-vision-snapshot", event => {
    const snapshot = event.detail || {};
    if (!snapshot.peer_id) return;
    snapshots.set(String(snapshot.peer_id), snapshot);
    drawPeer(snapshot);
  });
  window.addEventListener("resize", redraw);
  window.addEventListener("scroll", redraw, true);
  window.DEFENX_LOCAL_VISION = {
    state: () => ({ objects: false, faces: false, status: "OFF" })
  };
})();