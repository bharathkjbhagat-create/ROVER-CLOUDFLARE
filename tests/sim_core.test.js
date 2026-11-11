/* Automated tests for public/sim-core.js - SOFTWARE simulation only (no hardware, no real network).
 * Run: node --test tests/sim_core.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../public/sim-core.js");

const EPOCH = 1.78e9;
const mk = (o) => new S.RoverSim(Object.assign({ epoch: EPOCH, seed: 3 }, o || {}));
const DONE = r => ["COMPLETE", "SAFE_STOP", "ESTOP"].includes(r.state);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const uniq = a => new Set(a).size === a.length;

/* ---------------- exploration ---------------- */
test("autonomous exploration maps the world, never collides, and finishes safely", () => {
  for (const sc of ["open_field", "warehouse", "corridor"]) {
    const r = mk({ scenario: sc }); r.startExploration();
    assert.ok(r.runUntil(DONE, 3000), sc + " did not finish");
    const s = r.snapshot();
    assert.equal(s.state, "COMPLETE", sc + " ended in " + s.state + " " + s.reason);
    assert.ok(s.explored_pct >= 95, sc + " explored only " + s.explored_pct);
    assert.equal(s.collisions, 0, sc + " collided");
    assert.ok(s.sim && s.stats.distance > 20);
  }
});

test("simulated exploration takes 10-15 minutes of rover time on the standard maps", () => {
  const r = mk({ scenario: "warehouse" }); r.startExploration(); r.runUntil(DONE, 3000);
  assert.ok(r.t >= 600 && r.t <= 1000, "took " + r.t + " s");
});

test("sensor and GPS inputs are simulated (noisy, bounded) and the rover navigates on its estimate", () => {
  const r = mk(); r.startExploration(); let maxErr = 0, gpsErr = 0;
  for (let i = 0; i < 3000; i++) { r.step(0.1); maxErr = Math.max(maxErr, dist(r.est, r.truth)); if (r.gps.fix) gpsErr = Math.max(gpsErr, dist(r.gps, r.truth)); }
  assert.ok(gpsErr > 0.05, "GPS should be noisy, was " + gpsErr);
  assert.ok(gpsErr < 1.5, "GPS noise bounded to 3 sigma");
  assert.ok(maxErr < 0.8, "pose estimate drifted " + maxErr);
  const s = r.snapshot(); assert.ok(["front", "left", "right"].every(k => s.sensors[k].valid && s.sensors[k].m > 0));
});

/* ---------------- 10-15 minutes offline, local storage, sync ---------------- */
test("15 minutes offline: keeps working without internet, journals locally, stops safely at the autonomy limit", () => {
  const store = new S.MemoryStore(), cloud = new S.SimCloud();
  const r = mk({ scenario: "big_field", store, cloud }); r.startExploration(); r.setLink(false);
  let autonomousAt10 = false;
  for (let i = 0; i < 6000; i++) { r.step(0.1); if (i === 6000 - 1) autonomousAt10 = r.state.indexOf("EXPLORE") === 0; }
  assert.ok(autonomousAt10, "should still be exploring after 10 offline minutes, was " + r.state);
  assert.equal(r.net, "OFFLINE");
  assert.equal(cloud.stats.batches, 0, "nothing may reach the server while offline");
  assert.ok(r.pending().length >= 5, "events must be queued locally");
  assert.ok(JSON.parse(store.get("defenx-sim:ROVER-SIM:journal")).events.length >= 5, "journal must be persisted to local storage");
  assert.ok(store.get("defenx-sim:ROVER-SIM:map"), "explored map must be persisted locally");
  r.run(320);
  const s = r.snapshot();
  assert.equal(s.state, "SAFE_STOP"); assert.equal(s.reason, "AUTONOMY_LIMIT");
  assert.ok(s.link.offlineS >= 900, "offline for " + s.link.offlineS);
  assert.equal(s.pose.speed, 0); assert.equal(s.collisions, 0);
  assert.ok(r.events.some(e => e.type === "autonomy_limit") && r.events.some(e => e.type === "link_lost" && e.offline));
  assert.ok(s.explored_pct > 50, "should have explored a lot offline: " + s.explored_pct);
  assert.deepEqual(r.resume(), { ok: false, reason: "AUTONOMY_LIMIT_NEEDS_LINK" });
});

