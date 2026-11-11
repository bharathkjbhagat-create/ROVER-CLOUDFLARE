/* DEFENX Simulation Lab - dashboard panel for the SOFTWARE rover simulation (public/sim-core.js).
 * Everything here is simulated: no hardware is contacted, nothing is sent to the real rover or the real fleet API.
 * Built with textContent/DOM APIs only. Map overlays use the dashboard's existing Leaflet map when present. */
(() => {
  "use strict";
  const demo = location.pathname === "/" || location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  const mount = document.getElementById("simLabMount");
  if (!mount) return;
  if (demo || !window.DefenxSim) { mount.hidden = true; return; }
  const S = window.DefenxSim, CELL = S.CELL;
  const $ = (t, props, kids) => { const e = document.createElement(t); Object.assign(e, props || {}); (kids || []).forEach(k => e.appendChild(k)); return e; };
  const store = (() => { try { const k = "defenx-sim:probe"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return { get: k2 => localStorage.getItem(k2), set: (k2, v) => localStorage.setItem(k2, v), del: k2 => localStorage.removeItem(k2), ok: true }; } catch (_) { return new S.MemoryStore(); } })();
  const CLOUD_KEY = "defenx-sim:cloud", ORIGIN = { lat: 13.0, lon: 77.6 };
  const STATE_TEXT = { IDLE: "IDLE", EXPLORE_PICK: "EXPLORING · PLANNING", EXPLORE_DRIVE: "EXPLORING · DRIVING", EXPLORE_SCAN: "EXPLORING · SCANNING", AVOID: "AVOIDING OBSTACLE", RTB_NAVIGATE: "RETURNING TO BASE", RTB_VERIFY: "VERIFYING ARRIVAL", RTB_ARRIVED: "ARRIVED AT BASE", SAFE_STOP: "SAFE STOP", ESTOP: "EMERGENCY STOP", COMPLETE: "EXPLORATION COMPLETE" };
  const REASON_TEXT = { NO_SAFE_ROUTE: "no safe route", AUTONOMY_LIMIT: "15-min offline limit", GPS_LOST: "GPS lost", SENSOR_FAULT: "sensor fault", LOW_BATTERY: "battery low", NO_PROGRESS: "no progress", UNREACHABLE_AREAS: "some areas unreachable", ROVER_UNREACHABLE: "rover unreachable (offline)", BASE_NOT_IN_MAPPED_FREE_SPACE: "base must be inside mapped free space", GPS_UNAVAILABLE: "no GPS fix", BATTERY_TOO_LOW: "battery below 25%", ESTOP_ACTIVE: "e-stop active", OUTSIDE_WORLD: "outside the simulated area", RADIUS_OUT_OF_RANGE: "radius must be 1-20 m", AUTONOMY_LIMIT_NEEDS_LINK: "needs link to resume" };
  const why = r => REASON_TEXT[r] || String(r || "").toLowerCase().replace(/_/g, " ");

  let sim = null, cloud = null, simCloud = null, flaskCloud = null, errShown = "", scenario = "open_field", speed = 5, paused = false, pickBase = false, showTruth = false, onMap = false, lastT = 0, acc = 0, raf = 0;
  let uiTick = 0, mapTick = 0, demoRun = null, awaitSync = null, mapLayers = null, mapClickBound = null, trail = [];

  /* ---------- DOM ---------- */
  const chipMode = $("span", { className: "simChip simChipWarn", textContent: "SOFTWARE ONLY" });
  const chipNet = $("span", { className: "simChip", textContent: "ONLINE" });
  const note = $("div", { className: "simNote", textContent: "Simulated rover, GPS and ultrasonic sensors running in this browser. It does not control or prove anything about the physical rover." });
  const canvas = $("canvas", { className: "simCanvas", width: 480, height: 480 }); canvas.setAttribute("aria-label", "Simulated rover map"); canvas.setAttribute("role", "img");
  const grid = $("div", { className: "simGrid" }), cells = {};
  ["LINK", "STATE", "GPS", "SENSORS F/L/R", "BATTERY", "SIM TIME", "EXPLORED", "EVENTS QUEUED/SYNCED", "OFFLINE AUTONOMY", "RETURN TO BASE"].forEach(k => { const b = $("b", { textContent: "—" }); cells[k] = b; grid.appendChild($("div", {}, [$("span", { textContent: k }), b])); });
  const msg = $("div", { className: "simMsg", role: "status" }); msg.setAttribute("aria-live", "polite");
  const log = $("div", { className: "simLog" });
  const btns = {};
  const btn = (id, label, cls, fn) => { const b = $("button", { type: "button", id: "sim_" + id, textContent: label, className: "simBtn " + (cls || "") }); b.addEventListener("click", () => { try { fn(b); } catch (e) { say("Action failed: " + (e && e.message || e), "bad"); } }); btns[id] = b; return b; };
  const row = (label, kids) => $("div", { className: "simRow" }, [$("span", { className: "simRowLabel", textContent: label })].concat(kids));
  const scenSel = $("select", { id: "sim_scenario", className: "simSel" }); Object.keys(S.SCENARIOS).forEach(k => scenSel.appendChild($("option", { value: k, textContent: S.SCENARIOS[k].label })));
  const speedSel = $("select", { id: "sim_speed", className: "simSel" }); [1, 5, 20, 60].forEach(v => speedSel.appendChild($("option", { value: String(v), textContent: v + "× speed" }))); speedSel.value = "5";
  const cloudSel = $("select", { id: "sim_cloudmode", className: "simSel" }); [["ok", "Cloud: normal"], ["lose_ack", "Cloud: lose replies"], ["reject", "Cloud: reject uploads"], ["flask", "Cloud: real Flask server"]].forEach(a => cloudSel.appendChild($("option", { value: a[0], textContent: a[1] })));
  const radius = $("input", { id: "sim_radius", type: "number", min: 1, max: 20, step: 0.5, value: "2.5", className: "simNum" }); radius.setAttribute("aria-label", "Arrival radius in metres");
  const mapChk = $("input", { id: "sim_onmap", type: "checkbox" }), truthChk = $("input", { id: "sim_truth", type: "checkbox" });
  const lab = (cb, text) => $("label", { className: "simChk" }, [cb, $("span", { textContent: text })]);

  mount.className = "card simLabCard"; mount.id = "simLabSection";
  mount.append($("div", { className: "cardHeader" }, [$("b", { textContent: "SIMULATION LAB" }), $("span", { className: "simChips" }, [chipMode, chipNet])]), note,
    $("div", { className: "simCanvasWrap" }, [canvas]), grid, msg,
    row("WORLD", [scenSel, speedSel, btn("reset", "RESET", "", () => resetSim(true))]),
    row("EXPLORE", [btn("start", "START EXPLORATION", "simPrimary", () => reply(sim.startExploration(), "Exploration started")), btn("pause", "PAUSE SIM", "", b => { paused = !paused; b.textContent = paused ? "RESUME SIM" : "PAUSE SIM"; b.setAttribute("aria-pressed", String(paused)); say(paused ? "Simulation clock paused (rover state unchanged)." : "Simulation clock running."); }), btn("stop", "STOP ROVER", "", () => reply(sim.stop(), "Rover stopped")), btn("resume", "RESUME AUTONOMY", "", () => reply(sim.resume(), "Autonomy resumed"))]),
    row("NETWORK", [btn("link", "GO OFFLINE", "", toggleLink), btn("offdemo", "15-MIN OFFLINE TEST", "", startOfflineDemo), cloudSel]),
    row("BASE", [btn("pick", "PICK BASE", "", togglePick), radius, btn("setbase", "SET RADIUS", "", () => reply(sim.setRadius(Number(radius.value)), "Arrival radius set to " + radius.value + " m")),
      btn("rtb", "RETURN TO BASE", "simPrimary", () => reply(sim.requestRTB({ via: "cloud" }), "Return to base started")), btn("cancelrtb", "CANCEL RETURN", "", () => reply(sim.cancelRTB(), "Return cancelled"))]),
    row("FAULTS", [btn("gpsf", "DROP GPS", "", b => toggleFault("gps", b, "GPS dropout")), btn("frontf", "FRONT SENSOR FAULT", "", b => toggleFault("front", b, "Front sensor fault")), btn("block", "BLOCK ROUTE AHEAD", "", () => { const r = sim.blockAhead(3, 3); say(r.ok ? "Obstacle dropped ahead (" + r.cells + " cells). The rover must detect and avoid it." : "Could not place an obstacle here.", r.ok ? "ok" : "bad"); }),
      btn("estop", "E-STOP", "simDanger", () => reply(sim.estop(), "Emergency stop latched")), btn("estopr", "RESET E-STOP", "", () => reply(sim.resetEstop(), "E-stop cleared (rover idle)"))]),
    $("div", { className: "simRow" }, [lab(mapChk, "Show on live map"), lab(truthChk, "Show true obstacles (sim only)")]),
    $("div", { className: "simLogTitle", textContent: "ROVER EVENT JOURNAL  (✓ synced · … queued locally)" }), log);

  function say(t, kind) { msg.textContent = t; msg.dataset.k = kind || "info"; }
  function reply(res, okText) { if (res && res.ok) say(okText, "ok"); else say("Refused: " + why(res && res.reason), "bad"); refresh(true); return res; }

  /* ---------- simulation lifecycle ---------- */
  function makeCloud() {
    const c = new S.SimCloud();
    try { const j = JSON.parse(store.get(CLOUD_KEY) || "null"); if (j && Array.isArray(j.events)) j.events.forEach(e => c.events.set(e.id, e)); } catch (_) { }
    const up = c.upload.bind(c);
    c.upload = b => { const r = up(b); try { store.set(CLOUD_KEY, JSON.stringify({ events: [...c.events.values()].slice(-2000) })); } catch (_) { } return r; };
    return c;
  }
  function makeFlaskCloud() { // the real backend: POST /api/fleet/sim/events (administrator session, stored under SIM-ROVER)
    const c = { real: true, mode: "flask", events: new Map(), stats: { batches: 0, accepted: 0, duplicates: 0, rejected: 0, ackLost: 0 } };
    c.upload = async batch => {
      c.stats.batches++;
      const r = await fetch("/api/fleet/sim/events", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: batch }) });
      let j = null; try { j = await r.json(); } catch (_) { }
      if (!r.ok || !j || !j.ok) { c.stats.rejected++; throw new Error(r.status === 401 || r.status === 403 ? "the Flask server needs an administrator login (HTTP " + r.status + ")" : (j && j.error) || "HTTP " + r.status); }
      c.stats.accepted += (j.accepted || []).length; c.stats.duplicates += (j.duplicates || []).length; (j.stored_ids || []).forEach(id => c.events.set(id, true));
      return { stored_ids: j.stored_ids || [] };
    };
    return c;
  }
  function origin() { try { const m = window.__defenxGetMap && window.__defenxGetMap(); if (m && m.getCenter) { const c = m.getCenter(); if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { lat: c.lat, lon: c.lng }; } } catch (_) { } return ORIGIN; }
  let simOrigin = ORIGIN;
  function resetSim(wipe) {
    if (wipe) { ["journal", "map"].forEach(k => { try { store.del("defenx-sim:ROVER-SIM:" + k); } catch (_) { } }); try { store.del(CLOUD_KEY); } catch (_) { } }
    scenario = scenSel.value || scenario; demoRun = null; awaitSync = null; trail = []; pickBase = false; btns.pick.textContent = "PICK BASE"; btns.pick.removeAttribute("aria-pressed");
    if (wipe || !simOrigin) simOrigin = origin();
    simCloud = makeCloud(); flaskCloud = makeFlaskCloud(); errShown = ""; if (cloudSel.value === "flask") cloud = flaskCloud; else { cloud = simCloud; cloud.mode = cloudSel.value; }
    sim = new S.RoverSim({ id: "ROVER-SIM", scenario, seed: 3, store, cloud, origin: simOrigin, restore: !wipe });
    if (!sim.restored) { sim.run(2); } // first GPS fix
    ["gpsf", "frontf"].forEach(k => { btns[k].removeAttribute("aria-pressed"); btns[k].classList.remove("on"); });
    btns.link.textContent = "GO OFFLINE"; btns.link.removeAttribute("aria-pressed");
    clearOverlay(); if (onMap) ensureOverlay();
    say(wipe ? "Simulation reset." : (sim.restored ? "Restored simulated rover from local storage (it stays idle after a power cycle)." : "Simulation ready."), "info"); refresh(true);
  }
  function toggleLink() { const up = !sim.link; sim.setLink(up); btns.link.textContent = up ? "GO OFFLINE" : "GO ONLINE"; btns.link.setAttribute("aria-pressed", String(!up)); say(up ? "Link restored. The rover will reconnect and sync its queued events." : "Link cut. The rover keeps working autonomously and journals events locally.", up ? "ok" : "warn"); if (up && sim.pending().length) awaitSync = { queued: sim.pending().length, since: sim.t }; refresh(true); }
  function toggleFault(name, b, label) { const on = !sim.faults[name]; sim.setFault(name, on); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); say(label + (on ? " injected." : " cleared."), on ? "warn" : "ok"); refresh(true); }
  function togglePick() { pickBase = !pickBase; btns.pick.textContent = pickBase ? "CLICK GRID/MAP…" : "PICK BASE"; btns.pick.setAttribute("aria-pressed", String(pickBase)); say(pickBase ? "Click a mapped (free) cell on the grid" + (onMap ? " or on the map" : "") + " to place the base." : "Base picking cancelled.", "info"); }
  function applyBase(x, y) { pickBase = false; btns.pick.textContent = "PICK BASE"; btns.pick.removeAttribute("aria-pressed"); const r = sim.setBase(x, y, Number(radius.value) || sim.base.radius); reply(r, "Base set (arrival radius " + sim.base.radius + " m)"); }
  function startOfflineDemo() {
    if (demoRun) { say("Offline test already running.", "warn"); return; }
    if (sim.state === "ESTOP") { say("Refused: e-stop active", "bad"); return; }
    if (sim.state === "IDLE" || sim.state === "COMPLETE" || sim.state === "SAFE_STOP" || sim.state === "RTB_ARRIVED") { const r = sim.state === "SAFE_STOP" ? sim.resume() : sim.startExploration(); if (!r.ok) { say("Refused: " + why(r.reason), "bad"); return; } }
    sim.setLink(false); btns.link.textContent = "GO ONLINE"; btns.link.setAttribute("aria-pressed", "true"); speedSel.value = "60"; speed = 60; paused = false; btns.pause.textContent = "PAUSE SIM";
    demoRun = { t0: sim.t, ev0: sim.seq, coll0: sim.stats.collisions }; say("Offline test running at 60×: no server contact for up to 15 simulated minutes…", "warn");
  }
  function finishOfflineDemo() {
    const s = sim.snapshot(), min = (s.link.offlineS / 60).toFixed(1); speedSel.value = "5"; speed = 5;
    say("Offline test finished after " + min + " min: " + STATE_TEXT[s.state] + (s.reason ? " (" + why(s.reason) + ")" : "") + ", explored " + Math.round(s.explored_pct) + "%, " + s.events.pending + " events queued, " + (s.collisions - demoRun.coll0) + " collisions. Press GO ONLINE to sync.", s.collisions === demoRun.coll0 ? "ok" : "bad"); demoRun = null;
  }

  /* ---------- drawing ---------- */
  const off = document.createElement("canvas"), ctx = canvas.getContext("2d"); let offCtx = null, img = null;
  function sizeCanvas() { const w = Math.max(240, Math.min(560, canvas.parentElement.clientWidth || 360)), d = window.devicePixelRatio || 1; if (canvas.width !== Math.round(w * d)) { canvas.width = Math.round(w * d); canvas.height = Math.round(w * d * sim.h / sim.w); canvas.style.height = Math.round(w * sim.h / sim.w) + "px"; } }
  function draw() {
    if (!sim || !ctx) return; sizeCanvas();
    if (off.width !== sim.w || off.height !== sim.h) { off.width = sim.w; off.height = sim.h; offCtx = off.getContext("2d"); img = offCtx.createImageData(sim.w, sim.h); }
    const d = img.data, K = sim.known, occ = sim.world.occ;
    for (let y = 0; y < sim.h; y++) for (let x = 0; x < sim.w; x++) { const i = y * sim.w + x, o = ((sim.h - 1 - y) * sim.w + x) * 4; let r = 5, g = 11, b = 17;
      if (K[i] === 2) { r = 255; g = 80; b = 96; } else if (K[i] === 1) { r = 22; g = 66; b = 88; } else if (showTruth && occ[i]) { r = 75; g = 85; b = 95; }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; }
    offCtx.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    const sc = canvas.width / (sim.w * CELL), P = (x, y) => [x * sc, canvas.height - y * sc], s = sim.snapshot();
    // base + arrival radius
    const bp = P(s.base.x, s.base.y); ctx.strokeStyle = "#22d3a6"; ctx.fillStyle = "rgba(34,211,166,.12)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(bp[0], bp[1], s.base.radius * sc, 0, 7); ctx.fill(); ctx.stroke(); ctx.fillStyle = "#22d3a6"; ctx.font = (11 * (window.devicePixelRatio || 1)) + "px sans-serif"; ctx.fillText("BASE", bp[0] - 14, bp[1] + 4);
    // planned route
    if (s.path.length) { ctx.strokeStyle = "#4dc3ff"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.beginPath(); const p0 = P(s.est.x, s.est.y); ctx.moveTo(p0[0], p0[1]); s.path.forEach(c => { const p = P(c.x, c.y); ctx.lineTo(p[0], p[1]); }); ctx.stroke(); ctx.setLineDash([]); }
    // trail
    if (trail.length > 1) { ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1.5; ctx.beginPath(); trail.forEach((c, i) => { const p = P(c[0], c[1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.stroke(); }
    // sensor beams
    const names = [["front", 0], ["left", Math.PI / 4], ["right", -Math.PI / 4]]; ctx.lineWidth = 1;
    names.forEach(n => { const sn = s.sensors[n[0]]; if (!sn.valid) return; const a = s.pose.h + n[1], e = P(s.pose.x + Math.cos(a) * sn.m, s.pose.y + Math.sin(a) * sn.m), p = P(s.pose.x, s.pose.y); ctx.strokeStyle = sn.m < 1 ? "#ff314a" : "rgba(245,185,66,.6)"; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(e[0], e[1]); ctx.stroke(); });
    // rover
    const rp = P(s.pose.x, s.pose.y), a = -s.pose.h, L = 9 * (window.devicePixelRatio || 1); ctx.save(); ctx.translate(rp[0], rp[1]); ctx.rotate(a); ctx.fillStyle = s.state === "SAFE_STOP" || s.state === "ESTOP" ? "#ff314a" : "#ffffff"; ctx.beginPath(); ctx.moveTo(L, 0); ctx.lineTo(-L * .7, L * .6); ctx.lineTo(-L * .7, -L * .6); ctx.closePath(); ctx.fill(); ctx.restore();
    canvas.setAttribute("aria-label", "Simulated rover map. State " + (STATE_TEXT[s.state] || s.state) + ", explored " + Math.round(s.explored_pct) + " percent.");
  }
  function refresh(force) {
    if (!sim) return; const s = sim.snapshot(), set = (k, v, t) => { cells[k].textContent = v; if (t) cells[k].dataset.t = t; else delete cells[k].dataset.t; };
    chipNet.textContent = s.link.net; chipNet.className = "simChip " + (s.link.net === "ONLINE" ? "simChipOk" : "simChipBad");
    set("LINK", s.link.net + (s.link.up ? "" : " (cut)"), s.link.net === "ONLINE" ? "ok" : "warn");
    set("STATE", (STATE_TEXT[s.state] || s.state) + (s.reason ? " · " + why(s.reason) : ""), s.state === "SAFE_STOP" || s.state === "ESTOP" ? "bad" : s.state === "RTB_ARRIVED" ? "ok" : "");
    set("GPS", s.gps.fix ? "FIX ±" + s.gps.acc + " m" : "NO FIX", s.gps.fix ? "ok" : "bad");
    const f = k => s.sensors[k].valid ? Math.round(s.sensors[k].m * 100) + "" : "FAULT"; set("SENSORS F/L/R", f("front") + " / " + f("left") + " / " + f("right") + " cm", s.faults.front || s.faults.left || s.faults.right ? "bad" : "");
    set("BATTERY", s.battery.toFixed(1) + "%", s.battery < 25 ? "warn" : "ok");
    set("SIM TIME", Math.floor(s.t / 60) + "m " + String(Math.floor(s.t % 60)).padStart(2, "0") + "s");
    set("EXPLORED", s.explored_pct.toFixed(0) + "% (sim truth)");
    set("EVENTS QUEUED/SYNCED", s.events.pending + " / " + (cloud ? cloud.events.size : 0), s.events.pending ? "warn" : "ok");
    set("OFFLINE AUTONOMY", s.link.net === "OFFLINE" ? "offline " + Math.floor(s.link.offlineS / 60) + "m " + String(Math.floor(s.link.offlineS % 60)).padStart(2, "0") + "s · " + Math.max(0, Math.round(s.link.autonomyLeftS)) + " s left" : "online", s.link.net === "OFFLINE" ? "warn" : "ok");
    const rt = s.rtb; set("RETURN TO BASE", !rt ? "NOT ACTIVE" : rt.arrived ? "ARRIVED (rover reported stopped inside " + s.base.radius + " m)" : rt.state === "FAILED" ? "FAILED · " + why(rt.reason) : rt.state + " · " + Math.round(rt.remaining_m) + " m left · " + Math.round(rt.progress_pct) + "%", rt && rt.arrived ? "ok" : rt && rt.state === "FAILED" ? "bad" : "");
    const g = (id, dis) => { btns[id].disabled = !!dis; };
    const est = s.state === "ESTOP", busy = !!demoRun;
    g("start", est || busy); g("stop", est); g("resume", s.state !== "SAFE_STOP" || busy); g("rtb", est || busy); g("cancelrtb", s.mode !== "RTB"); g("estopr", !est); g("estop", est); g("offdemo", est || busy); g("setbase", false);
    if (force || cells.STATE.dataset.rendered !== String(sim.seq)) { renderLog(); cells.STATE.dataset.rendered = String(sim.seq); }
    if (cloud && cloud.real && sim.lastSyncError && sim.lastSyncError !== errShown && s.events.pending) { errShown = sim.lastSyncError; say("Flask sync failed (events stay queued and retry): " + sim.lastSyncError, "bad"); }
    if (awaitSync && sim.link && s.link.net === "ONLINE" && !s.events.pending) { say("Reconnected: " + awaitSync.queued + " queued events synchronised. Server holds " + cloud.events.size + " unique events, " + cloud.stats.duplicates + " duplicates, 0 lost.", "ok"); awaitSync = null; }
  }
  function renderLog() {
    log.textContent = ""; const ev = sim.events.slice(-10).reverse(); if (!ev.length) { log.appendChild($("div", { className: "simLogRow", textContent: "No events yet." })); return; }
    ev.forEach(e => { const r = $("div", { className: "simLogRow" }, [$("i", { textContent: e.acked ? "✓" : "…" }), $("span", { textContent: new Date(e.t * 1000).toISOString().slice(11, 19) + (e.offline ? " ⌁" : "") + "  " + e.type.toUpperCase() + " — " + e.message })]); r.dataset.sev = e.severity; log.appendChild(r); });
  }

  /* ---------- Leaflet overlay on the dashboard map (optional) ---------- */
  function getMap() { try { return window.L && window.__defenxGetMap && window.__defenxGetMap(); } catch (_) { return null; } }
  function ensureOverlay() {
    const m = getMap(), L = window.L; if (!m || !L) { say("The live map is not available, so the overlay stays on the grid.", "warn"); mapChk.checked = false; onMap = false; return false; }
    if (mapLayers) return true;
    const g = L.layerGroup().addTo(m), ico = L.divIcon({ className: "simRoverIcon", html: "<div>▲</div>", iconSize: [26, 26], iconAnchor: [13, 13] });
    mapLayers = { g, rover: L.marker([simOrigin.lat, simOrigin.lon], { icon: ico, interactive: false, zIndexOffset: 900 }).addTo(g), track: L.polyline([], { color: "#ffffff", weight: 2, opacity: .6 }).addTo(g), route: L.polyline([], { color: "#4dc3ff", weight: 3, dashArray: "6 6" }).addTo(g),
      base: L.circle([simOrigin.lat, simOrigin.lon], { radius: 2.5, color: "#22d3a6", fillOpacity: .15, weight: 2 }).addTo(g), line: L.polyline([], { color: "#f5b942", weight: 2, dashArray: "2 6" }).addTo(g), world: L.rectangle(worldBounds(), { color: "#ff9f1c", weight: 1, fill: false, dashArray: "4 4", interactive: false }).addTo(g) };
    mapLayers.base.bindTooltip("SIM BASE", { permanent: true, direction: "top" }); mapLayers.line.bindTooltip("", { permanent: true, direction: "center" });
    try { m.fitBounds(mapLayers.world.getBounds(), { maxZoom: 19, padding: [20, 20] }); } catch (_) { }
    mapClickBound = e => { if (!pickBase || !e || !e.latlng) return; const p = S.fromLatLon(simOrigin, e.latlng.lat, e.latlng.lng); applyBase(p.x, p.y); }; m.on("click", mapClickBound); return true;
  }
  function worldBounds() { const a = S.toLatLon(simOrigin, 0, 0), b = S.toLatLon(simOrigin, sim.w * CELL, sim.h * CELL); return [[a.lat, a.lon], [b.lat, b.lon]]; }
  function clearOverlay() { const m = getMap(); if (mapLayers) { try { if (m && mapClickBound) m.off("click", mapClickBound); m && m.removeLayer(mapLayers.g); } catch (_) { } } mapLayers = null; mapClickBound = null; }
  function updateOverlay(s) {
    if (!mapLayers) return; const ll = (x, y) => { const p = S.toLatLon(simOrigin, x, y); return [p.lat, p.lon]; };
    mapLayers.rover.setLatLng(ll(s.pose.x, s.pose.y)); const el = mapLayers.rover.getElement && mapLayers.rover.getElement(); if (el && el.firstChild) el.firstChild.style.transform = "rotate(" + s.pose.bearing + "deg)";
    mapLayers.track.setLatLngs(trail.map(c => ll(c[0], c[1]))); mapLayers.route.setLatLngs(s.path.length ? [ll(s.est.x, s.est.y)].concat(s.path.map(c => ll(c.x, c.y))) : []);
    mapLayers.base.setLatLng(ll(s.base.x, s.base.y)); mapLayers.base.setRadius(s.base.radius);
    const d = Math.hypot(s.pose.x - s.base.x, s.pose.y - s.base.y); mapLayers.line.setLatLngs([ll(s.pose.x, s.pose.y), ll(s.base.x, s.base.y)]); mapLayers.line.setTooltipContent(d.toFixed(1) + " m to base · bearing " + Math.round((Math.atan2(s.base.x - s.pose.x, s.base.y - s.pose.y) * 180 / Math.PI + 360) % 360) + "°");
  }

  /* ---------- loop + events ---------- */
  function frame(ts) {
    raf = requestAnimationFrame(frame); if (!sim) return; const dt = Math.min(0.25, (ts - lastT) / 1000 || 0); lastT = ts;
    if (!paused) {
      acc += dt * speed; let n = 0; while (acc >= 0.1 && n < 600) { sim.step(0.1); acc -= 0.1; n++; if ((sim.stats.ticks % 5) === 0) trail.push([sim.truth.x, sim.truth.y]); if (demoRun && (sim.offlineSeconds() >= 900 || sim.state === "SAFE_STOP" || sim.state === "COMPLETE" || sim.state === "ESTOP")) { finishOfflineDemo(); break; } }
      if (acc > 1) acc = 0; if (trail.length > 600) trail.splice(0, trail.length - 600);
    }
    draw(); uiTick += dt; if (uiTick >= 0.25) { uiTick = 0; refresh(false); } mapTick += dt; if (mapTick >= 0.25) { mapTick = 0; updateOverlay(sim.snapshot()); }
  }
  canvas.addEventListener("click", e => { if (!pickBase || !sim) return; const r = canvas.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height; applyBase(fx * sim.w * CELL, (1 - fy) * sim.h * CELL); });
  scenSel.addEventListener("change", () => { resetSim(true); });
  speedSel.addEventListener("change", () => { speed = Number(speedSel.value) || 1; });
  cloudSel.addEventListener("change", () => {
    if (!sim) return; const v = cloudSel.value; cloud = v === "flask" ? flaskCloud : simCloud; if (v !== "flask") cloud.mode = v; sim.o.cloud = cloud; errShown = "";
    say(v === "ok" ? "Simulated cloud is healthy." : v === "lose_ack" ? "Simulated cloud will store uploads but lose the replies (tests duplicate protection)." : v === "reject" ? "Simulated cloud will reject uploads (events stay queued and retry)." : "Events now sync to the real Flask backend (/api/fleet/sim/events, stored under SIM-ROVER). Needs an administrator login.", v === "ok" ? "ok" : "warn"); refresh(true);
  });
  mapChk.addEventListener("change", () => { onMap = mapChk.checked; if (onMap) { if (!ensureOverlay()) onMap = false; else say("Simulated rover is drawn on the live map, labelled as a simulation.", "info"); } else clearOverlay(); });
  truthChk.addEventListener("change", () => { showTruth = truthChk.checked; });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && pickBase) togglePick(); });

  resetSim(false); raf = requestAnimationFrame(frame);
  window.__defenxSimLab = { sim: () => sim, cloud: () => cloud, advance: sec => { sim.run(sec); draw(); refresh(true); }, pickBaseAt: (x, y) => applyBase(x, y), overlay: () => mapLayers };
})();
