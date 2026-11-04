/* Real rover camera snapshot and recording actions.
 * This module never captures the simulated 3D room or an unrelated screen.
 */
(function () {
  "use strict";
  var demo = location.pathname === "/" || location.pathname === "/demo" ||
    new URLSearchParams(location.search).get("demo") === "1";
  var recorder = null, frameRequest = 0, bound = false;

  function status(message) {
    var el = document.getElementById("camActionStatus");
    if (el) el.textContent = message;
  }
  function emit(action, details) {
    window.dispatchEvent(new CustomEvent("defenx-camera-action", {
      detail: { action: action, details: details }
    }));
  }
  function sourceFrame() {
    if (demo) throw new Error("Live camera capture is disabled in demo mode.");
    var el = document.getElementById("roverRealCamera");
    if (!el) throw new Error("No authenticated rover camera stream is connected.");
    if (el.tagName === "IFRAME") throw new Error("This embedded camera does not expose frames for capture.");
    var width = el.tagName === "VIDEO" ? el.videoWidth : el.naturalWidth;
    var height = el.tagName === "VIDEO" ? el.videoHeight : el.naturalHeight;
    var ready = el.tagName === "VIDEO" ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!ready || !width || !height) throw new Error("The live rover camera has not produced a frame yet.");
    return { element: el, width: width, height: height };
  }
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  function cameraError(error, action) {
    var message = error && error.name === "SecurityError"
      ? "Camera server must allow CORS for browser-side capture."
      : (error && error.message || "Camera action could not be completed.");
    status(message);
    if (action) emit("CAMERA_ACTION_FAILED", action + ": " + message);
  }
  function snapshot() {
    try {
      var frame = sourceFrame(), canvas = document.createElement("canvas");
      canvas.width = frame.width; canvas.height = frame.height;
      var context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas capture is unavailable.");
      context.drawImage(frame.element, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        if (!blob) { status("The browser could not create the camera image."); return; }
        saveBlob(blob, "DEFENX-ROVER-01-camera-" +
          new Date().toISOString().replace(/[:.]/g, "-") + ".png");
        status("Live camera frame saved.");
        emit("CAMERA_SNAPSHOT", "Live rover camera frame saved");
      }, "image/png");
    } catch (error) { cameraError(error, "Snapshot"); }
  }
  function updateRecordButton(active) {
    var button = document.getElementById("camRecordBtn");
    if (!button) return;
    button.textContent = active ? "■" : "●";
    button.title = active ? "Stop camera recording" : "Start camera recording";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(active));
    button.classList.toggle("active", active);
  }
  function record() {
    if (recorder && recorder.state === "recording") {
      status("Finishing camera recording…");
      recorder.stop();
      return;
    }
    var stream = null;
    try {
      if (typeof MediaRecorder === "undefined") throw new Error("Video recording is not supported by this browser.");
      if (!HTMLCanvasElement.prototype.captureStream) throw new Error("Canvas video recording is not supported by this browser.");
      var frame = sourceFrame(), scale = Math.min(1, 1920 / Math.max(frame.width, frame.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(frame.width * scale));
      canvas.height = Math.max(1, Math.round(frame.height * scale));
      var context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas recording is unavailable.");
      context.drawImage(frame.element, 0, 0, canvas.width, canvas.height);
      stream = canvas.captureStream(15);
      var types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      var mime = types.find(function (type) { return MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type); });
      var activeRecorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1800000 } : { videoBitsPerSecond: 1800000 });
      var chunks = [];
      recorder = activeRecorder;
      activeRecorder.ondataavailable = function (event) {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      activeRecorder.onerror = function () {
        status("Camera recording encountered a browser or stream error.");
        try { if (activeRecorder.state !== "inactive") activeRecorder.stop(); } catch (_) {}
      };
      activeRecorder.onstop = function () {
        if (frameRequest) cancelAnimationFrame(frameRequest);
        frameRequest = 0;
        stream.getTracks().forEach(function (track) { track.stop(); });
        var type = activeRecorder.mimeType || mime || "video/webm";
        var blob = chunks.length ? new Blob(chunks, { type: type }) : null;
        recorder = null;
        updateRecordButton(false);
        if (blob && blob.size) {
          var extension = type.indexOf("mp4") >= 0 ? "mp4" : "webm";
          saveBlob(blob, "DEFENX-ROVER-01-recording-" +
            new Date().toISOString().replace(/[:.]/g, "-") + "." + extension);
          status("Live camera recording saved.");
          emit("CAMERA_RECORDING_SAVED", "Live camera recording saved");
        } else {
          status("No camera video data was recorded.");
        }
      };
      activeRecorder.start(1000);
      updateRecordButton(true);
      status("Recording live rover camera…");
      emit("CAMERA_RECORDING_STARTED", "Live rover camera recording started");
      var lastFrame = 0;
      function drawFrame(timestamp) {
        if (recorder !== activeRecorder || activeRecorder.state !== "recording") return;
        if (timestamp - lastFrame >= 66) {
          try {
            if (!frame.element.isConnected) throw new Error("Live camera disconnected. Recording stopped.");
            context.drawImage(frame.element, 0, 0, canvas.width, canvas.height);
            lastFrame = timestamp;
          } catch (error) {
            cameraError(error, "Recording");
            try { activeRecorder.stop(); } catch (_) {}
            return;
          }
        }
        frameRequest = requestAnimationFrame(drawFrame);
      }
      frameRequest = requestAnimationFrame(drawFrame);
    } catch (error) {
      if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
      recorder = null;
      updateRecordButton(false);
      cameraError(error, "Recording");
    }
  }
  function bind() {
    if (bound) return;
    bound = true;
    var shot = document.getElementById("camShotBtn");
    var rec = document.getElementById("camRecordBtn");
    if (shot) shot.addEventListener("click", snapshot);
    if (rec) {
      updateRecordButton(false);
      rec.addEventListener("click", record);
    }
  }
  window.DEFENX_CAMERA_ACTIONS = { bind: bind };
})();
