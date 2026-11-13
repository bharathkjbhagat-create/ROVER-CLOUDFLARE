/* DEFENX YOLOv8n browser inference.
 * Runs locally on the authenticated camera stream. Frames are never uploaded.
 * Model: unileon-robotics/YOLO8-ONNX yolov8n.onnx (AGPL-3.0; see docs/AI-MODELS.md).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.DEFENX_YOLO = factory(root);
})(typeof window !== "undefined" ? window : globalThis, function createDefenxYolo(root) {
  "use strict";

  const RUNTIME_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js";
  const MODEL_URL = "https://huggingface.co/unileon-robotics/YOLO8-ONNX/resolve/main/yolov8n.onnx";
  const INPUT_W = 640, INPUT_H = 480, CHANNELS = 84;
  const CLASSES = [
    "person","bicycle","car","motorcycle","airplane","bus","train","truck","boat","traffic light",
    "fire hydrant","stop sign","parking meter","bench","bird","cat","dog","horse","sheep","cow",
    "elephant","bear","zebra","giraffe","backpack","umbrella","handbag","tie","suitcase","frisbee",
    "skis","snowboard","sports ball","kite","baseball bat","baseball glove","skateboard","surfboard",
    "tennis racket","bottle","wine glass","cup","fork","knife","spoon","bowl","banana","apple",
    "sandwich","orange","broccoli","carrot","hot dog","pizza","donut","cake","chair","couch",
    "potted plant","bed","dining table","toilet","tv","laptop","mouse","remote","keyboard","cell phone",
    "microwave","oven","toaster","sink","refrigerator","book","clock","vase","scissors","teddy bear",
    "hair drier","toothbrush"
  ];
  const state = { session: null, promise: null, runtimePromise: null, canvas: null, context: null, lastError: null };
  const stats = { inferences: 0, errors: 0, lastInferenceMs: 0, backend: "wasm" };

  function iou(a, b) {
    const x1 = Math.max(a.bbox[0], b.bbox[0]), y1 = Math.max(a.bbox[1], b.bbox[1]);
    const x2 = Math.min(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]);
    const y2 = Math.min(a.bbox[1] + a.bbox[3], b.bbox[1] + b.bbox[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = a.bbox[2] * a.bbox[3], areaB = b.bbox[2] * b.bbox[3];
    return inter / Math.max(1e-9, areaA + areaB - inter);
  }

  // YOLOv8 detection output is channel-major: [1, 4 box values + 80 class scores, anchors].
  function decodeOutput(output, sourceWidth, sourceHeight, options = {}) {
    const data = output && output.data;
    const dims = output && output.dims;
    if (!data || !dims || dims.length !== 3 || dims[0] !== 1) throw new Error("Unsupported YOLO output tensor");
    const channels = dims[1], anchors = dims[2];
    if (channels !== CHANNELS || data.length !== channels * anchors) throw new Error("Unexpected YOLO output shape");
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.35;
    const maxDetections = Number.isFinite(options.maxDetections) ? options.maxDetections : 30;
    const scale = Math.min(INPUT_W / sourceWidth, INPUT_H / sourceHeight);
    const padX = (INPUT_W - sourceWidth * scale) / 2;
    const padY = (INPUT_H - sourceHeight * scale) / 2;
    const candidates = [];
    for (let a = 0; a < anchors; a++) {
      let classId = -1, score = threshold;
      for (let c = 4; c < channels; c++) {
        const value = data[c * anchors + a];
        if (value > score) { score = value; classId = c - 4; }
      }
      if (classId < 0 || !Number.isFinite(score)) continue;
      const cx = data[a], cy = data[anchors + a], w = data[2 * anchors + a], h = data[3 * anchors + a];
      if (![cx, cy, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      const x = Math.max(0, (cx - w / 2 - padX) / scale);
      const y = Math.max(0, (cy - h / 2 - padY) / scale);
      const right = Math.min(sourceWidth, (cx + w / 2 - padX) / scale);
      const bottom = Math.min(sourceHeight, (cy + h / 2 - padY) / scale);
      if (right <= x || bottom <= y) continue;
      candidates.push({ class: CLASSES[classId], classId, score, bbox: [x, y, right - x, bottom - y] });
    }
    candidates.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const candidate of candidates) {
      if (kept.some(item => item.classId === candidate.classId && iou(item, candidate) > 0.45)) continue;
      kept.push(candidate);
      if (kept.length >= maxDetections) break;
    }
    return kept;
  }

  function loadRuntime() {
    if (root.ort) return Promise.resolve(root.ort);
    if (state.runtimePromise) return state.runtimePromise;
    state.runtimePromise = new Promise((resolve, reject) => {
      const doc = root.document;
      if (!doc || !doc.head) return reject(new Error("Browser document unavailable for ONNX Runtime"));
      const script = doc.createElement("script");
      const timer = root.setTimeout(() => reject(new Error("ONNX Runtime download timed out")), 30000);
      script.src = RUNTIME_URL;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => {
        root.clearTimeout(timer);
        root.ort ? resolve(root.ort) : reject(new Error("ONNX Runtime did not initialise"));
      };
      script.onerror = () => { root.clearTimeout(timer); reject(new Error("ONNX Runtime download failed")); };
      doc.head.appendChild(script);
    }).catch(error => { state.runtimePromise = null; throw error; });
    return state.runtimePromise;
  }

  async function load() {
    if (state.session) return state.session;
    if (state.promise) return state.promise;
    state.promise = (async () => {
      try {
        const ort = await loadRuntime();
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
        const session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all"
        });
        const input = session.inputNames && session.inputNames[0];
        const output = session.outputNames && session.outputNames[0];
        if (!input || !output) throw new Error("YOLO model input/output names are missing");
        state.session = session;
        state.inputName = input;
        state.outputName = output;
        state.canvas = root.document.createElement("canvas");
        state.canvas.width = INPUT_W;
        state.canvas.height = INPUT_H;
        state.context = state.canvas.getContext("2d", { willReadFrequently: true });
        if (!state.context) throw new Error("YOLO preprocessing canvas unavailable");
        state.lastError = null;
        return session;
      } catch (error) {
        state.lastError = String(error && error.message || error);
        state.session = null;
        throw error;
      } finally {
        state.promise = null;
      }
    })();
    return state.promise;
  }

  async function detect(source, maxDetections = 30, threshold = 0.35) {
    if (!state.session) await load();
    if (!source || !source.videoWidth && !source.naturalWidth) throw new Error("YOLO requires a ready live video or image source");
    const width = source.videoWidth || source.naturalWidth;
    const height = source.videoHeight || source.naturalHeight;
    const scale = Math.min(INPUT_W / width, INPUT_H / height);
    const drawW = Math.round(width * scale), drawH = Math.round(height * scale);
    const padX = Math.floor((INPUT_W - drawW) / 2), padY = Math.floor((INPUT_H - drawH) / 2);
    const ctx = state.context;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, INPUT_W, INPUT_H);
    ctx.drawImage(source, padX, padY, drawW, drawH);
    const pixels = ctx.getImageData(0, 0, INPUT_W, INPUT_H).data;
    const input = new Float32Array(3 * INPUT_W * INPUT_H);
    const plane = INPUT_W * INPUT_H;
    for (let p = 0, i = 0; p < plane; p++, i += 4) {
      input[p] = pixels[i] / 255;
      input[plane + p] = pixels[i + 1] / 255;
      input[2 * plane + p] = pixels[i + 2] / 255;
    }
    const ort = root.ort;
    const tensor = new ort.Tensor("float32", input, [1, 3, INPUT_H, INPUT_W]);
    const started = root.performance && root.performance.now ? root.performance.now() : Date.now();
    try {
      const results = await state.session.run({ [state.inputName]: tensor });
      const output = results[state.outputName];
      const detections = decodeOutput(output, width, height, { maxDetections, threshold });
      stats.inferences += 1;
      const ended = root.performance && root.performance.now ? root.performance.now() : Date.now();
      stats.lastInferenceMs = Math.max(0, ended - started);
      return detections;
    } catch (error) {
      stats.errors += 1;
      throw error;
    }
  }

  function getStatus() {
    return { loaded: !!state.session, loading: !!state.promise, error: state.lastError, stats: Object.assign({}, stats) };
  }

  return { load, detect, decodeOutput, getStatus, classNames: CLASSES.slice() };
});
