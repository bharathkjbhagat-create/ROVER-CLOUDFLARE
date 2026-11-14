/* One PC-local vision scheduler for YOLO and face recognition.
 * The dashboard camera remains the only camera source. A frame is captured once,
 * then sent once with the requested pipeline flags. */
(() => {
  "use strict";
  const API = "http://127.0.0.1:8000";
  const yolo = {
    panel: document.getElementById("localYoloPanel"),
    button: document.getElementById("localYoloToggle"),
    status: document.getElementById("localYoloStatus")
  };
  const face = {
    panel: document.getElementById("localFacePanel"),
    button: document.getElementById("localFaceToggle"),
    status: document.getElementById("localFaceStatus")
  };
  if (!yolo.button || !face.button) return;
  if (location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1") {
    if (yolo.panel) yolo.panel.hidden = true;
    if (face.panel) face.panel.hidden = true;
    return;
  }

  const state = { objects: false, faces: false, busy: false, timer: 0, generation: 0, errors: 0, disconnected: false, owner: false };
  const overlay = document.createElement("canvas");
  overlay.className = "localYoloCanvas localFaceCanvas";
  overlay.setAttribute("aria-label", "Unified local object and face scanning overlay");
  overlay.hidden = true;
  const ctx = overlay.getContext("2d", { alpha: true });
  const counts = { person: 0, vehicle: 0, object: 0 };
  const ids = { person: "localYoloPeople", vehicle: "localYoloVehicles", object: "localYoloObjects" };
  const galleryList = document.getElementById("localFaceGallery");
  const enrollName = document.getElementById("localFaceEnrollName");
  const enrollButton = document.getElementById("localFaceEnrollButton");
  const enrollStatus = document.getElementById("localFaceEnrollStatus");
  const events = document.getElementById("localFaceEvents");
  let recentEvents = [];

  function source() {
    const el = document.getElementById("roverRealCamera");
    if (!el || el.dataset.defenxLiveStream !== "1") return null;
    if (el.dataset.defenxRemoteCamera === "1" && el.dataset.defenxCameraActive !== "1") return null;
    if (el.tagName === "VIDEO" && !el.paused && el.readyState >= 2 && el.videoWidth && el.videoHeight) return el;
    if (el.tagName === "IMG" && el.complete && el.naturalWidth && el.naturalHeight) return el;
    return null;
  }
  function setFeature(feature, value, message, error) {
    if (!feature.status) return;
    feature.status.textContent = message;
    if (feature.panel) feature.panel.dataset.state = error ? "error" : value ? "active" : "idle";
  }
  function errorText(error) {
    const message = String(error && error.message || error);
    return /failed to fetch|networkerror/i.test(message)
      ? "DISCONNECTED • start the DEFENX local AI service and allow this site's local network access"
      : message;
  }
  function clearOverlay() {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    counts.person = counts.vehicle = counts.object = 0;
    for (const key of Object.keys(counts)) {
      const node = document.getElementById(ids[key]);
      if (node) node.textContent = "0";
    }
  }
  function attachOverlay() {
    const viewport = document.getElementById("cameraViewport");
    if (!viewport) return;
    if (overlay.parentElement !== viewport) viewport.appendChild(overlay);
  }
  function fit(width, height) {
    attachOverlay();
    const sourceNode = source();
    if (!sourceNode) return false;
    const rect = sourceNode.getBoundingClientRect();
    if (!rect.width || !rect.height || !width || !height) return false;
    overlay.width = Math.round(rect.width * (window.devicePixelRatio || 1));
    overlay.height = Math.round(rect.height * (window.devicePixelRatio || 1));
    overlay.style.position = "absolute";
    overlay.style.left = (sourceNode.offsetLeft || 0) + "px";
    overlay.style.top = (sourceNode.offsetTop || 0) + "px";
    overlay.style.width = rect.width + "px";
    overlay.style.height = rect.height + "px";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "15";
    return true;
  }
  function draw(data) {
    const ds = Array.isArray(data.detections) ? data.detections : [];
    const fs = Array.isArray(data.faces) ? data.faces : [];
    const w = Number(data.width) || 0, h = Number(data.height) || 0;
    if (!fit(w, h)) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const sx = overlay.width / w, sy = overlay.height / h;
    ctx.lineWidth = Math.max(2, overlay.width / 320);
    ctx.font = "600 " + Math.max(12, overlay.width / 42) + "px system-ui";
    for (const d of ds) {
      const b = d.box || {};
      const name = String(d.class_name || "object");
      const category = name === "person" ? "person" : /^(bicycle|car|motorcycle|airplane|bus|train|truck|boat)$/.test(name) ? "vehicle" : "object";
      counts[category]++;
      const x = Number(b.x1) * sx, y = Number(b.y1) * sy, bw = (Number(b.x2) - Number(b.x1)) * sx, bh = (Number(b.y2) - Number(b.y1)) * sy;
      ctx.strokeStyle = category === "person" ? "#20d5c2" : category === "vehicle" ? "#f7c948" : "#58a6ff";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.strokeRect(x, y, bw, bh);
      ctx.fillText(name.toUpperCase() + " " + Math.round((Number(d.confidence) || 0) * 100) + "%", x + 3, Math.max(14, y - 4));
    }
    for (const f of fs) {
      const b = f.box || {};
      const x = Number(b.x1) * sx, y = Number(b.y1) * sy, bw = (Number(b.x2) - Number(b.x1)) * sx, bh = (Number(b.y2) - Number(b.y1)) * sy;
      const identity = f.match_status === "recognized" && f.identity ? String(f.identity) : f.match_status === "unverified" ? "UNVERIFIED" : "UNKNOWN";
      // Faces are distinct from the person box and always carry an explicit identity state.
      ctx.strokeStyle = f.match_status === "recognized" ? "#5be37d" : "#ff6b6b";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.strokeRect(x, y, bw, bh);
      ctx.fillText(identity, x + 3, y + Math.max(14, ctx.lineWidth + 12));
    }
    for (const [key, nodeId] of Object.entries(ids)) {
      const node = document.getElementById(nodeId);
      if (node) node.textContent = String(counts[key]);
    }
    if (events && fs.length) {
      recentEvents = fs.map(f => ({ identity: f.match_status === "recognized" ? f.identity : "UNKNOWN", status: f.match_status || "unknown", at: new Date().toLocaleTimeString() })).concat(recentEvents).slice(0, 8);
      renderEvents();
    }
  }
  function renderEvents() {
    if (!events) return;
    events.replaceChildren();
    for (const item of recentEvents) {
      const row = document.createElement("div");
      row.textContent = item.at + " • " + (item.status === "recognized" ? item.identity : item.status === "unverified" ? "UNVERIFIED" : "UNKNOWN");
      events.appendChild(row);
    }
  }
  async function request(path, options) {
    const response = await fetch(API + path, { mode: "cors", credentials: "omit", cache: "no-store", targetAddressSpace: "loopback", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || "Local vision request failed (" + response.status + ")");
    return data;
  }
  async function health() {
    const data = await request("/health");
    if (!data.model_loaded) throw new Error("ERROR • YOLO model is not loaded");
    return data;
  }
  async function refreshGallery() {
    if (!galleryList) return;
    const data = await request("/faces");
    galleryList.replaceChildren();
    for (const person of data.people || []) {
      const row = document.createElement("div"), label = document.createElement("span"), remove = document.createElement("button");
      label.textContent = String(person.name || "") + " • " + (Number(person.samples) || 0) + " sample(s)";
      remove.type = "button"; remove.textContent = "REMOVE";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try { await request("/faces/" + encodeURIComponent(String(person.name || "")), { method: "DELETE" }); await refreshGallery(); }
        catch (e) { if (enrollStatus) enrollStatus.textContent = errorText(e); remove.disabled = false; }
      });
      row.append(label, remove); galleryList.appendChild(row);
    }
    if (!data.people || !data.people.length) {
      const empty = document.createElement("small"); empty.textContent = "No people enrolled on this PC."; galleryList.appendChild(empty);
    }
  }
  async function enroll() {
    const camera = source();
    if (!camera) { if (enrollStatus) enrollStatus.textContent = "ERROR • start the live camera first"; return; }
    const name = String(enrollName && enrollName.value || "").trim();
    if (!name) { if (enrollStatus) enrollStatus.textContent = "Enter a person's name first."; return; }
    enrollButton.disabled = true;
    try {
      const frame = document.createElement("canvas");
      frame.width = camera.tagName === "VIDEO" ? camera.videoWidth : camera.naturalWidth;
      frame.height = camera.tagName === "VIDEO" ? camera.videoHeight : camera.naturalHeight;
      frame.getContext("2d").drawImage(camera, 0, 0);
      const blob = await new Promise(resolve => frame.toBlob(resolve, "image/jpeg", 0.88));
      if (!blob) throw new Error("Could not capture the live enrollment frame");
      const form = new FormData(); form.append("name", name); form.append("image", blob, "enrollment.jpg");
      const result = await request("/faces/enroll", { method: "POST", body: form });
      if (enrollStatus) enrollStatus.textContent = "Enrolled " + result.name + " on this PC";
      await refreshGallery();
    } catch (e) { if (enrollStatus) enrollStatus.textContent = errorText(e); }
    finally { enrollButton.disabled = false; }
  }
  function notifyState() {
    const enabled = state.objects || state.faces;
    overlay.hidden = !enabled;
    if (!enabled) clearOverlay();
    if (window.DEFENX_VISION_SYNC) {
      window.DEFENX_VISION_SYNC.setOwner(enabled);
      window.DEFENX_VISION_SYNC.setStatus(enabled ? (state.disconnected ? "DISCONNECTED" : "RUNNING") : "OFF");
    }
    window.dispatchEvent(new CustomEvent("defenx-local-vision-state", { detail: { objects: state.objects, faces: state.faces } }));
    if (!enabled) {
      setFeature(yolo, false, "OFF • YOLO is stopped", false);
      setFeature(face, false, "OFF • local face scanning is stopped", false);
      if (state.timer) clearTimeout(state.timer);
    } else {
      if (state.timer) clearTimeout(state.timer);
      state.generation++;
      state.errors = 0;
      scan();
    }
  }
  async function scan() {
    const generation = state.generation;
    if (state.busy || (!state.objects && !state.faces)) return;
    if (document.hidden) return schedule(900);
    if (!state.owner && window.DEFENX_VISION_SYNC) return schedule(900);
    const camera = source();
    if (!camera) {
      setFeature(state.objects ? yolo : face, true, "RUNNING • waiting for the live camera", false);
      return schedule(700);
    }
    state.busy = true;
    try {
      const sw = camera.tagName === "VIDEO" ? camera.videoWidth : camera.naturalWidth;
      const sh = camera.tagName === "VIDEO" ? camera.videoHeight : camera.naturalHeight;
      const scale = Math.min(1, 960 / sw), width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale));
      const frame = document.createElement("canvas"); frame.width = width; frame.height = height;
      frame.getContext("2d").drawImage(camera, 0, 0, width, height);
      const blob = await new Promise(resolve => frame.toBlob(resolve, "image/jpeg", 0.78));
      if (!blob) throw new Error("Could not prepare camera frame");
      const form = new FormData(); form.append("image", blob, "live-frame.jpg");
      form.append("include_objects", state.objects ? "true" : "false");
      form.append("include_faces", state.faces ? "true" : "false");
      const result = await request("/vision-detect", { method: "POST", body: form });
      if (generation !== state.generation) return;
      state.errors = 0; state.disconnected = false;
      draw(result);
      if (window.DEFENX_VISION_SYNC) window.DEFENX_VISION_SYNC.publish(result);
      if (state.objects) setFeature(yolo, true, "ON • YOLO " + (result.device || "CPU").toUpperCase() + " • " + (result.detections || []).length + " detections", false);
      if (state.faces) setFeature(face, true, "ON • " + (result.faces || []).length + " faces • unknown faces remain UNKNOWN", false);
      schedule(500);
    } catch (e) {
      if (generation !== state.generation) return;
      state.errors++;
      if (state.errors >= 3) state.disconnected = true;
      const msg = errorText(e);
      if (state.objects) setFeature(yolo, true, msg, true);
      if (state.faces) setFeature(face, true, msg, true);
      schedule(state.disconnected ? 3000 : 1200);
    } finally { state.busy = false; }
  }
  function schedule(delay) { clearTimeout(state.timer); if (state.objects || state.faces) state.timer = setTimeout(scan, delay); }
  async function toggle(mode, feature) {
    const key = mode === "yolo" ? "objects" : "faces";
    if (state[key]) {
      state[key] = false;
      if (feature.button) feature.button.textContent = mode === "yolo" ? "START LOCAL YOLO" : "START LOCAL FACE ID";
      notifyState();
      return;
    }
    if (feature.button) feature.button.disabled = true;
    setFeature(feature, true, "RUNNING • checking local AI service", false);
    try {
      const data = await health();
      if (mode === "face" && (!data.face_detection_loaded || !data.face_recognition_loaded)) throw new Error("ERROR • face models are not ready");
      state[key] = true;
      if (feature.button) feature.button.textContent = mode === "yolo" ? "STOP LOCAL YOLO" : "STOP LOCAL FACE ID";
      if (mode === "face") await refreshGallery();
      notifyState();
    } catch (e) {
      setFeature(feature, false, errorText(e), true);
    } finally { if (feature.button) feature.button.disabled = false; }
  }
  yolo.button.addEventListener("click", () => toggle("yolo", yolo));
  face.button.addEventListener("click", () => toggle("face", face));
  if (enrollButton) enrollButton.addEventListener("click", enroll);
  window.addEventListener("resize", () => { if (!overlay.hidden && source()) fit(overlay.width, overlay.height); });
  window.addEventListener("pagehide", () => { state.objects = state.faces = false; notifyState(); });
  window.addEventListener("online", () => { state.disconnected = false; if (state.objects || state.faces) schedule(0); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && (state.objects || state.faces)) schedule(0); });
  const viewport = document.getElementById("cameraViewport");
  if (viewport) new MutationObserver(() => { if (state.objects || state.faces) schedule(0); }).observe(viewport, { childList: true });
  window.DEFENX_LOCAL_VISION = { state: () => ({ objects: state.objects, faces: state.faces, status: state.disconnected ? "DISCONNECTED" : state.objects || state.faces ? "RUNNING" : "OFF" }) };
})();