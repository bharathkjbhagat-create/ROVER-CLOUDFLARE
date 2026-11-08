/* DEFENX detection events and alerts.
 * Receives only classified LIVE-camera results from ai-vision.js (never reference
 * uploads), suppresses repeats for one continuous detection, and records:
 * category, time, status, confidence, camera reference and GPS (with accuracy,
 * or "unavailable"). No images, face data or descriptors are stored or sent.
 */
(() => {
  "use strict";
  const KEY = "defenx_detection_events_v1";
  const PREF = "defenx_detection_alerts_v1";
  const CFG = "defenx_alert_config_v1";
  const panel = document.getElementById("detectionEventsPanel");
  if (!panel) return;
  const core = window.DEFENX_VISION_CORE;
  const list = document.getElementById("detectionEventList");
  const status = document.getElementById("detectionAlertStatus");
  const toggle = document.getElementById("detectionAlertToggle");
  const permission = document.getElementById("detectionPermissionBtn");
  const clear = document.getElementById("detectionClearBtn");
  const vehicleToggle = document.getElementById("detectionVehicleToggle");
  const objectToggle = document.getElementById("detectionObjectToggle");
  const demoMode = location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  const LABELS = {
    unknown_person: "UNKNOWN PERSON", registered_no_mask: "REGISTERED PERSON WITHOUT MASK",
    unknown_no_mask: "UNKNOWN PERSON WITHOUT MASK", vehicle_detected: "VEHICLE DETECTED", object_detected: "OBJECT DETECTED"
  };

  const localExport = document.createElement("button");
  localExport.type = "button"; localExport.id = "detectionExportBtn"; localExport.textContent = "EXPORT CSV";
  clear.insertAdjacentElement("beforebegin", localExport);

  function downloadCSV(filename, rows) {
    const csv = rows.map(row => row.map(value => '"' + String(value ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  const gpsText = g => g ? g.lat.toFixed(5) + ", " + g.lon.toFixed(5) + (g.accuracy_m != null ? " (±" + Math.round(g.accuracy_m) + " m)" : " (accuracy n/a)") : "GPS unavailable";
  localExport.addEventListener("click", () => {
    downloadCSV("defenx-detection-events-local.csv", [
      ["Time", "Category", "Status", "Subject", "Mask", "Confidence", "Camera", "GPS", "Accuracy (m)"],
      ...events.map(e => [e.at, e.label || e.type, e.status || "", e.subject || "", e.mask || "",
        e.confidence != null ? Math.round(e.confidence * 100) + "%" : "", e.camera ? e.camera.label : "",
        e.gps ? e.gps.lat + "," + e.gps.lon : "unavailable", e.gps && e.gps.accuracy_m != null ? e.gps.accuracy_m : ""])
    ]);
  });

  // Admin export reads the protected audit API (no IP / user-agent columns).
  const auditTools = document.getElementById("detectionAuditTools");
  const auditExport = document.getElementById("exportDetectionAuditBtn");
  if (auditTools && auditExport) {
    auditExport.addEventListener("click", async () => {
      auditExport.disabled = true; auditExport.textContent = "PREPARING…";
      try {
        const response = await fetch("/api/audit?limit=5000", { credentials: "same-origin" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Admin access required");
        const rows = (data.logs || []).filter(i => ["PERSON_DETECTED", "PERSON_CLEARED", "DETECTION_ALERT"].includes(i.action));
        downloadCSV("defenx-detection-events-admin.csv", [
          ["Timestamp", "User", "Role", "Event", "Category", "Status", "Confidence", "Camera", "GPS", "Details"],
          ...rows.map(i => {
            let a = null;
            if (i.action === "DETECTION_ALERT") { try { a = JSON.parse(i.details); } catch (_) {} }
            return [i.created_at, i.display_name || i.username, i.role, i.action, a ? a.label : "", a ? a.status : "",
              a ? Math.round(a.confidence * 100) + "%" : "", a && a.camera ? a.camera.label : "", a ? gpsText(a.gps) : "", a ? "" : i.details];
          })
        ]);
        status.textContent = rows.length ? "Admin detection export ready" : "No admin detection events to export";
      } catch (error) { status.textContent = error.message || "Could not export admin events"; }
      finally { auditExport.disabled = false; auditExport.textContent = "EXPORT PERSON EVENTS CSV"; }
    });
  }

  let enabled = false;
  try { enabled = localStorage.getItem(PREF) === "1"; } catch (_) {}
  let cfg = { vehicles: false, objects: false, objectClasses: core ? core.DEFAULT_ALERT_OBJECTS.slice() : [] };
  try { const saved = JSON.parse(localStorage.getItem(CFG) || "null"); if (saved) { cfg.vehicles = !!saved.vehicles; cfg.objects = !!saved.objects; } } catch (_) {}
  let lastPresent = null;
  let events = readEvents();
  const gate = core ? new core.AlertGate(6000) : null;

  function readEvents() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(value) ? value.filter(x => x && typeof x.at === "string" && typeof x.type === "string").slice(0, 50) : [];
    } catch (_) { return []; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(events.slice(0, 50))); } catch (_) {} }
  const escapeText = v => String(v == null ? "" : v).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function render() {
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = enabled ? "ALERTS ON" : "ALERTS OFF";
    if (vehicleToggle) { vehicleToggle.textContent = "VEHICLE ALERTS " + (cfg.vehicles ? "ON" : "OFF"); vehicleToggle.setAttribute("aria-pressed", String(cfg.vehicles)); }
    if (objectToggle) { objectToggle.textContent = "OBJECT ALERTS " + (cfg.objects ? "ON" : "OFF"); objectToggle.setAttribute("aria-pressed", String(cfg.objects)); }
    if (!status.dataset.sticky) status.textContent = enabled
      ? (("Notification" in window && Notification.permission === "granted") ? "Operator alerts enabled" : "Event logging enabled • browser permission not granted")
      : "Event logging active • notifications disabled";
    if (!events.length) { list.innerHTML = '<div class="detectionEmpty">No detection events recorded yet.</div>'; return; }
    list.innerHTML = events.map(item => {
      const when = escapeText(new Date(item.at).toLocaleString());
      if (item.type === "ALERT") {
        const bits = [item.status, item.subject && item.subject !== "UNKNOWN" ? item.subject : null, item.mask,
          item.confidence != null ? Math.round(item.confidence * 100) + "% confidence" : null,
          item.camera && item.camera.label, gpsText(item.gps)].filter(Boolean).map(escapeText).join(" • ");
        return '<div class="detectionEvent alert"><span class="detectionEventMark">▲</span><span><b>' + escapeText(item.label) + '</b><small>' + when + ' • ' + bits + (item.synced === false ? " • not synced" : "") + '</small></span></div>';
      }
      return '<div class="detectionEvent"><span class="detectionEventMark">' + (item.type === "PERSON_PRESENT" ? "●" : "○") + '</span><span><b>' + escapeText(item.label) + '</b><small>' + when + '</small></span></div>';
    }).join("");
  }

  /* ---------- context attached to every alert ---------- */
  function currentGps() {
    const phone = window.DEFENX_PHONE_GPS_LATEST;
    if (phone && Number.isFinite(phone.lat) && Number.isFinite(phone.lon) && Date.now() - (phone.timestamp || 0) < 15000)
      return { lat: phone.lat, lon: phone.lon, accuracy_m: Number.isFinite(phone.accuracy) ? phone.accuracy : null };
    const t = window.defenxLatestTelemetry;
    if (t && t.gps_fix === true && t.gps_source === "ROVER_DEVICE" && Number.isFinite(Number(t.lat)) && Number.isFinite(Number(t.lon)))
      return { lat: Number(t.lat), lon: Number(t.lon), accuracy_m: Number.isFinite(Number(t.gps_accuracy_m)) && t.gps_accuracy_m !== null ? Number(t.gps_accuracy_m) : null };
    return null; // never fabricate a location
  }
  function cameraRef() {
    const el = document.getElementById("roverRealCamera");
    if (el && el.tagName === "VIDEO" && el.srcObject) return { label: "PHONE CAMERA", source: "phone" };
    const t = window.defenxLatestTelemetry;
    return { label: ((t && t.device_id) || "ROVER-01") + " CAMERA", source: "rover" };
  }

  /* ---------- recording ---------- */
  function notify(title, body) {
    if (enabled && "Notification" in window && Notification.permission === "granted" && !document.hidden) {
      try { new Notification(title, { body }); } catch (_) {}
    }
  }
  function send(event) {
    if (demoMode) return;
    fetch("/api/detection-alerts", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({
        category: event.category, status: event.status, confidence: event.confidence, subject: event.subject, mask: event.mask,
        live_verified: event.liveVerified === true, source: "live_camera", camera: event.camera,
        gps: event.gps ? { lat: event.gps.lat, lon: event.gps.lon, accuracy: event.gps.accuracy_m } : null
      })
    }).then(async response => {
      if (response.ok) { event.synced = true; save(); render(); }
      else { status.dataset.sticky = "1"; status.textContent = "Alert saved locally • admin sync rejected (" + response.status + ")"; }
    }).catch(() => { status.dataset.sticky = "1"; status.textContent = "Alert saved locally • admin sync unavailable"; });
  }
  function offer(a) {
    if (demoMode || !gate || !LABELS[a.category]) return false;
    const now = performance.now();
    gate.sweep(now);
    if (!gate.offer(a.category, a.trackId, now)) return false; // same continuous detection: already alerted
    const event = {
      type: "ALERT", category: a.category, label: LABELS[a.category], status: a.status,
      confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)), subject: a.subject || null, mask: a.mask || null,
      camera: cameraRef(), gps: currentGps(), liveVerified: a.live === true, at: new Date().toISOString(), synced: false
    };
    events.unshift(event); events = events.slice(0, 50); save(); render();
    send(event);
    notify("DEFENX • " + event.label, event.status + " • " + Math.round(event.confidence * 100) + "% • " + gpsText(event.gps));
    window.dispatchEvent(new CustomEvent("defenx-alert", { detail: event }));
    return true;
  }
  window.DEFENX_ALERTS = { offer, config: () => cfg, gps: currentGps, camera: cameraRef };

  function recordPresence(type) {
    events.unshift({ type, label: type === "PERSON_PRESENT" ? "LIVE PERSON DETECTED • review camera view" : "LIVE PERSON NO LONGER DETECTED", at: new Date().toISOString() });
    events = events.slice(0, 50); save(); render();
    if (!demoMode) {
      fetch("/api/detection-events", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }), keepalive: true
      }).then(r => { if (!r.ok) { status.dataset.sticky = "1"; status.textContent = "Local event saved • admin sync requires an authenticated session"; } })
        .catch(() => { status.dataset.sticky = "1"; status.textContent = "Local event saved • admin sync unavailable"; });
    }
    if (type === "PERSON_PRESENT") notify("DEFENX • Live person detected", "A verified live person is visible in the camera view.");
  }

  /* ---------- controls ---------- */
  toggle.addEventListener("click", () => {
    enabled = !enabled;
    try { localStorage.setItem(PREF, enabled ? "1" : "0"); } catch (_) {}
    delete status.dataset.sticky;
    if (enabled && "Notification" in window && Notification.permission === "default") { status.dataset.sticky = "1"; status.textContent = "Use ENABLE BROWSER NOTIFICATIONS to grant permission"; }
    render();
  });
  function saveCfg() { try { localStorage.setItem(CFG, JSON.stringify({ vehicles: cfg.vehicles, objects: cfg.objects })); } catch (_) {} render(); }
  if (vehicleToggle) vehicleToggle.addEventListener("click", () => { cfg.vehicles = !cfg.vehicles; saveCfg(); });
  if (objectToggle) objectToggle.addEventListener("click", () => { cfg.objects = !cfg.objects; saveCfg(); });
  permission.addEventListener("click", async () => {
    status.dataset.sticky = "1";
    if (!("Notification" in window)) { status.textContent = "Browser notifications are not supported"; return; }
    try { const r = await Notification.requestPermission(); status.textContent = r === "granted" ? "Browser notifications permitted" : "Browser notification permission not granted"; }
    catch (_) { status.textContent = "Could not request notification permission"; }
  });
  clear.addEventListener("click", () => { events = []; save(); delete status.dataset.sticky; render(); });
  window.addEventListener("defenx-ai-detection", event => {
    const present = Number(event.detail && event.detail.human || 0) > 0;
    if (lastPresent === null) { lastPresent = present; if (present) recordPresence("PERSON_PRESENT"); return; }
    if (present !== lastPresent) { lastPresent = present; recordPresence(present ? "PERSON_PRESENT" : "PERSON_CLEARED"); }
  });

  // Administrators can review stored alerts from earlier sessions.
  async function loadHistory() {
    if (demoMode) return;
    try {
      const response = await fetch("/api/detection-alerts?limit=50", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const remote = (data.alerts || []).map(a => ({
        type: "ALERT", category: a.category, label: a.label, status: a.status, confidence: a.confidence, subject: a.subject,
        mask: a.mask, camera: a.camera, gps: a.gps, at: a.at, synced: true
      }));
      const keep = events.filter(e => e.type !== "ALERT" || e.synced === false);
      events = keep.concat(remote).sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 50);
      save(); render();
    } catch (_) { /* history is optional */ }
  }
  render();
  loadHistory();
})();