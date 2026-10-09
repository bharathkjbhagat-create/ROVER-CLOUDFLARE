from flask import Flask, Response, jsonify, request, send_from_directory, session, redirect, g
from functools import wraps
from pathlib import Path
from datetime import datetime, timezone, timedelta
from werkzeug.security import generate_password_hash as _werkzeug_generate_hash, check_password_hash

def generate_password_hash(password):
    # PBKDF2 works in the Cloudflare Python runtime; scrypt may not.
    return _werkzeug_generate_hash(password, method="pbkdf2:sha256")

def _safe_equal(a, b):
    # compare_digest can raise TypeError for incompatible string input.
    try:
        return hmac.compare_digest(str(a).encode("utf-8"), str(b).encode("utf-8"))
    except Exception:
        return False
import math
import os
import base64
import time
import uuid
import json
import hmac
import hashlib

try:
    from workers import env as CF_ENV
    from pyodide.ffi import run_sync
    import js
    CF_FETCH = js.fetch
except Exception:
    CF_ENV = None
    CF_FETCH = None
    run_sync = None

class _CompatLock:
    def __enter__(self): return self
    def __exit__(self, exc_type, exc, tb): return False

class _CompatThreading:
    @staticmethod
    def Lock(): return _CompatLock()

threading = _CompatThreading()

def _config(name, default=None):
    value = os.environ.get(name)
    if value not in (None, ""):
        return value
    if CF_ENV is not None:
        try:
            value = getattr(CF_ENV, name)
            if value not in (None, ""):
                return value
        except Exception:
            pass
    return default

psycopg = None
_psycopg_loaded = False

def get_psycopg():
    global psycopg, _psycopg_loaded
    if not _psycopg_loaded:
        _psycopg_loaded = True
        try:
            import psycopg as _psycopg
            psycopg = _psycopg
        except Exception:
            # PostgreSQL is optional for the Cloudflare demo/auth fallback path.
            psycopg = None
    return psycopg

BASE_DIR = Path(__file__).resolve().parents[1] / "public"
app = Flask(__name__)

# Secrets and credentials are supplied by Cloudflare Worker bindings/environment.
# There are deliberately no production credential fallbacks in source code.
# Session signing must survive Worker isolates. Prefer the dedicated secret;
# during migration, derive a stable signing key from an already-secret binding
# so a missing SESSION_SECRET cannot turn a valid login into a server error.
# Never fall back to a public constant.
SESSION_SECRET = _config("SESSION_SECRET")
if not SESSION_SECRET:
    _session_seed = (
        _config("ROVER_DEVICE_TOKEN")
        or _config("ADMIN_PASSWORD")
        or _config("FRIEND_MAHANTESH_PASSWORD_HASH")
        or _config("FRIEND_DHANUSH_PASSWORD_HASH")
        or _config("FRIEND_ANIRUDH_PASSWORD_HASH")
        or _config("FRIEND4_PASSWORD_HASH")
    )
    if _session_seed:
        SESSION_SECRET = "defenx-session-" + hashlib.sha256(
            str(_session_seed).encode("utf-8")
        ).hexdigest()
SESSION_SECRET_CONFIGURED = bool(SESSION_SECRET)
# Cloudflare validates/imports the module during deployment. If no secret
# binding exists at all, login returns a clear configuration error rather than
# producing an opaque 500.
app.secret_key = SESSION_SECRET or "DEFENX-CLOUDFLARE-BOOTSTRAP-INVALID"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_NAME="rover_session",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 12,
    SESSION_REFRESH_EACH_REQUEST=False,
    MAX_CONTENT_LENGTH=32 * 1024,
)

DATABASE_URL = _config("DATABASE_URL")
ADMIN_USERNAME = str(_config("ADMIN_USERNAME", "ADMIN") or "ADMIN").strip().upper()
ADMIN_PASSWORD = _config("ADMIN_PASSWORD")
ROVER_DEVICE_TOKEN = _config("ROVER_DEVICE_TOKEN", "").strip()
ROVER_CAMERA_STREAM_URL = _config("ROVER_CAMERA_STREAM_URL", "").strip()
ROVER_CAMERA_STREAM_TYPE = _config("ROVER_CAMERA_STREAM_TYPE", "mjpeg").strip().lower()
LEGACY_AUTH_ENABLED = str(_config("LEGACY_AUTH_ENABLED", "1")).strip().lower() not in {"0", "false", "no", "off"}
LEGACY_AUTH_URL = str(_config("LEGACY_AUTH_URL", "https://rover-ten-weld.vercel.app/api/login")).strip()

KNOWN_FRIEND_USERNAMES = ("MAHANTESH", "MAHADESH", "DHANUSH", "ANIRUDH", "MAMLESHWAR")

FRIEND_ACCOUNTS = [
    {
        "username": "MAHANTESH",
        "password": _config("FRIEND_MAHANTESH_PASSWORD"),
        "password_hash": _config("FRIEND_MAHANTESH_PASSWORD_HASH"),
        "display_name": "MAHANTESH",
    },
    {
        "username": "DHANUSH",
        "password": _config("FRIEND_DHANUSH_PASSWORD"),
        "password_hash": _config("FRIEND_DHANUSH_PASSWORD_HASH"),
        "display_name": "DHANUSH",
    },
    {
        "username": "ANIRUDH",
        "password": _config("FRIEND_ANIRUDH_PASSWORD"),
        "password_hash": _config("FRIEND_ANIRUDH_PASSWORD_HASH"),
        "display_name": "ANIRUDH",
    },
    {
        "username": "MAMLESHWAR",
        "password": None,
        "password_hash": _config("FRIEND4_PASSWORD_HASH"),
        "display_name": "MAMLESHWAR",
    },
]
FRIEND_ACCOUNTS = [x for x in FRIEND_ACCOUNTS if x.get("password_hash") or x.get("password")]

# Approved IDs remain recognizable even if a Cloudflare password binding is temporarily missing.
for _known_username in KNOWN_FRIEND_USERNAMES:
    if _known_username not in {x["username"] for x in FRIEND_ACCOUNTS}:
        FRIEND_ACCOUNTS.append({
            "username": _known_username,
            "password": None,
            "password_hash": None,
            "display_name": _known_username,
        })


# Shared login-alert storage for Vercel's serverless environment. Without a
# database, process memory is instance-local, so successful user logins are also
# written as small private Vercel Blob objects for cross-instance admin alerts.
# Cloudflare migration: login alerts are read from PostgreSQL audit_log.
# Vercel Blob is intentionally removed from the Cloudflare runtime.
BLOB_LOGIN_PREFIX = "defenx-audit/logins/"

def write_shared_login_event(user, details=""):
    if not user or user.get("role") != "user":
        return False
    now = datetime.now(timezone.utc)
    event = {
        "id": f"do-{time.time_ns()}-{uuid.uuid4().hex}",
        "username": user.get("username"),
        "display_name": user.get("display_name"),
        "role": user.get("role"),
        "action": "LOGIN",
        "details": details,
        "ip_address": client_ip(),
        "user_agent": request.headers.get("User-Agent", "")[:500],
        "created_at": now.isoformat(),
    }
    return bool(_realtime_call("append_login_event", event))

def read_shared_login_events(limit=20, since=None):
    try:
        safe_limit = min(max(int(limit), 1), 100)
    except (TypeError, ValueError):
        safe_limit = 20
    events = _realtime_call("get_login_events", safe_limit)
    if not isinstance(events, list):
        return [], None
    since_dt = None
    if since:
        try:
            since_dt = datetime.fromisoformat(str(since).replace("Z", "+00:00"))
            if since_dt.tzinfo is None:
                since_dt = since_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            since_dt = None
    filtered = []
    latest = None
    for event in events:
        stamp = _parse_iso_datetime(event.get("created_at"))
        if stamp is not None:
            if latest is None or stamp > latest:
                latest = stamp
            if since_dt is not None and stamp <= since_dt:
                continue
        filtered.append(event)
        if len(filtered) >= safe_limit:
            break
    return filtered, (latest.isoformat() if latest else None)


# Shared live-control state for Cloudflare.
# A Durable Object is the authoritative cross-instance live state and WebSocket hub.
BLOB_LIVE_PREFIX = "defenx-live/state/"
LIVE_STATE_CACHE_SECONDS = 0.05
BLOB_DEVICE_LOCATION_PREFIX = "defenx-device/location/"
try:
    DEVICE_OFFLINE_AFTER_SECONDS = max(5, int(_config("DEVICE_OFFLINE_AFTER_SECONDS", "8")))
except (TypeError, ValueError):
    DEVICE_OFFLINE_AFTER_SECONDS = 8
_shared_live_cache = {"expires": 0.0, "state": None}
_shared_live_lock = threading.Lock()
_last_realtime_push_at = 0.0
LIVE_STATE_PUSH_MIN_INTERVAL = 1.1

def _realtime_stub():
    if CF_ENV is None or run_sync is None:
        return None
    try:
        return CF_ENV.REALTIME_HUB.getByName("defenx-global")
    except Exception:
        return None

def _realtime_call(method, *args):
    stub = _realtime_stub()
    if stub is None:
        return None
    try:
        return run_sync(getattr(stub, method)(*args))
    except Exception:
        return None

def _shared_state_payload(version, source="system"):
    with lock:
        snapshot = json.loads(json.dumps(state))
    snapshot["sync_version"] = str(version)
    snapshot["sync_source"] = source
    snapshot["sync_at"] = datetime.now(timezone.utc).isoformat()
    return snapshot

