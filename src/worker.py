import json
import base64
import hashlib
import hmac
from urllib.parse import urlparse
import uuid
import time
import js
from js import WebSocketPair, WebSocketRequestResponsePair, fetch as js_fetch
from workers import DurableObject, Response, WorkerEntrypoint, wsgi
from werkzeug.security import check_password_hash

from fleet_do import FleetDOLogic
from app import app, LEGACY_AUTH_ENABLED, LEGACY_AUTH_URL, SESSION_SECRET, ADMIN_USERNAME, runtime_users, runtime_password_hashes, safe_check_password_hash


class RealtimeHub(DurableObject):
    """Single authoritative live-state hub for DEFENX.

    It stores the latest telemetry/control snapshot and owns the hibernatable
    WebSocket connections so every connected dashboard sees the same state.
    """

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.ctx = ctx
        self.env = env
        self.sessions = {}

        for ws in self.ctx.getWebSockets():
            attachment = ws.deserializeAttachment() or {}
            session_id = attachment.get("id")
            if session_id:
                self.sessions[session_id] = ws

        self.ctx.setWebSocketAutoResponse(
            WebSocketRequestResponsePair.new("ping", "pong")
        )

    async def get_state(self):
        state = await self.ctx.storage.get("state")
        return state if isinstance(state, dict) else None

    async def revoke_session(self, session_hash, expires_at):
        """Persist logout revocation; never evict an unexpired revocation."""
        session_hash = str(session_hash or "")
        if len(session_hash) != 64 or any(ch not in "0123456789abcdef" for ch in session_hash):
            return False
        now = int(time.time())
        try:
            expires_at = int(expires_at)
        except (TypeError, ValueError):
            return False
        if expires_at <= now:
            return False
        sessions = await self.ctx.storage.get("revoked_sessions")
        if not isinstance(sessions, dict):
            sessions = {}
        sessions = {
            key: int(expiry) for key, expiry in sessions.items()
            if str(expiry).isdigit() and int(expiry) > now
        }
        if session_hash not in sessions and len(sessions) >= 4096:
            return False
        sessions[session_hash] = expires_at
        await self.ctx.storage.put("revoked_sessions", sessions)
        return True

    async def is_session_revoked(self, session_hash, now=None):
        session_hash = str(session_hash or "")
        if len(session_hash) != 64 or any(ch not in "0123456789abcdef" for ch in session_hash):
            return False
        now = int(now or time.time())
        sessions = await self.ctx.storage.get("revoked_sessions")
        if not isinstance(sessions, dict):
            return False
        expiry = sessions.get(session_hash)
        if expiry is None:
            return False
        try:
            if int(expiry) > now:
                return True
        except (TypeError, ValueError):
            pass
        sessions.pop(session_hash, None)
        await self.ctx.storage.put("revoked_sessions", sessions)
        return False

    async def append_login_event(self, event):
        if not isinstance(event, dict):
            return False
        events = await self.ctx.storage.get("login_events")
        if not isinstance(events, list):
            events = []
        now = int(time.time())
        retained = []
        for item in events:
            try:
                expires = int(item.get("expires_at") or 0)
                if not expires:
                    from datetime import datetime
                    stamp = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00"))
                    expires = int(stamp.timestamp()) + 7 * 24 * 60 * 60
                if expires > now:
                    retained.append(item)
            except (TypeError, ValueError, OverflowError):
                continue
        retained.insert(0, event)
        # Keep the complete seven-day event window; cap only pathological volumes.
        await self.ctx.storage.put("login_events", retained[:5000])
        return True

    async def get_login_events(self, limit=100):
        try:
            safe_limit = min(max(int(limit), 1), 5000)
        except (TypeError, ValueError):
            safe_limit = 100
        events = await self.ctx.storage.get("login_events")
        if not isinstance(events, list):
            return []
        now = int(time.time())
        retained = []
        for item in events:
            if not isinstance(item, dict):
                continue
            try:
                expires = int(item.get("expires_at") or 0)
                if not expires:
                    from datetime import datetime
                    stamp = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00"))
                    expires = int(stamp.timestamp()) + 7 * 24 * 60 * 60
                if expires > now:
                    retained.append(item)
            except (TypeError, ValueError, OverflowError):
                continue
        if len(retained) != len(events):
            await self.ctx.storage.put("login_events", retained[:5000])
        return retained[:safe_limit]

    async def face_enrollment_op(self, request_json):
        """Store only AES-GCM ciphertext for administrator face enrollments."""
        try:
            request = json.loads(request_json) if isinstance(request_json, str) else request_json
        except Exception:
            return {"ok": False, "error": "bad_request"}
        if not isinstance(request, dict):
            return {"ok": False, "error": "bad_request"}
        operation = str(request.get("op") or "")
        rows = await self.ctx.storage.get("face_enrollments")
        if not isinstance(rows, list):
            rows = []
        rows = [row for row in rows if isinstance(row, dict)]
        if operation == "list":
            return {"ok": True, "enrollments": rows}
        if operation == "add":
            enrollment = request.get("enrollment")
            if not isinstance(enrollment, dict):
                return {"ok": False, "error": "bad_request"}
            ident = str(enrollment.get("id") or "")
            blob = enrollment.get("blob")
            if (len(ident) != 36 or not isinstance(blob, str)
                    or not blob.startswith("a256gcm.v1.") or len(blob) > 40000):
                return {"ok": False, "error": "bad_request"}
            if any(row.get("id") == ident for row in rows):
                return {"ok": False, "error": "duplicate"}
            if len(rows) >= 50:
                return {"ok": False, "error": "enrollment_limit"}
            rows.append({
                "id": ident,
                "blob": blob,
                "created_at": str(enrollment.get("created_at") or "")[:40],
                "created_by": str(enrollment.get("created_by") or "")[:64],
            })
            await self.ctx.storage.put("face_enrollments", rows)
            self._broadcast({"type": "face_profiles_changed", "operation": "added", "profile_id": ident})
            return {"ok": True, "id": ident}
        if operation == "get":
            ident = str(request.get("id") or "")
            row = next((item for item in rows if item.get("id") == ident), None)
            return {"ok": True, "enrollment": row} if row else {"ok": False, "error": "not_found"}
        if operation == "delete":
            ident = str(request.get("id") or "")
            retained = [row for row in rows if row.get("id") != ident]
            if len(retained) == len(rows):
                return {"ok": False, "error": "not_found"}
            await self.ctx.storage.put("face_enrollments", retained)
            self._broadcast({"type": "face_profiles_changed", "operation": "deleted", "profile_id": ident})
            return {"ok": True, "id": ident}
        return {"ok": False, "error": "bad_request"}

    async def fleet_op(self, request_json):
        """Device-fleet persistence (registry, status, replay table, command queue, events).

        Logic lives in fleet_do.FleetDOLogic so it is unit-tested with a fake storage.
        Durable Object input gates serialise storage read-modify-write sequences."""
        return await FleetDOLogic(self.ctx.storage).handle(request_json)

    async def set_last_known_loss(self, loss_event):
        if not isinstance(loss_event, dict):
            return False
        await self.ctx.storage.put("last_known_loss", loss_event)
        return True

    async def get_last_known_loss(self, device_code="ROVER-01"):
        value = await self.ctx.storage.get("last_known_loss")
        if not isinstance(value, dict):
            return None
        if str(value.get("device_id") or "ROVER-01") != str(device_code or "ROVER-01"):
            return None
        return value

    async def clear_last_known_loss(self, device_code="ROVER-01"):
        value = await self.ctx.storage.get("last_known_loss")
        if isinstance(value, dict) and str(value.get("device_id") or "ROVER-01") == str(device_code or "ROVER-01"):
            await self.ctx.storage.delete("last_known_loss")
        return True

    async def set_state(self, payload):
        if not isinstance(payload, dict):
            return False
        await self.ctx.storage.put("state", payload)
        self._broadcast({"type": "state", "telemetry": payload, "source": "sync"})
        return True

    def _broadcast(self, payload):
        message = json.dumps(payload, separators=(",", ":"))
        for ws in self.ctx.getWebSockets():
            try:
                ws.send(message)
            except Exception:
                pass

    async def fetch(self, request):
        upgrade = str(request.headers.get("Upgrade") or "").lower()
        if upgrade != "websocket":
            return Response("Expected WebSocket", status=426)

        # Physical/browser devices obtain a short-lived, single-use ticket through
        # the signed fleet API. The ticket is stored as a hash and bound to the
        # current key version, so revoke/rotate immediately invalidates it.
        query = str(request.url).split("?", 1)[1] if "?" in str(request.url) else ""
        params = {}
        for part in query.split("&"):
            key, sep, value = part.partition("=")
            if sep:
                params[key] = value
        device_ticket = params.get("device_ticket", "")
        attachment = None
        if device_ticket:
            try:
                ticket_hash = hashlib.sha256(device_ticket.encode("ascii")).hexdigest()
                result = await self.fleet_op(json.dumps({
                    "op": "ws_ticket_consume", "ticket_hash": ticket_hash,
                }, separators=(",", ":")))
                if hasattr(result, "to_py"):
                    result = result.to_py()
                if not isinstance(result, dict) or result.get("ok") is not True:
                    return Response("Device ticket invalid or expired", status=401)
                attachment = {
                    "kind": "device", "device_id": str(result.get("device_id") or ""),
                    "key_version": int(result.get("key_version") or 0),
                }
            except Exception:
                return Response("Device ticket invalid or expired", status=401)

        if attachment is None:
            cookie = str(request.headers.get("Cookie") or "")
            if not cookie:
                return Response("Authentication required", status=401)

            # Validate the signed Flask session before exposing live telemetry.
            try:
                from app import app
                session_cookie = None
                for part in cookie.split(";"):
                    name, sep, value = part.strip().partition("=")
                    if name == app.config.get("SESSION_COOKIE_NAME", "session") and sep:
                        session_cookie = value
                        break
                if not session_cookie:
                    return Response("Authentication required", status=401)
                serializer = app.session_interface.get_signing_serializer(app)
                if serializer is None:
                    return Response("Authentication service unavailable", status=503)
                try:
                    serializer.loads(session_cookie, max_age=int(app.permanent_session_lifetime.total_seconds()))
                except Exception:
                    return Response("Authentication required", status=401)
                session_hash = hashlib.sha256(session_cookie.encode("utf-8")).hexdigest()
                if await self.is_session_revoked(session_hash):
                    return Response("Authentication required", status=401)
                attachment = {"kind": "operator", "cookie": cookie}
            except Exception:
                return Response("Authentication service unavailable", status=503)

        client, server = WebSocketPair.new().object_values()
        self.ctx.acceptWebSocket(server)
        session_id = str(uuid.uuid4())
        attachment["id"] = session_id
        server.serializeAttachment(attachment)
        self.sessions[session_id] = server

        if attachment.get("kind") == "device":
            server.send(json.dumps({"type": "connected", "realtime": True, "device_id": attachment["device_id"]}))
        else:
            server.send(json.dumps({"type": "connected", "realtime": True}))
            state = await self.get_state()
            if state:
                server.send(json.dumps({
                    "type": "state", "telemetry": state, "source": "initial"
                }, separators=(",", ":")))
        return Response(None, status=101, web_socket=client)

    async def _device_websocket_message(self, ws, data, attachment):
        if str(data.get("type") or "") == "ping":
            ws.send(json.dumps({"type": "pong", "t": data.get("t")}))
            return
        if str(data.get("type") or "") != "device_request":
            return
        device_id = str(attachment.get("device_id") or "")
        path = str(data.get("path") or "")
        if path not in {"/api/fleet/heartbeat", "/api/fleet/events/upload", "/api/fleet/commands/ack"}:
            ws.send(json.dumps({"type": "device_error", "error": "Request path not allowed"}))
            return
        body = data.get("body")
        ts, nonce, signature = (str(data.get(k) or "") for k in ("timestamp", "nonce", "signature"))
        if not isinstance(body, str) or len(body.encode("utf-8")) > 32768:
            ws.send(json.dumps({"type": "device_error", "error": "Request body invalid"}))
            return
        try:
            request = js.Request.new(
                "https://defenx.internal" + path,
                {
                    "method": "POST",
                    "headers": {
                        "Content-Type": "application/json",
                        "X-Device-Id": device_id,
                        "X-Timestamp": ts,
                        "X-Nonce": nonce,
                        "X-Signature": signature,
                    },
                    "body": body,
                },
            )
            response = await self.ctx.exports.Default.fetch(request)
            response_body = str(await response.text())
            server_signature = str(response.headers.get("X-Server-Signature") or "")
            ws.send(json.dumps({
                "type": "device_response", "nonce": nonce,
                "status": int(response.status), "body": response_body,
                "signature": server_signature,
            }, separators=(",", ":")))
            if int(response.status) == 200 and path == "/api/fleet/events/upload":
                self._broadcast_device_sync(device_id)
        except Exception:
            ws.send(json.dumps({"type": "device_error", "error": "Device synchronization temporarily unavailable"}))

    def _broadcast_device_sync(self, source_device):
        payload = json.dumps({"type": "fleet_sync", "source_device": source_device}, separators=(",", ":"))
        for socket in self.ctx.getWebSockets():
            try:
                info = socket.deserializeAttachment() or {}
                if info.get("kind") == "device" and info.get("device_id") != source_device:
                    socket.send(payload)
            except Exception:
                pass

    def _rtc_broadcast(self, payload, exclude_peer=None, target_peer=None):
        message = json.dumps(payload, separators=(",", ":"))
        for socket in self.ctx.getWebSockets():
            try:
                info = socket.deserializeAttachment() or {}
                peer_id = str(info.get("rtc_peer_id") or "")
                if info.get("rtc_room") != "defenx-global" or not peer_id:
                    continue
                if exclude_peer and peer_id == exclude_peer:
                    continue
                if target_peer and peer_id != target_peer:
                    continue
                socket.send(message)
            except Exception:
                pass

    def _handle_rtc_message(self, ws, data, attachment):
        action = str(data.get("type") or "").lower()
        peer_id = str(attachment.get("rtc_peer_id") or "")
        if action == "rtc_join":
            requested = str(data.get("peer_id") or "")
            if len(requested) < 16 or len(requested) > 64 or not all(
                ch.isalnum() or ch in "_-" for ch in requested
            ):
                ws.send(json.dumps({"type": "rtc_error", "error": "Invalid camera peer ID"}))
                return
            attachment["rtc_peer_id"] = requested
            attachment["rtc_room"] = "defenx-global"
            attachment["rtc_camera"] = False
            ws.serializeAttachment(attachment)
            peers = []
            for socket in self.ctx.getWebSockets():
                try:
                    info = socket.deserializeAttachment() or {}
                    other_id = str(info.get("rtc_peer_id") or "")
                    if info.get("rtc_room") == "defenx-global" and other_id and other_id != requested:
                        peers.append({"id": other_id, "camera": bool(info.get("rtc_camera"))})
                except Exception:
                    pass
            ws.send(json.dumps({"type": "rtc_peer_list", "peers": peers}, separators=(",", ":")))
            self._rtc_broadcast(
                {"type": "rtc_peer_joined", "peer": {"id": requested, "camera": False}},
                exclude_peer=requested,
            )
            return

        if not peer_id or attachment.get("rtc_room") != "defenx-global":
            ws.send(json.dumps({"type": "rtc_error", "error": "Join camera room first"}))
            return

        if action == "rtc_camera":
            active = bool(data.get("active"))
            attachment["rtc_camera"] = active
            ws.serializeAttachment(attachment)
            self._rtc_broadcast({
                "type": "rtc_camera",
                "peer_id": peer_id,
                "active": active,
            }, exclude_peer=peer_id)
            return

        if action == "rtc_signal":
            target = str(data.get("target") or "")
            signal = data.get("signal")
            if (not target or target == peer_id or not isinstance(signal, dict)
                    or str(signal.get("type") or "") not in {"offer", "answer", "ice"}
                    or len(json.dumps(signal, separators=(",", ":"))) > 64000):
                ws.send(json.dumps({"type": "rtc_error", "error": "Invalid camera signaling message"}))
                return
            self._rtc_broadcast({
                "type": "rtc_signal",
                "from": peer_id,
                "signal": signal,
            }, target_peer=target)
            return

    async def webSocketMessage(self, ws, message):
        attachment = ws.deserializeAttachment() or {}
        if attachment.get("kind") == "device":
            try:
                data = json.loads(str(message))
            except Exception:
                ws.send(json.dumps({"type": "device_error", "error": "Invalid message"}))
                return
            await self._device_websocket_message(ws, data, attachment)
            return
        cookie = str(attachment.get("cookie") or "")

        try:
            data = json.loads(str(message))
        except Exception:
            ws.send(json.dumps({"type": "error", "error": "Invalid message"}))
            return

        action = str(data.get("type") or "").lower()
        if action == "ping":
            ws.send(json.dumps({"type": "pong", "t": data.get("t")}))
            return
        if action in {"rtc_join", "rtc_camera", "rtc_signal"}:
            if not cookie:
                ws.send(json.dumps({"type": "rtc_error", "error": "Authentication required"}))
                return
            try:
                auth_request = js.Request.new(
                    "https://defenx.internal/api/me",
                    {"method": "GET", "headers": {"Cookie": cookie, "Accept": "application/json"}},
                )
                auth_response = await self.ctx.exports.Default.fetch(auth_request)
                if int(auth_response.status) >= 400:
                    ws.send(json.dumps({"type": "rtc_error", "error": "Authentication expired"}))
                    return
            except Exception:
                ws.send(json.dumps({"type": "rtc_error", "error": "Camera authorization unavailable"}))
                return
            self._handle_rtc_message(ws, data, attachment)
            return
        if action not in {"command", "mode"}:
            return
        if not cookie:
            ws.send(json.dumps({"type": "command-error", "error": "Authentication required"}))
            return

        # Re-check the session before each state-changing WebSocket command so
        # logging out or invalidating the session immediately removes control.
        try:
            js = __import__("js")
            auth_request = js.Request.new(
                "https://defenx.internal/api/me",
                {
                    "method": "GET",
                    "headers": {"Cookie": cookie, "Accept": "application/json"},
                },
            )
            auth_response = await self.ctx.exports.Default.fetch(auth_request)
            if int(auth_response.status) >= 400:
                ws.send(json.dumps({"type": "command-error", "error": "Authentication expired"}))
                return
        except Exception:
            ws.send(json.dumps({"type": "command-error", "error": "Authentication service unavailable"}))
            return

        path = "/api/command" if action == "command" else "/api/mode"
        body = (
            {"command": str(data.get("command") or "STOP").upper()}
            if action == "command"
            else {"mode": str(data.get("mode") or "MANUAL").upper()}
        )

        # Loop back into the same Worker/Flask API. This keeps authorization,
        # audit logging and command validation in the existing application.
        try:
            request = __import__("js").Request.new(
                "https://defenx.internal" + path,
                {
                    "method": "POST",
                    "headers": {
                        "Cookie": cookie,
                        "Content-Type": "application/json",
                    },
                    "body": json.dumps(body),
                },
            )
            response = await self.ctx.exports.Default.fetch(request)
            result = json.loads(await response.text())
        except Exception:
            ws.send(json.dumps({
                "type": "command-error",
                "error": "Realtime command service unavailable"
            }))
            return

        if int(response.status) >= 400:
            ws.send(json.dumps({
                "type": "command-error",
                "error": result.get("error") or "Rejected"
            }))
            return

        if result.get("telemetry"):
            await self.set_state(result["telemetry"])

        self._broadcast({
            "type": "camera-command",
            "command": body.get("command"),
            "source": "instant"
        }) if action == "command" else None

        ws.send(json.dumps({
            "type": "ack",
            "action": action,
            "value": body.get("command") or body.get("mode")
        }))

    async def webSocketClose(self, ws, code, reason, wasClean):
        attachment = ws.deserializeAttachment() or {}
        session_id = attachment.get("id")
        peer_id = str(attachment.get("rtc_peer_id") or "")
        if peer_id:
            self._rtc_broadcast({"type": "rtc_peer_left", "peer_id": peer_id}, exclude_peer=peer_id)
        if session_id:
            self.sessions.pop(session_id, None)
        try:
            ws.close(code, reason)
        except Exception:
            pass


