/* DEFENX person-detection event history and operator-controlled notifications.
 * Stores only event type and timestamp in this browser. Never stores images,
 * face data, identity, GPS coordinates, or person-specific tracking records.
 */
(() => {
  "use strict";
  const KEY = "defenx_detection_events_v1";
  const PREF = "defenx_detection_alerts_v1";
  const panel = document.getElementById("detectionEventsPanel");
  if (!panel) return;
  const list = document.getElementById("detectionEventList");
  const status = document.getElementById("detectionAlertStatus");
  const toggle = document.getElementById("detectionAlertToggle");
  const permission = document.getElementById("detectionPermissionBtn");
  const clear = document.getElementById("detectionClearBtn");
  const localExport = document.createElement("button");
  localExport.type = "button";
  localExport.id = "detectionExportBtn";
  localExport.textContent = "EXPORT CSV";
  clear.insertAdjacentElement("beforebegin", localExport);

  function downloadCSV(filename, rows) {
    const csv = rows.map(row => row.map(value => '"' + String(value ?? "").replace(/"/g, '""') + '"').join(",")).join("\\r\\n");
    const blob = new Blob(["\\uFEFF" + csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  localExport.addEventListener("click", () => {
    downloadCSV("defenx-person-events-local.csv", [
      ["Event", "Timestamp"],
      ...events.map(item => [item.type, item.at])
    ]);
  });

  // The admin export requests the existing protected audit API and exports
  // only generic person-presence events; IP addresses and user-agent fields
  // are deliberately excluded.
  const auditTools = document.getElementById("detectionAuditTools");
  const auditExport = document.getElementById("exportDetectionAuditBtn");
  if (auditTools && auditExport) {
    auditExport.addEventListener("click", async () => {
      auditExport.disabled = true;
      auditExport.textContent = "PREPARING…";
      try {
        const response = await fetch("/api/audit?limit=5000", {credentials:"same-origin"});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Admin access required");
        const rows = (data.logs || []).filter(item =>
          item.action === "PERSON_DETECTED" || item.action === "PERSON_CLEARED"
        );
        downloadCSV("defenx-person-events-admin.csv", [
          ["Timestamp", "User", "Role", "Event", "Details"],
          ...rows.map(item => [item.created_at, item.display_name || item.username, item.role, item.action, item.details])
        ]);
        status.textContent = rows.length ? "Admin person-event export ready" : "No admin person events to export";
      } catch (error) {
        status.textContent = error.message || "Could not export admin events";
      } finally {
        auditExport.disabled = false;
        auditExport.textContent = "EXPORT PERSON EVENTS CSV";
      }
    });
  }
  let enabled = false;
  try { enabled = localStorage.getItem(PREF) === "1"; } catch (_) {}
  const demoMode = location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  let lastPresent = null;
  let events = readEvents();

  function readEvents() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(value) ? value.filter(x => x && typeof x.at === "string" && typeof x.type === "string").slice(0, 50) : [];
    } catch (_) { return []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(events.slice(0, 50))); } catch (_) {}
  }
  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }
  function render() {
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = enabled ? "ALERTS ON" : "ALERTS OFF";
    status.textContent = enabled
      ? (("Notification" in window && Notification.permission === "granted") ? "Operator alerts enabled" : "Event logging enabled • browser permission not granted")
      : "Event logging active • notifications disabled";
    if (!events.length) {
      list.innerHTML = '<div class="detectionEmpty">No person-detection events recorded in this browser.</div>';
      return;
    }
    list.innerHTML = events.map(item =>
      '<div class="detectionEvent"><span class="detectionEventMark">'+(item.type === "PERSON_PRESENT" ? "●" : "○")+'</span><span><b>'+escapeText(item.label)+'</b><small>'+escapeText(new Date(item.at).toLocaleString())+'</small></span></div>'
    ).join("");
  }
  function record(type) {
    const now = Date.now();
    events.unshift({type, label: type === "PERSON_PRESENT" ? "UNVERIFIED PERSON DETECTED • review camera view" : "UNVERIFIED PERSON NO LONGER DETECTED", at: new Date(now).toISOString()});
    events = events.slice(0, 50);
    save();
    render();
    // Only the generic state transition reaches the authenticated admin audit log.
    // Demo mode stays local; camera frames and biometric data are never sent.
    if (!demoMode) {
      fetch("/api/detection-events", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
        keepalive: true
      }).then(response => {
        if (!response.ok) status.textContent = "Local event saved • admin sync requires an authenticated session";
      }).catch(() => {
        status.textContent = "Local event saved • admin sync unavailable";
      });
    }
    if (type === "PERSON_PRESENT" && enabled && "Notification" in window && Notification.permission === "granted" && !document.hidden) {
      try { new Notification("DEFENX • Person detected", {body:"A person is visible in the active camera view. Review the live feed."}); } catch (_) {}
    }
  }
  toggle.addEventListener("click", async () => {
    enabled = !enabled;
    try { localStorage.setItem(PREF, enabled ? "1" : "0"); } catch (_) {}
    if (enabled && "Notification" in window && Notification.permission === "default") {
      status.textContent = "Use ENABLE BROWSER NOTIFICATIONS to grant permission";
    }
    render();
  });
  permission.addEventListener("click", async () => {
    if (!("Notification" in window)) { status.textContent = "Browser notifications are not supported"; return; }
    try {
      const result = await Notification.requestPermission();
      status.textContent = result === "granted" ? "Browser notifications permitted" : "Browser notification permission not granted";
    } catch (_) { status.textContent = "Could not request notification permission"; }
  });
  clear.addEventListener("click", () => {
    events = [];
    save();
    render();
  });
  window.addEventListener("defenx-ai-detection", event => {
    const present = Number(event.detail && event.detail.human || 0) > 0;
    if (lastPresent === null) { lastPresent = present; if (present) record("PERSON_PRESENT"); return; }
    if (present !== lastPresent) {
      lastPresent = present;
      record(present ? "PERSON_PRESENT" : "PERSON_CLEARED");
    }
  });
  render();
})();
