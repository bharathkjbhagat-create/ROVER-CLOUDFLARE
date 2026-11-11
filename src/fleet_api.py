"""Flask routes for DEFENX device fleet synchronisation.

``register_fleet(app, hooks)`` is called once from app.py.  ``hooks`` supplies
the existing application's auth decorators, audit logger and live-state helpers
so this module stays decoupled and the existing login/session logic is reused
unchanged.
"""
from __future__ import annotations

import json
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from flask import Response, jsonify, request

import fleet as F


# --------------------------------------------------------------------------
# Durable Object backed store (production).  Mirrors MemoryFleetStore.
# --------------------------------------------------------------------------
class DOFleetStore:
    """Calls ``RealtimeHub.fleet_op`` (worker.py).  Any failure raises
    ``FleetStoreError`` so callers fail closed (HTTP 503) instead of accepting
    unauthenticated or un-persisted data."""

    def __init__(self, stub_getter, run_sync):
        self._stub = stub_getter
        self._run = run_sync

    def _op(self, op, **kw):
        stub = self._stub()
        if stub is None or self._run is None:
            raise F.FleetStoreError("fleet store unavailable")
        try:
            result = self._run(stub.fleet_op(json.dumps({"op": op, **kw}, separators=(",", ":"))))
        except Exception as exc:  # noqa: BLE001
            raise F.FleetStoreError("fleet store unavailable") from exc
        if hasattr(result, "to_py"):
            result = result.to_py()
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise F.FleetStoreError(str((result or {}).get("error") if isinstance(result, dict) else "fleet store error"))
        return result

    def get(self, key):
        return self._op("get", key=key).get("value")

    def put(self, key, value):
        self._op("put", key=key, value=value)

    def delete(self, key):
        self._op("delete", key=key)

    def list_prefix(self, prefix, limit=200):
        return [tuple(x) for x in self._op("list", prefix=prefix, limit=limit)["items"]]

    def claim_nonce(self, key, ttl_s):
        return bool(self._op("claim_nonce", key=key, ttl=ttl_s)["claimed"])

    def queue_push(self, device_id, cmd, cap=50):
        self._op("q_push", device=device_id, cmd=cmd, cap=cap)

    def queue_pending(self, device_id, now):
        return self._op("q_pending", device=device_id, now=now)["items"]

    def queue_cancel_pending(self, device_id, now, reason, keep=()):
        return self._op("q_cancel", device=device_id, now=now, reason=reason, keep=list(keep))["n"]

    def queue_ack(self, device_id, cmd_id, status, detail, now):
        return self._op("q_ack", device=device_id, id=cmd_id, status=status, detail=detail, now=now).get("cmd")

    def queue_list(self, device_id, limit=30):
        return self._op("q_list", device=device_id, limit=limit)["items"]

    def events_append(self, device_id, events):
        r = self._op("ev_append", device=device_id, events=events)
        return r["accepted"], r["duplicates"]

    def events_list(self, limit=100, device_id=None, since=None):
        return self._op("ev_list", limit=limit, device=device_id, since=since)["items"]


# --------------------------------------------------------------------------
# Rate limiter (per worker instance; complements Cloudflare edge limits)
# --------------------------------------------------------------------------
class RateLimiter:
    def __init__(self, limit, window_s, clock=time.monotonic):
        self.limit, self.window, self.clock = limit, window_s, clock
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def reset(self):
        with self._lock:
            self._hits.clear()

    def exceeded(self, key):
        now = self.clock()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return False
            while q and now - q[0] > self.window:
                q.popleft()
            return len(q) >= self.limit

    def allow(self, key):
        now = self.clock()
        with self._lock:
            if len(self._hits) > 2048:
                for k in [k for k, q in self._hits.items() if not q or now - q[-1] > self.window]:
                    self._hits.pop(k, None)
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True


