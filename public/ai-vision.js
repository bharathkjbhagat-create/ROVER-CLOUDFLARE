/* DEFENX on-device AI vision pipeline (orchestrator).
 * One sequential scheduler drives object detection (TensorFlow.js COCO-SSD) and
 * the face pipeline (face-recognition.js). Both read the SAME live camera element
 * and nothing else, so reference photographs can never enter this pipeline.
 * Frames stay in this browser; only alert metadata is sent to the backend.
 * Decisions are made in vision-core.js: anything not positively established is
 * reported as UNVERIFIED rather than guessed.
 */
(() => {
  "use strict";
  const core = window.DEFENX_VISION_CORE;
  const viewport = document.getElementById("cameraViewport");
  const bar = document.getElementById("aiVisionBar");
  const statusText = document.getElementById("aiVisionState");
  const toggle = document.getElementById("aiVisionToggle");
  const humanCount = document.getElementById("aiHumanCount");
  const vehicleCount = document.getElementById("aiVehicleCount");
  if (!core || !viewport || !bar || !statusText || !toggle) return;

  const demoMode = window.location.pathname === "/demo" ||
    new URLSearchParams(window.location.search).get("demo") === "1";
  const STATUS = core.STATUS, T = core.THRESHOLDS;
  const canvas = document.createElement("canvas");
  canvas.className = "aiVisionCanvas";
  canvas.setAttribute("aria-label", "AI detection overlay");
  canvas.setAttribute("aria-hidden", "true");
  viewport.appendChild(canvas);
  const context = canvas.getContext("2d");
  const work = document.createElement("canvas");
  const workCtx = work.getContext("2d", { willReadFrequently: true });
  const tfUrl = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
  const modelUrl = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";
  const slow = (navigator.hardwareConcurrency || 4) <= 4 || window.matchMedia("(max-width: 700px)").matches;
  const OBJECT_DELAY = slow ? 1400 : 900, FACE_DELAY = slow ? 220 : 150;

  let source = null, model = null, modelPromise = null, paused = false, running = false, timer = 0;
  let visionRoomJoined = false, visionSyncConnected = false, visionOwner = true, visionClaimPending = false, lastVisionPublish = 0;
  const VISION_SYNC_INTERVAL = 750;
  let sourceGeneration = 0, corsCheckedFor = null, failures = 0, lastToken = null, lastWorkAt = 0;
  let objTracker = new core.Tracker(), screens = [], nextObj = 0, nextFace = 0, busy = false;
  let objMs = 0, objectModelFailed = false, cache = { now: -1, value: null }, faceFails = 0, faceBroken = false;
  const stats = window.DEFENX_VISION_STATS = { objectMs: 0, faceMs: 0, descriptorMs: 0, cycles: 0, skippedFrames: 0 };
  const face = () => window.DEFENX_FACE;

  const setText = (id, value) => { const e = document.getElementById(id); if (e) e.textContent = String(value); };
  function setState(state, message) {
    bar.dataset.state = state;
    statusText.textContent = message;
    window.ROVER_AI_VISION_STATUS = state;
    const canRetry = state === "error" && sourceReady(source) && !paused;
    toggle.disabled = state === "loading" || state === "waiting" || state === "unsupported" || state === "demo" || (state === "error" && !canRetry);
    toggle.textContent = paused ? "RESUME AI" : canRetry ? "RETRY AI" : "PAUSE AI";
    setText("deviceAiState", state === "active" ? "AI LIVE" : state === "paused" ? "PAUSED" : state === "loading" ? "LOADING" : "WAITING");
  }
  function publish(counts) {
    if (humanCount) humanCount.textContent = String(counts.human);
    if (vehicleCount) vehicleCount.textContent = String(counts.vehicle);
    setText("person", counts.human); setText("vehicle", counts.vehicle); setText("object", counts.object);
    setText("confidence", Math.round(counts.confidence * 100) + "%");
    window.ROVER_AI_VISION_COUNTS = counts;
    window.dispatchEvent(new CustomEvent("defenx-ai-detection", { detail: counts }));
  }
  const zeroCounts = () => ({ human: 0, vehicle: 0, object: 0, unverified: 0, photo: 0, confidence: 0 });
  function clearAll() {
    objTracker = new core.Tracker(); screens = [];
    if (face()) face().reset();
    clearOverlay(); publish(zeroCounts());
  }
  function clearOverlay() { if (context) context.clearRect(0, 0, canvas.width, canvas.height); }

  /* ---------------- source handling ---------------- */
  function sourceReady(el) {
    if (!el) return false;
    // A remote WebRTC stream is not a valid live AI source while its sender
    // has paused/stopped the camera track.
    if (el.dataset?.defenxRemoteCamera === "1" && el.dataset.defenxCameraActive !== "1") return false;
    if (el.tagName === "VIDEO") {
      const tracks = el.srcObject && typeof el.srcObject.getVideoTracks === "function" ? el.srcObject.getVideoTracks() : [];
      const liveTrack = tracks.some(track => track.readyState === "live" && track.enabled);
      return el.dataset.defenxLiveStream === "1" && !el.paused && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0 && (liveTrack || Boolean(el.currentSrc || el.src));
    }
    if (el.tagName === "IMG") return el.dataset.defenxLiveStream === "1" && el.complete && el.naturalWidth > 0 && el.naturalHeight > 0;
    return false;
  }
  const sourceSize = el => el.tagName === "VIDEO" ? { width: el.videoWidth, height: el.videoHeight } : { width: el.naturalWidth, height: el.naturalHeight };
  function checkReadable(el) {
    if (corsCheckedFor === el) return;
    const probe = document.createElement("canvas"); probe.width = probe.height = 1;
    const c = probe.getContext("2d", { willReadFrequently: true });
    c.drawImage(el, 0, 0, 1, 1); c.getImageData(0, 0, 1, 1);
    corsCheckedFor = el;
  }
  // A token that changes only when a NEW frame was decoded, so duplicate frames are skipped.
  function frameToken(el) {
    if (el.tagName === "VIDEO") {
      const q = typeof el.getVideoPlaybackQuality === "function" ? el.getVideoPlaybackQuality() : null;
      return q && q.totalVideoFrames ? q.totalVideoFrames : el.currentTime;
    }
    return null; // MJPEG/image streams expose no frame counter
  }
  function frameFor(now) { // one downscaled pixel grab per scheduler step, shared by all analyses
    if (cache.now === now && cache.value) return cache.value;
    const d = sourceSize(source), scale = Math.min(1, 640 / d.width);
    const w = Math.max(1, Math.round(d.width * scale)), h = Math.max(1, Math.round(d.height * scale));
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    workCtx.drawImage(source, 0, 0, w, h);
    const id = workCtx.getImageData(0, 0, w, h);
    cache = { now, value: { img: { data: id.data, width: w, height: h }, scale } };
    return cache.value;
  }

  /* ---------------- COCO-SSD ---------------- */
  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url; script.async = true; script.crossOrigin = "anonymous";
      script.onload = () => window[globalName] ? resolve() : reject(new Error("AI library did not initialise"));
      script.onerror = () => reject(new Error("Could not load " + globalName));
      document.head.appendChild(script);
    });
  }
  async function ensureModel() {
    if (model) return model;
    if (!modelPromise) {
      modelPromise = (async () => {
        setState("loading", "LOADING ON-DEVICE AI MODEL • FIRST USE");
        await loadScript(tfUrl, "tf");
        await loadScript(modelUrl, "cocoSsd");
        const tf = window.tf;
        await tf.ready();
        try { if (!(await tf.setBackend("webgl"))) await tf.setBackend("cpu"); } catch (_) { await tf.setBackend("cpu"); }
        await tf.ready();
        model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
        return model;
      })();
    }
    try { return await modelPromise; } finally { modelPromise = null; }
  }

  /* ---------------- decisions ---------------- */
  function isSpoofed(box) { // picture cues around a face block "live" status
    const now = performance.now();
    for (const s of screens) {
      if (now - s.at < 3500 && core.area(s.bbox) > core.area(box) * 1.05 && core.containment(box, s.bbox) >= T.screenContainment) return "inside " + s.cls;
    }
    for (const tr of objTracker.tracks) {
      const v = tr.data.verdict;
      if (tr.key !== "person" || !v || !v.cue || now - tr.lastSeen > 3500) continue;
      if (core.containment(box, tr.bbox) >= 0.6) return v.reasons[0] || "picture cue";
    }
    return null;
  }
  function evalVerdict(track, now) {
    const c = track.data.ctx, det = track.data.det;
    if (!c || !det) return null;
    const live = det.class === "person" && face() && face().liveFaceInside(det.bbox, now);
    const v = core.objectVerdict(det, Object.assign({}, c, { now, liveFace: !!live }));
    track.data.verdict = v;
    return v;
  }
  const offer = a => window.DEFENX_ALERTS && window.DEFENX_ALERTS.offer(a);

  async function runObjects(now) {
    const started = performance.now(), generation = sourceGeneration, active = source;
    const preds = await model.detect(active, 20, 0.4);
    objMs = performance.now() - started; stats.objectMs = objMs;
    if (!running || paused || active !== source || generation !== sourceGeneration) return;
    const dims = sourceSize(active), frame = frameFor(now);
    const dets = preds.map(p => ({ class: p.class, score: p.score, bbox: p.bbox }));
    screens = screens.filter(s => now - s.at < 3500)
      .concat(dets.filter(d => core.SCREEN_CLASSES.has(d.class) && d.score >= 0.35).map(d => ({ cls: d.class, bbox: d.bbox, at: now })));
    objTracker.update(dets, now);
    for (const det of dets) {
      const c = { frameArea: dims.width * dims.height, now, screen: core.screenContext(det, dets) };
      if (!c.screen && !core.SCREEN_CLASSES.has(det.class)) {
        const wb = det.bbox.map(v => v * frame.scale);
        c.border = core.borderScore(frame.img, wb);
        c.graphic = core.graphicScore(frame.img, wb);
      }
      det.track.data.ctx = c; det.track.data.det = det;
    }
    failures = 0;
  }
  async function runFaces(now) {
    const f = face(), active = source, started = performance.now();
    try {
      await f.process({ source: active, now, frame: () => frameFor(now), isSpoofed });
      faceFails = 0;
    } catch (error) {
      if (/taint|cross.origin|securityerror/i.test(String(error && error.message || error))) throw error;
      if (++faceFails >= 3) faceBroken = true; // keep object detection alive if the face pipeline keeps failing
      return 1000;
    }
    stats.faceMs = f.stats.detectMs; stats.descriptorMs = f.stats.descriptorMs;
    return performance.now() - started;
  }

  /* ---------------- drawing & alerts ---------------- */
  const COLORS = {
    [STATUS.LIVE_HUMAN]: "#39e6a5", [STATUS.LIVE_VEHICLE]: "#54cfff", [STATUS.REAL_OBJECT]: "#b69cff",
    [STATUS.PHOTO]: "#ffb454", [STATUS.VIRTUAL]: "#ffb454", [STATUS.UNVERIFIED]: "#ffd75e",
    [STATUS.RECOGNIZED]: "#39e6a5", [STATUS.UNKNOWN]: "#ff5b65", [STATUS.NOT_CLEAR]: "#9aa7ad"
  };
  function label(x, y, lines, color) {
    context.font = "700 11px system-ui, sans-serif";
    const w = Math.max(...lines.map(l => context.measureText(l).width)) + 10, h = lines.length * 14 + 4;
    const top = Math.max(0, y - h - 1);
    context.fillStyle = color; context.fillRect(x, top, w, h);
    context.fillStyle = "#031018";
    lines.forEach((l, i) => context.fillText(l, x + 5, top + 12 + i * 14));
  }
  function render(now) {
    if (!source) return;
    const host = source.parentElement || viewport;
    if (canvas.parentElement !== host) host.appendChild(canvas);
    const rect = host.getBoundingClientRect();
    const vw = Math.max(1, Math.round(rect.width)), vh = Math.max(1, Math.round(rect.height));
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
    context.clearRect(0, 0, vw, vh);
    const d = sourceSize(source);
    if (!d.width || !d.height) return zeroCounts();
    const contain = getComputedStyle(source).objectFit === "contain";
    const scale = (contain ? Math.min : Math.max)(vw / d.width, vh / d.height);
    const ox = (vw - d.width * scale) / 2, oy = (vh - d.height * scale) / 2;
    const counts = zeroCounts();
    const syncDetections = [], syncFaces = [];
    let confSum = 0, confN = 0;
    const box = (b, color, dashed) => {
      const x = b[0] * scale + ox, y = b[1] * scale + oy;
      context.strokeStyle = color; context.lineWidth = 2; context.setLineDash(dashed ? [6, 4] : []);
      context.strokeRect(x, y, b[2] * scale, b[3] * scale); context.setLineDash([]);
      return [x, y];
    };
    for (const tr of objTracker.tracks) {
      if (now - tr.lastSeen > 1800) continue;
      const v = evalVerdict(tr, now);
      if (!v) continue;
      const det = tr.data.det, pct = Math.round(det.score * 100) + "%";
      syncDetections.push({ class_id: det.class === "person" ? 0 : -1, class_name: det.class, confidence: det.score,
        normalized_box: { x1: det.bbox[0] / d.width, y1: det.bbox[1] / d.height, x2: (det.bbox[0] + det.bbox[2]) / d.width, y2: (det.bbox[1] + det.bbox[3]) / d.height } });
      const color = COLORS[v.status] || COLORS[STATUS.UNVERIFIED];
      const [x, y] = box(det.bbox, color, v.status !== STATUS.LIVE_HUMAN && v.status !== STATUS.LIVE_VEHICLE && v.status !== STATUS.REAL_OBJECT);
      label(x, y, [det.class.toUpperCase() + " " + pct, v.status], color);
      if (v.status === STATUS.LIVE_HUMAN) { counts.human++; confSum += det.score; confN++; }
      else if (v.status === STATUS.LIVE_VEHICLE) { counts.vehicle++; confSum += det.score; confN++; }
      else if (v.status === STATUS.REAL_OBJECT) { counts.object++; confSum += det.score; confN++; }
      else if (v.status === STATUS.PHOTO || v.status === STATUS.VIRTUAL) counts.photo++;
      else counts.unverified++;
      const cfg = window.DEFENX_ALERTS && window.DEFENX_ALERTS.config();
      if (v.status === STATUS.LIVE_VEHICLE && cfg && cfg.vehicles)
        offer({ category: "vehicle_detected", trackId: "o" + tr.id, status: v.status, subject: det.class, confidence: det.score });
      if (v.status === STATUS.REAL_OBJECT && cfg && cfg.objects && cfg.objectClasses.includes(det.class))
        offer({ category: "object_detected", trackId: "o" + tr.id, status: v.status, subject: det.class, confidence: det.score });
    }
    const fr = face() ? face().faces : [];
    for (const f of fr) {
      if (now - f.at > 1200) continue;
      const matchStatus = !f.spoof && f.identity === STATUS.RECOGNIZED ? "recognized" : f.identity === STATUS.UNKNOWN ? "unknown" : "unverified";
      syncFaces.push({ match_status: matchStatus,
        normalized_box: { x1: f.bbox[0] / d.width, y1: f.bbox[1] / d.height, x2: (f.bbox[0] + f.bbox[2]) / d.width, y2: (f.bbox[1] + f.bbox[3]) / d.height } });
      const color = f.spoof ? COLORS[STATUS.PHOTO] : COLORS[f.identity] || COLORS[STATUS.UNVERIFIED];
      const idLine = f.spoof ? STATUS.PHOTO : (f.identity === STATUS.RECOGNIZED ? STATUS.RECOGNIZED + " • " + f.name : f.identity);
      const lines = [idLine];
      if (!f.spoof && f.identity !== STATUS.NOT_CLEAR) lines.push(f.mask);
      const [x, y] = box(f.bbox, color, f.identity !== STATUS.RECOGNIZED && f.identity !== STATUS.UNKNOWN);
      label(x, y, lines, color);
      for (const category of f.alerts) {
        const conf = category === "unknown_person" ? f.identityConfidence : Math.min(f.identityConfidence, f.maskConfidence);
        offer({
          category, trackId: "f" + f.id, live: true, confidence: conf,
          status: category === "registered_no_mask" ? STATUS.NO_MASK : STATUS.UNKNOWN,
          subject: category === "registered_no_mask" ? f.name : "UNKNOWN", mask: f.mask
        });
      }
    }
    counts.confidence = confN ? confSum / confN : 0;
    if (visionOwner && visionRoomJoined && window.DEFENX_VISION_SYNC && Date.now() - lastVisionPublish >= VISION_SYNC_INTERVAL) {
      lastVisionPublish = Date.now();
      window.DEFENX_VISION_SYNC.publish({ width: d.width, height: d.height, detections: syncDetections, faces: syncFaces });
    }
    return counts;
  }
  function describe(counts) {
    const parts = [];
    if (counts.human) parts.push(counts.human + " LIVE HUMAN");
    if (counts.vehicle) parts.push(counts.vehicle + " VEHICLE");
    if (counts.object) parts.push(counts.object + " OBJECT");
    if (counts.photo) parts.push(counts.photo + " PHOTO/SCREEN");
    if (counts.unverified) parts.push(counts.unverified + " UNVERIFIED");
    return parts.length ? "LIVE AI • " + parts.join(" • ") : "LIVE AI • SCANNING";
  }
  function refreshView(now) {
    const counts = render(now) || zeroCounts();
    publish(counts);
    const syncLabel = visionRoomJoined ? "SYNCED" : visionSyncConnected ? "CONNECTING SYNC" : "DISCONNECTED";
    const label = objectModelFailed ? "FACE AI ONLY • OBJECT MODEL UNAVAILABLE" : describe(counts);
    setState("active", label + " • " + syncLabel);
  }

  /* ---------------- scheduler: one task at a time, never blocks the stream ---------------- */
  function schedule(delay) {
    if (timer) clearTimeout(timer);
    if (running && !paused) timer = window.setTimeout(tick, Math.max(20, delay));
  }
  async function tick() {
    if (!running || paused || busy || !visionOwner) return;
    if (document.hidden) return schedule(1200);
    if (!sourceReady(source)) { releaseVisionOwner(); clearAll(); setState("waiting", "WAITING FOR LIVE CAMERA FRAMES"); return schedule(900); }
    const now = performance.now();
    const token = frameToken(source);
    if (token !== null && token === lastToken && now - lastWorkAt < 2500) { stats.skippedFrames++; return schedule(120); }
    busy = true;
    try {
      checkReadable(source);
      const f = face(), faceOn = !!(f && !faceBroken && f.active());
      const objOn = !!model;
      let ran = false;
      if (faceOn && now >= nextFace) {
        const ms = await runFaces(now);
        nextFace = performance.now() + Math.max(FACE_DELAY, ms * 1.3);
        ran = true;
      } else if (objOn && now >= nextObj) {
        await runObjects(now);
        nextObj = performance.now() + Math.max(OBJECT_DELAY, objMs * 2);
        ran = true;
      }
      if (ran) { lastToken = token; lastWorkAt = now; stats.cycles++; refreshView(performance.now()); }
      failures = 0;
      const due = Math.min(faceOn ? nextFace : Infinity, objOn ? nextObj : Infinity);
      busy = false;
      schedule(ran ? 25 : Math.min(250, due - performance.now()));
    } catch (error) {
      busy = false;
      const message = String(error && error.message || error);
      const cors = /taint|cross.origin|securityerror/i.test(message);
      if (!cors && ++failures < 3) return schedule(1000 * failures);
      running = false;
      clearAll();
      setState("error", cors ? "CAMERA CORS BLOCKS AI • ENABLE CAMERA CORS" : "AI DETECTION UNAVAILABLE • CHECK CAMERA / MODEL");
    }
  }

  function claimVisionOwner() {
    const sync = window.DEFENX_VISION_SYNC;
    if (!sync || !visionRoomJoined) { visionOwner = true; return true; }
    if (visionOwner || visionClaimPending) return visionOwner;
    visionOwner = false;
    visionClaimPending = !!sync.setOwner(true);
    return false;
  }
  function releaseVisionOwner() {
    if (visionRoomJoined && visionOwner && window.DEFENX_VISION_SYNC) {
      window.DEFENX_VISION_SYNC.publish({ width: 1, height: 1, detections: [], faces: [] });
      window.DEFENX_VISION_SYNC.setOwner(false);
    }
    visionOwner = !visionRoomJoined;
    visionClaimPending = false;
  }
  async function startDetection() {
    failures = 0;
    if (!source || !sourceReady(source) || paused) { setState("waiting", "WAITING FOR LIVE CAMERA FRAMES"); return; }
    if (!claimVisionOwner()) { running = false; if (timer) clearTimeout(timer); setState("waiting", "CHECKING FOR ANOTHER ACTIVE SCANNER"); return; }
    try {
      checkReadable(source);
      window.dispatchEvent(new Event("defenx-camera-live"));
      if (face()) face().boot();
      try { const local = window.DEFENX_LOCAL_VISION && window.DEFENX_LOCAL_VISION.state(); if (!local || (!local.objects && !local.faces)) await ensureModel(); objectModelFailed = false; }
      catch (error) {
        if (/taint|cross.origin|securityerror/i.test(String(error && error.message || error))) throw error;
        objectModelFailed = true; // keep the face pipeline running even if COCO-SSD cannot load
        if (!face()) throw error;
      }
      if (paused || !sourceReady(source)) return;
      running = true;
      toggle.disabled = false;
      toggle.textContent = "PAUSE AI";
      nextObj = nextFace = 0;
      schedule(0);
    } catch (error) {
      running = false;
      setState("error", /taint|cross.origin|securityerror/i.test(String(error && error.message || error))
        ? "CAMERA CORS BLOCKS AI • ENABLE CAMERA CORS" : "AI MODEL COULD NOT LOAD • CHECK INTERNET");
    }
  }
  function onSourceReady() { if (!paused) { setState("loading", "LIVE CAMERA FOUND • STARTING AI"); startDetection(); } }
  function onSourceError() {
    running = false; if (timer) clearTimeout(timer);
    releaseVisionOwner(); clearAll(); setState("error", "CAMERA STREAM ERROR • AI PAUSED");
  }
  function findSource() {
    const element = document.getElementById("roverRealCamera");
    if (!element || element === source) return;
    source = element; sourceGeneration += 1; corsCheckedFor = null; lastToken = null; running = false; busy = false; faceFails = 0; faceBroken = false;
    if (timer) clearTimeout(timer);
    clearAll();
    if (element.tagName === "IFRAME") { setState("unsupported", "EMBEDDED CAMERA • USE DIRECT MJPEG / VIDEO STREAM"); return; }
    if ((element.tagName !== "IMG" && element.tagName !== "VIDEO") || element.dataset.defenxLiveStream !== "1") { setState("waiting", "WAITING FOR LIVE CAMERA STREAM"); return; }
    element.addEventListener("load", onSourceReady);
    element.addEventListener("loadeddata", onSourceReady);
    element.addEventListener("playing", () => { if (!running && !paused && element === source) onSourceReady(); });
    element.addEventListener("error", onSourceError);
    if (sourceReady(element)) onSourceReady(); else setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
  }

  toggle.addEventListener("click", () => {
    if (bar.dataset.state === "error" && !paused) { setState("loading", "RETRYING AI VISION"); startDetection(); return; }
    paused = !paused;
    if (paused) {
      running = false; if (timer) clearTimeout(timer);
      releaseVisionOwner(); clearAll(); setState("paused", "AI PAUSED BY OPERATOR"); toggle.disabled = false;
    } else { setState("loading", "RESUMING AI VISION"); startDetection(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && visionRoomJoined && visionOwner) { releaseVisionOwner(); running = false; if (timer) clearTimeout(timer); }
    else if (!document.hidden && !paused && sourceReady(source) && !running && (model || (face() && face().active()))) startDetection();
  });
  window.addEventListener("defenx-vision-sync-state", event => {
    const detail = event.detail || {};
    visionSyncConnected = !!detail.connected;
    if (!detail.connected) {
      visionRoomJoined = false; visionOwner = true; visionClaimPending = false;
      if (!paused && sourceReady(source) && !running) startDetection();
      return;
    }
    if (detail.joined) {
      visionRoomJoined = true; visionOwner = false; visionClaimPending = false;
      running = false; if (timer) clearTimeout(timer); clearAll();
      if (!paused && sourceReady(source)) {
        if (claimVisionOwner()) startDetection();
        else setState("waiting", "CHECKING FOR ANOTHER ACTIVE SCANNER");
      }
    }
  });
  window.addEventListener("defenx-vision-owner", event => {
    if (!visionRoomJoined) return;
    const detail = event.detail || {}, owner = String(detail.owner || "");
    const mine = String(window.DEFENX_CAMERA_PEER_ID || "");
    if (detail.granted && owner && owner === mine) {
      visionOwner = true; visionClaimPending = false;
      if (!paused && sourceReady(source)) startDetection();
    } else if (owner && owner !== mine) {
      visionOwner = false; visionClaimPending = false; running = false;
      if (timer) clearTimeout(timer); clearAll();
      setState("waiting", "AI SCANNING ON ANOTHER AUTHENTICATED DEVICE");
    } else if (!owner) {
      visionOwner = false; visionClaimPending = false;
      if (!paused && sourceReady(source) && claimVisionOwner()) startDetection();
    }
  });
  window.addEventListener("resize", () => { if (running && source) render(performance.now()); });
  window.addEventListener("pagehide", () => { running = false; if (timer) clearTimeout(timer); releaseVisionOwner(); });

  if (demoMode) {
    setState("demo", "DEMO MODE • REAL AI DETECTION DISABLED");
    toggle.hidden = true;
    publish(zeroCounts());
    return;
  }
  const observer = new MutationObserver(findSource);
  observer.observe(viewport, { childList: true });
  findSource();
  setState("waiting", "WAITING FOR AUTHENTICATED ROVER CAMERA");
})();