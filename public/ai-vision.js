/* DEFENX on-device AI vision.
 * TensorFlow.js COCO-SSD runs only on a real, readable rover camera stream.
 * Frames stay in this browser; this module does not upload images or detections.
 */
(() => {
  "use strict";

  const viewport = document.getElementById("cameraViewport");
  const bar = document.getElementById("aiVisionBar");
  const statusText = document.getElementById("aiVisionState");
  const toggle = document.getElementById("aiVisionToggle");
  const humanCount = document.getElementById("aiHumanCount");
  const vehicleCount = document.getElementById("aiVehicleCount");
  if (!viewport || !bar || !statusText || !toggle) return;

  // The production dashboard and login share "/". Only explicit demo routes
  // disable real AI; treating "/" as demo permanently hid the operator control.
  const demoMode = window.location.pathname === "/demo" ||
    new URLSearchParams(window.location.search).get("demo") === "1";
  const canvas = document.createElement("canvas");
  canvas.className = "aiVisionCanvas";
  canvas.setAttribute("aria-label", "AI object detection overlay");
  canvas.setAttribute("aria-hidden", "true");
  viewport.appendChild(canvas);
  const context = canvas.getContext("2d");
  const vehicles = new Set(["bicycle", "car", "motorcycle", "bus", "train", "truck"]);
  const tfUrl = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
  const modelUrl = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";

  let source = null;
  let model = null;
  let modelPromise = null;
  let paused = false;
  let running = false;
  let timer = 0;
  let sourceGeneration = 0;
  let corsCheckedFor = null;
  let lastPredictions = [];
  const detectionDelay = (navigator.hardwareConcurrency || 4) <= 4 || window.matchMedia("(max-width: 700px)").matches ? 1300 : 850;

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }

  function setState(state, message) {
    bar.dataset.state = state;
    statusText.textContent = message;
    window.ROVER_AI_VISION_STATUS = state;
    const canRetry = state === "error" && sourceReady(source) && !paused;
    toggle.disabled = state === "loading" || state === "waiting" ||
      state === "unsupported" || state === "demo" ||
      (state === "error" && !canRetry);
    toggle.textContent = paused ? "RESUME AI" : canRetry ? "RETRY AI" : "PAUSE AI";
    setText("deviceAiState", state === "active" ? "AI LIVE" :
      state === "paused" ? "PAUSED" : state === "loading" ? "LOADING" : "WAITING");
  }

  function clearCounts() {
    lastPredictions = [];
    if (humanCount) humanCount.textContent = "0";
    if (vehicleCount) vehicleCount.textContent = "0";
    setText("person", "0");
    setText("vehicle", "0");
    setText("object", "0");
    setText("confidence", "0%");
    clearOverlay();
    window.ROVER_AI_VISION_COUNTS = { human: 0, vehicle: 0, confidence: 0 };
  }

  function clearOverlay() {
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  function sourceReady(element) {
    if (!element) return false;
    if (element.tagName === "VIDEO") {
      const tracks = element.srcObject && typeof element.srcObject.getVideoTracks === "function" ? element.srcObject.getVideoTracks() : [];
      const liveTrack = tracks.some(track => track.readyState === "live" && track.enabled);
      return element.dataset.defenxLiveStream === "1" && !element.paused && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0 && (liveTrack || Boolean(element.currentSrc || element.src));
    }
    if (element.tagName === "IMG") {
      return element.dataset.defenxLiveStream === "1" && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
    }
    return false;
  }

  function sourceSize(element) {
    return element.tagName === "VIDEO"
      ? { width: element.videoWidth, height: element.videoHeight }
      : { width: element.naturalWidth, height: element.naturalHeight };
  }

  function checkReadable(element) {
    if (corsCheckedFor === element) return;
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const probeContext = probe.getContext("2d", { willReadFrequently: true });
    probeContext.drawImage(element, 0, 0, 1, 1);
    probeContext.getImageData(0, 0, 1, 1);
    corsCheckedFor = element;
  }

  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => window[globalName]
        ? resolve()
        : reject(new Error("AI library did not initialise"));
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
        try {
          const webglReady = await tf.setBackend("webgl");
          if (!webglReady) await tf.setBackend("cpu");
        } catch (_) {
          await tf.setBackend("cpu");
        }
        await tf.ready();
        model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
        return model;
      })();
    }
    try {
      return await modelPromise;
    } finally {
      modelPromise = null;
    }
  }

  function drawDetections(predictions, width, height) {
    const rect = viewport.getBoundingClientRect();
    const viewWidth = Math.max(1, Math.round(rect.width));
    const viewHeight = Math.max(1, Math.round(rect.height));
    if (canvas.width !== viewWidth || canvas.height !== viewHeight) {
      canvas.width = viewWidth;
      canvas.height = viewHeight;
    }
    context.clearRect(0, 0, viewWidth, viewHeight);

    // Match the camera element's object-fit:cover crop so boxes stay aligned.
    const scale = Math.max(viewWidth / width, viewHeight / height);
    const offsetX = (viewWidth - width * scale) / 2;
    const offsetY = (viewHeight - height * scale) / 2;
    const visible = predictions.filter(item =>
      item.class === "person" || vehicles.has(item.class)
    );

    lastPredictions = visible;
    visible.forEach(item => {
      const isHuman = item.class === "person";
      const x = item.bbox[0] * scale + offsetX;
      const y = item.bbox[1] * scale + offsetY;
      const w = item.bbox[2] * scale;
      const h = item.bbox[3] * scale;
      const color = isHuman ? "#39e6a5" : "#54cfff";
      const label = (isHuman ? "HUMAN" : item.class.toUpperCase()) +
        " " + Math.round(item.score * 100) + "%";
      const fontSize = 11;
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.strokeRect(x, y, w, h);
      context.font = "700 " + fontSize + "px system-ui, sans-serif";
      const labelWidth = context.measureText(label).width + 10;
      const labelTop = Math.max(0, y - 20);
      context.fillStyle = color;
      context.fillRect(x, labelTop, labelWidth, 18);
      context.fillStyle = "#031018";
      context.fillText(label, x + 5, labelTop + 13);
    });
    return visible;
  }

  function publishCounts(visible) {
    const people = visible.filter(item => item.class === "person");
    const vehicleItems = visible.filter(item => vehicles.has(item.class));
    const count = visible.length;
    const confidence = count
      ? visible.reduce((sum, item) => sum + item.score, 0) / count
      : 0;

    if (humanCount) humanCount.textContent = String(people.length);
    if (vehicleCount) vehicleCount.textContent = String(vehicleItems.length);
    setText("person", people.length);
    setText("vehicle", vehicleItems.length);
    setText("object", "0");
    setText("confidence", Math.round(confidence * 100) + "%");
    window.ROVER_AI_VISION_COUNTS = {
      human: people.length,
      vehicle: vehicleItems.length,
      confidence: confidence
    };
    window.dispatchEvent(new CustomEvent("defenx-ai-detection", {
      detail: window.ROVER_AI_VISION_COUNTS
    }));
  }

  function scheduleNext(delay) {
    if (timer) clearTimeout(timer);
    if (running && !paused) timer = window.setTimeout(detectFrame, delay);
  }

  async function detectFrame() {
    if (!running || paused) return;
    if (window.DEFENX_FACE_SCAN_ACTIVE) {
      scheduleNext(1000);
      return;
    }
    if (document.hidden) {
      scheduleNext(1200);
      return;
    }
    if (!sourceReady(source)) {
      clearCounts();
      setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
      scheduleNext(900);
      return;
    }

    try {
      const activeSource = source;
      const generation = sourceGeneration;
      const dimensions = sourceSize(activeSource);
      checkReadable(activeSource);
      const predictions = await model.detect(activeSource, 6, 0.5);
      if (!running || paused || !activeSource || generation !== sourceGeneration || activeSource !== source) return;
      if (window.DEFENX_FACE_SCAN_ACTIVE) {
        scheduleNext(1000);
        return;
      }
      const visible = drawDetections(predictions, dimensions.width, dimensions.height);
      publishCounts(visible);
      setState("active", visible.length
        ? "LIVE AI • DETECTING HUMAN / VEHICLES"
        : "LIVE AI • SCANNING");
    } catch (error) {
      running = false;
      clearCounts();
      const message = String(error && error.message || error);
      if (/taint|cross.origin|securityerror/i.test(message)) {
        setState("error", "CAMERA CORS BLOCKS AI • ENABLE CAMERA CORS");
      } else {
        setState("error", "AI DETECTION UNAVAILABLE • CHECK CAMERA / MODEL");
      }
      return;
    }
    scheduleNext(detectionDelay);
  }

  async function startDetection() {
    if (!source || !sourceReady(source) || paused) {
      setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
      return;
    }
    try {
      checkReadable(source);
      await ensureModel();
      if (paused || !sourceReady(source)) return;
      running = true;
      toggle.disabled = false;
      toggle.textContent = "PAUSE AI";
      scheduleNext(0);
    } catch (error) {
      running = false;
      const message = String(error && error.message || error);
      setState("error", /taint|cross.origin|securityerror/i.test(message)
        ? "CAMERA CORS BLOCKS AI • ENABLE CAMERA CORS"
        : "AI MODEL COULD NOT LOAD • CHECK INTERNET");
    }
  }

  function onSourceReady() {
    if (paused) return;
    setState("loading", "LIVE CAMERA FOUND • STARTING AI");
    startDetection();
  }

  function onSourceError() {
    running = false;
    if (timer) clearTimeout(timer);
    clearCounts();
    setState("error", "CAMERA STREAM ERROR • AI PAUSED");
  }

  function findSource() {
    const element = document.getElementById("roverRealCamera");
    if (!element || element === source) return;
    source = element;
    sourceGeneration += 1;
    corsCheckedFor = null;
    running = false;
    clearCounts();
    if (timer) clearTimeout(timer);

    if (element.tagName === "IFRAME") {
      setState("unsupported", "EMBEDDED CAMERA • USE DIRECT MJPEG / VIDEO STREAM");
      return;
    }
    if ((element.tagName !== "IMG" && element.tagName !== "VIDEO") || element.dataset.defenxLiveStream !== "1") {
      setState("waiting", "WAITING FOR LIVE CAMERA STREAM");
      return;
    }
    element.addEventListener("load", onSourceReady);
    element.addEventListener("loadeddata", onSourceReady);
    element.addEventListener("error", onSourceError);
    if (sourceReady(element)) onSourceReady();
    else setState("waiting", "WAITING FOR LIVE CAMERA FRAMES");
  }

  toggle.addEventListener("click", () => {
    if (bar.dataset.state === "error" && !paused) {
      setState("loading", "RETRYING AI VISION");
      startDetection();
      return;
    }
    paused = !paused;
    if (paused) {
      running = false;
      if (timer) clearTimeout(timer);
      clearCounts();
      setState("paused", "AI PAUSED BY OPERATOR");
      toggle.disabled = false;
    } else {
      setState("loading", "RESUMING AI VISION");
      startDetection();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !paused && model && sourceReady(source) && !running) {
      running = true;
      scheduleNext(0);
    }
  });

  window.addEventListener("resize", () => {
    if (running && source) {
      const dimensions = sourceSize(source);
      drawDetections(lastPredictions, dimensions.width, dimensions.height);
    }
  });

  if (demoMode) {
    setState("demo", "DEMO MODE • REAL AI DETECTION DISABLED");
    toggle.hidden = true;
    clearCounts();
    return;
  }

  const observer = new MutationObserver(findSource);
  observer.observe(viewport, { childList: true });
  findSource();
  setState("waiting", "WAITING FOR AUTHENTICATED ROVER CAMERA");
})();