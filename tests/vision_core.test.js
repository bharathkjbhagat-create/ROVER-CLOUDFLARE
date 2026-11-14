// Unit tests for public/vision-core.js (run: node --test tests/vision_core.test.js).
// Inputs are synthetic images and landmark sets; they verify decision logic, not
// real-world accuracy of the neural models (which cannot run in this test).
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

/* ---------- geometry / screen context ---------- */
test("containment and iou", () => {
  assert.equal(core.containment([10, 10, 10, 10], [0, 0, 100, 100]), 1);
  assert.equal(core.containment([200, 200, 10, 10], [0, 0, 100, 100]), 0);
  assert.ok(core.iou([0, 0, 10, 10], [0, 0, 10, 10]) > 0.99);
});

test("a person or car inside a tv/phone/laptop/book is flagged as picture context", () => {
  for (const cls of ["tv", "cell phone", "laptop", "book"]) {
    const person = { class: "person", score: 0.9, bbox: [120, 80, 60, 120] };
    const screen = { class: cls, score: 0.7, bbox: [100, 60, 200, 180] };
    const ctx = core.screenContext(person, [person, screen]);
    assert.ok(ctx && ctx.cls === cls, cls);
  }
  const person = { class: "person", score: 0.9, bbox: [0, 0, 60, 120] };
  const far = { class: "tv", score: 0.9, bbox: [300, 300, 100, 100] };
  assert.equal(core.screenContext(person, [person, far]), null);
  // screens themselves are real objects, never "inside" another screen
  const laptop = { class: "laptop", score: 0.9, bbox: [10, 10, 50, 50] };
  const tv = { class: "tv", score: 0.9, bbox: [0, 0, 200, 200] };
  assert.equal(core.screenContext(laptop, [laptop, tv]), null);
});

/* ---------- pixel statistics ---------- */
test("borderScore finds a straight frame on all four sides but not a plain scene", () => {
  const box = [100, 100, 100, 100];
  const framed = makeImg(320, 320, (x, y) => (x > 86 && x < 214 && y > 86 && y < 214) ? [30, 30, 30] : [220, 220, 220]);
  assert.equal(core.borderScore(framed, box).all, true);
  const plain = makeImg(320, 320, (x, y) => { const v = 120 + ((x * 7 + y * 3) % 5); return [v, v, v]; });
  assert.equal(core.borderScore(plain, box).all, false);
  const partial = makeImg(320, 320, (x, y) => (x > 86 && x < 214 && y > 86) ? [30, 30, 30] : [220, 220, 220]);
  assert.equal(core.borderScore(partial, box).all, false);
});

test("graphicScore flags flat illustrations, not noisy camera-like content", () => {
  const cartoon = makeImg(200, 200, (x, y) => x < 100 ? [255, 40, 40] : [40, 40, 255]);
  assert.equal(core.graphicScore(cartoon, [0, 0, 200, 200]).high, true);
  const photo = makeImg(200, 200, (x, y) => [100 + x / 3 + rnd() * 14, 90 + y / 4 + rnd() * 14, 80 + rnd() * 14]);
  assert.equal(core.graphicScore(photo, [0, 0, 200, 200]).high, false);
});