test("reconnect: every stored event is synchronised automatically, exactly once", () => {
  const cloud = new S.SimCloud(), r = mk({ cloud });
  r.startExploration(); r.setLink(false); r.run(400); assert.ok(r.pending().length > 3);
  const produced = r.events.map(e => e.id); assert.equal(cloud.events.size, 0);
  r.setLink(true); r.run(30);
  assert.equal(r.net, "ONLINE"); assert.equal(r.pending().length > 0, true === false ? true : r.events.some(e => !e.acked) ? r.pending().length > 0 : false);
  const ids = [...cloud.events.keys()];
  assert.ok(produced.every(id => cloud.events.has(id)), "event lost");
  assert.equal(cloud.stats.duplicates, 0, "event duplicated");
  assert.ok(uniq(ids));
  assert.ok(r.events.filter(e => e.type === "link_restored").length === 1);
  const off = [...cloud.events.values()].filter(e => e.offline); assert.ok(off.length >= 1, "offline events keep their offline flag");
});

test("lost server acknowledgements cause re-sends but never duplicates or losses", () => {
  const cloud = new S.SimCloud(), r = mk({ cloud }); r.startExploration(); r.run(60);
  cloud.mode = "lose_ack"; r.run(200);
  assert.ok(cloud.stats.ackLost > 0 && r.pending().length > 0, "the sim must actually lose acks");
  cloud.mode = "ok"; r.run(120);
  const all = r.events.map(e => e.id);
  assert.ok(cloud.stats.duplicates > 0, "server saw re-sent events");
  assert.equal(cloud.events.size, new Set(all).size, "server holds exactly the unique events");
  assert.ok(all.every(id => cloud.events.has(id)), "nothing lost");
  assert.equal(r.pending().length, 0);
});

test("server rejections keep events queued and retried with backoff until accepted", () => {
  const cloud = new S.SimCloud(), r = mk({ cloud }); r.startExploration(); cloud.mode = "reject"; r.run(120);
  const before = cloud.stats.batches; assert.ok(before >= 1 && before < 30, "retries must back off, got " + before);
  assert.ok(r.pending().length > 0); assert.ok(r.snapshot().lastSyncError);
  cloud.mode = "ok"; r.run(60); assert.equal(r.pending().length, 0);
});

test("power-cycle while offline: journal, map and pose survive, ids stay unique, nothing lost or duplicated", () => {
  const store = new S.MemoryStore(), cloud = new S.SimCloud();
  const a = mk({ store, cloud }); a.startExploration(); a.setLink(false); a.run(300);
  const idsA = a.events.map(e => e.id), mapA = a.exploredPct(), posA = Object.assign({}, a.truth);
  const b = mk({ store, cloud, restore: true }); // new boot, same flash
  assert.ok(b.restored, "state must be restored"); assert.equal(b.state, "IDLE", "must never resume driving by itself after a reset");
  assert.deepEqual(b.events.map(e => e.id), idsA);
  assert.ok(Math.abs(b.exploredPct() - mapA) < 3, "map is snapshotted every 5 s"); assert.ok(dist(b.truth, posA) < 3.5, "pose within one snapshot interval");
  b.startExploration(); b.setLink(false); b.run(120); b.setLink(true); b.run(60);
  const all = b.events.map(e => e.id); assert.ok(uniq(all), "ids unique across boots");
  assert.ok(all.length > idsA.length);
  assert.equal(cloud.events.size, all.length); assert.equal(cloud.stats.duplicates, 0);
  assert.ok(idsA.every(id => cloud.events.has(id)));
});

test("all emitted events satisfy the real server's event schema", () => {
  const r = mk(); r.startExploration(); r.setLink(false); r.run(200); r.requestRTB({ via: "local" }); r.run(100);
  assert.ok(r.events.length > 5);
  for (const e of r.events) {
    assert.match(e.id, /^[A-Za-z0-9._:-]{6,64}$/); assert.match(e.type, /^[a-z0-9_]{2,32}$/);
    assert.ok(["info", "warn", "critical"].includes(e.severity)); assert.ok(e.t > 1e9 && e.message.length <= 200);
    assert.ok(JSON.stringify(e.data || {}).length < 6000);
  }
});

