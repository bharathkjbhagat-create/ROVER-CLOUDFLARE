/* DEFENX software rover simulation core.  SOFTWARE ONLY - this is NOT evidence that physical hardware works.
 * Simulates: ground-truth world, 3 ultrasonic beams, noisy GPS, frontier exploration, obstacle detour, offline journal
 * + idempotent sync, and return-to-base with a stop-and-verify arrival rule.  No DOM, runs in Node and the browser. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DefenxSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const CELL = 0.5, UNK = 0, FREE = 1, OCC = 2;
  const K = {
    cruise: 0.6, turn: 1.6, range: 4.0, frontStop: 0.42, sideStop: 0.28, robotR: 0.2, offlineAfter: 5, autonomyCap: 900,
    gpsHz: 1, gpsFresh: 3, gpsLost: 10, lowBattery: 12, rtbMinBattery: 25, verifyFixes: 3, maxDetours: 8, stuckS: 40,
    batch: 50, persistEvery: 5, maxJournal: 5000, defaultRadius: 2.5
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const hyp = (a, b) => Math.hypot(a, b);
  function rng(seed) {
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    next.gauss = () => { let u = 0, v = 0; while (!u) u = next(); while (!v) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return next;
  }
  /* ---------- geo helpers: local tangent plane, x east / y north in metres ---------- */
  const M_LAT = 111320;
  const toLatLon = (o, x, y) => ({ lat: o.lat + y / M_LAT, lon: o.lon + x / (M_LAT * Math.cos(o.lat * Math.PI / 180)) });
  const fromLatLon = (o, lat, lon) => ({ x: (lon - o.lon) * M_LAT * Math.cos(o.lat * Math.PI / 180), y: (lat - o.lat) * M_LAT });
  const bearingDeg = h => ((90 - h * 180 / Math.PI) % 360 + 360) % 360;

  /* ---------- ground-truth world ---------- */
  class World {
    constructor(w, h) { this.w = w; this.h = h; this.occ = new Uint8Array(w * h); this.blocks = []; }
    isOcc(cx, cy) { return cx < 0 || cy < 0 || cx >= this.w || cy >= this.h || this.occ[cy * this.w + cx] === 1; }
    rect(x0, y0, x1, y1, v) { for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) this.occ[y * this.w + x] = v === 0 ? 0 : 1; }
    occAt(x, y) { return this.isOcc(Math.floor(x / CELL), Math.floor(y / CELL)); }
    collides(x, y, r) {
      for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++) for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
        if (!this.isOcc(cx, cy)) continue;
        const dx = Math.max(cx * CELL - x, 0, x - (cx + 1) * CELL), dy = Math.max(cy * CELL - y, 0, y - (cy + 1) * CELL);
        if (hyp(dx, dy) < r) return true;
      }
      return false;
    }
    ray(x, y, ang, max) { const c = Math.cos(ang), s = Math.sin(ang); for (let d = 0.05; d <= max; d += 0.05) if (this.occAt(x + c * d, y + s * d)) return d; return Infinity; }
    reachable(start) { // cells a rover could reach given 1-cell clearance (ground truth, used only as a metric)
      const blocked = new Uint8Array(this.w * this.h);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.isOcc(x, y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < this.w && ny < this.h) blocked[ny * this.w + nx] = 1; }
      const seen = new Uint8Array(this.w * this.h), q = [Math.floor(start.y / CELL) * this.w + Math.floor(start.x / CELL)]; seen[q[0]] = 1; let n = 0;
      while (q.length) { const i = q.pop(); n++; const cx = i % this.w, cy = (i / this.w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue; const j = ny * this.w + nx; if (!seen[j] && !blocked[j]) { seen[j] = 1; q.push(j); } } }
      return { seen, count: n };
    }
  }
  const SCENARIOS = {
    open_field: { label: "Open field (32 m, scattered obstacles)", w: 64, h: 64 },
    warehouse: { label: "Warehouse (rooms, 3 m doorways)", w: 64, h: 64 },
    corridor: { label: "Corridor (3 m wide, single route - blocked-route tests)", w: 64, h: 40 },
    big_field: { label: "Large field (48 m - long offline run)", w: 96, h: 96 }
  };
  function buildScenario(name, seed) {
    const def = SCENARIOS[name] || SCENARIOS.open_field, r = rng(seed || 1), W = new World(def.w, def.h);
    W.rect(0, 0, def.w - 1, 0); W.rect(0, def.h - 1, def.w - 1, def.h - 1); W.rect(0, 0, 0, def.h - 1); W.rect(def.w - 1, 0, def.w - 1, def.h - 1);
    let start = { x: 3, y: 3 };
    const clearStart = () => W.rect(Math.floor((start.x - 2) / CELL), Math.floor((start.y - 2) / CELL), Math.floor((start.x + 2) / CELL), Math.floor((start.y + 2) / CELL), 0);
    if (name === "warehouse") {
      [20, 42].forEach(cx => { W.rect(cx, 1, cx, def.h - 2); [Math.floor(6 + r() * 14), Math.floor(36 + r() * 18)].forEach(g => W.rect(cx, g, cx, g + 5, 0)); });
      W.rect(1, 32, def.w - 2, 32); [8, 28, 50].forEach(g => W.rect(g, 32, g + 5, 32, 0));
      for (let i = 0; i < 6; i++) { const cx = 3 + Math.floor(r() * 58), cy = 3 + Math.floor(r() * 58); if (cx % 21 > 2 && Math.abs(cy - 32) > 2) W.rect(cx, cy, cx + 2, cy + 1); }
    } else if (name === "corridor") {
      W.rect(1, 1, def.w - 2, def.h - 2, 1); W.rect(2, 2, 14, 16, 0); W.rect(14, 7, 50, 12, 0); W.rect(50, 2, 61, 20, 0);
      W.rect(26, 2, 28, 5); W.rect(38, 14, 40, 17); // unreachable decor is solid anyway
    } else {
      const n = name === "big_field" ? 46 : 16, lim = def.w - 6;
      for (let i = 0; i < n; i++) { const cx = 4 + Math.floor(r() * lim), cy = 4 + Math.floor(r() * lim), w = 2 + Math.floor(r() * 5), h = 2 + Math.floor(r() * 5); W.rect(cx, cy, cx + w, cy + h); }
    }
    if (name === "corridor") start = { x: 4, y: 5 };
    clearStart();
    return { world: W, start, name: SCENARIOS[name] ? name : "open_field", label: def.label };
  }

  /* ---------- storage + simulated cloud ---------- */
  class MemoryStore { constructor() { this.m = new Map(); } get(k) { return this.m.has(k) ? this.m.get(k) : null; } set(k, v) { this.m.set(k, v); } }
  const EV_ID = /^[A-Za-z0-9._:-]{6,64}$/, EV_TYPE = /^[a-z0-9_]{2,32}$/;
  class SimCloud { // SIMULATED cloud endpoint with the same dedupe/validation contract as /api/fleet/events/upload
    constructor() { this.events = new Map(); this.mode = "ok"; this.stats = { batches: 0, accepted: 0, duplicates: 0, rejected: 0, ackLost: 0 }; }
    upload(batch) {
      this.stats.batches++;
      if (this.mode === "reject") { this.stats.rejected++; throw new Error("SERVER_REJECTED"); }
      if (!Array.isArray(batch) || !batch.length || batch.length > K.batch) throw new Error("BAD_BATCH");
      for (const e of batch) if (!EV_ID.test(String(e.id)) || !EV_TYPE.test(String(e.type))) throw new Error("INVALID_EVENT");
      for (const e of batch) { if (this.events.has(e.id)) this.stats.duplicates++; else { this.events.set(e.id, e); this.stats.accepted++; } }
      if (this.mode === "lose_ack") { this.stats.ackLost++; throw new Error("ACK_LOST"); }
      return { stored_ids: batch.map(e => e.id) };
    }
  }

  /* ---------- the simulated rover ---------- */
  class RoverSim {
    constructor(opts) {
      const o = this.o = Object.assign({ id: "ROVER-SIM", scenario: "open_field", seed: 1, store: null, epoch: null, origin: { lat: 13.0, lon: 77.6 }, gpsSigma: 0.3, cloud: null, autoRtbOnLinkLoss: false, restore: true }, opts || {});
      const sc = buildScenario(o.scenario, o.seed); this.world = sc.world; this.scenario = sc.name; this.label = sc.label;
      this.w = this.world.w; this.h = this.world.h; const N = this.w * this.h;
      this.rnd = rng((o.seed || 1) * 7919 + 13); this.t = 0; this.epoch0 = o.epoch != null ? o.epoch : Date.now() / 1000; this.boot = Math.floor(this.rnd() * 36 ** 4).toString(36).padStart(4, "0") + Math.floor(Date.now() % 36 ** 2).toString(36);
      this.truth = { x: sc.start.x, y: sc.start.y, h: Math.PI / 2 }; this.est = { x: sc.start.x, y: sc.start.y }; this.start = Object.assign({}, sc.start);
      this.known = new Uint8Array(N); this.pass = new Uint8Array(N); this.dirty = true; this.black = new Set();
      this.dist = new Float64Array(N); this.prev = new Int32Array(N);
      this.state = "IDLE"; this.reason = ""; this.mode = null; this.prevMode = null; this.path = []; this.target = null; this.arrived = false;
      this.cmd = { v: 0, w: 0 }; this.speed = 0; this.battery = 100; this.faults = { gps: false, front: false, left: false, right: false };
      this.link = true; this.net = "ONLINE"; this.linkDown = 0; this.linkUp = 0; this.offlineSince = null;
      this.gps = { fix: false, x: 0, y: 0, acc: 0, seq: 0, t: -99 }; this.gpsTimer = 0; this.fixes = 0;
      this.sens = { front: { m: K.range, valid: true }, left: { m: K.range, valid: true }, right: { m: K.range, valid: true } };
      this.base = { x: sc.start.x, y: sc.start.y, radius: K.defaultRadius }; this.rtb = null; this.verify = 0; this.verifySeq = -1; this.detours = 0; this.rtbInit = 0;
      this.scanA = 0; this.events = []; this.seq = 0; this.dropped = 0; this.clusters = []; this.lastReplanT = -99; this.lastAreaCount = 0;
      this.nextSync = 0; this.syncFail = 0; this.persistT = 0; this.gpsResumes = 0; this.stuckPos = { x: sc.start.x, y: sc.start.y, t: 0 }; this.lastLinkEvt = null;
      this.stats = { collisions: 0, distance: 0, replans: 0, scans: 0, ticks: 0 }; this.listeners = [];
      this.truthReach = this.world.reachable(this.start); this._markFootprint();
      if (o.store && o.restore) this._restore();
      this._refresh();
    }
    key(s) { return "defenx-sim:" + this.o.id + ":" + s; }
    on(fn) { this.listeners.push(fn); }
    /* ----- events + journal ----- */
    _event(type, severity, message, data) {
      const ev = { id: this.o.id + "-" + this.boot + "-" + String(++this.seq).padStart(6, "0"), type, severity: severity || "info", t: Math.round((this.epoch0 + this.t) * 1000) / 1000, message: String(message).slice(0, 200), offline: this.net === "OFFLINE", acked: false };
      if (data) ev.data = data;
      this.events.push(ev);
      if (this.events.length > K.maxJournal) { const i = this.events.findIndex(e => !e.acked && e.severity === "info"); if (i >= 0) { this.events.splice(i, 1); this.dropped++; } }
      this._saveJournal(); this.listeners.forEach(f => { try { f(ev); } catch (_) { } });
      return ev;
    }
    pending() { return this.events.filter(e => !e.acked); }
    _saveJournal() { const s = this.o.store; if (!s) return; try { s.set(this.key("journal"), JSON.stringify({ v: 1, seq: this.seq, dropped: this.dropped, events: this.events })); } catch (_) { } }
    _saveWorld() {
      const s = this.o.store; if (!s) return;
      try {
        s.set(this.key("map"), JSON.stringify({ v: 1, scenario: this.scenario, seed: this.o.seed, known: Array.from(this.known).join(""), black: Array.from(this.black),
          truth: this.truth, est: this.est, battery: this.battery, base: this.base, blocks: this.world.blocks, stats: this.stats, t: this.t }));
      } catch (_) { }
    }
    _restore() {
      const s = this.o.store;
      try {
        const j = JSON.parse(s.get(this.key("journal")) || "null");
        if (j && Array.isArray(j.events)) { this.events = j.events; this.seq = Math.max(j.seq | 0, 0); this.dropped = j.dropped | 0; }
        const m = JSON.parse(s.get(this.key("map")) || "null");
        if (m && m.scenario === this.scenario && m.seed === this.o.seed && typeof m.known === "string" && m.known.length === this.known.length) {
          for (let i = 0; i < m.known.length; i++) this.known[i] = m.known.charCodeAt(i) - 48;
          this.black = new Set(m.black || []); this.truth = m.truth; this.est = m.est; this.battery = m.battery; this.base = m.base; this.stats = Object.assign(this.stats, m.stats || {}); this.t = m.t || 0;
          (m.blocks || []).forEach(b => this._addBlock(b[0], b[1], b[2], b[3], true));
          this.restored = true; this.dirty = true; this.lastAreaCount = this._knownFree();
        }
      } catch (_) { }
    }
    /* ----- known map ----- */
    _cell(x, y) { return Math.floor(y / CELL) * this.w + Math.floor(x / CELL); }
    _markFootprint() { const cx = Math.floor(this.est.x / CELL), cy = Math.floor(this.est.y / CELL); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < this.w && y < this.h && this.known[y * this.w + x] === UNK) { this.known[y * this.w + x] = FREE; } } }
    _refresh() {
      if (!this.dirty) return; this.dirty = false; const { w, h, known, pass } = this; pass.fill(0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; if (known[i] !== FREE) continue; let ok = true;
        for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h || known[ny * w + nx] === OCC) { ok = false; break; } }
        pass[i] = ok ? 1 : 0;
      }
    }
    _knownFree() { let n = 0; for (let i = 0; i < this.known.length; i++) if (this.known[i] === FREE) n++; return n; }
    exploredPct() { let n = 0; const s = this.truthReach.seen; for (let i = 0; i < s.length; i++) if (s[i] && this.known[i] === FREE) n++; return this.truthReach.count ? Math.min(100, 100 * n / this.truthReach.count) : 0; }
    _isFrontier(i) {
      if (this.known[i] !== FREE || !this.pass[i] || this.black.has(i)) return false; const { w, h } = this, x = i % w, y = (i / w) | 0;
      return (x > 0 && this.known[i - 1] === UNK) || (x < w - 1 && this.known[i + 1] === UNK) || (y > 0 && this.known[i - w] === UNK) || (y < h - 1 && this.known[i + w] === UNK);
    }
    _plan(isGoal, extra) { // Dijkstra over known, clearance-inflated free cells; start cell is always allowed
      this._refresh(); const { w, h, dist, prev, pass } = this, N = w * h, s = this._cell(this.est.x, this.est.y);
      if (s < 0 || s >= N) return null; if (isGoal(s)) return [s];
      dist.fill(Infinity); prev.fill(-1); dist[s] = 0; const hp = [[0, s]];
      const push = it => { hp.push(it); let c = hp.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (hp[p][0] <= hp[c][0]) break; [hp[p], hp[c]] = [hp[c], hp[p]]; c = p; } };
      const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let c = 0; for (; ;) { let l = 2 * c + 1, r = l + 1, m = c; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === c) break;[hp[m], hp[c]] = [hp[c], hp[m]]; c = m; } } return top; };
      const ok = j => pass[j] === 1 || j === extra;
      while (hp.length) {
        const [d, i] = pop(); if (d > dist[i]) continue;
        if (i !== s && isGoal(i)) { const p = []; for (let c = i; c !== -1; c = prev[c]) p.push(c); return p.reverse(); }
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!ok(j)) continue;
          if (dx && dy && !(ok(y * w + nx) && ok(ny * w + x))) continue; // no corner cutting
          const nd = d + (dx && dy ? 1.4142 : 1); if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push([nd, j]); }
        }
      }
      return null;
    }
    _cellXY(i) { return { x: (i % this.w + 0.5) * CELL, y: (Math.floor(i / this.w) + 0.5) * CELL }; }
    pathLength(from) {
      let a = from || this.est, len = 0; for (const i of this.path) { const p = this._cellXY(i); len += hyp(p.x - a.x, p.y - a.y); a = p; } return len;
    }
    /* ----- environment: link, faults, injected blocks ----- */
    setLink(up) { this.link = !!up; }
    setFault(name, on) { if (name in this.faults) this.faults[name] = !!on; }
    setBattery(p) { this.battery = clamp(Number(p) || 0, 0, 100); }
    _addBlock(x0, y0, x1, y1, silent) { this.world.rect(x0, y0, x1, y1); if (!silent) this.world.blocks.push([x0, y0, x1, y1]); }
    blockAhead(distance, span) { // drop a wall across the rover's current heading/path (a "route blocked" fault)
      let a = this.truth.h; if (this.path.length > 1) { const p = this._cellXY(this.path[Math.min(this.path.length - 1, 3)]); a = Math.atan2(p.y - this.truth.y, p.x - this.truth.x); }
      const d = Math.max(1.5, distance || 3), half = Math.max(0.5, (span || 3) / 2), cx = this.truth.x + Math.cos(a) * d, cy = this.truth.y + Math.sin(a) * d, nx = -Math.sin(a), ny = Math.cos(a);
      let placed = 0; for (let s = -half; s <= half; s += CELL / 2) for (let t = 0; t < CELL; t += CELL / 2) { const x = cx + nx * s + Math.cos(a) * t, y = cy + ny * s + Math.sin(a) * t; if (hyp(x - this.truth.x, y - this.truth.y) < 1.0) continue; const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); if (!this.world.isOcc(gx, gy)) { this._addBlock(gx, gy, gx, gy); placed++; } }
      return { ok: placed > 0, cells: placed };
    }
    /* ----- operator / autonomy commands ----- */
    startExploration() {
      if (this.state === "ESTOP") return { ok: false, reason: "ESTOP_ACTIVE" }; if (this.battery <= K.lowBattery) return { ok: false, reason: "LOW_BATTERY" };
      this.mode = "EXPLORE"; this.state = "EXPLORE_PICK"; this.reason = ""; this.arrived = false; this.rtb = null; this.path = []; this.black.clear();
      this._event("explore_started", "info", "Autonomous exploration started", { explored_pct: Math.round(this.exploredPct()) }); return { ok: true };
    }
    stop() { if (this.state === "ESTOP") return { ok: false, reason: "ESTOP_ACTIVE" }; this._halt("IDLE", ""); this._event("operator_stop", "info", "Operator stop"); return { ok: true }; }
    estop() { this.state = "ESTOP"; this.mode = null; this.path = []; this.cmd = { v: 0, w: 0 }; this.speed = 0; this.rtb = null; this._event("estop", "critical", "Emergency stop latched"); return { ok: true }; }
    resetEstop() { if (this.state !== "ESTOP") return { ok: false, reason: "NOT_IN_ESTOP" }; if (!this._sensorsOk()) return { ok: false, reason: "SENSOR_FAULT" }; this.state = "IDLE"; this._event("estop_reset", "info", "E-stop cleared (rover idle)"); return { ok: true }; }
    _halt(state, reason) { this.state = state; this.reason = reason || ""; this.speed = 0; this.mode = state === "IDLE" ? null : this.mode; this.path = []; this.cmd = { v: 0, w: 0 }; if (state === "IDLE") this.rtb = null; }
    _safeStop(reason, msg) {
      if (this.state === "SAFE_STOP" || this.state === "ESTOP") return;
      this.prevMode = this.mode; this._halt("SAFE_STOP", reason); this.path = [];
      this._event("safe_stop", "warn", msg || "Safe stop: " + reason, { reason, mode: this.prevMode });
      if (this.rtb) this.rtb = Object.assign(this.rtb, { state: "FAILED", reason });
    }
    resume() {
      if (this.state !== "SAFE_STOP") return { ok: false, reason: "NOT_STOPPED" };
      if (!this._sensorsOk()) return { ok: false, reason: "SENSOR_FAULT" }; if (!this._gpsOk()) return { ok: false, reason: "GPS_UNAVAILABLE" }; if (this.battery <= K.lowBattery) return { ok: false, reason: "LOW_BATTERY" };
      if (this.reason === "AUTONOMY_LIMIT" && this.net !== "ONLINE") return { ok: false, reason: "AUTONOMY_LIMIT_NEEDS_LINK" };
      const was = this.prevMode; this.reason = "";
      if (was === "RTB") return this.requestRTB({ via: "local" }); return this.startExploration();
    }
    setBase(x, y, radius) {
      if (![x, y].every(Number.isFinite)) return { ok: false, reason: "INVALID_POINT" };
      const r = radius == null ? this.base.radius : Number(radius); if (!(r >= 1 && r <= 20)) return { ok: false, reason: "RADIUS_OUT_OF_RANGE" };
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL); if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return { ok: false, reason: "OUTSIDE_WORLD" };
      if (this.known[cy * this.w + cx] !== FREE) return { ok: false, reason: "BASE_NOT_IN_MAPPED_FREE_SPACE" };
      this.base = { x, y, radius: r }; this._saveWorld(); this._event("base_set", "info", "Base set", { x: +x.toFixed(2), y: +y.toFixed(2), radius_m: r }); return { ok: true };
    }
    setRadius(radius) { // changing only the arrival radius never re-validates the base location
      const r = Number(radius); if (!(r >= 1 && r <= 20)) return { ok: false, reason: "RADIUS_OUT_OF_RANGE" };
      this.base = Object.assign({}, this.base, { radius: r }); this._saveWorld(); this._event("base_set", "info", "Arrival radius changed", { radius_m: r }); return { ok: true };
    }
    requestRTB(opt) {
      const via = (opt && opt.via) || "cloud", fail = (reason, msg) => { this._event("rtb_failed", "warn", msg || "Return to base refused: " + reason, { reason, via }); return { ok: false, reason }; };
      if (via === "cloud" && (!this.link || this.net !== "ONLINE")) return { ok: false, reason: "ROVER_UNREACHABLE" }; // fail closed: nothing was sent
      if (this.state === "ESTOP") return fail("ESTOP_ACTIVE"); if (!this._gpsOk()) return fail("GPS_UNAVAILABLE"); if (!this._sensorsOk()) return fail("SENSOR_FAULT");
      if (this.battery < K.rtbMinBattery) return fail("BATTERY_TOO_LOW"); const g = this._cell(this.base.x, this.base.y);
      if (this.known[g] !== FREE) return fail("BASE_NOT_IN_MAPPED_FREE_SPACE");
      const p = this._planToBase(); if (!p) return fail("NO_SAFE_ROUTE", "No safe route to base on the known map");
      this.mode = "RTB"; this.state = "RTB_NAVIGATE"; this.reason = ""; this.arrived = false; this.verify = 0; this.detours = 0; this.path = p; this.rtbInit = this.pathLength();
      this.rtb = { state: "NAVIGATING", reason: "", via }; this.stuckPos = { x: this.est.x, y: this.est.y, t: this.t };
      this._event("rtb_started", "info", "Return to base started", { via, route_m: +this.rtbInit.toFixed(1), radius_m: this.base.radius }); return { ok: true };
    }
    cancelRTB() { if (this.mode !== "RTB") return { ok: false, reason: "NOT_RETURNING" }; this._halt("IDLE", ""); this._event("rtb_cancelled", "info", "Return to base cancelled"); return { ok: true }; }
    /* ----- sensing ----- */
    _sensorsOk() { return !this.faults.front && !this.faults.left && !this.faults.right; }
    _gpsOk() { return this.gps.fix && this.t - this.gps.t <= K.gpsFresh; }
    _sense(dt) {
      const names = { front: 0, left: Math.PI / 4, right: -Math.PI / 4 }, beam = [-0.09, 0, 0.09], R = K.range;
      for (const n in names) {
        if (this.faults[n]) { this.sens[n] = { m: NaN, valid: false }; continue; }
        let min = Infinity;
        for (const b of beam) {
          const a = this.truth.h + names[n] + b, d = this.world.ray(this.truth.x, this.truth.y, a, R); if (d < min) min = d;
          const c = Math.cos(a), s = Math.sin(a), free = Math.min(d, R) - 0.12;
          for (let u = 0.2; u < free; u += 0.25) { const i = this._cell(this.est.x + c * u, this.est.y + s * u); if (i >= 0 && i < this.known.length && this.known[i] === UNK) this.known[i] = FREE; }
          if (d <= R) {
            const hx = this.est.x + c * (d + 0.03), hy = this.est.y + s * (d + 0.03), cx = Math.floor(hx / CELL), cy = Math.floor(hy / CELL);
            if (cx >= 0 && cy >= 0 && cx < this.w && cy < this.h && hyp(hx - this.est.x, hy - this.est.y) > 0.3) {
              const i = cy * this.w + cx; if (this.known[i] !== OCC) { this.known[i] = OCC; this.dirty = true; this._noteObstacle(hx, hy, d); }
            }
          }
        }
        this.sens[n] = { m: min === Infinity ? R : Math.max(0.05, min + this.rnd.gauss() * 0.02), valid: true };
      }
      this.dirty = true; this._markFootprint();
    }
    _noteObstacle(x, y, d) {
      if (d > 1.6 || (Math.abs(this.speed) < 0.05 && this.state.indexOf("SCAN") >= 0)) return;
      if (this.clusters.some(c => hyp(c.x - x, c.y - y) < 1.5)) return; this.clusters.push({ x, y });
      const ll = toLatLon(this.o.origin, x, y); this._event("obstacle_detected", "warn", "Obstacle detected " + d.toFixed(1) + " m ahead", { x: +x.toFixed(2), y: +y.toFixed(2), range_m: +d.toFixed(2), lat: ll.lat, lon: ll.lon });
    }
    _gpsTick(dt) {
      this.gpsTimer += dt; if (this.gpsTimer < 1 / K.gpsHz - 1e-9) return; this.gpsTimer = 0;
      if (this.faults.gps) { if (this.gps.fix && this.t - this.gps.t > K.gpsFresh) { this.gps.fix = false; this._event("gps_lost", "warn", "GPS fix lost", { age_s: +(this.t - this.gps.t).toFixed(1) }); } return; }
      const sg = this.o.gpsSigma, ex = clamp(this.rnd.gauss(), -3, 3) * sg, ey = clamp(this.rnd.gauss(), -3, 3) * sg;
      const was = this.gps.fix || this.fixes === 0; this.gps = { fix: true, x: this.truth.x + ex, y: this.truth.y + ey, acc: +(sg * 2.5).toFixed(2), seq: ++this.fixes, t: this.t };
      if (this.fixes === 1) { this.est = { x: this.gps.x, y: this.gps.y }; } else { this.est.x += 0.25 * (this.gps.x - this.est.x); this.est.y += 0.25 * (this.gps.y - this.est.y); }
      if (!was) this._event("gps_recovered", "info", "GPS fix recovered");
    }
    _linkTick(dt) {
      if (!this.link) { this.linkUp = 0; if (this.net === "ONLINE") { this.linkDown += dt; if (this.linkDown >= K.offlineAfter) { this.net = "OFFLINE"; this.offlineSince = this.t - this.linkDown; this._event("link_lost", "warn", "Server unreachable - offline autonomy active", { offline_since_s: +this.offlineSince.toFixed(1) }); } } }
      else { this.linkDown = 0; if (this.net === "OFFLINE") { this.linkUp += dt; if (this.linkUp >= 1) { this.net = "ONLINE"; const off = this.t - this.offlineSince; this.offlineSince = null; this.nextSync = this.t; this.syncFail = 0; this._event("link_restored", "info", "Link restored - syncing stored events", { offline_s: +off.toFixed(1), queued: this.pending().length }); } } }
    }
    offlineSeconds() { return this.net === "OFFLINE" && this.offlineSince != null ? this.t - this.offlineSince : 0; }
    /* ----- sync (idempotent: an event leaves the queue only when the server returned its id) ----- */
    _syncTick() {
      const cloud = this.o.cloud; if (!cloud || !this.link || this.net !== "ONLINE" || this.t < this.nextSync || this.syncBusy) return;
      const pend = this.pending(); if (!pend.length) return;
      const batch = pend.slice(0, K.batch).map(e => { const c = Object.assign({}, e); delete c.acked; return c; });
      const good = r => {
        const ok = new Set(r && r.stored_ids || []); let n = 0;
        this.events.forEach(e => { if (ok.has(e.id) && !e.acked) { e.acked = true; n++; } });
        this.syncFail = 0; this.nextSync = this.t + 0.5; this.lastSync = { t: this.t, sent: batch.length, acked: n }; this.lastSyncError = "";
        if (this.events.length > 600) { const keep = this.events.filter(e => !e.acked), done = this.events.filter(e => e.acked).slice(-300); this.events = done.concat(keep).sort((a, b) => parseInt(a.id.slice(-6), 10) - parseInt(b.id.slice(-6), 10)); }
        this._saveJournal();
      };
      const bad = err => { this.syncFail++; this.nextSync = this.t + Math.min(30, Math.pow(2, this.syncFail)); this.lastSyncError = String(err && err.message || err); };
      let r; try { r = cloud.upload(batch); } catch (err) { bad(err); return; }
      if (r && typeof r.then === "function") { this.syncBusy = true; r.then(res => { this.syncBusy = false; good(res); }, err => { this.syncBusy = false; bad(err); }); } else good(r); // sync (SimCloud) or async (real server)
    }
    /* ----- motion (the only place motors are driven) ----- */
    _drive(v, w, dt) {
      let spd = clamp(v, 0, K.cruise);
      if (spd > 0) { const f = this.sens.front, l = this.sens.left, r = this.sens.right; if (!f.valid || f.m < K.frontStop || (l.valid && l.m < K.sideStop) || (r.valid && r.m < K.sideStop) || this.battery <= K.lowBattery) spd = 0; }
      const th = this.truth.h + clamp(w, -2, 2) * dt, nx = this.truth.x + Math.cos(th) * spd * dt, ny = this.truth.y + Math.sin(th) * spd * dt;
      if (spd > 0 && this.world.collides(nx, ny, K.robotR)) { this.stats.collisions++; spd = 0; this.truth.h = th; this.speed = 0; return; }
      const dx = nx - this.truth.x, dy = ny - this.truth.y; this.truth.h = th; this.truth.x = nx; this.truth.y = ny; this.speed = spd; this.stats.distance += hyp(dx, dy);
      this.est.x += dx; this.est.y += dy; this.battery = Math.max(0, this.battery - (spd > 0 ? 0.012 : 0.004) * dt);
    }
    _follow() { // returns false when the path is finished
      while (this.path.length) { const p = this._cellXY(this.path[0]); if (hyp(p.x - this.est.x, p.y - this.est.y) < 0.3 && this.path.length > 1) this.path.shift(); else break; }
      if (!this.path.length) return false; const p = this._cellXY(this.path[0]), dx = p.x - this.est.x, dy = p.y - this.est.y, dist = hyp(dx, dy);
      if (dist < 0.3 && this.path.length === 1) { this.path = []; return false; }
      const e = wrap(Math.atan2(dy, dx) - this.truth.h), w = clamp(3 * e, -K.turn, K.turn);
      let v = Math.abs(e) > 0.5 ? 0 : K.cruise * (1 - Math.abs(e) / 0.5); if (this.sens.front.m < 1.0) v = Math.min(v, 0.3); this.cmd = { v: Math.min(v, Math.max(0.12, dist * 1.2)), w }; return true;
    }
    _pathBlocked() { this._refresh(); const g = this.mode === "RTB" ? this._cell(this.base.x, this.base.y) : -1; for (let k = 0; k < Math.min(this.path.length, 8); k++) { const i = this.path[k]; if (!this.pass[i] && i !== g && !(k === 0)) return true; } return false; }
    _replanThrottle(kind) { if (this.t - this.lastReplanT > 5) { this.lastReplanT = this.t; this._event("route_replanned", "info", kind, { detours: this.detours }); } this.stats.replans++; }
    /* ----- one physics/FSM tick ----- */
    step(dt) {
      dt = dt || 0.1; this.t += dt; this.stats.ticks++; this._linkTick(dt); this._gpsTick(dt); this._sense(dt); this.cmd = { v: 0, w: 0 };
      const auto = this.state !== "IDLE" && this.state !== "ESTOP" && this.state !== "SAFE_STOP" && this.state !== "COMPLETE" && this.state !== "RTB_ARRIVED";
      if (auto) {
        if (this.battery <= K.lowBattery) this._safeStop("LOW_BATTERY", "Battery critical - safe stop");
        else if (!this._sensorsOk()) { this._event("sensor_fault", "critical", "Obstacle sensor fault - motors disabled", { faults: Object.keys(this.faults).filter(k => this.faults[k] && k !== "gps") }); this._safeStop("SENSOR_FAULT", "Sensor fault - safe stop"); }
        else if (this.offlineSeconds() >= K.autonomyCap) { this._event("autonomy_limit", "warn", "15-minute offline autonomy limit reached"); this._safeStop("AUTONOMY_LIMIT", "Offline autonomy limit - safe stop"); }
        else if (this.t - this.gps.t > K.gpsLost && this.fixes > 0) this._safeStop("GPS_LOST", "GPS lost > " + K.gpsLost + " s - safe stop");
      }
      if (this.state === "SAFE_STOP" && this.reason === "GPS_LOST" && this._gpsOk() && this.gpsResumes < 2 && this.t - this.gps.t < 1.5) { this.gpsResumes++; this.resume(); }
      if (this.o.autoRtbOnLinkLoss && this.mode === "EXPLORE" && this.offlineSeconds() >= 30 && this.state.indexOf("EXPLORE") === 0) this.requestRTB({ via: "local" });
      if (this.state !== "SAFE_STOP" && this.state !== "ESTOP" && !this._gpsOk() && auto && this.state !== "IDLE") { /* stale GPS: hold still (bounded by GPS_LOST above) */ }
      else this._fsm(dt);
      this._drive(this.cmd.v, this.cmd.w, dt); this._syncTick();
      if (this.mode && this.state !== "SAFE_STOP" && (this.state.indexOf("DRIVE") > 0 || this.state === "RTB_NAVIGATE")) {
        if (hyp(this.est.x - this.stuckPos.x, this.est.y - this.stuckPos.y) > 0.5) this.stuckPos = { x: this.est.x, y: this.est.y, t: this.t };
        else if (this.t - this.stuckPos.t > K.stuckS) this._safeStop("NO_PROGRESS", "No progress for " + K.stuckS + " s - safe stop");
      }
      this.persistT += dt; if (this.persistT >= K.persistEvery) { this.persistT = 0; this._saveWorld(); const n = this._knownFree(); if (n - this.lastAreaCount >= 150) { this.lastAreaCount = n; this._event("area_explored", "info", "Explored " + Math.round(this.exploredPct()) + "% of reachable area", { explored_pct: Math.round(this.exploredPct()) }); } }
    }
    _fsm(dt) {
      switch (this.state) {
        case "EXPLORE_PICK": {
          this._refresh(); const p = this._plan(i => this._isFrontier(i));
          if (p) { this.path = p; this.target = p[p.length - 1]; this.state = "EXPLORE_DRIVE"; this.stuckPos = { x: this.est.x, y: this.est.y, t: this.t }; break; }
          let left = 0, reach = 0; for (let i = 0; i < this.known.length; i++) { if (this._isFrontier(i)) left++; if (this.dist[i] < Infinity) reach++; }
          if (left > 0 && reach < 12) { this._safeStop("NO_SAFE_ROUTE", "Boxed in: no safe route out of the current area"); break; } // the rover itself cannot move anywhere
          this._halt("COMPLETE", left ? "UNREACHABLE_AREAS" : "");
          this._event("exploration_complete", "info", left ? "Exploration finished; " + left + " frontier cells are not safely reachable" : "Exploration complete", { explored_pct: Math.round(this.exploredPct()), unreachable_frontier_cells: left });
          break;
        }
        case "EXPLORE_DRIVE": {
          if (this.sens.front.m < K.frontStop + 0.05) { this.state = "AVOID"; this.avoidT = this.t; break; }
          if (this._pathBlocked()) { this._replanThrottle("Route re-planned around new obstacle"); this.state = "EXPLORE_PICK"; break; }
          if (!this._follow()) { this.state = "EXPLORE_SCAN"; this.scanA = 0; this.stats.scans++; }
          break;
        }
        case "EXPLORE_SCAN": {
          this.cmd = { v: 0, w: K.turn }; this.scanA += K.turn * dt;
          if (this.scanA >= 2 * Math.PI) { if (this.target != null && this._isFrontier(this.target)) this.black.add(this.target); this.state = "EXPLORE_PICK"; }
          break;
        }
        case "AVOID": {
          if (this.t - this.avoidT < 0.6) break; this._replanThrottle("Obstacle ahead - re-planning route");
          if (this.mode === "RTB") { this.detours++; if (this.detours > K.maxDetours) { this._rtbFail("NO_SAFE_ROUTE", "Return to base blocked: detour limit reached"); break; } this.state = "RTB_NAVIGATE"; this._rtbReplan(); } else this.state = "EXPLORE_PICK";
          break;
        }
        case "RTB_NAVIGATE": {
          const d = hyp(this.est.x - this.base.x, this.est.y - this.base.y), stopD = Math.max(0.5, this.base.radius * 0.7);
          if (d <= stopD) { this.state = "RTB_VERIFY"; this.verify = 0; this.verifySeq = this.gps.seq; this.rtb.state = "VERIFYING"; break; }
          if (this.sens.front.m < K.frontStop + 0.05) { this.state = "AVOID"; this.avoidT = this.t; break; }
          if (this._pathBlocked() || !this.path.length) { this.detours++; if (this.detours > K.maxDetours) { this._rtbFail("NO_SAFE_ROUTE", "Return to base blocked: detour limit reached"); break; } this._replanThrottle("Route re-planned around new obstacle"); this._rtbReplan(); break; }
          if (!this._follow()) { this._rtbReplan(); }
          this.rtb.remaining_m = this.pathLength(); break;
        }
        case "RTB_VERIFY": {
          const d = hyp(this.gps.x - this.base.x, this.gps.y - this.base.y);
          if (this.gps.seq !== this.verifySeq) { this.verifySeq = this.gps.seq; if (d <= this.base.radius) this.verify++; else { this.verify = 0; this.state = "RTB_NAVIGATE"; this._rtbReplan(); break; } }
          if (this.verify >= K.verifyFixes && Math.abs(this.speed) < 0.01) { // arrival is declared only by the rover, stopped, inside the radius
            this.state = "RTB_ARRIVED"; this.arrived = true; this.rtb.state = "ARRIVED"; this.rtb.remaining_m = 0; this.mode = null;
            this._event("rtb_arrived", "info", "Arrived at base (stopped inside radius)", { est_distance_m: +hyp(this.est.x - this.base.x, this.est.y - this.base.y).toFixed(2), radius_m: this.base.radius, sim_true_distance_m: +hyp(this.truth.x - this.base.x, this.truth.y - this.base.y).toFixed(2) });
          }
          break;
        }
        default: break;
      }
    }
    _planToBase() { // exact base cell first; otherwise any safely reachable mapped cell inside the arrival radius (that is all the rule requires)
      const g = this._cell(this.base.x, this.base.y), stopD = Math.max(0.5, this.base.radius * 0.7), near = Math.max(0.35, stopD - 0.35);
      return this._plan(i => i === g, g) || this._plan(i => { if (!this.pass[i]) return false; const c = this._cellXY(i); return hyp(c.x - this.base.x, c.y - this.base.y) <= near; });
    }
    _rtbReplan() { const p = this._planToBase(); if (!p) { this._rtbFail("NO_SAFE_ROUTE", "No safe route to base - safe stop"); return; } this.path = p; }
    _rtbFail(reason, msg) { this._event("rtb_failed", "warn", msg, { reason, via: this.rtb && this.rtb.via }); this._safeStop(reason, msg); if (this.rtb) this.rtb.reason = reason; }
    /* ----- status for UI and tests ----- */
    snapshot() {
      const ll = toLatLon(this.o.origin, this.truth.x, this.truth.y), rem = this.rtb && this.mode === "RTB" ? this.pathLength() : (this.rtb && this.rtb.remaining_m) || 0, pend = this.pending().length;
      return {
        t: this.t, state: this.state, reason: this.reason, mode: this.mode, scenario: this.scenario, sim: true,
        link: { up: this.link, net: this.net, offlineS: this.offlineSeconds(), autonomyLeftS: this.net === "OFFLINE" ? Math.max(0, K.autonomyCap - this.offlineSeconds()) : K.autonomyCap },
        gps: { fix: this._gpsOk(), acc: this.gps.acc, lat: ll.lat, lon: ll.lon }, pose: { x: this.truth.x, y: this.truth.y, h: this.truth.h, bearing: bearingDeg(this.truth.h), speed: this.speed },
        est: { x: this.est.x, y: this.est.y }, battery: +this.battery.toFixed(1), sensors: this.sens, faults: Object.assign({}, this.faults),
        base: Object.assign({}, this.base, toLatLon(this.o.origin, this.base.x, this.base.y)), path: this.path.map(i => this._cellXY(i)), target: this.target != null ? this._cellXY(this.target) : null,
        rtb: this.rtb ? { state: this.rtb.state, reason: this.rtb.reason || "", arrived: this.arrived, remaining_m: rem, initial_m: this.rtbInit, progress_pct: this.rtbInit > 0 ? clamp(100 * (1 - rem / this.rtbInit), 0, 100) : 0, detours: this.detours } : null,
        arrived: this.arrived, explored_pct: this.exploredPct(), events: { total: this.seq, pending: pend, acked: this.events.length - pend, dropped: this.dropped, journal: this.events.length },
        collisions: this.stats.collisions, stats: Object.assign({}, this.stats), lastSyncError: this.lastSyncError || ""
      };
    }
    run(seconds, dt) { dt = dt || 0.1; const n = Math.round(seconds / dt); for (let i = 0; i < n; i++) this.step(dt); }
    runUntil(pred, maxS, dt) { dt = dt || 0.1; for (let i = 0, n = Math.round(maxS / dt); i < n; i++) { this.step(dt); if (pred(this)) return true; } return false; }
  }
  return { CELL, UNK, FREE, OCC, K, SCENARIOS, World, RoverSim, SimCloud, MemoryStore, buildScenario, toLatLon, fromLatLon, bearingDeg, rng };
});
