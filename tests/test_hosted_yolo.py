"""Hosted YOLO proxy: validation, normalisation, auth, secret hygiene, detection-only guarantee."""
from __future__ import annotations

import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-yolo-test-session-secret")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import yolo_proxy as yp  # noqa: E402
import app as rover_app  # noqa: E402

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
FAKE_KEY = "TESTKEY-not-a-real-secret-123456"
FAKE_URL = "https://detect.example.com/model/1"

UPSTREAM = {
    "image": {"width": 640, "height": 480},
    "predictions": [
        {"x": 320, "y": 240, "width": 100, "height": 200, "confidence": 0.91, "class": "person", "class_id": 0,
         "identity": "JOHN DOE", "embedding": [0.1] * 128},
        {"x": 100, "y": 100, "width": 40, "height": 40, "confidence": 0.8, "class": "face", "name": "Alice"},
        {"x": 10, "y": 10, "width": 10, "height": 10, "confidence": 0.1, "class": "cup"},
        {"x": 5, "y": 5, "width": -4, "height": 10, "confidence": 0.9, "class": "bad"},
        {"x": "nan", "y": 5, "width": 4, "height": 10, "confidence": 0.9, "class": "bad2"},
    ],
}


class ProxyLogicTests(unittest.TestCase):
    def test_normalize_boxes_and_filters(self):
        out = yp.normalize_response(UPSTREAM)
        self.assertTrue(out["ok"])
        self.assertEqual([d["class_name"] for d in out["detections"]], ["person"])
        box = out["detections"][0]["box"]
        self.assertAlmostEqual(box["x1"], (320 - 50) / 640, places=4)
        self.assertAlmostEqual(box["y2"], (240 + 100) / 480, places=4)
        self.assertEqual(len(out["faces"]), 1)

    def test_no_identity_fields_leak(self):
        text = json.dumps(yp.normalize_response(UPSTREAM), separators=(",", ":")).lower().replace("class_name", "class")
        for banned in ("john", "alice", "identity", "embedding", "\"name\":", "match_status", "descriptor"):
            self.assertNotIn(banned, text)
        self.assertEqual(set(yp.normalize_response(UPSTREAM)["faces"][0]), {"confidence", "box"})

    def test_bad_payloads_rejected(self):
        for bad in (None, [], {}, {"predictions": "x"}, {"predictions": [], "image": {}}):
            with self.assertRaises(yp.YoloError):
                yp.normalize_response(bad)

    def test_decode_image_limits(self):
        self.assertEqual(yp.decode_image(JPEG, "image/jpeg"), JPEG)
        for body, ctype, status in ((b"", "image/jpeg", 400), (JPEG, "text/plain", 415),
                                    (b"notanimage", "image/jpeg", 400),
                                    (JPEG + b"0" * yp.MAX_IMAGE_BYTES, "image/jpeg", 413)):
            with self.assertRaises(yp.YoloError) as ctx:
                yp.decode_image(body, ctype)
            self.assertEqual(ctx.exception.status, status)

    def test_url_ssrf_guard(self):
        for bad in ("", "http://x.com/a", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.5/a",
                    "https://169.254.169.254/a", "https://u:p@x.com/a", "https://svc.internal/a", "ftp://x.com"):
            with self.assertRaises(yp.YoloError, msg=bad):
                yp.validate_upstream_url(bad)
        self.assertEqual(yp.validate_upstream_url(FAKE_URL), FAKE_URL)

    def test_build_upstream_keeps_key_out_of_url_and_encodes(self):
        url, headers, body = yp.build_upstream(FAKE_URL + "?api_key=evil&x=1", FAKE_KEY, JPEG)
        self.assertNotIn("api_key", url)
        self.assertNotIn("evil", url)
        self.assertEqual(headers["Authorization"], "Bearer " + FAKE_KEY)
        self.assertIn("x=1", url)
        self.assertTrue(body.isascii())
        with self.assertRaises(yp.YoloError):
            yp.build_upstream(FAKE_URL, "", JPEG)

    def test_status_mapping(self):
        self.assertEqual(yp.map_upstream_status(401).code, "upstream_auth")
        self.assertEqual(yp.map_upstream_status(429).status, 429)
        self.assertEqual(yp.map_upstream_status(500).code, "upstream_unavailable")