/* ---------- object verdicts ---------- */
function verdictFor(det, ctx = {}) {
  const tracker = new core.Tracker();
  const t0 = ctx.t0 || 0;
  let v;
  const n = ctx.frames || 1, dt = ctx.dt || 500;
  for (let i = 0; i < n; i++) {
    const d = Object.assign({}, det);
    tracker.update([d], t0 + i * dt);
    v = core.objectVerdict(d, Object.assign({ frameArea: 640 * 480, now: t0 + i * dt }, ctx));
  }
  return v;
}
test("people are never LIVE HUMAN without live face evidence", () => {
  const p = { class: "person", score: 0.95, bbox: [100, 50, 120, 300] };
  assert.equal(verdictFor(p, { frames: 10 }).status, STATUS.UNVERIFIED);
  assert.equal(verdictFor(p, { frames: 10, liveFace: true }).status, STATUS.LIVE_HUMAN);
});
test("photo of a person/vehicle inside a screen is PHOTO / SCREEN IMAGE even after many frames", () => {
  const screen = { cls: "tv", containment: 0.9 };
  assert.equal(verdictFor({ class: "person", score: 0.95, bbox: [100, 50, 60, 100] }, { frames: 10, liveFace: true, screen }).status, STATUS.PHOTO);
  assert.equal(verdictFor({ class: "car", score: 0.95, bbox: [100, 50, 60, 100] }, { frames: 10, screen: { cls: "cell phone", containment: 0.8 } }).status, STATUS.PHOTO);
});
test("vehicles need several stable frames; first sighting is UNVERIFIED", () => {
  const car = { class: "car", score: 0.9, bbox: [50, 50, 200, 120] };
  assert.equal(verdictFor(car, { frames: 1 }).status, STATUS.UNVERIFIED);
  assert.equal(verdictFor(car, { frames: 6 }).status, STATUS.LIVE_VEHICLE);
  for (const cls of ["motorcycle", "bus", "truck", "bicycle"]) assert.equal(verdictFor(Object.assign({}, car, { class: cls }), { frames: 6 }).status, STATUS.LIVE_VEHICLE, cls);
  assert.equal(verdictFor({ class: "backpack", score: 0.8, bbox: [5, 5, 50, 60] }, { frames: 6 }).status, STATUS.REAL_OBJECT);
});
test("low confidence, frame-filling, framed and graphic detections are not confirmed", () => {
  assert.equal(verdictFor({ class: "car", score: 0.3, bbox: [50, 50, 200, 120] }, { frames: 6 }), null);
  assert.equal(verdictFor({ class: "backpack", score: 0.5, bbox: [5, 5, 50, 60] }, { frames: 6 }), null);
  assert.equal(verdictFor({ class: "car", score: 0.9, bbox: [0, 0, 630, 470] }, { frames: 6 }).status, STATUS.UNVERIFIED);
  assert.equal(verdictFor({ class: "car", score: 0.9, bbox: [50, 50, 200, 120] }, { frames: 6, border: { all: true } }).status, STATUS.UNVERIFIED);
  assert.equal(verdictFor({ class: "car", score: 0.9, bbox: [50, 50, 200, 120] }, { frames: 6, border: { all: true }, graphic: { high: true } }).status, STATUS.VIRTUAL);
  // picture cues are exported so a face inside such a region can never be treated as live
  assert.equal(verdictFor({ class: "person", score: 0.9, bbox: [50, 50, 100, 200] }, { frames: 6, liveFace: true, border: { all: true } }).cue, true);
  assert.equal(verdictFor({ class: "person", score: 0.9, bbox: [50, 50, 100, 200] }, { frames: 6, liveFace: true }).cue, undefined);
});

