import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const opencvPath = resolve(root, "public/opencv-vision.js");
const opencvDist = resolve(root, "node_modules/@techstark/opencv-js/dist");
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>DEFENX OpenCV browser test</title><main>OpenCV test</main>");
    return;
  }
  if (req.url && req.url.startsWith("/vendor/")) {
    const name = req.url.slice("/vendor/".length).split("?")[0];
    if (!name || name.includes("/") || name.includes("..")) { res.writeHead(400); res.end("Invalid vendor path"); return; }
    readFile(resolve(opencvDist, name)).then(body => {
      const type = name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
      res.end(body);
    }).catch(() => { res.writeHead(404); res.end("Pinned OpenCV asset not found: " + name); });
    return;
  }
  if (req.url === "/opencv-vision.js") {
    readFile(opencvPath).then(body => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    }).catch(() => { res.writeHead(500); res.end("Unable to read OpenCV integration"); });
    return;
  }
  res.writeHead(404); res.end("Not found");
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
const origin = "http://127.0.0.1:" + address.port;
let browser;
let stage = "startup";
const watchdog = setTimeout(() => {
  console.error("FAIL: OpenCV browser integration exceeded 120 seconds at stage: " + stage);
  process.exit(1);
}, 120000);

try {
  stage = "launch Chromium";
  browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
  });
  stage = "create camera-enabled browser context";
  const context = await browser.newContext({
    permissions: ["camera"],
    viewport: { width: 900, height: 700 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  stage = "load local OpenCV test page";
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(url => { window.DEFENX_OPENCV_URL = url; }, origin + "/vendor/opencv.js");
  await page.addScriptTag({ url: origin + "/opencv-vision.js" });

  stage = "acquire synthetic live camera";
  const camera = await page.evaluate(async () => {
    const stream = await Promise.race([
      navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Synthetic camera permission/device timed out")), 15000))
    ]);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.appendChild(video);
    await Promise.race([
      video.play(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Synthetic camera video playback timed out")), 15000))
    ]);
    await Promise.race([
      new Promise((resolve, reject) => {
        if (video.videoWidth && video.videoHeight) return resolve();
        video.addEventListener("loadedmetadata", resolve, { once: true });
        video.addEventListener("error", reject, { once: true });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Synthetic camera metadata timed out")), 15000))
    ]);
    window.__defenxTestStream = stream;
    return { width: video.videoWidth, height: video.videoHeight, track: stream.getVideoTracks()[0]?.readyState };
  });
  if (!camera.width || !camera.height || camera.track !== "live") {
    throw new Error("Synthetic browser camera did not become a live video stream: " + JSON.stringify(camera));
  }
  console.log("PASS: Chromium acquired a live synthetic camera stream.");

  stage = "load pinned OpenCV.js 4.12 WebAssembly runtime";
  const runtime = await page.evaluate(async () => {
    const cv = await window.DEFENX_OPENCV.load();
    return {
      loaded: !!cv,
      state: window.DEFENX_OPENCV.getStatus().state,
      hasMat: !!(cv && cv.Mat),
      hasWasm: typeof WebAssembly !== "undefined"
    };
  });
  if (!runtime.loaded || !runtime.hasMat || !runtime.hasWasm || runtime.state !== "ready") {
    throw new Error("Official OpenCV.js WebAssembly runtime failed to initialise: " + JSON.stringify(runtime));
  }
  console.log("PASS: pinned OpenCV.js 4.12 runtime and WebAssembly initialised in Chromium.");

  stage = "run OpenCV motion detection";
  const metrics = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 160, 120);
    const baseline = window.DEFENX_OPENCV.process(ctx.getImageData(0, 0, 160, 120), 1000);

    ctx.fillStyle = "#fff";
    ctx.fillRect(35, 25, 45, 45);
    const changed = window.DEFENX_OPENCV.process(ctx.getImageData(0, 0, 160, 120), 2500);
    return {
      baseline: baseline && baseline.baseline,
      changedBaseline: changed && changed.baseline,
      moving: changed && changed.moving,
      motionPercent: changed && changed.motionPercent,
      processed: window.DEFENX_OPENCV.getStatus().stats.processedFrames,
      errors: window.DEFENX_OPENCV.getStatus().stats.errors
    };
  });
  if (!metrics.baseline || metrics.changedBaseline || !metrics.moving ||
      !(metrics.motionPercent > 0) || metrics.processed !== 2 || metrics.errors !== 0) {
    throw new Error("Pinned OpenCV.js frame processing did not produce the expected motion result: " + JSON.stringify(metrics));
  }
  console.log("PASS: real OpenCV.js processed image frames and detected controlled motion: " + JSON.stringify(metrics));

  stage = "close browser and camera";
  if (errors.length) throw new Error("Browser JavaScript errors: " + errors.join(" | "));
  await page.evaluate(() => {
    for (const track of window.__defenxTestStream?.getTracks?.() || []) track.stop();
  });
  await context.close();
} finally {
  clearTimeout(watchdog);
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
