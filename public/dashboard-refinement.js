/* DEFENX dashboard interaction refinement.
 * Keeps existing controls in the DOM and preserves their IDs and delegated events.
 */
(function () {
  "use strict";

  function init() {
    const body = document.body;
    const menu = document.getElementById("mobileMenuBtn");
    const sidebar = document.getElementById("commandSidebar") || document.querySelector(".sidebar");
    if (!body || !menu || !sidebar || menu.dataset.defenxDrawerBound === "1") return;
    menu.dataset.defenxDrawerBound = "1";

    if (!sidebar.id) sidebar.id = "commandSidebar";
    menu.setAttribute("aria-controls", sidebar.id);

    let backdrop = document.querySelector(".defenx-drawer-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "defenx-drawer-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      body.appendChild(backdrop);
    }

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");

    function focusableItems() {
      return Array.from(sidebar.querySelectorAll(focusableSelector)).filter((item) =>
        !item.hidden && item.getAttribute("aria-hidden") !== "true"
      );
    }

    function setOpen(open, restoreFocus = true) {
      const wasOpen = body.classList.contains("defenx-drawer-open");
      const shouldOpen = Boolean(open);
      body.classList.toggle("defenx-drawer-open", shouldOpen);
      menu.setAttribute("aria-expanded", String(shouldOpen));
      menu.setAttribute("aria-label", shouldOpen ? "Close navigation" : "Open navigation");
      sidebar.setAttribute("aria-hidden", String(!shouldOpen));
      backdrop.setAttribute("aria-hidden", String(!shouldOpen));
      // Keep the overlay state synchronized even if a host page stylesheet has
      // stronger visibility rules than this refinement stylesheet.
      backdrop.style.opacity = shouldOpen ? "1" : "0";
      backdrop.style.visibility = shouldOpen ? "visible" : "hidden";
      backdrop.style.pointerEvents = shouldOpen ? "auto" : "none";

      if (shouldOpen) {
        sidebar.removeAttribute("inert");
        if (!wasOpen) {
          const first = focusableItems()[0];
          if (first) first.focus({ preventScroll: true });
        }
      } else {
        if (restoreFocus && (wasOpen || sidebar.contains(document.activeElement))) {
          menu.focus({ preventScroll: true });
        }
        sidebar.setAttribute("inert", "");
      }
    }

    menu.addEventListener("click", (event) => {
      event.preventDefault();
      setOpen(!body.classList.contains("defenx-drawer-open"));
    });
    backdrop.addEventListener("click", () => setOpen(false));

    document.addEventListener("keydown", (event) => {
      if (!body.classList.contains("defenx-drawer-open")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusableItems();
      if (!items.length) {
        event.preventDefault();
        menu.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });

    sidebar.addEventListener("click", (event) => {
      if (event.target.closest(".navItem, .sideLogout")) setOpen(false);
    });

    const mapHeader = document.querySelector(".mapHeader");
    const mapControls = mapHeader && mapHeader.querySelector(".mapControls");
    if (mapHeader && mapControls && !mapHeader.querySelector(".inlineFold")) {
      const fold = document.createElement("details");
      fold.className = "inlineFold";
      const summary = document.createElement("summary");
      summary.textContent = "MAP OPTIONS";
      fold.appendChild(summary);
      fold.appendChild(mapControls);
      mapHeader.appendChild(fold);
    }

    const returnActions = document.querySelector(".returnBaseActions");
    if (returnActions && !returnActions.querySelector(".advancedRouteFold")) {
      const extras = Array.from(returnActions.querySelectorAll(
        "#previewReturnRouteBtn, #simulateObstacleRouteBtn, #clearReturnRouteBtn"
      ));
      if (extras.length) {
        const fold = document.createElement("details");
        fold.className = "controlSubFold advancedRouteFold";
        const summary = document.createElement("summary");
        summary.textContent = "ADVANCED ROUTE TOOLS";
        fold.appendChild(summary);
        extras.forEach((element) => fold.appendChild(element));
        returnActions.appendChild(fold);
      }
    }

    const detectionActions = document.querySelector(
      "#detectionEventsPanel .detectionEventsActions"
    );
    if (detectionActions && !detectionActions.parentElement.querySelector(".detectionSettingsFold")) {
      const fold = document.createElement("details");
      fold.className = "detectionSettingsFold";
      const summary = document.createElement("summary");
      summary.textContent = "ALERT SETTINGS & FILTERS";
      fold.appendChild(summary);
      detectionActions.parentElement.insertBefore(fold, detectionActions);
      fold.appendChild(detectionActions);
    }

    const camera = document.getElementById("liveCamera");
    if (camera && !camera.querySelector(".visionToolsFold")) {
      const ai = camera.querySelector("#aiVisionBar");
      const face = camera.querySelector("#faceScanBar");
      if (ai || face) {
        const fold = document.createElement("details");
        fold.className = "controlSubFold visionToolsFold";
        fold.open = true; // Keep live face match and liveness instructions visible during scanning.
        const summary = document.createElement("summary");
        summary.textContent = "AI VISION & FACE SECURITY CONTROLS";
        fold.appendChild(summary);

        const insertionPoint = ai || face;
        camera.insertBefore(fold, insertionPoint);
        if (ai) fold.appendChild(ai);
        if (face) fold.appendChild(face);
      }
    }

    setOpen(false, false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
