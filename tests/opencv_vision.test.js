"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createOpenCV = require("../public/opencv-vision.js");

function makeRuntime() {
  const mats = [];
  class Mat {
    constructor(rows = 0, cols = 0, data = null) {
      this.rows = rows;
      this.cols = cols;
      this.data = data ? new Uint8Array(data) : new Uint8Array(rows * cols);
      this.deleted = false;
      mats.push(this);
    }
    clone() { return new Mat(this.rows, this.cols, this.data); }
    delete() { this.deleted = true; }
  }
  const cv = {
    Mat,
    Size: class Size { constructor(width, height) { this.width = width; this.height = height; } },
    COLOR_RGBA2GRAY: 1,
    INTER_AREA: 2,
    BORDER_DEFAULT: 3,
    THRESH_BINARY: 4,
    matFromImageData(image) {
      return new Mat(image.height, image.width, image.data);
    },
    cvtColor(src, dst) {
      dst.rows = src.rows;
      dst.cols = src.cols;
      dst.data = new Uint8Array(src.rows * src.cols);
      for (let i = 0, p = 0; i < dst.data.length; i++, p += 4) {
        dst.data[i] = Math.round(0.299 * src.data[p] + 0.587 * src.data[p + 1] + 0.114 * src.data[p + 2]);
      }
    },
    resize(src, dst, size) {
      dst.rows = size.height;
      dst.cols = size.width;
      dst.data = new Uint8Array(dst.rows * dst.cols);
      for (let y = 0; y < dst.rows; y++) for (let x = 0; x < dst.cols; x++) {
        const sx = Math.min(src.cols - 1, Math.floor(x * src.cols / dst.cols));
        const sy = Math.min(src.rows - 1, Math.floor(y * src.rows / dst.rows));
        dst.data[y * dst.cols + x] = src.data[sy * src.cols + sx];
      }
    },
    GaussianBlur(src, dst) {
      dst.rows = src.rows;
      dst.cols = src.cols;
      dst.data = new Uint8Array(src.data);
    },
    absdiff(a, b, dst) {
      dst.rows = a.rows;
      dst.cols = a.cols;
      dst.data = Uint8Array.from(a.data, (v, i) => Math.abs(v - b.data[i]));
    },
    threshold(src, dst, threshold) {
      dst.rows = src.rows;
      dst.cols = src.cols;
      dst.data = Uint8Array.from(src.data, v => v > threshold ? 255 : 0);
    },
    countNonZero(mat) {
      return mat.data.reduce((n, value) => n + (value !== 0 ? 1 : 0), 0);
    }
  };
  return { cv, mats };
}

function image(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill;
    data[i + 1] = fill;
    data[i + 2] = fill;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function makeRoot(cv) {
  const events = [];
  let clock = 1000;
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options && options.detail; }
  }
  return {
    cv,
    navigator: { hardwareConcurrency: 8 },
    performance: { now: () => clock },
    CustomEvent,
    dispatchEvent(event) { events.push(event); return true; },
    setClock(value) { clock = value; },
    events
  };
}

test("loads an already available OpenCV runtime without adding a script", async () => {
  const { cv } = makeRuntime();
  const root = makeRoot(cv);
  const vision = createOpenCV(root);
  assert.equal(await vision.load(), cv);
  assert.equal(vision.getStatus().state, "ready");
  assert.match(vision.getStatus().message, /LOCAL MOTION ANALYSIS/);
});

test("waits for the WebAssembly runtime after the OpenCV script load event", async () => {
  const { cv } = makeRuntime();
  const root = makeRoot(null);
  root.WebAssembly = WebAssembly;
  root.setTimeout = setTimeout;
  root.clearTimeout = clearTimeout;
  let appended = 0;
  root.document = {
    head: {
      appendChild(script) {
        appended += 1;
        script.parentNode = { removeChild() {} };
        setTimeout(() => {
          root.cv = cv;
          script.onload();
        }, 120);
      }
    },
    createElement() { return { dataset: {}, async: false, src: "", onload: null, onerror: null }; },
    getElementById() { return null; }
  };
  const vision = createOpenCV(root);
  assert.equal(await vision.load(), cv);
  assert.equal(appended, 1);
  assert.equal(vision.getStatus().state, "ready");
});

test("uses OpenCV grayscale, resize, blur and frame differencing for motion metrics", async () => {
  const { cv } = makeRuntime();
  const root = makeRoot(cv);
  const vision = createOpenCV(root);
  await vision.load();

  const first = vision.process(image(16, 16, 0), 1000);
  assert.equal(first.baseline, true);
  assert.equal(first.moving, false);
  assert.equal(first.motionRatio, 0);

  const changed = image(16, 16, 0);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) {
    const i = (y * 16 + x) * 4;
    changed.data[i] = changed.data[i + 1] = changed.data[i + 2] = 255;
  }
  const second = vision.process(changed, 1500);
  assert.equal(second.baseline, false);
  assert.equal(second.moving, true);
  assert.ok(second.motionRatio >= 0.012 && second.motionRatio <= 0.75);
  assert.equal(second.source, "opencv.js");
  assert.equal(root.events.filter(event => event.type === "defenx-opencv-motion").length, 2);
  assert.equal(vision.getStatus().stats.processedFrames, 2);
  assert.equal(vision.getStatus().stats.motionFrames, 1);
});

test("throttles duplicate work and ignores malformed image data", async () => {
  const { cv } = makeRuntime();
  const vision = createOpenCV(makeRoot(cv));
  await vision.load();
  assert.equal(vision.process(image(16, 16), 1000).baseline, true);
  assert.equal(vision.process(image(16, 16), 1200), null);
  assert.equal(vision.process({ width: 16, height: 16, data: new Uint8Array(5) }, 1600), null);
  assert.equal(vision.getStatus().stats.processedFrames, 1);
});

test("reset releases the previous frame and the next frame becomes a new baseline", async () => {
  const { cv, mats } = makeRuntime();
  const vision = createOpenCV(makeRoot(cv));
  await vision.load();
  vision.process(image(16, 16), 1000);
  const previous = mats.find(mat => !mat.deleted && mat.rows > 0 && mat.cols > 0);
  assert.ok(previous);
  vision.reset();
  assert.equal(previous.deleted, true);
  const next = vision.process(image(16, 16), 2000);
  assert.equal(next.baseline, true);
});

test("gracefully degrades when OpenCV runtime and browser DOM are unavailable", async () => {
  const root = makeRoot(null);
  const vision = createOpenCV(root);
  assert.equal(await vision.load(), null);
  assert.equal(vision.getStatus().state, "unavailable");
  assert.equal(vision.process(image(8, 8), 2000), null);
});
