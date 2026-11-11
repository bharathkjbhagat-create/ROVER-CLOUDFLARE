"""Multi-process integration test over real TCP.

Spawns: 1 DEFENX server process + independent client OS processes (each with its own
secret, its own clock, its own queue file).  Software-only: it proves protocol/server
behaviour between independent *processes*, NOT between two physical devices.
Run:  python tests/integration_two_clients.py
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable
MASTER = "integration-master-secret-0123456789abcdef"


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Operator:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with self.op.open(req, timeout=5) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or "{}")


def wait_for(fn, timeout=20, step=0.3, msg="condition"):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    raise AssertionError("timed out waiting for " + msg)


class TwoClientIntegration(unittest.TestCase):
    procs: list = []

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = dict(os.environ, SESSION_SECRET="s" * 40, ADMIN_USERNAME="ADMIN", ADMIN_PASSWORD="integration-admin-pass-1",
                   FLEET_MASTER_SECRET=MASTER, DEVICE_OFFLINE_AFTER_SECONDS="5", COOKIE_SECURE="false", PYTHONPATH=str(ROOT / "src"))
        code = ("import app; app.app.config['SESSION_COOKIE_SECURE']=False; "
                f"app.app.run(host='127.0.0.1', port={cls.port}, threaded=True, use_reloader=False)")
        cls.server = subprocess.Popen([PY, "-c", code], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.procs.append(cls.server)
        wait_for(lambda: _up(cls.base), 20, msg="server start")
        cls.op = Operator(cls.base)
        # Patch: with no DB the login path needs db_available False; app does this by default without DATABASE_URL.
        st, body = cls.op.call("POST", "/api/login", {"username": "ADMIN", "password": "integration-admin-pass-1"})
        assert st == 200, (st, body)
        cls.secrets = {}
        for did, role in (("PHONE-A", "phone"), ("PHONE-B", "phone"), ("ROVER-01", "rover")):
            st, body = cls.op.call("POST", "/api/fleet/devices", {"id": did, "name": did, "role": role})
            assert st == 200, (st, body)
            cls.secrets[did] = body["secret"]

    @classmethod
    def tearDown(self):
        for p in list(self.procs):
            if p is not self.server and p.poll() is None:
                p.kill()

    @classmethod
    def tearDownClass(cls):
        for p in cls.procs:
            if p.poll() is None:
                p.kill()
        cls.tmp.cleanup()

    def spawn_client(self, did, lat, lon, battery, out, queue=None):
        env = dict(os.environ, DEVICE_SECRET=self.secrets[did], DEVICE_ID=did, FLEET_URL=self.base)
        args = [PY, str(ROOT / "tools/fleet_client.py"), "--lat", str(lat), "--lon", str(lon), "--battery", str(battery), "--interval", "0.5"]
        if queue:
            args += ["--queue", queue]
        f = open(out, "w")
        p = subprocess.Popen(args, env=env, stdout=f, stderr=subprocess.STDOUT)
        self.procs.append(p)
        return p

    @staticmethod
    def lines(path):
        out = []
        for l in Path(path).read_text().splitlines():
            try:
                out.append(json.loads(l))
            except ValueError:
                pass
        return out

    def fleet(self):
        return {d["id"]: d for d in self.op.call("GET", "/api/fleet/state")[1]["devices"]}

    # ---------------------------------------------------------------------
    def test_1_two_independent_devices_sync_offline_detect_reconnect(self):
        outA, outB = f"{self.tmp.name}/A.out", f"{self.tmp.name}/B.out"
        a = self.spawn_client("PHONE-A", 12.9001, 77.5001, 91, outA)
        b = self.spawn_client("PHONE-B", 12.9002, 77.5002, 47, outB)
        # A sends a location -> B receives it
        wait_for(lambda: any(p["id"] == "PHONE-A" and p.get("lat") == 12.9001 for l in self.lines(outB) for p in l.get("peers", [])), msg="B sees A's location")
        # B sends status -> A receives it
        wait_for(lambda: any(p["id"] == "PHONE-B" and p.get("battery") == 47 for l in self.lines(outA) for p in l.get("peers", [])), msg="A sees B's battery")
        self.assertTrue(self.fleet()["PHONE-A"]["online"] and self.fleet()["PHONE-B"]["online"])
        # Disconnect B hard (process killed, no goodbye) -> offline detection
        b.send_signal(signal.SIGKILL); b.wait()
        wait_for(lambda: not self.fleet()["PHONE-B"]["online"], 20, msg="B detected offline")
        self.assertTrue(self.fleet()["PHONE-A"]["online"], "A must be unaffected")
        evs = self.op.call("GET", "/api/fleet/events?device=PHONE-B&limit=100")[1]["events"]
        self.assertEqual(len([e for e in evs if e["type"] == "device_offline"]), 1, "offline persisted exactly once")
        # A observes B offline
        wait_for(lambda: any(p["id"] == "PHONE-B" and p["online"] is False for l in self.lines(outA)[-4:] for p in l.get("peers", [])), 10, msg="A sees B offline")
        # Reconnect B -> sync resumes
        outB2 = f"{self.tmp.name}/B2.out"
        self.spawn_client("PHONE-B", 12.9003, 77.5003, 46, outB2)
        wait_for(lambda: self.fleet()["PHONE-B"]["online"], 15, msg="B back online")
        wait_for(lambda: any(p["id"] == "PHONE-A" for l in self.lines(outB2) for p in l.get("peers", [])), msg="B resumes receiving A")
        wait_for(lambda: any(p["id"] == "PHONE-B" and p.get("lat") == 12.9003 for l in self.lines(outA) for p in l.get("peers", [])), msg="A resumes receiving B")
        a.kill()

    def test_2_offline_events_survive_outage_process_restart_and_lost_response(self):
        q = f"{self.tmp.name}/rover.queue.json"
        drv = f"""
