"""Single-process DEFENX local vision service.

Receives frames from the dashboard; it never opens a camera. Load YOLO once per
process and serialize inference to avoid duplicate model work and camera owners.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile


MAX_IMAGE_BYTES = 10 * 1024 * 1024
VEHICLE_CLASSES = {1, 2, 3, 4, 5, 6, 7, 8}
ALERTS: deque[dict[str, Any]] = deque(maxlen=500)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iou(a: dict[str, int], b: dict[str, int]) -> float:
    x1, y1 = max(a["x1"], b["x1"]), max(a["y1"], b["y1"])
    x2, y2 = min(a["x2"], b["x2"]), min(a["y2"], b["y2"])
    intersection = max(0, x2 - x1) * max(0, y2 - y1)
    area_a = max(0, a["x2"] - a["x1"]) * max(0, a["y2"] - a["y1"])
    area_b = max(0, b["x2"] - b["x1"]) * max(0, b["y2"] - b["y1"])
    return intersection / max(1, area_a + area_b - intersection)


class VisionEngine:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.yolo = None
        self.device = "cpu"
        self.cuda = False
        self.yolo_error: str | None = None
        self.face_error: str | None = None
        self.face_detector = None
        self.face_recognizer = None
        self.names: dict[int, str] = {}
        self.object_tracks: list[dict[str, Any]] = []
        self.face_tracks: list[dict[str, Any]] = []
        self.next_track = 1
        self.alert_last_seen: dict[str, float] = {}
        self.gallery_path = Path(os.getenv("DEFENX_FACE_GALLERY", "data/face_gallery.json"))

    def load(self) -> None:
        try:
            from ultralytics import YOLO
            weights = Path(os.getenv("DEFENX_YOLO_MODEL", "yolov8n.pt"))
            if not weights.is_file():
                raise RuntimeError(f"YOLO weights not found: {weights}")
            try:
                import torch
                self.cuda = bool(torch.cuda.is_available())
            except Exception:
                self.cuda = False
            requested = os.getenv("DEFENX_AI_DEVICE", "auto").lower()
            self.device = "0" if self.cuda and requested in {"auto", "cuda", "gpu", "0"} else "cpu"
            self.yolo = YOLO(str(weights))
            names = getattr(self.yolo, "names", {})
            self.names = {int(k): str(v) for k, v in names.items()} if hasattr(names, "items") else {i: str(v) for i, v in enumerate(names)}
            self.yolo_error = None
        except Exception as exc:
            # Keep face-only scans available when YOLO weights, CUDA, or Ultralytics fail.
            self.yolo = None
            self.yolo_error = str(exc)
        self._load_face_models()

    def _load_face_models(self) -> None:
        try:
            detector_path = Path(os.getenv("DEFENX_YUNET_MODEL", "models/face_detection_yunet_2023mar.onnx"))
            recognizer_path = Path(os.getenv("DEFENX_SFACE_MODEL", "models/face_recognition_sface_2021dec.onnx"))
            if not detector_path.is_file() or not recognizer_path.is_file():
                raise FileNotFoundError("Place the OpenCV Zoo YuNet and SFace ONNX files in models/ or set DEFENX_YUNET_MODEL and DEFENX_SFACE_MODEL.")
            self.face_detector = cv2.FaceDetectorYN.create(str(detector_path), "", (320, 320), 0.75, 0.3, 5000)
            self.face_recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), "")
            self.face_error = None
        except Exception as exc:
            self.face_detector = self.face_recognizer = None
            self.face_error = str(exc)

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self.yolo is not None else "error",
            "model_loaded": self.yolo is not None,
            "model": os.getenv("DEFENX_YOLO_MODEL", "yolov8n.pt"),
            "device": "cuda:0" if self.device == "0" else "cpu",
            "face_detection_loaded": self.face_detector is not None,
            "face_recognition_loaded": self.face_recognizer is not None,
            "enrolled_people": len(self._gallery()),
            "camera": "stopped",
            "camera_error": None,
            "error": self.yolo_error,
        }

    def _gallery(self) -> dict[str, list[list[float]]]:
        try:
            data = json.loads(self.gallery_path.read_text(encoding="utf-8"))
            return {str(k): v for k, v in data.items() if isinstance(v, list)}
        except (OSError, ValueError, TypeError):
            return {}

    def _save_gallery(self, gallery: dict[str, list[list[float]]]) -> None:
        self.gallery_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.gallery_path.with_suffix(".tmp")
        temp.write_text(json.dumps(gallery, separators=(",", ":")), encoding="utf-8")
        temp.replace(self.gallery_path)

    @staticmethod
    def decode(data: bytes) -> np.ndarray:
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Image must be between 1 byte and 10 MB")
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid image")
        return image

    def _objects(self, image: np.ndarray) -> list[dict[str, Any]]:
        if self.yolo is None:
            return []
        try:
            predictions = self.yolo.predict(image, device=self.device, verbose=False, conf=0.25, iou=0.5, max_det=100)
        except Exception as exc:
            if self.device != "0":
                raise
            # Recover from CUDA driver/OOM errors by retrying the same frame on CPU.
            self.device = "cpu"
            try:
                predictions = self.yolo.predict(image, device="cpu", verbose=False, conf=0.25, iou=0.5, max_det=100)
            except Exception:
                self.yolo_error = str(exc)
                raise
        result = predictions[0]
        detections = []
        for box in result.boxes:
            class_id = int(box.cls.item())
            confidence = float(box.conf.item())
            xyxy = box.xyxy[0].tolist()
            coords = [int(round(v)) for v in xyxy]
            coords[0] = max(0, min(image.shape[1] - 1, coords[0]))
            coords[2] = max(coords[0] + 1, min(image.shape[1], coords[2]))
            coords[1] = max(0, min(image.shape[0] - 1, coords[1]))
            coords[3] = max(coords[1] + 1, min(image.shape[0], coords[3]))
            name = self.names.get(class_id, str(class_id))
            detections.append({"class_id": class_id, "class_name": name, "confidence": round(confidence, 4), "alert": class_id == 0 or class_id in VEHICLE_CLASSES,
                               "box": dict(zip(("x1", "y1", "x2", "y2"), coords))})
        # Suppress duplicates across model outputs by class and overlap.
        detections.sort(key=lambda d: d["confidence"], reverse=True)
        unique: list[dict[str, Any]] = []
        for item in detections:
            if not any(item["class_id"] == prev["class_id"] and _iou(item["box"], prev["box"]) >= 0.65 for prev in unique):
                unique.append(item)
        return unique

    def _faces(self, image: np.ndarray) -> list[dict[str, Any]]:
        if self.face_detector is None or self.face_recognizer is None:
            return []
        h, w = image.shape[:2]
        self.face_detector.setInputSize((w, h))
        _, raw = self.face_detector.detect(image)
        if raw is None:
            return []
        boxes = []
        for face in raw:
            x, y, fw, fh = [int(round(v)) for v in face[:4]]
            box = {"x1": max(0, x), "y1": max(0, y), "x2": min(w, x + fw), "y2": min(h, y + fh)}
            if box["x2"] <= box["x1"] or box["y2"] <= box["y1"]:
                continue
            if any(_iou(box, prior) >= 0.55 for prior in boxes):
                continue
            boxes.append(box)
        gallery = self._gallery()
        results = []
        for box in boxes:
            # YuNet row for SFace alignment consists of box, landmarks and detector confidence.
            matching = next((row for row in raw if abs(int(row[0]) - box["x1"]) <= 2 and abs(int(row[1]) - box["y1"]) <= 2), None)
            if matching is None:
                continue
            aligned = self.face_recognizer.alignCrop(image, matching)
            feature = self.face_recognizer.feature(aligned).flatten().astype(np.float32)
            identity, similarity = "UNKNOWN", 0.0
            ranked = []
            for name, samples in gallery.items():
                for sample in samples:
                    sample_vec = np.asarray(sample, dtype=np.float32)
                    denom = float(np.linalg.norm(feature) * np.linalg.norm(sample_vec))
                    ranked.append((float(np.dot(feature, sample_vec) / denom) if denom else -1.0, name))
            ranked.sort(reverse=True)
            if ranked and ranked[0][0] >= 0.42 and (len(ranked) == 1 or ranked[0][0] - ranked[1][0] >= 0.06):
                similarity, identity = ranked[0]
            results.append({"identity": identity, "match_status": "recognized" if identity != "UNKNOWN" else "unknown",
                            "detection_confidence": round(float(matching[-1]), 4), "similarity": round(float(similarity), 4), "box": box})
        return results

    def _track(self, detections: list[dict[str, Any]], kind: str) -> None:
        tracks = self.object_tracks if kind == "object" else self.face_tracks
        now = time.monotonic()
        remaining = list(tracks)
        for item in detections:
            box = item["box"]
            key = str(item.get("class_name") if kind == "object" else "face")
            candidates = [track for track in remaining if track.get("key") == key]
            best = max(candidates, key=lambda t: _iou(box, t["box"]), default=None)
            if best and _iou(box, best["box"]) >= 0.25:
                item["track_id"] = best["id"]
                best["box"] = box
                best["at"] = now
                remaining.remove(best)
            else:
                item["track_id"] = self.next_track
                self.next_track += 1
                tracks.append({"id": item["track_id"], "key": key, "box": box, "at": now})
        tracks[:] = [t for t in tracks if now - t["at"] < 2.0]

    def infer(self, image: np.ndarray, include_objects: bool, include_faces: bool, source: str) -> dict[str, Any]:
        with self.lock:
            detections = self._objects(image) if include_objects else []
            faces = self._faces(image) if include_faces else []
            self._track(detections, "object")
            self._track(faces, "face")
        h, w = image.shape[:2]
        timestamp = _now()
        events = []
        monotonic_now = time.monotonic()
        present_alerts = set()
        for item in detections:
            cid = item["class_id"]
            if cid == 0 or cid in VEHICLE_CLASSES:
                key = "object:" + str(item["track_id"])
                present_alerts.add(key)
                if monotonic_now - self.alert_last_seen.get(key, 0) < 10:
                    continue
                self.alert_last_seen[key] = monotonic_now
                label = item["class_name"].title()
                events.append({"event_id": str(uuid.uuid4()), "type": "detection_alert", "timestamp": timestamp,
                               "source": source, "class_id": cid, "class_name": item["class_name"],
                               "confidence": item["confidence"], "box": item["box"], "track_id": item["track_id"], "message": label + " detected"})
        for face in faces:
            if face["match_status"] == "recognized":
                key = "face:" + str(face["track_id"])
                present_alerts.add(key)
                if monotonic_now - self.alert_last_seen.get(key, 0) < 10:
                    continue
                self.alert_last_seen[key] = monotonic_now
                events.append({"event_id": str(uuid.uuid4()), "type": "face_recognized", "timestamp": timestamp,
                               "source": source, "identity": face["identity"], "confidence": face["detection_confidence"],
                               "similarity": face["similarity"], "box": face["box"], "track_id": face["track_id"],
                               "message": "Known person detected: " + face["identity"]})
        for key, seen_at in list(self.alert_last_seen.items()):
            if key not in present_alerts and monotonic_now - seen_at > 30:
                del self.alert_last_seen[key]
        ALERTS.extend(events)
        return {"timestamp": timestamp, "source": source, "device": "cuda:0" if self.device == "0" else "cpu",
                "width": w, "height": h, "detections": detections, "faces": faces, "events": events,
                "alerts": events}


def create_app(engine: VisionEngine | None = None) -> FastAPI:
    ai = engine or VisionEngine()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await asyncio.to_thread(ai.load)
        app.state.ai = ai
        yield
        # There is no camera or background inference loop to stop.

    app = FastAPI(title="DEFENX Local Vision", version="1.0", lifespan=lifespan)
    from fastapi.middleware.cors import CORSMiddleware
    origins = os.getenv("DEFENX_AI_ALLOWED_ORIGINS", "https://defenx.bindukjagadish.workers.dev,http://127.0.0.1:5000,http://localhost:5000").split(",")
    allowed_origins = [origin.strip() for origin in origins if origin.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=allowed_origins, allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["*"], allow_credentials=False)

    @app.middleware("http")
    async def allow_private_network_preflight(request, call_next):
        response = await call_next(request)
        origin = request.headers.get("origin")
        if origin in allowed_origins and request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    async def read_image(image: UploadFile) -> np.ndarray:
        data = await image.read(MAX_IMAGE_BYTES + 1)
        return ai.decode(data)

    async def detect(image: UploadFile, objects: bool, faces: bool, source: str = "upload"):
        frame = await read_image(image)
        if faces and not ai.face_detector:
            raise HTTPException(status_code=503, detail="Local face models are unavailable")
        return await asyncio.to_thread(ai.infer, frame, objects, faces, source)

    @app.get("/health")
    async def health():
        return ai.health()

    @app.post("/vision-detect")
    async def vision_detect(image: UploadFile = File(...), include_objects: bool = Form(True), include_faces: bool = Form(True)):
        return await detect(image, include_objects, include_faces)

    @app.post("/detect")
    async def detect_both(image: UploadFile = File(...)):
        return await detect(image, True, True)

    @app.post("/face-detect")
    async def face_detect(image: UploadFile = File(...)):
        return await detect(image, False, True)

    @app.get("/alerts")
    async def alerts():
        return {"events": list(ALERTS)[-100:], "count": len(ALERTS)}

    @app.get("/faces")
    async def faces():
        gallery = ai._gallery()
        return {"people": [{"name": name, "samples": len(samples)} for name, samples in gallery.items()]}

    @app.post("/faces/enroll")
    async def enroll(name: str = Form(...), image: UploadFile = File(...)):
        clean_name = " ".join(name.strip().split())[:80]
        if not clean_name:
            raise HTTPException(status_code=400, detail="Name is required")
        frame = await read_image(image)
        if not ai.face_detector or not ai.face_recognizer:
            raise HTTPException(status_code=503, detail="Local face models are unavailable")
        with ai.lock:
            ai.face_detector.setInputSize((frame.shape[1], frame.shape[0]))
            _, found = ai.face_detector.detect(frame)
            if found is None or len(found) != 1:
                raise HTTPException(status_code=400, detail="Enrollment requires exactly one clear face")
            aligned = ai.face_recognizer.alignCrop(frame, found[0])
            sample = ai.face_recognizer.feature(aligned).flatten().astype(np.float32).tolist()
            gallery = ai._gallery()
            gallery.setdefault(clean_name, []).append(sample)
            gallery[clean_name] = gallery[clean_name][-20:]
            ai._save_gallery(gallery)
        return {"status": "enrolled", "name": clean_name, "samples": len(gallery[clean_name]), "photo_saved": False}

    @app.delete("/faces/{name}")
    async def delete_face(name: str):
        with ai.lock:
            gallery = ai._gallery()
            if name not in gallery:
                raise HTTPException(status_code=404, detail="Person not found")
            del gallery[name]
            ai._save_gallery(gallery)
        return {"status": "deleted", "name": name}

    return app


app = create_app()