def write_shared_live_state(source="system"):
    global _last_realtime_push_at
    now = datetime.now(timezone.utc)
    version = f"live-{int(now.timestamp()*1000):013d}-{uuid.uuid4().hex[:10]}"
    payload = _shared_state_payload(version, source)
    with _shared_live_lock:
        _shared_live_cache["expires"] = time.monotonic() + LIVE_STATE_CACHE_SECONDS
        _shared_live_cache["state"] = payload
    high_frequency = source in {"rover-device", "telemetry", "gps"} or source.startswith("simulation:")
    if (not high_frequency) or (time.monotonic() - _last_realtime_push_at >= LIVE_STATE_PUSH_MIN_INTERVAL):
        _realtime_call("set_state", payload)
        _last_realtime_push_at = time.monotonic()
    return payload

def read_shared_live_state(force=False):
    now = time.monotonic()
    with _shared_live_lock:
        cached = _shared_live_cache.get("state")
        expires = _shared_live_cache.get("expires", 0.0)
        if not force and cached is not None and now < expires:
            return json.loads(json.dumps(cached))
    snapshot = _realtime_call("get_state")
    if isinstance(snapshot, dict):
        snapshot = mark_device_offline_if_stale(snapshot)
        with _shared_live_lock:
            _shared_live_cache["expires"] = time.monotonic() + LIVE_STATE_CACHE_SECONDS
            _shared_live_cache["state"] = snapshot
        return snapshot
    return None

def apply_shared_live_state(snapshot):
    if not snapshot or not isinstance(snapshot, dict):
        return False
    with lock:
        for key in state.keys():
            if key in snapshot:
                state[key] = snapshot[key]
        state["updated"] = snapshot.get("updated", state.get("updated"))
    return True

def _parse_iso_datetime(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None

def _location_payload(snapshot, lost_at=None):
    try:
        lat = float(snapshot.get("lat")); lon = float(snapshot.get("lon"))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    captured = _parse_iso_datetime(snapshot.get("last_seen_at") or snapshot.get("updated")) or datetime.now(timezone.utc)
    lost = _parse_iso_datetime(lost_at) or datetime.now(timezone.utc)
    return {
        "device_id": str(snapshot.get("device_id") or "ROVER-01"),
        "lat": lat, "lon": lon,
        "speed_kmh": float(snapshot.get("speed_kmh") or 0),
        "heading": float(snapshot.get("heading") or 0),
        "battery": float(snapshot.get("battery") or 0),
        "signal": float(snapshot.get("signal") or 0),
        "gps_sats": int(snapshot.get("gps_sats") or 0),
        "gps_fix": bool(snapshot.get("gps_fix")),
        "network": str(snapshot.get("network") or ""),
        "captured_at": captured.isoformat(),
        "lost_at": lost.isoformat(),
        "reason": "SIGNAL_LOST",
    }

def write_persistent_last_known_loss(loss_event):
    if not loss_event:
        return False
    if not db_available():
        return bool(_realtime_call("set_last_known_loss", loss_event))
    device_code = str(loss_event.get("device_id") or "ROVER-01")
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO device_loss_events
                       (device_code,lat,lon,speed_kmh,heading,battery,signal,gps_sats,gps_fix,network,captured_at,lost_at,reason,cleared_at)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)
                       ON CONFLICT (device_code) DO UPDATE SET
                         lat=EXCLUDED.lat,lon=EXCLUDED.lon,speed_kmh=EXCLUDED.speed_kmh,
                         heading=EXCLUDED.heading,battery=EXCLUDED.battery,signal=EXCLUDED.signal,
                         gps_sats=EXCLUDED.gps_sats,gps_fix=EXCLUDED.gps_fix,network=EXCLUDED.network,
                         captured_at=EXCLUDED.captured_at,lost_at=EXCLUDED.lost_at,reason=EXCLUDED.reason,
                         cleared_at=NULL""",
                    (device_code,loss_event["lat"],loss_event["lon"],loss_event["speed_kmh"],
                     loss_event["heading"],loss_event["battery"],loss_event["signal"],loss_event["gps_sats"],
                     loss_event["gps_fix"],loss_event["network"],_parse_iso_datetime(loss_event["captured_at"]),
                     _parse_iso_datetime(loss_event["lost_at"]) or datetime.now(timezone.utc),
                     loss_event.get("reason") or "SIGNAL_LOST"),
                )
        return True
    except Exception:
        mark_db_unavailable()
        return False

def read_persistent_last_known_loss(device_code="ROVER-01"):
    code = str(device_code or "ROVER-01")
    if not db_available():
        return None
    try:
        with get_db() as conn:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute(
                    """SELECT device_code,lat,lon,speed_kmh,heading,battery,signal,gps_sats,gps_fix,network,
                              captured_at,lost_at,reason,cleared_at
                       FROM device_loss_events WHERE device_code=%s LIMIT 1""", (code,))
                row = cur.fetchone()
                if row and row["cleared_at"] is None:
                    event = dict(row)
                    for key in ("captured_at", "lost_at"):
                        if event.get(key) is not None:
                            event[key] = event[key].isoformat()
                    event["device_id"] = event.pop("device_code")
                    return event
    except Exception:
        mark_db_unavailable()
    return _realtime_call("get_last_known_loss", code) or None

def clear_persistent_last_known_loss(device_code="ROVER-01"):
    code = str(device_code or "ROVER-01")
    if not db_available():
        _realtime_call("clear_last_known_loss", code)
        return
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM device_loss_events WHERE device_code=%s", (code,))
    except Exception:
        mark_db_unavailable()

def mark_device_offline_if_stale(snapshot):
    if not snapshot or not isinstance(snapshot,dict) or snapshot.get("device_online") is False:
        return snapshot
    last_seen=_parse_iso_datetime(snapshot.get("last_seen_at") or snapshot.get("updated"))
    if not last_seen or (datetime.now(timezone.utc)-last_seen).total_seconds()<DEVICE_OFFLINE_AFTER_SECONDS:
        return snapshot
    loss_event=_location_payload(snapshot,lost_at=datetime.now(timezone.utc).isoformat())
    if not loss_event:return snapshot
    snapshot["device_online"]=False
    snapshot["signal_lost_at"]=loss_event["lost_at"]
    snapshot["last_known_loss"]=loss_event
    write_persistent_last_known_loss(loss_event)
    apply_shared_live_state(snapshot)
    write_shared_live_state("device-signal-lost")
    return snapshot

# Simple per-instance login throttling. Vercel may run multiple instances, so
# this is an additional defense rather than a replacement for edge/WAF limits.
LOGIN_WINDOW_SECONDS = 300
LOGIN_MAX_ATTEMPTS = 6
_login_attempts = {}
_login_lock = threading.Lock()

def safe_check_password_hash(password_hash, password):
    """Return False instead of crashing when a stored hash is malformed or
    unsupported by the Cloudflare Python runtime."""
    if not password_hash:
        return False
    try:
        return bool(check_password_hash(str(password_hash), str(password)))
    except Exception as exc:
        print(f"DEFENX password hash verification failed: {type(exc).__name__}")
        return False

def login_rate_limited(ip):
    now = time.monotonic()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _login_attempts[ip] = attempts
        return len(attempts) >= LOGIN_MAX_ATTEMPTS

def record_login_failure(ip):
    now = time.monotonic()
    with _login_lock:
        attempts = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        attempts.append(now)
        _login_attempts[ip] = attempts

def clear_login_failures(ip):
    with _login_lock:
        _login_attempts.pop(ip, None)

@app.before_request
def block_cross_origin_state_change():
    # Reject cross-origin state-changing API requests before the endpoint runs.
    if request.path.startswith("/api/") and request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.path != "/api/login":
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") != f"{request.scheme}://{request.host}".rstrip("/"):
            return jsonify({"ok": False, "error": "Cross-origin request blocked"}), 403

@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=(self)"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # Authentication pages and API responses can contain private account or rover
    # state. Prevent browsers and intermediary caches from reusing those responses.
    if request.path.startswith("/api/") or request.path in {"/", "/index.html", "/login.html", "/secure-login"}:
        response.headers["Cache-Control"] = "no-store"
    return response

state = {
    "device_id": "ROVER-01", "lat": 12.9716, "lon": 77.5946, "speed_kmh": 0.0, "heading": 0,
    "battery": 78, "signal": 82, "gps_sats": 9, "gps_fix": True, "mode": "MANUAL",
    "obstacle_cm": 125, "camera": True, "network": "4G",
    "ai": {"person": 0, "vehicle": 0, "object": 0, "confidence": 0.0},
    "target": {
        "detected": False, "type": "Object", "range_m": 0, "speed_kmh": 0.0,
        "heading": 0, "direction": "N", "size_m": 0.0, "confidence": 0.0,
        "lat": 12.9716, "lon": 77.5946,
    },
    "temp_c": 32, "storage_pct": 72,
    "last_command": "STOP", "updated": datetime.now(timezone.utc).isoformat(),
    "tracking": True, "geofence": True, "alert": None,
    "gps_source": "SIMULATION", "gps_accuracy_m": None, "gps_last_epoch": 0.0, "gps_source_id": "",
    "camera_source": "SIMULATION", "target_source": "SIMULATION",
    "device_online": True, "last_seen_at": datetime.now(timezone.utc).isoformat(),
    "signal_lost_at": None, "last_known_loss": None,
}
track = []
recent_actions = []

# When PostgreSQL is intentionally not connected, keep Admin-managed friend
# accounts in the running application instance so password resets still work.
# This avoids requiring Neon/PostgreSQL for the live demonstration.
runtime_users = {}
runtime_password_hashes = {}
for i, friend in enumerate(FRIEND_ACCOUNTS, start=1):
    runtime_users[friend["username"]] = {
        "id": f"runtime-{i}",
        "username": friend["username"],
        "display_name": friend.get("display_name") or friend["username"],
        "role": "user",
        "enabled": True,
        "can_control": True,
        "can_manage_users": False,
        "created_at": None,
        "last_login_at": None,
    }
    runtime_password_hashes[friend["username"]] = friend.get("password_hash")

# Common spelling alias used for MAHANTESH.
if "MAHANTESH" in runtime_users:
    runtime_users["MAHADESH"] = dict(runtime_users["MAHANTESH"])
    runtime_users["MAHADESH"]["username"] = "MAHANTESH"
    runtime_password_hashes["MAHADESH"] = runtime_password_hashes.get("MAHANTESH")

lock = threading.Lock()
_db_initialized = False
_db_unavailable_until = 0.0
_db_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY,
 username TEXT UNIQUE NOT NULL,
 display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user',
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 can_control BOOLEAN NOT NULL DEFAULT TRUE,
 can_manage_users BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS devices (
 id UUID PRIMARY KEY,
 device_code TEXT UNIQUE NOT NULL,
 name TEXT NOT NULL,
 type TEXT NOT NULL DEFAULT 'ROVER',
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 notes TEXT DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS audit_log (
 id BIGSERIAL PRIMARY KEY,
 username TEXT NOT NULL,
 display_name TEXT,
 role TEXT,
 action TEXT NOT NULL,
 details TEXT,
 ip_address TEXT,
 user_agent TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS device_loss_events (
 device_code TEXT PRIMARY KEY,
 lat DOUBLE PRECISION NOT NULL,
 lon DOUBLE PRECISION NOT NULL,
 speed_kmh DOUBLE PRECISION,
 heading DOUBLE PRECISION,
 battery DOUBLE PRECISION,
 signal DOUBLE PRECISION,
 gps_sats INTEGER,
 gps_fix BOOLEAN,
 network TEXT,
 captured_at TIMESTAMPTZ NOT NULL,
 lost_at TIMESTAMPTZ NOT NULL,
 reason TEXT NOT NULL DEFAULT 'SIGNAL_LOST',
 cleared_at TIMESTAMPTZ
);
"""

