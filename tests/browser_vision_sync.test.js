// Regression: standalone claim() must not recurse through the owner-event listener (RangeError: Maximum call stack size exceeded).
// Run: node --test tests/browser_vision_sync.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load() {
  const listeners = {};
  const window = {
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    dispatchEvent: e => { (listeners[e.type] || []).forEach(f => f(e)); return true; },
  };
  const ctx = { window, document: { hidden: false }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } }, Date, String };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/browser-vision-sync.js"), "utf8"), ctx);
  return { window, listeners };
}

test("standalone claim() returns true without recursing through the owner listener (ai-vision startDetection pattern)", () => {
  const { window } = load();
  let calls = 0;
  // Mirrors public/ai-vision.js: owner event with owned=true -> startDetection() -> claim()
  window.addEventListener("defenx-browser-vision-owner", e => { if (e.detail.owned) { calls++; assert.ok(calls < 50, "runaway recursion"); window.DEFENX_BROWSER_VISION_SYNC.claim(); } });
  assert.equal(window.DEFENX_BROWSER_VISION_SYNC.claim(), true);
  assert.equal(window.DEFENX_BROWSER_VISION_SYNC.owns(), true);
  assert.ok(calls <= 1, "listener ran " + calls + " times");
});

test("losing and regaining ownership still notifies listeners (state changes are not swallowed)", () => {
  const { window } = load();
  const seen = [];
  window.addEventListener("defenx-browser-vision-owner", e => seen.push(e.detail.owned));
  window.dispatchEvent({ type: "defenx-vision-sync-state", detail: { connected: true, joined: true } });
  assert.equal(window.DEFENX_BROWSER_VISION_SYNC.owns(), false);
  window.dispatchEvent({ type: "defenx-vision-sync-state", detail: { connected: false } });
  assert.equal(window.DEFENX_BROWSER_VISION_SYNC.owns(), true);
});