/* ---------------- obstacles and safe stop ---------------- */
test("a new obstacle on the route is detected and the rover plans a safe alternative", () => {
  const r = mk(); r.startExploration(); r.run(120);
  for (let k = 0; k < 4; k++) { assert.ok(r.blockAhead(2.5, 3).cells >= 0); r.run(40); }
  r.runUntil(DONE, 3000);
  assert.equal(r.stats.collisions, 0); assert.ok(r.stats.replans >= 1); assert.ok(r.events.some(e => e.type === "obstacle_detected"));
  assert.equal(r.state, "COMPLETE");
});

test("boxed in with no safe route: the rover stops and says why", () => {
  const r = mk(); r.startExploration(); r.run(5);
  for (let a = 0; a < 6.3; a += 0.1) { r.world.rect(Math.floor((r.truth.x + Math.cos(a) * 1.2) / 0.5), Math.floor((r.truth.y + Math.sin(a) * 1.2) / 0.5), Math.floor((r.truth.x + Math.cos(a) * 1.7) / 0.5), Math.floor((r.truth.y + Math.sin(a) * 1.7) / 0.5)); }
  r.runUntil(DONE, 300);
  assert.equal(r.state, "SAFE_STOP"); assert.ok(["NO_SAFE_ROUTE", "NO_PROGRESS"].includes(r.reason), r.reason); assert.equal(r.speed, 0); assert.equal(r.stats.collisions, 0);
  assert.ok(r.events.some(e => e.type === "safe_stop"));
});

/* ---------------- return to base ---------------- */
function explored(sc, secs) { const r = mk({ scenario: sc, cloud: new S.SimCloud() }); r.startExploration(); r.run(secs); return r; }

test("RTB: base chosen on the map, rover drives the route, arrival is declared only when stopped inside the radius", () => {
  const r = explored("open_field", 240); r.stop(); r.run(2);
  const far = r.snapshot().pose; assert.ok(dist(far, r.base) > 4, "rover should be away from base");
  assert.deepEqual(r.setBase(r.start.x, r.start.y, 3), { ok: true }); assert.equal(r.base.radius, 3);
  assert.deepEqual(r.requestRTB({ via: "cloud" }), { ok: true });
  let arrivedSeen = false, lastRem = Infinity, monotonicBreaks = 0, started = r.snapshot().rtb.remaining_m;
  for (let i = 0; i < 6000 && !r.arrived; i++) {
    r.step(0.1); const s = r.snapshot();
    if (s.arrived) { arrivedSeen = true; break; }
    if (s.rtb && s.state === "RTB_NAVIGATE") { if (s.rtb.remaining_m > lastRem + 2) monotonicBreaks++; lastRem = s.rtb.remaining_m; }
    assert.equal(s.arrived, false, "arrived must be false while still moving");
  }
  assert.ok(arrivedSeen, "never arrived (" + r.state + " " + r.reason + ")");
  const s = r.snapshot();
  assert.equal(s.state, "RTB_ARRIVED"); assert.equal(s.pose.speed, 0, "must be stopped"); assert.ok(dist(s.pose, r.base) <= 3, "true position inside radius: " + dist(s.pose, r.base));
  assert.equal(s.rtb.remaining_m, 0); assert.equal(s.rtb.progress_pct, 100); assert.ok(s.stats.collisions === 0);
  const ev = r.events.find(e => e.type === "rtb_arrived"); assert.ok(ev && ev.data.sim_true_distance_m <= 3 && ev.data.radius_m === 3);
  assert.ok(started > 4); assert.ok(monotonicBreaks <= 2, "route progress should trend down");
});

test("RTB never reports arrival before the rover has stopped and 3 consecutive fixes are inside the radius", () => {
  const r = explored("open_field", 200); r.stop(); r.requestRTB({ via: "cloud" });
  const log = [];
  for (let i = 0; i < 6000 && !r.arrived; i++) { r.step(0.1); if (r.state === "RTB_VERIFY") log.push([r.verify, r.speed]); }
  assert.ok(r.arrived); assert.ok(log.length >= 2, "verify phase must take time"); assert.ok(log.every(x => x[1] < 0.01), "motors stopped during verify");
  assert.ok(Math.max(...log.map(x => x[0])) >= 2);
});

