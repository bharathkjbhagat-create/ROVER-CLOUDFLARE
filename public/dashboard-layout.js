/* DEFENX approved dashboard layout: combine device and status without changing telemetry IDs. */
(function () {
  "use strict";
  function applyApprovedLayout() {
    var device = document.getElementById("deviceSection");
    var status = document.querySelector(".lowerGrid > .statusCard");
    if (device && status && !device.contains(status)) {
      status.classList.add("combinedDeviceStatus");
      var heading = status.querySelector(".cardHeader > b");
      if (heading) heading.textContent = "DEVICE STATUS";
      device.appendChild(status);
    }
    var presence = document.getElementById("onlineUsers");
    if (presence) {
      var block = presence.closest(".statusBlock");
      if (block) block.remove();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyApprovedLayout, { once: true });
  } else {
    applyApprovedLayout();
  }
})();
