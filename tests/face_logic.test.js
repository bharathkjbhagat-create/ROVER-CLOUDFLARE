// Unit tests for the browser-side face logic (pure functions). Run: node tests/face_logic.test.js
const assert = require("assert");
const L = require("../public/face-recognition.js");

function solid(r, g, b, w = 8, h = 8, noise = 0) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = noise ? (Math.sin(i * 12.9898) * 43758.5453 % 1) * noise : 0;
    d[i * 4] = r + n; d[i * 4 + 1] = g + n; d[i * 4 + 2] = b + n; d[i * 4 + 3] = 255;
  }
  return d;
}
const S = (rgb, noise) => L.regionStats(solid(...rgb, 8, 8, noise), 8, 8, { x: 0, y: 0, w: 8, h: 8 });

// Pixel-statistics regression: optimized scan must preserve the original YCbCr means,
// luma variance and clipping behavior used by the mask/quality heuristics.
{
  const pixels = new Uint8ClampedArray([
    240, 180, 130, 255,  30, 80, 210, 255,
    90, 150, 70, 255,   12, 18, 24, 255
  ]);
  const actual = L.regionStats(pixels, 2, 2, { x: -1, y: 0, w: 3, h: 2 });
  const sample = [[240,180,130],[30,80,210],[90,150,70],[12,18,24]];
  const y = sample.map(([r,g,b]) => 0.299*r + 0.587*g + 0.114*b);
  const cb = sample.map(([r,g,b]) => 128 - 0.168736*r - 0.331264*g + 0.5*b);
  const cr = sample.map(([r,g,b]) => 128 + 0.5*r - 0.418688*g - 0.081312*b);
  const mean = a => a.reduce((sum,v) => sum+v, 0) / a.length;
  const close = (a,b) => assert(Math.abs(a-b) < 1e-9, a + " != " + b);
  close(actual.y, mean(y)); close(actual.cb, mean(cb)); close(actual.cr, mean(cr));
  close(actual.sd, Math.sqrt(Math.max(0, mean(y.map(v => v*v)) - mean(y)**2)));
  assert.strictEqual(actual.n, 4);
  assert.strictEqual(L.regionStats(pixels, 2, 2, { x: 3, y: 0, w: 1, h: 1 }), null);
}

const SKINS = { light: [233, 190, 165], medium: [198, 146, 110], dark: [120, 78, 55] };
// Real eye boxes mix sclera, iris, lashes and skin: mid brightness and high variance.
const realisticEye = tone => ({ y: S(SKINS[tone]).y * 0.62, cb: 120, cr: 140, sd: 42, n: 64 });
const skinRegions = tone => {
  const s = S(SKINS[tone], 6);
  return { forehead: s, cheekL: s, cheekR: s, lowerL: s, lowerR: s, chin: s, philtrum: s, eyeL: realisticEye(tone), eyeR: realisticEye(tone) };
};
const masked = (tone, rgb) => { const r = skinRegions(tone), m = S(rgb, 4); return Object.assign(r, { lowerL: m, lowerR: m, chin: m, philtrum: m }); };

// skin detection across tones, mask colours not skin
for (const tone of Object.keys(SKINS)) assert(L.skinLike(S(SKINS[tone])), "skin " + tone);
for (const rgb of [[60, 120, 200], [245, 245, 245], [20, 20, 20], [90, 140, 90]]) assert(!L.skinLike(S(rgb)), "mask " + rgb);

