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

resp = client.post("/api/login", json={"username":"ROVERADMIN","password":"priority6-test-password"})
assert resp.status_code == 200, resp.get_data(as_text=True)

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
assert "ROVER_DEVICE" in app_js

print("DEFENX smoke tests: PASS")
