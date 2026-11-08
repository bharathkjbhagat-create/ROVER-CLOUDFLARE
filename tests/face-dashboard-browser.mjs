import { chromium } from "playwright";

const base = (process.env.WORKER_URL || "").replace(/\/$/, "");
const username = process.env.PREVIEW_ADMIN_USERNAME || "";
const password = process.env.PREVIEW_ADMIN_PASSWORD || "";
if (!base || !username || !password) throw new Error("Preview URL and isolated admin credentials are required.");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

// Deterministic test doubles for the face models. The camera input below is a
// generated canvas stream, never a physical camera or a real person's image.
await page.addInitScript(() => {
  const emptyFaces = Promise.resolve([]);
  window.faceapi = {
    nets: {
      tinyFaceDetector: { loadFromUri: async () => {} },
      faceLandmark68TinyNet: { loadFromUri: async () => {} },
      faceRecognitionNet: { loadFromUri: async () => {} }
    },
    TinyFaceDetectorOptions: function () {},
    detectAllFaces: () => ({ withFaceLandmarks: async () => emptyFaces }),
    detectSingleFace: () => ({
      withFaceLandmarks: () => ({ withFaceDescriptor: async () => null })
    })
  };

  // Replace only the browser permission boundary with a synthetic canvas stream.
  // This exercises the real USE PHONE CAMERA click handler without physical hardware.
  const devices = navigator.mediaDevices;
  if (devices) {
    Object.defineProperty(devices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 480;
        const context = canvas.getContext("2d");
        context.fillStyle = "#333"; context.fillRect(0, 0, 640, 480);
        const stream = canvas.captureStream(10);
        window.__defenxTestCameraStream = stream;
        return stream;
      }
    });
  }
});

try {
  const login = await page.goto(base + "/login.html", { waitUntil: "domcontentloaded" });
  if (!login?.ok()) throw new Error("Preview login page did not load.");
  await page.locator("#desktop-username").fill(username);
  await page.locator("#desktop-password").fill(password);
  await page.locator("#desktop-submit").click();
  await page.waitForURL(url => url.pathname === "/index.html", { timeout: 20000 });
  await page.waitForFunction(() => window.DEFENX_FACE && document.getElementById("faceScanToggle"));

  const cameraButton = page.locator("#phoneCameraBtn");
  await cameraButton.click();
  await page.waitForFunction(() => {
    const video = document.getElementById("roverRealCamera");
    return video && video.dataset.defenxLiveStream === "1" &&
      video.srcObject && document.getElementById("phoneCameraBtn")?.textContent.includes("STOP PHONE CAMERA");
  });
  await page.waitForFunction(() => {
    const video = document.getElementById("roverRealCamera");
    return video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  });
  console.log("PASS: USE PHONE CAMERA click starts the real camera lifecycle with a synthetic stream.");

  const toggle = page.locator("#faceScanToggle");
  await page.waitForFunction(() => {
    const button = document.getElementById("faceScanToggle");
    const bar = document.getElementById("faceScanBar");
    return button && !button.disabled && bar?.dataset.state === "active";
  }, undefined, { timeout: 20000 });
  if (!(await toggle.isEnabled())) throw new Error("Face ID control did not enable on synthetic live video.");
  console.log("PASS: encrypted Durable Object registry loaded for the admin dashboard.");
  console.log("PASS: synthetic live camera stream enabled the Face ID control.");

  await toggle.click();
  await page.waitForFunction(() => document.getElementById("faceScanState")?.textContent.includes("FACE ID STOPPED BY OPERATOR"));
  console.log("PASS: STOP FACE ID control changes the scanner state.");

  await toggle.click();
  await page.waitForFunction(() => document.getElementById("faceScanBar")?.dataset.state === "active");
  if (!(await page.evaluate(() => window.DEFENX_FACE.active()))) {
    throw new Error("Face ID did not resume after the START FACE ID click.");
  }
  console.log("PASS: START FACE ID control resumes the scanner.");

  await cameraButton.click();
  await page.waitForFunction(() => document.getElementById("phoneCameraBtn")?.textContent.includes("USE PHONE CAMERA"));
  const tracksStopped = await page.evaluate(() =>
    (window.__defenxTestCameraStream?.getTracks?.() || []).every(track => track.readyState === "ended")
  );
  if (!tracksStopped) throw new Error("STOP PHONE CAMERA did not release the synthetic media tracks.");
  console.log("PASS: STOP PHONE CAMERA releases the media stream.");

  if (pageErrors.length) throw new Error("Uncaught browser errors: " + pageErrors.join(" | "));
  console.log("PASS: no uncaught dashboard JavaScript errors.");
} finally {
  await page.evaluate(() => {
    for (const track of window.__defenxTestCameraStream?.getTracks?.() || []) track.stop();
  }).catch(() => {});
  await context.close();
  await browser.close();
}