def register_fleet(app, hooks):
    cfg = hooks["config"]
    master = cfg("FLEET_MASTER_SECRET", "")
    try:
        offline_after = max(5, int(cfg("DEVICE_OFFLINE_AFTER_SECONDS", str(F.OFFLINE_AFTER_SECONDS))))
    except (TypeError, ValueError):
        offline_after = F.OFFLINE_AFTER_SECONDS
    primary = str(cfg("FLEET_PRIMARY_ROVER", "ROVER-01"))

    if hooks["cloudflare"]:
        store = DOFleetStore(hooks["realtime_stub"], hooks["run_sync"])
    else:
        store = F.MemoryFleetStore()
    service = F.FleetService(store, master, offline_after=offline_after, primary_rover=primary)
    app.extensions["fleet_service"] = service

    device_limiter = RateLimiter(100, 10)      # per authenticated device (~10 req/s: heartbeat + acks + event batches)
    anon_limiter = RateLimiter(20, 60)         # per client IP: FAILED authentications only (valid devices share NATs)
    operator_limiter = RateLimiter(100, 10)    # per operator
    fail_audit_limiter = RateLimiter(1, 60)
    app.extensions["fleet_limiters"] = [device_limiter, anon_limiter, operator_limiter, fail_audit_limiter]

    require_login, require_admin = hooks["require_login"], hooks["require_admin"]
    current_user, audit = hooks["current_user"], hooks["audit"]

    def err(e: F.FleetError):
        body = {"ok": False, "error": e.message, **e.extra}
        return jsonify(body), e.status

    def store_down():
        return jsonify({"ok": False, "error": "Fleet storage temporarily unavailable"}), 503

    def signed(secret, device_id, nonce, payload, status=200):
        raw = json.dumps(payload, separators=(",", ":")).encode()
        resp = Response(raw, status=status, mimetype="application/json")
        resp.headers["X-Server-Signature"] = F.sign_response(secret, device_id, nonce, raw)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    def device_endpoint(handler):
        def wrapper():
            ip = hooks["client_ip"]() or "unknown"
            if anon_limiter.exceeded(ip):
                return jsonify({"ok": False, "error": "Too many failed authentications"}), 429
            body = request.get_data(cache=False, as_text=False)
            try:
                rec, secret, nonce = service.authenticate(request.method, request.path, request.headers, body)
            except F.FleetError as exc:
                if exc.status in (401, 409):
                    anon_limiter.allow(ip)
                if exc.status == 401 and fail_audit_limiter.allow("fail:" + ip):
                    try:
                        audit("FLEET_AUTH_FAILED", f"Rejected device request from {ip} (id={request.headers.get('X-Device-Id', '')[:40]})", None)
                    except Exception:  # noqa: BLE001
                        pass
                return err(exc)
            except F.FleetStoreError:
                return store_down()
            if not device_limiter.allow(rec["id"]):
                return jsonify({"ok": False, "error": "Device rate limit exceeded"}), 429
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
            except (UnicodeDecodeError, ValueError):
                return signed(secret, rec["id"], nonce, {"ok": False, "error": "Invalid JSON"}, 400)
            try:
                payload = handler(rec, data)
                return signed(secret, rec["id"], nonce, payload)
            except F.FleetError as exc:
                return signed(secret, rec["id"], nonce, {"ok": False, "error": exc.message, **exc.extra}, exc.status)
            except F.FleetStoreError:
                return store_down()
        wrapper.__name__ = handler.__name__ + "_route"
        return wrapper

    # -- mirror primary rover into the legacy dashboard state -----------------
    def mirror_to_dashboard(rec, st):
        if rec["role"] != "rover" or rec["id"] != primary:
            return
        state, lock = hooks["state"], hooks["lock"]
        now_iso = datetime.now(timezone.utc).isoformat()
        caps = st.get("caps", {})
        obstacle = st.get("obstacle") or {}
        front = obstacle.get("front")
        with lock:
            state["device_id"] = rec["id"]
            state["real_device_epoch"] = time.time()
            if st.get("gps_fix") and "lat" in st:
                state.update(lat=st["lat"], lon=st["lon"], gps_fix=True, gps_source="ROVER_DEVICE",
                             gps_last_epoch=time.time(), gps_source_id=rec["id"])
                if "accuracy_m" in st:
                    state["gps_accuracy_m"] = round(st["accuracy_m"], 1)
            else:
                state["gps_fix"] = False
            for src, dst in (("gps_sats", "gps_sats"), ("speed_kmh", "speed_kmh"), ("heading", "heading"),
                             ("battery", "battery"), ("signal", "signal"), ("network", "network"), ("temp_c", "temp_c")):
                if src in st:
                    state[dst] = st[src]
            if front and front.get("valid"):
                state["obstacle_cm"] = front["cm"]
            state["obstacle_valid"] = bool(front and front.get("valid"))
            if "camera" in st:
                state["camera"], state["camera_source"] = st["camera"], "ROVER_DEVICE"
            state["autonomous_navigation"] = caps.get("autonomous_navigation") is True
            state["obstacle_avoidance"] = caps.get("obstacle_avoidance") is True
            state["obstacle_sensor_healthy"] = caps.get("obstacle_sensor_healthy") is True
            state["safety_controller_healthy"] = caps.get("safety_controller_healthy") is True
            state["fleet_fsm"] = st.get("fsm")
            state["estop"] = bool(st.get("estop"))
            state["offline_autonomy"] = bool(st.get("offline_autonomy"))
            state["rtb"] = st.get("rtb")
            state["fleet_link"] = st.get("link")
            state["updated"] = state["last_seen_at"] = now_iso
            state["device_online"], state["signal_lost_at"] = True, None
        try:
            hooks["add_track"]()
            hooks["write_shared_live_state"]("rover-device")
        except Exception:  # noqa: BLE001
            pass

    # -- device endpoints -----------------------------------------------------
    def heartbeat(rec, data):
        st = service.ingest_heartbeat(rec, data)
        mirror_to_dashboard(rec, st)
        base = service.get_base()
        return {"ok": True, "server_time": time.time(), "commands": service.device_commands(rec["id"]),
                "base": ({"lat": base["lat"], "lon": base["lon"], "saved_at": base["saved_at"]} if base else None),
                "peers": service.peers_for(rec["id"])}

    def events(rec, data):
        return {"ok": True, **service.ingest_events(rec, data), "server_time": time.time()}

    def ack(rec, data):
        c = service.ack_command(rec, data)
        return {"ok": True, "status": c["status"]}

    app.add_url_rule("/api/fleet/heartbeat", "fleet_heartbeat", device_endpoint(heartbeat), methods=["POST"])
    app.add_url_rule("/api/fleet/events/upload", "fleet_events_upload", device_endpoint(events), methods=["POST"])
    app.add_url_rule("/api/fleet/commands/ack", "fleet_command_ack", device_endpoint(ack), methods=["POST"])

    # -- operator endpoints ---------------------------------------------------
    def operator_guard():
        u = current_user()
        if u and not operator_limiter.allow(u["username"]):
            return jsonify({"ok": False, "error": "Rate limit exceeded"}), 429
        return None

    @app.get("/api/fleet/state")
    @require_login
    def fleet_state():
        limited = operator_guard()
        if limited:
            return limited
        try:
            devices = service.fleet_snapshot(include_trail=True)
            return jsonify({"ok": True, "enabled": service.enabled, "server_time": time.time(), "devices": devices,
                            "base": service.get_base(), "primary": primary,
                            "offline_after_s": offline_after}) if service.enabled else \
                jsonify({"ok": True, "enabled": False, "devices": [], "base": None, "primary": primary,
                         "server_time": time.time(), "offline_after_s": offline_after})
        except F.FleetStoreError:
            return store_down()

    @app.get("/api/fleet/events")
    @require_login
    def fleet_events():
        try:
            limit = int(request.args.get("limit", 100))
        except ValueError:
            limit = 100
        device = request.args.get("device") or None
        if device and not F.DEVICE_ID_RE.match(device):
            return jsonify({"ok": False, "error": "Invalid device"}), 400
        try:
            events = service.list_events(limit, device)
            if not device:  # simulation events only show when asked for explicitly (?device=SIM-ROVER)
                events = [e for e in events if e.get("source") != "simulation"]
            return jsonify({"ok": True, "events": events})
        except F.FleetStoreError:
            return store_down()

    @app.post("/api/fleet/sim/events")
    @require_admin
    def fleet_sim_events():
        limited = operator_guard()
        if limited:
            return limited
        try:
            return jsonify({"ok": True, **service.ingest_sim_events(request.get_json(silent=True) or {}), "server_time": time.time()})
        except F.FleetError as exc:
            return err(exc)
        except F.FleetStoreError:
            return store_down()

    @app.post("/api/fleet/devices")
    @require_admin
    def fleet_register():
        data = request.get_json(silent=True) or {}
        u = current_user()
        try:
            rec, secret = service.register_device(str(data.get("id", "")).strip(), data.get("name"),
                                                  str(data.get("role", "")).strip().lower(), u["username"])
        except F.FleetError as exc:
            return err(exc)
        except F.FleetStoreError:
            return store_down()
        audit("FLEET_DEVICE_REGISTERED", f"Registered {rec['role']} device {rec['id']}", u)
        resp = jsonify({"ok": True, "device": rec, "secret": secret,
                        "notice": "Copy this device secret now. It is not stored and cannot be shown again; rotate to issue a new one."})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.post("/api/fleet/devices/<device_id>/rotate")
    @require_admin
    def fleet_rotate(device_id):
        u = current_user()
        try:
            rec, secret = service.rotate_device(F.validate_device_id(device_id), u["username"])
        except F.FleetError as exc:
            return err(exc)
        except F.FleetStoreError:
            return store_down()
        audit("FLEET_DEVICE_KEY_ROTATED", f"Rotated key for {device_id}", u)
        resp = jsonify({"ok": True, "device": rec, "secret": secret})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.delete("/api/fleet/devices/<device_id>")
    @require_admin
    def fleet_revoke(device_id):
        u = current_user()
        try:
            service.revoke_device(F.validate_device_id(device_id), u["username"])
        except F.FleetError as exc:
            return err(exc)
        except F.FleetStoreError:
            return store_down()
        audit("FLEET_DEVICE_REVOKED", f"Revoked device {device_id}", u)
        return jsonify({"ok": True})

    @app.post("/api/fleet/base")
    @require_admin
    def fleet_base():
        data = request.get_json(silent=True) or {}
        u = current_user()
        try:
            base = service.save_base(data.get("lat"), data.get("lon"), u["username"])
        except F.FleetError as exc:
            return err(exc)
        except F.FleetStoreError:
            return store_down()
        audit("FLEET_BASE_SAVED", f"Base {base['lat']:.6f},{base['lon']:.6f}", u)
        return jsonify({"ok": True, "base": base})

    @app.get("/api/fleet/base")
    @require_login
    def fleet_get_base():
        try:
            return jsonify({"ok": True, "base": service.get_base()})
        except F.FleetStoreError:
            return store_down()

    @app.post("/api/fleet/command")
    @require_login
    def fleet_command():
        limited = operator_guard()
        if limited:
            return limited
        data = request.get_json(silent=True) or {}
        u = current_user()
        try:
            device_id = F.validate_device_id(str(data.get("device_id", "")))
            cmd = service.issue_command(device_id, data.get("command"), u["username"], u.get("role") == "admin")
        except F.FleetError as exc:
            if exc.status in (403, 409):
                audit("FLEET_COMMAND_REFUSED", f"{data.get('command')} -> {data.get('device_id')}: {exc.message} {exc.extra.get('reasons', '')}", u)
            return err(exc)
        except F.FleetStoreError:
            return store_down()
        audit("FLEET_COMMAND", f"{cmd['command']} -> {device_id}", u)
        return jsonify({"ok": True, "command": {k: cmd[k] for k in ("id", "command", "device_id", "ttl_ms", "status")}})

    @app.get("/api/fleet/commands")
    @require_login
    def fleet_commands():
        device = str(request.args.get("device_id", ""))
        if not F.DEVICE_ID_RE.match(device):
            return jsonify({"ok": False, "error": "Invalid device"}), 400
        try:
            return jsonify({"ok": True, "commands": service.store.queue_list(device)})
        except F.FleetStoreError:
            return store_down()

    return service
