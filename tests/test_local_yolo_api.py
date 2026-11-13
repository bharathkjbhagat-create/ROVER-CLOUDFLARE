import base64
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from src import local_ai_api as api


class LocalYoloApiTests(unittest.TestCase):
    def setUp(self):
        self.client = api.app.test_client()
        self.origin = {"Origin": next(iter(api.ALLOWED_ORIGINS))}

    def test_rejects_non_loopback_host(self):
        response = self.client.get("/health", headers={**self.origin, "Host": "evil.example"})
        self.assertEqual(response.status_code, 403)

    def test_rejects_unapproved_origin(self):
        response = self.client.get("/health", headers={"Origin": "https://attacker.invalid"})
        self.assertEqual(response.status_code, 403)

    def test_health_preflight_includes_private_network_cors(self):
        response = self.client.options("/health", headers={**self.origin, "Host": "127.0.0.1:8765"})
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], self.origin["Origin"])
        self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")

    def test_bad_images_are_rejected_before_inference(self):
        missing = self.client.post("/detect", json={}, headers=self.origin)
        malformed = self.client.post("/detect", json={"image": "%%%"}, headers=self.origin)
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(malformed.status_code, 400)

    def test_detect_returns_cpu_yolo_boxes(self):
        coord = SimpleNamespace(tolist=lambda: [10.0, 20.0, 80.0, 120.0])
        class_value = SimpleNamespace(item=lambda: 0)
        confidence = SimpleNamespace(item=lambda: 0.91)
        fake_box = SimpleNamespace(xyxy=[coord], cls=[class_value], conf=[confidence])
        fake_model = SimpleNamespace(predict=lambda *args, **kwargs: [SimpleNamespace(boxes=[fake_box], names={0: "person"})])
        fake_cv2 = SimpleNamespace(IMREAD_COLOR=1, imdecode=lambda *args: SimpleNamespace(size=9, shape=(120, 160, 3)))
        fake_numpy = SimpleNamespace(uint8="uint8", frombuffer=lambda *args, **kwargs: b"decoded")
        image = base64.b64encode(b"test-jpeg").decode("ascii")
        with patch.object(api, "_get_model", return_value=fake_model), patch.dict("sys.modules", {"cv2": fake_cv2, "numpy": fake_numpy}):
            response = self.client.post("/detect", json={"image": image}, headers=self.origin)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["engine"], "YOLOv8n CPU")
        self.assertEqual(data["detections"][0]["class"], "person")
        self.assertEqual(data["detections"][0]["box"], [10.0, 20.0, 80.0, 120.0])


if __name__ == "__main__":
    unittest.main()
