import io
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "local_ai_server"))
import ai_server as api


class FakeTensor:
    def __init__(self, value):
        self.value = value
    def item(self):
        return self.value


class FakeBox:
    def __init__(self, cls, conf, coords):
        self.cls = FakeTensor(cls)
        self.conf = FakeTensor(conf)
        self.xyxy = [SimpleNamespace(tolist=lambda: coords)]


class FakeModel:
    names = {0: "person", 2: "car"}
    def predict(self, *args, **kwargs):
        return [SimpleNamespace(boxes=[
            FakeBox(0, 0.9, [10, 10, 80, 90]),
            FakeBox(0, 0.8, [11, 11, 81, 91]),
            FakeBox(2, 0.8, [100, 10, 180, 90]),
        ])]


class FakeFaceDetector:
    def setInputSize(self, size):
        self.size = size
    def detect(self, image):
        # YuNet rows: xywh, five landmarks, confidence.
        row1 = [10, 10, 25, 25] + [0] * 10 + [0.99]
        row2 = [60, 10, 25, 25] + [0] * 10 + [0.98]
        return 1, np.asarray([row1, row2], dtype=np.float32)


class FakeFaceRecognizer:
    def alignCrop(self, image, row):
        return image[:10, :10]
    def feature(self, aligned):
        return np.asarray([[1.0, 0.0]], dtype=np.float32)


class LocalVisionTests(unittest.TestCase):
    def setUp(self):
        self.engine = api.VisionEngine()
        self.engine.yolo = FakeModel()
        self.engine.names = FakeModel.names
        self.engine.face_detector = FakeFaceDetector()
        self.engine.face_recognizer = FakeFaceRecognizer()
        self.client = TestClient(api.create_app(self.engine))
        self.image = np.zeros((120, 200, 3), dtype=np.uint8)
        ok, encoded = cv2.imencode(".jpg", self.image)
        self.jpeg = encoded.tobytes()
        self.engine._gallery = lambda: {"Bharath": [[1.0, 0.0]]}

    def tearDown(self):
        self.client.close()

    def test_duplicate_object_boxes_are_suppressed_but_distinct_classes_remain(self):
        detections = self.engine._objects(self.image)
        self.assertEqual(len(detections), 2)
        self.assertEqual({d["class_name"] for d in detections}, {"person", "car"})

    def test_multiple_faces_keep_recognized_and_unknown_statuses(self):
        self.engine._gallery = lambda: {"Bharath": [[1.0, 0.0], [0.0, 1.0]]}
        result = self.engine._faces(self.image)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["match_status"], "recognized")
        self.assertEqual(result[0]["identity"], "Bharath")
        self.assertEqual(result[1]["match_status"], "unknown")
        self.assertEqual(result[1]["identity"], "UNKNOWN")

    def test_face_only_endpoint_does_not_require_or_call_yolo(self):
        self.engine.yolo = None
        response = self.client.post("/vision-detect", data={"include_objects": "false", "include_faces": "true"},
                                    files={"image": ("frame.jpg", self.jpeg, "image/jpeg")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["faces"]), 2)
        self.assertEqual(response.json()["detections"], [])

    def test_health_reports_camera_stopped_and_device(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["camera"], "stopped")
        self.assertEqual(response.json()["device"], "cpu")


if __name__ == "__main__":
    unittest.main()
