"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const yolox = require("../public/yolox-browser.js");

const ROWS = yolox.constants.OUTPUT_ROWS;
const COLS = yolox.constants.OUTPUT_COLUMNS;
const META = { width: 640, height: 480, ratio: 0.65, padX: 0, padY: 0 };

function output() { return new Float32Array(ROWS * COLS); }
function anchor(row) {
  let remaining = row;
  for (const stride of [8, 16, 32]) {
    const size = 416 / stride;
    const count = size * size;
    if (remaining < count) return { gx: remaining % size, gy: Math.floor(remaining / size), stride };
    remaining -= count;
  }
  throw new Error("anchor row out of range");
}
function detection(data, row, values) {
  const offset = row * COLS;
  const a = anchor(row);
  data[offset] = values.cx / a.stride - a.gx;
  data[offset + 1] = values.cy / a.stride - a.gy;
  data[offset + 2] = Math.log(values.width / a.stride);
  data[offset + 3] = Math.log(values.height / a.stride);
  data[offset + 4] = values.objectness;
  data[offset + 5 + values.classId] = values.classScore;
}

test("YOLOX-Nano exposes the expected pinned model and class map", () => {
  assert.equal(yolox.constants.INPUT_SIZE, 416);
  assert.equal(yolox.constants.OUTPUT_ROWS, 3549);
  assert.equal(yolox.constants.OUTPUT_COLUMNS, 85);
  assert.equal(yolox.labels.length, 80);
  assert.equal(yolox.labels[0], "person");
  assert.equal(yolox.labels[2], "car");
  assert.match(yolox.constants.MODEL_SHA256, /^[a-f0-9]{64}$/);
});

test("decodes a person prediction into original camera coordinates", () => {
  const data = output();
  detection(data, 1325, { cx: 208, cy: 208, width: 100, height: 150, objectness: 0.95, classId: 0, classScore: 0.9 });
  const found = yolox.postprocess(data, META, 0.4, 0.45, 20);
  assert.equal(found.length, 1);
  assert.equal(found[0].class, "person");
  assert.ok(Math.abs(found[0].score - 0.855) < 1e-5);
  assert.ok(Math.abs(found[0].bbox[0] - (158 / 0.65)) < 1e-4);
  assert.ok(Math.abs(found[0].bbox[1] - (133 / 0.65)) < 1e-4);
  assert.ok(found[0].bbox[2] > 0 && found[0].bbox[3] > 0);
});

test("keeps the highest overlapping detection per class but preserves a different class", () => {
  const data = output();
  detection(data, 1325, { cx: 208, cy: 208, width: 100, height: 120, objectness: 0.95, classId: 0, classScore: 0.95 });
  detection(data, 1326, { cx: 208, cy: 208, width: 102, height: 122, objectness: 0.9, classId: 0, classScore: 0.9 });
  detection(data, 1327, { cx: 208, cy: 208, width: 100, height: 120, objectness: 0.92, classId: 2, classScore: 0.9 });
  const found = yolox.postprocess(data, META, 0.4, 0.45, 20);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(item => item.class).sort(), ["car", "person"]);
});

test("decodes all three YOLOX stride grids (8, 16 and 32)", () => {
  const data = output();
  detection(data, 1325, { cx: 208, cy: 208, width: 100, height: 100, objectness: 0.95, classId: 0, classScore: 0.95 });
  detection(data, 2704, { cx: 80, cy: 80, width: 32, height: 48, objectness: 0.95, classId: 2, classScore: 0.9 });
  detection(data, 3380, { cx: 96, cy: 96, width: 64, height: 96, objectness: 0.95, classId: 5, classScore: 0.9 });
  const found = yolox.postprocess(data, META, 0.4, 0.45, 20);
  assert.equal(found.length, 3);
  const byClass = Object.fromEntries(found.map(item => [item.class, item]));
  assert.ok(Math.abs(byClass.car.bbox[0] - (64 / 0.65)) < 1e-4);
  assert.ok(Math.abs(byClass.bus.bbox[0] - (64 / 0.65)) < 1e-4);
  assert.ok(Math.abs(byClass.person.bbox[0] - (158 / 0.65)) < 1e-4);
});

test("applies objectness times class confidence and the confidence threshold", () => {
  const data = output();
  detection(data, 1325, { cx: 200, cy: 200, width: 80, height: 80, objectness: 0.7, classId: 2, classScore: 0.4 });
  const found = yolox.postprocess(data, META, 0.4, 0.45, 20);
  assert.equal(found.length, 0);
});

test("clamps boxes to image bounds and ignores invalid boxes", () => {
  const data = output();
  detection(data, 0, { cx: 4, cy: 4, width: 90, height: 90, objectness: 0.99, classId: 2, classScore: 0.99 });
  const offset = COLS;
  data[offset] = NaN;
  data[offset + 1] = 40;
  data[offset + 2] = 100;
  data[offset + 3] = 100;
  data[offset + 4] = 0.99;
  data[offset + 5] = 0.99;
  const found = yolox.postprocess(data, META, 0.4, 0.45, 20);
  assert.equal(found.length, 1);
  assert.equal(found[0].bbox[0], 0);
  assert.equal(found[0].bbox[1], 0);
  assert.ok(found[0].bbox[0] + found[0].bbox[2] <= META.width);
  assert.ok(found[0].bbox[1] + found[0].bbox[3] <= META.height);
});

test("rejects model-contract and geometry mismatches", () => {
  assert.throws(() => yolox.postprocess(new Float32Array(20), META), /output shape mismatch/i);
  assert.throws(() => yolox.postprocess(output(), { width: 0, height: 1, ratio: 1 }), /geometry is invalid/i);
});