/* ---------- liveness ---------- */
function run(frames, mk) { const lv = new core.Liveness(); let t = 0; for (let i = 0; i < frames; i++) { lv.update(mk(i), t); t += 100; } return { lv, t }; }
test("liveness: a still face, rigid photo motion and landmark jitter are NOT live", () => {
  assert.equal(run(60, () => landmarks(200, 200, 60)).lv.verified(6000), false);
  const rigid = run(60, i => { // slide, scale and rotate a photo: similarity transform only
    const a = Math.sin(i / 6) * 0.3, sc = 1 + Math.sin(i / 9) * 0.15, tx = Math.sin(i / 5) * 20;
    return landmarks(200, 200, 60).map(([x, y]) => [200 + tx + sc * ((x - 200) * Math.cos(a) - (y - 200) * Math.sin(a)), 200 + sc * ((x - 200) * Math.sin(a) + (y - 200) * Math.cos(a))]);
  });
  assert.equal(rigid.lv.verified(6000), false);
  const jitter = run(60, () => landmarks(200, 200, 60).map(([x, y]) => [x + (rnd() - 0.5) * 0.3, y + (rnd() - 0.5) * 0.3]));
  assert.equal(jitter.lv.verified(6000), false);
});
test("liveness: one blink alone cannot complete the randomized challenge", () => {
  const lv = new core.Liveness(() => 0); let t = 0;
  const frame = opts => { lv.update(landmarks(200, 200, 60, opts), t); t += 100; };
  for (let i = 0; i < 8; i++) frame({});
  for (let i = 0; i < 3; i++) frame({ eye: 0.3 });
  for (let i = 0; i < 4; i++) frame({});
  assert.ok(lv.challengeIndex <= 1);
  assert.equal(lv.verified(t), false);
});
test("liveness: mouth movement alone cannot complete the randomized challenge", () => {
  const lv = new core.Liveness(() => 0); let t = 0;
  const frame = opts => { lv.update(landmarks(200, 200, 60, opts), t); t += 100; };
  for (let i = 0; i < 8; i++) frame({});
  for (let i = 0; i < 3; i++) frame({ mouth: 1 });
  for (let i = 0; i < 4; i++) frame({});
  assert.ok(lv.challengeIndex <= 1);
  assert.equal(lv.verified(t), false);
});
test("liveness: randomized three-step challenge requires the requested actions in order", () => {
  const lv = new core.Liveness(() => 0);
  let t = 0;
  const frame = opts => { lv.update(landmarks(200, 200, 60, opts), t); t += 100; };
  for (let i = 0; i < 8; i++) frame({});
  for (const cue of lv.challenge) {
    if (cue === "blink") {
      for (let i = 0; i < 3; i++) frame({ eye: 0.3 });
      for (let i = 0; i < 3; i++) frame({});
    } else if (cue === "mouth") {
      for (let i = 0; i < 3; i++) frame({ mouth: 1 });
      for (let i = 0; i < 3; i++) frame({});
    } else {
      const yaw = cue === "turn_left" ? -0.25 : 0.25;
      for (let i = 0; i < 3; i++) frame({ yaw });
      for (let i = 0; i < 3; i++) frame({});
    }
  }
  assert.equal(lv.challenge.length, 3);
  assert.equal(lv.prompt(), null);
  assert.equal(lv.verified(t), true);
  assert.equal(lv.verified(t + 20000), false);
  assert.notEqual(lv.prompt(), null);
});

/* ---------- face clarity ---------- */
test("faceClarity rejects small, side-on, low-score, blurred and dark faces", () => {
  const good = { bbox: [100, 100, 120, 150], score: 0.9, points: landmarks(160, 150, 60) };
  assert.equal(core.faceClarity(good).clear, true);
  assert.equal(core.faceClarity(Object.assign({}, good, { bbox: [100, 100, 30, 40] })).clear, false);
  assert.equal(core.faceClarity(Object.assign({}, good, { score: 0.3 })).clear, false);
  assert.equal(core.faceClarity(Object.assign({}, good, { points: landmarks(160, 150, 60, { yaw: 0.6 }) })).clear, false);
  const flat = makeImg(320, 320, () => [128, 128, 128]);
  assert.ok(core.faceClarity(good, flat).reasons.includes("blurred"));
  const dark = makeImg(320, 320, (x, y) => { const v = 5 + ((x * 31 + y * 17) % 40); return [v, v, v]; });
  assert.ok(core.faceClarity(good, dark).reasons.includes("too dark"));
});

/* ---------- mask ---------- */
function faceImage(kind) {
  const pts = landmarks(200, 160, 80), SKIN = [224, 172, 140];
  const img = makeImg(400, 400, (x, y) => {
    const lowerFace = y > 160 + 0.55 * 80 && x > 120 && x < 280 && y < 160 + 1.75 * 80;
    if (kind === "white" && lowerFace) return [236, 236, 240];
    if (kind === "blue" && lowerFace) return [140, 190, 225];
    if (kind === "black" && lowerFace) return [25, 25, 30];
    if (kind === "nomask" && Math.abs(x - 200) < 0.28 * 80 && y > 160 + 1.06 * 80 && y < 160 + 1.2 * 80) return [190, 80, 92];
    return SKIN;
  });
  return { img, pts };
}
test("mask: no mask / white / blue / black masks / skin-coloured cover", () => {
  assert.equal(core.maskAnalysis(...Object.values(faceImage("nomask"))).state, "NO_MASK");
  for (const k of ["white", "blue", "black"]) assert.equal(core.maskAnalysis(...Object.values(faceImage(k))).state, "MASK", k);
  assert.equal(core.maskAnalysis(...Object.values(faceImage("skin"))).state, "UNCLEAR"); // ambiguous => never guessed
});