def db_available():
    try:
        configured_store = bool(DATABASE_URL or _cf_hyperdrive())
        if not configured_store or not ADMIN_USERNAME or not ADMIN_PASSWORD:
            return False
        if time.monotonic() < _db_unavailable_until:
            return False
        return bool(get_psycopg())
    except Exception:
        return False

def mark_db_unavailable(seconds=20):
    global _db_unavailable_until, _db_initialized
    _db_unavailable_until = time.monotonic() + seconds
    _db_initialized = False

def _cf_hyperdrive():
    if CF_ENV is None:
        return None
    try:
        return getattr(CF_ENV, "HYPERDRIVE")
    except Exception:
        return None

def get_db():
    if not db_available():
        return None
    try:
        hd = _cf_hyperdrive()
        if hd is not None and not DATABASE_URL:
            return psycopg.connect(
                host=str(hd.host),
                port=int(hd.port),
                user=str(hd.user),
                password=str(hd.password),
                dbname=str(hd.database),
                sslmode="disable",
                autocommit=True,
                connect_timeout=2,
            )
        return psycopg.connect(DATABASE_URL, autocommit=True, connect_timeout=2)
    except Exception:
        mark_db_unavailable()
        raise

def ensure_db():
    global _db_initialized
    if not db_available() or _db_initialized:
        return
    with _db_lock:
        if _db_initialized or not db_available():
            return
        try:
            with get_db() as conn:
                with conn.cursor() as cur:
                    for statement in [s.strip() for s in SCHEMA.split(";") if s.strip()]:
                        cur.execute(statement)
                    cur.execute("UPDATE users SET can_control=TRUE WHERE enabled=TRUE")
                    cur.execute("SELECT id FROM users WHERE username=%s", (ADMIN_USERNAME,))
                    if not cur.fetchone():
                        cur.execute(
                            """INSERT INTO users
                            (id,username,display_name,password_hash,role,enabled,can_control,can_manage_users)
                            VALUES (%s,%s,%s,%s,'admin',TRUE,TRUE,TRUE)""",
                            (str(uuid.uuid4()), ADMIN_USERNAME, "ROVER Administrator", generate_password_hash(ADMIN_PASSWORD)),
                        )
                    cur.execute("SELECT id FROM devices WHERE device_code=%s", ("ROVER-01",))
                    if not cur.fetchone():
                        cur.execute(
                            """INSERT INTO devices (id,device_code,name,type,enabled,notes)
                               VALUES (%s,%s,%s,'ROVER',TRUE,%s)""",
                            (str(uuid.uuid4()), "ROVER-01", "ROVER-01", "Default demonstration rover"),
                        )
                    for i, friend in enumerate(FRIEND_ACCOUNTS, start=1):
                        cur.execute("SELECT id FROM users WHERE username=%s", (friend["username"],))
                        if not cur.fetchone():
                            cur.execute(
                                """INSERT INTO users
                                (id,username,display_name,password_hash,role,enabled,can_control,can_manage_users)
                                VALUES (%s,%s,%s,%s,'user',TRUE,TRUE,FALSE)""",
                                (
                                    str(uuid.uuid4()),
                                    friend["username"],
                                    friend.get("display_name") or f"ROVER Friend {i}",
                                    friend.get("password_hash") or generate_password_hash(friend["password"]),
                                ),
                            )
                _db_initialized = True
        except Exception:
            # Never hold the page hostage when the database is unavailable.
            mark_db_unavailable()

def client_ip():
    # Cloudflare provides the connecting client address directly; fall back to
    # the forwarded chain for local/proxy-compatible deployments.
    return (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    )

def fallback_user():
    data = session.get("fallback_user")
    return dict(data) if data else None

def current_user():
    if hasattr(g, "_rover_user_loaded"):
        return g._rover_user

    # Fast path: after login, the signed Flask session already contains the
    # authenticated user's public identity and permissions. Do not hit
    # PostgreSQL for every dashboard/API request.
    cached = session.get("user_cache")
    if cached and cached.get("username"):
        user = dict(cached)
    else:
        user = fallback_user()

    g._rover_user_loaded = True
    g._rover_user = user
    return user

AUDIT_RETENTION_HOURS = 24
AUDIT_RETENTION_SECONDS = AUDIT_RETENTION_HOURS * 60 * 60

def prune_local_login_events():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=AUDIT_RETENTION_HOURS)
    with lock:
        recent_actions[:] = [
            x for x in recent_actions
            if x.get("action") != "LOGIN" or (
                x.get("created_at") and datetime.fromisoformat(str(x["created_at"]).replace("Z","+00:00")) >= cutoff
            )
        ]

def recent_action(action, details="", user=None):
    u = user or current_user()
    entry = {
        "id": f"local-{time.time_ns()}",
        "username": u["username"] if u else "anonymous",
        "display_name": u.get("display_name") if u else None,
        "role": u.get("role") if u else None,
        "action": action,
        "details": details,
        "ip_address": client_ip(),
        "user_agent": request.headers.get("User-Agent", "")[:500],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with lock:
        recent_actions.insert(0, entry)
        # Keep every successful login locally for the full 24-hour retention window.
        cutoff = datetime.now(timezone.utc) - timedelta(hours=AUDIT_RETENTION_HOURS)
        recent_actions[:] = [
            x for x in recent_actions
            if x.get("action") != "LOGIN" or (
                x.get("created_at") and datetime.fromisoformat(str(x["created_at"]).replace("Z","+00:00")) >= cutoff
            )
        ]
        # Non-login UI events remain bounded; LOGIN events are retained separately for 24h.
        non_login = [x for x in recent_actions if x.get("action") != "LOGIN"][:100]
        logins = [x for x in recent_actions if x.get("action") == "LOGIN"]
        recent_actions[:] = sorted(non_login + logins, key=lambda x: str(x.get("created_at","")), reverse=True)

def audit(action, details="", user=None):
    # Successful login entries are intentionally retained for 24 hours, then removed.
    if db_available():
        try:
            with get_db() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """DELETE FROM audit_log
                           WHERE action = 'LOGIN'
                             AND created_at < NOW() - INTERVAL '24 hours'"""
                    )
        except Exception:
            mark_db_unavailable()
    prune_local_login_events()
    if not db_available():
        recent_action(action, details, user)
        if action == "LOGIN":
            write_shared_login_event(user or current_user(), details)
        return
    u = user or current_user()
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO audit_log
                       (username,display_name,role,action,details,ip_address,user_agent)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        u["username"] if u else "anonymous",
                        u.get("display_name") if u else None,
                        u.get("role") if u else None,
                        action,
                        details,
                        client_ip(),
                        request.headers.get("User-Agent", "")[:500],
                    ),
                )
    except Exception:
        recent_action(action, details, user)
        mark_db_unavailable()
        if action == "LOGIN":
            write_shared_login_event(user or current_user(), details)
