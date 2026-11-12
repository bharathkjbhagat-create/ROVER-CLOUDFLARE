/* DEFENX registered-user face verification, mask detection and liveness.
 * - Runs only on the live camera element (#roverRealCamera, data-defenx-live-stream="1").
 * - Compares live faces against administrator-enrolled, consenting users only.
 * - Enrollment photographs are processed on their own canvas and are never fed to
 *   the live pipeline, so an uploaded reference photo cannot raise a detection or alert.
 * - Frames never leave the browser. Enrolled descriptors and reference photographs
 *   are encrypted with AES-256-GCM before storage in the admin-only Durable Object.
 *   There is no plaintext IndexedDB or server-side plaintext fallback.
 * Orchestrated by ai-vision.js through window.DEFENX_FACE.
 */
(() => {
  "use strict";
  const core = window.DEFENX_VISION_CORE;
  const bar = document.getElementById("faceScanBar");
  const status = document.getElementById("faceScanState");
  const count = document.getElementById("faceScanCount");
  const toggle = document.getElementById("faceScanToggle");
  const list = document.getElementById("faceStatusList");
  if (!core || !bar || !status || !count || !toggle) return;

  const demoMode = location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  const libraryUrl = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js";
  const modelUrl = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/";
  const PREF = "defenx_face_id_v1";
  const STATUS = core.STATUS;
  const small = (navigator.hardwareConcurrency || 4) <= 4 || window.matchMedia("(max-width: 700px)").matches;
  const detectorSize = small ? 288 : 320;

  let faceapi = null, modelPromise = null, modelReady = false;
  let wanted = true; // operator preference: scanning is on unless it was switched off
  try { wanted = localStorage.getItem(PREF) !== "off"; } catch (_) {}
  let enrolled = [], storageMode = "none";
  let tracker = new core.Tracker(), lastFaces = [], working = false;
  const cropCanvas = document.createElement("canvas");
  const cropCtx = cropCanvas.getContext("2d", { willReadFrequently: true });
  const stats = { detectMs: 0, descriptorMs: 0 };

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- models ---------------- */
  function loadScript() {
    if (window.faceapi) return Promise.resolve(window.faceapi);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = libraryUrl; script.async = true; script.crossOrigin = "anonymous";
      script.onload = () => window.faceapi ? resolve(window.faceapi) : reject(new Error("Face library unavailable"));
      script.onerror = () => reject(new Error("Could not load face library"));
      document.head.appendChild(script);
    });
  }
  function ensureModels() {
    if (modelReady) return Promise.resolve(faceapi);
    if (!modelPromise) {
      modelPromise = (async () => {
        faceapi = await loadScript();
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelUrl),
          faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl)
        ]);
        modelReady = true;
        return faceapi;
      })().catch(error => { modelPromise = null; throw error; });
    }
    return modelPromise;
  }

  /* ---------------- encrypted server-only enrollment storage ---------------- */
  async function fetchJson(url, options) {
    const response = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, options || {}));
    let data = null;
    try { data = await response.json(); } catch (_) {}
    return { response, data: data || {} };
  }
  async function loadEnrollments() {
    if (demoMode) { enrolled = []; storageMode = "none"; return; }
    try {
      const { response, data } = await fetchJson("/api/face-enrollments");
      if (response.ok && data.ok && data.storage === "durable-object-encrypted") {
        enrolled = data.enrollments || [];
        storageMode = "server";
        return;
      }
      enrolled = [];
      storageMode = "none";
    } catch (_) {
      // Biometric data must never fall back to unencrypted browser storage.
      enrolled = [];
      storageMode = "none";
    }
  }

  /* ---------------- live pipeline (called by ai-vision.js) ---------------- */
  function active() { return !demoMode && storageMode === "server" && wanted && modelReady; }
  function reset() { tracker = new core.Tracker(); lastFaces = []; setCount(0); renderList([]); }
  function cropFace(source, box, pad) {
    const sw = source.videoWidth || source.naturalWidth, sh = source.videoHeight || source.naturalHeight;
    const x = Math.max(0, box[0] - box[2] * pad), y = Math.max(0, box[1] - box[3] * pad);
    const w = Math.min(sw - x, box[2] * (1 + 2 * pad)), h = Math.min(sh - y, box[3] * (1 + 2 * pad));
    const scale = Math.min(1, 224 / Math.max(w, h));
    cropCanvas.width = Math.max(32, Math.round(w * scale)); cropCanvas.height = Math.max(32, Math.round(h * scale));
    cropCtx.drawImage(source, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);
    return cropCanvas;
  }
  async function descriptorFor(source, box) {
    const started = performance.now();
    const canvas = cropFace(source, box, 0.35);
    const result = await faceapi.detectSingleFace(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
      .withFaceLandmarks(true).withFaceDescriptor();
    stats.descriptorMs = performance.now() - started;
    return result ? Array.from(result.descriptor) : null;
  }

  /* ctx: { source, now, frame(): {img, scale}, isSpoofed(box): string|null }  ->  array of face results */
  async function process(ctx) {
    if (!active() || working) return lastFaces;
    working = true;
    try {
      const { source, now } = ctx;
      const started = performance.now();
      const raw = await faceapi.detectAllFaces(source, new faceapi.TinyFaceDetectorOptions({ inputSize: detectorSize, scoreThreshold: 0.5 })).withFaceLandmarks(true);
      stats.detectMs = performance.now() - started;
      if (document.getElementById("roverRealCamera") !== source || !active()) return lastFaces;
      const faces = raw.map(r => ({
        bbox: [r.detection.box.x, r.detection.box.y, r.detection.box.width, r.detection.box.height],
        score: r.detection.score,
        points: r.landmarks.positions.map(p => [p.x, p.y])
      }));
      tracker.update(faces, now, () => "face");
      let descriptorBudget = 1;
      const results = [];
      for (const face of faces) {
        const tr = face.track, d = tr.data;
        d.live = d.live || new core.Liveness();
        d.live.update(face.points, now);
        d.idHistory = d.idHistory || [];
        // pixel analysis (clarity, mask) at most every 600 ms per face
        if (!d.analysisAt || now - d.analysisAt > 600) {
          const frame = ctx.frame();
          if (frame) {
            const s = frame.scale, scaled = { bbox: face.bbox.map(v => v * s), score: face.score, points: face.points.map(p => [p[0] * s, p[1] * s]) };
            d.clarity = core.faceClarity(scaled, frame.img);
            const m = d.clarity.clear ? core.maskAnalysis(frame.img, scaled.points) : { state: "UNCLEAR", confidence: 0 };
            // a mask verdict needs 3 of the last 5 analyses to agree, so one odd frame cannot raise an alert
            d.maskHist = (d.maskHist || []).concat(m.state).slice(-5);
            const agree = ["MASK", "NO_MASK"].find(k => d.maskHist.filter(x => x === k).length >= 3);
            d.mask = agree ? Object.assign({}, m, { state: agree }) : { state: "UNCLEAR", confidence: m.confidence };
            d.analysisAt = now;
          }
        }
        const clarity = d.clarity || core.faceClarity(face);
        const mask = d.mask || { state: "UNCLEAR", confidence: 0 };
        // identity descriptor: refresh quickly until a stable vote exists, then slowly
        const needs = clarity.clear && descriptorBudget > 0 && (!d.descAt || now - d.descAt > (d.idHistory.length < 3 ? 900 : 6000));
        if (needs) {
          descriptorBudget--;
          try {
            const descriptor = await descriptorFor(source, face.bbox);
            d.descAt = now;
            if (descriptor) { d.idHistory.push(core.matchIdentity(descriptor, enrolled)); if (d.idHistory.length > 8) d.idHistory.shift(); }
          } catch (_) { d.descAt = now; }
        }
        const identity = core.smoothIdentity(d.idHistory);
        const spoof = ctx.isSpoofed ? ctx.isSpoofed(face.bbox) : null;
        const live = d.live.verified(now) && !spoof;
        const resolved = core.resolveFace({ clarity, mask, identity, live });
        results.push({
          id: tr.id, bbox: face.bbox, score: face.score, live, spoof,
          identity: resolved.identity, mask: resolved.mask, name: resolved.name, alerts: resolved.alerts,
          identityConfidence: identity.confidence || 0, maskConfidence: mask.confidence || 0,
          reasons: resolved.reasons, possible: identity.possible || null, at: now
        });
      }
      lastFaces = results;
      setCount(results.length);
      renderList(results);
      return results;
    } finally { working = false; }
  }
  function liveFaceInside(box, now) {
    return lastFaces.some(f => f.live && now - f.at < 2500 &&
      f.bbox[0] + f.bbox[2] / 2 >= box[0] && f.bbox[0] + f.bbox[2] / 2 <= box[0] + box[2] &&
      f.bbox[1] + f.bbox[3] / 2 >= box[1] && f.bbox[1] + f.bbox[3] / 2 <= box[1] + box[3]);
  }

  /* ---------------- status UI ---------------- */
  let state = "waiting";
  function setCount(n) { count.textContent = String(n); }
  function sourceOk() { const n = $("roverRealCamera"); return !!(n && n.dataset.defenxLiveStream === "1" && (n.tagName === "VIDEO" || n.tagName === "IMG")); }
  function setState(next, message) {
    state = next; bar.dataset.state = next; status.textContent = message;
    toggle.textContent = wanted ? "STOP FACE ID" : "START FACE ID";
    toggle.disabled = demoMode || storageMode !== "server" || next === "loading" || !sourceOk();
  }
  const faceStatusRows = new Map();
  function renderList(results) {
    if (!list) return;
    const seen = new Set();
    for (const f of results) {
      const key = String(f.id);
      seen.add(key);
      let row = faceStatusRows.get(key);
      if (!row) {
        row = document.createElement("div"); row.className = "faceStatusRow"; row.dataset.id = key;
        row.append(document.createElement("b"), document.createElement("span"));
        faceStatusRows.set(key, row);
      }
      const idLine = f.identity === STATUS.RECOGNIZED ? STATUS.RECOGNIZED + " • " + f.name : f.identity;
      const conf = f.identity === STATUS.RECOGNIZED || f.identity === STATUS.UNKNOWN ? " • " + Math.round(f.identityConfidence * 100) + "%" : "";
      const extra = f.spoof ? " • " + STATUS.PHOTO : (f.reasons && f.reasons.length ? " • " + f.reasons.join(", ") : (f.possible && f.identity === STATUS.UNVERIFIED && !f.live ? " • live presence not established" : ""));
      const maskText = f.mask + (f.mask === STATUS.NOT_CLEAR ? "" : " • " + Math.round(f.maskConfidence * 100) + "%");
      row.children[0].textContent = idLine + conf;
      row.children[1].textContent = maskText + extra;
      // Reuse each tracked face's row to avoid rebuilding the admin UI on every camera frame.
      list.appendChild(row);
    }
    for (const [key, row] of faceStatusRows) {
      if (seen.has(key)) continue;
      row.remove(); faceStatusRows.delete(key);
    }
  }
  function refreshBar() {
    if (demoMode) { setState("demo", "FACE ID DISABLED IN DEMO MODE"); return; }
    if (storageMode !== "server") { setState("error", "ENCRYPTED ENROLLMENT STORAGE UNAVAILABLE • FACE ID DISABLED"); return; }
    if (!sourceOk()) { setState("waiting", "WAITING FOR LIVE CAMERA"); return; }
    if (!wanted) { setState("paused", "FACE ID STOPPED BY OPERATOR"); return; }
    if (!modelReady) return;
    const where = storageMode === "server" ? "encrypted server storage" : "unavailable";
    setState("active", "FACE ID LIVE • " + enrolled.length + " ENROLLED (" + where + ")");
  }
  async function bootModels() {
    if (demoMode || storageMode !== "server" || !wanted || modelReady || state === "loading" || !sourceOk()) return;
    setState("loading", "LOADING FACE MODELS • FIRST USE");
    try { await ensureModels(); refreshBar(); }
    catch (_) { setState("error", "FACE MODELS COULD NOT LOAD • CHECK INTERNET"); }
  }
  toggle.addEventListener("click", () => {
    wanted = !wanted;
    try { localStorage.setItem(PREF, wanted ? "on" : "off"); } catch (_) {}
    if (!wanted) { reset(); refreshBar(); } else { bootModels(); refreshBar(); }
  });
  window.DEFENX_FACE = {
    active, process, reset, liveFaceInside, ensureModels, boot: bootModels,
    refresh: refreshBar, stats, enrolledCount: () => enrolled.length,
    reloadEnrollments: async () => { await loadEnrollments(); refreshBar(); },
    get faces() { return lastFaces; }
  };

  /* ---------------- enrollment (admin) ---------------- */
  function enrollMsg(text, bad) { const m = $("faceEnrollMsg"); if (m) { m.textContent = text; m.style.color = bad ? "#ff8b96" : ""; } }
  let thumbUrls = [];
  async function renderEnrollList() {
    const box = $("faceEnrollList"), note = $("faceStorageNote");
    if (!box) return;
    thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
    if (note) note.textContent = storageMode === "server"
      ? "Stored encrypted in the administrator-only Cloudflare Durable Object. Photographs and face data are never shown to other users."
      : "Encrypted server storage unavailable. Face enrollment is disabled until AES-GCM storage is configured.";
    if (!enrolled.length) { box.innerHTML = '<div class="empty">No registered users enrolled.</div>'; return; }
    box.innerHTML = enrolled.map(e => '<div class="faceEnrollRow" data-id="' + esc(e.id) + '"><span class="faceThumbs" aria-label="Reference photographs"></span><b>' + esc(e.name) + '</b><button type="button" class="mini" data-del="' + esc(e.id) + '">REMOVE</button></div>').join("");
    for (const e of enrolled) {
      const thumbs = box.querySelector('[data-id="' + CSS.escape(e.id) + '"] .faceThumbs');
      try {
        const count = Math.min(3, Math.max(1, Number(e.photo_count) || 1));
        for (let index = 0; index < count; index++) {
          const suffix = index ? "/photo/" + index : "/photo";
          const r = await fetch("/api/face-enrollments/" + encodeURIComponent(e.id) + suffix, { credentials: "same-origin", cache: "no-store" });
          if (r.ok) { const u = URL.createObjectURL(await r.blob()), img = document.createElement("img"); img.alt = "Encrypted reference " + (index + 1); img.width = 44; img.height = 44; img.src = u; thumbUrls.push(u); thumbs.appendChild(img); }
        }
      } catch (_) {}
    }
  }
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file is not a readable image")); };
      img.src = url;
    });
  }
  function thumbnail(img, box) { // square face crop, JPEG, small enough for the 32 KB request cap
    const side = Math.max(box.width, box.height) * 1.5;
    const sx = Math.max(0, box.x + box.width / 2 - side / 2), sy = Math.max(0, box.y + box.height / 2 - side / 2);
    const sw = Math.min(img.width - sx, side), sh = Math.min(img.height - sy, side);
    for (const px of [160, 128, 96, 72]) {
      const c = document.createElement("canvas"); c.width = c.height = px;
      c.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, px, px);
      for (const q of [0.7, 0.55, 0.4]) {
        const url = c.toDataURL("image/jpeg", q);
        if (url.length - 23 <= 4000) return url;
      }
    }
    return null;
  }
  async function enrollFromPhoto(liveCanvas) {
    const name = ($("faceEnrollName").value || "").trim();
    const files = liveCanvas ? [] : Array.from($("faceEnrollFile").files || []);
    if (!name) return enrollMsg("Enter the person's name.", true);
    if (!liveCanvas && !files.length) return enrollMsg("Choose 1-3 clear, front-facing photographs.", true);
    if (files.length > 3) return enrollMsg("Choose no more than 3 reference photographs.", true);
    if (!$("faceEnrollConsent").checked) return enrollMsg("Documented consent from this person is required.", true);
    if (storageMode !== "server") return enrollMsg("Encrypted server storage is unavailable. No biometric data was saved.", true);
    const button = $(liveCanvas ? "faceEnrollLiveBtn" : "faceEnrollBtn"); button.disabled = true;
    try {
      enrollMsg("Loading face models…");
      await ensureModels();
      const descriptors = [], photos = [], sources = liveCanvas ? [liveCanvas] : files;
      for (let index = 0; index < sources.length; index++) {
        const item = sources[index];
        let canvas = item;
        if (!liveCanvas) {
          const source = await loadImage(item);
          const k = Math.min(1, 800 / Math.max(source.width, source.height));
          canvas = document.createElement("canvas"); canvas.width = Math.round(source.width * k); canvas.height = Math.round(source.height * k);
          canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
        }
        enrollMsg("Analysing reference " + (index + 1) + " of " + sources.length + "…");
        const found = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.6 })).withFaceLandmarks(true).withFaceDescriptors();
        if (found.length !== 1) throw new Error(found.length ? "Each photograph must contain exactly one face." : "No clear face found. Use a well-lit, front-facing photograph.");
        const face = found[0], points = face.landmarks.positions.map(p => [p.x, p.y]);
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        const clarity = core.faceClarity({
          bbox: [face.detection.box.x, face.detection.box.y, face.detection.box.width, face.detection.box.height],
          score: face.detection.score, points
        }, { data: pixels.data, width: pixels.width, height: pixels.height });
        if (!clarity.clear) throw new Error("Photograph " + (index + 1) + " not suitable: " + clarity.reasons.join(", ") + ".");
        const photo = thumbnail(canvas, face.detection.box);
        if (!photo) throw new Error("Could not prepare reference photograph " + (index + 1) + ".");
        descriptors.push(Array.from(face.descriptor)); photos.push(photo);
      }
      const { response, data } = await fetchJson("/api/face-enrollments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, consent: true, descriptors, photos })
      });
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not save the enrolment.");
      $("faceEnrollName").value = ""; $("faceEnrollFile").value = ""; $("faceEnrollConsent").checked = false;
      await loadEnrollments(); refreshBar(); await renderEnrollList();
      enrollMsg("Enrolled " + name + " with " + descriptors.length + " encrypted reference photograph(s).");
    } catch (error) { enrollMsg(error.message || "Enrolment failed.", true); }
    finally { button.disabled = false; }
  }
  async function removeEnrollment(id) {
    const entry = enrolled.find(e => e.id === id);
    if (storageMode !== "server" || !entry || !confirm("Remove " + entry.name + " and delete their stored photograph and face data?")) return;
    try {
      if (storageMode === "server") {
        const { response, data } = await fetchJson("/api/face-enrollments/" + encodeURIComponent(id), { method: "DELETE" });
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not remove.");
      }
      await loadEnrollments(); refreshBar(); await renderEnrollList(); enrollMsg("Removed " + entry.name + ".");
    } catch (error) { enrollMsg(error.message || "Could not remove.", true); }
  }
  function bindEnrollmentUi() {
    const tabBtn = $("faceTabBtn"), tab = $("faceTab");
    if (!tabBtn || !tab) return;
    const others = ["usersTab", "auditTab"];
    tabBtn.addEventListener("click", async () => {
      others.forEach(id => $(id) && $(id).classList.add("hidden"));
      tab.classList.remove("hidden");
      await loadEnrollments(); await renderEnrollList();
    });
    // other code paths (e.g. the alerts bell) also show the users/audit panels: keep exactly one visible
    others.forEach(id => { const el = $(id); if (el && window.MutationObserver) new MutationObserver(() => { if (!el.classList.contains("hidden")) tab.classList.add("hidden"); }).observe(el, { attributes: true, attributeFilter: ["class"] }); });
    $("faceEnrollBtn").addEventListener("click", () => enrollFromPhoto());
    const liveBtn = $("faceEnrollLiveBtn");
    if (liveBtn) liveBtn.addEventListener("click", () => {
      // Single frame from the LIVE camera element, processed in the browser; the frame itself is never uploaded
      // (only the 128-value descriptor and a small reference thumbnail, encrypted server-side).
      const video = $("roverRealCamera");
      if (!video || video.dataset.defenxLiveStream !== "1" || video.tagName !== "VIDEO" || video.readyState < 2 || !video.videoWidth)
        return enrollMsg("Start the phone camera (or a live video feed) and wait for video before enrolling from the camera.", true);
      const c = document.createElement("canvas"), k = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
      c.width = Math.round(video.videoWidth * k); c.height = Math.round(video.videoHeight * k);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      enrollFromPhoto(c);
    });
    $("faceEnrollList").addEventListener("click", e => { const b = e.target.closest("[data-del]"); if (b) removeEnrollment(b.dataset.del); });
    const closeBtn = document.querySelector('[data-close="adminModal"]');
    if (closeBtn) closeBtn.addEventListener("click", () => { thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = []; });
  }

  /* ---------------- boot ---------------- */
  let lastNode = null;
  function onCameraChange() {
    const node = $("roverRealCamera");
    if (node !== lastNode) { lastNode = node; reset(); } // only a new camera element resets tracking
    refreshBar(); bootModels();
  }
  const viewport = $("cameraViewport");
  if (viewport && window.MutationObserver) new MutationObserver(onCameraChange).observe(viewport, { childList: true, subtree: true });
  window.addEventListener("defenx-camera-live", onCameraChange);
  bindEnrollmentUi();
  refreshBar();
  if (!demoMode) loadEnrollments().then(() => { refreshBar(); bootModels(); });
  window.addEventListener("pagehide", () => { thumbUrls.forEach(u => URL.revokeObjectURL(u)); reset(); });
})();