/* ---------- identity ---------- */
const vec = () => Array.from({ length: 128 }, () => (rnd() - 0.5) * 0.2);
const near = (v, d) => { const dir = vec(); const n = Math.hypot(...dir); return v.map((x, i) => x + dir[i] / n * d); };
test("identity: enrolled user recognised, stranger unknown, borderline unverified", () => {
  const alice = { id: "a", name: "Alice", descriptor: vec() }, bob = { id: "b", name: "Bob", descriptor: vec() };
  const r = core.matchIdentity(near(alice.descriptor, 0.2), [alice, bob]);
  assert.equal(r.state, "RECOGNIZED"); assert.equal(r.name, "Alice");
  assert.equal(core.matchIdentity(vec(), [alice, bob]).state, "UNKNOWN");
  assert.equal(core.matchIdentity(near(alice.descriptor, 0.56), [alice, bob]).state, "UNVERIFIED");
  assert.equal(core.matchIdentity(vec(), []).state, "UNKNOWN");
  const twin = { id: "t", name: "Twin", descriptor: near(alice.descriptor, 0.02) }; // ambiguous between two people
  assert.equal(core.matchIdentity(near(alice.descriptor, 0.2), [alice, twin]).state, "UNVERIFIED");
  // several reference photos of the SAME person must not make the match ambiguous
  const alice2 = { id: "a2", name: "Alice", descriptor: near(alice.descriptor, 0.1) };
  const same = core.matchIdentity(near(alice.descriptor, 0.15), [alice, alice2, bob]);
  assert.equal(same.state, "RECOGNIZED"); assert.equal(same.name, "Alice");
  const photoProfile = { id: "a", name: "Alice", descriptors: [alice.descriptor, alice2.descriptor] };
  const multi = core.matchIdentity(near(alice2.descriptor, 0.04), [photoProfile, bob]);
  assert.equal(multi.state, "RECOGNIZED"); assert.equal(multi.name, "Alice");
});
test("identity: damaged or incompatible descriptors fail closed as UNVERIFIED", () => {
  const valid = { id: "a", name: "Alice", descriptor: vec() };
  assert.equal(core.matchIdentity(vec(), [{ id: "broken", name: "Broken", descriptor: [1, 2] }]).state, "UNVERIFIED");
  assert.equal(core.matchIdentity(vec(), [{ id: "broken", name: "Broken", descriptors: [[NaN, 1]] }]).state, "UNVERIFIED");
  assert.equal(core.matchIdentity(null, [valid]).state, "UNVERIFIED");
  assert.equal(core.matchIdentity([NaN, 0], [valid]).state, "UNVERIFIED");
  assert.equal(core.matchIdentity(near(valid.descriptor, 0.2), [valid, { id: "bad", name: "Bad", descriptor: [1] }]).state, "RECOGNIZED");
});
test("identity smoothing needs 3 agreeing frames", () => {
  const a = { state: "RECOGNIZED", name: "A", confidence: 0.8 }, u = { state: "UNKNOWN", name: null, confidence: 0.9 };
  assert.equal(core.smoothIdentity([a, a]).state, "UNVERIFIED");
  assert.equal(core.smoothIdentity([a, u, a, u, a]).state, "RECOGNIZED");
  assert.equal(core.smoothIdentity([a, u, a, u, u]).state, "UNKNOWN");
  assert.equal(core.smoothIdentity([a, u, { state: "UNVERIFIED", confidence: 0.4 }, a, u]).state, "UNVERIFIED");
});

