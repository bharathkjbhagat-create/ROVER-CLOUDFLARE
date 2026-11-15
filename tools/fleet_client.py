#!/usr/bin/env python3
"""Reference DEFENX device client (stdlib only).

Implements exactly the protocol the ESP32 firmware and the phone web client use:
signed requests, verified signed responses, per-boot sequence numbers, an
on-disk offline event queue with idempotent upload.  Used by tools/rover_sim.py,
the integration tests, and as executable documentation of the protocol.

    FLEET_URL=https://defenx.example.workers.dev DEVICE_ID=PHONE-01 DEVICE_SECRET=... \
        python tools/fleet_client.py --lat 12.97 --lon 77.59
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import fleet as F  # noqa: E402  (signing helpers shared with the server)


class FleetNetworkError(Exception):
    pass


class FleetAuthError(Exception):
    pass


class DeviceClient:
    def __init__(self, base_url, device_id, secret, queue_path=None, timeout=4.0, clock=time.time):
        self.base, self.id, self.secret, self.timeout, self.clock = base_url.rstrip("/"), device_id, secret, timeout, clock
        self.boot_id = secrets.token_hex(4)
        self.seq = 0
        self.event_counter = 0
        self.queue_path = Path(queue_path) if queue_path else None
        self.queue: list[dict] = []
        self.network_up = True            # test hook: simulate an outage without touching the OS network
        self.drop_next_response = False   # test hook: server processed request but response was lost
        self.last_ok = 0.0
        if self.queue_path and self.queue_path.exists():
            try:
                self.queue = json.loads(self.queue_path.read_text())
            except ValueError:
                self.queue = []

    # -- transport --------------------------------------------------------
    def _post(self, path, payload):
        if not self.network_up:
            raise FleetNetworkError("network down (simulated)")
        body = json.dumps(payload, separators=(",", ":")).encode()
        ts, nonce = str(self.clock()), secrets.token_urlsafe(18)
        sig = F.sign_request(self.secret, "POST", path, self.id, ts, nonce, body)
        req = urllib.request.Request(self.base + path, data=body, method="POST", headers={
            "Content-Type": "application/json", "X-Device-Id": self.id, "X-Timestamp": ts, "X-Nonce": nonce,
            "X-Signature": sig})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw, status, hdr = r.read(), r.status, r.headers
        except urllib.error.HTTPError as e:
            raw, status, hdr = e.read(), e.code, e.headers
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise FleetNetworkError(str(e)) from e
        if self.drop_next_response:
            self.drop_next_response = False
            raise FleetNetworkError("response lost (simulated)")
        if status == 401:
            raise FleetAuthError("server rejected device credentials")
        expected = F.sign_response(self.secret, self.id, nonce, raw)
        got = hdr.get("X-Server-Signature", "")
        if not hmac.compare_digest(expected, got):
            raise FleetAuthError("server response signature invalid - ignoring (possible spoof)")
        self.last_ok = time.time()
        return status, json.loads(raw.decode())

    # -- protocol -----------------------------------------------------------
    def heartbeat(self, status: dict):
        self.seq += 1
        status = dict(status, seq=self.seq, boot_id=self.boot_id, pending_events=len(self.queue))
        code, data = self._post("/api/fleet/heartbeat", status)
        if code != 200:
            raise FleetNetworkError(f"heartbeat HTTP {code}: {data.get('error')}")
        return data

    def ack(self, cmd_id, status, detail=""):
        code, data = self._post("/api/fleet/commands/ack", {"id": cmd_id, "status": status, "detail": detail})
        if code != 200:
            raise FleetNetworkError(f"ack HTTP {code}: {data.get('error')}")
        return data

    def record_event(self, etype, message="", severity="info", data=None, offline=False):
        self.event_counter += 1
        ev = {"id": f"{self.boot_id}-{self.event_counter:06d}", "type": etype, "message": message[:200],
              "severity": severity, "t": self.clock(), "offline": offline}
        if data is not None:
            ev["data"] = data
        self.queue.append(ev)
        self._persist()
        return ev

    def _persist(self):
        if self.queue_path:
            tmp = self.queue_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.queue))
            os.replace(tmp, self.queue_path)

    def flush_events(self, batch=20):
        """Upload queued events. An event leaves the queue ONLY after the server confirms storing it."""
        sent = 0
        while self.queue:
            chunk = self.queue[:batch]
            code, data = self._post("/api/fleet/events/upload", {"events": chunk})
            if code != 200:
                raise FleetNetworkError(f"event upload HTTP {code}: {data.get('error')}")
            stored = set(data.get("stored_ids", []))
            self.queue = [e for e in self.queue if e["id"] not in stored]
            self._persist()
            sent += len(stored)
            if not stored:
                break
        return sent


def main():
    p = argparse.ArgumentParser(description="DEFENX device client (phone-like: location + battery heartbeats)")
    p.add_argument("--url", default=os.environ.get("FLEET_URL", "http://127.0.0.1:5000"))
    p.add_argument("--id", default=os.environ.get("DEVICE_ID"))
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--battery", type=float, default=90)
    p.add_argument("--interval", type=float, default=1.0)
    p.add_argument("--queue", default=None)
    p.add_argument("--count", type=int, default=0, help="stop after N heartbeats (0 = run forever)")
    a = p.parse_args()
    secret = os.environ.get("DEVICE_SECRET")
    if not a.id or not secret:
        sys.exit("DEVICE_ID/--id and DEVICE_SECRET are required")
    c = DeviceClient(a.url, a.id, secret, a.queue)
    n = 0
    while True:
        try:
            r = c.heartbeat({"lat": a.lat, "lon": a.lon, "gps_fix": True, "accuracy_m": 5, "gps_age_ms": 0,
                             "battery": a.battery, "camera": False, "fsm": "IDLE", "network": "wifi"})
            print(json.dumps({"peers": r["peers"], "commands": r["commands"]}), flush=True)
            c.flush_events()
        except (FleetNetworkError, FleetAuthError) as e:
            print(json.dumps({"error": str(e)}), flush=True)
        n += 1
        if a.count and n >= a.count:
            break
        time.sleep(a.interval)


if __name__ == "__main__":
    main()

