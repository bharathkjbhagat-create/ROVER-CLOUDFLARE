// Presentation-attack scenarios for the face liveness / picture-context logic in public/vision-core.js.
// Inputs are SYNTHETIC landmark sequences (10 fps) - they test decision logic, NOT real-world model accuracy.
// Run: node --test tests/spoof_attacks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../public/vision-core.js");
const { STATUS } = core;
function makeImg(W, H, fn) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = fn(x, y), i = (y * W + x) * 4;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data, width: W, height: H };
}
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// Canonical 68-point face. s = inter-ocular distance in px.
function landmarks(cx, cy, s, { eye = 1, mouth = 0, yaw = 0 } = {}) {
  const p = Array.from({ length: 68 }, (_, i) => [cx + (i - 34) * 0.02 * s, cy + s]);
  const w = 0.38 * s, h = 0.14 * s * eye;
  const L = [cx - s / 2, cy], R = [cx + s / 2, cy];
  p[36] = [L[0] - w / 2, L[1]]; p[39] = [L[0] + w / 2, L[1]];
  p[37] = [L[0] - w / 6, L[1] - h / 2]; p[38] = [L[0] + w / 6, L[1] - h / 2];
  p[41] = [L[0] - w / 6, L[1] + h / 2]; p[40] = [L[0] + w / 6, L[1] + h / 2];
  p[42] = [R[0] - w / 2, R[1]]; p[45] = [R[0] + w / 2, R[1]];
  p[43] = [R[0] - w / 6, R[1] - h / 2]; p[44] = [R[0] + w / 6, R[1] - h / 2];
  p[47] = [R[0] - w / 6, R[1] + h / 2]; p[46] = [R[0] + w / 6, R[1] + h / 2];
  p[19] = [L[0], cy - 0.35 * s]; p[24] = [R[0], cy - 0.35 * s];
  p[30] = [cx + yaw * s, cy + 0.55 * s]; p[33] = [cx, cy + 0.75 * s];
  p[48] = [cx - 0.3 * s, cy + 1.15 * s]; p[54] = [cx + 0.3 * s, cy + 1.15 * s];
  p[51] = [cx, cy + 1.05 * s]; p[57] = [cx, cy + 1.17 * s + mouth * 0.33 * s];
  for (const i of [49, 50]) p[i] = [cx - (52 - i) * 0.08 * s, cy + 1.07 * s];
  for (const i of [52, 53]) p[i] = [cx + (i - 51) * 0.08 * s, cy + 1.07 * s];
  for (const i of [55, 56]) p[i] = [cx + (57 - i) * 0.1 * s, cy + 1.17 * s + mouth * 0.2 * s];
  for (const i of [58, 59]) p[i] = [cx - (i - 57) * 0.1 * s + (i === 59 ? 0 : 0), cy + 1.17 * s + mouth * 0.2 * s];
  p[4] = [cx - 0.8 * s, cy + 0.8 * s]; p[8] = [cx, cy + 1.6 * s]; p[12] = [cx + 0.8 * s, cy + 0.8 * s];
  return p;
}


const FPS_MS = 100;
function sequence(frames, mk) { const lv = new core.Liveness(); let anyVerified = false, t = 0, verifiedFrames = 0; for (let i = 0; i < frames; i++) { lv.update(mk(i), t); if (lv.verified(t)) { anyVerified = true; verifiedFrames++; } t += FPS_MS; } return { lv, anyVerified, verifiedFrames, t }; }
const base = () => landmarks(200, 200, 60);
const transform = (pts, f) => pts.map(([x, y]) => f(x - 200, y - 200)).map(([x, y]) => [200 + x, 200 + y]);
function verdictFor(det, ctx = {}) {
  const tracker = new core.Tracker(); let v; const n = ctx.frames || 1;
  for (let i = 0; i < n; i++) { const d = Object.assign({}, det); tracker.update([d], i * 500); v = core.objectVerdict(d, Object.assign({ frameArea: 640 * 480, now: i * 500 }, ctx)); }
  return v;
}