class Default(WorkerEntrypoint):
    """Cloudflare entrypoint.

    Authentication is handled here because Cloudflare's Worker Fetch API is
    asynchronous. This prevents Flask's synchronous WSGI handler from trying
    to block on a JavaScript Fetch promise, which causes Worker error 1101.
    """

    @staticmethod
    def _env_value(env, name, default=""):
        try:
            value = getattr(env, name)
            return str(value if value is not None else default)
        except Exception:
            return default

    @staticmethod
    def _normalize_login(value):
        return "".join(ch for ch in str(value or "").upper() if ch.isalnum())

    def _configure_app_secret(self):
        """Synchronize Flask's signing key with the live Worker bindings."""
        secret = self._env_value(self.env, "SESSION_SECRET")
        if not secret:
            seed = (
                self._env_value(self.env, "ROVER_DEVICE_TOKEN")
                or self._env_value(self.env, "ADMIN_PASSWORD")
                or self._env_value(self.env, "ADMIN_PASSWORD_HASH")
                or self._env_value(self.env, "FRIEND_MAHANTESH_PASSWORD_HASH")
                or self._env_value(self.env, "FRIEND_DHANUSH_PASSWORD_HASH")
                or self._env_value(self.env, "FRIEND_ANIRUDH_PASSWORD_HASH")
                or self._env_value(self.env, "FRIEND4_PASSWORD_HASH")
            )
            if seed:
                secret = "defenx-session-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()
        if secret:
            app.secret_key = secret
            return True
        return False

    @staticmethod
    def _make_user(username, role, display_name=None, can_manage_users=False, user_id=None):
        username = str(username or "").strip().upper()
        role = str(role or "user").strip().lower()
        return {
            "id": str(user_id or f"local-{username.lower()}"),
            "username": username,
            "display_name": str(display_name or username)[:120],
            "role": role,
            "enabled": True,
            "can_control": True,
            "can_manage_users": bool(can_manage_users),
            "created_at": None,
            "last_login_at": None,
        }

    def _local_authenticate(self, env, username, password):
        key = self._normalize_login(username)
        database_configured = bool(self._env_value(env, "DATABASE_URL"))
        if not database_configured:
            try:
                database_configured = getattr(env, "HYPERDRIVE", None) is not None
            except Exception:
                database_configured = False
        admin_name = self._env_value(env, "ADMIN_USERNAME", ADMIN_USERNAME).strip().upper() or "ADMIN"
        admin_password = self._env_value(env, "ADMIN_PASSWORD")
        admin_hash = self._env_value(env, "ADMIN_PASSWORD_HASH")
        admin_aliases = {
            self._normalize_login(admin_name), "ADMIN", "ADMIN-1", "ADMINISTRATOR",
            "DEFENXADMIN", "DEFENXADMINISTRATOR", "ROVERADMIN", "ROVERADMINISTRATOR",
            "ADMINUSER", "ADMINUSERID",
        }
        if not database_configured and key in admin_aliases:
            valid = bool(admin_password) and hmac.compare_digest(password, admin_password)
            if not valid and admin_hash:
                try:
                    valid = check_password_hash(admin_hash, password)
                except Exception:
                    valid = False
            if valid:
                return self._make_user(
                    admin_name, "admin", "ROVER Administrator",
                    can_manage_users=True, user_id="env-admin"
                )
        # DEFENX is admin-only: environment-configured friend credentials and
        # database-managed regular-user accounts are intentionally not accepted.
        return None

    async def _legacy_authenticate(self, username, password):
        if not LEGACY_AUTH_ENABLED or not LEGACY_AUTH_URL:
            return None
        try:
            from pyodide.ffi import to_js
            legacy_headers = js.Object.fromEntries(to_js({
                "Content-Type": "application/json",
                "Accept": "application/json",
            }))
            legacy_payload = json.dumps({
                "username": str(username or "").strip(),
                "password": str(password or ""),
            })

            # Pyodide does not automatically turn a Python dict into a plain
            # JavaScript object when passed as fetch init options. Convert the
            # headers explicitly and pass the remaining options as keywords.
            # Otherwise this branch can terminate the Worker with error 1101.
            fetch_options = {
                "method": "POST",
                "headers": legacy_headers,
                "body": legacy_payload,
            }
            try:
                fetch_options["signal"] = js.AbortSignal.timeout(5000)
            except BaseException:
                pass
            response = await js_fetch(
                LEGACY_AUTH_URL,
                method=fetch_options["method"],
                headers=fetch_options["headers"],
                body=fetch_options["body"],
                signal=fetch_options.get("signal"),
            )
            raw = await response.text()
            data = json.loads(str(raw or "{}"))
            status = int(response.status)
            if status in {401, 403}:
                # The legacy service explicitly rejected the credentials.
                return None
            if status < 200 or status >= 300:
                print(f"DEFENX legacy login service returned HTTP {status}")
                return {"_auth_unavailable": True}
            user = data.get("user") if isinstance(data, dict) else None
            if not data.get("ok") or not isinstance(user, dict):
                return None
            username_value = str(user.get("username") or "").strip().upper()
            role = str(user.get("role") or "user").strip().lower()
            configured_admin = self._env_value(self.env, "ADMIN_USERNAME", ADMIN_USERNAME).strip().upper() or "ADMIN"
            if not username_value or role != "admin" or self._normalize_login(username_value) != self._normalize_login(configured_admin):
                return None
            return {
                "id": str(user.get("id") or f"legacy-{username_value.lower()}"),
                "username": username_value,
                "display_name": str(user.get("display_name") or username_value)[:120],
                "role": role,
                "enabled": bool(user.get("enabled", True)),
                "can_control": bool(user.get("can_control", True)),
                "can_manage_users": bool(user.get("can_manage_users", False)),
                "created_at": user.get("created_at"),
                "last_login_at": None,
            }
        except BaseException as exc:
            # JavaScript Fetch/Promise failures can cross the Pyodide boundary
            # as non-Exception BaseException subclasses. Fail closed so a
            # recognized username cannot crash the entire Worker request.
            print(f"DEFENX legacy login fetch failed: {type(exc).__name__}")
            return {"_auth_unavailable": True}

    @staticmethod
    def _session_cookie(user, auth_source="environment"):
        serializer = app.session_interface.get_signing_serializer(app)
        if serializer is None:
            return None
        # Flask's request guard uses these fields to decide whether to validate
        # a DB session version or accept a trusted legacy-provider session.
        session_data = {
            "fallback_user": user,
            "user_cache": user,
            "auth_source": auth_source,
            "auth_version": int(user.get("auth_version", 0)),
            "audit_session_id": str(uuid.uuid4()),
            "dashboard_entry": True,
        }
        return serializer.dumps(session_data)

    @staticmethod
    def _session_cookie_from_request(request):
        cookie_name = str(app.config.get("SESSION_COOKIE_NAME", "session"))
        for part in str(request.headers.get("Cookie") or "").split(";"):
            name, sep, value = part.strip().partition("=")
            if name == cookie_name and sep and value:
                return value
        return None

    @staticmethod
    def _valid_session_cookie(cookie):
        if not cookie:
            return False
        try:
            serializer = app.session_interface.get_signing_serializer(app)
            if serializer is None:
                return False
            serializer.loads(cookie, max_age=int(app.permanent_session_lifetime.total_seconds()))
            return True
        except Exception:
            return False

    @staticmethod
    def _needs_revocation_check(path):
        if path in {"/", "/index.html"}:
            return True
        return path.startswith("/api/") and path not in {
            "/api/login", "/api/ping", "/api/health", "/api/logout"
        }

    async def _login_edge_rate_limited(self, request):
        """Use Cloudflare's shared rate-limit binding in addition to local throttling."""
        try:
            limiter = self.env.LOGIN_RATE_LIMITER
            ip = str(request.headers.get("CF-Connecting-IP") or "unknown")
            result = await limiter.limit({"key": ip})
            return not bool(result.success)
        except Exception as exc:
            # Keep the app available in local/test runtimes without this binding;
            # production config declares it and the Flask limiter remains a fallback.
            print(f"DEFENX edge login limiter unavailable: {type(exc).__name__}")
            return False

    async def _record_auth_event(self, user, action, session_id, request, details):
        """Write Worker-authenticated sessions directly to the shared Durable Object."""
        if not isinstance(user, dict) or action not in {"LOGIN", "LOGOUT"} or not session_id:
            return False
        now = int(time.time())
        event = {
            "id": f"worker-{now}-{uuid.uuid4().hex}",
            "username": str(user.get("username") or "UNKNOWN"),
            "display_name": str(user.get("display_name") or user.get("username") or "UNKNOWN"),
            "role": str(user.get("role") or "user"),
            "action": action,
            "details": details,
            "session_id": str(session_id),
            "ip_address": str(request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or "")[:120],
            "user_agent": str(request.headers.get("User-Agent") or "")[:500],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "expires_at": now + 7 * 24 * 60 * 60,
        }
        try:
            hub = self.env.REALTIME_HUB.getByName("defenx-global")
            return bool(await hub.append_login_event(event))
        except BaseException as exc:
            print(f"DEFENX {action.lower()} audit write failed: {type(exc).__name__}")
            return False

    def _login_response(self, user, auth_source="environment"):
        # Use the same response constructor for both error and success paths.
        # This avoids runtime differences in Response.json() when Set-Cookie
        # is present, which could otherwise turn a successful login into HTTP 500.
        if not user:
            body = {
                "ok": False,
                "error": "Invalid login ID or password.",
                "field": "username",
            }
            return Response(
                json.dumps(body, separators=(",", ":")),
                status=401,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            )

        try:
            cookie = self._session_cookie(user, auth_source=auth_source)
        except Exception as exc:
            print(f"DEFENX session creation failed: {type(exc).__name__}")
            cookie = None
        if not cookie:
            return Response(
                json.dumps({
                    "ok": False,
                    "error": "Authentication service unavailable.",
                }, separators=(",", ":")),
                status=503,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            )

        secure = self._env_value(self.env, "COOKIE_SECURE", "1") != "0"
        secure_flag = "; Secure" if secure else ""
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Set-Cookie": (
                f"rover_session={cookie}; Max-Age=43200; Path=/; "
                f"HttpOnly; SameSite=Lax{secure_flag}"
            ),
        }
        body = {"ok": True, "user": user, "db_connected": False}
        return Response(
            json.dumps(body, separators=(",", ":")),
            status=200,
            headers=headers,
        )

    async def _handle_login(self, request):
        try:
            fallback_request = request.clone()
        except Exception:
            fallback_request = None
        try:
            try:
                data = json.loads(str(await request.text() or "{}"))
            except Exception:
                data = {}
            username = str(data.get("username") or "").strip()
            password = str(data.get("password") or "")
            if not username or not password:
                return Response(
                    json.dumps({"ok": False, "error": "Enter login ID and password."}),
                    status=400,
                    headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
                )

            admin_name = self._env_value(self.env, "ADMIN_USERNAME", ADMIN_USERNAME).strip().upper() or "ADMIN"
            admin_aliases = {
                self._normalize_login(admin_name), "ADMIN", "ADMIN-1", "ADMINISTRATOR",
                "DEFENXADMIN", "DEFENXADMINISTRATOR", "ROVERADMIN", "ROVERADMINISTRATOR",
                "ADMINUSER", "ADMINUSERID",
            }
            if self._normalize_login(username) not in admin_aliases:
                return self._login_response(None)

            user = self._local_authenticate(self.env, username, password)
            if user:
                response = self._login_response(user)
                if int(response.status) == 200:
                    try:
                        cookie_header = str(response.headers.get("Set-Cookie") or "")
                        cookie_value = cookie_header.split(";", 1)[0].split("=", 1)[1]
                        serializer = app.session_interface.get_signing_serializer(app)
                        session_data = serializer.loads(cookie_value)
                        await self._record_auth_event(
                            user, "LOGIN", session_data.get("audit_session_id"), request,
                            "Successful login"
                        )
                    except BaseException as exc:
                        print(f"DEFENX login audit setup failed: {type(exc).__name__}")
                return response

            # Local/DB authentication gets priority over the optional legacy
            # provider so old passwords cannot bypass a local reset.
            if fallback_request is None:
                return Response(
                    json.dumps({
                        "ok": False,
                        "error": "Authentication service temporarily unavailable. Please try again.",
                    }, separators=(",", ":")),
                    status=503,
                    headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                )
            fallback_response = await wsgi.fetch(app, fallback_request, self.env)
            if int(fallback_response.status) != 401:
                return fallback_response
            try:
                local_error = json.loads(str(await fallback_response.clone().text() or "{}"))
            except Exception:
                local_error = {}
            if local_error.get("field") != "username":
                return fallback_response

            legacy_user = await self._legacy_authenticate(username, password)
            if legacy_user:
                if legacy_user.get("_auth_unavailable"):
                    return Response(
                        json.dumps({
                            "ok": False,
                            "error": "Authentication service temporarily unavailable. Please try again.",
                        }, separators=(",", ":")),
                        status=503,
                        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                    )
                response = self._login_response(legacy_user, auth_source="legacy")
                if int(response.status) == 200:
                    try:
                        cookie_header = str(response.headers.get("Set-Cookie") or "")
                        cookie_value = cookie_header.split(";", 1)[0].split("=", 1)[1]
                        serializer = app.session_interface.get_signing_serializer(app)
                        session_data = serializer.loads(cookie_value)
                        await self._record_auth_event(
                            legacy_user, "LOGIN", session_data.get("audit_session_id"), request,
                            "Successful login"
                        )
                    except BaseException as exc:
                        print(f"DEFENX legacy login audit setup failed: {type(exc).__name__}")
                return response
            return fallback_response
        except BaseException as exc:
            print(f"DEFENX login handler recovered from {type(exc).__name__}")
            return Response(
                json.dumps({
                    "ok": False,
                    "error": "Authentication service temporarily unavailable. Please try again.",
                }, separators=(",", ":")),
                status=503,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                },
            )

    async def fetch(self, request):
        # Parse the route first, then guard Worker-level setup as well as the
        # handler. A failure before _handle_login starts must not leak through
        # as an opaque platform HTTP 500.
        url = urlparse(request.url)
        try:
            self._configure_app_secret()

            # Signed Flask cookies are stateless; revoke them in Durable Object
            # storage so copied cookies and existing WebSockets stop working after logout.
            session_cookie = self._session_cookie_from_request(request)
            valid_session_cookie = self._valid_session_cookie(session_cookie)
            session_hash = (
                hashlib.sha256(session_cookie.encode("utf-8")).hexdigest()
                if valid_session_cookie else None
            )
            if session_hash and url.path == "/api/logout" and str(request.method).upper() == "POST":
                hub = self.env.REALTIME_HUB.getByName("defenx-global")
                revoked = await hub.revoke_session(session_hash, int(time.time()) + 43200)
                if not revoked:
                    return Response(
                        json.dumps({"ok": False, "error": "Secure logout is temporarily unavailable. Please retry."}),
                        status=503,
                        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                    )
            elif session_hash and self._needs_revocation_check(url.path):
                hub = self.env.REALTIME_HUB.getByName("defenx-global")
                try:
                    revoked = await hub.is_session_revoked(session_hash, int(time.time()))
                except BaseException:
                    return Response(
                        json.dumps({"ok": False, "error": "Session security check unavailable. Please retry."}),
                        status=503,
                        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                    )
                if revoked:
                    return Response(
                        json.dumps({"ok": False, "error": "Session expired. Please sign in again."}),
                        status=401,
                        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
                    )

            if url.path == "/api/ws":
                upgrade = str(request.headers.get("Upgrade") or "").lower()
                if upgrade != "websocket":
                    return Response("Expected WebSocket", status=426)
                stub = self.env.REALTIME_HUB.getByName("defenx-global")
                return await stub.fetch(request)

            if url.path == "/api/login" and str(request.method).upper() == "POST":
                if await self._login_edge_rate_limited(request):
                    return Response(
                        json.dumps({"ok": False, "error": "Too many login attempts. Please wait before trying again."}),
                        status=429,
                        headers={
                            "Content-Type": "application/json; charset=utf-8",
                            "Cache-Control": "no-store",
                            "Retry-After": "60",
                        },
                    )
                return await self._handle_login(request)

            # Route dashboard requests through Flask so its session gate protects
            # the normal dashboard while explicitly requested demo=1 remains read-only.
            # The Flask asset helper still serves static files with the correct headers.


            return await wsgi.fetch(app, request, self.env)
        except BaseException as exc:
            # Treat errors crossing the Worker/Pyodide boundary as request
            # failures too, rather than letting them escape as platform HTTP 500.
            print(f"DEFENX Worker fetch recovered from {type(exc).__name__}")
            if url.path == "/api/login":
                return Response(
                    json.dumps({
                        "ok": False,
                        "error": "Authentication service temporarily unavailable. Please try again.",
                    }, separators=(",", ":")),
                    status=503,
                    headers={
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store",
                    },
                )
            raise
