/* DEFENX face verification (browser side).
 * - Face detection + 128-d embeddings run locally in this browser (face-api.js, TensorFlow.js).
 * - Camera frames are never uploaded for recognition. Only numeric embeddings are sent to the
 *   server, which does the matching so authorised templates never reach any browser.
 * - A small JPEG snapshot is uploaded only for events that need administrator review.
 * - Recognition is never treated as proof of hostile intent: no "threat" classification exists.
 */
(() => {
  "use strict";

  /* ---------------- pure logic (unit-tested in Node) ---------------- */
  const T = {
    minFacePx: 64, minScore: 0.5, maxYaw: 0.22, minLuma: 40, maxLuma: 225, minSharp: 12,
    maskChromaDelta: 16, lowerPatchesForMask: 2, eyeDarkRatio: 0.45
  };

  function rgbToYcc(r, g, b) {
    return {
      y: 0.299 * r + 0.587 * g + 0.114 * b,
      cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
      cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    };
  }

  function regionStats(data, width, height, rect) {
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.w)), y1 = Math.min(height, Math.ceil(rect.y + rect.h));
    if (x1 <= x0 || y1 <= y0) return null;
    let n = 0, sy = 0, scb = 0, scr = 0, syy = 0;
    for (let y = y0; y < y1; y++) {
      let i = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const yy = 0.299 * r + 0.587 * g + 0.114 * b;
        sy += yy;
        scb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        scr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        syy += yy * yy;
        n++;
      }
    }
    const my = sy / n;
    return { y: my, cb: scb / n, cr: scr / n, sd: Math.sqrt(Math.max(0, syy / n - my * my)), n };
  }

  function skinLike(s) { return !!s && s.cr >= 134 && s.cb <= 125 && (s.cr - s.cb) >= 12; }
  function chromaDist(a, b) { return Math.hypot(a.cb - b.cb, a.cr - b.cr); }
  function lowChroma(s) { return Math.abs(s.cb - 128) < 4 && Math.abs(s.cr - 128) < 4; }

  /* regions: {forehead, cheekL, cheekR (reference), lowerL, lowerR, chin, philtrum, eyeL, eyeR} of
   * {y,cb,cr,sd}. Returns {occluded, reason, reliable}. Beards/makeup can cause false "obscured"
   * results; the consequence is a review item, never a hostile label. */
  function decideOcclusion(r) {
    const refs = [r.forehead, r.cheekL, r.cheekR].filter(Boolean);
    const lower = [r.lowerL, r.lowerR, r.chin, r.philtrum].filter(Boolean);
    if (refs.length < 1 || lower.length < 3) return { occluded: false, reason: "", reliable: false };
    const all = refs.concat(lower);
    if (all.every(lowChroma)) return { occluded: false, reason: "monochrome", reliable: false };
    const skinRefs = refs.filter(skinLike);
    let ref = null;
    if (skinRefs.length) {
      ref = {
        cb: skinRefs.reduce((a, s) => a + s.cb, 0) / skinRefs.length,
        cr: skinRefs.reduce((a, s) => a + s.cr, 0) / skinRefs.length
      };
    }
    let maskLike = 0;
    lower.forEach(p => {
      if (!skinLike(p) || (ref && chromaDist(p, ref) > T.maskChromaDelta)) maskLike++;
    });
    if (maskLike >= T.lowerPatchesForMask + (lower.length > 3 ? 1 : 0)) {
      return { occluded: true, reason: "lower_face_covered", reliable: true };
    }
    const eyes = [r.eyeL, r.eyeR].filter(Boolean);
    const skinY = refs.length ? refs.reduce((a, s) => a + s.y, 0) / refs.length : 0;
    if (eyes.length === 2 && skinY > 0 &&
        eyes.every(e => e.y < skinY * T.eyeDarkRatio && e.sd < 28)) {
      return { occluded: true, reason: "eyes_covered", reliable: true };
    }
    return { occluded: false, reason: "", reliable: true };
  }

  function yawRatio(pts) {
    const w = pts[16].x - pts[0].x;
    if (!(w > 0)) return 1;
    return (pts[30].x - (pts[0].x + pts[16].x) / 2) / w;
  }

  function laplacianVariance(gray, w, h) {
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += v; sumSq += v * v; n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  /* Returns {ok, reason}. Poor evidence is "verification required", never "unknown person". */
  function qualityCheck(q) {
    if (Math.min(q.boxW, q.boxH) < T.minFacePx) return { ok: false, reason: "face_too_small" };
    if (q.score < T.minScore) return { ok: false, reason: "low_detection_confidence" };
    if (Math.abs(q.yaw) > T.maxYaw) return { ok: false, reason: "camera_angle" };
    if (q.luma < T.minLuma) return { ok: false, reason: "low_light" };
    if (q.luma > T.maxLuma) return { ok: false, reason: "overexposed" };
    if (q.sharp < T.minSharp) return { ok: false, reason: "motion_blur" };
    return { ok: true, reason: "" };
  }

  function center(b) { return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }

  /* Greedy nearest-centre assignment. Returns [{trackIndex|-1}] per box. */
  function assign(tracks, boxes) {
    const used = new Set();
    return boxes.map(box => {
      const c = center(box), reach = Math.max(box.width, box.height) * 0.75;
      let best = -1, bestD = Infinity;
      tracks.forEach((t, i) => {
        if (used.has(i)) return;
        const d = Math.hypot(center(t.box).x - c.x, center(t.box).y - c.y);
        if (d < reach && d < bestD) { best = i; bestD = d; }
      });
      if (best >= 0) used.add(best);
      return best;
    });
  }

  function majority(list, pick) {
    if (!list.length) return false;
    return list.filter(pick).length / list.length >= 0.6;
  }

  function topReason(list) {
    const counts = {};
    list.forEach(o => { if (!o.qualityOk && o.reason) counts[o.reason] = (counts[o.reason] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || "poor_quality";
  }

  const LOGIC = { T, rgbToYcc, regionStats, skinLike, decideOcclusion, yawRatio, laplacianVariance,
    qualityCheck, assign, majority, topReason };
  if (typeof module !== "undefined" && module.exports) module.exports = LOGIC;
  if (typeof document === "undefined") return;
  window.DEFENX_FACE_LOGIC = LOGIC;

  /* ---------------- browser runtime ---------------- */
  const section = document.getElementById("faceVerification");
  const viewport = document.getElementById("cameraViewport");
  if (!section || !viewport) return;
  const demoMode = window.location.pathname === "/" || window.location.pathname === "/demo" ||
    new URLSearchParams(window.location.search).get("demo") === "1";
  if (demoMode) { section.hidden = true; return; }

  const LIB_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js";
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/";
  const CATEGORY = {
    AUTHORIZED_PERSONNEL: { label: "AUTHORIZED PERSONNEL \u2013 VERIFIED", short: "AUTHORIZED", color: "#39e6a5", tile: "AUTHORIZED PERSONNEL" },
    UNKNOWN_PERSON: { label: "UNKNOWN PERSON DETECTED", short: "UNKNOWN \u2022 UNVERIFIED", color: "#ffb347", tile: "UNKNOWN PERSON DETECTED" },
    IDENTITY_UNVERIFIED: { label: "IDENTITY UNVERIFIED", short: "IDENTITY UNVERIFIED", color: "#ff9a5c", tile: "IDENTITY UNVERIFIED" },
    FACE_OBSCURED: { label: "IDENTITY UNVERIFIED \u2013 FACE OBSCURED", short: "FACE OBSCURED", color: "#b79cff", tile: "FACE OBSCURED" },
    VERIFICATION_REQUIRED: { label: "VERIFICATION REQUIRED", short: "VERIFYING\u2026", color: "#54cfff", tile: "VERIFICATION REQUIRED" }
  };
  const ORDER = ["AUTHORIZED_PERSONNEL", "UNKNOWN_PERSON", "IDENTITY_UNVERIFIED", "FACE_OBSCURED", "VERIFICATION_REQUIRED"];

  let status = null, isAdmin = false, enabled = false;
  let source = null, faceapi = null, modelsPromise = null, ssdLoaded = false;
  let localCameraStream = null, localCameraActive = false, localCameraVideo = null;
  let busy = false, timer = 0, tracks = [], nextTrackId = 1, lastFaceSeen = 0, forceFaceScan = false;
  let noFaceSince = 0, noFaceCategory = null, noFaceReportedAt = 0, noFaceInflight = false;
  let events = [], knownAlertIds = new Set(), alertsPrimed = false, loopStopped = false;
  const snapshotTried = new Map();
  const work = document.createElement("canvas");
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  const qualityCanvas = document.createElement("canvas");
  qualityCanvas.width = 48; qualityCanvas.height = 48;
  const qualityCtx = qualityCanvas.getContext("2d", { willReadFrequently: true });
  const qualityGray = new Float32Array(48 * 48);
  const overlay = document.createElement("canvas");
  overlay.className = "faceOverlayCanvas";
  overlay.setAttribute("aria-hidden", "true");
  viewport.appendChild(overlay);
  const octx = overlay.getContext("2d");

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  async function api(path, options) {
    const opts = Object.assign({ credentials: "same-origin", headers: {} }, options || {});
    if (opts.body && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
      opts.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(path, opts);
    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON */ }
    return { ok: response.ok, status: response.status, data: data || {} };
  }

  /* ---------------- UI ---------------- */
  const ui = {};
  function buildUi() {
    section.textContent = "";
    section.className = "card faceCard";
    const head = el("div", "cardHeader");
    head.appendChild(el("b", "", "FACE VERIFICATION"));
    ui.state = el("span", "faceStateChip", "STARTING");
    head.appendChild(ui.state);
    section.appendChild(head);
    const cameraTools = el("div", "faceRow");
    ui.scanStart = el("button", "faceBtn primary", "START FACE SCAN");
    ui.scanStart.id = "defenxStartFaceScan";
    ui.scanStart.style.cssText = "position:relative;z-index:20;pointer-events:auto;touch-action:manipulation;min-height:42px;";
    ui.scanStart.type = "button";
    ui.cameraStart = el("button", "faceBtn", "USE THIS DEVICE CAMERA (TEST)");
    ui.cameraStart.type = "button";
    ui.cameraStop = el("button", "faceBtn danger", "STOP DEVICE CAMERA");
    ui.cameraStop.type = "button";
    ui.cameraStop.hidden = true;
    cameraTools.appendChild(ui.scanStart);
    cameraTools.appendChild(ui.cameraStart);
    cameraTools.appendChild(ui.cameraStop);
    ui.cameraStatus = el("small", "faceHint",
      "Optional test mode. Camera starts only after you tap the button. Frames stay in this browser; face-template numbers are sent for matching.");
    section.appendChild(cameraTools);
    section.appendChild(ui.cameraStatus);
    // Bind directly to the generated button. This avoids delegated-event interception
    // by dashboard handlers and guarantees one scan invocation per tap.
    ui.scanStart.addEventListener("click", (event) => {
      event.preventDefault();
      if (ui.scanStart.disabled) return;
      startFaceScan().catch(error => {
        ui.cameraStatus.textContent = "Face scan could not start: " + String(error && error.message || error);
        ui.scanStart.disabled = false;
      });
    });
    ui.cameraStart.addEventListener("click", startLocalCamera);
    ui.cameraStop.addEventListener("click", stopLocalCamera);
    ui.notice = el("div", "faceNotice");
    ui.notice.hidden = true;
    ui.notice.setAttribute("role", "status");
    section.appendChild(ui.notice);
    ui.tiles = el("div", "faceTiles");
    ui.tileCount = {};
    ORDER.forEach(key => {
      const tile = el("div", "faceTile");
      tile.style.setProperty("--faceColor", CATEGORY[key].color);
      tile.appendChild(el("small", "", CATEGORY[key].tile));
      ui.tileCount[key] = el("b", "", "0");
      tile.appendChild(ui.tileCount[key]);
      ui.tiles.appendChild(tile);
    });
    section.appendChild(ui.tiles);
    ui.list = el("div", "faceEvents");
    section.appendChild(ui.list);
    section.appendChild(el("p", "faceFoot",
      "Face matching runs in this browser; only numeric templates are compared on the server. " +
      "An unrecognised or covered face is UNVERIFIED, not a threat. For rover-camera events, a small encrypted review snapshot may be uploaded; local test-camera frames are never uploaded."));
    if (isAdmin) buildAdmin();
  }

  function buildAdmin() {
    const box = document.createElement("details");
    box.className = "faceAdmin";
    box.appendChild(el("summary", "", "AUTHORIZED PERSONNEL REGISTRY (ADMIN)"));
    box.appendChild(el("p", "faceHint",
      "Add 3\u20135 clear, front-facing photos per person (different lighting helps). Photos are processed in this " +
      "browser only and are never uploaded; only encrypted numeric face templates are stored."));
    ui.name = el("input", "faceInput");
    ui.name.type = "text"; ui.name.maxLength = 64; ui.name.placeholder = "Full name / ID label";
    ui.name.setAttribute("aria-label", "Authorized person name");
    ui.files = el("input", "faceInput");
    ui.files.type = "file"; ui.files.accept = "image/*"; ui.files.multiple = true;
    ui.files.setAttribute("aria-label", "Face photos");
    const row = el("div", "faceRow");
    ui.live = el("button", "faceBtn", "ADD LIVE CAMERA FRAME");
    ui.live.type = "button";
    ui.register = el("button", "faceBtn primary", "REGISTER");
    ui.register.type = "button";
    row.appendChild(ui.live); row.appendChild(ui.register);
    ui.regMsg = el("div", "faceMsg");
    ui.regMsg.setAttribute("role", "status");
    ui.pending = [];
    ui.people = el("div", "facePeople");
    [ui.name, ui.files, row, ui.regMsg, ui.people].forEach(n => box.appendChild(n));
    section.appendChild(box);
    ui.files.addEventListener("change", () => addDescriptors(Array.from(ui.files.files), false));
    ui.live.addEventListener("click", () => addDescriptors([], true));
    ui.register.addEventListener("click", registerPerson);
    box.addEventListener("toggle", () => { if (box.open) loadPeople(); });
  }

  function setChip(text, state) {
    if (!ui.state) return;
    ui.state.textContent = text;
    ui.state.dataset.state = state;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "--" : d.toLocaleString();
  }

  function statusText(ev) {
    if (ev.category === "AUTHORIZED_PERSONNEL") return "VERIFIED";
    if (ev.category === "VERIFICATION_REQUIRED") return "RE-CHECKING";
    return ({ OPEN: "PENDING REVIEW", VERIFIED_BY_ADMIN: "VERIFIED BY ADMIN", DISMISSED: "DISMISSED",
      ACKNOWLEDGED: "ACKNOWLEDGED" })[ev.status] || String(ev.status || "");
  }

  function renderEvents() {
    const dayAgo = Date.now() - 86400000;
    const counts = {};
    ORDER.forEach(k => { counts[k] = 0; });
    events.forEach(ev => {
      if (new Date(ev.last_seen).getTime() >= dayAgo && counts[ev.category] !== undefined) counts[ev.category]++;
    });
    ORDER.forEach(k => { ui.tileCount[k].textContent = String(counts[k]); });
    ui.list.textContent = "";
    if (!events.length) {
      ui.list.appendChild(el("div", "faceEmpty", "No verification events yet."));
    }
    events.slice(0, 20).forEach(ev => {
      const meta = CATEGORY[ev.category] || CATEGORY.VERIFICATION_REQUIRED;
      const item = el("div", "faceEvent");
      item.style.setProperty("--faceColor", meta.color);
      if (isAdmin && ev.has_snapshot) {
        const img = document.createElement("img");
        img.className = "faceThumb"; img.loading = "lazy"; img.alt = "Snapshot for review";
        img.src = "/api/faces/events/" + encodeURIComponent(ev.id) + "/snapshot";
        item.appendChild(img);
      }
      const body = el("div", "faceBody");
      body.appendChild(el("b", "", ev.label || meta.label));
      let line = "Status: " + statusText(ev);
      if (isAdmin && ev.person_label) line = ev.person_label + " \u2022 " + line;
      body.appendChild(el("span", "", line));
      const loc = ev.location && Number.isFinite(Number(ev.location.lat))
        ? Number(ev.location.lat).toFixed(5) + ", " + Number(ev.location.lon).toFixed(5) : "location n/a";
      body.appendChild(el("small", "", fmtTime(ev.first_seen) + " \u2022 " + (ev.camera || "camera") + " \u2022 " + loc));
      if (ev.count > 1) body.appendChild(el("small", "", "Last seen " + fmtTime(ev.last_seen) + " \u2022 " + ev.count + " observations"));
      if (isAdmin && ev.reason) body.appendChild(el("small", "", "Reason: " + String(ev.reason).replace(/_/g, " ") +
        (ev.match_distance != null ? " \u2022 distance " + ev.match_distance : "")));
      if (isAdmin && ev.notify_admin) {
        const actions = el("div", "faceRow");
        [["verify", "MARK VERIFIED"], ["dismiss", "DISMISS"]].forEach(pair => {
          const b = el("button", "faceBtn", pair[1]);
          b.type = "button";
          b.addEventListener("click", () => reviewEvent(ev.id, pair[0]));
          actions.appendChild(b);
        });
        const del = el("button", "faceBtn danger", "DELETE");
        del.type = "button";
        del.addEventListener("click", () => deleteEvent(ev.id));
        actions.appendChild(del);
        body.appendChild(actions);
      }
      item.appendChild(body);
      ui.list.appendChild(item);
    });
    if (isAdmin) {
      const open = events.filter(e => e.notify_admin && !e.alert_ack);
      ui.notice.hidden = open.length === 0;
      ui.notice.textContent = open.length
        ? "ADMIN NOTICE \u2022 " + open.length + " identity verification event" + (open.length > 1 ? "s" : "") +
          " awaiting review. This is not a threat assessment."
        : "";
      open.forEach(e => knownAlertIds.add(e.id));
    }
  }

  async function pollEvents() {
    if (document.hidden || !enabled) return;
    try {
      const r = await api("/api/faces/events?limit=50");
      if (r.status === 401) { enabled = false; setChip("SIGN-IN REQUIRED", "off"); return; }
      if (r.ok && Array.isArray(r.data.events)) { events = r.data.events; renderEvents(); }
    } catch (_) { /* transient network error; next poll retries */ }
  }

  async function reviewEvent(id, action) {
    const r = await api("/api/faces/events/" + id + "/review", { method: "POST", body: { action } });
    if (!r.ok) alert(r.data.error || "Review failed");
    pollEvents();
  }

  async function deleteEvent(id) {
    if (!confirm("Delete this event and its snapshot permanently?")) return;
    const r = await api("/api/faces/events/" + id, { method: "DELETE" });
    if (!r.ok) alert(r.data.error || "Delete failed");
    pollEvents();
  }

  /* ---------------- models ---------------- */
  function loadScript(url) {
    if (window.faceapi) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url; s.async = true; s.crossOrigin = "anonymous";
      s.onload = () => window.faceapi ? resolve() : reject(new Error("face library missing"));
      s.onerror = () => reject(new Error("face library load failed"));
      document.head.appendChild(s);
    });
  }

  async function ensureModels(needSsd) {
    if (!modelsPromise) {
      modelsPromise = (async () => {
        setChip("LOADING FACE MODELS", "loading");
        await loadScript(LIB_URL);
        faceapi = window.faceapi;
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
        ]);
      })().catch(err => { modelsPromise = null; throw err; });
    }
    await modelsPromise;
    if (needSsd && !ssdLoaded) {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
      ssdLoaded = true;
    }
  }

  /* ---------------- camera + analysis ---------------- */
  function sourceReady(e) {
    if (!e) return false;
    if (e.tagName === "VIDEO") return e.readyState >= 2 && e.videoWidth > 0;
    if (e.tagName === "IMG") return e.complete && e.naturalWidth > 0;
    return false;
  }
  function sourceSize(e) {
    return e.tagName === "VIDEO" ? { w: e.videoWidth, h: e.videoHeight } : { w: e.naturalWidth, h: e.naturalHeight };
  }

  function drawWork(src, dims) {
    const w = Math.min(dims.w, 640), f = w / dims.w;
    work.width = w; work.height = Math.max(1, Math.round(dims.h * f));
    workCtx.drawImage(src, 0, 0, work.width, work.height);
    return f;
  }

  function patch(cx, cy, half, f) {
    return { x: (cx - half) * f, y: (cy - half) * f, w: half * 2 * f, h: half * 2 * f };
  }

  function analyseFace(det, f) {
    const pts = det.landmarks.positions;
    const box = det.detection.box;
    const faceW = pts[16].x - pts[0].x;
    const half = Math.max(3, faceW * 0.06);
    const stats = rect => workCtx.getImageData(
      Math.max(0, Math.floor(rect.x)), Math.max(0, Math.floor(rect.y)),
      Math.max(1, Math.floor(rect.w)), Math.max(1, Math.floor(rect.h)));
    const S = rect => { const d = stats(rect); return regionStats(d.data, d.width, d.height, { x: 0, y: 0, w: d.width, h: d.height }); };
    const mid = (a, b) => ({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
    const browTop = Math.min(...pts.slice(17, 27).map(p => p.y));
    const faceH = pts[8].y - browTop;
    const eyeBox = idx => {
      const xs = idx.map(i => pts[i].x), ys = idx.map(i => pts[i].y);
      return { x: Math.min(...xs) * f, y: Math.min(...ys) * f, w: (Math.max(...xs) - Math.min(...xs)) * f, h: Math.max(2, (Math.max(...ys) - Math.min(...ys))) * f };
    };
    const fh = { x: (pts[21].x + pts[22].x) / 2, y: browTop - faceH * 0.15 };
    const cheekL = mid(36, 31), cheekR = mid(45, 35);
    const lowL = mid(4, 48), lowR = mid(12, 54), chin = { x: pts[8].x, y: (pts[57].y + pts[8].y) / 2 };
    const phil = { x: pts[33].x, y: (pts[33].y + pts[51].y) / 2 };
    const safe = fn => { try { return fn(); } catch (_) { return null; } };
    const regions = {
      forehead: safe(() => S(patch(fh.x, fh.y, half, f))),
      cheekL: safe(() => S(patch(cheekL.x, cheekL.y, half, f))),
      cheekR: safe(() => S(patch(cheekR.x, cheekR.y, half, f))),
      lowerL: safe(() => S(patch(lowL.x, lowL.y, half, f))),
      lowerR: safe(() => S(patch(lowR.x, lowR.y, half, f))),
      chin: safe(() => S(patch(chin.x, chin.y, half, f))),
      philtrum: safe(() => S(patch(phil.x, phil.y, half * 0.7, f))),
      eyeL: safe(() => S(eyeBox([36, 37, 38, 39, 40, 41]))),
      eyeR: safe(() => S(eyeBox([42, 43, 44, 45, 46, 47])))
    };
    const occ = decideOcclusion(regions);

    // Lighting + sharpness from a 48x48 grayscale crop of the face box.
    qualityCtx.drawImage(work, box.x * f, box.y * f, Math.max(1, box.width * f), Math.max(1, box.height * f), 0, 0, 48, 48);
    const px = qualityCtx.getImageData(0, 0, 48, 48).data, gray = qualityGray;
    let luma = 0;
    for (let i = 0; i < 48 * 48; i++) {
      const p = i * 4;
      const y = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
      gray[i] = y; luma += y;
    }
    luma /= 48 * 48;
    const quality = qualityCheck({
      boxW: box.width, boxH: box.height, score: det.detection.score, yaw: yawRatio(pts),
      luma, sharp: laplacianVariance(gray, 48, 48)
    });
    return { occluded: occ.occluded, occReason: occ.reason, qualityOk: quality.ok, reason: quality.reason || occ.reason };
  }

  function captureSnapshot() {
    if (!sourceReady(source)) return null;
    const dims = sourceSize(source);
    const c = document.createElement("canvas");
    for (const width of [256, 192, 144]) {
      c.width = width; c.height = Math.max(1, Math.round(dims.h * width / dims.w));
      c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
      for (const q of [0.6, 0.5, 0.4, 0.3]) {
        const b64 = c.toDataURL("image/jpeg", q).split(",")[1] || "";
        if (b64 && b64.length * 0.75 <= 17500) return b64;
      }
    }
    return null;
  }

  async function uploadSnapshot(eventId) {
    const tries = snapshotTried.get(eventId) || 0;
    if (tries >= 2) return;
    snapshotTried.set(eventId, tries + 1);
    if (snapshotTried.size > 200) snapshotTried.delete(snapshotTried.keys().next().value);
    let b64 = null;
    try { b64 = captureSnapshot(); } catch (_) { return; } // tainted canvas: camera lacks CORS
    if (!b64) return;
    try { await api("/api/faces/events/" + eventId + "/snapshot", { method: "POST", body: { image_b64: b64 } }); } catch (_) { /* retry on next report */ }
  }

  /* ---------------- reporting ---------------- */
  async function report(payload) {
    const r = await api("/api/faces/observe", { method: "POST", body: payload });
    if (r.status === 503 && r.data.code === "not_configured") { enabled = false; setChip("NOT CONFIGURED", "off"); return null; }
    if (!r.ok) return null;
    if (r.data.need_snapshot && !localCameraActive) uploadSnapshot(r.data.event_id);
    return r.data;
  }

  function maybeReport(track, now) {
    if (track.inflight || track.obs.length < 3 && now - track.firstSeen < 2500) return;
    if (track.obs.length < 2) return;
    const interval = track.category === "VERIFICATION_REQUIRED" || !track.category ? 4000 : 20000;
    if (track.lastReport && now - track.lastReport < interval) return;
    const recent = track.obs.slice(-5);
    track.inflight = true;
    track.lastReport = now;
    report({
      state: "face",
      descriptors: recent.map(o => o.desc),
      occluded: majority(recent, o => o.occluded),
      quality_ok: majority(recent, o => o.qualityOk),
      quality_reason: topReason(recent),
      persisted_s: (now - track.firstSeen) / 1000
    }).then(result => {
      if (result) { track.category = result.category; track.categoryAt = Date.now(); track.personLabel = result.person_label || null; }
    }).catch(() => { /* retried at next interval */ }).finally(() => { track.inflight = false; });
  }

  /* ---------------- frame loop ---------------- */
  function freshPersons() {
    const p = window.ROVER_AI_VISION_PERSONS;
    return p && Date.now() - p.at < 2500 ? p : null;
  }

  async function processFrame() {
    const src = source, dims = sourceSize(src), now = Date.now();
    const f = drawWork(src, dims);
    const dets = (await faceapi.detectAllFaces(src,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })).withFaceLandmarks().withFaceDescriptors())
      .sort((a, b) => b.detection.box.width * b.detection.box.height - a.detection.box.width * a.detection.box.height)
      .slice(0, 4);
    const boxes = dets.map(d => d.detection.box);
    const map = assign(tracks, boxes);
    dets.forEach((det, i) => {
      let track = map[i] >= 0 ? tracks[map[i]] : null;
      if (!track) {
        track = { id: nextTrackId++, box: boxes[i], obs: [], firstSeen: now, lastSeen: now, category: null, lastReport: 0, inflight: false };
        tracks.push(track);
      }
      track.box = boxes[i]; track.lastSeen = now;
      let analysis;
      try { analysis = analyseFace(det, f); } catch (err) {
        if (/taint|cross.origin|security/i.test(String(err && err.message || err))) throw err;
        analysis = { occluded: false, qualityOk: false, reason: "analysis_failed" };
      }
      track.obs.push({ desc: Array.from(det.descriptor), occluded: analysis.occluded, qualityOk: analysis.qualityOk, reason: analysis.reason });
      if (track.obs.length > 8) track.obs.shift();
      // A change of evidence (e.g. mask removed) forces a prompt re-check.
      const recent = track.obs.slice(-3);
      if (track.category && recent.length === 3 && track.category !== "VERIFICATION_REQUIRED") {
        const occludedNow = majority(recent, o => o.occluded);
        if ((track.category === "FACE_OBSCURED") !== occludedNow && now - track.lastReport > 2500) track.lastReport = 0;
      }
      maybeReport(track, now);
    });
    if (dets.length) lastFaceSeen = now;
    tracks = tracks.filter(t => now - t.lastSeen < 2500);
    handleNoFace(dims, boxes, now);
    drawOverlay(dims);
  }

  /* A person is visible (COCO-SSD) close enough to expect a face, but no face is found. */
  function handleNoFace(dims, faceBoxes, now) {
    const persons = freshPersons();
    let missing = false;
    if (persons && persons.height > 0) {
      missing = persons.boxes.some(pb => {
        if (pb[3] < persons.height * 0.25) return false;
        return !faceBoxes.some(fb => {
          const c = center(fb);
          return c.x >= pb[0] && c.x <= pb[0] + pb[2] && c.y >= pb[1] && c.y <= pb[1] + pb[3];
        });
      });
    }
    if (!missing) { noFaceSince = 0; noFaceCategory = null; return; }
    if (!noFaceSince) noFaceSince = now;
    const seconds = (now - noFaceSince) / 1000;
    if (seconds < 3 || noFaceInflight || now - noFaceReportedAt < 4000) return;
    noFaceInflight = true; noFaceReportedAt = now;
    report({ state: "no_face", descriptors: [], persisted_s: seconds })
      .then(r => { if (r) noFaceCategory = r.category; })
      .catch(() => {}).finally(() => { noFaceInflight = false; });
  }

  function drawOverlay(dims) {
    const rect = viewport.getBoundingClientRect();
    const vw = Math.max(1, Math.round(rect.width)), vh = Math.max(1, Math.round(rect.height));
    if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }
    octx.clearRect(0, 0, vw, vh);
    const scale = Math.max(vw / dims.w, vh / dims.h);
    const ox = (vw - dims.w * scale) / 2, oy = (vh - dims.h * scale) / 2;
    tracks.forEach(t => {
      const meta = CATEGORY[t.category] || CATEGORY.VERIFICATION_REQUIRED;
      const x = t.box.x * scale + ox, y = t.box.y * scale + oy, w = t.box.width * scale, h = t.box.height * scale;
      octx.strokeStyle = meta.color; octx.lineWidth = 2; octx.strokeRect(x, y, w, h);
      octx.font = "700 10px system-ui, sans-serif";
      const label = meta.short;
      const lw = octx.measureText(label).width + 10, top = Math.max(0, y - 18);
      octx.fillStyle = meta.color; octx.fillRect(x, top, lw, 16);
      octx.fillStyle = "#031018"; octx.fillText(label, x + 5, top + 12);
    });
  }

  function clearOverlay() { octx.clearRect(0, 0, overlay.width, overlay.height); }

  async function tick() {
    if (busy || loopStopped) return;
    const next = ms => { clearTimeout(timer); timer = setTimeout(tick, ms); };
    if (!enabled || document.hidden) return next(1500);
    if (!source || !sourceReady(source)) {
      tracks = []; clearOverlay(); setChip("WAITING FOR LIVE CAMERA", "idle"); return next(1200);
    }
    const now = Date.now(), persons = freshPersons();
    const want = forceFaceScan || (persons && persons.boxes.length > 0) || (tracks.length > 0 && now - lastFaceSeen < 3000);
    if (!want) {
      if (tracks.length) { tracks = []; clearOverlay(); }
      noFaceSince = 0; noFaceCategory = null;
      setChip(faceapi ? "IDLE \u2022 NO PERSON IN VIEW" : "STANDBY \u2022 STARTS WHEN A PERSON APPEARS", "idle");
      return next(800);
    }
    busy = true;
    try {
      await ensureModels(false);
      await processFrame();
      setChip("ACTIVE \u2022 VERIFYING", "active");
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/taint|cross.origin|security/i.test(msg)) {
        loopStopped = true; clearOverlay(); tracks = [];
        setChip("CAMERA CORS BLOCKS FACE CHECK", "error");
        busy = false; return;
      }
      setChip(/load/i.test(msg) ? "FACE MODELS UNAVAILABLE \u2022 CHECK INTERNET" : "FACE CHECK ERROR \u2022 RETRYING", "error");
      busy = false; return next(8000);
    }
    busy = false;
    next(450);
  }

  window.DEFENX_FACE_ALL_AUTHORIZED = () => {
    const now = Date.now();
    const live = tracks.filter(t => now - t.lastSeen < 3000);
    const authorized = live.filter(t => t.category === "AUTHORIZED_PERSONNEL" && now - (t.categoryAt || 0) < 30000);
    if (!authorized.length || authorized.length !== live.length) return false;
    if (noFaceSince || noFaceCategory) return false;
    const persons = freshPersons();
    return !!persons && persons.boxes.length === authorized.length;
  };

  /* ---------------- registration (admin) ---------------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
      img.src = url;
    });
  }

  function regMessage(text, bad) { ui.regMsg.textContent = text; ui.regMsg.dataset.bad = bad ? "1" : "0"; }

  async function addDescriptors(files, fromLive) {
    try {
      regMessage("Loading face models\u2026");
      await ensureModels(true);
      const inputs = [];
      if (fromLive) {
        if (!sourceReady(source)) { regMessage("Live camera is not ready.", true); return; }
        inputs.push({ name: "live camera frame", node: source });
      }
      for (const file of files) {
        try { inputs.push({ name: file.name, node: await loadImage(file) }); }
        catch (_) { regMessage(file.name + ": unreadable image.", true); }
      }
      const notes = [];
      for (const input of inputs) {
        const dims = input.node.tagName === "IMG" ? { w: input.node.naturalWidth, h: input.node.naturalHeight } : sourceSize(input.node);
        const dets = await faceapi.detectAllFaces(input.node, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
          .withFaceLandmarks().withFaceDescriptors();
        if (dets.length !== 1) { notes.push(input.name + ": needs exactly one face (found " + dets.length + ")"); continue; }
        const det = dets[0];
        if (Math.min(det.detection.box.width, det.detection.box.height) < 100) { notes.push(input.name + ": face too small"); continue; }
        const f = drawWork(input.node, dims);
        const a = analyseFace(det, f);
        if (a.occluded) { notes.push(input.name + ": face covered (" + a.occReason.replace(/_/g, " ") + ")"); continue; }
        if (!a.qualityOk) { notes.push(input.name + ": " + a.reason.replace(/_/g, " ")); continue; }
        ui.pending.push(Array.from(det.descriptor));
        notes.push(input.name + ": accepted");
      }
      ui.files.value = "";
      regMessage(ui.pending.length + " face template(s) ready. " + notes.join(" \u2022 "), ui.pending.length === 0);
    } catch (err) {
      regMessage("Could not process images: " + String(err && err.message || err), true);
    }
  }

  async function registerPerson() {
    const label = ui.name.value.trim();
    if (!label) { regMessage("Enter a name or ID label.", true); return; }
    if (ui.pending.length < 3) { regMessage("Add at least 3 accepted face photos before registering.", true); return; }
    ui.register.disabled = true;
    const r = await api("/api/faces/people", { method: "POST", body: { label, descriptors: ui.pending.slice(0, 10) } });
    ui.register.disabled = false;
    if (!r.ok) { regMessage(r.data.error || "Registration failed.", true); return; }
    ui.pending = []; ui.name.value = "";
    regMessage("Registered " + label + ". Authorization is active immediately.");
    loadPeople();
  }

  async function loadPeople() {
    const r = await api("/api/faces/people");
    if (!r.ok) return;
    ui.people.textContent = "";
    if (r.data.registry_ok === false) ui.people.appendChild(el("div", "faceMsg", "Warning: an unreadable registry record was found. Verification is failing safe until it is removed.")).dataset.bad = "1";
    if (!r.data.people.length) ui.people.appendChild(el("div", "faceEmpty", "No authorized personnel registered."));
    r.data.people.forEach(p => {
      const row = el("div", "facePerson");
      const info = el("div", "faceBody");
      info.appendChild(el("b", "", p.label));
      info.appendChild(el("small", "", (p.enabled ? "AUTHORIZED" : "AUTHORIZATION REVOKED") + " \u2022 " + p.templates + " template(s) \u2022 added " + fmtTime(p.created_at)));
      row.appendChild(info);
      const toggle = el("button", "faceBtn", p.enabled ? "REVOKE" : "REINSTATE");
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        if (p.enabled && !confirm("Revoke authorization for " + p.label + "? They will be treated as unverified.")) return;
        await api("/api/faces/people/" + p.id, { method: "PATCH", body: { enabled: !p.enabled } });
        loadPeople();
      });
      const del = el("button", "faceBtn danger", "DELETE DATA");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!confirm("Permanently delete all face data for " + p.label + "? This cannot be undone.")) return;
        await api("/api/faces/people/" + p.id, { method: "DELETE" });
        loadPeople();
      });
      row.appendChild(toggle); row.appendChild(del);
      ui.people.appendChild(row);
    });
  }

  /* ---------------- explicit face scan controls ---------------- */
  async function startFaceScan() {
    if (!enabled) {
      ui.cameraStatus.textContent = "Face verification is not configured. The administrator must set FACE_DATA_KEY on the preview Worker.";
      return;
    }
    ui.scanStart.disabled = true;
    forceFaceScan = true;
    ui.cameraStatus.textContent = "Starting face scan…";
    if (sourceReady(source)) {
      loopStopped = false;
      clearTimeout(timer);
      setChip("STARTING FACE SCAN", "idle");
      await tick();
      ui.cameraStatus.textContent = "Face scan requested on the active camera. Keep the face clearly visible.";
      ui.scanStart.disabled = false;
      return;
    }
    await startLocalCamera();
    ui.scanStart.disabled = false;
  }

  /* ---------------- explicit local camera test mode ---------------- */
  async function startLocalCamera() {
    if (sourceReady(source)) {
      ui.cameraStatus.textContent = "A rover camera feed is already active; local test mode will not replace it.";
      return;
    }
    // Do not replace a configured but still-loading remote rover feed.
    if (source && (source.tagName === "IFRAME" ||
        (source.tagName === "IMG" && source.getAttribute("src")) ||
        (source.tagName === "VIDEO" && (source.getAttribute("src") || source.srcObject)))) {
      ui.cameraStatus.textContent = "A rover camera stream is configured or loading. Local test mode will not override it.";
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      ui.cameraStatus.textContent = "This browser does not support camera access. Use HTTPS on a supported browser.";
      return;
    }
    ui.cameraStart.disabled = true;
    ui.cameraStatus.textContent = "Waiting for camera permission…";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
      localCameraStream = stream;
      let video = document.getElementById("roverRealCamera");
      if (!video || video.tagName !== "VIDEO") {
        const replacement = document.createElement("video");
        replacement.id = "roverRealCamera";
        if (video) video.replaceWith(replacement);
        else viewport.insertBefore(replacement, viewport.firstChild);
        video = replacement;
      }
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("aria-label", "Local device camera test feed");
      video.style.cssText = "display:block;width:100%;height:100%;object-fit:cover;background:#02070b;position:absolute;inset:0;z-index:4";
      video.srcObject = stream;
      await video.play();
      localCameraStream = stream;
      localCameraVideo = video;
      localCameraActive = true;
      const scene = document.getElementById("camera3DScene");
      if (scene) scene.style.display = "none";
      ui.cameraStart.hidden = true;
      ui.cameraStop.hidden = false;
      ui.cameraStatus.textContent = "LOCAL DEVICE CAMERA ACTIVE • TEST ONLY • FRAMES NOT UPLOADED";
      findSource();
      clearTimeout(timer);
      timer = setTimeout(tick, 100);
    } catch (err) {
      if (localCameraStream) localCameraStream.getTracks().forEach(track => track.stop());
      localCameraStream = null;
      localCameraActive = false;
      ui.cameraStart.disabled = false;
      ui.cameraStatus.textContent = "Camera could not start: " + String(err && err.message || err);
      setChip("CAMERA PERMISSION REQUIRED", "error");
    }
  }

  function stopLocalCamera() {
    if (localCameraStream) localCameraStream.getTracks().forEach(track => track.stop());
    if (localCameraVideo) {
      localCameraVideo.pause();
      localCameraVideo.srcObject = null;
      localCameraVideo.style.display = "none";
    }
    localCameraStream = null;
    localCameraVideo = null;
    localCameraActive = false;
    tracks = [];
    forceFaceScan = false;
    clearOverlay();
    const scene = document.getElementById("camera3DScene");
    if (scene) scene.style.display = "";
    if (ui.cameraStart) {
      ui.cameraStart.hidden = false;
      ui.cameraStart.disabled = false;
    }
    if (ui.cameraStop) ui.cameraStop.hidden = true;
    if (ui.cameraStatus) ui.cameraStatus.textContent = "Local camera stopped. No local test-camera snapshots were uploaded.";
    setChip("WAITING FOR LIVE CAMERA", "idle");
  }

  /* ---------------- camera source discovery ---------------- */
  function findSource() {
    const e = document.getElementById("roverRealCamera");
    if (localCameraActive && e !== localCameraVideo) stopLocalCamera();
    if (e === source) return;
    source = e; loopStopped = false; tracks = []; clearOverlay();
    if (e && e.tagName === "IFRAME") { setChip("EMBEDDED CAMERA \u2022 USE DIRECT MJPEG / VIDEO", "error"); source = null; }
    clearTimeout(timer); timer = setTimeout(tick, 300);
  }

  /* ---------------- start ---------------- */
  (async function start() {
    let r;
    try { r = await api("/api/faces/status"); } catch (_) { section.hidden = true; return; }
    if (!r.ok) { section.hidden = true; return; }
    status = r.data; isAdmin = !!status.admin;
    section.hidden = false;
    buildUi();
    if (!status.configured) {
      setChip("NOT CONFIGURED \u2022 SET FACE_DATA_KEY", "off");
      ui.list.appendChild(el("div", "faceEmpty", "Face verification is disabled until the administrator configures FACE_DATA_KEY on the server."));
      ui.cameraStart.disabled = true;
      ui.cameraStatus.textContent = "Camera test is disabled until FACE_DATA_KEY is configured.";
      return;
    }
    enabled = true;
    setChip("STARTING", "idle");
    new MutationObserver(findSource).observe(viewport, { childList: true });
    findSource();
    pollEvents();
    setInterval(pollEvents, 4000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollEvents(); clearTimeout(timer); timer = setTimeout(tick, 200); } });
    window.addEventListener("resize", () => { if (tracks.length && source && sourceReady(source)) drawOverlay(sourceSize(source)); });
    timer = setTimeout(tick, 500);
    window.addEventListener("pagehide", stopLocalCamera, { once: true });
  })();
})();