class FlaskRouteTests(unittest.TestCase):
    def setUp(self):
        # Other test modules mutate these module globals; pin them so this
        # class is order-independent, and restore them afterwards.
        for name, value in (("ADMIN_USERNAME", "ROVERADMIN"), ("DATABASE_URL", ""),
                            ("NEON_DIRECT_DATABASE_URL", ""), ("CF_ENV", None)):
            patcher = patch.object(rover_app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = rover_app.app.test_client()

    def _login(self):
        with self.client.session_transaction() as sess:
            sess["user_cache"] = {"id": "t", "username": "ROVERADMIN", "role": "admin", "enabled": True,
                                  "can_control": True, "can_manage_users": True}
            sess["auth_source"] = "environment"

    def test_requires_login(self):
        self.assertEqual(self.client.post("/api/yolo/detect", data=JPEG, content_type="image/jpeg").status_code, 401)
        self.assertEqual(self.client.get("/api/yolo/status").status_code, 401)

    def test_end_to_end_with_mock_upstream_and_secret_hygiene(self):
        self._login()
        seen = {}

        class FakeResp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["authorization"] = req.get_header("Authorization")
            seen["body"] = req.data
            return FakeResp(json.dumps(UPSTREAM).encode())

        env = {"YOLO_API_KEY": FAKE_KEY, "YOLO_API_URL": FAKE_URL}
        with patch.dict(os.environ, env), patch("urllib.request.urlopen", fake_urlopen):
            status = self.client.get("/api/yolo/status")
            self.assertEqual(status.status_code, 200)
            self.assertTrue(status.get_json()["configured"])
            self.assertFalse(status.get_json()["identification"])
            res = self.client.post("/api/yolo/detect", data=JPEG, content_type="image/jpeg")
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        raw = res.get_data(as_text=True)
        self.assertNotIn(FAKE_KEY, raw)
        self.assertNotIn(FAKE_KEY, json.dumps(dict(status.headers)))
        self.assertNotIn(FAKE_KEY, seen["url"])
        self.assertEqual(seen["authorization"], "Bearer " + FAKE_KEY)
        self.assertEqual(res.get_json()["detections"][0]["class_name"], "person")
        self.assertEqual(res.headers["Cache-Control"], "no-store")

    def test_not_configured_and_bad_input_and_upstream_errors(self):
        self._login()
        blank = {"YOLO_API_KEY": "", "YOLO_API_URL": ""}
        with patch.dict(os.environ, blank):
            r = self.client.post("/api/yolo/detect", data=JPEG, content_type="image/jpeg")
            self.assertEqual((r.status_code, r.get_json()["code"]), (503, "not_configured"))
            self.assertFalse(self.client.get("/api/yolo/status").get_json()["configured"])
        env = {"YOLO_API_KEY": FAKE_KEY, "YOLO_API_URL": FAKE_URL}
        import urllib.error
        with patch.dict(os.environ, env):
            self.assertEqual(self.client.post("/api/yolo/detect", data=b"", content_type="image/jpeg").status_code, 400)
            self.assertEqual(self.client.post("/api/yolo/detect", data=JPEG, content_type="text/plain").status_code, 415)
            for code, expect in ((401, 502), (429, 429), (500, 502)):
                def boom(req, timeout=None, code=code):
                    raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
                with patch("urllib.request.urlopen", boom):
                    r = self.client.post("/api/yolo/detect", data=JPEG, content_type="image/jpeg")
                self.assertEqual(r.status_code, expect)
                self.assertNotIn(FAKE_KEY, r.get_data(as_text=True))
            with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
                r = self.client.post("/api/yolo/detect", data=JPEG, content_type="image/jpeg")
            self.assertEqual(r.get_json()["code"], "upstream_unreachable")


class StaticWiringTests(unittest.TestCase):
    def read(self, rel): return (ROOT / rel).read_text(encoding="utf-8")

    def test_worker_route_is_authenticated_and_never_logs_secrets(self):
        worker = self.read("src/worker.py")
        self.assertIn('url.path == "/api/yolo/detect"', worker)
        self.assertIn("if not valid_session_cookie", worker)
        self.assertIn("def _json_response(", worker)
        block = worker[worker.index("async def _handle_yolo_detect"):worker.index("async def fetch(self, request)")]
        self.assertIn("self._json_response(", block)
        self.assertNotIn("print(f\"DEFENX hosted YOLO upstream fetch failed: {exc", block)
        self.assertNotIn("print(url", block)

    def test_frontend_loaded_and_has_no_secrets_or_identity_api(self):
        self.assertIn("/hosted-yolo.js", self.read("public/index.html"))
        js = self.read("public/hosted-yolo.js")
        self.assertNotIn("YOLO_API_KEY", js.replace("ADMIN MUST SET YOLO_API_KEY AND YOLO_API_URL", ""))
        self.assertNotIn("api_key", js)
        for banned in ("descriptor", "enroll", "match_status", "identify"):
            self.assertNotIn(banned, js.lower().replace("no identification, enrollment, matching or tracking of identity", ""))

    def test_no_secret_values_committed(self):
        for rel in (".env.example", ".env.local.example", "wrangler.jsonc"):
            for line in self.read(rel).splitlines():
                if line.startswith("YOLO_API_KEY=") or line.startswith("YOLO_API_URL="):
                    self.assertEqual(line.split("=", 1)[1].strip(), "")


if __name__ == "__main__":
    unittest.main()

