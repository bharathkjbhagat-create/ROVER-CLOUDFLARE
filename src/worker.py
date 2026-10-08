import json
import base64
import hashlib
import hmac
from urllib.parse import urlparse
import uuid
import js
from js import WebSocketPair, WebSocketRequestResponsePair, fetch as js_fetch
from workers import DurableObject, Response, WorkerEntrypoint, wsgi

from app import app, LEGACY_AUTH_ENABLED, LEGACY_AUTH_URL, SESSION_SECRET


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

    Keep ordinary HTTP/API requests on the documented Flask WSGI path. Login
    is handled by Flask itself so the browser request, Flask session cookie,
    and authentication code all use one request pipeline.
    """

    async def fetch(self, request):
        url = urlparse(request.url)

        if url.path == "/api/ws":
            upgrade = str(request.headers.get("Upgrade") or "").lower()
            if upgrade != "websocket":
                return Response("Expected WebSocket", status=426)
            stub = self.env.REALTIME_HUB.getByName("defenx-global")
            return await stub.fetch(request)

        return await wsgi.fetch(app, request, self.env)