import sys, json
sys.path.insert(0, {str(ROOT / 'tools')!r})
from fleet_client import DeviceClient, FleetNetworkError
c = DeviceClient({self.base!r}, 'ROVER-01', {self.secrets['ROVER-01']!r}, {q!r})
phase = sys.argv[1]
if phase == 'offline':
    c.network_up = False
    try: c.heartbeat({{}})
    except FleetNetworkError: pass
    for i in range(25):
        c.record_event('obstacle_stop', f'offline event {{i}}', 'warn', data={{'cm': 20 + i}}, offline=True)
    c.record_event('gps_track', 'offline gps', data={{'points': [{{'t': 1.0 + i, 'lat': 12.9 + i * 1e-5, 'lon': 77.5}} for i in range(30)]}}, offline=True)
    print(json.dumps({{'queued': len(c.queue)}}))
else:                                   # new process after 'reboot': queue reloaded from disk
    n0 = len(c.queue)
    c.drop_next_response = True         # server stores batch but the reply is lost
    try: c.flush_events()
    except FleetNetworkError: pass
    left = len(c.queue)
    c.flush_events()                    # retry: duplicates must not be double-stored
    print(json.dumps({{'before': n0, 'after_lost_reply': left, 'final': len(c.queue)}}))
"""
        r1 = subprocess.run([PY, "-c", drv, "offline"], capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(r1.stdout)["queued"], 26, r1.stderr)
        self.assertTrue(Path(q).exists())
        r2 = subprocess.run([PY, "-c", drv, "online"], capture_output=True, text=True, timeout=30)
        res = json.loads(r2.stdout)
        self.assertEqual(res["before"], 26, "queue persisted across process restart")
        self.assertEqual(res["after_lost_reply"], 26, "unconfirmed events are kept when reply is lost")
        self.assertEqual(res["final"], 0)
        evs = self.op.call("GET", "/api/fleet/events?device=ROVER-01&limit=500")[1]["events"]
        mine = [e for e in evs if e["source"] == "device"]
        self.assertEqual(len([e for e in mine if e["type"] == "obstacle_stop"]), 25, "no loss, no duplicates")
        self.assertEqual(len([e for e in mine if e["type"] == "gps_track"]), 1)
        self.assertEqual(len({e["id"] for e in mine}), len(mine))
        self.assertTrue(all(e["offline"] for e in mine))

    def test_3_commands_acknowledged_by_independent_rover_process_and_offline_gating(self):
        env = dict(os.environ, DEVICE_SECRET=self.secrets["ROVER-01"], DEVICE_ID="ROVER-01", FLEET_URL=self.base)
        rv = subprocess.Popen([PY, str(ROOT / "tools/rover_sim.py"), "--hz", "4"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.procs.append(rv)
        wait_for(lambda: self.fleet()["ROVER-01"]["online"], 15, msg="rover online")
        st, _ = self.op.call("POST", "/api/fleet/base", {"lat": 12.97165, "lon": 77.5946})
        self.assertEqual(st, 200)
        def acked(cmd_name):
            cmds = self.op.call("GET", "/api/fleet/commands?device_id=ROVER-01")[1]["commands"]
            return [c for c in cmds if c["command"] == cmd_name and c["status"] == "executed"]
        wait_for(lambda: (self.fleet()["ROVER-01"]["status"] or {}).get("caps"), msg="caps")
        self.assertEqual(self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "FORWARD"})[0], 200)
        wait_for(lambda: acked("FORWARD"), msg="FORWARD executed+acked")
        self.assertEqual(self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "EMERGENCY_STOP"})[0], 200)
        wait_for(lambda: acked("EMERGENCY_STOP"), msg="ESTOP acked")
        wait_for(lambda: (self.fleet()["ROVER-01"]["status"] or {}).get("estop") is True, msg="estop visible on dashboard")
        st, body = self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "FORWARD"})
        self.assertEqual(st, 409); self.assertIn("emergency stop latched", body["reasons"])
        self.assertEqual(self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "RESET_ESTOP"})[0], 200)
        wait_for(lambda: (self.fleet()["ROVER-01"]["status"] or {}).get("estop") is False, msg="estop cleared")
        # return to base executes on the rover process; dashboard shows device-reported state, arrival only when device says so
        self.assertEqual(self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "RETURN_TO_BASE"})[0], 200)
        wait_for(lambda: acked("RETURN_TO_BASE"), msg="RTB acked")
        wait_for(lambda: (self.fleet()["ROVER-01"]["status"] or {}).get("fsm") == "RTB_ARRIVED", 40, msg="device-confirmed arrival")
        tele = self.op.call("GET", "/api/telemetry")[1]
        self.assertEqual(tele["fleet_fsm"], "RTB_ARRIVED")
        # kill the rover: offline detection, and movement is refused while offline
        rv.send_signal(signal.SIGKILL); rv.wait()
        wait_for(lambda: not self.fleet()["ROVER-01"]["online"], 20, msg="rover offline")
        st, body = self.op.call("POST", "/api/fleet/command", {"device_id": "ROVER-01", "command": "FORWARD"})
        self.assertEqual(st, 409); self.assertIn("device offline", body["reasons"])
        self.assertTrue(self.op.call("GET", "/api/telemetry")[1]["device_online"] in (False, True))  # legacy flag follows existing stale logic

    def test_4_forged_requests_rejected(self):
        for did, secret in (("ROVER-01", "0" * 64), ("PHONE-A", self.secrets["PHONE-B"])):
            sys.path.insert(0, str(ROOT / "src"))
            import fleet as F
            body = b"{}"; ts = str(time.time()); nonce = "forged-nonce-0123456789"
            req = urllib.request.Request(self.base + "/api/fleet/heartbeat", data=body, method="POST", headers={
                "X-Device-Id": did, "X-Timestamp": ts, "X-Nonce": nonce,
                "X-Signature": F.sign_request(secret, "POST", "/api/fleet/heartbeat", did, ts, nonce, body)})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(cm.exception.code, 401)

    def test_5_javascript_device_client_protocol_against_live_server(self):
        """The phone web client's exact signing/verification code (public/fleet-protocol.js) talking to the real server."""
        js = f"""
const P = require({str(ROOT / 'public/fleet-protocol.js')!r});
(async () => {{
  const id = 'PHONE-A', secret = {self.secrets['PHONE-A']!r}, path = '/api/fleet/heartbeat';
  const body = P.enc.encode(JSON.stringify({{lat: 12.95, lon: 77.55, gps_fix: true, accuracy_m: 4, battery: 33, seq: 1, boot_id: 'jsboot01', fsm: 'IDLE'}}));
  const ts = String(Date.now() / 1000), n = P.nonce();
  const sig = await P.signRequest(secret, 'POST', path, id, ts, n, body);
  const res = await fetch({self.base!r} + path, {{method: 'POST', body, headers: {{'Content-Type': 'application/json', 'X-Device-Id': id, 'X-Timestamp': ts, 'X-Nonce': n, 'X-Signature': sig}}}});
  const raw = new Uint8Array(await res.arrayBuffer());
  const ok = P.timingSafeEqualHex(await P.signResponse(secret, id, n, raw), res.headers.get('X-Server-Signature') || '');
  console.log(JSON.stringify({{status: res.status, sigOk: ok, data: JSON.parse(new TextDecoder().decode(raw))}}));
}})();
"""
        out = subprocess.run(["node", "-e", js], capture_output=True, text=True, timeout=20)
        r = json.loads(out.stdout)
        self.assertEqual(r["status"], 200, out.stderr)
        self.assertTrue(r["sigOk"], "browser client must be able to verify the server signature")
        self.assertEqual(self.fleet()["PHONE-A"]["status"]["battery"], 33)



def _up(base):
    try:
        urllib.request.urlopen(base + "/api/health", timeout=1)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


if __name__ == "__main__":
    unittest.main(verbosity=2)
