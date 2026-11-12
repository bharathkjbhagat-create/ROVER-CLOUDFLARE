/* DEFENX vision core: pure decision logic for the live AI pipeline.
 * No DOM, no network, no models. It turns raw detector output (COCO-SSD boxes,
 * face-api landmarks/descriptors) plus pixel statistics into conservative
 * statuses. Every check here is a heuristic, not a guarantee: whenever the
 * evidence is insufficient the answer is UNVERIFIED / FACE NOT CLEAR.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DEFENX_VISION_CORE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATUS = {
    LIVE_HUMAN: "LIVE HUMAN", LIVE_VEHICLE: "LIVE VEHICLE", REAL_OBJECT: "REAL-WORLD OBJECT",
    PHOTO: "PHOTO / SCREEN IMAGE", VIRTUAL: "VIRTUAL / GRAPHICAL OBJECT", UNVERIFIED: "UNVERIFIED",
    MASK: "MASK DETECTED", NO_MASK: "NO MASK", RECOGNIZED: "FACE RECOGNIZED",
    UNKNOWN: "UNKNOWN PERSON", NOT_CLEAR: "FACE NOT CLEAR"
  };
  const VEHICLE_CLASSES = new Set(["bicycle", "car", "motorcycle", "bus", "truck", "train"]);
  // COCO classes that are themselves picture-bearing surfaces. A person/vehicle
  // sitting inside one of these is a picture of that thing, not the thing.
  const SCREEN_CLASSES = new Set(["tv", "laptop", "cell phone", "book"]);
  const DEFAULT_ALERT_OBJECTS = ["backpack", "handbag", "suitcase", "knife", "scissors", "baseball bat"];
  const T = {
    personScore: 0.55, vehicleScore: 0.5, objectScore: 0.6,
    screenContainment: 0.6, borderSideFraction: 0.6, maxFill: 0.85,
    confirmHits: 3, trackMaxAgeMs: 4000, livenessHoldMs: 8000,
    ear: { closedRatio: 0.72, minOpen: 0.17 }, nonRigid: 0.03,
    faceMinWidth: 56, faceMinScore: 0.55, maxYaw: 0.45, minSharp: 25, lumaMin: 35, lumaMax: 235,
    match: 0.5, unknown: 0.62, margin: 0.04,
    maskMouthContrastNoMask: 7, maskMouthContrastMask: 4, maskDeltaE: 12, noMaskDeltaE: 14,
    graphicPalette: 0.85, graphicFlat: 0.6
  };

  /* ---------------- geometry ---------------- */
  const area = b => Math.max(0, b[2]) * Math.max(0, b[3]);
  function intersection(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  }
  function iou(a, b) {
    const i = intersection(a, b), u = area(a) + area(b) - i;
    return u > 0 ? i / u : 0;
  }
  function containment(inner, outer) {
    const a = area(inner);
    return a > 0 ? intersection(inner, outer) / a : 0;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------- screen / photo context ---------------- */
  // Returns the picture-bearing detection that contains `det`, if any.
  function screenContext(det, all) {
    let best = null;
    for (const other of all) {
      if (other === det || !SCREEN_CLASSES.has(other.class) || other.score < 0.35) continue;
      if (SCREEN_CLASSES.has(det.class)) continue;
      if (area(other.bbox) < area(det.bbox) * 1.05) continue;
      const c = containment(det.bbox, other.bbox);
      if (c >= T.screenContainment && (!best || c > best.containment)) best = { cls: other.class, containment: c };
    }
    return best;
  }

  /* ---------------- pixel statistics (RGBA ImageData-like) ---------------- */
  function luma(d, i) { return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }

  // Long, continuous straight edges on all four sides of a box = picture frame / screen bezel.
  function borderScore(img, box) {
    const { data, width: W, height: H } = img;
    const [bx, by, bw, bh] = box;
    const g = (x, y) => luma(data, (clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)) * 4);
    const size = Math.min(bw, bh);
    const offsets = [0.02, 0.05, 0.09, 0.14].map(f => Math.max(2, Math.round(size * f)));
    const N = 24, TH = 22;
    function side(pointAt, normal) {
      let best = 0;
      for (const off of offsets) {
        let hit = 0;
        for (let k = 0; k < N; k++) {
          const p = pointAt((k + 0.5) / N, off);
          const a = g(p[0] - normal[0], p[1] - normal[1]), b = g(p[0] + normal[0], p[1] + normal[1]);
          if (Math.abs(a - b) >= TH) hit++;
        }
        best = Math.max(best, hit / N);
      }
      return best;
    }
    const sides = [
      side((t, o) => [bx + t * bw, by - o], [0, 1.5]),
      side((t, o) => [bx + bw + o, by + t * bh], [1.5, 0]),
      side((t, o) => [bx + t * bw, by + bh + o], [0, 1.5]),
      side((t, o) => [bx - o, by + t * bh], [1.5, 0])
    ];
    const passing = sides.filter(s => s >= T.borderSideFraction).length;
    return { sides, passing, all: passing === 4 };
  }

  // Flat-colour / noise-free content is typical of drawings, renders and UI graphics.
  function graphicScore(img, box) {
    const { data, width: W, height: H } = img;
    const x0 = clamp(Math.floor(box[0]), 0, W - 1), y0 = clamp(Math.floor(box[1]), 0, H - 1);
    const x1 = clamp(Math.ceil(box[0] + box[2]), x0 + 1, W), y1 = clamp(Math.ceil(box[1] + box[3]), y0 + 1, H);
    const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 64));
    const bins = new Map();
    let total = 0, flat = 0, patches = 0;
    for (let y = y0; y < y1 - step; y += step) {
      for (let x = x0; x < x1 - step; x += step) {
        const i = (y * W + x) * 4;
        const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
        bins.set(key, (bins.get(key) || 0) + 1);
        total++;
        const j = (y * W + x + step) * 4, k = ((y + step) * W + x) * 4;
        const d = Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]) +
          Math.abs(data[i] - data[k]) + Math.abs(data[i + 1] - data[k + 1]) + Math.abs(data[i + 2] - data[k + 2]);
        patches++;
        if (d <= 2) flat++;
      }
    }
    if (!total) return { palette: 0, flat: 0, high: false };
    const top = [...bins.values()].sort((a, b) => b - a).slice(0, 8).reduce((s, v) => s + v, 0) / total;
    const flatShare = patches ? flat / patches : 0;
    return { palette: top, flat: flatShare, high: top >= T.graphicPalette && flatShare >= T.graphicFlat };
  }

  /* ---------------- tracker ---------------- */
  class Tracker {
    constructor(maxAgeMs = T.trackMaxAgeMs, minIou = 0.25) { this.tracks = []; this.nextId = 1; this.maxAge = maxAgeMs; this.minIou = minIou; }
    update(dets, now, keyOf = d => d.class) {
      const used = new Set();
      for (const det of dets) {
        let best = null, bestIou = this.minIou;
        for (const t of this.tracks) {
          if (used.has(t) || t.key !== keyOf(det)) continue;
          const v = iou(t.bbox, det.bbox);
          if (v > bestIou) { best = t; bestIou = v; }
        }
        if (!best) {
          best = { id: this.nextId++, key: keyOf(det), firstSeen: now, hits: 0, misses: 0, history: [], data: {} };
          this.tracks.push(best);
        }
        used.add(best);
        best.bbox = det.bbox; best.lastSeen = now; best.hits++; best.det = det;
        det.track = best;
      }
      const dropped = this.tracks.filter(t => now - t.lastSeen > this.maxAge);
      this.tracks = this.tracks.filter(t => now - t.lastSeen <= this.maxAge);
      return dropped;
    }
  }

  /* ---------------- object verdicts (people are decided by the face/liveness path) ---------------- */
  function objectVerdict(det, ctx) {
    const cls = det.class, tr = det.track;
    const isVehicle = VEHICLE_CLASSES.has(cls), isPerson = cls === "person";
    const minScore = isPerson ? T.personScore : isVehicle ? T.vehicleScore : T.objectScore;
    if (det.score < minScore) return null; // below threshold: not reported at all (avoids false positives)
    const reasons = [];
    const screen = ctx.screen;
    if (screen) {
      tr && (tr.data.screenHits = (tr.data.screenHits || 0) + 1);
      reasons.push("inside " + screen.cls);
      return { status: STATUS.PHOTO, reasons, cue: true };
    }
    const b = ctx.border, g = ctx.graphic;
    if (g && g.high && (b && b.all)) return { status: STATUS.VIRTUAL, reasons: ["flat graphic content with frame"], cue: true };
    if (g && g.high) return { status: STATUS.UNVERIFIED, reasons: ["flat graphic content"], cue: true };
    if (b && b.all) return { status: STATUS.UNVERIFIED, reasons: ["picture-frame edges"], cue: true };
    const fill = ctx.frameArea ? area(det.bbox) / ctx.frameArea : 0;
    if (fill > T.maxFill) return { status: STATUS.UNVERIFIED, reasons: ["fills the whole frame"] };
    if (isPerson) {
      return ctx.liveFace
        ? { status: STATUS.LIVE_HUMAN, reasons: ["live face evidence"] }
        : { status: STATUS.UNVERIFIED, reasons: ["no live face evidence"] };
    }
    const stable = tr && tr.hits >= T.confirmHits && ctx.now - tr.firstSeen >= 1500;
    if (!stable) return { status: STATUS.UNVERIFIED, reasons: ["confirming over several frames"] };
    return { status: isVehicle ? STATUS.LIVE_VEHICLE : STATUS.REAL_OBJECT, reasons: ["stable, no picture cues"] };
  }

  /* ---------------- liveness (face landmarks) ---------------- */
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  function ear(pts, a, b, c, d, e, f) { // eye aspect ratio from six landmark indices
    const h = dist(pts[a], pts[d]);
    return h > 0 ? (dist(pts[b], pts[f]) + dist(pts[c], pts[e])) / (2 * h) : 0;
  }
  const eyeAspect = pts => (ear(pts, 36, 37, 38, 39, 40, 41) + ear(pts, 42, 43, 44, 45, 46, 47)) / 2;
  const mouthAspect = pts => { const w = dist(pts[48], pts[54]); return w > 0 ? dist(pts[51], pts[57]) / w : 0; };

  // Similarity-Procrustes residual between two landmark sets (rigid motion removed).
  function shapeResidual(a, b) {
    const n = a.length;
    const ca = [0, 0], cb = [0, 0];
    for (let i = 0; i < n; i++) { ca[0] += a[i][0] / n; ca[1] += a[i][1] / n; cb[0] += b[i][0] / n; cb[1] += b[i][1] / n; }
    let na = 0, nb = 0;
    const A = a.map(p => [p[0] - ca[0], p[1] - ca[1]]), B = b.map(p => [p[0] - cb[0], p[1] - cb[1]]);
    A.forEach(p => { na += p[0] * p[0] + p[1] * p[1]; }); B.forEach(p => { nb += p[0] * p[0] + p[1] * p[1]; });
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    if (!na || !nb) return 0;
    let dot = 0, crs = 0;
    for (let i = 0; i < n; i++) {
      const ax = A[i][0] / na, ay = A[i][1] / na, bx = B[i][0] / nb, by = B[i][1] / nb;
      dot += ax * bx + ay * by; crs += bx * ay - by * ax;
    }
    const th = Math.atan2(crs, dot), c = Math.cos(th), s = Math.sin(th);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const ax = A[i][0] / na, ay = A[i][1] / na, bx = B[i][0] / nb, by = B[i][1] / nb;
      const rx = c * bx - s * by, ry = s * bx + c * by;
      sum += (ax - rx) * (ax - rx) + (ay - ry) * (ay - ry);
    }
    return Math.sqrt(sum / n);
  }

  class Liveness {
    constructor() { this.eyes = []; this.prev = null; this.nonRigidRun = 0; this.evidenceAt = 0; this.evidence = { blinks: 0, mouth: 0, nonRigid: 0 }; this.closed = false; this.mouthOpen = false; }
    update(pts, now) {
      const e = eyeAspect(pts), m = mouthAspect(pts);
      this.eyes.push(e); if (this.eyes.length > 90) this.eyes.shift();
      const sorted = [...this.eyes].sort((x, y) => x - y);
      const base = sorted[Math.floor(sorted.length * 0.75)] || e; // typical open-eye level
      if (this.eyes.length >= 6 && base >= T.ear.minOpen) {
        const isClosed = e < base * T.ear.closedRatio;
        if (this.closed && !isClosed) { this.evidence.blinks++; this.evidenceAt = now; }
        this.closed = isClosed;
      }
      const open = m > 0.35;
      if (this.mouthOpen && !open) { this.evidence.mouth++; this.evidenceAt = now; }
      this.mouthOpen = open;
      if (this.prev) {
        const r = shapeResidual(this.prev, pts);
        this.nonRigidRun = r >= T.nonRigid ? this.nonRigidRun + 1 : 0;
        if (this.nonRigidRun >= 3) { this.evidence.nonRigid++; this.evidenceAt = now; this.nonRigidRun = 0; }
      }
      this.prev = pts;
    }
    verified(now) { return this.evidenceAt > 0 && now - this.evidenceAt <= T.livenessHoldMs; }
  }

  /* ---------------- face clarity & mask ---------------- */
  function faceClarity(face, img) {
    const reasons = [];
    const [, , w, h] = face.bbox;
    if (w < T.faceMinWidth) reasons.push("too small");
    if (face.score < T.faceMinScore) reasons.push("low detector score");
    const p = face.points;
    if (p) {
      const eyeL = [(p[36][0] + p[39][0]) / 2, (p[36][1] + p[39][1]) / 2], eyeR = [(p[42][0] + p[45][0]) / 2, (p[42][1] + p[45][1]) / 2];
      const iod = dist(eyeL, eyeR), mid = (eyeL[0] + eyeR[0]) / 2;
      if (iod <= 0 || Math.abs(p[30][0] - mid) / iod > T.maxYaw) reasons.push("not facing camera");
    }
    if (img) {
      const s = sharpAndLight(img, face.bbox);
      if (s.sharp < T.minSharp) reasons.push("blurred");
      if (s.luma < T.lumaMin) reasons.push("too dark");
      if (s.luma > T.lumaMax) reasons.push("overexposed");
    }
    return { clear: reasons.length === 0, reasons };
  }
  function sharpAndLight(img, box) {
    const { data, width: W, height: H } = img;
    const x0 = clamp(Math.floor(box[0]), 1, W - 2), y0 = clamp(Math.floor(box[1]), 1, H - 2);
    const x1 = clamp(Math.ceil(box[0] + box[2]), x0 + 2, W - 1), y1 = clamp(Math.ceil(box[1] + box[3]), y0 + 2, H - 1);
    const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 48));
    let n = 0, sum = 0, lsum = 0, lsq = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const c = luma(data, (y * W + x) * 4);
      const lap = 4 * c - luma(data, (y * W + x - 1) * 4) - luma(data, (y * W + x + 1) * 4) - luma(data, ((y - 1) * W + x) * 4) - luma(data, ((y + 1) * W + x) * 4);
      sum += lap; lsum += lap * lap; lsq += c; n++;
    }
    if (!n) return { sharp: 0, luma: 0 };
    return { sharp: lsum / n - (sum / n) ** 2, luma: lsq / n }; // Laplacian variance, mean luma
  }

  function rgb2lab(r, g, b) {
    const f = v => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
    const R = f(r), G = f(g), B = f(b);
    const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const h = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))];
  }
  function patchLab(img, cx, cy, half) {
    const { data, width: W, height: H } = img;
    const x0 = clamp(Math.round(cx - half), 0, W - 1), x1 = clamp(Math.round(cx + half), x0 + 1, W);
    const y0 = clamp(Math.round(cy - half), 0, H - 1), y1 = clamp(Math.round(cy + half), y0 + 1, H);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    return n ? rgb2lab(r / n, g / n, b / n) : [0, 0, 0];
  }
  const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // Mask vs. no mask from landmark-anchored colour/texture statistics.
  function maskAnalysis(img, pts) {
    const eyeL = [(pts[36][0] + pts[39][0]) / 2, (pts[36][1] + pts[39][1]) / 2], eyeR = [(pts[42][0] + pts[45][0]) / 2, (pts[42][1] + pts[45][1]) / 2];
    const iod = dist(eyeL, eyeR);
    if (!(iod > 8)) return { state: "UNCLEAR", confidence: 0, features: {} };
    const half = Math.max(2, iod * 0.09);
    const brow = [(pts[19][0] + pts[24][0]) / 2, (pts[19][1] + pts[24][1]) / 2];
    const upper = [
      patchLab(img, brow[0], brow[1] - iod * 0.28, half),
      patchLab(img, pts[40][0], pts[40][1] + iod * 0.28, half),
      patchLab(img, pts[47][0], pts[47][1] + iod * 0.28, half)
    ];
    const skin = [0, 1, 2].map(i => (upper[0][i] + upper[1][i] + upper[2][i]) / 3);
    const lowerPts = [
      [(pts[33][0] + pts[51][0]) / 2, (pts[33][1] + pts[51][1]) / 2],
      [(pts[4][0] + pts[48][0]) / 2, (pts[4][1] + pts[48][1]) / 2],
      [(pts[12][0] + pts[54][0]) / 2, (pts[12][1] + pts[54][1]) / 2],
      [(pts[57][0] + pts[8][0]) / 2, (pts[57][1] + pts[8][1]) / 2]
    ];
    const lower = lowerPts.map(p => patchLab(img, p[0], p[1], half));
    const meanDE = lower.reduce((s, l) => s + dE(skin, l), 0) / lower.length;
    // lip colour contrast: spread of a* over the mouth box
    const xs = pts.slice(48, 60).map(p => p[0]), ys = pts.slice(48, 60).map(p => p[1]);
    const mx0 = Math.min(...xs), mx1 = Math.max(...xs), my0 = Math.min(...ys), my1 = Math.max(...ys);
    const aVals = [];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 9; gx++) {
      aVals.push(patchLab(img, mx0 + (mx1 - mx0) * (gx + 0.5) / 9, my0 + (my1 - my0) * (gy + 0.5) / 5, Math.max(1, iod * 0.03))[1]);
    }
    aVals.sort((p, q) => p - q);
    const contrast = aVals[Math.floor(aVals.length * 0.9)] - aVals[Math.floor(aVals.length * 0.1)];
    const features = { meanDE, contrast };
    if (contrast >= T.maskMouthContrastNoMask && meanDE <= T.noMaskDeltaE) return { state: "NO_MASK", confidence: clamp(0.55 + (contrast - 7) / 20 + (T.noMaskDeltaE - meanDE) / 60, 0, 0.95), features };
    if (contrast <= T.maskMouthContrastMask && meanDE >= T.maskDeltaE) return { state: "MASK", confidence: clamp(0.55 + (meanDE - 12) / 40 + (4 - contrast) / 16, 0, 0.95), features };
    return { state: "UNCLEAR", confidence: 0.3, features };
  }

  /* ---------------- identity ---------------- */
  function matchIdentity(descriptor, enrolled) {
    if (!enrolled || !enrolled.length) return { state: "UNKNOWN", name: null, distance: null, confidence: 0.6, reason: "no enrolled users" };
    const rows = enrolled.map(e => {
      const samples = Array.isArray(e.descriptors) && e.descriptors.length ? e.descriptors : [e.descriptor];
      let best = Infinity;
      for (const sample of samples) {
        if (!Array.isArray(sample) || sample.length !== descriptor.length) continue;
        let sum = 0;
        for (let i = 0; i < descriptor.length; i++) { const d = descriptor[i] - sample[i]; sum += d * d; }
        best = Math.min(best, Math.sqrt(sum));
      }
      return { e, d: best };
    }).filter(row => Number.isFinite(row.d)).sort((a, b) => a.d - b.d);
    const best = rows[0];
    const other = rows.find(r => r.e.name !== best.e.name); // runner-up must be a different person
    const margin = other ? other.d - best.d : 1;
    if (best.d <= T.match && margin >= T.margin) return { state: "RECOGNIZED", name: best.e.name, id: best.e.id, distance: best.d, confidence: clamp((T.unknown - best.d) / T.unknown, 0, 1) };
    if (best.d >= T.unknown) return { state: "UNKNOWN", name: null, distance: best.d, confidence: clamp(0.5 + (best.d - T.unknown) * 2, 0.5, 0.99) };
    return { state: "UNVERIFIED", name: null, distance: best.d, confidence: 0.4, possible: best.e.name };
  }
  // Majority vote over the last frames so a single noisy descriptor cannot flip identity.
  function smoothIdentity(history) {
    const recent = history.slice(-5);
    if (recent.length < 3) return { state: "UNVERIFIED", confidence: 0 };
    const key = r => r.state + "|" + (r.name || "");
    const counts = new Map();
    recent.forEach(r => counts.set(key(r), (counts.get(key(r)) || 0) + 1));
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < 3) return { state: "UNVERIFIED", confidence: 0 };
    const rows = recent.filter(r => key(r) === top);
    return Object.assign({}, rows[rows.length - 1], { confidence: rows.reduce((s, r) => s + r.confidence, 0) / rows.length });
  }

  /* ---------------- combined face status ---------------- */
  function resolveFace({ clarity, mask, identity, live }) {
    if (!clarity.clear) return { identity: STATUS.NOT_CLEAR, mask: STATUS.NOT_CLEAR, name: null, alerts: [], reasons: clarity.reasons };
    const maskStatus = mask.state === "MASK" ? STATUS.MASK : mask.state === "NO_MASK" ? STATUS.NO_MASK : STATUS.NOT_CLEAR;
    let idStatus = STATUS.UNVERIFIED, name = null;
    if (live && identity && identity.state === "RECOGNIZED") { idStatus = STATUS.RECOGNIZED; name = identity.name; }
    else if (live && identity && identity.state === "UNKNOWN") idStatus = STATUS.UNKNOWN;
    const alerts = [];
    if (live) {
      if (idStatus === STATUS.UNKNOWN && maskStatus === STATUS.NO_MASK) alerts.push("unknown_no_mask");
      else if (idStatus === STATUS.UNKNOWN) alerts.push("unknown_person");
      else if (idStatus === STATUS.RECOGNIZED && maskStatus === STATUS.NO_MASK) alerts.push("registered_no_mask");
    }
    return { identity: idStatus, mask: maskStatus, name, alerts, reasons: [] };
  }

  /* ---------------- alert de-duplication ---------------- */
  class AlertGate {
    constructor(clearAfterMs = 6000) { this.active = new Map(); this.clearAfter = clearAfterMs; }
    // True only for the first time a (category, track) episode is seen.
    offer(category, trackId, now) {
      const key = category + ":" + trackId;
      const seen = this.active.get(key);
      this.active.set(key, now);
      return seen === undefined || now - seen > this.clearAfter;
    }
    sweep(now) { for (const [k, t] of this.active) if (now - t > this.clearAfter * 4) this.active.delete(k); }
  }

  return {
    STATUS, VEHICLE_CLASSES, SCREEN_CLASSES, DEFAULT_ALERT_OBJECTS, THRESHOLDS: T,
    iou, containment, area, screenContext, borderScore, graphicScore, Tracker, objectVerdict,
    Liveness, shapeResidual, eyeAspect, mouthAspect, faceClarity, sharpAndLight, maskAnalysis,
    matchIdentity, smoothIdentity, resolveFace, AlertGate
  };
});