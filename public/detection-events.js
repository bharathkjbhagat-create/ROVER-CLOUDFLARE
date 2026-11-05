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
    events.unshift({type, label: type === "PERSON_PRESENT" ? "Person detected in camera view" : "Person no longer detected", at: new Date(now).toISOString()});
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
