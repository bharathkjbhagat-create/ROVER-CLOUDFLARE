"""DEFENX fleet core: authenticated devices, replay protection, validation,
command safety gating and event synchronisation.

This module is pure Python (no Flask, no Cloudflare imports) so it can be unit
tested and reused by the Flask blueprint in ``fleet_api.py``.  Persistence goes
through a small ``FleetStore`` interface with an in-memory implementation (local
runs, tests) and a Durable Object implementation (production, see
``DOFleetStore`` in ``fleet_api.py`` and ``RealtimeHub.fleet_op`` in worker.py).

Security model
--------------
* Every device has a per-device secret derived from ``FLEET_MASTER_SECRET``:
  ``HMAC-SHA256(master, "defenx-device-v<key_version>:<device_id>")``.  Nothing
  secret is stored per device, rotation = bump ``key_version``, revocation =
  ``revoked`` flag.
* Device requests are signed (HMAC-SHA256) over
  ``METHOD\\nPATH\\nDEVICE_ID\\nTIMESTAMP\\nNONCE\\nSHA256(BODY)``.  Timestamp
  skew is bounded and every nonce is accepted once (replay protection).
* Server responses are signed over the request nonce + body hash, so a device
  only obeys commands that came from the server for *that* request.
* Devices can only write their own status/events.  They have no command
  endpoint, therefore one device can never command another device.  Commands
  are only issued by authenticated operators and are gated by safety rules.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import threading
import time
import uuid

SIM_DEVICE_ID = "SIM-ROVER"  # reserved: browser Simulation Lab events, never a real device
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
ROLES = ("rover", "phone", "sensor", "camera")
MOVEMENT_COMMANDS = ("FORWARD", "REVERSE", "LEFT", "RIGHT")
COMMANDS = MOVEMENT_COMMANDS + (
    "STOP", "EMERGENCY_STOP", "RESET_ESTOP", "RETURN_TO_BASE", "CANCEL_RETURN",
)
ALWAYS_ALLOWED = ("STOP", "EMERGENCY_STOP", "CANCEL_RETURN")
ADMIN_ONLY_COMMANDS = ("RESET_ESTOP", "RETURN_TO_BASE")

MAX_SKEW_SECONDS = 60
NONCE_TTL_SECONDS = 180
OFFLINE_AFTER_SECONDS = 8          # no authenticated heartbeat -> offline
MOVE_FRESH_SECONDS = 4             # telemetry must be this fresh to move
MOVEMENT_TTL_MS = 1500             # device stops itself after this
SAFE_TTL_MS = 300_000
RTB_TTL_MS = 30_000
RTB_ACTIVE_STATES = ("RTB_PRECHECK", "RTB_NAVIGATE", "RTB_AVOID", "RTB_VERIFY_DOCK")   # RTB_ARRIVED is terminal
MIN_FORWARD_CM = 40
MIN_BATTERY_MOVE = 15
MIN_BATTERY_RTB = 25
MAX_GPS_ACCURACY_M = 15.0
MAX_GPS_AGE_MS = 3000
MAX_EVENTS_PER_BATCH = 50
MAX_BODY_BYTES = 32 * 1024


class FleetError(Exception):
    """Raised for rejected requests; carries an HTTP status and public message."""

    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


# --------------------------------------------------------------------------
# Crypto helpers
# --------------------------------------------------------------------------
def master_ok(master: str | None) -> bool:
    return bool(master) and len(str(master)) >= 32


def derive_device_secret(master: str, device_id: str, key_version: int = 1) -> str:
    msg = f"defenx-device-v{int(key_version)}:{device_id}".encode()
    return hmac.new(str(master).encode(), msg, hashlib.sha256).hexdigest()


def body_hash(body: bytes) -> str:
    return hashlib.sha256(body or b"").hexdigest()


def request_canonical(method: str, path: str, device_id: str, ts: str, nonce: str, body: bytes) -> bytes:
    return "\n".join([method.upper(), path, device_id, str(ts), nonce, body_hash(body)]).encode()


def sign_request(secret: str, method: str, path: str, device_id: str, ts: str, nonce: str, body: bytes) -> str:
    return hmac.new(secret.encode(), request_canonical(method, path, device_id, ts, nonce, body), hashlib.sha256).hexdigest()


def sign_response(secret: str, device_id: str, nonce: str, body: bytes) -> str:
    msg = "\n".join(["RESP", device_id, nonce, body_hash(body)]).encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


def _finite(value, lo=None, hi=None, default=None):
    if isinstance(value, bool):
        return default
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(n):
        return default
    if lo is not None and n < lo:
        return default
    if hi is not None and n > hi:
        return default
    return n


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


# --------------------------------------------------------------------------
# Store interface + in-memory implementation
# --------------------------------------------------------------------------
class FleetStoreError(Exception):
    pass


class MemoryFleetStore:
    """Thread-safe in-memory store.  Every method is atomic."""

    def __init__(self, clock=time.time):
        self._lock = threading.Lock()
        self._kv: dict[str, object] = {}
        self._nonces: dict[str, float] = {}
        self._queues: dict[str, list] = {}
        self._events: dict[str, dict] = {}      # key -> event
        self._event_ids: set[str] = set()
        self._clock = clock

    # key/value -------------------------------------------------------------
    def get(self, key):
        with self._lock:
            v = self._kv.get(key)
            return json.loads(json.dumps(v)) if v is not None else None

    def put(self, key, value):
        with self._lock:
            self._kv[key] = json.loads(json.dumps(value))

    def delete(self, key):
        with self._lock:
            self._kv.pop(key, None)

    def list_prefix(self, prefix, limit=200):
        with self._lock:
            keys = sorted(k for k in self._kv if k.startswith(prefix))[:limit]
            return [(k, json.loads(json.dumps(self._kv[k]))) for k in keys]

    # replay protection -------------------------------------------------------
    def claim_nonce(self, key, ttl_s) -> bool:
        now = self._clock()
        with self._lock:
            if len(self._nonces) > 4096:
                self._nonces = {k: e for k, e in self._nonces.items() if e > now}
            exp = self._nonces.get(key)
            if exp is not None and exp > now:
                return False
            self._nonces[key] = now + ttl_s
            return True

    # command queue ----------------------------------------------------------
    def queue_push(self, device_id, cmd, cap=50):
        with self._lock:
            q = self._queues.setdefault(device_id, [])
            q.append(json.loads(json.dumps(cmd)))
            if len(q) > cap:
                del q[: len(q) - cap]

    def queue_pending(self, device_id, now):
        with self._lock:
            out = []
            for c in self._queues.get(device_id, []):
                if c["status"] == "pending":
                    if c["expires_at"] <= now:
                        c["status"] = "expired"
                        continue
                    c["deliveries"] = c.get("deliveries", 0) + 1
                    out.append(json.loads(json.dumps(c)))
            return out

    def queue_cancel_pending(self, device_id, now, reason, keep=()):
        """Supersede pending commands (STOP/E-STOP overrides queued motion)."""
        with self._lock:
            n = 0
            for c in self._queues.get(device_id, []):
                if c["status"] == "pending" and c["command"] not in keep:
                    c["status"] = "superseded"
                    c["detail"] = reason
                    c["acked_at"] = now
                    n += 1
            return n

    def queue_ack(self, device_id, cmd_id, status, detail, now):
        with self._lock:
            for c in self._queues.get(device_id, []):
                if c["id"] == cmd_id:
                    if c["status"] in ("pending", "expired"):
                        c["status"] = status
                        c["detail"] = detail
                        c["acked_at"] = now
                        return json.loads(json.dumps(c))
                    return json.loads(json.dumps(c))
            return None

    def queue_list(self, device_id, limit=30):
        with self._lock:
            return json.loads(json.dumps(self._queues.get(device_id, [])[-limit:]))

    # events -------------------------------------------------------------------
    def events_append(self, device_id, events):
        """Idempotent append. Returns (accepted_ids, duplicate_ids)."""
        accepted, dup = [], []
        with self._lock:
            for ev in events:
                dedupe = f"{device_id}:{ev['id']}"
                if dedupe in self._event_ids:
                    dup.append(ev["id"])
                    continue
                self._event_ids.add(dedupe)
                key = f"{int(ev['received_at'] * 1000):015d}:{dedupe}"
                self._events[key] = json.loads(json.dumps(ev))
                accepted.append(ev["id"])
            if len(self._events) > 5000:
                for k in sorted(self._events)[:500]:
                    self._events.pop(k, None)
        return accepted, dup

    def events_list(self, limit=100, device_id=None, since=None):
        with self._lock:
            out = []
            for k in sorted(self._events, reverse=True):
                ev = self._events[k]
                if device_id and ev["device_id"] != device_id:
                    continue
                if since is not None and ev["received_at"] <= since:
                    continue
                out.append(json.loads(json.dumps(ev)))
                if len(out) >= limit:
                    break
            return out


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
def validate_device_id(device_id) -> str:
    if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
        raise FleetError(400, "Device ID must be 3-32 characters: letters, digits, '_' or '-'")
    return device_id


def clean_distance(obj):
    """Return {cm, valid} for one distance sensor; sentinel/out-of-range => invalid."""
    if not isinstance(obj, dict):
        return None
    cm = _finite(obj.get("cm"), 0, 100000)
    valid = bool(obj.get("valid")) and cm is not None and 2 <= cm <= 600
    out = {"cm": round(cm, 1) if cm is not None else None, "valid": valid}
    age = _finite(obj.get("age_ms"), 0, 3_600_000)
    if age is not None:
        out["age_ms"] = int(age)
    return out


def validate_status(role: str, data: dict) -> dict:
    """Validate/normalise a heartbeat body.  Unknown keys are dropped."""
    if not isinstance(data, dict):
        raise FleetError(400, "Status must be a JSON object")
    out: dict = {}
    lat = _finite(data.get("lat"), -90, 90)
    lon = _finite(data.get("lon"), -180, 180)
    if lat is not None and lon is not None and not (lat == 0 and lon == 0):
        out["lat"], out["lon"] = lat, lon
    fix = data.get("gps_fix")
    out["gps_fix"] = bool(fix) if isinstance(fix, bool) else False
    if "lat" not in out:
        out["gps_fix"] = False           # a fix without coordinates is not a fix
    for key, lo, hi in (("accuracy_m", 0, 10000), ("speed_kmh", 0, 500), ("heading", -720, 720),
                        ("battery", 0, 100), ("signal", 0, 100), ("gps_age_ms", 0, 86_400_000),
                        ("hdop", 0, 100), ("uptime_s", 0, 10 ** 9), ("temp_c", -60, 150)):
        v = _finite(data.get(key), lo, hi)
        if v is not None:
            out[key] = v
    sats = _finite(data.get("gps_sats"), 0, 64)
    if sats is not None:
        out["gps_sats"] = int(sats)
    for key in ("camera", "estop", "offline_autonomy", "motors_enabled", "sim"):
        if isinstance(data.get(key), bool):
            out[key] = data[key]
    for key, maxlen in (("fsm", 32), ("fsm_reason", 64), ("mode", 24), ("network", 40), ("fw", 40), ("boot_id", 32),
                        ("link", 32)):
        if isinstance(data.get(key), str):
            out[key] = re.sub(r"[^\w .:/@+-]", "", data[key])[:maxlen]
    obstacle = {}
    for name in ("front", "left", "right", "rear"):
        d = clean_distance((data.get("obstacle") or {}).get(name)) if isinstance(data.get("obstacle"), dict) else None
        if d:
            obstacle[name] = d
    if obstacle:
        out["obstacle"] = obstacle
    caps = data.get("caps")
    if isinstance(caps, dict):
        out["caps"] = {k: bool(caps.get(k)) for k in (
            "autonomous_navigation", "obstacle_avoidance", "obstacle_sensor_healthy",
            "safety_controller_healthy", "camera_healthy", "gps_module", "motors")
            if isinstance(caps.get(k), bool)}
    rtb = data.get("rtb")
    if isinstance(rtb, dict):
        out["rtb"] = {
            "state": str(rtb.get("state") or "IDLE")[:24],
            "request_id": str(rtb.get("request_id") or "")[:40],
            "reason": str(rtb.get("reason") or "")[:64],
            "distance_m": _finite(rtb.get("distance_m"), 0, 10 ** 7),
            "arrived": rtb.get("arrived") is True,
        }
    pending = _finite(data.get("pending_events"), 0, 10 ** 6)
    if pending is not None:
        out["pending_events"] = int(pending)
    seq = _finite(data.get("seq"), 0, 10 ** 12)
    if seq is not None:
        out["seq"] = int(seq)
    return out


def validate_event(raw, now: float) -> dict:
    if not isinstance(raw, dict):
        raise FleetError(400, "Event must be an object")
    eid = raw.get("id")
    if not isinstance(eid, str) or not re.match(r"^[A-Za-z0-9._:-]{6,64}$", eid):
        raise FleetError(400, "Event id must be 6-64 safe characters")
    etype = str(raw.get("type") or "")
    if not re.match(r"^[a-z0-9_]{2,32}$", etype):
        raise FleetError(400, "Invalid event type")
    t = _finite(raw.get("t"), 0, now + 86400)           # device timestamp (epoch s)
    ev = {
        "id": eid, "type": etype,
        "severity": raw.get("severity") if raw.get("severity") in ("info", "warn", "critical") else "info",
        "t": t, "message": str(raw.get("message") or "")[:200],
        "offline": raw.get("offline") is True,
    }
    data = raw.get("data")
    if isinstance(data, dict):
        encoded = json.dumps(data, separators=(",", ":"))
        if len(encoded) > 6000:
            raise FleetError(400, "Event data too large")
        ev["data"] = data
    if etype == "gps_track":
        pts = []
        for p in (data or {}).get("points", [])[:100] if isinstance(data, dict) else []:
            la, lo, tt = _finite(p.get("lat"), -90, 90), _finite(p.get("lon"), -180, 180), _finite(p.get("t"), 0)
            if la is not None and lo is not None and tt is not None:
                pts.append({"t": tt, "lat": la, "lon": lo, "acc": _finite(p.get("acc"), 0, 10000)})
        ev["data"] = {"points": pts}
    return ev


# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------
class FleetService:
    def __init__(self, store, master_secret, clock=time.time, offline_after=OFFLINE_AFTER_SECONDS,
                 primary_rover="ROVER-01"):
        self.store = store
        self.master = master_secret
        self.clock = clock
        self.offline_after = offline_after
        self.primary_rover = primary_rover

    @property
    def enabled(self):
        return master_ok(self.master)

    def _require_enabled(self):
        if not self.enabled:
            raise FleetError(503, "Fleet service is not configured (FLEET_MASTER_SECRET missing or too short)")

    # -- device registry ----------------------------------------------------
    def register_device(self, device_id, name, role, actor):
        self._require_enabled()
        validate_device_id(device_id)
        if role not in ROLES:
            raise FleetError(400, "Role must be one of: " + ", ".join(ROLES))
        existing = self.store.get(f"dev:{device_id}")
        if existing and not existing.get("revoked"):
            raise FleetError(409, "Device already registered; rotate its key instead")
        version = (existing or {}).get("key_version", 0) + 1
        rec = {"id": device_id, "name": str(name or device_id)[:60], "role": role, "key_version": version,
               "revoked": False, "created_at": self.clock(), "created_by": str(actor)[:64]}
        self.store.put(f"dev:{device_id}", rec)
        return rec, derive_device_secret(self.master, device_id, version)

    def rotate_device(self, device_id, actor):
        self._require_enabled()
        rec = self.store.get(f"dev:{device_id}")
        if not rec or rec.get("revoked"):
            raise FleetError(404, "Unknown device")
        rec["key_version"] = int(rec["key_version"]) + 1
        rec["rotated_at"], rec["rotated_by"] = self.clock(), str(actor)[:64]
        self.store.put(f"dev:{device_id}", rec)
        return rec, derive_device_secret(self.master, device_id, rec["key_version"])

    def revoke_device(self, device_id, actor):
        rec = self.store.get(f"dev:{device_id}")
        if not rec:
            raise FleetError(404, "Unknown device")
        rec["revoked"], rec["revoked_at"], rec["revoked_by"] = True, self.clock(), str(actor)[:64]
        self.store.put(f"dev:{device_id}", rec)
        self.store.queue_cancel_pending(device_id, self.clock(), "device revoked")
        return rec

    def get_device(self, device_id):
        return self.store.get(f"dev:{device_id}")

    # -- authentication -----------------------------------------------------
    def authenticate(self, method, path, headers, body: bytes):
        """Verify a signed device request. Returns (device record, secret, nonce)."""
        self._require_enabled()
        if len(body or b"") > MAX_BODY_BYTES:
            raise FleetError(413, "Request too large")
        device_id = headers.get("X-Device-Id", "")
        ts, nonce, sig = headers.get("X-Timestamp", ""), headers.get("X-Nonce", ""), headers.get("X-Signature", "")
        if not DEVICE_ID_RE.match(device_id or "") or not NONCE_RE.match(nonce or "") or not sig or len(sig) != 64:
            raise FleetError(401, "Device authentication required")
        rec = self.store.get(f"dev:{device_id}")
        if not rec or rec.get("revoked"):
            raise FleetError(401, "Device authentication required")
        secret = derive_device_secret(self.master, device_id, rec["key_version"])
        expected = sign_request(secret, method, path, device_id, ts, nonce, body)
        if not hmac.compare_digest(expected, sig.lower()):
            raise FleetError(401, "Device authentication required")
        try:
            ts_f = float(ts)
        except ValueError:
            raise FleetError(401, "Device authentication required")
        if abs(self.clock() - ts_f) > MAX_SKEW_SECONDS:
            raise FleetError(401, "Timestamp outside allowed window", server_time=self.clock())
        # Nonce claimed only AFTER the signature is valid so unauthenticated
        # callers cannot fill the nonce table.
        if not self.store.claim_nonce(f"{device_id}:{nonce}", NONCE_TTL_SECONDS):
            raise FleetError(409, "Replayed request rejected")
        return rec, secret, nonce

    # -- status -------------------------------------------------------------
    def ingest_heartbeat(self, rec, body: dict, user_agent=""):
        status = validate_status(rec["role"], body)
        now = self.clock()
        prev = self.store.get(f"st:{rec['id']}") or {}
        # Per-device stale/out-of-order protection: reject strictly older seq
        # from the same boot (a delayed packet must not roll state back).
        if status.get("boot_id") and status.get("boot_id") == prev.get("boot_id") and \
                "seq" in status and "seq" in prev and status["seq"] <= prev["seq"]:
            raise FleetError(409, "Stale or duplicate heartbeat", last_seq=prev["seq"])
        was_online = prev.get("online_flag", False)
        status.update({"received_at": now, "online_flag": True, "device_id": rec["id"], "role": rec["role"]})
        # GPS history: keep a bounded in-status trail for map continuity.
        trail = prev.get("trail", [])
        if "lat" in status and status.get("gps_fix"):
            trail.append([round(status["lat"], 6), round(status["lon"], 6), int(now)])
            trail = trail[-60:]
        status["trail"] = trail
        self.store.put(f"st:{rec['id']}", status)
        events = []
        if not was_online:
            events.append(self._sys_event(rec["id"], f"on:{rec['id']}:{int(now)}", "device_online", "info",
                                          "Device connected / reconnected", now))
        if prev.get("estop") is not True and status.get("estop") is True:
            events.append(self._sys_event(rec["id"], f"es:{rec['id']}:{int(now * 1000)}", "emergency_stop", "critical",
                                          "Device reports emergency stop latched", now))
        if events:
            self.store.events_append(rec["id"], events)
        return status

    def _sys_event(self, device_id, eid, etype, severity, message, now):
        return {"id": eid, "type": etype, "severity": severity, "t": now, "message": message,
                "offline": False, "device_id": device_id, "received_at": now, "source": "server"}

    def effective_status(self, device_id):
        """Status with server-side freshness evaluation. Persists offline events once."""
        st = self.store.get(f"st:{device_id}")
        if not st:
            return None
        now = self.clock()
        age = now - st["received_at"]
        st = dict(st)
        st["age_s"] = round(age, 2)
        st["online"] = age <= self.offline_after
        if not st["online"] and st.get("online_flag"):
            # Deterministic id => idempotent even with concurrent readers.
            self.store.events_append(device_id, [self._sys_event(
                device_id, f"off:{device_id}:{int(st['received_at'])}", "device_offline", "warn",
                f"No heartbeat for {int(age)}s - device offline", now)])
            st["online_flag"] = False
            self.store.put(f"st:{device_id}", {**{k: v for k, v in st.items() if k not in ("age_s", "online")}})
        gps_age = st.get("gps_age_ms")
        st["gps_valid"] = bool(st.get("gps_fix") and "lat" in st and st.get("online") and
                               (gps_age is None or gps_age <= MAX_GPS_AGE_MS))
        return st

    def public_status(self, st, include_trail=False):
        keep = ("device_id", "role", "online", "age_s", "lat", "lon", "gps_fix", "gps_valid", "accuracy_m", "gps_sats",
                "gps_age_ms", "hdop", "speed_kmh", "heading", "battery", "signal", "camera", "obstacle", "caps", "fsm",
                "fsm_reason", "mode", "network", "link", "estop", "offline_autonomy", "motors_enabled", "rtb",
                "pending_events", "fw", "uptime_s", "received_at", "sim", "temp_c")
        out = {k: st[k] for k in keep if k in st}
        if include_trail:
            out["trail"] = st.get("trail", [])
        return out

    def fleet_snapshot(self, include_trail=False):
        devices = []
        for _, rec in self.store.list_prefix("dev:", 100):
            if rec.get("revoked"):
                continue
            st = self.effective_status(rec["id"])
            item = {"id": rec["id"], "name": rec["name"], "role": rec["role"], "created_at": rec["created_at"],
                    "key_version": rec["key_version"]}
            item["status"] = self.public_status(st, include_trail) if st else None
            item["online"] = bool(st and st["online"])
            devices.append(item)
        return devices

    def peers_for(self, device_id):
        out = []
        for d in self.fleet_snapshot():
            if d["id"] != device_id and d["status"]:
                s = d["status"]
                out.append({"id": d["id"], "name": d["name"], "role": d["role"], "online": d["online"],
                            **{k: s[k] for k in ("lat", "lon", "gps_fix", "battery", "signal", "camera", "fsm",
                                                 "estop", "received_at") if k in s}})
        return out

    # -- base ---------------------------------------------------------------
    def save_base(self, lat, lon, actor, device_id=None):
        lat, lon = _finite(lat, -90, 90), _finite(lon, -180, 180)
        if lat is None or lon is None:
            raise FleetError(400, "Valid base latitude and longitude are required")
        base = {"lat": lat, "lon": lon, "saved_at": self.clock(), "saved_by": str(actor)[:64],
                "device_id": device_id or self.primary_rover}
        self.store.put("base", base)
        self.store.events_append(base["device_id"], [self._sys_event(
            base["device_id"], f"base:{int(self.clock() * 1000)}", "base_saved", "info",
            f"Base saved by {actor}: {lat:.6f}, {lon:.6f}", self.clock())])
        return base

    def get_base(self):
        return self.store.get("base")

    # -- commands -----------------------------------------------------------
    def preflight(self, device_id, command):
        """Return (ok, reasons[]) for a command against the *server's* view of telemetry.

        The device repeats every check locally; this gate exists so unsafe
        requests are rejected visibly instead of silently queued."""
        reasons = []
        rec = self.store.get(f"dev:{device_id}")
        if not rec or rec.get("revoked"):
            return False, ["unknown device"]
        if rec["role"] != "rover":
            return False, ["target device is not a rover"]
        if command in ALWAYS_ALLOWED:
            return True, []
        st = self.effective_status(device_id)
        if not st or not st["online"]:
            return False, ["device offline"]
        if st["age_s"] > MOVE_FRESH_SECONDS:
            reasons.append("telemetry stale")
        caps = st.get("caps", {})
        if caps.get("safety_controller_healthy") is not True:
            reasons.append("safety controller not confirmed healthy")
        if st.get("estop"):
            reasons.append("emergency stop latched")
        if command == "RESET_ESTOP":
            # Reset is the one command that is *meant* to run while e-stop is latched.
            others = [r for r in reasons if r != "emergency stop latched"]
            return (not others), others
        batt = st.get("battery")
        front = (st.get("obstacle") or {}).get("front")
        fsm = st.get("fsm", "")
        if command in MOVEMENT_COMMANDS:
            if caps.get("obstacle_sensor_healthy") is not True:
                reasons.append("obstacle sensor not healthy")
            if not front or not front.get("valid"):
                reasons.append("obstacle data invalid")
            elif command == "FORWARD" and front["cm"] < MIN_FORWARD_CM:
                reasons.append(f"obstacle {front['cm']:.0f} cm ahead")
            if batt is None or batt < MIN_BATTERY_MOVE:
                reasons.append("battery low or unknown")
            if st.get("offline_autonomy"):
                reasons.append("rover is in offline autonomy")
            if fsm in RTB_ACTIVE_STATES:
                reasons.append("return-to-base in progress; cancel it first")
        elif command == "RETURN_TO_BASE":
            base = self.get_base()
            if not base:
                reasons.append("base location not saved")
            if not st.get("gps_valid"):
                reasons.append("no valid fresh GPS fix")
            elif st.get("accuracy_m") is None or st["accuracy_m"] > MAX_GPS_ACCURACY_M:
                reasons.append("GPS accuracy insufficient")
            for cap in ("autonomous_navigation", "obstacle_avoidance", "obstacle_sensor_healthy"):
                if caps.get(cap) is not True:
                    reasons.append(f"{cap} not confirmed")
            if not front or not front.get("valid"):
                reasons.append("obstacle data invalid")
            if batt is None or batt < MIN_BATTERY_RTB:
                reasons.append("battery below return-to-base reserve")
            if fsm in RTB_ACTIVE_STATES:
                reasons.append("return-to-base already active")
        return (not reasons), reasons

    def issue_command(self, device_id, command, actor, is_admin):
        self._require_enabled()
        command = str(command or "").upper()
        if command not in COMMANDS:
            raise FleetError(400, "Invalid command")
        if command in ADMIN_ONLY_COMMANDS and not is_admin:
            raise FleetError(403, "Administrator access required for this command")
        ok, reasons = self.preflight(device_id, command)
        if not ok:
            raise FleetError(409, "Command rejected by safety gate", reasons=reasons)
        now = self.clock()
        ttl = MOVEMENT_TTL_MS if command in MOVEMENT_COMMANDS else (RTB_TTL_MS if command == "RETURN_TO_BASE" else SAFE_TTL_MS)
        cmd = {"id": uuid.uuid4().hex, "device_id": device_id, "command": command, "issued_by": str(actor)[:64],
               "issued_at": now, "ttl_ms": ttl, "expires_at": now + ttl / 1000.0, "status": "pending", "deliveries": 0}
        if command in ("STOP", "EMERGENCY_STOP"):
            # A stop overrides everything still queued for the device.
            self.store.queue_cancel_pending(device_id, now, "superseded by " + command, keep=("EMERGENCY_STOP",))
        elif command in MOVEMENT_COMMANDS:
            self.store.queue_cancel_pending(device_id, now, "superseded by newer movement",
                                            keep=("STOP", "EMERGENCY_STOP", "RESET_ESTOP", "RETURN_TO_BASE", "CANCEL_RETURN"))
        if command == "RETURN_TO_BASE":
            base = self.get_base()
            cmd["base"] = {"lat": base["lat"], "lon": base["lon"]}
            cmd["request_id"] = cmd["id"]
        self.store.queue_push(device_id, cmd)
        self.store.events_append(device_id, [self._sys_event(
            device_id, f"cmd:{cmd['id']}", "command_issued", "warn" if command in ("EMERGENCY_STOP", "RETURN_TO_BASE") else "info",
            f"{command} issued by {actor}", now)])
        return cmd

    def device_commands(self, device_id):
        now = self.clock()
        cmds = []
        for c in self.store.queue_pending(device_id, now):
            item = {"id": c["id"], "command": c["command"], "ttl_ms": max(100, int((c["expires_at"] - now) * 1000)),
                    "issued_at": c["issued_at"]}
            if "base" in c:
                item["base"] = c["base"]
                item["request_id"] = c["request_id"]
            cmds.append(item)
        return cmds

    def ack_command(self, rec, body):
        cid = str((body or {}).get("id") or "")
        status = (body or {}).get("status")
        if status not in ("executed", "rejected", "ignored"):
            raise FleetError(400, "status must be executed, rejected or ignored")
        c = self.store.queue_ack(rec["id"], cid, status, str((body or {}).get("detail") or "")[:120], self.clock())
        if not c:
            raise FleetError(404, "Unknown command for this device")
        self.store.events_append(rec["id"], [self._sys_event(
            rec["id"], f"ack:{cid}:{status}", "command_ack", "info" if status == "executed" else "warn",
            f"{c['command']} {status}" + (f": {c.get('detail')}" if c.get("detail") else ""), self.clock())])
        return c

    # -- events -------------------------------------------------------------
    def ingest_events(self, rec, body):
        raw = (body or {}).get("events")
        if not isinstance(raw, list) or not raw:
            raise FleetError(400, "events must be a non-empty list")
        if len(raw) > MAX_EVENTS_PER_BATCH:
            raise FleetError(400, f"At most {MAX_EVENTS_PER_BATCH} events per batch")
        now = self.clock()
        evs = []
        for r in raw:
            ev = validate_event(r, now)
            ev.update({"device_id": rec["id"], "received_at": now, "source": "device"})
            evs.append(ev)
        accepted, dup = self.store.events_append(rec["id"], evs)
        # Everything in the batch is now durably known => safe for the device to drop.
        return {"accepted": accepted, "duplicates": dup, "stored_ids": accepted + dup}

    def ingest_sim_events(self, body):
        """Events from the browser Simulation Lab (administrator only). Stored under the reserved SIM-ROVER id and
        tagged source=simulation / data.sim=true so they can never be mistaken for events from a real rover."""
        raw = (body or {}).get("events")
        if not isinstance(raw, list) or not raw:
            raise FleetError(400, "events must be a non-empty list")
        if len(raw) > MAX_EVENTS_PER_BATCH:
            raise FleetError(400, f"At most {MAX_EVENTS_PER_BATCH} events per batch")
        now = self.clock()
        evs = []
        for r in raw:
            ev = validate_event(r, now)
            data = dict(ev.get("data") or {})
            data["sim"] = True
            ev["data"] = data
            ev.update({"device_id": SIM_DEVICE_ID, "received_at": now, "source": "simulation"})
            evs.append(ev)
        accepted, dup = self.store.events_append(SIM_DEVICE_ID, evs)
        return {"accepted": accepted, "duplicates": dup, "stored_ids": accepted + dup, "simulated": True}

    def list_events(self, limit=100, device_id=None):
        return self.store.events_list(min(max(int(limit), 1), 500), device_id)
