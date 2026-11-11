#!/usr/bin/env python3
"""SOFTWARE rover simulator speaking the real DEFENX device protocol.

It reports ``sim: true`` and stands in for the ESP32 so the dashboard, command
gate, offline sync and watchdog behaviour can be exercised without hardware.
It is NOT evidence that physical hardware works.  The authoritative navigation
logic is firmware/rover_core/nav_core.h (tested in firmware/test/sim_test.cpp).

Behaviours mirrored from the firmware contract:
  * movement commands carry a TTL and stop when it expires
  * comms-loss watchdog: motors stop if no authenticated server reply for WATCHDOG_S
  * STOP/EMERGENCY_STOP latch/clear semantics, e-stop reset only by RESET_ESTOP
  * while the server is unreachable, events are queued (disk) and uploaded on reconnect
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from fleet_client import DeviceClient, FleetAuthError, FleetNetworkError  # noqa: E402

WATCHDOG_S = 2.0


class SimRover:
    def __init__(self, client: DeviceClient, lat, lon, obstacle_cm=200.0):
        self.c, self.lat, self.lon = client, lat, lon
        self.heading, self.speed, self.battery = 90.0, 0.0, 85.0
        self.estop, self.obstacle_cm = False, obstacle_cm
        self.move_until, self.move_cmd = 0.0, None
        self.rtb = None                       # dict(base=(lat,lon), request_id=..)
        self.fsm, self.offline_since = "IDLE", None
        self.seen_cmds: set[str] = set()
        self.last_server_ok = time.time()
        self.moved_while_unsafe = 0

    def status(self):
        return {"lat": self.lat, "lon": self.lon, "gps_fix": True, "accuracy_m": 2.5, "gps_sats": 9, "gps_age_ms": 100,
                "speed_kmh": self.speed * 3.6, "heading": self.heading, "battery": round(self.battery, 1), "signal": 75,
                "camera": True, "fsm": self.fsm, "estop": self.estop, "offline_autonomy": self.offline_since is not None,
                "motors_enabled": not self.estop, "sim": True, "fw": "rover-sim-1", "network": "sim",
                "obstacle": {"front": {"cm": self.obstacle_cm, "valid": True}, "left": {"cm": 120, "valid": True},
                             "right": {"cm": 120, "valid": True}},
                "caps": {"autonomous_navigation": True, "obstacle_avoidance": True, "obstacle_sensor_healthy": True,
                         "safety_controller_healthy": True, "camera_healthy": True, "gps_module": True, "motors": True},
                "rtb": ({"state": self.fsm, "request_id": self.rtb["request_id"], "reason": "", "arrived": False}
                        if self.rtb else None), "link": "ONLINE" if self.offline_since is None else "SERVER_DOWN"}

    def apply(self, cmd):
        cid, name = cmd["id"], cmd["command"]
        if cid in self.seen_cmds:           # duplicate delivery (response lost) must not re-execute
            return "ignored", "duplicate"
        self.seen_cmds.add(cid)
        if name == "EMERGENCY_STOP":
            self.estop, self.speed, self.move_cmd, self.fsm, self.rtb = True, 0.0, None, "ESTOP", None
            return "executed", ""
        if name == "RESET_ESTOP":
            self.estop, self.fsm = False, "IDLE"
            return "executed", ""
        if name == "STOP":
            self.speed, self.move_cmd, self.fsm, self.rtb = 0.0, None, "IDLE", None
            return "executed", ""
        if self.estop:
            return "rejected", "estop latched"
        if name in ("FORWARD", "REVERSE", "LEFT", "RIGHT"):
            if name == "FORWARD" and self.obstacle_cm <= 30:
                return "rejected", "obstacle"
            self.move_cmd, self.move_until, self.fsm = name, time.time() + cmd["ttl_ms"] / 1000.0, "MANUAL"
            return "executed", ""
        if name == "RETURN_TO_BASE":
            self.rtb = {"base": (cmd["base"]["lat"], cmd["base"]["lon"]), "request_id": cmd["request_id"]}
            self.fsm = "RTB_NAVIGATE"
            return "executed", ""
        if name == "CANCEL_RETURN":
            self.rtb, self.fsm, self.speed = None, "IDLE", 0.0
            return "executed", ""
        return "rejected", "unknown"

    def step(self, dt):
        now = time.time()
        # comms watchdog: stop moving when the server has not answered recently (manual driving needs a link)
        if self.move_cmd and now - self.last_server_ok > WATCHDOG_S:
            self.move_cmd, self.speed, self.fsm = None, 0.0, "IDLE"
            self.c.record_event("watchdog_stop", "Comms watchdog stopped motors", "warn", offline=True)
        if self.move_cmd and now > self.move_until:
            self.move_cmd, self.speed, self.fsm = None, 0.0, "IDLE"
        if self.move_cmd in ("FORWARD", "REVERSE") and not self.estop:
            self.speed = 0.5 if self.move_cmd == "FORWARD" else -0.3
            d = self.speed * dt / 111320.0
            self.lat += d * math.cos(math.radians(self.heading)); self.lon += d * math.sin(math.radians(self.heading))
        elif self.move_cmd == "LEFT":
            self.heading = (self.heading - 45 * dt) % 360
        elif self.move_cmd == "RIGHT":
            self.heading = (self.heading + 45 * dt) % 360
        if self.rtb and not self.estop:
            blat, blon = self.rtb["base"]
            dy, dx = (blat - self.lat) * 111320.0, (blon - self.lon) * 111320.0 * math.cos(math.radians(self.lat))
            dist = math.hypot(dx, dy)
            if dist < 2.5:
                self.c.record_event("rtb_arrived", f"Arrived within {dist:.1f} m (simulated)", offline=self.offline_since is not None)
                self.rtb, self.fsm, self.speed = None, "RTB_ARRIVED", 0.0
            else:
                step = min(dist, 1.5 * dt)
                self.lat += dy / dist * step / 111320.0; self.lon += dx / dist * step / (111320.0 * math.cos(math.radians(self.lat)))
                self.speed = 1.5
        self.battery = max(0.0, self.battery - 0.002 * dt)

    def cycle(self):
        try:
            resp = self.c.heartbeat(self.status())
            self.last_server_ok = time.time()
            if self.offline_since is not None:
                self.c.record_event("link_restored", f"Reconnected after {time.time() - self.offline_since:.0f}s", offline=True)
                self.offline_since = None
            for cmd in resp["commands"]:
                st, detail = self.apply(cmd)
                self.c.ack(cmd["id"], st, detail)
            self.c.flush_events()
        except FleetNetworkError:
            if self.offline_since is None and time.time() - self.last_server_ok > 3.0:
                self.offline_since = time.time()
                self.c.record_event("link_lost", "Server unreachable; operating locally", "warn", offline=True)
        except FleetAuthError as e:
            print("AUTH ERROR:", e, file=sys.stderr, flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.environ.get("FLEET_URL", "http://127.0.0.1:5000"))
    p.add_argument("--id", default=os.environ.get("DEVICE_ID", "ROVER-01"))
    p.add_argument("--lat", type=float, default=12.9716)
    p.add_argument("--lon", type=float, default=77.5946)
    p.add_argument("--queue", default=None)
    p.add_argument("--hz", type=float, default=2.0)
    a = p.parse_args()
    secret = os.environ.get("DEVICE_SECRET") or sys.exit("DEVICE_SECRET is required")
    sim = SimRover(DeviceClient(a.url, a.id, secret, a.queue), a.lat, a.lon)
    last = time.time()
    while True:
        now = time.time()
        sim.step(now - last); last = now
        sim.cycle()
        time.sleep(1.0 / a.hz)


if __name__ == "__main__":
    main()
