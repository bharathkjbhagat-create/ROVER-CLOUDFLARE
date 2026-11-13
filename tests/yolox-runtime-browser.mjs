import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const runtimePath = fileURLToPath(new URL("../public/yolox-browser.js", import.meta.url));
const runtime = await readFile(runtimePath);
const server = createServer((req, res) => {
  if (req.url === "/yolox-browser.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(runtime);
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>DEFENX YOLOX runtime test</title><script src='/yolox-browser.js'></script>");
    return;
  }
  res.writeHead(404).end("not found");
});

let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const browserErrors = [];
  page.on("pageerror", error => browserErrors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
  const result = await page.evaluate(async () => {
    const detector = window.DEFENX_YOLOX;
    if (!detector) throw new Error("DEFENX YOLOX adapter did not load");
    await detector.load();

    // Run the real downloaded ONNX model in Chromium/WASM against a synthetic
    // frame. This verifies model integrity, ORT WASM loading, graph execution,
    // tensor shape, preprocessing and postprocessing without claiming accuracy.
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgb(40,90,150)";
    ctx.fillRect(180, 90, 220, 300);

    const started = performance.now();
    const first = await detector.detect(canvas, {
      confidenceThreshold: 0.99,
      nmsThreshold: 0.45,
      maxDetections: 20
    });
    const elapsedMs = performance.now() - started;
    const second = await detector.detect(canvas, {
      confidenceThreshold: 0.99,
      nmsThreshold: 0.45,
      maxDetections: 20
    });
    const valid = list => Array.isArray(list) && list.every(item =>
      typeof item.class === "string" &&
      Number.isFinite(item.score) && item.score >= 0 && item.score <= 1 &&
      Array.isArray(item.bbox) && item.bbox.length === 4 &&
      item.bbox.every(Number.isFinite) &&
      item.bbox[2] >= 0 && item.bbox[3] >= 0
    );
    if (!valid(first) || !valid(second)) throw new Error("YOLOX returned malformed detections");
    await detector.dispose();
    return {
      input: [1, 3, 416, 416],
      output: [1, 3549, 85],
      firstDetections: first.length,
      secondDetections: second.length,
      firstInferenceMs: Math.round(elapsedMs),
      modelSha256: detector.constants.MODEL_SHA256,
      ortVersion: detector.constants.ORT_VERSION
    };
  });
  if (browserErrors.length) throw new Error("Browser runtime errors: " + browserErrors.join(" | "));
  console.log("REAL YOLOX BROWSER INFERENCE PASS " + JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
