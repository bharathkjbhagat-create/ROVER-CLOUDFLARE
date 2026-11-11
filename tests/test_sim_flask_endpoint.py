"""POST /api/fleet/sim/events - the Flask endpoint that stores Simulation Lab events (administrator only).

Simulated events are idempotent, tagged as simulation, kept under the reserved SIM-ROVER id and hidden from the
normal rover event feed, so they can never be mistaken for real rover events."""
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

URL = "/api/fleet/sim/events"


def ev(i, t=None, **o):
    e = {"id": f"ROVER-SIM-abc12-{i:06d}", "type": "obstacle_detected", "severity": "warn", "t": t or time.time(), "message": "sim obstacle", "offline": True, "data": {"x": 1.5}}
    e.update(o)
    return e


class SimEventsEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = rover_app.app.extensions["fleet_service"]

    def setUp(self):
        self.service.store = F.MemoryFleetStore()
        for lim in rover_app.app.extensions["fleet_limiters"]:
            lim.reset()
        rover_app.clear_login_failures("127.0.0.1")
        self.admin = rover_app.app.test_client()
        with patch.object(rover_app, "DATABASE_URL", None), patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
                patch.object(rover_app, "db_available", return_value=False), patch.object(rover_app, "ensure_db", return_value=None):
            r = self.admin.post("/api/login", json={"username": rover_app.ADMIN_USERNAME, "password": rover_app.ADMIN_PASSWORD})
        self.assertEqual(r.status_code, 200)

    def test_requires_login(self):
        self.assertEqual(rover_app.app.test_client().post(URL, json={"events": [ev(1)]}).status_code, 401)

    def test_accepts_once_and_dedupes_resends(self):
        evs = [ev(i) for i in range(5)]
        a = self.admin.post(URL, json={"events": evs}).get_json()
        b = self.admin.post(URL, json={"events": evs}).get_json()
        self.assertTrue(a["ok"] and a["simulated"])
        self.assertEqual((len(a["accepted"]), len(a["duplicates"])), (5, 0))
        self.assertEqual((len(b["accepted"]), len(b["duplicates"])), (0, 5))
        self.assertEqual(sorted(b["stored_ids"]), sorted(e["id"] for e in evs))

    def test_events_are_tagged_simulation_and_listed_only_on_request(self):
        self.admin.post(URL, json={"events": [ev(1), ev(2)]})
        listed = self.admin.get("/api/fleet/events?device=SIM-ROVER").get_json()["events"]
        self.assertEqual(len(listed), 2)
        self.assertTrue(all(e["source"] == "simulation" and e["data"]["sim"] is True and e["device_id"] == "SIM-ROVER" for e in listed))
        everything = self.admin.get("/api/fleet/events").get_json()["events"]
        self.assertFalse([e for e in everything if e.get("source") == "simulation"], "sim events must not pollute the real feed")

    def test_does_not_create_a_device_or_touch_fleet_state(self):
        self.admin.post(URL, json={"events": [ev(1)]})
        st = self.admin.get("/api/fleet/state").get_json()
        self.assertNotIn("SIM-ROVER", [d.get("id") for d in st.get("devices", [])])

    def test_validation(self):
        for body in ({}, {"events": []}, {"events": "x"}, {"events": [ev(1, id="bad id!")]}, {"events": [ev(2, type="BAD TYPE")]},
                     {"events": [ev(3)] * 51}):
            with self.subTest(body=str(body)[:60]):
                self.assertEqual(self.admin.post(URL, json=body).status_code, 400)
        self.assertEqual(self.admin.post(URL, data="not json", content_type="application/json").status_code, 400)

    def test_implausible_device_timestamps_are_dropped_like_device_events(self):
        self.assertEqual(self.admin.post(URL, json={"events": [ev(9, t=time.time() + 10 * 86400)]}).status_code, 200)
        got = self.admin.get("/api/fleet/events?device=SIM-ROVER").get_json()["events"][0]
        self.assertTrue(got.get("t") is None or got["t"] <= time.time() + 86400 + 5, "implausible time must not be stored as-is")
        self.assertGreater(got["received_at"], 0)


if __name__ == "__main__":
    unittest.main()
