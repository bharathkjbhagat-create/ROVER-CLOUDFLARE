"""HTTP-level tests for /api/fleet/* using Flask's test client (real routing, real signatures)."""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-auth-regression-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402
import fleet as F  # noqa: E402

MASTER = "api-test-master-secret-0123456789abcdefgh"
HB = "/api/fleet/heartbeat"


def status(**o):
    s = {"lat": 12.9716, "lon": 77.5946, "gps_fix": True, "accuracy_m": 3, "gps_sats": 9, "gps_age_ms": 100, "battery": 80,
         "signal": 70, "camera": True, "fsm": "IDLE", "estop": False,
         "obstacle": {"front": {"cm": 150, "valid": True}, "left": {"cm": 90, "valid": True}, "right": {"cm": 90, "valid": True}},
         "caps": {"autonomous_navigation": True, "obstacle_avoidance": True, "obstacle_sensor_healthy": True,
                  "safety_controller_healthy": True}}
    s.update(o)
    return s


class FleetApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = rover_app.app.extensions["fleet_service"]
        cls.service.master = MASTER

    def setUp(self):
        self.service.store = F.MemoryFleetStore()
        for lim in rover_app.app.extensions["fleet_limiters"]:
            lim.reset()
        self.service.primary_rover = "ROVER-01"
        self.seq = {}
        self.admin = rover_app.app.test_client()
        rover_app.clear_login_failures("127.0.0.1")
        with patch.object(rover_app, "DATABASE_URL", None), patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
                patch.object(rover_app, "db_available", return_value=False), patch.object(rover_app, "ensure_db", return_value=None):
            r = self.admin.post("/api/login", json={"username": rover_app.ADMIN_USERNAME, "password": rover_app.ADMIN_PASSWORD})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.anon = rover_app.app.test_client()
        self.device = rover_app.app.test_client()   # device channel has no cookies at all

    def register(self, did, role):
        r = self.admin.post("/api/fleet/devices", json={"id": did, "name": did, "role": role})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        return r.get_json()["secret"]

    def dev_post(self, secret, did, path, payload, nonce=None, ts=None, raw=None, client=None):
        body = raw if raw is not None else json.dumps(payload, separators=(",", ":")).encode()
        ts = str(time.time() if ts is None else ts)
        nonce = nonce or os.urandom(12).hex()
        hdr = {"Content-Type": "application/json", "X-Device-Id": did, "X-Timestamp": ts, "X-Nonce": nonce,
               "X-Signature": F.sign_request(secret, "POST", path, did, ts, nonce, body)}
        r = (client or self.device).post(path, data=body, headers=hdr)
        return r, nonce

    def hb(self, secret, did, **o):
        self.seq[did] = self.seq.get(did, 0) + 1
        r, nonce = self.dev_post(secret, did, HB, status(seq=self.seq[did], boot_id="b1", **o))
        return r, nonce

    # ---------------- authentication / authorisation ----------------
    def test_operator_endpoints_require_login(self):
        for method, url in (("get", "/api/fleet/state"), ("get", "/api/fleet/events"), ("post", "/api/fleet/devices"),
                            ("post", "/api/fleet/base"), ("post", "/api/fleet/command"), ("get", "/api/fleet/base")):
            r = getattr(self.anon, method)(url)
            self.assertEqual(r.status_code, 401, url)

    def test_device_endpoints_reject_unsigned_and_cookie_only(self):
        for url in (HB, "/api/fleet/events/upload", "/api/fleet/commands/ack"):
            self.assertEqual(self.anon.post(url, json={}).status_code, 401, url)
            self.assertEqual(self.admin.post(url, json={}).status_code, 401, "operator cookie must not act as a device: " + url)

    def test_registration_returns_secret_once_and_never_in_state(self):
        secret = self.register("ROVER-01", "rover")
        self.assertEqual(len(secret), 64)
        blob = json.dumps([self.admin.get("/api/fleet/state").get_json(), self.admin.get("/api/fleet/events").get_json(),
                           self.admin.get("/api/telemetry").get_json()])
        self.assertNotIn(secret, blob)
        self.assertEqual(self.admin.post("/api/fleet/devices", json={"id": "ROVER-01", "name": "x", "role": "rover"}).status_code, 409)

    def test_invalid_registration_inputs(self):
        for body in ({"id": "x", "role": "rover"}, {"id": "GOOD-1", "role": "king"}, {"id": "bad id!", "role": "rover"}, {}):
            self.assertEqual(self.admin.post("/api/fleet/devices", json=body).status_code, 400, body)

    def test_websocket_ticket_is_signed_short_lived_and_stored_only_by_hash(self):
        secret = self.register("PHONE-01", "phone")
        r, nonce = self.dev_post(secret, "PHONE-01", "/api/fleet/ws-ticket", {})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        data = r.get_json()
        self.assertEqual(data["transport"], "websocket")
        self.assertGreaterEqual(data["expires_at"], int(time.time()))
        self.assertEqual(r.headers["X-Server-Signature"],
                         F.sign_response(secret, "PHONE-01", nonce, r.get_data()))
        self.assertNotIn(data["ticket"], json.dumps(self.service.store._data))
        digest = __import__("hashlib").sha256(data["ticket"].encode("ascii")).hexdigest()
        self.assertIn("ws_ticket:" + digest, self.service.store._data)

    def test_valid_heartbeat_signed_response_and_replay_protection(self):
        secret = self.register("ROVER-01", "rover")
        r, nonce = self.hb(secret, "ROVER-01")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        sig = r.headers["X-Server-Signature"]
        self.assertEqual(sig, F.sign_response(secret, "ROVER-01", nonce, r.get_data()))
        # exact replay of the same signed request
        self.seq["ROVER-01"] -= 1
        body = json.dumps(status(seq=1, boot_id="b1"), separators=(",", ":")).encode()
        r1, n = self.dev_post(secret, "ROVER-01", HB, None, raw=body, nonce="fixednonce1234567890")
        r2, _ = self.dev_post(secret, "ROVER-01", HB, None, raw=body, nonce="fixednonce1234567890")
        self.assertEqual(r2.status_code, 409)

    def test_wrong_secret_and_revoked_device(self):
        secret = self.register("ROVER-01", "rover")
        r, _ = self.dev_post("f" * 64, "ROVER-01", HB, status())
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.admin.delete("/api/fleet/devices/ROVER-01").status_code, 200)
        r, _ = self.hb(secret, "ROVER-01")
        self.assertEqual(r.status_code, 401)

    def test_old_timestamp_rejected(self):
        secret = self.register("ROVER-01", "rover")
        r, _ = self.dev_post(secret, "ROVER-01", HB, status(), ts=time.time() - 3600)
        self.assertEqual(r.status_code, 401)

    def test_malformed_json_with_valid_signature(self):
        secret = self.register("ROVER-01", "rover")
        r, _ = self.dev_post(secret, "ROVER-01", HB, None, raw=b"{not json")
        self.assertEqual(r.status_code, 400)

    def test_oversize_body_rejected(self):
        secret = self.register("ROVER-01", "rover")
        r, _ = self.dev_post(secret, "ROVER-01", HB, None, raw=b"x" * 40000)
        self.assertIn(r.status_code, (401, 413))

    def test_device_rate_limit(self):
        secret = self.register("ROVER-01", "rover")
        codes = [self.hb(secret, "ROVER-01")[0].status_code for _ in range(120)]
        self.assertIn(429, codes)
        self.assertEqual(codes[0], 200)

    # ---------------- two-device sync ----------------
    def test_location_and_status_propagate_between_devices(self):
        s_rover, s_phone = self.register("ROVER-01", "rover"), self.register("PHONE-01", "phone")
        self.hb(s_phone, "PHONE-01", lat=13.0, lon=77.7, battery=64)
        r, _ = self.hb(s_rover, "ROVER-01", battery=52)
        peers = {p["id"]: p for p in r.get_json()["peers"]}
        self.assertEqual((peers["PHONE-01"]["lat"], peers["PHONE-01"]["battery"]), (13.0, 64))
        r, _ = self.hb(s_phone, "PHONE-01", lat=13.0, lon=77.7, battery=64)
        self.assertEqual({p["id"]: p for p in r.get_json()["peers"]}["ROVER-01"]["battery"], 52)
        st = self.admin.get("/api/fleet/state").get_json()
        self.assertEqual({d["id"] for d in st["devices"] if d["online"]}, {"ROVER-01", "PHONE-01"})

    def test_primary_rover_mirrors_into_existing_dashboard_telemetry(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01", lat=12.5, lon=77.5, battery=61, obstacle={"front": {"cm": 87, "valid": True}})
        t = self.admin.get("/api/telemetry").get_json()
        self.assertEqual((t["lat"], t["lon"], t["battery"], t["obstacle_cm"]), (12.5, 77.5, 61, 87))
        self.assertEqual(t["gps_source"], "ROVER_DEVICE")
        self.assertTrue(t["safety_controller_healthy"] and t["autonomous_navigation"])
        self.assertTrue(t["device_online"])

    def test_phone_does_not_overwrite_rover_telemetry(self):
        s_phone = self.register("PHONE-01", "phone")
        before = self.admin.get("/api/telemetry").get_json()
        self.hb(s_phone, "PHONE-01", lat=1.0, lon=1.0, battery=1)
        after = self.admin.get("/api/telemetry").get_json()
        self.assertEqual((before["lat"], before["battery"]), (after["lat"], after["battery"]))

    def test_invalid_gps_and_sensor_data_not_mirrored_as_valid(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01", obstacle={"front": {"cm": 0, "valid": True}})
        t = self.admin.get("/api/telemetry").get_json()
        self.assertFalse(t["obstacle_valid"])
        self.hb(secret, "ROVER-01", lat=float("nan"), gps_fix=True)
        t = self.admin.get("/api/telemetry").get_json()
        self.assertFalse(t["gps_fix"])

    # ---------------- commands ----------------
    def command(self, device, cmd, client=None):
        return (client or self.admin).post("/api/fleet/command", json={"device_id": device, "command": cmd})

    def test_command_flow_delivery_ack_and_audit(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01")
        r = self.command("ROVER-01", "FORWARD")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        hb, _ = self.hb(secret, "ROVER-01")
        cmds = hb.get_json()["commands"]
        self.assertEqual(cmds[0]["command"], "FORWARD")
        ack, _ = self.dev_post(secret, "ROVER-01", "/api/fleet/commands/ack", {"id": cmds[0]["id"], "status": "executed"})
        self.assertEqual(ack.status_code, 200)
        self.assertEqual(self.hb(secret, "ROVER-01")[0].get_json()["commands"], [])

    def test_command_rejections_are_409_with_reasons(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01", obstacle={"front": {"cm": 15, "valid": True}})
        r = self.command("ROVER-01", "FORWARD")
        self.assertEqual(r.status_code, 409)
        self.assertTrue(any("obstacle" in x for x in r.get_json()["reasons"]))

    def test_command_requires_login_and_valid_device(self):
        self.assertEqual(self.command("ROVER-01", "STOP", client=self.anon).status_code, 401)
        self.assertEqual(self.command("bad id", "STOP").status_code, 400)
        self.assertEqual(self.command("NOPE-01", "STOP").status_code, 409)

    def test_phone_cannot_be_commanded_and_cannot_command(self):
        s_phone = self.register("PHONE-01", "phone")
        self.assertEqual(self.command("PHONE-01", "FORWARD").status_code, 409)
        # a device-signed request to the operator command endpoint is not accepted
        r, _ = self.dev_post(s_phone, "PHONE-01", "/api/fleet/command", {"device_id": "ROVER-01", "command": "STOP"})
        self.assertEqual(r.status_code, 401)

    def test_device_cannot_ack_commands_of_other_device(self):
        s_rover, s_phone = self.register("ROVER-01", "rover"), self.register("PHONE-01", "phone")
        self.hb(s_rover, "ROVER-01")
        cid = self.command("ROVER-01", "STOP").get_json()["command"]["id"]
        r, _ = self.dev_post(s_phone, "PHONE-01", "/api/fleet/commands/ack", {"id": cid, "status": "executed"})
        self.assertEqual(r.status_code, 404)

    def test_base_save_and_return_to_base_flow(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01")
        self.assertEqual(self.command("ROVER-01", "RETURN_TO_BASE").status_code, 409)       # no base yet
        self.assertEqual(self.admin.post("/api/fleet/base", json={"lat": 95, "lon": 0}).status_code, 400)
        self.assertEqual(self.admin.post("/api/fleet/base", json={"lat": 12.97, "lon": 77.59}).status_code, 200)
        self.assertEqual(self.command("ROVER-01", "RETURN_TO_BASE").status_code, 200)
        hb, _ = self.hb(secret, "ROVER-01")
        j = hb.get_json()
        self.assertEqual(j["commands"][0]["base"], {"lat": 12.97, "lon": 77.59})
        self.assertEqual(j["base"]["lat"], 12.97)

    def test_events_upload_dedupe_and_listing(self):
        secret = self.register("ROVER-01", "rover")
        evs = {"events": [{"id": f"boot1-{i:04d}", "type": "obstacle_stop", "t": time.time() - 30, "offline": True,
                           "message": "stop", "severity": "warn"} for i in range(3)]}
        r1, _ = self.dev_post(secret, "ROVER-01", "/api/fleet/events/upload", evs)
        r2, _ = self.dev_post(secret, "ROVER-01", "/api/fleet/events/upload", evs)
        self.assertEqual(len(r1.get_json()["accepted"]), 3)
        self.assertEqual((len(r2.get_json()["accepted"]), len(r2.get_json()["duplicates"])), (0, 3))
        listed = self.admin.get("/api/fleet/events?device=ROVER-01").get_json()["events"]
        self.assertEqual(len([e for e in listed if e["type"] == "obstacle_stop"]), 3)
        self.assertEqual(self.admin.get("/api/fleet/events?device=bad%20id").status_code, 400)

    def test_secret_rotation_over_http(self):
        old = self.register("ROVER-01", "rover")
        new = self.admin.post("/api/fleet/devices/ROVER-01/rotate").get_json()["secret"]
        self.assertNotEqual(old, new)
        self.assertEqual(self.hb(old, "ROVER-01")[0].status_code, 401)
        self.assertEqual(self.hb(new, "ROVER-01")[0].status_code, 200)

    def test_fleet_disabled_without_master_secret_fails_closed(self):
        secret = self.register("ROVER-01", "rover")
        self.service.master = ""
        try:
            self.assertEqual(self.hb(secret, "ROVER-01")[0].status_code, 503)
            self.assertEqual(self.admin.post("/api/fleet/devices", json={"id": "X-123", "role": "rover"}).status_code, 503)
            self.assertFalse(self.admin.get("/api/fleet/state").get_json()["enabled"])
        finally:
            self.service.master = MASTER

    def test_cross_origin_state_change_blocked(self):
        r = self.admin.post("/api/fleet/command", json={"device_id": "ROVER-01", "command": "STOP"},
                            headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 403)

    def test_audit_trail_recorded_for_operator_actions(self):
        secret = self.register("ROVER-01", "rover")
        self.hb(secret, "ROVER-01")
        self.command("ROVER-01", "STOP")
        actions = [a.get("action") for a in rover_app.recent_actions] if hasattr(rover_app, "recent_actions") else []
        self.assertTrue(any("FLEET" in str(a) for a in actions), actions[-5:])


if __name__ == "__main__":
    unittest.main()
