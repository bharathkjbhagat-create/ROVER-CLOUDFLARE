/* DEFENX fleet & autonomy panel. Everything displayed comes from /api/fleet/state (authenticated device
 * heartbeats). Missing data is shown as unavailable - never invented. Arrival is shown only when the
 * rover itself reports RTB_ARRIVED. Uses textContent only (no innerHTML with server data). */
(() => {
  "use strict";
  // Must match app.js: "/" and "/demo" are the read-only simulation views; the authenticated dashboard is /index.html.
  const demo = location.pathname === "/" || location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  const mount = document.getElementById("fleetMount");
  if (!mount || demo) { if (mount) mount.hidden = true; return; }
  const $ = (t, props, kids) => { const e = document.createElement(t); Object.assign(e, props || {}); (kids || []).forEach(k => e.appendChild(k)); return e; };
  let data = null, fails = 0, pollTimer = null, me = null, primary = "ROVER-01", busy = false;
  const FLEET_CMDS = new Set(["FORWARD", "REVERSE", "LEFT", "RIGHT", "STOP", "EMERGENCY_STOP", "RESET_ESTOP", "RETURN_TO_BASE", "CANCEL_RETURN"]);

  const conn = $("span", { className: "fleetConn", textContent: "CONNECTING" }); conn.dataset.s = "connecting";
  const banner = $("div", { className: "fleetBanner" });
  const cells = {}; const grid = $("div", { className: "fleetGrid" });
  ["LINK", "STATE", "GPS", "OBSTACLE", "BATTERY", "CAMERA", "RETURN TO BASE", "OFFLINE QUEUE"].forEach(k => {
    const b = $("b", { textContent: "—" }); cells[k] = b; grid.appendChild($("div", {}, [$("span", { textContent: k }), b]));
  });
  const msg = $("div", { className: "fleetBanner", id: "fleetMsg" });
  const actions = $("div", { className: "fleetActions" });
  const btn = (label, cls, fn) => { const b = $("button", { type: "button", textContent: label, className: cls || "" }); b.addEventListener("click", async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } }); return b; };
  const list = $("div", { className: "fleetList" }), events = $("div", { className: "fleetEvents" });
  const secretBox = $("div", { className: "fleetSecret" });
  const addId = $("input", { placeholder: "Device ID e.g. PHONE-01", maxLength: 32, autocomplete: "off" });
  const addName = $("input", { placeholder: "Name", maxLength: 60 });
  const addRole = $("select"); ["rover", "phone", "sensor", "camera"].forEach(r => addRole.appendChild($("option", { value: r, textContent: r.toUpperCase() })));
  const addForm = $("div", { className: "fleetAdd" }, [addId, addName, addRole, btn("REGISTER DEVICE", "", registerDevice)]);
  mount.className = "card fleetCard"; mount.id = "fleetSection";
  mount.append($("div", { className: "cardHeader" }, [$("b", { textContent: "FLEET & AUTONOMY" }), conn]), banner, grid, msg, actions, list, secretBox, addForm,
    $("div", { className: "cardHeader" }, [$("b", { textContent: "DEVICE EVENTS (PERSISTED)" })]), events,
    $("div", { className: "fleetList" }, [$("small", { textContent: "Phones join via /device-client.html. Device secrets are shown once." })]));

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store" }, opts || {}, opts && opts.body ? { headers: { "Content-Type": "application/json" } } : {}));
    let j = {}; try { j = await r.json(); } catch (_) {}
    return { r, j };
  }
  const rover = () => data && data.devices.find(d => d.id === primary);
  const active = () => !!(data && data.enabled && rover());
  function say(text, tone) { msg.textContent = text; msg.dataset.t = tone || "warn"; msg.classList.toggle("show", !!text); }
  async function command(cmd) {
    cmd = String(cmd).toUpperCase(); if (!FLEET_CMDS.has(cmd)) return { ok: false, message: "Unsupported fleet command" };
    try {
      const { r, j } = await api("/api/fleet/command", { method: "POST", body: JSON.stringify({ device_id: primary, command: cmd }) });
      if (!r.ok) { const m = (j.reasons && j.reasons.length) ? j.reasons.join("; ") : (j.error || "refused"); say(cmd + " refused: " + m, "bad"); return { ok: false, message: m }; }
      say(cmd + " sent - waiting for rover acknowledgement", "warn"); poll(true); return { ok: true };
    } catch (_) { say("Command not sent: server unreachable", "bad"); return { ok: false, message: "server unreachable" }; }
  }
  async function saveBase(lat, lon) {
    const { r, j } = await api("/api/fleet/base", { method: "POST", body: JSON.stringify({ lat, lon }) });
    say(r.ok ? "Base saved on server" : "Base not saved: " + (j.error || r.status), r.ok ? "ok" : "bad"); poll(true); return r.ok;
  }
  async function saveBaseFromRover() {
    const s = rover() && rover().status;
    if (!s || !s.gps_valid || s.accuracy_m === undefined || s.accuracy_m > 15) { say("Cannot save base: rover has no valid, accurate GPS fix right now", "bad"); return; }
    if (!confirm("Save the rover's CURRENT GPS position as the base?")) return; await saveBase(s.lat, s.lon);
  }
  async function returnToBase() {
    const res = await command("RETURN_TO_BASE");
    return res;
  }
  async function registerDevice() {
    const body = { id: addId.value.trim(), name: addName.value.trim() || addId.value.trim(), role: addRole.value };
    const { r, j } = await api("/api/fleet/devices", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) { say("Register failed: " + (j.error || r.status), "bad"); return; }
    secretBox.style.display = "block"; secretBox.textContent = "";
    secretBox.append($("b", { textContent: "DEVICE SECRET FOR " + j.device.id + " (shown once):" }), $("br"), document.createTextNode(j.secret), $("br"),
      $("small", { textContent: "Put it in firmware/esp32_rover/config.h or the device client. It cannot be retrieved again." }));
    addId.value = ""; addName.value = ""; poll(true);
  }
  async function deviceAction(id, kind) {
    if (kind === "revoke" && !confirm("Revoke " + id + "? It will be disconnected immediately.")) return;
    const { r, j } = kind === "revoke" ? await api("/api/fleet/devices/" + encodeURIComponent(id), { method: "DELETE" }) : await api("/api/fleet/devices/" + encodeURIComponent(id) + "/rotate", { method: "POST", body: "{}" });
    if (!r.ok) { say(kind + " failed: " + (j.error || r.status), "bad"); return; }
    if (j.secret) { secretBox.style.display = "block"; secretBox.textContent = "NEW SECRET FOR " + id + " (shown once): " + j.secret; }
    poll(true);
  }

  const set = (k, text, tone) => { cells[k].textContent = text; cells[k].dataset.t = tone || ""; };
  function render() {
    const r = rover(), s = r && r.status;
    list.textContent = "";
    (data.devices || []).forEach(d => {
      const st = d.status, row = $("div", { className: "fleetDev" });
      const left = $("span", {}, [$("b", { textContent: d.id }), $("small", { textContent: " " + d.role.toUpperCase() + (st && st.sim ? " · SIMULATOR" : "") })]);
      const mid = $("span", { className: d.online ? "on" : "off", textContent: d.online ? "● ONLINE" : "● OFFLINE" });
      const info = $("small", { textContent: st ? (st.battery !== undefined ? Math.round(st.battery) + "% · " : "") + (st.gps_valid ? st.lat.toFixed(4) + "," + st.lon.toFixed(4) : "no GPS") + " · " + Math.round(st.age_s) + "s ago" : "never connected" });
      const ctl = $("span");
      if (me && me.role === "admin") { const rb = btn("ROTATE", "", () => deviceAction(d.id, "rotate")), vb = btn("REVOKE", "", () => deviceAction(d.id, "revoke")); ctl.append(rb, vb); }
      row.append(left, mid, info, ctl); list.appendChild(row);
    });
    if (!data.enabled) { banner.className = "fleetBanner show"; banner.dataset.t = "warn"; banner.textContent = "Fleet service not configured: set FLEET_MASTER_SECRET on the server."; }
    else if (!r) { banner.className = "fleetBanner show"; banner.dataset.t = "warn"; banner.textContent = "No rover registered as " + primary + ". Register it below, then flash its firmware."; }
    else banner.className = "fleetBanner";
    if (!r || !s) { Object.keys(cells).forEach(k => set(k, r ? "NO DATA YET" : "—", "warn")); actionsState(false); return; }
    const online = r.online, fsm = s.fsm || "UNKNOWN";
    set("LINK", !online ? "ROVER OFFLINE" : (s.offline_autonomy ? "OFFLINE AUTONOMY (" + (s.link || "no server") + ")" : "ONLINE"), !online ? "bad" : (s.offline_autonomy ? "warn" : "ok"));
    set("STATE", s.estop ? "EMERGENCY STOP" : fsm.replace(/_/g, " "), s.estop || /FAILED|PAUSED/.test(fsm) ? "bad" : (/RTB/.test(fsm) ? "warn" : "ok"));
    set("GPS", s.gps_valid ? ("FIX · ±" + (s.accuracy_m !== undefined ? s.accuracy_m.toFixed(1) : "?") + " m · " + (s.gps_sats !== undefined ? s.gps_sats : "?") + " sats") : "GPS UNAVAILABLE", s.gps_valid ? "ok" : "bad");
    const o = s.obstacle || {}, f = o.front, fcap = s.caps && s.caps.obstacle_sensor_healthy;
    set("OBSTACLE", !f || !f.valid || fcap === false ? "SENSOR FAULT / NO DATA" : "F " + Math.round(f.cm) + " cm" + (o.left && o.left.valid ? " · L " + Math.round(o.left.cm) : "") + (o.right && o.right.valid ? " · R " + Math.round(o.right.cm) : ""), (!f || !f.valid || fcap === false) ? "bad" : (f.cm < 40 ? "warn" : "ok"));
    set("BATTERY", s.battery !== undefined ? Math.round(s.battery) + "%" : "UNKNOWN", s.battery === undefined || s.battery < 20 ? "bad" : (s.battery < 35 ? "warn" : "ok"));
    set("CAMERA", s.camera === true ? "LIVE" : "CAMERA UNAVAILABLE", s.camera === true ? "ok" : "bad");
    const rtb = s.rtb;
    let rtbText = "IDLE", rtbTone = "";
    if (fsm === "RTB_ARRIVED") { rtbText = "ARRIVED · CONFIRMED BY ROVER"; rtbTone = "ok"; }
    else if (/^RTB/.test(fsm)) { rtbText = "RETURN-TO-BASE ACTIVE" + (rtb && rtb.distance_m ? " · " + Math.round(rtb.distance_m) + " m" : ""); rtbTone = "warn"; }
    else if (/FAILED|PAUSED/.test(fsm)) { rtbText = "STOPPED · " + (s.fsm_reason || fsm).replace(/_/g, " "); rtbTone = "bad"; }
    set("RETURN TO BASE", rtbText, rtbTone);
    set("OFFLINE QUEUE", s.pending_events !== undefined ? s.pending_events + " event(s) waiting" : "—", s.pending_events > 0 ? "warn" : "");
    actionsState(online);
    const el = document.getElementById("returnBaseStatus");
    if (el && (/^RTB/.test(fsm) || /FAILED|PAUSED/.test(fsm))) el.textContent = rtbText;
    const saved = data.base ? "BASE SAVED ON SERVER · " + data.base.lat.toFixed(5) + ", " + data.base.lon.toFixed(5) : "BASE NOT SET";
    if (el && !/^RTB/.test(fsm) && !/FAILED|PAUSED/.test(fsm)) el.textContent = fsm === "RTB_ARRIVED" ? "ARRIVED · DEVICE CONFIRMED" : saved;
  }
  let baseBtn, cancelBtn, resetBtn, estopBtn; // RETURN TO BASE lives only on the Return card (#returnToBaseBtn); a second button here duplicated it
  function buildActions() {
    estopBtn = btn("■ EMERGENCY STOP", "estop", () => command("EMERGENCY_STOP"));
    resetBtn = btn("RESET E-STOP", "", () => confirm("Reset the emergency stop? The rover will stay stopped until you give a new command.") && command("RESET_ESTOP"));
    baseBtn = btn("SAVE BASE = ROVER GPS", "", saveBaseFromRover);
    cancelBtn = btn("CANCEL RETURN", "", () => command("CANCEL_RETURN"));
    actions.append(estopBtn, resetBtn, cancelBtn, baseBtn);
  }
  function actionsState(online) { estopBtn.disabled = false; /* E-STOP is never disabled; server queues it even offline */ const admin = me && me.role === "admin"; [resetBtn, baseBtn].forEach(b => { b.disabled = !admin || !online; }); cancelBtn.disabled = false; }
  async function loadEvents() {
    try { const { r, j } = await api("/api/fleet/events?limit=12"); if (!r.ok) return; events.textContent = "";
      j.events.forEach(e => events.appendChild($("div", { className: e.severity, textContent: new Date((e.received_at || e.t) * 1000).toLocaleTimeString() + " " + e.device_id + " · " + e.type + (e.offline ? " [offline-recorded]" : "") + (e.message ? " · " + e.message : "") }))); } catch (_) {}
  }
  let evTick = 0;
  async function poll(now) {
    if (busy && !now) return; busy = true; clearTimeout(pollTimer);
    try {
      const { r, j } = await api("/api/fleet/state");
      if (!r.ok) throw new Error("http " + r.status);
      data = j; primary = j.primary || primary; fails = 0; conn.dataset.s = "online"; conn.textContent = "SYNCED"; render();
      if (evTick++ % 4 === 0) loadEvents();
    } catch (_) { fails++; conn.dataset.s = fails > 2 ? "offline" : "reconnecting"; conn.textContent = fails > 2 ? "SERVER OFFLINE" : "RECONNECTING"; }
    busy = false; pollTimer = setTimeout(poll, document.hidden ? 6000 : 1500);
  }
  buildActions();
  fetch("/api/me", { credentials: "same-origin" }).then(r => r.json()).then(j => { me = j.user || j; actionsState(false); poll(true); }).catch(() => poll(true));
  window.DEFENX_FLEET = { active, command, returnToBase, saveBase, get primary() { return primary; } };
})();