test("ATTACK printed photo held still for 60 s is never live", () => {
  assert.equal(sequence(600, base).anyVerified, false);
});
test("ATTACK printed photo hand-held (rigid shake, tilt, distance change) for 60 s is never live", () => {
  const r = sequence(600, i => { const a = Math.sin(i / 7) * 0.25, sc = 1 + Math.sin(i / 11) * 0.12, tx = Math.sin(i / 5) * 18, ty = Math.cos(i / 8) * 10;
    return transform(base(), (x, y) => [tx + sc * (x * Math.cos(a) - y * Math.sin(a)), ty + sc * (x * Math.sin(a) + y * Math.cos(a))]); });
  assert.equal(r.anyVerified, false);
});
test("ATTACK printed photo with sensor-level landmark noise (<=0.5 px) is never live", () => {
  let s = 99; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  assert.equal(sequence(600, () => base().map(([x, y]) => [x + (rnd() - 0.5), y + (rnd() - 0.5)])).anyVerified, false);
});
test("ATTACK printed photo tilted away (perspective squeeze, yaw-like) is never live", () => {
  const r = sequence(600, i => { const k = 1 - 0.18 * (0.5 + 0.5 * Math.sin(i / 9)); return transform(base(), (x, y) => [x * k, y]); });
  assert.equal(r.anyVerified, false, "uniform horizontal squeeze of a flat photo must not count as facial motion");
});
test("ATTACK bent / curled photo (slow smooth warp) is never live", () => {
  const r = sequence(600, i => { const bend = 0.10 * Math.sin(i / 20); return transform(base(), (x, y) => [x * (1 + bend * (y / 60)), y * (1 - bend * (x / 120))]); });
  assert.equal(r.verifiedFrames, 0);
});
test("ATTACK phone-screen replay of a blinking, talking face is blocked by picture context on every frame", () => {
  const live = sequence(300, i => landmarks(200, 200, 60, { eye: (i % 40 >= 12 && i % 40 < 15) ? 0.3 : 1, mouth: (i % 50 >= 20 && i % 50 < 26) ? 1 : 0 }));
  assert.equal(live.anyVerified, true, "a replayed video DOES animate the landmarks, so liveness alone cannot stop it");
  for (const screen of [{ cls: "cell phone", containment: 0.85 }, { cls: "tv", containment: 0.9 }, { cls: "laptop", containment: 0.8 }]) {
    for (let frames = 1; frames <= 40; frames += 13) {
      const v = verdictFor({ class: "person", score: 0.95, bbox: [100, 50, 60, 100] }, { frames, liveFace: true, screen });
      assert.equal(v.status, STATUS.PHOTO, screen.cls + " @" + frames);
      assert.notEqual(v.status, STATUS.LIVE_HUMAN);
    }
  }
});
test("ATTACK photo/video inside a straight-edged frame (border cue) is never LIVE HUMAN", () => {
  for (const frames of [1, 6, 30]) assert.notEqual(verdictFor({ class: "person", score: 0.9, bbox: [50, 50, 100, 200] }, { frames, liveFace: true, border: { all: true } }).status, STATUS.LIVE_HUMAN);
});
test("KNOWN LIMITATION full-frame video replay with no visible bezel passes liveness (needs challenge-response or depth hardware)", () => {
  const live = sequence(300, i => landmarks(200, 200, 60, { eye: (i % 40 >= 12 && i % 40 < 15) ? 0.3 : 1 }));
  const v = verdictFor({ class: "person", score: 0.95, bbox: [100, 50, 60, 100] }, { frames: 10, liveFace: live.anyVerified });
  // This test pins the CURRENT behaviour so nobody assumes this attack is covered. If a mitigation is added,
  // flip the assertion and update docs/ACCEPTANCE_REPORT.md.
  assert.equal(v.status, STATUS.LIVE_HUMAN);
});
