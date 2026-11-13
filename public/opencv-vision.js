/* DEFENX OpenCV.js vision layer.
 * Runs only on frames already captured by the authenticated, local AI pipeline.
 * Computes conservative frame-to-frame motion metrics; it never creates alerts,
 * uploads images, stores frames, or replaces the existing object/face models.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.DEFENX_OPENCV = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function createDefenxOpenCV(root) {
  "use strict";

  const SCRIPT_URL = "https://docs.opencv.org/4.x/opencv.js";
  const MIN_INTERVAL_MS = (root.navigator && (root.navigator.hardwareConcurrency || 4) <= 4) ? 850 : 450;
  const state = {
    status: "idle",
    message: "WAITING FOR LIVE CAMERA",
    cv: null,
    loadPromise: null,
    previousGray: null,
    previousWidth: 0,
    previousHeight: 0,
    lastFrameAt: 0,
    processingError: false
  };
  const stats = {
    processedFrames: 0,
    motionFrames: 0,
    errors: 0,
    lastMotionAt: null,
    lastMotionRatio: 0,
    lastProcessMs: 0
  };
  root.DEFENX_OPENCV_STATS = stats;

  function publish(status, message) {
    state.status = status;
    state.message = message;
    root.DEFENX_OPENCV_STATUS = { state: status, message };
    const node = root.document && root.document.getElementById("opencvVisionState");
    if (node) node.textContent = "OpenCV: " + message;
  }

  function validRuntime(cv) {
    return !!cv &&
      typeof cv.Mat === "function" &&
      typeof cv.Size === "function" &&
      typeof cv.matFromImageData === "function" &&
      typeof cv.cvtColor === "function" &&
      typeof cv.resize === "function" &&
      typeof cv.GaussianBlur === "function" &&
      typeof cv.absdiff === "function" &&
      typeof cv.threshold === "function" &&
      typeof cv.countNonZero === "function";
  }

  async function currentRuntime(waitMs = 0) {
    let candidate = root.cv;
    if (candidate && typeof candidate.then === "function") {
      if (waitMs <= 0) return null;
      candidate = await Promise.race([
        Promise.resolve(candidate),
        new Promise(resolve => (root.setTimeout || setTimeout)(() => resolve(null), waitMs))
      ]);
    }
    return validRuntime(candidate) ? candidate : null;
  }

  // OpenCV.js downloads its JavaScript before its WebAssembly runtime is ready.
  // The script load event alone is therefore not a reliable readiness signal.
  async function waitForRuntime(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const runtime = await currentRuntime(50);
      if (runtime) return runtime;
      await new Promise(resolve => (root.setTimeout || setTimeout)(resolve, 50));
    }
    throw new Error("OpenCV.js WebAssembly runtime initialisation timed out");
  }

  function load() {
    if (state.cv) return Promise.resolve(state.cv);
    if (state.loadPromise) return state.loadPromise;

    state.loadPromise = (async () => {
      try {
        const existing = await currentRuntime();
        if (existing) {
          state.cv = existing;
          publish("ready", "READY • LOCAL MOTION ANALYSIS");
          return existing;
        }

        const doc = root.document;
        if (!doc || !doc.head || typeof doc.createElement !== "function") {
          publish("unavailable", "UNAVAILABLE • EXISTING AI CONTINUES");
          return null;
        }
        if (!root.WebAssembly && typeof WebAssembly === "undefined") {
          publish("unavailable", "WEBASSEMBLY UNSUPPORTED • EXISTING AI CONTINUES");
          return null;
        }

        publish("loading", "LOADING OPENCV.JS • FIRST USE");
        const cv = await new Promise((resolve, reject) => {
          const script = doc.createElement("script");
          let settled = false;
          const timeout = root.setTimeout || setTimeout;
          const clear = root.clearTimeout || clearTimeout;
          const timer = timeout(() => finish(new Error("OpenCV.js load timed out")), 45000);
          function finish(error, runtime) {
            if (settled) return;
            settled = true;
            clear(timer);
            if (error) {
              if (script.parentNode) script.parentNode.removeChild(script);
              reject(error);
            } else resolve(runtime);
          }
          script.src = SCRIPT_URL;
          script.async = true;
          script.dataset.defenxOpenCv = "1";
          script.onload = async () => {
            try {
              const runtime = await waitForRuntime(40000);
              finish(null, runtime);
            } catch (error) {
              finish(error);
            }
          };
          script.onerror = () => finish(new Error("OpenCV.js could not be downloaded"));
          doc.head.appendChild(script);
        });

        state.cv = cv;
        publish("ready", "READY • LOCAL MOTION ANALYSIS");
        return cv;
      } catch (_) {
        publish("unavailable", "UNAVAILABLE • EXISTING AI CONTINUES");
        return null;
      } finally {
        state.loadPromise = null;
      }
    })();

    return state.loadPromise;
  }

  function validImageData(imageData) {
    return !!imageData &&
      Number.isInteger(imageData.width) && imageData.width > 0 &&
      Number.isInteger(imageData.height) && imageData.height > 0 &&
      imageData.data && imageData.data.length === imageData.width * imageData.height * 4;
  }

  function release(mat) {
    if (mat && typeof mat.delete === "function") {
      try { mat.delete(); } catch (_) {}
    }
  }

  function reset() {
    release(state.previousGray);
    state.previousGray = null;
    state.previousWidth = 0;
    state.previousHeight = 0;
    state.lastFrameAt = 0;
  }

  function emit(result) {
    if (typeof root.dispatchEvent !== "function" || typeof root.CustomEvent !== "function") return;
    try {
      root.dispatchEvent(new root.CustomEvent("defenx-opencv-motion", { detail: result }));
    } catch (_) {}
  }

  function process(imageData, now) {
    const cv = state.cv;
    if (!cv || !validImageData(imageData)) return null;
    const stamp = Number.isFinite(now) ? now :
      (root.performance && typeof root.performance.now === "function" ? root.performance.now() : Date.now());
    if (state.lastFrameAt && stamp - state.lastFrameAt < MIN_INTERVAL_MS) return null;
    state.lastFrameAt = stamp;

    let rgba = null, gray = null, resized = null, blurred = null, diff = null, mask = null;
    const started = stamp;
    try {
      rgba = cv.matFromImageData(imageData);
      gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

      const width = Math.min(320, gray.cols);
      const height = Math.max(1, Math.round(gray.rows * width / gray.cols));
      resized = new cv.Mat();
      cv.resize(gray, resized, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
      blurred = new cv.Mat();
      cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

      let ratio = 0;
      let moving = false;
      let baseline = !state.previousGray ||
        state.previousWidth !== blurred.cols || state.previousHeight !== blurred.rows;

      if (!baseline) {
        diff = new cv.Mat();
        mask = new cv.Mat();
        cv.absdiff(blurred, state.previousGray, diff);
        cv.threshold(diff, mask, 18, 255, cv.THRESH_BINARY);
        const total = mask.rows * mask.cols;
        ratio = total > 0 ? cv.countNonZero(mask) / total : 0;
        // A broad scene-wide illumination change is not reported as motion.
        moving = ratio >= 0.012 && ratio <= 0.75;
      }

      const nextPrevious = blurred.clone();
      release(state.previousGray);
      state.previousGray = nextPrevious;
      state.previousWidth = blurred.cols;
      state.previousHeight = blurred.rows;

      stats.processedFrames += 1;
      stats.lastMotionRatio = ratio;
      if (moving) {
        stats.motionFrames += 1;
        stats.lastMotionAt = new Date().toISOString();
      }
      const ended = root.performance && typeof root.performance.now === "function"
        ? root.performance.now() : Date.now();
      stats.lastProcessMs = Math.max(0, ended - started);

      const result = {
        source: "opencv.js",
        baseline,
        moving,
        motionRatio: ratio,
        motionPercent: Math.round(ratio * 1000) / 10,
        width: imageData.width,
        height: imageData.height,
        at: new Date().toISOString()
      };
      emit(result);
      return result;
    } catch (_) {
      stats.errors += 1;
      if (!state.processingError) {
        state.processingError = true;
        publish("degraded", "PROCESSING UNAVAILABLE • EXISTING AI CONTINUES");
      }
      return null;
    } finally {
      release(mask);
      release(diff);
      release(blurred);
      release(resized);
      release(gray);
      release(rgba);
    }
  }

  function getStatus() {
    return {
      state: state.status,
      message: state.message,
      stats: Object.assign({}, stats)
    };
  }

  publish("idle", "WAITING FOR LIVE CAMERA");
  return { load, process, reset, getStatus, validImageData };
});
