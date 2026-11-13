/* DEFENX YOLOX-Nano browser runtime.
 * The camera frames remain local. The ONNX model is SHA-256 verified before
 * use and is cached by the browser after the first successful download.
 * YOLOX and its upstream COCO weights: Apache-2.0. ONNX Runtime Web: MIT.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.DEFENX_YOLOX = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const INPUT_SIZE = 416;
  const OUTPUT_ROWS = 3549;
  const OUTPUT_COLUMNS = 85;
  const MODEL_URL = "https://huggingface.co/skillsafe-ai/yolox-nano/resolve/main/yolox_nano.onnx";
  const MODEL_SHA256 = "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d";
  const ORT_VERSION = "1.31.1";
  const ORT_SCRIPT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@" + ORT_VERSION + "/dist/ort.min.js";
  const ORT_WASM_PATH = "https://cdn.jsdelivr.net/npm/onnxruntime-web@" + ORT_VERSION + "/dist/";
  const CACHE_NAME = "defenx-yolox-nano-v1";
  const LABELS = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake",
    "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop",
    "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
  ];
  // The official YOLOX ONNX export emits raw (tx,ty,tw,th) values in grid units.
  // Anchor order matches YOLOX demo_postprocess: stride 8, then 16, then 32;
  // within each stride, rows are y-major and columns are x-major.
  const ANCHORS = (() => {
    const rows = [];
    for (const stride of [8, 16, 32]) {
      const gridSize = INPUT_SIZE / stride;
      for (let gy = 0; gy < gridSize; gy += 1) {
        for (let gx = 0; gx < gridSize; gx += 1) rows.push({ gx, gy, stride });
      }
    }
    if (rows.length !== OUTPUT_ROWS) throw new Error("YOLOX anchor-grid contract mismatch");
    return rows;
  })();

  let session = null;
  let sessionPromise = null;
  let inputCanvas = null;
  let inputContext = null;

  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function intersectionOverUnion(a, b) {
    const left = Math.max(a.x1, b.x1);
    const top = Math.max(a.y1, b.y1);
    const right = Math.min(a.x2, b.x2);
    const bottom = Math.min(a.y2, b.y2);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const intersection = width * height;
    const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
    const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
    const union = areaA + areaB - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function postprocess(output, meta, confidenceThreshold, nmsThreshold, maxDetections) {
    const threshold = Math.max(0, Math.min(1, finite(confidenceThreshold, 0.4)));
    const nms = Math.max(0, Math.min(1, finite(nmsThreshold, 0.45)));
    const limit = Math.max(1, Math.min(100, Math.floor(finite(maxDetections, 20))));
    if (!output || output.length !== OUTPUT_ROWS * OUTPUT_COLUMNS) {
      throw new Error("YOLOX output shape mismatch; expected [1,3549,85]");
    }
    if (!meta || !(meta.width > 0) || !(meta.height > 0) || !(meta.ratio > 0)) {
      throw new Error("YOLOX image geometry is invalid");
    }

    const candidates = [];
    for (let row = 0; row < OUTPUT_ROWS; row += 1) {
      const offset = row * OUTPUT_COLUMNS;
      const objectness = output[offset + 4];
      if (!Number.isFinite(objectness) || objectness <= 0 || objectness < threshold) continue;

      let classId = -1;
      let classScore = 0;
      for (let c = 0; c < LABELS.length; c += 1) {
        const score = output[offset + 5 + c];
        if (Number.isFinite(score) && score > classScore) {
          classScore = score;
          classId = c;
        }
      }
      const score = objectness * classScore;
      if (classId < 0 || score < threshold) continue;

      const anchor = ANCHORS[row];
      const tx = output[offset], ty = output[offset + 1];
      const tw = output[offset + 2], th = output[offset + 3];
      if (![tx, ty, tw, th].every(Number.isFinite)) continue;
      const cx = (tx + anchor.gx) * anchor.stride;
      const cy = (ty + anchor.gy) * anchor.stride;
      const width = Math.exp(tw) * anchor.stride;
      const height = Math.exp(th) * anchor.stride;
      if (![cx, cy, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      const x1 = Math.max(0, Math.min(meta.width, (cx - width / 2 - meta.padX) / meta.ratio));
      const y1 = Math.max(0, Math.min(meta.height, (cy - height / 2 - meta.padY) / meta.ratio));
      const x2 = Math.max(0, Math.min(meta.width, (cx + width / 2 - meta.padX) / meta.ratio));
      const y2 = Math.max(0, Math.min(meta.height, (cy + height / 2 - meta.padY) / meta.ratio));
      if (x2 - x1 < 1 || y2 - y1 < 1) continue;

      candidates.push({ classId, score, x1, y1, x2, y2 });
    }

    candidates.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const candidate of candidates) {
      let suppressed = false;
      for (const accepted of kept) {
        if (accepted.classId === candidate.classId &&
            intersectionOverUnion(accepted, candidate) > nms) {
          suppressed = true;
          break;
        }
      }
      if (!suppressed) kept.push(candidate);
      if (kept.length >= limit) break;
    }

    return kept.map(item => ({
      class: LABELS[item.classId],
      score: item.score,
      bbox: [item.x1, item.y1, item.x2 - item.x1, item.y2 - item.y1]
    }));
  }

  function letterbox(source) {
    if (typeof document === "undefined") throw new Error("YOLOX requires a browser canvas");
    const width = source && (source.videoWidth || source.naturalWidth || source.width);
    const height = source && (source.videoHeight || source.naturalHeight || source.height);
    if (!(width > 0) || !(height > 0)) throw new Error("YOLOX camera frame is not ready");

    if (!inputCanvas) {
      inputCanvas = document.createElement("canvas");
      inputCanvas.width = INPUT_SIZE;
      inputCanvas.height = INPUT_SIZE;
      inputContext = inputCanvas.getContext("2d", { willReadFrequently: true });
      if (!inputContext) throw new Error("YOLOX could not create its input canvas");
    }

    const ratio = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
    const resizedWidth = Math.max(1, Math.floor(width * ratio));
    const resizedHeight = Math.max(1, Math.floor(height * ratio));
    // Match the official YOLOX preprocessing: image at top-left; pad only
    // on the right/bottom with gray 114 (do not center the image).
    const padX = 0;
    const padY = 0;

    inputContext.fillStyle = "rgb(114,114,114)";
    inputContext.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    inputContext.imageSmoothingEnabled = true;
    inputContext.imageSmoothingQuality = "high";
    inputContext.drawImage(source, 0, 0, width, height, 0, 0, resizedWidth, resizedHeight);

    const pixels = inputContext.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const plane = INPUT_SIZE * INPUT_SIZE;
    const chw = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i += 1) {
      const p = i * 4;
      chw[i] = pixels[p + 2];             // YOLOX export expects BGR, 0..255
      chw[plane + i] = pixels[p + 1];
      chw[plane * 2 + i] = pixels[p];
    }
    return {
      tensorData: chw,
      meta: { width, height, ratio, padX, padY }
    };
  }

  function loadScript() {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return Promise.reject(new Error("YOLOX runtime requires a browser"));
    }
    if (window.ort && window.ort.InferenceSession) return Promise.resolve(window.ort);
    return new Promise((resolve, reject) => {
      let script = document.querySelector("script[data-defenx-onnx-runtime='1']");
      const shouldAppend = !script;
      if (!script) {
        script = document.createElement("script");
        script.src = ORT_SCRIPT;
        script.async = true;
        script.crossOrigin = "anonymous";
        script.dataset.defenxOnnxRuntime = "1";
      }
      let settled = false;
      const ready = () => {
        if (settled) return;
        if (window.ort && window.ort.InferenceSession) {
          settled = true;
          resolve(window.ort);
        } else if (script.dataset.defenxOnnxRuntimeFailed === "1") {
          settled = true;
          reject(new Error("Could not load ONNX Runtime Web"));
        }
      };
      script.addEventListener("load", ready, { once: true });
      script.addEventListener("error", () => {
        script.dataset.defenxOnnxRuntimeFailed = "1";
        if (!settled) {
          settled = true;
          reject(new Error("Could not load ONNX Runtime Web"));
        }
      }, { once: true });
      if (window.ort && window.ort.InferenceSession) ready();
      else if (shouldAppend) document.head.appendChild(script);
      else if (script.dataset.defenxOnnxRuntimeFailed === "1") ready();
    });
  }

  async function sha256(buffer) {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error("Secure SHA-256 verification is unavailable in this browser");
    }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifiedBuffer(response) {
    if (!response || !response.ok) throw new Error("YOLOX model download failed (HTTP " + (response && response.status) + ")");
    const buffer = await response.arrayBuffer();
    const actual = await sha256(buffer);
    if (actual !== MODEL_SHA256) throw new Error("YOLOX model integrity check failed");
    return buffer;
  }

  async function fetchModel() {
    let cache = null;
    if (typeof caches !== "undefined") {
      try {
        cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(MODEL_URL);
        if (cached) {
          try {
            const buffer = await verifiedBuffer(cached);
            return buffer;
          } catch (_) {
            await cache.delete(MODEL_URL);
          }
        }
      } catch (_) {
        cache = null;
      }
    }

    const response = await fetch(MODEL_URL, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "force-cache"
    });
    const buffer = await verifiedBuffer(response);
    if (cache) {
      try {
        await cache.put(MODEL_URL, new Response(buffer.slice(0), {
          headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" }
        }));
      } catch (_) {
        // Model execution is still safe; offline persistence is an optimisation.
      }
    }
    return buffer;
  }

  async function load() {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const ort = await loadScript();
        if (ort.env && ort.env.wasm) {
          ort.env.wasm.wasmPaths = ORT_WASM_PATH;
          ort.env.wasm.numThreads = 1; // no cross-origin isolation requirement; mobile-friendly
        }
        const modelBytes = await fetchModel();
        const loaded = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all"
        });
        if (!Array.isArray(loaded.inputNames) || loaded.inputNames[0] !== "images" ||
            !Array.isArray(loaded.outputNames) || loaded.outputNames[0] !== "output") {
          if (loaded.release) await loaded.release();
          throw new Error("YOLOX model input/output contract mismatch");
        }
        session = loaded;
        return session;
      })();
    }
    try {
      return await sessionPromise;
    } finally {
      sessionPromise = null;
    }
  }

  async function detect(source, options) {
    const active = session || await load();
    const prepared = letterbox(source);
    const ort = window.ort;
    const input = new ort.Tensor("float32", prepared.tensorData, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const outputs = await active.run({ images: input });
    const prediction = outputs.output || outputs[active.outputNames[0]];
    if (!prediction || !prediction.data) throw new Error("YOLOX did not return its expected output tensor");
    if (prediction.dims && prediction.dims.join(",") !== "1,3549,85") {
      throw new Error("YOLOX output dimensions are not [1,3549,85]");
    }
    const opts = options || {};
    return postprocess(
      prediction.data,
      prepared.meta,
      opts.confidenceThreshold,
      opts.nmsThreshold,
      opts.maxDetections
    );
  }

  async function dispose() {
    const old = session;
    session = null;
    if (old && typeof old.release === "function") await old.release();
  }

  return Object.freeze({
    load,
    detect,
    dispose,
    postprocess,
    labels: LABELS.slice(),
    constants: Object.freeze({ INPUT_SIZE, OUTPUT_ROWS, OUTPUT_COLUMNS, MODEL_SHA256, ORT_VERSION, MODEL_URL })
  });
});
