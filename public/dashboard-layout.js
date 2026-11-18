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

  document.addEventListener("click", function (event) {
    var item = event.target.closest(".navItem[data-action='simlab']");
    var back = event.target.closest("#simLabBackBtn");
    if (!item && !back) return;
    var page = document.getElementById("simLabPage");
    if (!page) return;
    page.hidden = !item;
    document.body.classList.toggle("simLabOpen", !!item);
    if (back) {
      document.querySelectorAll(".navItem").forEach(function (node) { node.classList.remove("active"); });
      var dashboard = document.querySelector('.navItem[data-scroll="dashboardTop"]');
      if (dashboard) dashboard.classList.add("active");
      var top = document.getElementById("dashboardTop");
      if (top) top.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
})();
