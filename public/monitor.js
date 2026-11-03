/* DEFENX full-screen monitoring view.
 * Self-contained module: reuses the dashboard's existing camera element and the
 * telemetry already received by app.js (via the "defenx-telemetry" event).
 * Nothing here simulates a camera feed or a GPS position.
 */
(function () {
  "use strict";
  if (window.__defenxMonitor) return;
  window.__defenxMonitor = true;

  var demo = location.pathname === "/" || location.pathname === "/demo" ||
    new URLSearchParams(location.search).get("demo") === "1";
  var $ = function (id) { return document.getElementById(id); };

  var ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  var OSM = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  var st = {
    open: false, built: false, cfg: null, cfgBusy: false, cfgAt: 0,
    tel: null, telAt: 0,
    cam: { state: "idle", attempts: 0, timer: null },
    prevKey: "", prevLink: "",
    map: null, sat: null, std: null, useSat: true, tileErr: 0,
    marker: null, acc: null, trail: null, trailPts: [], lastFix: null,
    bearing: null, follow: true, firstFix: false,
    autoFs: false, lastFocus: null, pushed: false
  };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : (typeof v === "string" && v.trim() !== "" && isFinite(+v) ? +v : null); }
  function setText(id, t) { var e = $(id); if (e && e.textContent !== t) e.textContent = t; }
  function toRad(x) { return x * Math.PI / 180; }
  function distM(a, b) {
    var R = 6371000, dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearingDeg(a, b) {
    var y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
    var x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function toast(msg, kind) {
    var host = $("mvToasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "mvToasts"; host.setAttribute("aria-live", "polite"); host.setAttribute("role", "status");
      document.body.appendChild(host);
    }
    var t = document.createElement("div");
    t.className = "mv-toast" + (kind ? " " + kind : "");
    t.textContent = msg;
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
  }

  /* ---------- telemetry interpretation (honest: only what is reported) ---------- */
  function roverReporting(t) {
    // Backend defaults are simulated; treat values as real only when the rover device itself has reported.
    return !!t && t.device_online !== false &&
      (t.gps_source === "ROVER_DEVICE" || t.camera_source === "ROVER_DEVICE" || t.target_source === "ROVER_DEVICE" || !!t.gps_source_id);
  }
  function gpsFix(t) {
    if (!t || t.gps_source !== "ROVER_DEVICE" || t.gps_fix === false) return null;
    var lat = num(t.lat), lon = num(t.lon);
    if (lat === null || lon === null || t.lat == null || t.lon == null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
    return [lat, lon];
  }

  /* ---------- camera ---------- */
  function camEl() {
    var e = $("roverRealCamera");
    return (e && e.getAttribute("src")) ? e : null;
  }
  function setCam(s) { st.cam.state = s; }
  function camFail() {
    if (st.cam.state === "fail") return;
    setCam("fail");
    st.cam.attempts++;
    var d = Math.min(30000, 2000 * Math.pow(2, Math.min(st.cam.attempts - 1, 4)));
    clearTimeout(st.cam.timer);
    st.cam.timer = setTimeout(function () { reconnect(false); }, d);
  }
  function reconnect(manual) {
    var el = camEl();
    if (!el) { if (manual) { st.cfg = null; st.cfgAt = 0; loadCfg(); } return; }
    clearTimeout(st.cam.timer);
    if (manual) st.cam.attempts = 0;
    setCam("connecting");
    var tag = el.tagName;
    if (tag === "IMG") {
      var u = el.getAttribute("src");
      el.removeAttribute("src");
      setTimeout(function () { el.setAttribute("src", u); }, 60);
    } else if (tag === "VIDEO") {
      try { el.load(); var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    } else if (tag === "IFRAME") {
      el.setAttribute("src", el.getAttribute("src"));
    }
    st.cam.timer = setTimeout(function () { if (st.cam.state === "connecting") { st.cam.state = "idle"; camFail(); } }, 12000);
    render();
  }
  function attachCam(el) {
    if (el.__mvBound) return;
    el.__mvBound = true;
    var tag = el.tagName;
    function live() { st.cam.attempts = 0; clearTimeout(st.cam.timer); setCam(tag === "IFRAME" ? "embedded" : "live"); render(); }
    function bad() { camFail(); render(); }
    if (tag === "IMG") {
      el.addEventListener("load", live); el.addEventListener("error", bad);
      if (el.complete && el.naturalWidth > 0) live(); else setCam("connecting");
    } else if (tag === "VIDEO") {
      el.addEventListener("loadeddata", live); el.addEventListener("playing", live);
      ["error", "ended", "abort", "emptied"].forEach(function (n) { el.addEventListener(n, bad); });
      if (el.readyState >= 2) live(); else setCam("connecting");
    } else {
      el.addEventListener("load", live);
      setCam("connecting");
    }
  }
  function loadCfg() {
    if (demo || st.cfgBusy || st.cfg) return;
    if (Date.now() - st.cfgAt < 5000) return;
    st.cfgBusy = true; st.cfgAt = Date.now();
    fetch("/api/camera-config", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) st.cfg = { enabled: !!(d.enabled && d.url), type: d.type || "" }; })
      .catch(function () {})
      .then(function () { st.cfgBusy = false; render(); });
  }
  // Effective camera state, derived only from real signals.
  function camView() {
    var t = st.tel;
    if (demo) return { k: "demo", label: "DEMO", msg: "Demo mode — no live camera", bad: true };
    if (!st.cfg) return { k: "checking", label: "CHECKING", msg: "Checking camera configuration…", bad: true };
    if (!st.cfg.enabled) return { k: "none", label: "NO FEED", msg: "No camera stream is configured", bad: true };
    if (t && t.camera === false) return { k: "off", label: "CAMERA OFF", msg: "Rover reports its camera is off", bad: true, retry: true };
    var cs = st.cam.state;
    if (cs === "fail") return { k: "reconnecting", label: "RECONNECTING", msg: "Stream disconnected — reconnecting" + (st.cam.attempts > 1 ? " (attempt " + st.cam.attempts + ")" : "…"), bad: true, retry: true };
    if (cs === "live" || cs === "embedded") {
      if (t && t.device_online === false) return { k: "lost", label: "SIGNAL LOST", msg: "Rover signal lost — image may be frozen", bad: true, retry: true, overlay: true };
      return cs === "live" ? { k: "live", label: "LIVE", ok: true } : { k: "embedded", label: "EMBEDDED", ok: true };
    }
    return { k: "connecting", label: "CONNECTING", msg: "Connecting to camera stream…", bad: true, retry: true };
  }

  /* ---------- UI build ---------- */
  var ICON = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    reload: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
    shot: '<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    cam: '<path d="M3 7h12v10H3zM15 11l6-3v8l-6-3"/>'
  };
  function svg(n) { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[n] + '</svg>'; }

  function build() {
    if (st.built) return;
    st.built = true;
    var r = document.createElement("div");
    r.id = "mvRoot"; r.setAttribute("role", "dialog"); r.setAttribute("aria-modal", "true"); r.setAttribute("aria-label", "ROVER-01 full-screen monitor");
    r.innerHTML =
      '<header class="mv-top">' +
        '<div class="mv-brand defenxBrandName">DEFENX</div>' +
        '<span class="mv-sep"></span>' +
        '<span class="mv-pill" id="mvCamPill"><i></i><b id="mvCamLabel">CHECKING</b></span>' +
        '<span class="mv-chip" id="mvChipLink" title="Rover link"><small>ROVER</small><b id="mvLink">—</b></span>' +
        '<span class="mv-chip" id="mvChipBat" title="Battery"><small>BATT</small><b id="mvBat">—</b></span>' +
        '<span class="mv-chip" id="mvChipGps" title="GPS"><small>GPS</small><b id="mvGps">—</b></span>' +
        '<span class="mv-grow"></span>' +
        '<span class="mv-clock" id="mvClock"></span>' +
        '<button type="button" class="mv-btn" id="mvClose" data-tip="Close (Esc)" aria-label="Close full-screen monitor">' + svg("close") + '</button>' +
      '</header>' +
      '<div class="mv-body">' +
        '<section class="mv-cam" aria-label="Live camera">' +
          '<div class="mv-stage" id="mvStage"></div>' +
          '<div class="mv-banner" id="mvBanner" hidden><div class="mv-bannerIcon">' + svg("cam") + '</div><div id="mvBannerMsg"></div><button type="button" id="mvBannerRetry">Reconnect now</button></div>' +
          '<div class="mv-tools" role="toolbar" aria-label="Camera controls">' +
            '<button type="button" class="mv-btn" id="mvReconnect" data-tip="Reconnect camera" aria-label="Reconnect camera">' + svg("reload") + '</button>' +
            '<button type="button" class="mv-btn" id="mvShot" data-tip="Save snapshot" aria-label="Save snapshot">' + svg("shot") + '</button>' +
            '<button type="button" class="mv-btn" id="mvFs" data-tip="Browser full screen" aria-label="Toggle browser full screen">' + svg("full") + '</button>' +
          '</div>' +
        '</section>' +
        '<aside class="mv-side">' +
          '<div class="mv-resize" id="mvResize" role="separator" aria-orientation="vertical" aria-label="Resize map panel" tabindex="0" title="Drag to resize • double-click to reset"></div>' +
          '<details class="mv-panel" id="mvPanel" open><summary>System status</summary><div class="mv-grid">' +
            '<div><small>Server link</small><b id="mvSrv">—</b></div>' +
            '<div><small>Signal</small><b id="mvSig">—</b></div>' +
            '<div><small>Camera (rover)</small><b id="mvCamRep">—</b></div>' +
            '<div><small>Obstacle</small><b id="mvObs">—</b></div>' +
            '<div><small>GPS accuracy</small><b id="mvAcc">—</b></div>' +
            '<div><small>Speed</small><b id="mvSpd">—</b></div>' +
            '<div><small>Temp</small><b id="mvTmp">—</b></div>' +
            '<div><small>Updated</small><b id="mvUpd">—</b></div>' +
          '</div></details>' +
          '<div class="mv-mapwrap">' +
            '<div id="mvMap" aria-label="Rover map"></div>' +
            '<div class="mv-mapbar">' +
              '<button type="button" class="mv-btn sm" id="mvLayer" data-tip="Satellite / standard map" aria-label="Toggle satellite and standard map">' + svg("layers") + '</button>' +
              '<button type="button" class="mv-btn sm" id="mvCenter" data-tip="Center on rover" aria-label="Center on rover">' + svg("target") + '</button>' +
            '</div>' +
            '<div class="mv-maptag" id="mvMapTag">SATELLITE</div>' +
            '<div class="mv-mapmsg" id="mvMapMsg"></div>' +
            '<div class="mv-coords" id="mvCoords" hidden></div>' +
          '</div>' +
        '</aside>' +
      '</div>';
    document.body.appendChild(r);

    $("mvClose").addEventListener("click", function () { closeMonitor(); });
    $("mvReconnect").addEventListener("click", function () { reconnect(true); toast("Reconnecting camera…"); });
    $("mvBannerRetry").addEventListener("click", function () { reconnect(true); });
    $("mvShot").addEventListener("click", snapshot);
    $("mvFs").addEventListener("click", function () { st.autoFs = false; toggleFs(); });
    $("mvLayer").addEventListener("click", function () { setLayer(!st.useSat); });
    $("mvCenter").addEventListener("click", function () { st.follow = true; centerNow(true); });
    initResize();
    if (window.matchMedia("(max-height:520px),(orientation:portrait)").matches) $("mvPanel").open = false;
  }

  /* ---------- resizable map panel ---------- */
  function initResize() {
    var h = $("mvResize"), root = $("mvRoot"), drag = false;
    function apply(w) {
      var max = Math.round(window.innerWidth * 0.5), min = 220;
      w = Math.max(min, Math.min(max, Math.round(w)));
      root.style.setProperty("--mv-side", w + "px");
      if (st.map) st.map.invalidateSize();
    }
    h.addEventListener("pointerdown", function (e) { drag = true; try { h.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); });
    h.addEventListener("pointermove", function (e) { if (drag) apply(window.innerWidth - e.clientX); });
    function end() { drag = false; }
    h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
    h.addEventListener("dblclick", function () { root.style.removeProperty("--mv-side"); setTimeout(function () { if (st.map) st.map.invalidateSize(); }, 50); });
    h.addEventListener("keydown", function (e) {
      var cur = $("mvRoot").querySelector(".mv-side").getBoundingClientRect().width;
      if (e.key === "ArrowLeft") { apply(cur + 24); e.preventDefault(); }
      else if (e.key === "ArrowRight") { apply(cur - 24); e.preventDefault(); }
    });
  }

  /* ---------- map ---------- */
  function ensureMap() {
    if (st.map) return true;
    if (typeof L === "undefined" || !$("mvMap")) return false;
    st.map = L.map("mvMap", { zoomControl: false, worldCopyJump: true }).setView([20, 0], 2);
    L.control.zoom({ position: "bottomleft" }).addTo(st.map);
    st.sat = L.tileLayer(ESRI, { maxZoom: 19, attribution: "Imagery © Esri" });
    st.std = L.tileLayer(OSM, { maxZoom: 19, attribution: "© OpenStreetMap contributors" });
    st.sat.on("tileerror", function () {
      st.tileErr++;
      if (st.tileErr === 4 && st.useSat) { setLayer(false); toast("Satellite imagery unavailable — showing standard map", "warn"); }
    });
    st.sat.on("tileload", function () { st.tileErr = 0; });
    (st.useSat ? st.sat : st.std).addTo(st.map);
    st.map.on("dragstart", function () { st.follow = false; });
    setText("mvMapTag", st.useSat ? "SATELLITE" : "MAP");
    updateMap();
    return true;
  }
  function setLayer(sat) {
    if (!st.map) return;
    st.useSat = sat; st.tileErr = 0;
    if (st.map.hasLayer(st.sat)) st.map.removeLayer(st.sat);
    if (st.map.hasLayer(st.std)) st.map.removeLayer(st.std);
    (sat ? st.sat : st.std).addTo(st.map);
    setText("mvMapTag", sat ? "SATELLITE" : "MAP");
  }
  function arrowHtml(deg, stale) {
    var cls = "mv-rover" + (stale ? " stale" : "");
    if (deg == null) return '<div class="' + cls + '"><span class="dot"></span></div>';
    return '<div class="' + cls + '"><svg viewBox="0 0 40 40" style="transform:rotate(' + Math.round(deg) + 'deg)"><path d="M20 3l11 31-11-7-11 7z" fill="#22d3a6" stroke="#04110d" stroke-width="2" stroke-linejoin="round"/></svg></div>';
  }
  function centerNow(zoom) {
    if (!st.map || !st.lastFix) { toast("No live GPS position to center on", "warn"); return; }
    if (zoom && st.map.getZoom() < 16) st.map.setView(st.lastFix, 17); else st.map.panTo(st.lastFix);
  }
  function updateMap() {
    var t = st.tel, fix = gpsFix(t), stale = false;
    if (t && t.device_online === false && (st.lastFix || fix)) { fix = st.lastFix || fix; stale = true; }
    else if (!fix && st.lastFix) { fix = st.lastFix; stale = true; }
    var msg = $("mvMapMsg"), coords = $("mvCoords");
    if (!fix) {
      if (msg) { msg.textContent = demo ? "Demo mode — no GPS" : "No live GPS fix from rover"; msg.style.display = "block"; }
      if (coords) coords.hidden = true;
      return;
    }
    if (msg) {
      if (stale) { msg.textContent = (t && t.device_online === false) ? "Last known position — rover offline" : "GPS fix lost — last known position"; msg.style.display = "block"; }
      else msg.style.display = "none";
    }
    if (coords) { coords.hidden = false; coords.textContent = fix[0].toFixed(5) + "°, " + fix[1].toFixed(5) + "°"; }
    if (!st.map) return;
    var spd = t ? num(t.speed_kmh) : null, hd = t ? num(t.heading) : null;
    var deg = (!stale && spd !== null && spd > 0.5 && hd !== null) ? ((hd % 360) + 360) % 360 : st.bearing;
    var icon = L.divIcon({ className: "mv-roverIcon", html: arrowHtml(deg, stale), iconSize: [40, 40], iconAnchor: [20, 20] });
    if (!st.marker) st.marker = L.marker(fix, { icon: icon, keyboard: false, title: "ROVER-01" }).addTo(st.map);
    else { st.marker.setLatLng(fix); st.marker.setIcon(icon); }
    var acc = (!stale && t) ? num(t.gps_accuracy_m) : null;
    if (acc !== null && acc > 0 && acc < 5000) {
      if (!st.acc) st.acc = L.circle(fix, { radius: acc, color: "#22d3a6", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(st.map);
      else { st.acc.setLatLng(fix); st.acc.setRadius(acc); }
    } else if (st.acc) { st.map.removeLayer(st.acc); st.acc = null; }
    if (st.trailPts.length > 1) {
      if (!st.trail) st.trail = L.polyline(st.trailPts, { color: "#ffcf5a", weight: 3, opacity: 0.85, interactive: false }).addTo(st.map);
      else st.trail.setLatLngs(st.trailPts);
    }
    if (!st.firstFix) { st.firstFix = true; st.map.setView(fix, 17); }
    else if (st.follow && !stale) st.map.panTo(fix, { animate: true });
  }

  /* ---------- telemetry ---------- */
  function onTelemetry(t) {
    if (!t || typeof t !== "object") return;
    st.tel = t; st.telAt = Date.now();
    var fix = gpsFix(t);
    if (fix && !(t.device_online === false)) {
      var last = st.lastFix;
      if (!last || distM(last, fix) >= 2) {
        if (last && distM(last, fix) >= 3) st.bearing = bearingDeg(last, fix);
        st.trailPts.push(fix);
        if (st.trailPts.length > 400) st.trailPts.shift();
      }
      st.lastFix = fix;
    }
    render();
  }

  /* ---------- render ---------- */
  function fmtAgo(iso) {
    var ms = Date.parse(iso); if (!isFinite(ms)) return "—";
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago";
  }
  function render() {
    var v = camView(), t = st.tel;

    // dashboard camera badge + placeholder (kept honest outside the monitor too)
    var badge = document.querySelector("#liveCamera .liveBadge");
    if (badge) {
      var want = v.label === "LIVE" ? "LIVE" : v.label;
      if (badge.__mv !== want) {
        badge.__mv = want; badge.innerHTML = "<i></i> " + esc(want);
        badge.classList.toggle("mvOff", !v.ok);
      }
    }
    var ph = $("camPlaceholder");
    if (ph) {
      var showPh = !demo && !v.ok;
      ph.hidden = !showPh;
      if (showPh) setText("camPlaceholderMsg", v.msg || "");
    }

    // toast on state transitions
    var key = v.k;
    if (st.prevKey && key !== st.prevKey && !demo) {
      if (v.ok && st.prevKey !== "checking" && st.prevKey !== "connecting") toast("Camera stream restored", "ok");
      else if (!v.ok && (st.prevKey === "live" || st.prevKey === "embedded") && key !== "checking") toast(key === "lost" ? "Rover signal lost" : "Camera connection lost — reconnecting", "bad");
    }
    st.prevKey = key;
    var link = !t ? "" : (t.device_online === false ? "off" : "on");
    if (st.prevLink && link && link !== st.prevLink && !demo) toast(link === "off" ? "Rover signal lost" : "Rover back online", link === "off" ? "bad" : "ok");
    if (link) st.prevLink = link;

    if (!st.open || !st.built) return;

    var pill = $("mvCamPill");
    pill.className = "mv-pill " + (v.ok ? "ok" : (v.k === "reconnecting" || v.k === "connecting" || v.k === "checking" ? "warn" : "bad"));
    setText("mvCamLabel", v.label);

    var banner = $("mvBanner");
    banner.hidden = !!v.ok;
    banner.classList.toggle("overlay", !!v.overlay);
    if (!v.ok) { setText("mvBannerMsg", v.msg || ""); $("mvBannerRetry").style.display = v.retry ? "" : "none"; }
    $("mvReconnect").style.display = (!demo && st.cfg && st.cfg.enabled) ? "" : "none";

    var rep = roverReporting(t);
    var linkTxt = demo ? "DEMO" : (!t ? "—" : (t.device_online === false ? "OFFLINE" : (rep ? "ONLINE" : "NO DATA")));
    setText("mvLink", linkTxt);
    $("mvChipLink").className = "mv-chip " + (linkTxt === "ONLINE" ? "ok" : (linkTxt === "OFFLINE" ? "bad" : ""));
    var bat = rep ? num(t.battery) : null;
    setText("mvBat", bat === null ? "—" : Math.round(bat) + "%");
    $("mvChipBat").className = "mv-chip " + (bat === null ? "" : (bat < 20 ? "bad" : (bat < 40 ? "warn" : "ok")));
    var fix = gpsFix(t), acc = fix ? num(t.gps_accuracy_m) : null;
    var gtxt = demo ? "DEMO" : (fix ? (t.device_online === false ? "LAST KNOWN" : "FIX" + (acc !== null ? " ±" + Math.round(acc) + "m" : "")) : "NO FIX");
    setText("mvGps", gtxt);
    $("mvChipGps").className = "mv-chip " + (fix && t.device_online !== false ? "ok" : (demo ? "" : "warn"));

    var ws = window.roverWS;
    setText("mvSrv", demo ? "DEMO" : (ws && ws.readyState === 1 ? "REALTIME" : (ws && ws.readyState === 0 ? "CONNECTING" : "HTTP FALLBACK")));
    var sig = rep ? num(t.signal) : null; setText("mvSig", sig === null ? "—" : Math.round(sig) + "%");
    setText("mvCamRep", !rep ? "—" : (t.camera === false ? "OFF" : (t.camera_source === "ROVER_DEVICE" ? "ON" : "—")));
    var ob = rep ? num(t.obstacle_cm) : null; setText("mvObs", ob === null ? "—" : Math.round(ob) + " cm");
    setText("mvAcc", acc === null ? "—" : "±" + Math.round(acc) + " m");
    var sp = (rep && fix) ? num(t.speed_kmh) : null; setText("mvSpd", sp === null ? "—" : sp.toFixed(1) + " km/h");
    var tp = rep ? num(t.temp_c) : null; setText("mvTmp", tp === null ? "—" : Math.round(tp) + "°C");
    setText("mvUpd", (t && rep && (t.last_seen_at || t.updated)) ? fmtAgo(t.last_seen_at || t.updated) : "—");
    setText("mvClock", new Date().toLocaleTimeString());

    updateMap();
  }

  /* ---------- open / close / fullscreen ---------- */
  function adopt() {
    var el = camEl(), stage = $("mvStage");
    if (!el || !stage || stage.contains(el)) return;
    st.home = el.parentNode;
    stage.appendChild(el);
    if (el.tagName === "VIDEO") { try { var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  function release() {
    var el = $("roverRealCamera"), stage = $("mvStage");
    if (!el || !stage || !stage.contains(el)) return;
    var home = $("cameraViewport") || st.home;
    if (home) home.insertBefore(el, home.firstChild);
    if (el.tagName === "VIDEO") { try { var p = el.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
  }
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function toggleFs() {
    var root = $("mvRoot");
    if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document); return; }
    var req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!req) { toast("Browser full screen is not supported here — the monitor already fills the window"); return; }
    try { var p = req.call(root); if (p && p.catch) p.catch(function () { toast("Browser full screen was blocked"); }); } catch (e) {}
  }
  function openMonitor() {
    build();
    if (st.open) return;
    st.open = true;
    st.lastFocus = document.activeElement;
    $("mvRoot").classList.add("mv-open");
    document.documentElement.classList.add("mv-lock");
    adopt();
    loadCfg();
    ensureMap();
    st.follow = true;
    // Opening is a user gesture, so browser full screen is allowed here.
    var root = $("mvRoot"), req = root.requestFullscreen || root.webkitRequestFullscreen;
    st.autoFs = !!req;
    if (req) { try { var p = req.call(root); if (p && p.catch) p.catch(function () { st.autoFs = false; }); } catch (e) { st.autoFs = false; } }
    try { history.pushState({ mv: 1 }, ""); st.pushed = true; } catch (e) { st.pushed = false; }
    render();
    setTimeout(function () { if (st.map) st.map.invalidateSize(); if (st.map && st.lastFix) centerNow(false); }, 120);
    var c = $("mvClose"); if (c) c.focus({ preventScroll: true });
  }
  function closeMonitor(fromPop) {
    if (!st.open) return;
    st.open = false; st.autoFs = false;
    release();
    $("mvRoot").classList.remove("mv-open");
    document.documentElement.classList.remove("mv-lock");
    if (fsEl()) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
    if (!fromPop && st.pushed) { st.pushed = false; try { history.back(); } catch (e) {} }
    if (fromPop) st.pushed = false;
    if (st.lastFocus && st.lastFocus.focus) { try { st.lastFocus.focus({ preventScroll: true }); } catch (e) {} }
  }
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  function onFsChange() {
    if (!st.built) return;
    var on = !!fsEl();
    var b = $("mvFs"); if (b) { b.innerHTML = svg(on ? "exit" : "full"); b.setAttribute("data-tip", on ? "Exit browser full screen" : "Browser full screen"); }
    if (st.map) setTimeout(function () { st.map.invalidateSize(); }, 100);
    // Esc / system exit from the auto-entered full screen returns to the dashboard.
    if (!on && st.open && st.autoFs) closeMonitor();
  }
  window.addEventListener("popstate", function () { if (st.open) closeMonitor(true); });
  document.addEventListener("keydown", function (e) {
    if (st.open && e.key === "Escape") { e.preventDefault(); closeMonitor(); }
  });
  window.addEventListener("resize", function () { if (st.open && st.map) st.map.invalidateSize(); });

  /* ---------- snapshot ---------- */
  function snapshot() {
    var el = camEl();
    if (!el || el.tagName === "IFRAME") { toast("Snapshot is not available for this stream type", "warn"); return; }
    try {
      var w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
      if (!w || !h) { toast("No camera frame to capture yet", "warn"); return; }
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(el, 0, 0, w, h);
      c.toBlob(function (b) {
        if (!b) { toast("Snapshot failed", "bad"); return; }
        var a = document.createElement("a"); a.href = URL.createObjectURL(b);
        a.download = "defenx-rover-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        toast("Snapshot saved", "ok");
      }, "image/png");
    } catch (e) {
      toast("Browser blocked the snapshot (camera stream does not allow CORS)", "warn");
    }
  }

  /* ---------- wiring ---------- */
  window.addEventListener("defenx-telemetry", function (e) { onTelemetry(e.detail); });
  window.ROVER_MONITOR = { open: openMonitor, close: function () { closeMonitor(); }, reconnect: function () { reconnect(true); } };

  function init() {
    if (!demo) document.body.classList.add("mvReal");
    var b = $("viewFullBtn"); if (b) b.addEventListener("click", openMonitor);
    var ph = $("camPlaceholder"); if (ph) { var rb = $("camPlaceholderRetry"); if (rb) rb.addEventListener("click", function () { reconnect(true); }); }
    if (window.defenxLatestTelemetry) onTelemetry(window.defenxLatestTelemetry);
    loadCfg();
    setInterval(function () {
      var el = camEl();
      if (el) { attachCam(el); if (st.open) adopt(); }
      if (!st.cfg) loadCfg();
      if (st.open && !st.map) ensureMap();
      render();
    }, 1000);
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
