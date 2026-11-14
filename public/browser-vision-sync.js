/* Browser-only scanner ownership and low-rate detection sync.
 * Only normalized boxes and face match statuses are relayed to authenticated peers.
 * Camera frames and face descriptors stay in the active browser.
 */
(() => {
  "use strict";
  let connected = false, joined = false, owned = true, wanted = false, pending = false, lastSent = 0;
  const publishInterval = 750;
  const notify = reason => window.dispatchEvent(new CustomEvent("defenx-browser-vision-owner", {
    detail: { owned, connected, joined, reason: reason || "" }
  }));

  function claim() {
    wanted = true;
    const sync = window.DEFENX_VISION_SYNC;
    if (!sync || !joined) { owned = true; notify(); return true; }
    if (owned) return true;
    if (!pending) pending = !!sync.setOwner(true);
    if (!pending) notify("CONNECTING TO DEVICE SYNC");
    return false;
  }

  function release() {
    wanted = false;
    const sync = window.DEFENX_VISION_SYNC;
    if (joined && owned && sync) {
      sync.publish({ width: 1, height: 1, detections: [], faces: [] });
      sync.setOwner(false);
    }
    pending = false;
    owned = !joined;
  }

  function publish(result) {
    if (!joined || !owned || !window.DEFENX_VISION_SYNC || Date.now() - lastSent < publishInterval) return;
    lastSent = Date.now();
    window.DEFENX_VISION_SYNC.publish(result);
  }

  window.addEventListener("defenx-vision-sync-state", event => {
    const detail = event.detail || {};
    connected = !!detail.connected;
    if (!connected) {
      joined = false; pending = false; owned = true;
      if (wanted) notify("DEVICE SYNC DISCONNECTED • SCANNING ON THIS DEVICE");
      return;
    }
    if (detail.joined) {
      joined = true; pending = false; owned = false;
      if (wanted && !document.hidden) claim();
      else notify();
    }
  });

  window.addEventListener("defenx-vision-owner", event => {
    if (!joined) return;
    const detail = event.detail || {}, owner = String(detail.owner || "");
    const mine = String(window.DEFENX_CAMERA_PEER_ID || "");
    if (detail.granted && owner === mine) {
      owned = true; pending = false; notify();
    } else if (owner && owner !== mine) {
      owned = false; pending = false; notify("AI SCANNING ON ANOTHER AUTHENTICATED DEVICE");
    } else {
      owned = false; pending = false;
      if (wanted && !document.hidden) claim();
      else notify("SCANNER AVAILABLE");
    }
  });

  window.addEventListener("pagehide", release);
  window.DEFENX_BROWSER_VISION_SYNC = {
    claim,
    release,
    owns: () => owned,
    status: () => joined ? "SYNCED" : connected ? "CONNECTING SYNC" : "DISCONNECTED",
    publish
  };
})();