/* Optional local Python YOLO service. Frames come only from the existing live camera. */
(() => {
  "use strict";
  const API = "http://127.0.0.1:8765";
  const panel = document.getElementById("localYoloPanel");
  const button = document.getElementById("localYoloToggle");
  const status = document.getElementById("localYoloStatus");
  if (!panel || !button || !status) return;
  if (location.pathname === "/demo" || new URLSearchParams(location.search).get("demo") === "1") {
    panel.hidden = true;
    return;
  }
  const ids = { person: "localYoloPeople", vehicle: "localYoloVehicles", object: "localYoloObjects" };
  const canvas = document.createElement("canvas");
  canvas.className = "localYoloCanvas";
  canvas.setAttribute("aria-label", "Local YOLO object detection overlay");
  canvas.hidden = true;
  let active = false, busy = false, timer = 0, source = null, generation = 0;
  const ctx = canvas.getContext("2d");
  const counts = { person: 0, vehicle: 0, object: 0 };
  const vehicleNames = new Set(["bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat"]);
  const alertCooldown = new Map();

  function setStatus(text, error) {
    status.textContent = text;
    panel.dataset.state = error ? "error" : active ? "active" : "idle";
  }
  function clear() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const key of Object.keys(counts)) {
      counts[key] = 0;
      const node = document.getElementById(ids[key]);
      if (node) node.textContent = "0";
    }
  }
  function liveSource() {
    const el = document.getElementById("roverRealCamera");
    if (!el || el.dataset.defenxLiveStream !== "1") return null;
    if (el.dataset.defenxRemoteCamera === "1" && el.dataset.defenxCameraActive !== "1") return null;
    if (el.tagName === "VIDEO" && !el.paused && el.readyState >= 2 && el.videoWidth && el.videoHeight) return el;
    if (el.tagName === "IMG" && el.complete && el.naturalWidth && el.naturalHeight) return el;
    return null;
  }
  async function health() {
    const response = await fetch(API + "/health", { mode: "cors", credentials: "omit", cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ready) throw new Error(data.model_found ? "AI packages unavailable in local Python environment" : "YOLO model file not found; see local AI setup guide");
    return data;
  }
  function draw(detections, width, height) {
    const host = source.parentElement || document.getElementById("cameraViewport");
    if (canvas.parentElement !== host) host.appendChild(canvas);
    const rect = host.getBoundingClientRect(), vw = Math.max(1, Math.round(rect.width)), vh = Math.max(1, Math.round(rect.height));
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
    ctx.clearRect(0, 0, vw, vh);
    const contain = getComputedStyle(source).objectFit === "contain";
    const scale = (contain ? Math.min : Math.max)(vw / width, vh / height);
    const ox = (vw - width * scale) / 2, oy = (vh - height * scale) / 2;
    clearCounts();
    for (const item of detections) {
      const name = String(item.class || "object").toLowerCase(), [x1, y1, x2, y2] = item.box || [];
      if (![x1, y1, x2, y2, item.confidence].every(Number.isFinite)) continue;
      if (name === "person") counts.person++;
      else if (vehicleNames.has(name)) counts.vehicle++;
      else counts.object++;
      const color = name === "person" ? "#46f0a1" : vehicleNames.has(name) ? "#55d8ff" : "#ffd466";
      const x = x1 * scale + ox, y = y1 * scale + oy, w = (x2 - x1) * scale, h = (y2 - y1) * scale;
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      const label = name.toUpperCase() + " " + Math.round(item.confidence * 100) + "%";
      ctx.font = "700 11px system-ui, sans-serif";
      const labelWidth = ctx.measureText(label).width + 10, top = Math.max(0, y - 18);
      ctx.fillStyle = color; ctx.fillRect(x, top, labelWidth, 17);
      ctx.fillStyle = "#07120d"; ctx.fillText(label, x + 5, top + 12);
    }
    publishAlerts(detections);
    for (const key of Object.keys(counts)) {
      const node = document.getElementById(ids[key]);
      if (node) node.textContent = String(counts[key]);
    }
    window.dispatchEvent(new CustomEvent("defenx-local-yolo-detection", {
      detail: { engine: "YOLOv8n CPU", ...counts, detections }
    }));
  }
  function publishAlerts(detections) {
    const alerts = window.DEFENX_ALERTS;
    if (!alerts || typeof alerts.offer !== "function") return;
    const cfg = alerts.config();
    const now = Date.now(), present = new Set();
    for (const item of detections) {
      const name = String(item.class || "object").toLowerCase();
      const isVehicle = vehicleNames.has(name);
      if (!(isVehicle ? cfg.vehicles : cfg.objects && cfg.objectClasses.includes(name))) continue;
      const category = isVehicle ? "vehicle_detected" : "object_detected";
      const key = category + ":" + name;
      present.add(key);
      const previous = alertCooldown.get(key) || 0;
      if (now - previous < 6000) continue;
      alertCooldown.set(key, now);
      alerts.offer({
        category, trackId: "local-yolo-" + name,
        status: isVehicle ? "LIVE VEHICLE" : "REAL-WORLD OBJECT",
        subject: name, confidence: Number(item.confidence) || 0, engine: "YOLOv8n CPU"
      });
    }
    for (const [key, at] of alertCooldown) if (now - at > 30000 && !present.has(key)) alertCooldown.delete(key);
  }
  function clearCounts() { counts.person = counts.vehicle = counts.object = 0; }
  async function scan() {
    if (!active || busy) return;
    source = liveSource();
    if (!source) { setStatus("Waiting for an authenticated live camera stream", false); return schedule(700); }
    busy = true;
    const version = generation;
    try {
      const size = source.tagName === "VIDEO"
        ? { width: source.videoWidth, height: source.videoHeight }
        : { width: source.naturalWidth, height: source.naturalHeight };
      const factor = Math.min(1, 640 / size.width), width = Math.max(1, Math.round(size.width * factor)), height = Math.max(1, Math.round(size.height * factor));
      const frame = document.createElement("canvas"); frame.width = width; frame.height = height;
      frame.getContext("2d").drawImage(source, 0, 0, width, height);
      const jpeg = frame.toDataURL("image/jpeg", 0.72);
      const response = await fetch(API + "/detect", {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: jpeg.split(",")[1] })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Local inference request failed");
      if (active && version === generation && source === liveSource()) {
        draw(data.detections || [], data.width, data.height);
        setStatus("LIVE • YOLOv8n CPU • " + (data.detections || []).length + " detections • frames sent to this PC only", false);
      }
      schedule(750);
    } catch (error) {
      if (active && version === generation) {
        clear();
        const message = String(error && error.message || error);
        setStatus(/taint|cross.origin|securityerror/i.test(message)
          ? "Camera feed blocks frame analysis • enable camera CORS"
          : message.includes("Failed to fetch") ? "Local AI server unreachable • start it on this PC"
          : message, true);
        schedule(2500);
      }
    } finally { busy = false; }
  }
  function schedule(delay) { if (timer) clearTimeout(timer); if (active) timer = setTimeout(scan, delay); }
  async function start() {
    button.disabled = true;
    setStatus("Checking local Python AI server…", false);
    try {
      await health();
      active = true; generation++;
      button.textContent = "STOP LOCAL YOLO"; button.disabled = false;
      canvas.hidden = false;
      setStatus("Ready • waiting for a live camera", false);
      scan();
    } catch (error) {
      setStatus(String(error && error.message || error), true);
      button.disabled = false;
    }
  }
  function stop() {
    active = false; generation++;
    if (timer) clearTimeout(timer);
    canvas.hidden = true; clear();
    button.textContent = "START LOCAL YOLO";
    setStatus("Stopped • camera frames are no longer sent to the local AI service", false);
  }
  button.addEventListener("click", () => active ? stop() : start());
  window.addEventListener("pagehide", stop);
  const cameraViewport = document.getElementById("cameraViewport");
  if (cameraViewport) new MutationObserver(() => { if (active) schedule(0); }).observe(cameraViewport, { childList: true });
})();
