import { chromium } from "playwright";

const base = (process.env.WORKER_URL || "").replace(/\/$/, "");
const username = process.env.PREVIEW_ADMIN_USERNAME || "";
const password = process.env.PREVIEW_ADMIN_PASSWORD || "";
if (!base || !username || !password) throw new Error("Preview URL and isolated preview admin credentials are required.");

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
});
const context = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 1365, height: 900 }
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));

try {
  const response = await page.goto(base + "/login.html", { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new Error("Preview login page did not load: HTTP " + (response?.status() ?? "no response"));
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#submit").click();
  await page.waitForURL(url => url.pathname === "/index.html", { timeout: 20000 });

  const faceSection = page.locator("#faceVerification");
  await faceSection.waitFor({ state: "visible" });
  const scanButton = page.locator("#defenxStartFaceScan");
  await scanButton.waitFor({ state: "visible" });
  if (!(await scanButton.isEnabled())) throw new Error("Start Face Scan button is disabled.");

  // Fake Chromium camera only: no real device, person, enrollment, or uploaded frame.
  await scanButton.click();
  await page.waitForFunction(() => {
    const video = document.getElementById("roverRealCamera");
    return video && video.tagName === "VIDEO" && video.srcObject &&
      video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }, undefined, { timeout: 20000 });
  const cameraStatus = await faceSection.locator(".faceHint").innerText();
  if (!cameraStatus.includes("LOCAL DEVICE CAMERA ACTIVE")) {
    throw new Error("Camera status did not confirm the test camera: " + cameraStatus);
  }
  const stopButton = faceSection.getByRole("button", { name: "STOP DEVICE CAMERA" });
  if (!(await stopButton.isVisible())) throw new Error("Stop Device Camera button did not appear.");
  console.log("PASS: authenticated admin dashboard opened the face-verification panel.");
  console.log("PASS: Start Face Scan click handler opened Chromium's synthetic camera feed.");
  console.log("PASS: camera status and Stop Device Camera control updated.");

  await stopButton.click();
  await page.waitForFunction(() => {
    const video = document.getElementById("roverRealCamera");
    return !video || !video.srcObject;
  });
  const stopped = await faceSection.locator(".faceHint").innerText();
  if (!stopped.includes("Local camera stopped")) throw new Error("Camera did not report a clean stop.");
  console.log("PASS: Stop Device Camera released the synthetic stream.");

  if (pageErrors.length) throw new Error("Uncaught browser errors: " + pageErrors.join(" | "));
  console.log("PASS: no uncaught browser JavaScript errors.");
} finally {
  await context.close();
  await browser.close();
}