// uncovered faces are not flagged, covered faces are (all tones, common mask colours)
for (const tone of Object.keys(SKINS)) {
  assert.strictEqual(L.decideOcclusion(skinRegions(tone)).occluded, false, "bare " + tone);
  for (const rgb of [[60, 120, 200], [245, 245, 245], [20, 20, 20], [90, 140, 90]]) {
    const r = L.decideOcclusion(masked(tone, rgb));
    assert(r.occluded && r.reason === "lower_face_covered", "masked " + tone + " " + rgb);
  }
}
// scarf covering only 3 of 4 lower patches still flagged; 1 of 4 not
{ const r = masked("medium", [60, 120, 200]); r.philtrum = r.forehead; assert(L.decideOcclusion(r).occluded); }
{ const r = skinRegions("medium"); r.chin = S([60, 120, 200]); assert(!L.decideOcclusion(r).occluded); }
// sunglasses
{ const r = skinRegions("light"); r.eyeL = { y: 14, cb: 128, cr: 128, sd: 5, n: 64 }; r.eyeR = { y: 14, cb: 128, cr: 128, sd: 5, n: 64 }; const o = L.decideOcclusion(r); assert(o.occluded && o.reason === "eyes_covered"); }
// monochrome / IR feed: cannot judge, must report unreliable (never claims a mask)
{ const g = S([128, 128, 128]); const o = L.decideOcclusion({ forehead: g, cheekL: g, cheekR: g, lowerL: g, lowerR: g, chin: g, philtrum: g }); assert(!o.occluded && !o.reliable); }
// missing data -> not occluded, unreliable
assert.strictEqual(L.decideOcclusion({}).reliable, false);

// quality: safe fallbacks
const good = { boxW: 120, boxH: 120, score: 0.9, yaw: 0.05, luma: 120, sharp: 60 };
assert(L.qualityCheck(good).ok);
const cases = { face_too_small: { boxW: 40 }, low_detection_confidence: { score: 0.3 }, camera_angle: { yaw: 0.4 },
  low_light: { luma: 20 }, overexposed: { luma: 240 }, motion_blur: { sharp: 3 } };
for (const [reason, patch] of Object.entries(cases)) assert.strictEqual(L.qualityCheck(Object.assign({}, good, patch)).reason, reason);

// yaw: frontal vs turned
const pts = Array.from({ length: 68 }, () => ({ x: 50, y: 50 }));
pts[0] = { x: 0, y: 50 }; pts[16] = { x: 100, y: 50 };
pts[30] = { x: 50, y: 60 }; assert(Math.abs(L.yawRatio(pts)) < 0.02);
pts[30] = { x: 80, y: 60 }; assert(Math.abs(L.yawRatio(pts)) > L.T.maxYaw);

// sharpness: checkerboard (sharp) vs flat/blurred
const sharp = new Float32Array(48 * 48).map((_, i) => ((i % 48 + Math.floor(i / 48)) % 2) * 200);
const flat = new Float32Array(48 * 48).fill(120);
const blur = new Float32Array(48 * 48).map((_, i) => 100 + (i % 48) * 0.5);
assert(L.laplacianVariance(sharp, 48, 48) > L.T.minSharp);
assert(L.laplacianVariance(flat, 48, 48) < L.T.minSharp);
assert(L.laplacianVariance(blur, 48, 48) < L.T.minSharp);

// track assignment keeps identities across small moves, creates new for distant faces, no double-claim
const tr = [{ box: { x: 100, y: 100, width: 80, height: 80 } }, { box: { x: 400, y: 100, width: 80, height: 80 } }];
assert.deepStrictEqual(L.assign(tr, [{ x: 108, y: 104, width: 80, height: 80 }, { x: 395, y: 98, width: 80, height: 80 }]), [0, 1]);
assert.deepStrictEqual(L.assign(tr, [{ x: 250, y: 300, width: 80, height: 80 }]), [-1]);
assert.deepStrictEqual(L.assign(tr, [{ x: 100, y: 100, width: 80, height: 80 }, { x: 102, y: 101, width: 80, height: 80 }]), [0, -1]);

// voting
assert(L.majority([1, 1, 1, 0, 0].map(v => ({ v })), o => o.v));
assert(!L.majority([1, 0, 0, 0, 0].map(v => ({ v })), o => o.v));
assert.strictEqual(L.topReason([{ qualityOk: false, reason: "low_light" }, { qualityOk: false, reason: "low_light" }, { qualityOk: false, reason: "camera_angle" }]), "low_light");

console.log("face logic tests: PASS");
