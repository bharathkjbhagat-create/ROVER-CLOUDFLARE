/* DEFENX phone/browser device client. Runs on a real phone: real GPS (Geolocation), real battery and
 * network info where the browser exposes them. Sends signed heartbeats, verifies signed server replies,
 * keeps an offline event queue and uploads it idempotently after reconnect. No camera frames are sent. */
(() => {
  "use strict";
  const P = window.DefenxFleetProtocol, $ = id => document.getElementById(id);
  const QKEY = "defenx_device_queue_v1", HB = "/api/fleet/heartbeat";
  let timer = null, running = false, seq = 0, evCounter = 0, bootId = "", gps = null, watchId = null, backoff = 1500;
  let secret = "", deviceId = "", lastOk = 0, offlineSince = null, camOn = false, camStream = null, queue = [];
  const log = m => { const l = $("log"); l.textContent = new Date().toLocaleTimeString() + "  " + m + "\n" + l.textContent.slice(0, 3000); };
  const setState = (t, cls) => { const s = $("state"); s.textContent = t; s.className = "pill " + (cls || ""); };
  const loadQ = () => { try { queue = JSON.parse(localStorage.getItem(QKEY) || "[]").filter(e => e && e.id); } catch (_) { queue = []; } };
  const saveQ = () => { try { localStorage.setItem(QKEY, JSON.stringify(queue.slice(-400))); } catch (_) {} };
  function record(type, message, severity, data, offline) {
    evCounter++; queue.push({ id: bootId + "-" + String(evCounter).padStart(6, "0"), type, message: String(message).slice(0, 200),
      severity: severity || "info", t: Date.now() / 1000, offline: !!offline, ...(data ? { data } : {}) }); saveQ(); renderQ();
  }
  const renderQ = () => { $("queued").textContent = String(queue.length); };

  async function post(path, payload) {
    const body = P.enc.encode(JSON.stringify(payload));
    const ts = String(Date.now() / 1000), n = P.nonce();
    const sig = await P.signRequest(secret, "POST", path, deviceId, ts, n, body);
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000);
    let res;
    try {
      res = await fetch(path, { method: "POST", body, signal: ctl.signal, cache: "no-store", credentials: "omit",
        headers: { "Content-Type": "application/json", "X-Device-Id": deviceId, "X-Timestamp": ts, "X-Nonce": n, "X-Signature": sig } });
    } finally { clearTimeout(to); }
    const raw = new Uint8Array(await res.arrayBuffer());
    if (res.status === 401) { const e = new Error("credentials rejected or clock skew"); e.auth = true; throw e; }
    const expect = await P.signResponse(secret, deviceId, n, raw);
    if (!P.timingSafeEqualHex(expect, res.headers.get("X-Server-Signature") || "")) { const e = new Error("server signature invalid"); e.auth = true; throw e; }
    return { status: res.status, data: JSON.parse(new TextDecoder().decode(raw)) };
  }

  async function battery() { try { const b = await navigator.getBattery(); return Math.round(b.level * 100); } catch (_) { return undefined; } }
  function snapshot(batt) {
    const c = navigator.connection || {}; const s = { fsm: "IDLE", camera: camOn, network: c.effectiveType || (navigator.onLine ? "online" : "offline"), fw: "web-device-1" };
    if (batt !== undefined) s.battery = batt;
    if (c.downlink) s.signal = Math.max(0, Math.min(100, Math.round(c.downlink * 10)));
    if (gps) { s.lat = gps.latitude; s.lon = gps.longitude; s.gps_fix = true; s.accuracy_m = gps.accuracy; s.gps_age_ms = Math.max(0, Date.now() - gps.t);
      if (Number.isFinite(gps.speed) && gps.speed !== null) s.speed_kmh = gps.speed * 3.6; if (Number.isFinite(gps.heading) && gps.heading !== null) s.heading = gps.heading; }
    else s.gps_fix = false;
    return s;
  }
  async function flush() {
    while (queue.length && running) {
      const chunk = queue.slice(0, 20), r = await post("/api/fleet/events/upload", { events: chunk });
      if (r.status !== 200) throw new Error("event upload " + r.status);
      const stored = new Set(r.data.stored_ids || []); queue = queue.filter(e => !stored.has(e.id)); saveQ(); renderQ();
      if (!stored.size) break;
    }
  }
  const peerRows = new Map();
  function renderPeers(peers) {
    const box = $("peers");
    const seen = new Set();
    for (const p of peers) {
      const id = String(p.id);
      seen.add(id);
      let row = peerRows.get(id);
      if (!row) { row = document.createElement("div"); row.className = "peer"; peerRows.set(id, row); }
      row.textContent = id + " (" + p.role + ") — " + (p.online ? "ONLINE" : "OFFLINE") +
        (p.lat !== undefined ? " · " + p.lat.toFixed(5) + ", " + p.lon.toFixed(5) : " · no GPS") +
        (p.battery !== undefined ? " · " + Math.round(p.battery) + "%" : "") + (p.estop ? " · E-STOP" : "");
      box.appendChild(row);
    }
    for (const [id, row] of peerRows) {
      if (seen.has(id)) continue;
      row.remove(); peerRows.delete(id);
    }
    if (!peers.length) {
      peerRows.clear();
      box.textContent = "No other devices registered yet.";
    }
  }
  async function tick() {
    if (!running) return;
    try {
      seq++;
      const r = await post(HB, { ...snapshot(await battery()), seq, boot_id: bootId, pending_events: queue.length });
      if (r.status === 409 && /stale|duplicate/i.test(r.data.error || "")) { seq = (r.data.last_seq || seq) + 1; }
      else if (r.status !== 200) throw new Error(r.data.error || ("HTTP " + r.status));
      else {
        lastOk = Date.now(); backoff = 1500;
        if (offlineSince) { record("link_restored", "Reconnected after " + Math.round((Date.now() - offlineSince) / 1000) + "s", "info", null, true); offlineSince = null; log("Reconnected - syncing queued events"); }
        setState("ONLINE", "ok"); renderPeers(r.data.peers || []);
        (r.data.commands || []).forEach(c => log("Command received (ignored by phone): " + c.command));
        await flush();
      }
    } catch (e) {
      if (e.auth) { setState("AUTH ERROR", "bad"); log("Authentication problem: " + e.message); backoff = 15000; }
      else {
        if (!offlineSince) { offlineSince = Date.now(); record("link_lost", "Server unreachable; queueing events locally", "warn", null, true); }
        setState(navigator.onLine ? "SERVER UNREACHABLE · RECONNECTING" : "NO NETWORK · RECONNECTING", "warn"); backoff = Math.min(backoff * 1.7, 10000);
      }
    }
    if (running) timer = setTimeout(tick, backoff);
  }
  function startGps() {
    if (!navigator.geolocation) { log("Geolocation unavailable in this browser"); return; }
    watchId = navigator.geolocation.watchPosition(p => { gps = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy,
      speed: p.coords.speed, heading: p.coords.heading, t: Date.now() }; $("gps").textContent = gps.latitude.toFixed(5) + ", " + gps.longitude.toFixed(5) + " ±" + Math.round(gps.accuracy) + "m"; },
      e => { gps = null; $("gps").textContent = e.code === 1 ? "PERMISSION DENIED" : "UNAVAILABLE"; record("gps_error", "GPS error " + e.code, "warn", null, !!offlineSince); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  }
  async function toggleCam() {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; camOn = false; $("cam").textContent = "Camera status: off"; return; }
    try { camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: $("facing").value } , audio: false}); camOn = true;
      camStream.getVideoTracks()[0].addEventListener("ended", () => { camOn = false; $("cam").textContent = "Camera status: disconnected"; record("camera_lost", "Camera track ended", "warn", null, !!offlineSince); });
      $("cam").textContent = "Camera status: live (frames are NOT uploaded)"; }
    catch (e) { camOn = false; $("cam").textContent = "Camera unavailable: " + (e && e.name === "NotAllowedError" ? "permission denied" : (e && e.name) || "error"); }
  }
  function start() {
    deviceId = $("deviceId").value.trim(); secret = $("secret").value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(deviceId) || !/^[0-9a-f]{64}$/.test(secret)) { log("Enter the Device ID and the 64-character secret from the dashboard"); return; }
    try { (($("remember").checked ? localStorage : sessionStorage)).setItem("defenx_device_cfg", JSON.stringify({ deviceId, secret })); if (!$("remember").checked) localStorage.removeItem("defenx_device_cfg"); } catch (_) {}
    bootId = Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(16).padStart(2, "0")).join(""); seq = 0; evCounter = 0;
    loadQ(); renderQ(); running = true; setState("CONNECTING", "warn"); $("startBtn").disabled = true; $("stopBtn").disabled = false; startGps(); tick();
  }
  function stop() { running = false; clearTimeout(timer); if (watchId !== null) navigator.geolocation.clearWatch(watchId); setState("STOPPED"); $("startBtn").disabled = false; $("stopBtn").disabled = true; }
  window.addEventListener("online", () => { if (running) { clearTimeout(timer); backoff = 500; tick(); } });
  document.addEventListener("DOMContentLoaded", () => {
    try { const c = JSON.parse(sessionStorage.getItem("defenx_device_cfg") || localStorage.getItem("defenx_device_cfg") || "null"); if (c) { $("deviceId").value = c.deviceId; $("secret").value = c.secret; } } catch (_) {}
    $("startBtn").addEventListener("click", start); $("stopBtn").addEventListener("click", stop); $("camBtn").addEventListener("click", toggleCam); loadQ(); renderQ();
  });
})();
