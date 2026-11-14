/* Optional PC-local face recognition. Only live camera frames are sent to the
 * loopback FastAPI service; names and face events stay in this browser. */
(() => {
  "use strict";
  const API = "http://127.0.0.1:8000";
  const panel = document.getElementById("localFacePanel");
  const button = document.getElementById("localFaceToggle");
  const status = document.getElementById("localFaceStatus");
  const faceCount = document.getElementById("localFaceCount");
  const knownCount = document.getElementById("localFaceKnown");
  const eventList = document.getElementById("localFaceEvents");
  const galleryList = document.getElementById("localFaceGallery");
  const enrollName = document.getElementById("localFaceEnrollName");
  const enrollButton = document.getElementById("localFaceEnrollButton");
  const enrollStatus = document.getElementById("localFaceEnrollStatus");
  if (!panel || !button || !status) return;
  if (location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1") {
    panel.hidden = true;
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.className = "localFaceCanvas";
  canvas.setAttribute("aria-label", "Local face recognition overlay");
  canvas.hidden = true;
  const ctx = canvas.getContext("2d");
  let active = false, busy = false, timer = 0, source = null, generation = 0;
  let recentEvents = [];
  const lastEventAt = new Map();

  function setStatus(message, error) {
    status.textContent = message;
    panel.dataset.state = error ? "error" : active ? "active" : "idle";
  }
  function liveSource() {
    const el = document.getElementById("roverRealCamera");
    if (!el || el.dataset.defenxLiveStream !== "1") return null;
    if (el.dataset.defenxRemoteCamera === "1" && el.dataset.defenxCameraActive !== "1") return null;
    if (el.tagName === "VIDEO" && !el.paused && el.readyState >= 2 && el.videoWidth && el.videoHeight) return el;
    if (el.tagName === "IMG" && el.complete && el.naturalWidth && el.naturalHeight) return el;
    return null;
  }
  async function health() {
    const response = await fetch(API + "/health", { mode: "cors", credentials: "omit", cache: "no-store", targetAddressSpace: "loopback" });
    const data = await response.json();
    if (!response.ok || !data.face_detection_loaded || !data.face_recognition_loaded) {
      throw new Error(data.detail || "Local face models are not ready. Start the DEFENX AI server on this PC.");
    }
    return data;
  }
  async function localRequest(path, options) {
    const response = await fetch(API + path, {
      mode: "cors", credentials: "omit", cache: "no-store",
      targetAddressSpace: "loopback", ...options
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || data.error || "Local face server request failed");
    return data;
  }
  async function loadGallery() {
    if (!galleryList) return;
    const data = await localRequest("/faces");
    galleryList.replaceChildren();
    if (!data.people || !data.people.length) {
      const empty = document.createElement("small");
      empty.textContent = "No people enrolled in this PC's local gallery yet.";
      galleryList.appendChild(empty);
      return;
    }
    for (const person of data.people) {
      const row = document.createElement("div"); row.className = "localFacePerson";
      const label = document.createElement("span"), remove = document.createElement("button");
      const name = String(person.name || "");
      label.textContent = name + " • " + (Number(person.samples) || 0) + " sample(s)";
      remove.type = "button"; remove.textContent = "REMOVE";
      remove.addEventListener("click", async () => {
        if (!window.confirm("Remove " + name + " and its saved face templates from this PC?")) return;
        remove.disabled = true;
        try {
          await localRequest("/faces/" + encodeURIComponent(name), { method: "DELETE" });
          if (enrollStatus) enrollStatus.textContent = name + " removed from this PC's local gallery.";
          await loadGallery();
        } catch (error) {
          if (enrollStatus) enrollStatus.textContent = String(error && error.message || error);
          remove.disabled = false;
        }
      });
      row.append(label, remove); galleryList.appendChild(row);
    }
  }
  async function enrollLiveFrame() {
    if (!enrollButton) return;
    enrollButton.disabled = true;
    try {
      const name = String(enrollName && enrollName.value || "").trim();
      if (!name) throw new Error("Enter a name for the live face sample.");
      const current = liveSource();
      if (!current) throw new Error("Start the live camera before enrolling a face.");
      const size = current.tagName === "VIDEO"
        ? { width: current.videoWidth, height: current.videoHeight }
        : { width: current.naturalWidth, height: current.naturalHeight };
      const factor = Math.min(1, 640 / size.width);
      const frame = document.createElement("canvas");
      frame.width = Math.max(1, Math.round(size.width * factor));
      frame.height = Math.max(1, Math.round(size.height * factor));
      frame.getContext("2d").drawImage(current, 0, 0, frame.width, frame.height);
      const blob = await new Promise(resolve => frame.toBlob(resolve, "image/jpeg", 0.88));
      if (!blob) throw new Error("Could not capture a live camera frame.");
      const form = new FormData();
      form.append("name", name);
      form.append("image", blob, "live-face.jpg");
      const result = await localRequest("/faces/enroll", { method: "POST", body: form });
      if (enrollStatus) enrollStatus.textContent = "Enrolled " + result.name + " • " + result.samples + " sample(s) • saved on this PC; photo not stored.";
      await loadGallery();
      if (active) schedule(0);
    } catch (error) {
      if (enrollStatus) enrollStatus.textContent = String(error && error.message || error);
    } finally { enrollButton.disabled = false; }
  }
  function draw(faces, width, height) {
    const host = source.parentElement || document.getElementById("cameraViewport");
    if (canvas.parentElement !== host) host.appendChild(canvas);
    const rect = host.getBoundingClientRect(), vw = Math.max(1, Math.round(rect.width)), vh = Math.max(1, Math.round(rect.height));
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
    ctx.clearRect(0, 0, vw, vh);
    const contain = getComputedStyle(source).objectFit === "contain";
    const scale = (contain ? Math.min : Math.max)(vw / width, vh / height);
    const ox = (vw - width * scale) / 2, oy = (vh - height * scale) / 2;
    let known = 0;
    for (const face of faces) {
      const box = face.box || {};
      const values = [box.x1, box.y1, box.x2, box.y2];
      if (!values.every(Number.isFinite)) continue;
      const identified = face.match_status === "recognized" && typeof face.identity === "string";
      if (identified) known++;
      const color = identified ? "#39e6a5" : "#ffb454";
      const x = box.x1 * scale + ox, y = box.y1 * scale + oy;
      const w = (box.x2 - box.x1) * scale, h = (box.y2 - box.y1) * scale;
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      const label = identified ? face.identity : "UNKNOWN FACE";
      ctx.font = "700 12px system-ui, sans-serif";
      const labelWidth = ctx.measureText(label).width + 12, top = Math.max(0, y - 20);
      ctx.fillStyle = color; ctx.fillRect(x, top, labelWidth, 18);
      ctx.fillStyle = "#07120d"; ctx.fillText(label, x + 6, top + 13);
    }
    if (faceCount) faceCount.textContent = String(faces.length);
    if (knownCount) knownCount.textContent = String(known);
    updateEvents(faces);
  }
  function updateEvents(faces) {
    const now = Date.now();
    for (const face of faces) {
      const identity = face.match_status === "recognized" ? face.identity : null;
      const key = identity ? "known:" + identity : "unknown";
      if (now - (lastEventAt.get(key) || 0) < 6000) continue;
      lastEventAt.set(key, now);
      recentEvents.unshift({
        message: identity ? "Known person detected: " + identity : "Unknown face detected",
        at: new Date(now).toLocaleTimeString(),
        score: Number.isFinite(face.detection_confidence) ? Math.round(face.detection_confidence * 100) : null
      });
    }
    recentEvents = recentEvents.slice(0, 5);
    if (!eventList) return;
    eventList.replaceChildren();
    if (!recentEvents.length) {
      const empty = document.createElement("small");
      empty.textContent = "No face alerts yet.";
      eventList.appendChild(empty);
      return;
    }
    for (const item of recentEvents) {
      const row = document.createElement("div");
      row.className = "localFaceEvent";
      const message = document.createElement("b"), detail = document.createElement("small");
      message.textContent = item.message;
      detail.textContent = item.at + (item.score == null ? "" : " • face detection " + item.score + "%");
      row.append(message, detail);
      eventList.appendChild(row);
    }
  }
  function clearOverlay() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (faceCount) faceCount.textContent = "0";
    if (knownCount) knownCount.textContent = "0";
    recentEvents = [];
    if (eventList) eventList.replaceChildren();
  }
  function schedule(delay) { if (timer) clearTimeout(timer); if (active) timer = setTimeout(scan, delay); }
  async function scan() {
    if (!active || busy) return;
    source = liveSource();
    if (!source) { setStatus("Waiting for the authenticated live camera", false); return schedule(700); }
    busy = true;
    const version = generation;
    try {
      const size = source.tagName === "VIDEO"
        ? { width: source.videoWidth, height: source.videoHeight }
        : { width: source.naturalWidth, height: source.naturalHeight };
      const factor = Math.min(1, 640 / size.width);
      const width = Math.max(1, Math.round(size.width * factor));
      const height = Math.max(1, Math.round(size.height * factor));
      const frame = document.createElement("canvas"); frame.width = width; frame.height = height;
      frame.getContext("2d").drawImage(source, 0, 0, width, height);
      const blob = await new Promise(resolve => frame.toBlob(resolve, "image/jpeg", 0.72));
      if (!blob) throw new Error("Could not prepare a camera frame");
      const form = new FormData(); form.append("image", blob, "live-frame.jpg");
      const response = await fetch(API + "/face-detect", {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store", targetAddressSpace: "loopback", body: form
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Local face analysis failed");
      if (active && version === generation && source === liveSource()) {
        draw(data.faces || [], data.width || width, data.height || height);
        const found = (data.faces || []).length;
        setStatus("LIVE • LOCAL FACE MATCH • " + found + " face" + (found === 1 ? "" : "s") + " • frames sent to this PC only", false);
      }
      schedule(1000);
    } catch (error) {
      if (active && version === generation) {
        const message = String(error && error.message || error);
        clearOverlay();
        setStatus(/taint|cross.origin|securityerror/i.test(message)
          ? "Camera feed blocks local frame analysis • check camera CORS"
          : message.includes("Failed to fetch")
            ? "Local face server unreachable or browser blocked loopback access • start the server on this PC"
            : message, true);
        schedule(3000);
      }
    } finally { busy = false; }
  }
  async function start() {
    button.disabled = true;
    setStatus("Checking the local face server…", false);
    try {
      const data = await health();
      await loadGallery();
      active = true; generation++;
      button.textContent = "STOP LOCAL FACE ID"; button.disabled = false;
      canvas.hidden = false;
      const enrolled = Number(data.enrolled_people) || 0;
      setStatus("Ready • " + enrolled + " local enrollment" + (enrolled === 1 ? "" : "s") + " • waiting for a live camera", false);
      scan();
    } catch (error) {
      const message = String(error && error.message || error);
      setStatus(message.includes("Failed to fetch") || message.includes("NetworkError")
        ? "Local face server unreachable or browser blocked loopback access • allow local-network access and check server/origin"
        : message, true);
      button.disabled = false;
    }
  }
  function stop() {
    active = false; generation++;
    if (timer) clearTimeout(timer);
    canvas.hidden = true; clearOverlay();
    button.textContent = "START LOCAL FACE ID";
    setStatus("Stopped • live frames are no longer sent to the local AI server", false);
  }
  button.addEventListener("click", () => active ? stop() : start());
  if (enrollButton) enrollButton.addEventListener("click", enrollLiveFrame);
  window.addEventListener("pagehide", stop);
  const cameraViewport = document.getElementById("cameraViewport");
  if (cameraViewport) new MutationObserver(() => { if (active) schedule(0); }).observe(cameraViewport, { childList: true });
})();