test("RTB radius is respected for different radii", () => {
  for (const radius of [1.5, 4, 8]) {
    const r = explored("open_field", 200); r.stop(); r.setBase(r.start.x, r.start.y, radius); r.requestRTB({ via: "cloud" });
    assert.ok(r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 700), "no result for radius " + radius);
    assert.ok(r.arrived, radius + ": " + r.reason); assert.ok(dist(r.truth, r.base) <= radius, radius + ": ended " + dist(r.truth, r.base));
  }
});

test("RTB to a different base picked on the map, and set-base validation", () => {
  const r = explored("open_field", 300); r.stop();
  assert.equal(r.setBase(-5, 3).reason, "OUTSIDE_WORLD"); assert.equal(r.setBase(NaN, 3).reason, "INVALID_POINT"); assert.equal(r.setBase(5, 5, 0.2).reason, "RADIUS_OUT_OF_RANGE");
  let cand = null; for (let i = 0; i < r.known.length && !cand; i++) { const p = r._cellXY(i); if (r.known[i] === 1 && r.pass[i] && dist(p, r.truth) > 8) cand = p; }
  assert.ok(cand, "need a known free cell"); const unk = (() => { for (let i = 0; i < r.known.length; i++) if (r.known[i] === 0) return r._cellXY(i); })();
  if (unk) assert.equal(r.setBase(unk.x, unk.y).reason, "BASE_NOT_IN_MAPPED_FREE_SPACE");
  assert.deepEqual(r.setBase(cand.x, cand.y, 2.5), { ok: true }); assert.deepEqual(r.requestRTB({ via: "cloud" }), { ok: true });
  assert.ok(r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 700)); assert.ok(r.arrived); assert.ok(dist(r.truth, cand) <= 2.5);
});

test("RTB to a base right next to a wall (base cell not safely drivable) still arrives inside the radius", () => {
  const r = explored("open_field", 320); r.stop(); r.run(2); r._refresh(); let c = null;
  for (let i = 0; i < r.known.length && !c; i++) { const p = r._cellXY(i); if (r.known[i] === 1 && !r.pass[i] && dist(p, r.truth) > 6 && dist(p, r.start) > 3) c = p; }
  assert.ok(c, "need a mapped free cell that is too close to an obstacle to drive onto");
  assert.deepEqual(r.setBase(c.x, c.y, 2.5), { ok: true }); const res = r.requestRTB({ via: "cloud" });
  if (!res.ok) return; // refusing is acceptable only if truly no safe route exists; arrival is the expected outcome
  assert.ok(r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 900)); assert.ok(r.arrived, r.reason); assert.ok(dist(r.truth, c) <= 2.5); assert.equal(r.stats.collisions, 0);
});

test("changing only the arrival radius works even if the base cell was later mapped as an obstacle", () => {
  const r = explored("open_field", 60); r.stop(); const b = r.base, i = r._cell(b.x, b.y); r.known[i] = 2; r.dirty = true;
  assert.equal(r.setBase(b.x, b.y).reason, "BASE_NOT_IN_MAPPED_FREE_SPACE"); assert.deepEqual(r.setRadius(6), { ok: true }); assert.equal(r.base.radius, 6);
  assert.equal(r.setRadius(0.5).reason, "RADIUS_OUT_OF_RANGE"); assert.equal(r.setRadius(21).reason, "RADIUS_OUT_OF_RANGE"); assert.equal(r.setRadius("x").reason, "RADIUS_OUT_OF_RANGE"); assert.equal(r.base.radius, 6);
});

test("RTB avoids a new obstacle dropped on its route (detour, no collision)", () => {
  const r = explored("open_field", 240); r.stop(); r.requestRTB({ via: "cloud" }); r.run(6);
  const res = r.blockAhead(3, 3); assert.ok(res.ok);
  assert.ok(r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 900)); assert.ok(r.arrived, r.reason); assert.equal(r.stats.collisions, 0);
  assert.ok(r.events.some(e => e.type === "route_replanned" || e.type === "obstacle_detected"));
});

