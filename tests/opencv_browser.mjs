import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const opencvPath = resolve(root, "public/opencv-vision.js");
const server = createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><meta charset=utf-8><title>DEFENX OpenCV browser test</title><main>OpenCV test</main>");
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

try {
  browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
  });
  const context = await browser.newContext({
    permissions: ["camera"],
    viewport: { width: 900, height: 700 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ url: origin + "/opencv-vision.js" });

  const camera = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    await new Promise((resolve, reject) => {
      if (video.videoWidth && video.videoHeight) return resolve();
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", reject, { once: true });
    });
    window.__defenxTestStream = stream;
    return { width: video.videoWidth, height: video.videoHeight, track: stream.getVideoTracks()[0]?.readyState };
  });
  if (!camera.width || !camera.height || camera.track !== "live") {
    throw new Error("Synthetic browser camera did not become a live video stream: " + JSON.stringify(camera));
  }
  console.log("PASS: Chromium acquired a live synthetic camera stream.");

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
  console.log("PASS: official OpenCV.js runtime and WebAssembly initialised in Chromium.");

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
    const changed = window.DEFENX_OPENCV.process(ctx.getImageData(0, 0, 160, 120), 1600);
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
    throw new Error("Real OpenCV.js frame processing did not produce the expected motion result: " + JSON.stringify(metrics));
  }
  console.log("PASS: real OpenCV.js processed image frames and detected controlled motion: " + JSON.stringify(metrics));

  if (errors.length) throw new Error("Browser JavaScript errors: " + errors.join(" | "));
  await page.evaluate(() => {
    for (const track of window.__defenxTestStream?.getTracks?.() || []) track.stop();
  });
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
