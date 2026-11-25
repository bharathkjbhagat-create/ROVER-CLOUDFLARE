/* DEFENX hosted YOLO client (object + face DETECTION only).
 * Sends a downscaled JPEG of the visible camera frame to the authenticated
 * same-origin proxy (/api/yolo/detect). The API key lives only in Cloudflare
 * Worker secrets; this file never sees it. Results are boxes + class names +
 * confidence. No identification, enrollment, matching or tracking of identity.
 */
(() => {
  "use strict";
  const viewport = document.getElementById("cameraViewport");
  const aiBar = document.getElementById("aiVisionBar");
  const demoMode = location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1";
  if (!viewport || !aiBar || demoMode) return;

  const MAX_SIDE = 640, JPEG_QUALITY = 0.7, INTERVAL_MS = 1200, MAX_BACKOFF_MS = 15000;
  let running = false, timer = 0, busy = false, failures = 0, configured = null, lastOk = 0;

  const style = document.createElement("style");
  style.textContent = ".hostedYoloBar{display:flex;align-items:center;gap:9px;padding:7px 10px;border-top:1px solid #193a4d;background:#07131d;font-size:9px;letter-spacing:.4px;color:#bafbe4}" +
    ".hostedYoloBar b{font-weight:900}.hostedYoloBar [data-role=state]{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:#9fc7d6}" +
    ".hostedYoloBar[data-state=error] [data-role=state]{color:#ff8a96}.hostedYoloBar[data-state=active] [data-role=state]{color:#7ff0c6}" +
    ".hostedYoloBar button{min-height:28px;padding:0 9px;border:1px solid #2a8872;border-radius:6px;background:#0d2923;color:#bafbe4;font-size:8px;font-weight:900;letter-spacing:.4px;cursor:pointer}" +
    ".hostedYoloBar button:disabled{opacity:.5;cursor:not-allowed}.hostedYoloPrivacy{flex:1 0 100%;font-size:8px;color:#93aebb}.hostedYoloCanvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9}";
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "hostedYoloBar";
  bar.id = "hostedYoloBar";
  bar.dataset.state = "off";
  bar.innerHTML = "<b>HOSTED YOLO</b><span data-role=\"state\" role=\"status\" aria-live=\"polite\">OFF</span><button type=\"button\" data-role=\"toggle\" title=\"Start or stop hosted detection\">START</button><small class=\"hostedYoloPrivacy\">Downscaled live frames are sent to the configured provider while detection is on.</small>";
  aiBar.insertAdjacentElement("afterend", bar);
  const stateEl = bar.querySelector("[data-role=state]"), toggle = bar.querySelector("[data-role=toggle]");

  const canvas = document.createElement("canvas");
  canvas.className = "hostedYoloCanvas";
  canvas.setAttribute("aria-hidden", "true");
  viewport.appendChild(canvas);
  const work = document.createElement("canvas");

  function setState(state, text) {
    bar.dataset.state = state;
    stateEl.textContent = text;
    toggle.textContent = running ? "STOP" : "START";
  }

  function frameSource() {
    const videos = Array.from(viewport.querySelectorAll("video"));
    return videos.find(v => v.readyState >= 2 && v.videoWidth > 0 && v.getBoundingClientRect().width > 0) || null;
  }

  function clearOverlay() {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw(result) {
    const rect = viewport.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = Math.max(2, canvas.width / 220);
    ctx.font = "600 " + Math.max(11, canvas.width / 28) + "px system-ui";
    const box = (b, color, label) => {
      const x = b.x1 * canvas.width, y = b.y1 * canvas.height;
      const w = (b.x2 - b.x1) * canvas.width, h = (b.y2 - b.y1) * canvas.height;
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return;
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.strokeRect(x, y, w, h);
      ctx.fillText(label, x + 2, Math.max(12, y - 3));
    };
    for (const d of result.detections) box(d.box, d.class_name === "person" ? "#20d5c2" : "#f7c948", d.class_name.toUpperCase() + " " + Math.round(d.confidence * 100) + "%");
    for (const f of result.faces) box(f.box, "#6aa8ff", "FACE DETECTED " + Math.round(f.confidence * 100) + "%");
  }

  async function checkConfigured() {
    try {
      const res = await fetch("/api/yolo/status", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json();
      configured = !!(res.ok && data && data.configured);
    } catch (_) { configured = null; }
    return configured;
  }

  function notifyOnDeviceAI(active) {
    window.dispatchEvent(new CustomEvent("defenx-hosted-yolo-state", { detail: { active: !!active } }));
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (running) timer = setTimeout(tick, delay);
  }

  async function tick() {
    if (!running || busy) return;
    const video = frameSource();
    if (!video) { setState("waiting", "WAITING FOR LIVE CAMERA"); return schedule(INTERVAL_MS); }
    busy = true;
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      work.width = Math.max(1, Math.round(video.videoWidth * scale));
      work.height = Math.max(1, Math.round(video.videoHeight * scale));
      work.getContext("2d").drawImage(video, 0, 0, work.width, work.height);
      const blob = await new Promise((resolve, reject) =>
        work.toBlob(b => b ? resolve(b) : reject(new Error("frame capture failed")), "image/jpeg", JPEG_QUALITY));
      const res = await fetch("/api/yolo/detect", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "image/jpeg" }, body: blob,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
      if (!running) return;
      if (res.status === 401) { running = false; notifyOnDeviceAI(false); clearOverlay(); setState("error", "SESSION EXPIRED • SIGN IN AGAIN"); return; }
      if (!res.ok || !data || data.ok !== true) {
        const err = new Error((data && data.error) || ("HTTP " + res.status));
        err.retryAfter = res.status === 429 ? 5000 : 0;
        throw err;
      }
      failures = 0; lastOk = Date.now();
      draw(data);
      const people = data.detections.filter(d => d.class_name === "person").length;
      setState("active", data.detections.length + " OBJECT(S) • " + people + " PERSON • " + data.faces.length + " FACE(S) DETECTED");
      window.dispatchEvent(new CustomEvent("defenx-hosted-yolo", { detail: data }));
      schedule(INTERVAL_MS);
    } catch (error) {
      if (!running) return;
      failures += 1;
      clearOverlay();
      const wait = Math.max(error.retryAfter || 0, Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** Math.min(failures, 4)));
      const msg = error.name === "SecurityError" ? "CAMERA FRAME CANNOT BE READ (CROSS-ORIGIN SOURCE)" : String(error.message || "REQUEST FAILED").toUpperCase();
      setState("error", "DETECTION FAILED • " + msg.slice(0, 90) + " • RETRY " + Math.round(wait / 1000) + "s");
      schedule(wait);
    } finally { busy = false; }
  }

  async function start() {
    toggle.disabled = true;
    setState("loading", "CHECKING HOSTED YOLO");
    const ok = await checkConfigured();
    toggle.disabled = false;
    if (ok === false) { running = false; setState("error", "NOT CONFIGURED • ADMIN MUST SET YOLO_API_KEY AND YOLO_API_URL"); return; }
    running = true; failures = 0;
    notifyOnDeviceAI(true);
    setState("loading", "STARTING");
    tick();
  }

  function stop() { running = false; notifyOnDeviceAI(false); clearTimeout(timer); clearOverlay(); setState("off", "OFF"); }
  toggle.addEventListener("click", () => (running ? stop() : start()));
  document.addEventListener("visibilitychange", () => { if (document.hidden && running) stop(); });
  window.DEFENX_HOSTED_YOLO = { start, stop, isRunning: () => running, lastOk: () => lastOk };
})();