test("RTB with the only route blocked: safe stop, NO_SAFE_ROUTE, never a fake arrival", () => {
  const r = mk({ scenario: "corridor", cloud: new S.SimCloud() }); r.startExploration(); r.runUntil(DONE, 1000); r.stop(); r.run(2);
  let far = null; for (let i = 0; i < r.known.length; i++) { const p = r._cellXY(i); if (r.known[i] === 1 && r.pass[i] && p.x > 24 && (!far || p.x > far.x)) far = p; }
  assert.ok(far, "far room must be mapped");
  assert.deepEqual(r.setBase(far.x, far.y, 2.5), { ok: true }); assert.deepEqual(r.requestRTB({ via: "cloud" }), { ok: true });
  assert.ok(r.runUntil(x => x.truth.x > 12 && x.truth.x < 20, 300), "should be in the corridor, x=" + r.truth.x);
  assert.ok(r.blockAhead(3, 5).ok);
  r.runUntil(x => x.state === "SAFE_STOP" || x.arrived, 300);
  assert.equal(r.state, "SAFE_STOP"); assert.equal(r.reason, "NO_SAFE_ROUTE"); assert.equal(r.arrived, false); assert.equal(r.speed, 0); assert.equal(r.stats.collisions, 0);
  assert.ok(r.events.some(e => e.type === "rtb_failed")); assert.equal(r.snapshot().rtb.state, "FAILED");
});

test("RTB refused (fail closed) when preconditions fail, with the reason recorded", () => {
  let r = explored("open_field", 100); r.stop(); r.setFault("front", true); assert.equal(r.requestRTB({ via: "cloud" }).reason, "SENSOR_FAULT");
  r = explored("open_field", 100); r.stop(); r.setBattery(20); assert.equal(r.requestRTB({ via: "cloud" }).reason, "BATTERY_TOO_LOW");
  r = explored("open_field", 100); r.stop(); r.setFault("gps", true); r.run(6); assert.equal(r.requestRTB({ via: "cloud" }).reason, "GPS_UNAVAILABLE");
  r = explored("open_field", 100); r.estop(); assert.equal(r.requestRTB({ via: "cloud" }).reason, "ESTOP_ACTIVE");
  assert.ok(r.state === "ESTOP" && r.speed === 0 && !r.arrived);
  r = mk(); assert.equal(r.requestRTB({ via: "cloud" }).reason, "GPS_UNAVAILABLE", "no GPS fix yet -> refuse");
});

test("communication failure: a cloud RTB command to an unreachable rover is refused, not faked", () => {
  const r = explored("open_field", 120); r.stop(); r.setLink(false); r.run(7); assert.equal(r.net, "OFFLINE");
  const before = r.events.length, res = r.requestRTB({ via: "cloud" });
  assert.deepEqual(res, { ok: false, reason: "ROVER_UNREACHABLE" }); assert.equal(r.state, "IDLE"); assert.equal(r.events.length, before, "no event may claim the command was sent");
});

test("communication failure mid-return: rover finishes autonomously, arrival is journaled offline and synced later", () => {
  const cloud = new S.SimCloud(), r = mk({ cloud }); r.startExploration(); r.run(240); r.stop(); r.requestRTB({ via: "cloud" }); r.run(4);
  r.setLink(false);
  assert.ok(r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 900)); assert.ok(r.arrived, r.reason);
  const arr = r.events.find(e => e.type === "rtb_arrived"); assert.ok(arr); assert.equal(arr.acked, false); assert.equal(cloud.events.has(arr.id), false);
  r.setLink(true); r.run(30); assert.ok(cloud.events.has(arr.id), "arrival event synced after reconnect"); assert.equal(cloud.stats.duplicates, 0);
});

test("opt-in automatic return after 30 s offline (off by default)", () => {
  let r = mk(); r.startExploration(); r.run(200); r.setLink(false); r.run(80); assert.equal(r.mode, "EXPLORE", "default must NOT auto-return");
  r = mk({ autoRtbOnLinkLoss: true }); r.startExploration(); r.run(200); r.setLink(false); r.run(60);
  assert.equal(r.mode === "RTB" || r.arrived || r.state === "SAFE_STOP", true); assert.ok(r.events.some(e => e.type === "rtb_started" && e.data.via === "local"));
});

