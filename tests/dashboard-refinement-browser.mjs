import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const [css, script] = await Promise.all([
  readFile(path.join(root, "public/dashboard-refinement.css"), "utf8"),
  readFile(path.join(root, "public/dashboard-refinement.js"), "utf8")
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.setContent(`<!doctype html>
<html lang="en"><head>
<style>
  :root { --line: #586574; --card: #1f2933; }
  .sidebar { background: rgb(31, 41, 51); border-right: 2px solid rgb(81, 91, 101); }
  #mobileMenuBtn { background: rgb(61, 72, 83); border: 1px solid rgb(91, 102, 113); }
</style>
</head><body>
<header class="topbar">
  <div class="brandCluster"><div class="brandWords">
    <div class="brandName">DEFENX</div><div class="brandSub">Intelligence in Motion</div>
    <button id="mobileMenuBtn" type="button" aria-expanded="false" aria-controls="commandSidebar" aria-label="Open navigation"><span></span><span></span><span></span></button>
  </div></div>
</header>
<div id="mobileNavPanel" class="mobileNavPanel" aria-hidden="true"></div>
<div class="appShell">
  <aside id="commandSidebar" class="sidebar" aria-hidden="true" inert>
    <div class="sideTitle">COMMAND CENTRE</div>
    <nav class="sideNav">
      <button type="button" class="navItem" data-scroll="dashboardTop">Dashboard</button>
      <button type="button" class="navItem" data-scroll="liveMap">Live Map</button>
    </nav>
    <button type="button" id="sideLogoutBtn" class="sideLogout">Logout</button>
  </aside>
  <main class="dashboard" id="dashboardTop">
    <section class="dashboardGrid">
      <section id="liveMap" class="card mapCard">
        <div class="cardHeader mapHeader">
          <div><b>LIVE MAP</b></div>
          <div class="mapControls">
            <div class="mapTabs"><button type="button" id="streetLayerBtn">Street</button></div>
            <div class="mapUtilityControls"><button type="button" id="mapFollowBtn">FOLLOW ON</button></div>
          </div>
        </div>
      </section>
      <div class="rightStack">
        <section id="liveCamera" class="card cameraCard">
          <div id="aiVisionBar"><button type="button" id="aiVisionToggle">AI</button></div>
          <div id="faceScanBar"><button type="button" id="faceScanToggle">FACE</button></div>
          <section id="detectionEventsPanel">
            <div class="detectionEventsHead">
              <b>DETECTION EVENTS</b>
              <div class="detectionEventsActions">
                <button type="button" id="detectionAlertToggle">ALERTS</button>
                <button type="button" id="detectionClearBtn">CLEAR</button>
              </div>
            </div>
            <div id="detectionEventList"></div>
          </section>
        </section>
      </div>
    </section>
    <section class="controlCard">
      <div class="returnBaseActions">
        <button type="button" id="selectReturnBaseBtn">SELECT BASE</button>
        <button type="button" id="returnToBaseBtn">RETURN TO BASE</button>
        <button type="button" id="previewReturnRouteBtn" class="routePreviewBtn">ROAD ROUTE PREVIEW</button>
        <button type="button" id="simulateObstacleRouteBtn" class="routePreviewBtn">BLOCKED ROUTE</button>
        <button type="button" id="clearReturnRouteBtn" class="routePreviewBtn">CLEAR PREVIEW</button>
      </div>
    </section>
  </main>
</div>
</body></html>`);

  const watchedButtonIds = [
    "mapFollowBtn", "previewReturnRouteBtn", "simulateObstacleRouteBtn",
    "clearReturnRouteBtn", "aiVisionToggle", "faceScanToggle",
    "detectionAlertToggle", "detectionClearBtn"
  ];
  // Bind representative pre-existing direct and delegated handlers BEFORE the
  // refinement moves any of these elements, then prove both still fire.
  await page.evaluate(ids => {
    window.__directButtonClicks = [];
    window.__bubbledButtonClicks = [];
    for (const id of ids) {
      document.getElementById(id)?.addEventListener("click", () => window.__directButtonClicks.push(id));
    }
    document.addEventListener("click", event => {
      const button = event.target.closest("button[id]");
      if (button) window.__bubbledButtonClicks.push(button.id);
    });
  }, watchedButtonIds);

  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });

  const menu = page.locator("#mobileMenuBtn");
  const sidebar = page.locator("#commandSidebar");
  assert.equal(await menu.getAttribute("aria-controls"), "commandSidebar");
  assert.equal(await menu.getAttribute("aria-expanded"), "false");
  assert.equal(await sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(await sidebar.getAttribute("inert"), "");

  const originalTheme = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector(".sidebar")).backgroundColor,
    menu: getComputedStyle(document.querySelector("#mobileMenuBtn")).backgroundColor
  }));
  assert.equal(originalTheme.sidebar, "rgb(31, 41, 51)", "drawer CSS must not replace the existing sidebar theme");
  assert.equal(originalTheme.menu, "rgb(61, 72, 83)", "drawer CSS must not replace the existing menu-button theme");

  await menu.click();
  await page.waitForFunction(() =>
    document.body.classList.contains("defenx-drawer-open") &&
    document.getElementById("commandSidebar").getAttribute("aria-hidden") === "false"
  );
  assert.equal(await menu.getAttribute("aria-expanded"), "true");
  assert.equal(await sidebar.getAttribute("inert"), null);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".sidebar")).visibility), "visible");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".defenx-drawer-backdrop")).visibility), "visible");
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("navItem")), true);

  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.scroll), "liveMap");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "sideLogoutBtn");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.scroll), "dashboardTop");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "sideLogoutBtn");

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("defenx-drawer-open"));
  assert.equal(await menu.getAttribute("aria-expanded"), "false");
  assert.equal(await sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "mobileMenuBtn");

  await menu.click();
  const viewport = page.viewportSize();
  await page.locator(".defenx-drawer-backdrop").click({ position: { x: viewport.width - 8, y: 8 } });
  await page.waitForFunction(() => !document.body.classList.contains("defenx-drawer-open"));

  await menu.click();
  await page.locator("#commandSidebar .navItem").first().click();
  await page.waitForFunction(() => !document.body.classList.contains("defenx-drawer-open"));

  const structure = await page.evaluate(() => ({
    mapFold: Boolean(document.querySelector(".mapHeader > .inlineFold")),
    mapControlsMoved: document.querySelector(".mapControls")?.parentElement?.classList.contains("inlineFold"),
    routeFold: Boolean(document.querySelector(".advancedRouteFold")),
    routeButtonsInFold: ["previewReturnRouteBtn", "simulateObstacleRouteBtn", "clearReturnRouteBtn"]
      .every(id => document.querySelector(".advancedRouteFold")?.contains(document.getElementById(id))),
    visionFold: Boolean(document.querySelector("#liveCamera > .visionToolsFold")),
    aiAndFaceGrouped: ["aiVisionBar", "faceScanBar"].every(id =>
      document.querySelector(".visionToolsFold")?.contains(document.getElementById(id))),
    alertsRemainSeparate: !document.querySelector(".visionToolsFold")?.contains(document.getElementById("detectionEventsPanel")),
    alertActionsGrouped: Boolean(document.querySelector(".detectionSettingsFold")?.contains(document.getElementById("detectionAlertToggle"))),
    emptyLegacyPanel: document.querySelector("#mobileNavPanel")?.children.length === 0
  }));
  assert.deepEqual(structure, {
    mapFold: true,
    mapControlsMoved: true,
    routeFold: true,
    routeButtonsInFold: true,
    visionFold: true,
    aiAndFaceGrouped: true,
    alertsRemainSeparate: true,
    alertActionsGrouped: true,
    emptyLegacyPanel: true
  });

  await page.locator(".mapHeader > .inlineFold > summary").click();
  assert.equal(await page.locator(".inlineFold").getAttribute("open"), "");
  assert.notEqual(await page.locator(".mapControls").evaluate(el => getComputedStyle(el).display), "none");
  await page.locator(".advancedRouteFold > summary").click();
  await page.locator(".visionToolsFold > summary").click();
  await page.locator(".detectionSettingsFold > summary").click();

  for (const id of [
    "mapFollowBtn", "previewReturnRouteBtn", "simulateObstacleRouteBtn",
    "clearReturnRouteBtn", "aiVisionToggle", "faceScanToggle",
    "detectionAlertToggle", "detectionClearBtn"
  ]) {
    await page.locator("#" + id).click();
  }
  const [direct, bubbled] = await page.evaluate(() => [
    window.__directButtonClicks,
    window.__bubbledButtonClicks
  ]);
  for (const id of watchedButtonIds) {
    assert.ok(direct.includes(id), id + " must retain its direct handler after relocation");
    assert.ok(bubbled.includes(id), id + " must remain in the document click path after relocation");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await sidebar.evaluate(el => getComputedStyle(el).display), "flex");
  assert.equal(await menu.evaluate(el => getComputedStyle(el).display !== "none"), true);
  await menu.click();
  assert.equal(await sidebar.evaluate(el => getComputedStyle(el).visibility), "visible");
  await page.keyboard.press("Escape");
  assert.equal(await sidebar.getAttribute("aria-hidden"), "true");

  assert.deepEqual(pageErrors, [], "dashboard refinement should not throw browser errors");
  console.log("PASS: drawer open/close, backdrop, Escape, focus, tab target, mobile layout, and theme preservation.");
  console.log("PASS: map, route, AI/face, and alert controls stay reachable and retain bubbling after grouping.");
} finally {
  await browser.close();
}