def require_login(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user():
            return jsonify({"ok": False, "error": "Login required"}), 401
        return fn(*args, **kwargs)
    return wrapper

def require_control(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            return jsonify({"ok": False, "error": "Login required"}), 401
        # Every authenticated user is allowed to operate the rover control panel.
        # User-management permissions remain separate and admin-only unless granted.
        return fn(*args, **kwargs)
    return wrapper

def require_manage(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            return jsonify({"ok": False, "error": "Login required"}), 401
        if u["role"] != "admin" and not u["can_manage_users"]:
            return jsonify({"ok": False, "error": "User-management permission required"}), 403
        return fn(*args, **kwargs)
    return wrapper

def require_admin(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        u = current_user()
        if not u:
            return jsonify({"ok": False, "error": "Login required"}), 401
        if u["role"] != "admin":
            return jsonify({"ok": False, "error": "Admin access required"}), 403
        return fn(*args, **kwargs)
    return wrapper


def _asset_response(filename, mimetype=None):
    """Serve a Workers Static Asset when running on Cloudflare; fall back to disk locally."""
    try:
        env = request.environ.get("workers.env")
        assets = getattr(env, "ASSETS", None) if env is not None else None
        if assets is not None and run_sync is not None:
            js = __import__("js")
            asset_request = js.Request.new(str(request.url))
            asset_response = run_sync(assets.fetch(asset_request))
            body = run_sync(asset_response.bytes())
            response = Response(body, status=int(asset_response.status), headers=asset_response.headers)
            if mimetype:
                response.headers["Content-Type"] = mimetype
            return response
    except Exception:
        pass
    return send_from_directory(BASE_DIR, filename, mimetype=mimetype)


def add_track():
    with lock:
        track.append({"lat": state["lat"], "lon": state["lon"], "t": state["updated"]})
        if len(track) > 1000:
            del track[:200]

@app.get("/")
@app.get("/index.html")
def index():
    # Public access is limited to an explicitly requested, read-only simulation.
    # It uses browser-generated demo telemetry and never creates an auth session.
    if request.args.get("demo") == "1":
        response = _asset_response("index.html", "text/html; charset=utf-8")
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        response.headers["X-DEFENX-Demo"] = "read-only"
        return response

    # Normal dashboard entry remains session-protected.
    entry_granted = bool(session.pop("dashboard_entry", False))
    if not entry_granted or not current_user():
        session.clear()
        response = redirect("/secure-login?ui=20261005", code=302)
        response.delete_cookie("rover_auth", path="/")
        return response
    response = _asset_response("index.html", "text/html; charset=utf-8")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.get("/demo")
def demo_entry():
    # Static asset routing only knows actual files; send demo visitors to the
    # existing HTML entry point, where the query flag activates local simulation.
    return redirect("/index.html?demo=1", code=302)

@app.get("/login.html")
def login_page():
    response = _asset_response("login.html", "text/html; charset=utf-8")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.get("/secure-login")
def secure_login():
    return redirect("/login.html", code=302)

@app.get("/api/logout")
def logout_to_login():
    """Clear the browser session and return the operator to the sign-in screen."""
    session.clear()
    response = redirect("/login.html", code=302)
    response.delete_cookie(
        "rover_session", path="/", secure=True, httponly=True, samesite="Lax"
    )
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response

def cached_static(filename, mimetype):
    response = _asset_response(filename, mimetype)
    # app.js and style.css are loaded with a version query string in index.html.
    # Let browsers/CDN cache them so routine dashboard loads do not invoke Flask
    # just to re-download unchanged static assets.
    response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
    return response

@app.get("/app.js")
def app_js():
    return cached_static("app.js", "application/javascript")

@app.get("/style.css")
def style_css():
    return cached_static("style.css", "text/css")

@app.get("/sw.js")
def service_worker():
    return _asset_response("sw.js", "application/javascript")

@app.get("/manifest.webmanifest")
def manifest():
    return _asset_response("manifest.webmanifest", "application/manifest+json")



@app.get("/rover-device.webp")
def rover_device_photo():
    return cached_static("rover-device.webp", "image/webp")

@app.get("/rover-left.webp")
def rover_left_photo():
    return cached_static("rover-left.webp", "image/webp")

@app.get("/api/health")
def health():
    # Public diagnostic endpoint: expose configuration status only, never secrets.
    return jsonify({
        "ok": True,
        "service": "ROVER-01",
        "runtime": "cloudflare-worker",
        "session_configured": bool(SESSION_SECRET),
        "admin_configured": bool(ADMIN_USERNAME and ADMIN_PASSWORD),
        "legacy_bridge_configured": bool(LEGACY_AUTH_ENABLED and LEGACY_AUTH_URL and CF_ENV is not None),
        "legacy_auth_enabled": bool(LEGACY_AUTH_ENABLED and LEGACY_AUTH_URL),
        "auth_path_configured": bool(
            (ADMIN_USERNAME and ADMIN_PASSWORD)
            or (LEGACY_AUTH_ENABLED and LEGACY_AUTH_URL)
        ),
        "realtime_bound": bool(_realtime_stub()),
    })

@app.get("/api/ping")
def ping():
    # Public, lightweight warm-up endpoint used by the static sign-in screen.
    # It keeps the Python function ready before the operator submits credentials.
    response = jsonify({"ok": True, "service": "ROVER-01"})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response

@app.get("/api/me")
@require_login
def me():
    return jsonify({"ok": True, "user": current_user(), "db_connected": db_available()})

@app.get("/api/bootstrap")
@require_login
def bootstrap():
    u=current_user()
    snapshot = read_shared_live_state(force=True)
    if snapshot:
        apply_shared_live_state(snapshot)
    with lock:
        telemetry={**state, "track": track[-120:]}
    if snapshot:
        telemetry["sync_version"]=snapshot.get("sync_version")
        telemetry["sync_source"]=snapshot.get("sync_source")
        telemetry["sync_at"]=snapshot.get("sync_at")
    if telemetry.get("last_known_loss") is None:
        persisted_loss=read_persistent_last_known_loss(str(telemetry.get("device_id") or "ROVER-01"))
        if persisted_loss: telemetry["last_known_loss"]=persisted_loss
    return jsonify({"ok":True,"user":u,"telemetry":telemetry,"db_connected":db_available()})

def _signed_worker_legacy_user():
    """Read a legacy-authenticated user injected by the async Worker layer.

    The async Worker performs the external Fetch call. It then signs this
    compact user payload with the same session secret before forwarding the
    request into Flask, so browser-supplied headers cannot impersonate a user.
    """
    payload = request.headers.get("X-DEFENX-LEGACY-USER", "")
    signature = request.headers.get("X-DEFENX-LEGACY-SIG", "")
    if not payload or not signature or not SESSION_SECRET:
        return None
    try:
        expected = hmac.new(
            str(SESSION_SECRET).encode("utf-8"),
            payload.encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        padded = payload + "=" * (-len(payload) % 4)
        user = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if not isinstance(user, dict):
            return None
        username = str(user.get("username") or "").strip().upper()
        role = str(user.get("role") or "user").strip().lower()
        if not username or role not in {"admin", "user"}:
            return None
        return {
            "id": str(user.get("id") or f"legacy-{username.lower()}"),
            "username": username,
            "display_name": str(user.get("display_name") or username)[:120],
            "role": role,
            "enabled": bool(user.get("enabled", True)),
            "can_control": bool(user.get("can_control", True)),
            "can_manage_users": bool(user.get("can_manage_users", False)),
            "created_at": user.get("created_at"),
            "last_login_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        print(f"DEFENX signed legacy authentication rejected: {type(exc).__name__}")
        return None

@app.post("/api/login")
def login():
    if not SESSION_SECRET_CONFIGURED:
        return jsonify({
            "ok": False,
            "error": "Cloudflare SESSION_SECRET is not configured."
        }), 503
    ip = client_ip()
    if login_rate_limited(ip):
        response = jsonify({"ok": False, "error": "Too many login attempts. Please wait 5 minutes."})
        response.status_code = 429
        response.headers["Retry-After"] = str(LOGIN_WINDOW_SECONDS)
        return response
    # Fast path for configured operator accounts: do not wait for a database
    # connection during sign-in. This keeps the command gate responsive after
    # cold starts and when the database is temporarily unavailable.
    data = request.get_json(silent=True) or {}
    raw_username = str(data.get("username", "")).strip()
    # Preserve the real login ID for database/email-style accounts. A compact
    # comparison key is used only for admin aliases and runtime lookup.
    username = raw_username.upper()

    def normalize_login_id(value):
        return "".join(ch for ch in str(value or "").upper() if ch.isalnum())

    login_key = normalize_login_id(username)
    # Canonicalize the known alias before external or database authentication.
    friend_aliases = {"MAHADESH": "MAHANTESH"}
    canonical_username = friend_aliases.get(login_key, username)
    password = str(data.get("password", ""))

    # Keep validation consistent with the Worker-native login path: malformed
    # or incomplete credentials are client errors, not authentication failures.
    if not username or not password:
        return jsonify({
            "ok": False,
            "error": "Enter login ID and password.",
            "field": "username" if not username else "password",
        }), 400

    # Keep the admin sign-in compatible with the previous dashboard. ADMIN,
    # ADMINISTRATOR, DEFENX ADMIN and ROVER ADMIN all map to the configured admin.
    admin_login_ids = {
        normalize_login_id(x)
        for x in {
            ADMIN_USERNAME,
            "ADMIN",
            "ADMIN-1",
            "ADMINISTRATOR",
            "DEFENX ADMIN",
            "DEFENX ADMINISTRATOR",
            "ROVER ADMIN",
            "ROVER ADMINISTRATOR",
            "ADMIN USER",
            "ADMIN USER ID",
        }
        if x
    }
    fast_user = _signed_worker_legacy_user()
    # Fast authentication path: configured Admin and Friend accounts are already
    # available in Worker memory. Verify them locally before touching PostgreSQL,
    # so a slow database can never hold the sign-in screen hostage.
    if ADMIN_USERNAME and ADMIN_PASSWORD and login_key in admin_login_ids and _safe_equal(password, ADMIN_PASSWORD):
        fast_user = {"id": "env-admin", "username": ADMIN_USERNAME or "ADMIN", "display_name": "ROVER Administrator",
                     "role": "admin", "enabled": True, "can_control": True, "can_manage_users": True,
                     "created_at": None, "last_login_at": None}
    else:
        runtime_user = runtime_users.get(username)
        runtime_hash = runtime_password_hashes.get(username)
        if not runtime_user and login_key:
            for candidate_username, candidate_user in runtime_users.items():
                if normalize_login_id(candidate_username) == login_key:
                    runtime_user = candidate_user
                    runtime_hash = runtime_password_hashes.get(candidate_username)
                    break
        if runtime_user and runtime_user.get("enabled") and runtime_hash:
            try:
                if safe_check_password_hash(runtime_hash, password):
                    fast_user = dict(runtime_user)
                    fast_user["last_login_at"] = datetime.now(timezone.utc).isoformat()
                    runtime_users[username] = dict(fast_user)
            except Exception:
                fast_user = None

    if fast_user:
        clear_login_failures(ip)
        session.clear()
        session.permanent = False
        session["fallback_user"] = fast_user
        session["user_cache"] = fast_user
        session["dashboard_entry"] = True
        # Do not block sign-in on a database audit write. Keep the event in the
        # local/realtime login-alert path and let administrative persistence happen
        # outside the critical authentication path.
        # Authentication must never fail because audit/live-sync/database helpers are unavailable.
        # The session is already established at this point; auxiliary logging is best-effort.
        try:
            recent_action("LOGIN", "Successful login", fast_user)
        except Exception as exc:
            print(f"DEFENX login audit skipped: {type(exc).__name__}")
        if fast_user.get("role") == "user":
            try:
                write_shared_login_event(fast_user, "Successful login")
            except Exception as exc:
                print(f"DEFENX login event skipped: {type(exc).__name__}")
        try:
            db_status = bool(db_available())
        except Exception:
            db_status = False
        response = jsonify({"ok": True, "user": fast_user, "db_connected": db_status})
        response.set_cookie(
            "rover_auth", "1", max_age=60 * 60 * 12,
            secure=_config("COOKIE_SECURE", "1") != "0",
            httponly=True, samesite="Lax", path="/"
        )
        return response

    # Migration authentication is handled by the asynchronous Cloudflare
    # Worker entrypoint before Flask/WSGI. Never call the legacy Fetch bridge
    # from this synchronous handler: it can trigger Worker error 1101 / HTTP 500.
    # Unknown credentials may require the database lookup.
    try:
        ensure_db()
        database_ready = db_available()
    except Exception as exc:
        print(f"DEFENX login database preflight failed: {type(exc).__name__}")
        database_ready = False

    if not database_ready:
        if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
            user = {"id": "env-admin", "username": ADMIN_USERNAME or "ADMIN", "display_name": "ROVER Administrator",
                    "role": "admin", "enabled": True, "can_control": True, "can_manage_users": True,
                    "created_at": None, "last_login_at": None}
        else:
            user = None
            known_username = login_key in admin_login_ids or username in runtime_users or any(normalize_login_id(x) == login_key for x in runtime_users)
            runtime_user = runtime_users.get(username)
            runtime_hash = runtime_password_hashes.get(username)
            if runtime_user and runtime_user.get("enabled") and runtime_hash is None:
                configured_friend = next((f for f in FRIEND_ACCOUNTS if f["username"] == username), None)
                if configured_friend and configured_friend.get("password"):
                    runtime_hash = generate_password_hash(configured_friend["password"])
                    runtime_password_hashes[username] = runtime_hash
            if runtime_user and runtime_user.get("enabled") and runtime_hash and safe_check_password_hash(runtime_hash, password):
                user = dict(runtime_user)
                user["last_login_at"] = datetime.now(timezone.utc).isoformat()
                runtime_users[username] = dict(user)
        if not user:
            record_login_failure(ip)
            return jsonify({"ok": False,
                            "error": "Invalid password." if known_username else "Invalid login ID.",
                            "field": "password" if known_username else "username"}), 401
        session.clear()
        session.permanent = False
        session["fallback_user"] = user
        session["user_cache"] = user
        session["dashboard_entry"] = True
        audit("LOGIN", "Successful login", user)
        response = jsonify({"ok": True, "user": user, "db_connected": False,
                            "warning": "Database not connected. Friend management and permanent audit history require DATABASE_URL."})
        response.set_cookie(
            "rover_auth", "1", max_age=60 * 60 * 12,
            secure=_config("COOKIE_SECURE", "1") != "0",
            httponly=True, samesite="Lax", path="/"
        )
        return response

    with get_db() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute("SELECT * FROM users WHERE UPPER(username)=UPPER(%s) LIMIT 1", (canonical_username,))
            user = cur.fetchone()

            # Seed configured friend accounts only when their DB row does not
            # exist. Once a row exists, its password hash is authoritative so an
            # Admin reset persists.
            friend_config = next(
                (friend for friend in FRIEND_ACCOUNTS if normalize_login_id(friend["username"]) == login_key or friend["username"] == canonical_username),
                None,
            )
            if friend_config:
                if user:
                    if not user["enabled"] or not safe_check_password_hash(user["password_hash"], password):
                        record_login_failure(ip)
                        audit("LOGIN_FAILED", "Invalid login attempt")
                        return jsonify({"ok": False, "error": "Invalid password.", "field": "password"}), 401
                    cur.execute(
                        """UPDATE users SET display_name=%s,role='user',
                           enabled=TRUE,can_control=TRUE,can_manage_users=FALSE,
                           last_login_at=NOW()
                           WHERE id=%s""",
                        (friend_config.get("display_name") or username, user["id"]),
                    )
                    cur.execute("SELECT * FROM users WHERE id=%s", (user["id"],))
                    user = cur.fetchone()
                else:
                    configured_hash = friend_config.get("password_hash")
                    configured_password = friend_config.get("password")
                    if configured_hash:
                        valid = safe_check_password_hash(configured_hash, password)
                        password_hash = configured_hash
                    else:
                        valid = (
                            configured_password is not None
                            and _safe_equal(password, configured_password)
                        )
                        password_hash = generate_password_hash(password) if valid else None
                    if not valid:
                        record_login_failure(ip)
                        audit("LOGIN_FAILED", "Invalid login attempt")
                        return jsonify({"ok": False, "error": "Invalid password.", "field": "password"}), 401
                    friend_id = str(uuid.uuid4())
                    cur.execute(
                        """INSERT INTO users
                           (id,username,display_name,password_hash,role,enabled,can_control,can_manage_users,last_login_at)
                           VALUES (%s,%s,%s,%s,'user',TRUE,TRUE,FALSE,NOW())""",
                        (
                            friend_id,
                            username,
                            friend_config.get("display_name") or username,
                            password_hash,
                        ),
                    )
                    cur.execute("SELECT * FROM users WHERE id=%s", (friend_id,))
                    user = cur.fetchone()
            elif not user:
                record_login_failure(ip)
                audit("LOGIN_FAILED", "Invalid login attempt")
                return jsonify({"ok": False, "error": "Invalid login ID.", "field": "username"}), 401
            elif not user["enabled"] or not safe_check_password_hash(user["password_hash"], password):
                record_login_failure(ip)
                audit("LOGIN_FAILED", "Invalid login attempt")
                return jsonify({"ok": False, "error": "Invalid password.", "field": "password"}), 401
            else:
                cur.execute("UPDATE users SET last_login_at=NOW() WHERE id=%s", (user["id"],))
                user = dict(user)

    clear_login_failures(ip)
    session.clear()
    session.permanent = False
    session["user_id"] = str(user["id"])
    session["dashboard_entry"] = True
    public_user = {
        "id": str(user["id"]), "username": user["username"], "display_name": user["display_name"],
        "role": user["role"], "enabled": user["enabled"], "can_control": user["can_control"],
        "can_manage_users": user["can_manage_users"]
    }
    session["user_cache"] = public_user
    # Database authentication is already complete; audit persistence is best-effort.
    try:
        audit("LOGIN", "Successful login", user)
    except Exception as exc:
        print(f"DEFENX database login audit skipped: {type(exc).__name__}")
    response = jsonify({"ok": True, "user": public_user, "db_connected": True})
    response.set_cookie(
        "rover_auth", "1", max_age=60 * 60 * 12,
        secure=_config("COOKIE_SECURE", "1") != "0",
        httponly=True, samesite="Lax", path="/"
    )
    return response

@app.post("/api/logout")
@require_login
def logout():
    u = current_user()
    audit("LOGOUT", "User logged out", u)
    session.clear()
    response = jsonify({"ok": True})
    response.delete_cookie("rover_auth", path="/")
    return response

@app.post("/api/profile")
@require_login
def profile():
    u = current_user()
    data = request.get_json(silent=True) or {}
    display_name = str(data.get("display_name", "")).strip()
    new_password = str(data.get("new_password", ""))
    if not display_name:
        return jsonify({"ok": False, "error": "Display name is required"}), 400
    if len(new_password) > 0 and len(new_password) < 10:
        return jsonify({"ok": False, "error": "New password must be at least 10 characters"}), 400

    if not db_available():
        u["display_name"] = display_name
        session["fallback_user"] = dict(u)
        session["user_cache"] = dict(u)
        return jsonify({"ok": True, "user": u, "db_connected": False,
                        "warning": "Profile display name is session-only until DATABASE_URL is connected."})

    with get_db() as conn:
        with conn.cursor() as cur:
            if new_password:
                cur.execute("UPDATE users SET display_name=%s,password_hash=%s WHERE id=%s",
                            (display_name, generate_password_hash(new_password), u["id"]))
            else:
                cur.execute("UPDATE users SET display_name=%s WHERE id=%s", (display_name, u["id"]))
    public = {
        "id": str(u["id"]), "username": u["username"], "display_name": display_name,
        "role": u["role"], "enabled": u["enabled"], "can_control": u["can_control"],
        "can_manage_users": u["can_manage_users"]
    }
    session["user_cache"] = public
    audit("PROFILE_UPDATED", "Profile updated", u)
    return jsonify({"ok": True, "user": public, "db_connected": True})

@app.get("/api/users")
@require_manage
def users():
    # Initialize the database/schema and seed the four configured friend accounts
    # before reading the Admin user-management table.
    ensure_db()
    if not db_available():
        rows = []
        for username, user in runtime_users.items():
            rows.append(dict(user))
        if ADMIN_USERNAME:
            rows.insert(0, {
                "id": "env-admin", "username": ADMIN_USERNAME, "display_name": "ROVER Administrator",
                "role": "admin", "enabled": True, "can_control": True, "can_manage_users": True,
                "created_at": None, "last_login_at": None
            })
        return jsonify({"ok": True, "users": rows, "db_connected": False,
                        "warning": "User changes are active for the current application instance without PostgreSQL."})
    with get_db() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute("""SELECT id,username,display_name,role,enabled,can_control,can_manage_users,created_at,last_login_at
                           FROM users ORDER BY created_at DESC""")
            rows = cur.fetchall()
    return jsonify({"ok": True, "users": [dict(x, id=str(x["id"])) for x in rows]})

@app.post("/api/users")
@require_manage
def create_user():
    ensure_db()
    if not db_available():
        return jsonify({"ok": False, "error": "Connect PostgreSQL (DATABASE_URL) to add friend accounts."}), 503
    actor = current_user()
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    display_name = str(data.get("display_name", "")).strip() or username
    password = str(data.get("password", ""))
    role = str(data.get("role", "user")).lower()
    # All active users receive rover-control access by design.
    can_control = True
    can_manage_users = bool(data.get("can_manage_users"))
    if len(username) < 3 or len(password) < 10:
        return jsonify({"ok": False, "error": "Login ID needs 3+ characters and password needs 10+ characters"}), 400
    if role not in {"user", "admin"}:
        return jsonify({"ok": False, "error": "Invalid role"}), 400
    if actor["role"] != "admin" and role == "admin":
        return jsonify({"ok": False, "error": "Only an admin can create another admin"}), 403
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO users
                (id,username,display_name,password_hash,role,enabled,can_control,can_manage_users)
                VALUES (%s,%s,%s,%s,%s,TRUE,%s,%s)""",
                (str(uuid.uuid4()), username, display_name, generate_password_hash(password), role, can_control, can_manage_users))
        audit("USER_CREATED", f"Created {username}", actor)
        return jsonify({"ok": True})
    except Exception:
        return jsonify({"ok": False, "error": "Login ID already exists or could not be created"}), 400

@app.patch("/api/users/<user_id>")
@require_manage
def update_user(user_id):
    ensure_db()
    actor = current_user()
    if not db_available():
        target = next((u for u in runtime_users.values() if str(u["id"]) == str(user_id)), None)
        if not target:
            return jsonify({"ok": False, "error": "User not found"}), 404
        data = request.get_json(silent=True) or {}
        if "display_name" in data:
            target["display_name"] = str(data.get("display_name", "")).strip() or target["display_name"]
        if "enabled" in data:
            if str(target["id"]) == str(actor["id"]) and not bool(data["enabled"]):
                return jsonify({"ok": False, "error": "You cannot disable your own account"}), 400
            target["enabled"] = bool(data["enabled"])
        if "can_manage_users" in data:
            target["can_manage_users"] = bool(data["can_manage_users"])
        audit("USER_UPDATED", f"Updated {target['username']}", actor)
        return jsonify({"ok": True, "db_connected": False,
                        "warning": "User changes are active for the running application instance."})
    data = request.get_json(silent=True) or {}
    with get_db() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute("SELECT * FROM users WHERE id=%s", (user_id,))
            target = cur.fetchone()
            if not target:
                return jsonify({"ok": False, "error": "User not found"}), 404
            role = str(data.get("role", target["role"])).lower()
            if role not in {"user", "admin"}:
                return jsonify({"ok": False, "error": "Invalid role"}), 400
            if actor["role"] != "admin" and role == "admin":
                return jsonify({"ok": False, "error": "Only an admin can promote to admin"}), 403
            display_name = str(data.get("display_name", target["display_name"])).strip() or target["display_name"]
            enabled = bool(data.get("enabled", target["enabled"]))
            # Rover control is available to every active user; only user-management remains permissioned.
            can_control = True
            can_manage_users = bool(data.get("can_manage_users", target["can_manage_users"]))
            if str(target["id"]) == str(actor["id"]) and not enabled:
                return jsonify({"ok": False, "error": "You cannot disable your own account"}), 400
            cur.execute("""UPDATE users SET display_name=%s,role=%s,enabled=%s,can_control=%s,can_manage_users=%s
                           WHERE id=%s""",
                        (display_name, role, enabled, can_control, can_manage_users, user_id))
    audit("USER_UPDATED", f"Updated {target['username']}", actor)
    return jsonify({"ok": True})

@app.post("/api/users/<user_id>/reset-password")
@require_admin
def reset_password(user_id):
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    if len(password) < 10:
        return jsonify({"ok": False, "error": "Password must be at least 10 characters"}), 400
    actor = current_user()
    ensure_db()

    # No database required: update the running friend account's password hash.
    for username, target in runtime_users.items():
        if str(target["id"]) == str(user_id):
            runtime_password_hashes[username] = generate_password_hash(password)
            audit("PASSWORD_RESET", f"Reset password for {username}", actor)
            return jsonify({"ok": True, "db_connected": False,
                            "warning": "Password changed successfully for the running application instance."})

    if not db_available():
        return jsonify({"ok": False, "error": "User not found"}), 404

    try:
        with get_db() as conn:
            with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                cur.execute("SELECT id,username FROM users WHERE id=%s", (user_id,))
                target = cur.fetchone()
                if not target:
                    return jsonify({"ok": False, "error": "User not found"}), 404
                cur.execute(
                    "UPDATE users SET password_hash=%s WHERE id=%s",
                    (generate_password_hash(password), user_id),
                )
        audit("PASSWORD_RESET", f"Reset password for {target['username']}", actor)
        return jsonify({"ok": True})
    except Exception:
        return jsonify({"ok": False, "error": "Could not reset password"}), 400

@app.get("/api/audit")
@require_admin
def audit_logs():
    try:
        limit = min(max(int(request.args.get("limit", "1000")), 1), 5000)
    except ValueError:
        limit = 1000
    rows = []
    warning = None
    if db_available():
        try:
            with get_db() as conn:
                with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                    cur.execute(
                        """SELECT id,username,display_name,role,action,details,ip_address,user_agent,created_at
                           FROM audit_log
                           WHERE created_at >= NOW() - INTERVAL '24 hours'
                              OR action <> 'LOGIN'
                           ORDER BY created_at DESC LIMIT %s""",
                        (limit,),
                    )
                    rows = [dict(x, id=int(x["id"])) for x in cur.fetchall()]
        except Exception:
            mark_db_unavailable()
            warning = "PostgreSQL is temporarily unavailable. Showing recent local events."
    if not db_available() and warning is None:
        warning = "Permanent audit history requires DATABASE_URL. Showing recent local events."
    if not db_available():
        shared_rows, _ = read_shared_login_events(limit=limit, since=None)
        rows.extend(shared_rows)
    with lock:
        rows.extend(recent_actions[:limit])
    dedup = {}
    for item in rows:
        dedup[str(item.get("id"))] = item
    rows = list(dedup.values())
    rows.sort(key=lambda x: str(x.get("created_at", "")), reverse=True)
    result = {"ok": True, "logs": rows[:limit]}
    if warning:
        result["warning"] = warning
    return jsonify(result)


@app.get("/api/login-events")
@require_admin
def login_events():
    try:
        limit = min(max(int(request.args.get("limit", "100")), 1), 100)
    except ValueError:
        limit = 100
    since = request.args.get("since", "").strip()
    rows = []
    warning = None

    if db_available():
        try:
            with get_db() as conn:
                with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
                    if since:
                        try:
                            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
                        except ValueError:
                            since_dt = None
                    else:
                        since_dt = None
                    if since_dt is not None:
                        cur.execute(
                            """SELECT id,username,display_name,role,action,details,ip_address,user_agent,created_at
                               FROM audit_log
                               WHERE action='LOGIN' AND role='user' AND created_at > %s
                               ORDER BY created_at DESC LIMIT %s""",
                            (since_dt, limit),
                        )
                    else:
                        cur.execute(
                            """SELECT id,username,display_name,role,action,details,ip_address,user_agent,created_at
                               FROM audit_log
                               WHERE action='LOGIN' AND role='user'
                               ORDER BY created_at DESC LIMIT %s""",
                            (limit,),
                        )
                    rows = [dict(x, id=int(x["id"])) for x in cur.fetchall()]
        except Exception:
            mark_db_unavailable()
            warning = "PostgreSQL is temporarily unavailable. Using shared login alerts."

    if not db_available():
        if warning is None:
            warning = "PostgreSQL is not connected. Using shared login alerts."
        shared_rows, latest = read_shared_login_events(limit=limit, since=since or None)
        rows.extend(shared_rows)
    else:
        latest = None

    with lock:
        rows.extend(
            x for x in recent_actions
            if x.get("action") == "LOGIN" and x.get("role") == "user"
        )

    dedup = {}
    for item in rows:
        key = f'{item.get("username","")}|{item.get("created_at","")}|{item.get("action","")}'
        dedup[key] = item
    rows = list(dedup.values())
    rows.sort(key=lambda x: str(x.get("created_at", "")), reverse=True)
    result = {"ok": True, "logs": rows[:limit]}
    if latest:
        result["latest"] = latest
    if warning:
        result["warning"] = warning
    return jsonify(result)

@app.get("/api/devices")
@require_login
def devices():
    if not db_available():
        return jsonify({"ok": True, "devices": [
            {"id":"fallback-rover-01","device_code":"ROVER-01","name":"ROVER-01","type":"ROVER","enabled":True,
             "notes":"Default demonstration rover","created_at":None}
        ], "db_connected": False})
    with get_db() as conn:
        with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
            cur.execute("SELECT id,device_code,name,type,enabled,notes,created_at FROM devices ORDER BY created_at ASC")
            rows=cur.fetchall()
    return jsonify({"ok":True,"devices":[dict(x,id=str(x["id"])) for x in rows],"db_connected":True})

@app.post("/api/devices")
@require_manage
def create_device():
    actor=current_user()
    data=request.get_json(silent=True) or {}
    code=str(data.get("device_code","")).strip().upper()
    name=str(data.get("name","")).strip() or code
    dtype=str(data.get("type","ROVER")).strip().upper() or "ROVER"
    notes=str(data.get("notes","")).strip()
    if len(code)<3 or len(name)<2:
        return jsonify({"ok":False,"error":"Device ID needs 3+ characters and a device name is required"}),400
    if not db_available():
        return jsonify({"ok":False,"error":"Device registration becomes permanent after PostgreSQL (DATABASE_URL) is connected."}),503
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""INSERT INTO devices (id,device_code,name,type,enabled,notes)
                               VALUES (%s,%s,%s,%s,TRUE,%s)""",
                            (str(uuid.uuid4()),code,name,dtype,notes))
        audit("DEVICE_CREATED",f"Added {code}",actor)
        return jsonify({"ok":True})
    except Exception:
        return jsonify({"ok":False,"error":"Device ID already exists or could not be added"}),400

@app.post("/api/activity")
@require_login
def activity():
    u = current_user()
    data = request.get_json(silent=True) or {}
    action = str(data.get("action", "")).strip().upper().replace(" ", "_")
    details = str(data.get("details", "")).strip()
    allowed = {
        "MAP_SATELLITE", "MAP_CENTER", "MAP_FIT", "THEME_CHANGED",
        "PROFILE_OPENED", "ALERTS_OPENED", "DEVICES_OPENED",
        "BROWSER_ALERTS_ENABLED", "LOGIN_ALERTS_CLEARED",
        "CAMERA_RECORD", "NIGHT_MODE",
    }
    if action not in allowed:
        return jsonify({"ok": False, "error": "Invalid activity"}), 400
    audit(action, details[:500], u)
    return jsonify({"ok": True})

@app.get("/api/live-sync")
def live_sync():
    expected = _config("LIVE_SYNC_SECRET")
    supplied = request.headers.get("X-Live-Sync", "")
    if not expected or supplied != expected:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    snapshot = read_shared_live_state()
    if snapshot:
        apply_shared_live_state(snapshot)
    with lock:
        response_state = {**state, "track": track[-120:]}
    if snapshot:
        response_state["sync_version"] = snapshot.get("sync_version")
        response_state["sync_source"] = snapshot.get("sync_source")
        response_state["sync_at"] = snapshot.get("sync_at")
    return jsonify(response_state)

@app.get("/api/device-last-known")
@require_login
def device_last_known():
    snapshot=read_shared_live_state(force=True)
    if snapshot: apply_shared_live_state(snapshot)
    with lock:
        device_code=str(state.get("device_id") or "ROVER-01")
        loss=state.get("last_known_loss")
        online=bool(state.get("device_online",True))
        last_seen_at=state.get("last_seen_at") or state.get("updated")
        signal_lost_at=state.get("signal_lost_at")
    if loss is None:
        loss=read_persistent_last_known_loss(device_code)
        if loss:
            with lock: state["last_known_loss"]=loss
    return jsonify({"ok":True,"device_id":device_code,"device_online":online,"last_seen_at":last_seen_at,
                    "signal_lost_at":signal_lost_at,"last_known_loss":loss})

@app.delete("/api/device-last-known")
@require_login
def remove_device_last_known():
    data=request.get_json(silent=True) or {}
    device_code=str(data.get("device_id") or state.get("device_id") or "ROVER-01")
    clear_persistent_last_known_loss(device_code)
    with lock: state["last_known_loss"]=None
    write_shared_live_state("last-known-remove")
    return jsonify({"ok":True,"device_id":device_code})

@app.get("/api/telemetry")
@require_login
def telemetry():
    snapshot = read_shared_live_state()
    if snapshot:
        apply_shared_live_state(snapshot)
    with lock:
        response_state = {**state, "track": track[-120:]}
    if snapshot:
        response_state["sync_version"] = snapshot.get("sync_version")
        response_state["sync_source"] = snapshot.get("sync_source")
        response_state["sync_at"] = snapshot.get("sync_at")
    return jsonify(response_state)

def valid_device_token():
    supplied = str(request.headers.get("X-Rover-Device-Token") or "").strip()
    if not supplied:
        auth = str(request.headers.get("Authorization") or "")
        if auth.lower().startswith("bearer "):
            supplied = auth[7:].strip()
    return bool(ROVER_DEVICE_TOKEN) and bool(supplied) and _safe_equal(supplied, ROVER_DEVICE_TOKEN)

def require_device_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not valid_device_token():
            return jsonify({"ok": False, "error": "Rover device authentication required"}), 401
        return fn(*args, **kwargs)
    return wrapper

def _finite_number(value, default=None, minimum=None, maximum=None):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(n):
        return default
    if minimum is not None and n < minimum:
        return default
    if maximum is not None and n > maximum:
        return default
    return n

@app.get("/api/camera-config")
@require_login
def camera_config():
    return jsonify({
        "ok": True,
        "enabled": bool(ROVER_CAMERA_STREAM_URL),
        "url": ROVER_CAMERA_STREAM_URL if ROVER_CAMERA_STREAM_URL else None,
        "type": ROVER_CAMERA_STREAM_TYPE if ROVER_CAMERA_STREAM_URL else None,
        "source": "ROVER_CAMERA" if ROVER_CAMERA_STREAM_URL else "SIMULATION",
    })

@app.post("/api/device/telemetry")
@require_device_token
def device_telemetry():
    data = request.get_json(silent=True) or {}
    with lock:
        for key, minimum, maximum in (
            ("speed_kmh", 0, 500), ("heading", -720, 720), ("battery", 0, 100),
            ("signal", 0, 100), ("obstacle_cm", 0, 100000),
        ):
            if key in data:
                value = _finite_number(data.get(key), None, minimum, maximum)
                if value is not None:
                    state[key] = value

        lat = _finite_number(data.get("lat"), None, -90, 90)
        lon = _finite_number(data.get("lon"), None, -180, 180)
        accuracy = _finite_number(data.get("accuracy_m"), None, 0, 10000)
        if lat is not None and lon is not None:
            state["lat"] = lat
            state["lon"] = lon
            state["gps_fix"] = True
            if accuracy is not None:
                state["gps_accuracy_m"] = round(accuracy, 1)
            state["gps_source"] = "ROVER_DEVICE"
            state["gps_last_epoch"] = time.time()
            state["gps_source_id"] = str(data.get("source_id") or "ROVER-01")[:120]

        if isinstance(data.get("gps_sats"), (int, float)) and math.isfinite(float(data["gps_sats"])):
            state["gps_sats"] = max(0, int(data["gps_sats"]))
        if "mode" in data and str(data.get("mode")).upper() in {"MANUAL","ASSISTED","AUTO-DEMO"}:
            state["mode"] = str(data["mode"]).upper()
        if "network" in data:
            state["network"] = str(data.get("network") or "")[:80]
        if isinstance(data.get("ai"), dict):
            ai=data["ai"]
            state["ai"]={
                "person": max(0,int(ai.get("person", state["ai"].get("person",0)) or 0)),
                "vehicle": max(0,int(ai.get("vehicle", state["ai"].get("vehicle",0)) or 0)),
                "object": max(0,int(ai.get("object", state["ai"].get("object",0)) or 0)),
                "confidence": max(0.0,min(1.0,float(ai.get("confidence", state["ai"].get("confidence",0.0)) or 0.0))),
            }
        if isinstance(data.get("target"), dict):
            t=data["target"]
            detected=bool(t.get("detected"))
            state["target"]={
                "detected": detected,
                "type": str(t.get("type") or "Object")[:80],
                "range_m": max(0,float(t.get("range_m") or 0)),
                "speed_kmh": max(0,float(t.get("speed_kmh") or 0)),
                "heading": float(t.get("heading") or 0)%360,
                "direction": str(t.get("direction") or "N")[:12],
                "size_m": max(0,float(t.get("size_m") or 0)),
                "confidence": max(0.0,min(1.0,float(t.get("confidence") or 0))),
                "lat": lat if lat is not None else state["lat"],
                "lon": lon if lon is not None else state["lon"],
            }
            state["target_source"]="ROVER_DEVICE"
            state["alert"]="TARGET_DETECTED" if detected else None
        if isinstance(data.get("camera"), bool):
            state["camera"] = data["camera"]
            state["camera_source"] = "ROVER_DEVICE"
        state["updated"] = datetime.now(timezone.utc).isoformat()
        state["last_seen_at"] = state["updated"]
        state["device_online"] = True
        state["signal_lost_at"] = None
    add_track()
    snapshot = write_shared_live_state("rover-device")
    return jsonify({"ok": True, "telemetry": snapshot or None})

@app.post("/api/telemetry")
@require_login
def ingest():
    data = request.get_json(silent=True) or {}
    # Telemetry is authoritative input from the active source. Avoid a Blob read
    # before every tick; high-frequency telemetry is intentionally memory/realtime
    # state and is not durably persisted on each update.
    with lock:
        for key in ["lat","lon","speed_kmh","heading","battery","signal","gps_sats","obstacle_cm","mode","network","gps_fix"]:
            if key in data:
                state[key] = data[key]
        if isinstance(data.get("ai"), dict):
            state["ai"].update(data["ai"])
        state["updated"] = datetime.now(timezone.utc).isoformat()
        state["last_seen_at"] = state["updated"]
        state["device_online"] = True
        state["signal_lost_at"] = None
    add_track()
    snapshot = write_shared_live_state("telemetry")
    return jsonify({"ok": True, "telemetry": snapshot or None})

@app.post("/api/gps")
@require_login
def gps_ingest():
    # Live GPS is high-frequency input. Do not fetch Blob state on every GPS tick.
    data = request.get_json(silent=True) or {}
    try:
        lat = float(data.get("lat"))
        lon = float(data.get("lon"))
        accuracy = float(data.get("accuracy_m", 9999))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Valid GPS latitude, longitude and accuracy are required"}), 400

    if not math.isfinite(lat) or not math.isfinite(lon) or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return jsonify({"ok": False, "error": "Invalid GPS coordinates"}), 400
    if not math.isfinite(accuracy) or accuracy < 0 or accuracy > 10000:
        return jsonify({"ok": False, "error": "Invalid GPS accuracy"}), 400

    source_id = str(data.get("source_id") or "").strip()[:120]
    if not source_id:
        return jsonify({"ok": False, "error": "GPS source ID is required"}), 400

    now = time.time()
    with lock:
        active_source = str(state.get("gps_source_id") or "")
        active_kind = str(state.get("gps_source") or "")
        last_epoch = float(state.get("gps_last_epoch") or 0)
        if active_kind == "ROVER_DEVICE" and (now - last_epoch) < 30:
            return jsonify({
                "ok": False,
                "error": "Rover device GPS is active",
                "gps_source": "ROVER_DEVICE",
            }), 409
        if active_source and active_source != source_id and (now - last_epoch) < 20:
            return jsonify({
                "ok": False,
                "error": "Another live GPS source is active",
                "gps_source": "LIVE_GPS",
            }), 409

        state["lat"] = lat
        state["lon"] = lon
        state["gps_fix"] = True
        state["gps_accuracy_m"] = round(accuracy, 1)
        state["gps_source"] = "LIVE_GPS"
        state["gps_last_epoch"] = now
        state["gps_source_id"] = source_id
        if isinstance(data.get("gps_sats"), (int, float)) and math.isfinite(float(data["gps_sats"])):
            state["gps_sats"] = max(0, int(data["gps_sats"]))
        state["updated"] = datetime.now(timezone.utc).isoformat()
        state["last_seen_at"] = state["updated"]
        state["device_online"] = True
        state["signal_lost_at"] = None

    add_track()
    shared = write_shared_live_state("gps")
    return jsonify({"ok": True, "telemetry": shared or None, "gps_source": "LIVE_GPS", "accuracy_m": round(accuracy, 1)})

@app.post("/api/command")
@require_control
def command():
    u = current_user()
    snapshot = read_shared_live_state(force=True)
    if snapshot:
        apply_shared_live_state(snapshot)
    data = request.get_json(silent=True) or {}
    cmd = str(data.get("command", "STOP")).upper()
    allowed = {"FORWARD","REVERSE","LEFT","RIGHT","STOP","PAN_LEFT","PAN_RIGHT","TILT_UP","TILT_DOWN"}
    if cmd not in allowed:
        return jsonify({"ok": False, "error": "Invalid command"}), 400
    with lock:
        state["last_command"] = cmd
        if cmd == "STOP":
            state["speed_kmh"] = 0
        state["updated"] = datetime.now(timezone.utc).isoformat()
    write_shared_live_state(f"command:{u.get('username','unknown')}:{cmd}")
    audit("COMMAND", cmd, u)
    snapshot = read_shared_live_state(force=True)
    return jsonify({"ok": True, "command": cmd, "telemetry": snapshot or None})

@app.post("/api/mode")
@require_control
def mode():
    u = current_user()
    snapshot = read_shared_live_state(force=True)
    if snapshot:
        apply_shared_live_state(snapshot)
    data = request.get_json(silent=True) or {}
    mode_name = str(data.get("mode", "MANUAL")).upper()
    if mode_name not in {"MANUAL","ASSISTED","AUTO-DEMO"}:
        return jsonify({"ok": False, "error": "Invalid mode"}), 400
    with lock:
        state["mode"] = mode_name
        state["updated"] = datetime.now(timezone.utc).isoformat()
    write_shared_live_state(f"mode:{u.get('username','unknown')}:{mode_name}")
    audit("MODE_CHANGE", mode_name, u)
    snapshot = read_shared_live_state(force=True)
    return jsonify({"ok": True, "mode": mode_name, "telemetry": snapshot or None})

@app.post("/api/simulate")
@require_control
def simulate():
    u = current_user()
    # Simulation is an active local state update; avoid a Blob read before each
    # button-triggered tick now that simulation state is kept in realtime memory.
    with lock:
        ang = math.radians((time.time() * 8) % 360)
        gps_live_fresh = str(state.get("gps_source") or "") in {"LIVE_GPS", "ROVER_DEVICE"} and (time.time() - float(state.get("gps_last_epoch") or 0)) < 30
        if not gps_live_fresh:
            state["lat"] = 12.9716 + 0.0022 * math.sin(ang)
            state["lon"] = 77.5946 + 0.0028 * math.cos(ang)
            state["gps_fix"] = False
            state["gps_source"] = "SIMULATION"
            state["gps_accuracy_m"] = None
            state["camera_source"] = "SIMULATION"
            state["target_source"] = "SIMULATION"
        state["speed_kmh"] = 3.5
        state["heading"] = (math.degrees(ang) + 90) % 360
        state["signal"] = int(65 + 25 * (0.5 + 0.5 * math.sin(ang * 2)))
        state["battery"] = max(20, 78 - int((time.time() / 20) % 35))
        state["obstacle_cm"] = int(80 + 70 * (0.5 + 0.5 * math.cos(ang * 3)))
        # Simulation only: targets appear suddenly for a few seconds, then disappear.
        # This is not a real sensor detection.
        event_slot = int(time.time() // 12) % 4
        detected = event_slot in (1,)
        target_bearing = (math.degrees(ang) + 42) % 360
        target_range = int(680 + 170 * (0.5 + 0.5 * math.sin(ang * 1.7))) if detected else 0
        target_speed = round(12 + 9 * (0.5 + 0.5 * math.cos(ang * 1.3)), 1) if detected else 0.0
        target_lat = state["lat"] + 0.0058 + 0.0007 * math.sin(ang * 1.4) if detected else state["lat"]
        target_lon = state["lon"] + 0.0062 + 0.0007 * math.cos(ang * 1.4) if detected else state["lon"]
        target_conf = round(0.91 + 0.07 * (0.5 + 0.5 * math.sin(ang * 2.1)), 3) if detected else 0.0
        target_type = "Person" if (int(time.time() // 24) % 2)==0 else "Object"
        dirs = ["N","NE","E","SE","S","SW","W","NW"]
        target_direction = dirs[int(round(target_bearing / 45.0)) % 8] if detected else "N"
        state["target"] = {
            "detected": detected, "type": target_type if detected else "Object", "range_m": target_range,
            "speed_kmh": target_speed, "heading": target_bearing if detected else 0, "direction": target_direction,
            "size_m": 1.7 if target_type == "Person" and detected else (1.0 if detected else 0.0),
            "confidence": target_conf, "lat": target_lat, "lon": target_lon,
        }
        state["ai"] = {
            "person": 1 if detected and target_type == "Person" else 0,
            "vehicle": 0,
            "object": 1 if detected and target_type == "Object" else 0,
            "confidence": target_conf,
        }
        state["temp_c"] = int(31 + 2 * (0.5 + 0.5 * math.sin(ang * 0.8)))
        state["storage_pct"] = max(60, 72 - int((time.time() / 180) % 12))
        state["alert"] = "TARGET_DETECTED" if detected else None
        state["updated"] = datetime.now(timezone.utc).isoformat()
        state["last_seen_at"] = state["updated"]
        state["device_online"] = True
        state["signal_lost_at"] = None
    add_track()
    snapshot = write_shared_live_state(f"simulation:{u.get('username','unknown')}")
    # Simulation ticks are system telemetry, not user actions. Do not flood
    # the shared Admin event log with one entry every few seconds.
    return jsonify({"ok": True, "telemetry": snapshot or None})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)