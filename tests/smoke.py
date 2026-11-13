"""Clean-repository smoke checks for DEFENX."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

os.environ.setdefault("SESSION_SECRET", "priority6-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "priority6-test-password")
os.environ.setdefault("ROVER_DEVICE_TOKEN", "priority6-test-device-token")

import app as rover_app

client = rover_app.app.test_client()

resp = client.get("/api/ping")
assert resp.status_code == 200 and resp.get_json().get("ok") is True

# Public demo entry serves the dashboard shell without creating a user session.
# Its APIs for live telemetry and control must remain private.
demo_client = rover_app.app.test_client()
demo_redirect = demo_client.get("/demo")
assert demo_redirect.status_code == 302
assert demo_redirect.headers.get("Location") == "/index.html?demo=1"
demo_resp = demo_client.get("/index.html?demo=1")
assert demo_resp.status_code == 200, demo_resp.status_code
assert demo_resp.headers.get("X-DEFENX-Demo") == "read-only"
assert b"/app.js?v=" in demo_resp.data  # Cache-busting version may change with each frontend release.
assert demo_client.get("/api/bootstrap").status_code == 401
assert demo_client.get("/api/telemetry").status_code == 401
assert demo_client.post("/api/command", json={"command":"FORWARD"}).status_code == 401
assert demo_client.get("/").status_code == 302

resp = client.post("/api/login", json={"username":"ROVERADMIN","password":"priority6-test-password"})
assert resp.status_code == 200, resp.get_data(as_text=True)

# Regression coverage for the historical deployment rejection: unknown and
# incomplete credentials must remain ordinary client errors, never HTTP 500.
resp = client.post("/api/login", json={"username":"__INVALID_TEST_USER__","password":"__INVALID_TEST_PASSWORD__"})
assert resp.status_code == 401, resp.get_data(as_text=True)
assert resp.get_json().get("ok") is False

resp = client.post("/api/login", json={"username":"","password":""})
assert resp.status_code == 400, resp.get_data(as_text=True)

worker_py = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
# Login responses, including the successful Set-Cookie path, use the
# Worker-compatible Response constructor with an explicit JSON body.
assert "return Response(" in worker_py
assert '"Set-Cookie": (' in worker_py
assert 'json.dumps(body, separators=(",", ":"))' in worker_py
assert "return Response.json(" not in worker_py

resp = client.get("/api/bootstrap")
assert resp.status_code == 200 and resp.get_json().get("telemetry") is not None

resp = client.post("/api/device/telemetry", json={"lat":12.9716,"lon":77.5946})
assert resp.status_code == 401

resp = client.post(
    "/api/device/telemetry",
    headers={"X-Rover-Device-Token":"priority6-test-device-token"},
    json={
        "lat":12.97161,"lon":77.59461,"accuracy_m":2.4,"speed_kmh":4.2,
        "heading":43,"battery":81,"signal":91,"gps_sats":12,"camera":True,
        "target":{"detected":False,"type":"Object"},
    },
)
assert resp.status_code == 200, resp.get_data(as_text=True)

app_js = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
assert "/api/camera-config" in app_js
assert "navigator.geolocation" not in app_js
phone_gps_js = (ROOT / "public" / "phone-gps.js").read_text(encoding="utf-8")
assert "navigator.geolocation.watchPosition" in phone_gps_js
assert "enableHighAccuracy:true" in phone_gps_js
assert 'bindTooltip("PHONE LOCATION"' in phone_gps_js
assert "L.circle" in phone_gps_js
assert "DEFENX_PHONE_GPS_CONTROL" in phone_gps_js
assert "fetch(" not in phone_gps_js  # Phone coordinates stay on-device; they are not uploaded.
assert "randomDemoPoint" in app_js
assert '$("warningToggleBtn")?.addEventListener("click",toggleWarningDisplay)' in app_js
assert "updateWarningControlUI({obstacle_cm:d.obstacle_cm,target:{detected}})" in app_js
assert 'localStorage.setItem("rover_warning_display"' in app_js
assert "ROVER_DEVICE" in app_js
assert "router.project-osrm.org/route/v1/driving/" in app_js
assert 'id="mapFollowBtn"' in (ROOT / "public" / "index.html").read_text(encoding="utf-8")
assert 'data-mapmode="hybrid"' in (ROOT / "public" / "index.html").read_text(encoding="utf-8")

ai_js = (ROOT / "public" / "ai-vision.js").read_text(encoding="utf-8")
yolox_js = (ROOT / "public" / "yolox-browser.js").read_text(encoding="utf-8")
index_html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
assert "YOLOX-Nano" in yolox_js and "MODEL_SHA256" in yolox_js
assert "onnxruntime-web@" in yolox_js and 'executionProviders: ["wasm"]' in yolox_js
assert "cocoSsd.load" not in ai_js and "model.detect(active, { maxDetections: 20" in ai_js
assert '/yolox-browser.js?v=20261113-01' in index_html
assert 'deviceTarget=String(input&&input.target_source||"")==="ROVER_DEVICE"' in app_js
assert '"person"' in yolox_js
assert '"motorcycle"' in (ROOT / "public" / "vision-core.js").read_text(encoding="utf-8")
assert "defenx-ai-detection" in ai_js
assert "navigator.mediaDevices.getUserMedia" not in ai_js
assert "const OBJECT_DELAY" in ai_js and "model.detect(active, 20, 0.4)" in ai_js
face_js = (ROOT / "public" / "face-recognition.js").read_text(encoding="utf-8")
assert "faceapi.detectAllFaces" in face_js and "window.DEFENX_FACE = {" in face_js
assert "function scheduleRender()" in phone_gps_js and "requestAnimationFrame" in phone_gps_js
assert "{enableHighAccuracy:true,maximumAge:1000,timeout:20000}" in phone_gps_js
phone_camera_js = (ROOT / "public" / "phone-camera.js").read_text(encoding="utf-8")
assert "navigator.mediaDevices.getUserMedia" in phone_camera_js
assert 'let facing="environment"' in phone_camera_js and "facingMode:{ideal:facing}" in phone_camera_js

print("DEFENX smoke tests: PASS")