/* ---------- combined statuses & alerts ---------- */
const clear = { clear: true, reasons: [] };
const M = s => ({ state: s, confidence: 0.8 });
const ID = (s, n) => ({ state: s, name: n || null, confidence: 0.8 });
test("combined statuses and alert categories", () => {
  let r = core.resolveFace({ clarity: { clear: false, reasons: ["blurred"] }, mask: M("NO_MASK"), identity: ID("UNKNOWN"), live: true });
  assert.equal(r.identity, STATUS.NOT_CLEAR); assert.deepEqual(r.alerts, []);
  r = core.resolveFace({ clarity: clear, mask: M("NO_MASK"), identity: ID("RECOGNIZED", "Ann"), live: false });
  assert.equal(r.identity, STATUS.UNVERIFIED); assert.deepEqual(r.alerts, []); assert.equal(r.name, null);
  r = core.resolveFace({ clarity: clear, mask: M("NO_MASK"), identity: ID("UNKNOWN"), live: false });
  assert.deepEqual(r.alerts, []); // photo of a stranger: no alert
  r = core.resolveFace({ clarity: clear, mask: M("NO_MASK"), identity: ID("UNKNOWN"), live: true });
  assert.equal(r.identity, STATUS.UNKNOWN); assert.deepEqual(r.alerts, ["unknown_no_mask"]);
  r = core.resolveFace({ clarity: clear, mask: M("MASK"), identity: ID("UNKNOWN"), live: true });
  assert.equal(r.identity, STATUS.UNKNOWN); assert.equal(r.mask, STATUS.MASK); assert.deepEqual(r.alerts, ["unknown_person"]);
  r = core.resolveFace({ clarity: clear, mask: M("NO_MASK"), identity: ID("RECOGNIZED", "Ann"), live: true });
  assert.equal(r.identity, STATUS.RECOGNIZED); assert.equal(r.name, "Ann"); assert.deepEqual(r.alerts, ["registered_no_mask"]);
  r = core.resolveFace({ clarity: clear, mask: M("MASK"), identity: ID("RECOGNIZED", "Ann"), live: true });
  assert.deepEqual(r.alerts, []);
  r = core.resolveFace({ clarity: clear, mask: M("UNCLEAR"), identity: ID("UNKNOWN"), live: true });
  assert.equal(r.mask, STATUS.NOT_CLEAR); assert.deepEqual(r.alerts, ["unknown_person"]);
  r = core.resolveFace({ clarity: clear, mask: M("MASK"), identity: ID("UNVERIFIED"), live: true });
  assert.equal(r.identity, STATUS.UNVERIFIED); assert.deepEqual(r.alerts, []);
});
test("AlertGate suppresses repeats for one continuous detection", () => {
  const g = new core.AlertGate(6000);
  assert.equal(g.offer("unknown_person", 1, 0), true);
  for (let t = 500; t < 60000; t += 500) assert.equal(g.offer("unknown_person", 1, t), false);
  assert.equal(g.offer("unknown_person", 2, 61000), true);          // different track
  assert.equal(g.offer("unknown_no_mask", 1, 61000), true);         // escalated category
  assert.equal(g.offer("unknown_person", 1, 61000 + 7000), true);   // returned after a gap
});
test("Tracker keeps ids through short dropouts and expires old tracks", () => {
  const tr = new core.Tracker(4000);
  const d1 = { class: "car", bbox: [10, 10, 100, 60] }; tr.update([d1], 0);
  const d2 = { class: "car", bbox: [14, 12, 100, 60] }; tr.update([d2], 1000);
  assert.equal(d1.track.id, d2.track.id);
  tr.update([], 3000);
  const d3 = { class: "car", bbox: [16, 12, 100, 60] }; tr.update([d3], 3500);
  assert.equal(d3.track.id, d1.track.id);
  const dropped = tr.update([], 9000);
  assert.equal(dropped.length, 1); assert.equal(tr.tracks.length, 0);
});