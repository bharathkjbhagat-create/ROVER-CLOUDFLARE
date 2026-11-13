"""Optional loopback API for local DEFENX YOLOv8 inference.

This is a separate process from the Cloudflare Worker. It accepts frames already
provided by the authenticated dashboard camera and never opens a camera itself.
"""
from __future__ import annotations

import base64
import binascii
import importlib.util
import os
from pathlib import Path
import threading

from flask import Flask, jsonify, request

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ORIGIN = "https://defenx.bindukjagadish.workers.dev"
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MODEL_PATH = Path(os.getenv("DEFENX_YOLO_MODEL", str(ROOT / "yolov8n.pt"))).expanduser()
ALLOWED_ORIGINS = {
    value.strip().rstrip("/")
    for value in os.getenv("DEFENX_AI_ALLOWED_ORIGINS", DEFAULT_ORIGIN + ",http://127.0.0.1:5000,http://localhost:5000").split(",")
    if value.strip()
}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_BYTES * 2
_model = None
_model_lock = threading.Lock()


def _loopback_host(value: str) -> bool:
    value = (value or "").lower()
    host = value[1:value.find("]")] if value.startswith("[") and "]" in value else value.rsplit(":", 1)[0]
    return host in {"127.0.0.1", "localhost", "::1"}


@app.before_request
def restrict_local_api():
    if not _loopback_host(request.host):
        return jsonify({"ok": False, "error": "Local AI API only accepts loopback connections"}), 403
    origin = request.headers.get("Origin")
    if origin and origin.rstrip("/") not in ALLOWED_ORIGINS:
        return jsonify({"ok": False, "error": "Dashboard origin is not allowed"}), 403
    if request.method == "OPTIONS":
        return ("", 204)


@app.after_request
def cors_headers(response):
    origin = request.headers.get("Origin", "").rstrip("/")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Max-Age"] = "600"
        # Chromium may request this for an HTTPS dashboard reaching loopback.
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response


def _get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        if not MODEL_PATH.is_file():
            raise FileNotFoundError(f"YOLO model file not found: {MODEL_PATH}")
        from ultralytics import YOLO
        _model = YOLO(str(MODEL_PATH))
        return _model


@app.get("/health")
@app.route("/health", methods=["OPTIONS"])
def health():
    deps = {name: importlib.util.find_spec(name) is not None for name in ("cv2", "torch", "ultralytics")}
    ready = all(deps.values()) and MODEL_PATH.is_file()
    return jsonify({
        "ok": True, "service": "defenx-local-yolo", "ready": ready,
        "device": "cpu", "model": MODEL_PATH.name,
        "model_found": MODEL_PATH.is_file(), "dependencies": deps,
    }), (200 if ready else 503)


@app.post("/detect")
@app.route("/detect", methods=["OPTIONS"])
def detect():
    body = request.get_json(silent=True)
    encoded = body.get("image") if isinstance(body, dict) else None
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES * 4 // 3 + 8):
        return jsonify({"ok": False, "error": "Provide a base64 JPEG frame under 2 MB"}), 400
    if encoded.startswith("data:"):
        encoded = encoded.split(",", 1)[-1]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return jsonify({"ok": False, "error": "Invalid base64 image"}), 400
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        return jsonify({"ok": False, "error": "Image is empty or exceeds 2 MB"}), 400
    try:
        import cv2
        import numpy as np
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None or frame.size == 0:
            return jsonify({"ok": False, "error": "Could not decode image frame"}), 400
        results = _get_model().predict(frame, imgsz=416, device="cpu", conf=0.35, verbose=False)
    except FileNotFoundError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 503
    except ImportError as exc:
        return jsonify({"ok": False, "error": f"AI dependency unavailable: {exc.name}"}), 503
    except Exception:
        app.logger.exception("Local YOLO inference failed")
        return jsonify({"ok": False, "error": "Local inference failed; check the AI server log"}), 500

    detections = []
    for result in results:
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            coords = box.xyxy[0].tolist()
            cls_id = int(box.cls[0].item())
            names = result.names
            detections.append({
                "class": str(names.get(cls_id, cls_id) if isinstance(names, dict) else names[cls_id]),
                "confidence": round(float(box.conf[0].item()), 4),
                "box": [round(float(value), 2) for value in coords],
            })
    return jsonify({"ok": True, "engine": "YOLOv8n CPU", "width": int(frame.shape[1]),
                    "height": int(frame.shape[0]), "detections": detections})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.getenv("DEFENX_AI_PORT", "8765")), debug=False, threaded=True)
