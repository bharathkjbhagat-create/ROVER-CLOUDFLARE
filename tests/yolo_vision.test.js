"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createYolo = require("../public/yolo-vision.js");
const yolo = createYolo({});

function outputWithDetections(items) {
  const anchors = items.length;
  const data = new Float32Array(84 * anchors);
  for (let a = 0; a < anchors; a++) {
    const d = items[a];
    data[a] = d.cx;
    data[anchors + a] = d.cy;
    data[2 * anchors + a] = d.w;
    data[3 * anchors + a] = d.h;
    data[(4 + d.classId) * anchors + a] = d.score;
  }
  return { data, dims: [1, 84, anchors] };
}

test("YOLOv8 output decoder maps COCO class and input coordinates to camera coordinates", () => {
  const result = yolo.decodeOutput(outputWithDetections([
    { cx: 320, cy: 240, w: 100, h: 120, classId: 0, score: 0.91 }
  ]), 640, 480);
  assert.equal(result.length, 1);
  assert.equal(result[0].class, "person");
  assert.equal(result[0].score, 0.91);
  assert.deepEqual(result[0].bbox, [270, 180, 100, 120]);
});

test("YOLO decoder applies confidence filtering and class-aware non-maximum suppression", () => {
  const result = yolo.decodeOutput(outputWithDetections([
    { cx: 200, cy: 180, w: 100, h: 100, classId: 2, score: 0.92 },
    { cx: 202, cy: 182, w: 100, h: 100, classId: 2, score: 0.84 },
    { cx: 202, cy: 182, w: 100, h: 100, classId: 5, score: 0.82 },
    { cx: 400, cy: 300, w: 80, h: 80, classId: 1, score: 0.2 }
  ]), 640, 480, { threshold: 0.35 });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(x => x.class).sort(), ["car", "bus"]);
});

test("YOLO decoder clips boxes to source frame and rejects invalid tensors", () => {
  const result = yolo.decodeOutput(outputWithDetections([
    { cx: 10, cy: 10, w: 80, h: 80, classId: 0, score: 0.8 }
  ]), 640, 480);
  assert.deepEqual(result[0].bbox, [0, 0, 50, 50]);
  assert.throws(() => yolo.decodeOutput({ data: new Float32Array(8), dims: [1, 4, 2] }, 640, 480), /shape/);
});

test("YOLO preprocessing decoder handles letterboxed non-4:3 source frames", () => {
  const result = yolo.decodeOutput(outputWithDetections([
    { cx: 320, cy: 240, w: 160, h: 120, classId: 2, score: 0.88 }
  ]), 1280, 720);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].bbox[0] - 440) < 1);
  assert.ok(Math.abs(result[0].bbox[1] - 240) < 1);
  assert.ok(Math.abs(result[0].bbox[2] - 400) < 1);
  assert.ok(Math.abs(result[0].bbox[3] - 240) < 1);
});
