"""Replays the simulated rover's OFFLINE event journal through the REAL signed fleet API (Flask test client).

Proves the simulation's events are accepted by the production schema and that re-sending the same journal
(what happens after a lost acknowledgement) can neither duplicate nor lose events on the server.
Software simulation only - the rover is the sim-core.js simulator, not hardware."""
import json
import os
import shutil
import subprocess
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
UPLOAD = "/api/fleet/events/upload"
NODE = shutil.which("node")
JS = r"""
const S = require(process.argv[1] + "/public/sim-core.js");
const r = new S.RoverSim({ scenario: "open_field", seed: 3, epoch: Number(process.argv[2]) });
r.startExploration(); r.setLink(false); r.run(420); r.stop(); r.run(1);
r.setBase(r.start.x, r.start.y, 3); r.requestRTB({ via: "local" });
r.runUntil(x => x.arrived || x.state === "SAFE_STOP", 900);
const out = r.events.map(e => { const c = Object.assign({}, e); delete c.acked; return c; });
console.log(JSON.stringify({ events: out, arrived: r.arrived, collisions: r.stats.collisions }));
"""


@unittest.skipUnless(NODE, "node is required to generate the simulated journal")
class SimJournalThroughRealServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = rover_app.app.extensions["fleet_service"]
        cls.service.master = MASTER
        out = subprocess.run([NODE, "-e", JS, str(ROOT), str(time.time() - 3000)], capture_output=True, text=True, timeout=120, check=True).stdout
        cls.sim = json.loads(out)

    def setUp(self):
        self.service.store = F.MemoryFleetStore()
        for lim in rover_app.app.extensions["fleet_limiters"]:
            lim.reset()
        self.admin = rover_app.app.test_client()
        rover_app.clear_login_failures("127.0.0.1")
        with patch.object(rover_app, "DATABASE_URL", None), patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
                patch.object(rover_app, "db_available", return_value=False), patch.object(rover_app, "ensure_db", return_value=None):
            r = self.admin.post("/api/login", json={"username": rover_app.ADMIN_USERNAME, "password": rover_app.ADMIN_PASSWORD})
        self.assertEqual(r.status_code, 200)
        self.secret = self.admin.post("/api/fleet/devices", json={"id": "ROVER-01", "name": "ROVER-01", "role": "rover"}).get_json()["secret"]
        self.device = rover_app.app.test_client()

    def post(self, events):
        body = json.dumps({"events": events}, separators=(",", ":")).encode()
        ts, nonce = str(time.time()), os.urandom(12).hex()
        hdr = {"Content-Type": "application/json", "X-Device-Id": "ROVER-01", "X-Timestamp": ts, "X-Nonce": nonce,
               "X-Signature": F.sign_request(self.secret, "POST", UPLOAD, "ROVER-01", ts, nonce, body)}
        return self.device.post(UPLOAD, data=body, headers=hdr)

    def upload_all(self, events, size=50):
        acc, dup = [], []
        for i in range(0, len(events), size):
            r = self.post(events[i:i + size])
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            j = r.get_json(); acc += j["accepted"]; dup += j["duplicates"]
        return acc, dup

    def test_journal_is_valid_offline_and_complete(self):
        ev = self.sim["events"]
        self.assertTrue(self.sim["arrived"], "the simulated rover should have returned to base offline")
        self.assertEqual(self.sim["collisions"], 0)
        self.assertGreater(len(ev), 8)
        types = {e["type"] for e in ev}
        self.assertTrue({"explore_started", "link_lost", "rtb_started", "rtb_arrived"} <= types, types)
        self.assertEqual(len({e["id"] for e in ev}), len(ev))

    def test_real_server_accepts_every_simulated_event_exactly_once(self):
        ev = self.sim["events"]
        acc, dup = self.upload_all(ev)
        self.assertEqual(sorted(acc), sorted(e["id"] for e in ev))
        self.assertEqual(dup, [])
        listed = self.admin.get("/api/fleet/events?device=ROVER-01&limit=500").get_json()["events"]
        self.assertEqual({e["id"] for e in listed if e["id"] in {x["id"] for x in ev}}, {e["id"] for e in ev})
        offline = [e for e in listed if e["type"] == "rtb_arrived"]
        self.assertTrue(offline and offline[0]["offline"] is True, "arrival reported while offline keeps its offline flag")

    def test_resending_the_whole_journal_creates_no_duplicates_and_loses_nothing(self):
        ev = self.sim["events"]
        self.upload_all(ev)
        acc2, dup2 = self.upload_all(ev)           # the rover never saw the acks and sends everything again
        self.assertEqual(acc2, [])
        self.assertEqual(sorted(dup2), sorted(e["id"] for e in ev))
        half = ev[: len(ev) // 2]
        self.service.store = F.MemoryFleetStore()   # fresh server; partial upload, then retry of the full journal
        self.secret = self.admin.post("/api/fleet/devices", json={"id": "ROVER-01", "name": "ROVER-01", "role": "rover"}).get_json()["secret"]
        acc3, _ = self.upload_all(half)
        acc4, dup4 = self.upload_all(ev)
        self.assertEqual(sorted(acc3 + acc4), sorted(e["id"] for e in ev))
        self.assertEqual(sorted(dup4), sorted(e["id"] for e in half))


if __name__ == "__main__":
    unittest.main()
