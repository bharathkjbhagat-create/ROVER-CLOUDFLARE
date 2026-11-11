"""Unit tests for src/fleet.py and src/fleet_do.py (no network, no Flask)."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import fleet as F  # noqa: E402
from fleet_do import FleetDOLogic  # noqa: E402

MASTER = "unit-test-master-secret-0123456789abcdef"


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


def good_status(**over):
    s = {"lat": 12.9716, "lon": 77.5946, "gps_fix": True, "accuracy_m": 3.0, "gps_sats": 9, "gps_age_ms": 200,
         "battery": 80, "signal": 70, "camera": True, "fsm": "IDLE", "boot_id": "boot1", "seq": 1,
         "obstacle": {"front": {"cm": 150, "valid": True}, "left": {"cm": 90, "valid": True},
                      "right": {"cm": 90, "valid": True}},
         "caps": {"autonomous_navigation": True, "obstacle_avoidance": True, "obstacle_sensor_healthy": True,
                  "safety_controller_healthy": True}}
    s.update(over)
    return s


def make(store_factory=F.MemoryFleetStore, clock=None):
    clock = clock or Clock()
    store = store_factory(clock=clock) if store_factory is F.MemoryFleetStore else store_factory()
    svc = F.FleetService(store, MASTER, clock=clock)
    return svc, clock


def signed_headers(secret, device, method, path, body, clock, nonce="n" * 20, ts=None):
    ts = str(clock() if ts is None else ts)
    return {"X-Device-Id": device, "X-Timestamp": ts, "X-Nonce": nonce,
            "X-Signature": F.sign_request(secret, method, path, device, ts, nonce, body)}


class CryptoTests(unittest.TestCase):
    def test_secret_derivation_is_per_device_and_versioned(self):
        a = F.derive_device_secret(MASTER, "ROVER-01", 1)
        self.assertEqual(a, F.derive_device_secret(MASTER, "ROVER-01", 1))
        self.assertNotEqual(a, F.derive_device_secret(MASTER, "ROVER-02", 1))
        self.assertNotEqual(a, F.derive_device_secret(MASTER, "ROVER-01", 2))
        self.assertNotEqual(a, F.derive_device_secret(MASTER + "x", "ROVER-01", 1))

    def test_short_master_rejected(self):
        self.assertFalse(F.master_ok("short"))
        svc = F.FleetService(F.MemoryFleetStore(), "short")
        with self.assertRaises(F.FleetError) as cm:
            svc.register_device("ROVER-01", "r", "rover", "admin")
        self.assertEqual(cm.exception.status, 503)

    def test_signature_binds_every_field(self):
        base = ("s", "POST", "/api/fleet/heartbeat", "DEV-1", "100", "n" * 20, b"{}")
        sig = F.sign_request(*base)
        for i, alt in enumerate(["x", "GET", "/other", "DEV-2", "101", "m" * 20, b"{ }"]):
            mutated = list(base)
            mutated[i] = alt
            self.assertNotEqual(sig, F.sign_request(*mutated), f"field {i} not bound")


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.svc, self.clock = make()
        self.rec, self.secret = self.svc.register_device("ROVER-01", "Rover", "rover", "admin")
        self.body = b'{"a":1}'
        self.path = "/api/fleet/heartbeat"

    def auth(self, **kw):
        h = signed_headers(self.secret, "ROVER-01", "POST", self.path, kw.pop("body", self.body), self.clock, **kw)
        return self.svc.authenticate("POST", self.path, h, kw.get("body", self.body))

    def test_valid_request(self):
        rec, secret, nonce = self.auth()
        self.assertEqual(rec["id"], "ROVER-01")
        self.assertEqual(secret, self.secret)

    def test_replay_rejected(self):
        self.auth(nonce="a" * 20)
        with self.assertRaises(F.FleetError) as cm:
            self.auth(nonce="a" * 20)
        self.assertEqual(cm.exception.status, 409)

    def test_stale_and_future_timestamps_rejected(self):
        for delta in (-61, 61):
            with self.assertRaises(F.FleetError) as cm:
                self.auth(nonce=f"t{delta}".ljust(20, "x"), ts=self.clock() + delta)
            self.assertEqual(cm.exception.status, 401)

    def test_tampered_body_rejected(self):
        h = signed_headers(self.secret, "ROVER-01", "POST", self.path, self.body, self.clock)
        with self.assertRaises(F.FleetError) as cm:
            self.svc.authenticate("POST", self.path, h, b'{"a":2}')
        self.assertEqual(cm.exception.status, 401)

    def test_wrong_secret_unknown_and_revoked_device(self):
        h = signed_headers("0" * 64, "ROVER-01", "POST", self.path, self.body, self.clock)
        with self.assertRaises(F.FleetError):
            self.svc.authenticate("POST", self.path, h, self.body)
        h = signed_headers(self.secret, "ROVER-99", "POST", self.path, self.body, self.clock, nonce="u" * 20)
        with self.assertRaises(F.FleetError):
            self.svc.authenticate("POST", self.path, h, self.body)
        self.svc.revoke_device("ROVER-01", "admin")
        with self.assertRaises(F.FleetError):
            self.auth(nonce="r" * 20)

    def test_failed_auth_does_not_consume_nonce(self):
        bad = signed_headers("1" * 64, "ROVER-01", "POST", self.path, self.body, self.clock, nonce="z" * 20)
        with self.assertRaises(F.FleetError):
            self.svc.authenticate("POST", self.path, bad, self.body)
        self.auth(nonce="z" * 20)  # legitimate use of same nonce still works

    def test_rotation_invalidates_old_secret(self):
        _, new_secret = self.svc.rotate_device("ROVER-01", "admin")
        self.assertNotEqual(new_secret, self.secret)
        with self.assertRaises(F.FleetError):
            self.auth(nonce="o" * 20)

    def test_device_cannot_sign_for_another_device(self):
        _, secret2 = self.svc.register_device("PHONE-01", "Phone", "phone", "admin")
        h = signed_headers(secret2, "ROVER-01", "POST", self.path, self.body, self.clock, nonce="x" * 20)
        with self.assertRaises(F.FleetError):
            self.svc.authenticate("POST", self.path, h, self.body)

    def test_oversize_body_rejected(self):
        with self.assertRaises(F.FleetError) as cm:
            self.svc.authenticate("POST", self.path, {}, b"x" * (F.MAX_BODY_BYTES + 1))
        self.assertEqual(cm.exception.status, 413)

    def test_register_validation(self):
        for bad in ("a", "has space", "x" * 40, "../etc", "<script>"):
            with self.assertRaises(F.FleetError):
                self.svc.register_device(bad, "n", "rover", "admin")
        with self.assertRaises(F.FleetError):
            self.svc.register_device("OK-1", "n", "admin", "admin")
        with self.assertRaises(F.FleetError) as cm:
            self.svc.register_device("ROVER-01", "n", "rover", "admin")
        self.assertEqual(cm.exception.status, 409)


class ValidationTests(unittest.TestCase):
    def test_rejects_non_finite_and_out_of_range(self):
        s = F.validate_status("rover", {"lat": float("nan"), "lon": 10, "gps_fix": True, "battery": 500, "signal": -5,
                                        "speed_kmh": float("inf")})
        self.assertFalse(s["gps_fix"])
        self.assertNotIn("lat", s)
        self.assertNotIn("battery", s)
        self.assertNotIn("signal", s)
        self.assertNotIn("speed_kmh", s)

    def test_null_island_and_fix_without_coordinates_are_not_a_fix(self):
        self.assertFalse(F.validate_status("rover", {"lat": 0, "lon": 0, "gps_fix": True})["gps_fix"])
        self.assertFalse(F.validate_status("rover", {"gps_fix": True})["gps_fix"])

    def test_booleans_are_not_numbers(self):
        self.assertNotIn("battery", F.validate_status("rover", {"battery": True}))

    def test_obstacle_sentinel_is_invalid(self):
        s = F.validate_status("rover", {"obstacle": {"front": {"cm": 0, "valid": True},
                                                      "left": {"cm": 9999, "valid": True},
                                                      "right": {"cm": 100, "valid": False}}})
        self.assertFalse(s["obstacle"]["front"]["valid"])
        self.assertFalse(s["obstacle"]["left"]["valid"])
        self.assertFalse(s["obstacle"]["right"]["valid"])

    def test_unknown_keys_dropped_and_strings_sanitised(self):
        s = F.validate_status("rover", {"evil": "x", "fsm": "<img src=x onerror=1>" * 5})
        self.assertNotIn("evil", s)
        self.assertNotIn("<", s["fsm"])
        self.assertLessEqual(len(s["fsm"]), 32)

    def test_event_validation(self):
        now = 1_800_000_000.0
        with self.assertRaises(F.FleetError):
            F.validate_event({"id": "x", "type": "gps"}, now)
        with self.assertRaises(F.FleetError):
            F.validate_event({"id": "valid-id-1", "type": "BAD TYPE"}, now)
        with self.assertRaises(F.FleetError):
            F.validate_event({"id": "valid-id-1", "type": "note", "data": {"x": "y" * 7000}}, now)
        ev = F.validate_event({"id": "valid-id-1", "type": "gps_track", "t": now,
                               "data": {"points": [{"t": now, "lat": 12.0, "lon": 77.0, "acc": 3},
                                                   {"t": now, "lat": 999, "lon": 77.0}]}}, now)
        self.assertEqual(len(ev["data"]["points"]), 1)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.svc, self.clock = make()
        self.rover, _ = self.svc.register_device("ROVER-01", "Rover", "rover", "admin")
        self.phone, _ = self.svc.register_device("PHONE-01", "Phone", "phone", "admin")

    def test_peer_sees_location_and_status(self):
        self.svc.ingest_heartbeat(self.phone, good_status(lat=13.0, lon=77.6, seq=1, boot_id="p1"))
        self.svc.ingest_heartbeat(self.rover, good_status(battery=55, seq=1))
        peers = {p["id"]: p for p in self.svc.peers_for("ROVER-01")}
        self.assertEqual(peers["PHONE-01"]["lat"], 13.0)
        self.assertTrue(peers["PHONE-01"]["online"])
        peers = {p["id"]: p for p in self.svc.peers_for("PHONE-01")}
        self.assertEqual(peers["ROVER-01"]["battery"], 55)
        self.assertNotIn("PHONE-01", {p["id"] for p in self.svc.peers_for("PHONE-01")})

    def test_offline_detection_and_persisted_event_then_resume(self):
        self.svc.ingest_heartbeat(self.rover, good_status(seq=1))
        self.assertTrue(self.svc.effective_status("ROVER-01")["online"])
        self.clock.t += 20
        self.assertFalse(self.svc.effective_status("ROVER-01")["online"])
        self.svc.effective_status("ROVER-01")  # repeated reads must not duplicate the event
        offs = [e for e in self.svc.list_events(50) if e["type"] == "device_offline"]
        self.assertEqual(len(offs), 1)
        self.svc.ingest_heartbeat(self.rover, good_status(seq=2))
        self.assertTrue(self.svc.effective_status("ROVER-01")["online"])
        self.assertEqual(len([e for e in self.svc.list_events(50) if e["type"] == "device_online"]), 2)

    def test_stale_out_of_order_heartbeat_rejected(self):
        self.svc.ingest_heartbeat(self.rover, good_status(seq=5, battery=70))
        with self.assertRaises(F.FleetError) as cm:
            self.svc.ingest_heartbeat(self.rover, good_status(seq=4, battery=10))
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.svc.effective_status("ROVER-01")["battery"], 70)
        self.svc.ingest_heartbeat(self.rover, good_status(seq=1, boot_id="boot2", battery=65))  # reboot is fine
        self.assertEqual(self.svc.effective_status("ROVER-01")["battery"], 65)

    def test_event_batch_idempotent_and_survives_retry(self):
        evs = [{"id": f"boot1-{i:04d}", "type": "gps_track" if i == 0 else "obstacle_stop", "t": self.clock() - 100 + i,
                "offline": True, "message": "m", "data": {"points": [{"t": self.clock(), "lat": 12.0, "lon": 77.0}]} if i == 0 else {"cm": 20}}
               for i in range(5)]
        r1 = self.svc.ingest_events(self.rover, {"events": evs})
        self.assertEqual(len(r1["accepted"]), 5)
        r2 = self.svc.ingest_events(self.rover, {"events": evs})        # response lost -> device retries
        self.assertEqual(r2["accepted"], [])
        self.assertEqual(len(r2["duplicates"]), 5)
        self.assertEqual(sorted(r2["stored_ids"]), sorted(e["id"] for e in evs))
        self.assertEqual(len([e for e in self.svc.list_events(100, "ROVER-01") if e["id"].startswith("boot1-")]), 5)

    def test_same_event_id_from_two_devices_is_not_a_collision(self):
        ev = {"id": "shared-id-001", "type": "note", "t": self.clock(), "message": "x"}
        self.assertEqual(len(self.svc.ingest_events(self.rover, {"events": [ev]})["accepted"]), 1)
        self.assertEqual(len(self.svc.ingest_events(self.phone, {"events": [ev]})["accepted"]), 1)

    def test_batch_limits(self):
        with self.assertRaises(F.FleetError):
            self.svc.ingest_events(self.rover, {"events": []})
        with self.assertRaises(F.FleetError):
            self.svc.ingest_events(self.rover, {"events": [{"id": f"id-{i:05d}", "type": "note"} for i in range(F.MAX_EVENTS_PER_BATCH + 1)]})

    def test_server_stamped_events_cannot_be_forged_by_device_source(self):
        r = self.svc.ingest_events(self.rover, {"events": [{"id": "forged-ev-1", "type": "note", "source": "server", "device_id": "PHONE-01"}]})
        ev = [e for e in self.svc.list_events(10) if e["id"] == "forged-ev-1"][0]
        self.assertEqual(ev["device_id"], "ROVER-01")
        self.assertEqual(ev["source"], "device")
        self.assertEqual(r["accepted"], ["forged-ev-1"])


class CommandGateTests(unittest.TestCase):
    def setUp(self):
        self.svc, self.clock = make()
        self.rover, _ = self.svc.register_device("ROVER-01", "Rover", "rover", "admin")
        self.phone, _ = self.svc.register_device("PHONE-01", "Phone", "phone", "admin")
        self.svc.ingest_heartbeat(self.rover, good_status())
        self.svc.save_base(12.97, 77.59, "admin")

    def issue(self, cmd, admin=True, dev="ROVER-01"):
        return self.svc.issue_command(dev, cmd, "admin", admin)

    def reasons(self, cmd, dev="ROVER-01"):
        with self.assertRaises(F.FleetError) as cm:
            self.issue(cmd, dev=dev)
        self.assertEqual(cm.exception.status, 409)
        return cm.exception.extra["reasons"]

    def hb(self, **over):
        self.clock.t += 1
        base = good_status(seq=int(self.clock.t))
        base.update(over)
        self.svc.ingest_heartbeat(self.rover, base)

    def test_movement_allowed_when_healthy(self):
        self.assertEqual(self.issue("FORWARD")["status"], "pending")

    def test_commands_cannot_target_non_rover_device(self):
        self.assertIn("target device is not a rover", self.reasons("FORWARD", "PHONE-01"))
        self.assertIn("target device is not a rover", self.reasons("STOP", "PHONE-01"))

    def test_unknown_device_and_invalid_command(self):
        self.assertIn("unknown device", self.reasons("STOP", "NOPE-1"))
        with self.assertRaises(F.FleetError) as cm:
            self.issue("SELF_DESTRUCT")
        self.assertEqual(cm.exception.status, 400)

    def test_forward_blocked_by_obstacle_invalid_sensor_battery_estop_stale(self):
        self.hb(obstacle={"front": {"cm": 20, "valid": True}})
        self.assertTrue(any("obstacle" in r for r in self.reasons("FORWARD")))
        self.issue("LEFT")                                      # turning in place is not blocked by an obstacle ahead
        self.hb(obstacle={"front": {"cm": 0, "valid": False}})
        self.assertIn("obstacle data invalid", self.reasons("FORWARD"))
        self.hb(battery=10)
        self.assertIn("battery low or unknown", self.reasons("FORWARD"))
        self.hb(estop=True)
        self.assertIn("emergency stop latched", self.reasons("FORWARD"))
        self.hb()
        self.clock.t += 5
        self.assertIn("telemetry stale", self.reasons("FORWARD"))
        self.clock.t += 10
        self.assertIn("device offline", self.reasons("FORWARD"))

    def test_stop_and_estop_always_accepted_even_offline(self):
        self.clock.t += 60
        self.assertEqual(self.issue("STOP")["command"], "STOP")
        self.assertEqual(self.issue("EMERGENCY_STOP")["command"], "EMERGENCY_STOP")

    def test_unhealthy_safety_controller_blocks_motion(self):
        self.hb(caps={"obstacle_sensor_healthy": True, "safety_controller_healthy": False})
        self.assertIn("safety controller not confirmed healthy", self.reasons("FORWARD"))

    def test_return_to_base_gate(self):
        self.assertEqual(self.issue("RETURN_TO_BASE")["base"]["lat"], 12.97)
        self.svc.store.queue_cancel_pending("ROVER-01", self.clock(), "t")
        with self.assertRaises(F.FleetError) as cm:
            self.issue("RETURN_TO_BASE", admin=False)
        self.assertEqual(cm.exception.status, 403)
        self.hb(accuracy_m=40)
        self.assertIn("GPS accuracy insufficient", self.reasons("RETURN_TO_BASE"))
        self.hb(gps_fix=False)
        self.assertIn("no valid fresh GPS fix", self.reasons("RETURN_TO_BASE"))
        self.hb(gps_age_ms=9000)
        self.assertIn("no valid fresh GPS fix", self.reasons("RETURN_TO_BASE"))
        self.hb(caps={"safety_controller_healthy": True})
        r = self.reasons("RETURN_TO_BASE")
        self.assertIn("autonomous_navigation not confirmed", r)
        self.assertIn("obstacle_avoidance not confirmed", r)
        self.hb(battery=22)
        self.assertIn("battery below return-to-base reserve", self.reasons("RETURN_TO_BASE"))
        self.hb()
        self.svc.store.put("base", None)
        self.assertIn("base location not saved", self.reasons("RETURN_TO_BASE"))

    def test_rtb_blocks_manual_and_cancel_always_allowed(self):
        self.hb(fsm="RTB_NAVIGATE")
        self.assertIn("return-to-base in progress; cancel it first", self.reasons("FORWARD"))
        self.assertEqual(self.issue("CANCEL_RETURN")["command"], "CANCEL_RETURN")

    def test_arrived_is_terminal_not_in_progress(self):
        self.hb(fsm="RTB_ARRIVED")
        self.assertEqual(self.issue("FORWARD")["status"], "pending")     # regression: used to be blocked
        for active in ("RTB_PRECHECK", "RTB_NAVIGATE", "RTB_AVOID", "RTB_VERIFY_DOCK"):
            self.hb(fsm=active)
            self.assertIn("return-to-base in progress; cancel it first", self.reasons("FORWARD"))

    def test_reset_estop_admin_only_and_requires_healthy(self):
        self.hb(estop=True)
        with self.assertRaises(F.FleetError) as cm:
            self.issue("RESET_ESTOP", admin=False)
        self.assertEqual(cm.exception.status, 403)
        self.assertEqual(self.issue("RESET_ESTOP")["command"], "RESET_ESTOP")
        self.hb(estop=True, caps={"safety_controller_healthy": False})
        self.assertIn("safety controller not confirmed healthy", self.reasons("RESET_ESTOP"))

    def test_stop_supersedes_queued_movement_and_commands_expire(self):
        c = self.issue("FORWARD")
        self.issue("STOP")
        cmds = self.svc.device_commands("ROVER-01")
        self.assertEqual([x["command"] for x in cmds], ["STOP"])
        self.assertEqual([x for x in self.svc.store.queue_list("ROVER-01") if x["id"] == c["id"]][0]["status"], "superseded")
        self.clock.t += 10                         # movement TTL is 1.5 s; STOP lasts longer
        self.issue("STOP")
        self.assertTrue(all(x["command"] == "STOP" for x in self.svc.device_commands("ROVER-01")))

    def test_movement_command_expires_instead_of_executing_late(self):
        self.issue("FORWARD")
        self.clock.t += 3
        self.assertEqual(self.svc.device_commands("ROVER-01"), [])

    def test_ack_flow_and_cross_device_ack_blocked(self):
        c = self.issue("STOP")
        with self.assertRaises(F.FleetError) as cm:
            self.svc.ack_command(self.phone, {"id": c["id"], "status": "executed"})
        self.assertEqual(cm.exception.status, 404)           # phone cannot ack rover commands
        self.svc.ack_command(self.rover, {"id": c["id"], "status": "executed"})
        self.assertEqual(self.svc.device_commands("ROVER-01"), [])
        with self.assertRaises(F.FleetError):
            self.svc.ack_command(self.rover, {"id": c["id"], "status": "hacked"})

    def test_revoked_device_loses_queued_commands(self):
        self.issue("STOP")
        self.svc.revoke_device("ROVER-01", "admin")
        self.assertEqual(self.svc.device_commands("ROVER-01"), [])

    def test_save_base_validation(self):
        for lat, lon in ((91, 0), (0, 181), ("x", 1), (None, None), (float("nan"), 1)):
            with self.assertRaises(F.FleetError):
                self.svc.save_base(lat, lon, "admin")


class FakeStorage:
    def __init__(self):
        self.d = {}

    async def get(self, k):
        import copy
        return copy.deepcopy(self.d.get(k))

    async def put(self, k, v):
        import copy
        self.d[k] = copy.deepcopy(v)

    async def delete(self, k):
        self.d.pop(k, None)


class SyncStoreAdapter:
    """Presents FleetDOLogic through the synchronous FleetStore interface (as DOFleetStore does)."""

    def __init__(self, clock):
        self.logic = FleetDOLogic(FakeStorage(), clock=clock)
        self.loop = asyncio.new_event_loop()

    def _op(self, **kw):
        r = self.loop.run_until_complete(self.logic.handle(json.dumps(kw)))
        assert r.get("ok") is True, r
        return r

    def get(self, key): return self._op(op="get", key=key)["value"]
    def put(self, key, value): self._op(op="put", key=key, value=value)
    def delete(self, key): self._op(op="delete", key=key)
    def list_prefix(self, prefix, limit=200): return [tuple(x) for x in self._op(op="list", prefix=prefix, limit=limit)["items"]]
    def claim_nonce(self, key, ttl_s): return self._op(op="claim_nonce", key=key, ttl=ttl_s)["claimed"]
    def queue_push(self, d, cmd, cap=50): self._op(op="q_push", device=d, cmd=cmd, cap=cap)
    def queue_pending(self, d, now): return self._op(op="q_pending", device=d, now=now)["items"]
    def queue_cancel_pending(self, d, now, reason, keep=()): return self._op(op="q_cancel", device=d, now=now, reason=reason, keep=list(keep))["n"]
    def queue_ack(self, d, cid, status, detail, now): return self._op(op="q_ack", device=d, id=cid, status=status, detail=detail, now=now)["cmd"]
    def queue_list(self, d, limit=30): return self._op(op="q_list", device=d, limit=limit)["items"]

    def events_append(self, d, events):
        r = self._op(op="ev_append", device=d, events=events)
        return r["accepted"], r["duplicates"]

    def events_list(self, limit=100, device_id=None, since=None):
        return self._op(op="ev_list", limit=limit, device=device_id, since=since)["items"]


class DurableObjectLogicTests(unittest.TestCase):
    """Re-runs the sync + command suites on top of the Durable Object storage logic (fake storage)."""

    def test_service_end_to_end_on_do_logic(self):
        clock = Clock()
        svc = F.FleetService(SyncStoreAdapter(clock), MASTER, clock=clock)
        rover, secret = svc.register_device("ROVER-01", "Rover", "rover", "admin")
        phone, _ = svc.register_device("PHONE-01", "Phone", "phone", "admin")
        body = b"{}"
        h = signed_headers(secret, "ROVER-01", "POST", "/x", body, clock, nonce="d" * 20)
        svc.authenticate("POST", "/x", h, body)
        with self.assertRaises(F.FleetError) as cm:
            svc.authenticate("POST", "/x", h, body)       # replay through DO nonce table
        self.assertEqual(cm.exception.status, 409)
        svc.ingest_heartbeat(rover, good_status())
        svc.ingest_heartbeat(phone, good_status(lat=13.1, boot_id="p", seq=1))
        self.assertEqual({p["id"] for p in svc.peers_for("ROVER-01")}, {"PHONE-01"})
        svc.save_base(12.97, 77.59, "admin")
        svc.issue_command("ROVER-01", "RETURN_TO_BASE", "admin", True)
        self.assertEqual(svc.device_commands("ROVER-01")[0]["command"], "RETURN_TO_BASE")
        evs = [{"id": f"boot9-{i:04d}", "type": "note", "t": clock(), "message": "m", "offline": True} for i in range(10)]
        self.assertEqual(len(svc.ingest_events(rover, {"events": evs})["accepted"]), 10)
        self.assertEqual(len(svc.ingest_events(rover, {"events": evs})["duplicates"]), 10)
        clock.t += 30
        svc.fleet_snapshot()
        svc.fleet_snapshot()
        self.assertEqual(len([e for e in svc.list_events(100) if e["type"] == "device_offline"]), 2)

    def test_event_ring_wraps_without_losing_newest(self):
        clock = Clock()
        store = SyncStoreAdapter(clock)
        total = F_CHUNK = 50 * 20 + 130
        for start in range(0, total, 40):
            batch = [{"id": f"ev-{i:06d}", "type": "note", "device_id": "D-1", "received_at": clock() + i, "t": 0,
                      "message": "m", "severity": "info", "offline": False} for i in range(start, min(start + 40, total))]
            store.events_append("D-1", batch)
        newest = store.events_list(limit=500)
        self.assertEqual(newest[0]["id"], f"ev-{total - 1:06d}")
        self.assertLessEqual(len(newest), 500)
        ids = [e["id"] for e in newest]
        self.assertEqual(ids, sorted(ids, reverse=True))      # ordering preserved across wrap
        self.assertNotIn("ev-000000", ids)                    # oldest were overwritten (bounded storage)

    def test_gps_track_points_go_to_ring_not_event_list(self):
        clock = Clock()
        logic = FleetDOLogic(FakeStorage(), clock=clock)
        loop = asyncio.new_event_loop()
        ev = {"id": "gps-0001", "type": "gps_track", "device_id": "D-1", "received_at": clock(),
              "data": {"points": [{"t": 1.0, "lat": 12.0, "lon": 77.0} for _ in range(100)]}}
        r = loop.run_until_complete(logic.handle({"op": "ev_append", "device": "D-1", "events": [ev]}))
        self.assertEqual(r["accepted"], ["gps-0001"])
        listed = loop.run_until_complete(logic.handle({"op": "ev_list", "limit": 10}))["items"][0]
        self.assertEqual(listed["data"], {"points_count": 100})
        hist = loop.run_until_complete(logic.handle({"op": "gps_history", "device": "D-1"}))["items"]
        self.assertEqual(len(hist), 100)

    def test_unknown_and_private_ops_rejected(self):
        logic = FleetDOLogic(FakeStorage())
        loop = asyncio.new_event_loop()
        for bad in ({"op": "nope"}, {"op": "_index"}, {"op": ""}, "not json", [], {"op": "put"}):
            self.assertEqual(loop.run_until_complete(logic.handle(bad))["ok"], False)


if __name__ == "__main__":
    unittest.main()