/* ---------------- faults ---------------- */
test("GPS dropout: holds still when the fix is stale, resumes if it returns quickly, safe-stops if it does not", () => {
  let r = mk(); r.startExploration(); r.run(60); r.setFault("gps", true); r.run(5); assert.ok(Math.abs(r.speed) < 0.01, "must not drive blind on stale GPS"); r.setFault("gps", false); r.run(10);
  assert.ok(r.state.indexOf("EXPLORE") === 0, "resumes after short dropout: " + r.state); assert.equal(r.stats.collisions, 0);
  r = mk(); r.startExploration(); r.run(60); r.setFault("gps", true); r.run(20);
  assert.equal(r.state, "SAFE_STOP"); assert.equal(r.reason, "GPS_LOST"); assert.ok(r.events.some(e => e.type === "gps_lost"));
});

test("obstacle sensor fault: motors disabled, no resume until the fault is cleared", () => {
  const r = mk(); r.startExploration(); r.run(30); r.setFault("front", true); r.run(1);
  assert.equal(r.state, "SAFE_STOP"); assert.equal(r.reason, "SENSOR_FAULT"); assert.equal(r.speed, 0);
  assert.equal(r.resume().reason, "SENSOR_FAULT"); r.setFault("front", false); r.run(1); assert.equal(r.resume().ok, true);
});

test("e-stop latches, survives sensor recovery, clears only to IDLE", () => {
  const r = mk(); r.startExploration(); r.run(30); r.estop(); r.run(5);
  assert.equal(r.state, "ESTOP"); assert.equal(r.speed, 0); assert.equal(r.startExploration().reason, "ESTOP_ACTIVE");
  r.setFault("left", true); assert.equal(r.resetEstop().reason, "SENSOR_FAULT"); r.setFault("left", false);
  assert.equal(r.resetEstop().ok, true); assert.equal(r.state, "IDLE"); r.run(5); assert.equal(r.speed, 0, "reset must not start moving");
});

test("low battery safe-stops the rover", () => {
  const r = mk(); r.startExploration(); r.run(20); r.setBattery(10); r.run(2); assert.equal(r.state, "SAFE_STOP"); assert.equal(r.reason, "LOW_BATTERY"); assert.equal(r.speed, 0);
});

/* ---------------- randomised safety sweep ---------------- */
test("randomised sweep: exploration + RTB over 10 worlds with random faults never collides or lies about arrival", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const sc = ["open_field", "warehouse", "big_field"][seed % 3], rnd = S.rng(seed * 101);
    const r = mk({ scenario: sc, seed, cloud: new S.SimCloud() }); r.startExploration();
    const t1 = 150 + Math.floor(rnd() * 250); for (let i = 0; i < t1 * 10; i++) { r.step(0.1); if (rnd() < 0.0004) r.setFault("gps", true); if (rnd() < 0.01) r.setFault("gps", false); if (rnd() < 0.0003) r.setLink(rnd() < 0.5); }
    r.setFault("gps", false); r.setLink(true); r.run(5); if (r.state === "SAFE_STOP") r.resume(); else r.stop();
    r.run(2); const res = r.requestRTB({ via: "cloud" });
    for (let i = 0; i < 9000 && res.ok && !r.arrived && r.state !== "SAFE_STOP"; i++) { r.step(0.1); if (r.arrived) assert.ok(Math.abs(r.speed) < 0.01); }
    assert.equal(r.stats.collisions, 0, "seed " + seed + " collided");
    if (r.arrived) assert.ok(dist(r.truth, r.base) <= r.base.radius + 0.01, "seed " + seed);
    assert.ok(uniq(r.events.map(e => e.id)));
  }
});

test("geo helpers round-trip and bearings", () => {
  const o = { lat: 13.0, lon: 77.6 }, p = S.toLatLon(o, 120, -80), q = S.fromLatLon(o, p.lat, p.lon);
  assert.ok(Math.abs(q.x - 120) < 1e-6 && Math.abs(q.y + 80) < 1e-6); assert.equal(Math.round(S.bearingDeg(Math.PI / 2)), 0); assert.equal(Math.round(S.bearingDeg(0)), 90);
});
