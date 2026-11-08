import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const base = (process.env.DEFENX_BASE_URL || "https://defenx.bindukjagadish.workers.dev").replace(/\/$/, "");
const outDir = path.resolve("artifacts/browser-audit");
await fs.mkdir(outDir, { recursive: true });

const results = [];
const failures = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: "PASS", detail });
    console.log("PASS:", name, "-", detail);
  } catch (error) {
    failures.push({ name, error: String(error) });
    results.push({ name, status: "FAIL", detail: String(error) });
    console.error("FAIL:", name, "-", error.message);
  }
}

try {
  const login = await context.newPage();
  login.setDefaultTimeout(15000);
  const loginErrors = [];
  login.on("pageerror", e => loginErrors.push(e.message));

  await check("Production login page loads", async () => {
    const response = await login.goto(base + "/login.html", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response || !response.ok()) throw new Error("HTTP " + (response?.status() ?? "no response"));
    await login.locator("body").waitFor({ state: "visible" });
    const text = (await login.locator("body").innerText()).trim();
    if (!text) throw new Error("Login page body is empty");
    const inputs = await login.locator("input").count();
    if (inputs < 1) throw new Error("No login inputs found");
    return "HTTP " + response.status() + "; " + inputs + " input(s); visible page text " + text.slice(0, 140).replace(/\s+/g, " ");
  });

  await check("Login page has no uncaught JavaScript errors", async () => {
    if (loginErrors.length) throw new Error(loginErrors.join(" | "));
    return "No uncaught page errors observed during initial load";
  });

  const demo = await context.newPage();
  demo.setDefaultTimeout(15000);
  const demoErrors = [];
  demo.on("pageerror", e => demoErrors.push(e.message));

  await check("Read-only demo dashboard loads", async () => {
    const response = await demo.goto(base + "/index.html?demo=1", { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response || !response.ok()) throw new Error("HTTP " + (response?.status() ?? "no response"));
    await demo.locator("body").waitFor({ state: "visible" });
    const text = (await demo.locator("body").innerText()).trim();
    if (!text) throw new Error("Dashboard body is empty");
    if (!/DEFENX|ROVER|MAP|DASHBOARD/i.test(text)) throw new Error("Expected dashboard content not found");
    return "HTTP " + response.status() + "; visible dashboard text " + text.slice(0, 220).replace(/\s+/g, " ");
  });

  await check("Demo dashboard has no uncaught JavaScript errors", async () => {
    if (demoErrors.length) throw new Error(demoErrors.join(" | "));
    return "No uncaught page errors observed during initial load";
  });

  await check("Public health endpoint responds", async () => {
    const response = await context.request.get(base + "/api/health", { timeout: 15000 });
    if (!response.ok()) throw new Error("HTTP " + response.status());
    return "HTTP " + response.status();
  });

  await check("Unauthenticated session endpoint is protected", async () => {
    const response = await context.request.get(base + "/api/me", { timeout: 15000 });
    if (![401, 403].includes(response.status())) throw new Error("Expected 401/403, received " + response.status());
    return "HTTP " + response.status() + " (unauthenticated request rejected)";
  });

  if (failures.length) {
    await login.screenshot({ path: path.join(outDir, "login.png"), fullPage: true }).catch(() => {});
    await demo.screenshot({ path: path.join(outDir, "demo-dashboard.png"), fullPage: true }).catch(() => {});
  }
} finally {
  await context.close();
  await browser.close();
}

await fs.writeFile(path.join(outDir, "results.json"), JSON.stringify({ base, results, failures }, null, 2));
console.log("\nBrowser audit summary:", results.filter(x => x.status === "PASS").length, "passed,", failures.length, "failed.");
if (failures.length) process.exitCode = 1;
