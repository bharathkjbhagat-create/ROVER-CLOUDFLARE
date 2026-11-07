/* DEFENX opt-in face scanning.
 * Adapted from the supplied face-verification package.
 * This safe integration performs face DETECTION only:
 * - starts only after an operator clicks START FACE SCAN
 * - analyses the existing live rover camera stream in this browser
 * - never creates face embeddings, identifies people, uploads frames,
 *   stores biometric templates, captures snapshots, or sends alerts
 */
(() => {
  "use strict";

  const viewport = document.getElementById("cameraViewport");
  const bar = document.getElementById("faceScanBar");
  const status = document.getElementById("faceScanState");
  const count = document.getElementById("faceScanCount");
  const toggle = document.getElementById("faceScanToggle");
  if (!viewport || !bar || !status || !count || !toggle) return;

  const demoMode = new URLSearchParams(location.search).get("demo") === "1";
  const libraryUrl = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js";
  const modelUrl = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/";
  const canvas = document.createElement("canvas");
  canvas.className = "faceScanCanvas";
  canvas.setAttribute("aria-hidden", "true");
  viewport.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let source = null;
  let faceapi = null;
  let modelPromise = null;
  let running = false;
  let scanning = false;
  let timer = 0;
  let generation = 0;

  function setState(state, message) {
    bar.dataset.state = state;
    status.textContent = message;
    toggle.textContent = scanning ? "STOP FACE SCAN" : "START FACE SCAN";
    toggle.disabled = demoMode || !source || !sourceReady(source) || state === "loading";
  }

  function sourceReady(node) {
    if (!node) return false;
    if (node.tagName === "VIDEO") return node.readyState >= 2 && node.videoWidth > 0 && node.videoHeight > 0;
    if (node.tagName === "IMG") return node.complete && node.naturalWidth > 0 && node.naturalHeight > 0;
    return false;
  }

  function dimensions() {
    return source.tagName === "VIDEO"
      ? { width: source.videoWidth, height: source.videoHeight }
      : { width: source.naturalWidth, height: source.naturalHeight };
  }

  function clearOverlay() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    count.textContent = "0";
  }

  function draw(detections, width, height) {
    const rect = viewport.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    const scale = Math.max(w / width, h / height);
    const ox = (w - width * scale) / 2;
    const oy = (h - height * scale) / 2;
    detections.forEach(item => {
      const box = item.box;
      const x = box.x * scale + ox;
      const y = box.y * scale + oy;
      const bw = box.width * scale;
      const bh = box.height * scale;
      ctx.strokeStyle = "#38e6a5";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, bw, bh);
      ctx.fillStyle = "#38e6a5";
      ctx.fillRect(x, Math.max(0, y - 20), 116, 18);
      ctx.fillStyle = "#031018";
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillText("FACE DETECTED", x + 5, Math.max(13, y - 7));
    });
    count.textContent = String(detections.length);
  }

  function loadScript() {
    if (window.faceapi) return Promise.resolve(window.faceapi);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = libraryUrl;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => window.faceapi ? resolve(window.faceapi) : reject(new Error("Face library unavailable"));
      script.onerror = () => reject(new Error("Could not load face scanning library"));
      document.head.appendChild(script);
    });
  }

  async function ensureModel() {
    if (faceapi && faceapi.nets.tinyFaceDetector.params) return faceapi;
    if (!modelPromise) {
      modelPromise = (async () => {
        faceapi = await loadScript();
        await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
        return faceapi;
      })();
    }
    try { return await modelPromise; }
    finally { modelPromise = null; }
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    if (running && scanning) timer = window.setTimeout(scanFrame, delay);
  }

  async function scanFrame() {
    if (!running || !scanning) return;
    if (document.hidden) {
      schedule(900);
      return;
    }
    if (!sourceReady(source)) {
      clearOverlay();
      setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
      schedule(700);
      return;
    }
    const activeSource = source;
    const token = generation;
    try {
      const d = dimensions();
      const detections = await faceapi.detectAllFaces(
        activeSource,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
      );
      if (!running || !scanning || token !== generation || activeSource !== source) return;
      draw(detections, d.width, d.height);
      setState("active", detections.length
        ? "LIVE SCAN • FACE PRESENT IN CAMERA VIEW"
        : "LIVE SCAN • NO FACE DETECTED");
    } catch (error) {
      stop(false);
      setState("error", /taint|cross.origin|securityerror/i.test(String(error))
        ? "CAMERA CORS BLOCKS LOCAL SCANNING"
        : "FACE SCAN UNAVAILABLE • CHECK CAMERA / MODEL CONNECTION");
      return;
    }
    schedule(650);
  }

  async function start() {
    if (demoMode || !sourceReady(source)) {
      setState("waiting", "WAITING FOR AN AUTHENTICATED LIVE CAMERA");
      return;
    }
    scanning = true;
    setState("loading", "LOADING FACE DETECTOR • FIRST USE");
    try {
      await ensureModel();
      if (!scanning) return;
      running = true;
      toggle.disabled = false;
      schedule(0);
    } catch (_) {
      scanning = false;
      running = false;
      clearOverlay();
      setState("error", "FACE MODEL COULD NOT LOAD • CHECK INTERNET");
    }
  }

  function stop(updateStatus = true) {
    scanning = false;
    running = false;
    generation += 1;
    if (timer) clearTimeout(timer);
    clearOverlay();
    if (updateStatus) setState("paused", "FACE SCAN STOPPED BY OPERATOR");
    else toggle.textContent = "START FACE SCAN";
  }

  function findSource() {
    const node = document.getElementById("roverRealCamera");
    // The camera element is often inserted before its first frame arrives.
    // Its load/loadeddata callback re-enters here with the same node.
    if (node === source) {
      if (source && !scanning && sourceReady(source)) {
        setState("ready", "LIVE CAMERA READY • START WHEN YOU CHOOSE");
      }
      return;
    }
    stop(false);
    source = node || null;
    generation += 1;
    if (demoMode) {
      setState("demo", "FACE SCAN DISABLED IN DEMO MODE");
    } else if (!source) {
      setState("waiting", "WAITING FOR LIVE ROVER CAMERA");
    } else if (source.tagName === "IFRAME") {
      setState("unsupported", "EMBEDDED CAMERA CANNOT BE SCANNED");
    } else if (source.tagName !== "IMG" && source.tagName !== "VIDEO") {
      setState("unsupported", "UNSUPPORTED CAMERA STREAM FORMAT");
    } else if (sourceReady(source)) {
      setState("ready", "LIVE CAMERA READY • START WHEN YOU CHOOSE");
    } else {
      setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
      source.addEventListener("load", findSource, { once: true });
      source.addEventListener("loadeddata", findSource, { once: true });
    }
  }

  toggle.addEventListener("click", () => {
    if (scanning) stop(true);
    else start();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scanning) {
      running = false;
      if (timer) clearTimeout(timer);
      clearOverlay();
      setState("paused", "SCAN PAUSED WHILE TAB IS HIDDEN");
    } else if (!document.hidden && scanning && faceapi) {
      running = true;
      setState("active", "RESUMING LOCAL FACE SCAN");
      schedule(0);
    }
  });
  window.addEventListener("resize", () => {
    if (scanning && sourceReady(source)) {
      clearOverlay();
      schedule(0);
    }
  });

  if (demoMode) {
    setState("demo", "FACE SCAN DISABLED IN DEMO MODE");
    return;
  }
  const observer = new MutationObserver(findSource);
  observer.observe(viewport, { childList: true, subtree: true });
  findSource();
})();
