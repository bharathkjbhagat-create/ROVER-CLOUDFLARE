import json
import base64
import hashlib
import hmac
from urllib.parse import urlparse
import uuid
import js
from js import WebSocketPair, WebSocketRequestResponsePair, fetch as js_fetch
from workers import DurableObject, Response, WorkerEntrypoint, wsgi
from werkzeug.security import check_password_hash

from app import app, LEGACY_AUTH_ENABLED, LEGACY_AUTH_URL, SESSION_SECRET, ADMIN_USERNAME


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

    async def append_login_event(self, event):
        if not isinstance(event, dict):
            return False
        events = await self.ctx.storage.get("login_events")
        if not isinstance(events, list):
            events = []
        events = [x for x in events if isinstance(x, dict)]
        events.insert(0, event)
        # Bound the private fallback log so it cannot grow without limit.
        await self.ctx.storage.put("login_events", events[:500])
        return True

    async def get_login_events(self, limit=20):
        try:
            safe_limit = min(max(int(limit), 1), 100)
        except (TypeError, ValueError):
            safe_limit = 20
        events = await self.ctx.storage.get("login_events")
        if not isinstance(events, list):
            return []
        return [x for x in events if isinstance(x, dict)][:safe_limit]

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

        cookie = str(request.headers.get("Cookie") or "")
        if not cookie:
            return Response("Authentication required", status=401)

        # Validate the signed Flask session before exposing live telemetry.
        try:
            # Avoid an internal Worker-to-Worker fetch for the initial handshake.
            # Validate the session locally; this prevents recursive routing and
            # makes the WebSocket endpoint independent of internal host aliases.
            from app import app
            raw_cookie = cookie
            session_cookie = None
            for part in raw_cookie.split(";"):
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
        except Exception:
            return Response("Authentication service unavailable", status=503)

        client, server = WebSocketPair.new().object_values()
        self.ctx.acceptWebSocket(server)

        session_id = str(uuid.uuid4())
        server.serializeAttachment({"id": session_id, "cookie": cookie})
        self.sessions[session_id] = server

        server.send(json.dumps({"type": "connected", "realtime": True}))

        state = await self.get_state()
        if state:
            server.send(json.dumps({
                "type": "state",
                "telemetry": state,
                "source": "initial"
            }, separators=(",", ":")))

        return Response(None, status=101, web_socket=client)

    async def webSocketMessage(self, ws, message):
        attachment = ws.deserializeAttachment() or {}
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
        admin_name = self._env_value(env, "ADMIN_USERNAME", ADMIN_USERNAME).strip().upper() or "ADMIN"
        admin_password = self._env_value(env, "ADMIN_PASSWORD")
        admin_hash = self._env_value(env, "ADMIN_PASSWORD_HASH")

        admin_aliases = {
            self._normalize_login(admin_name),
            "ADMIN",
            "ADMIN-1",
            "ADMINISTRATOR",
            "DEFENXADMIN",
            "DEFENXADMINISTRATOR",
            "ROVERADMIN",
            "ROVERADMINISTRATOR",
            "ADMINUSER",
            "ADMINUSERID",
        }
        if key in admin_aliases:
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

        friends = (
            ("MAHANTESH", "FRIEND_MAHANTESH_PASSWORD", "FRIEND_MAHANTESH_PASSWORD_HASH"),
            ("DHANUSH", "FRIEND_DHANUSH_PASSWORD", "FRIEND_DHANUSH_PASSWORD_HASH"),
            ("ANIRUDH", "FRIEND_ANIRUDH_PASSWORD", "FRIEND_ANIRUDH_PASSWORD_HASH"),
            ("MAMLESHWAR", "FRIEND4_PASSWORD", "FRIEND4_PASSWORD_HASH"),
        )
        for friend_name, password_key, hash_key in friends:
            aliases = {self._normalize_login(friend_name)}
            if friend_name == "MAHANTESH":
                aliases.add("MAHADESH")
            if key not in aliases:
                continue
            plain = self._env_value(env, password_key)
            hashed = self._env_value(env, hash_key)
            valid = bool(plain) and hmac.compare_digest(password, plain)
            if not valid and hashed:
                try:
                    valid = check_password_hash(hashed, password)
                except Exception:
                    valid = False
            if valid:
                return self._make_user(friend_name, "user", friend_name, can_manage_users=False)

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
            if int(response.status) < 200 or int(response.status) >= 300:
                return None
            user = data.get("user") if isinstance(data, dict) else None
            if not data.get("ok") or not isinstance(user, dict):
                return None
            username_value = str(user.get("username") or "").strip().upper()
            role = str(user.get("role") or "user").strip().lower()
            if not username_value or role not in {"admin", "user"}:
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
            return None

    @staticmethod
    def _session_cookie(user):
        serializer = app.session_interface.get_signing_serializer(app)
        if serializer is None:
            return None
        session_data = {
            "fallback_user": user,
            "user_cache": user,
            "dashboard_entry": True,
        }
        return serializer.dumps(session_data)

    def _login_response(self, user):
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
            cookie = self._session_cookie(user)
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

            user = self._local_authenticate(self.env, username, password)
            if user:
                return self._login_response(user)

            # Never send arbitrary login IDs to the legacy migration service.
            # Unknown IDs must be rejected locally with a normal 401.
            key = self._normalize_login(username)
            admin_name = self._env_value(
                self.env, "ADMIN_USERNAME", ADMIN_USERNAME
            )
            known_keys = {
                self._normalize_login(admin_name),
                "ADMIN",
                "ADMINISTRATOR",
                "DEFENXADMIN",
                "DEFENXADMINISTRATOR",
                "ROVERADMIN",
                "ROVERADMINISTRATOR",
                "ADMINUSER",
                "ADMINUSERID",
                "MAHANTESH",
                "MAHADESH",
                "DHANUSH",
                "ANIRUDH",
                "MAMLESHWAR",
            }
            if key not in known_keys:
                return self._login_response(None)

            canonical_friend_ids = {
                "MAHANTESH": "MAHANTESH",
                "MAHADESH": "MAHANTESH",
                "DHANUSH": "DHANUSH",
                "ANIRUDH": "ANIRUDH",
                "MAMLESHWAR": "MAMLESHWAR",
            }
            canonical_admin_ids = {
                self._normalize_login(admin_name),
                "ADMIN", "ADMIN1", "ADMINISTRATOR", "DEFENXADMIN",
                "DEFENXADMINISTRATOR", "ROVERADMIN", "ROVERADMINISTRATOR",
                "ADMINUSER", "ADMINUSERID",
            }
            # The legacy service may compare IDs literally. Send canonical
            # uppercase IDs instead of preserving the casing/spacing typed by
            # the user, while keeping the password unchanged.
            canonical = canonical_friend_ids.get(
                key,
                admin_name.strip().upper() if key in canonical_admin_ids else username.strip().upper(),
            )
            user = await self._legacy_authenticate(canonical, password)
            return self._login_response(user)
        except BaseException as exc:
            # Never let a Python or JavaScript/Pyodide error while building the
            # login response cascade into an unhandled Worker 500. Keep failures
            # closed: no session is issued, and callers receive a generic error.
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

            if url.path == "/api/ws":
                upgrade = str(request.headers.get("Upgrade") or "").lower()
                if upgrade != "websocket":
                    return Response("Expected WebSocket", status=426)
                stub = self.env.REALTIME_HUB.getByName("defenx-global")
                return await stub.fetch(request)

            if url.path == "/api/login" and str(request.method).upper() == "POST":
                return await self._handle_login(request)

            # Serve the public dashboard shell at the site root. This changes
            # only page routing: private APIs and rover commands still require
            # a valid authenticated session in the Flask application.
            if url.path in {"/", "/index.html"} and str(request.method).upper() in {"GET", "HEAD"}:
                original_url = str(request.url)
                asset_url = original_url.split("?", 1)[0]
                if url.path == "/":
                    asset_url = asset_url.rstrip("/") + "/index.html"
                if "?" in original_url:
                    asset_url += "?" + original_url.split("?", 1)[1]
                # Construct a fresh Request using only plain options. Passing
                # the incoming Pyodide Headers proxy through the JS constructor
                # can raise a Worker runtime exception (Error 1101).
                asset_request = js.Request.new(
                    asset_url,
                    {"method": str(request.method).upper()},
                )
                return await self.env.ASSETS.fetch(asset_request)

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
