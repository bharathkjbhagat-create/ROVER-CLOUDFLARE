#!/usr/bin/env python3
"""Headless-Chromium test of the hosted YOLO UI (desktop + mobile).
Serves the real public/ assets with a MOCK /api/yolo/* backend, injects a live <video>
(canvas.captureStream) into the camera viewport, and checks status text, request shape,
overlay drawing, error handling and layout. It does NOT call any real hosted YOLO provider.
Run: python tests/browser_hosted_yolo.py"""
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parents[1] / "public"
USER = {"display_name": "Test", "role": "admin", "username": "t", "can_control": True, "can_manage_users": True}
TEL = {"battery": 80, "signal": 80, "device_online": True, "camera": True, "lat": 12.97, "lon": 77.59}
MODE = {"configured": True, "detect": "ok"}
POSTS = []
OK = {"ok": True, "source": "hosted-yolo", "image": {"width": 640, "height": 480},
      "detections": [{"class_name": "person", "confidence": 0.9, "box": {"x1": .2, "y1": .2, "x2": .5, "y2": .8}},
                     {"class_name": "car", "confidence": 0.7, "box": {"x1": .55, "y1": .5, "x2": .9, "y2": .9}}],
      "faces": [{"confidence": 0.8, "box": {"x1": .25, "y1": .22, "x2": .35, "y2": .35}}]}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, o, code=200):
        d = json.dumps(o).encode(); self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); body = self.rfile.read(n)
        if self.path.split("?")[0] == "/api/yolo/detect":
            POSTS.append((self.headers.get("Content-Type"), body[:3], len(body)))
            m = MODE["detect"]
            if m == "ok": return self._json(OK)
            if m == "401": return self._json({"ok": False, "error": "Login required"}, 401)
            return self._json({"ok": False, "error": "Hosted YOLO service is unavailable.", "code": "upstream_unavailable"}, 502)
        self._json({"ok": True})
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/yolo/status": return self._json({"ok": True, "configured": MODE["configured"], "identification": False})
        if p == "/api/me": return self._json({"user": USER})
        if p == "/api/bootstrap": return self._json({"user": USER, "telemetry": TEL})
        if p == "/api/telemetry": return self._json(TEL)
        if p.startswith("/api/"): return self._json({})
        f = PUBLIC / ("index.html" if p in ("/", "") else p.lstrip("/"))
        if not f.is_file(): self.send_response(404); self.end_headers(); return
        d = f.read_bytes(); ct = {".js": "application/javascript", ".css": "text/css", ".html": "text/html"}.get(f.suffix, "application/octet-stream")
        self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)

srv = ThreadingHTTPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/index.html"
results = []
def check(name, cond, detail=""):
    results.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"))

INJECT_VIDEO = """() => new Promise(res => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 480;
  const x = c.getContext('2d'); let i = 0; setInterval(() => { x.fillStyle = 'rgb(' + (i++ % 255) + ',90,160)'; x.fillRect(0,0,640,480); }, 50);
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.autoplay = true; v.srcObject = c.captureStream(20);
  v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover';
  document.getElementById('cameraViewport').appendChild(v); v.play().catch(()=>{}); v.onloadeddata = () => res(true); setTimeout(() => res(v.readyState), 3000);
})"""
STATE = "() => document.querySelector('#hostedYoloBar [data-role=state]').textContent"
def wait_state(page, needle, timeout=8000):
    try: page.wait_for_function("n => document.querySelector('#hostedYoloBar [data-role=state]').textContent.includes(n)", arg=needle, timeout=timeout); return True
    except Exception: return False

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    for label, vp, mobile in (("desktop", {"width": 1280, "height": 900}, False), ("mobile", {"width": 390, "height": 844}, True)):
        ctx = browser.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile)
        ctx.route("**/*", lambda r: r.continue_() if r.request.url.startswith(f"http://127.0.0.1:{port}") else r.fulfill(status=200, content_type="application/javascript", body="/*stub*/"))
        page = ctx.new_page(); errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        POSTS.clear(); MODE.update(configured=False, detect="ok")
        page.goto(URL, wait_until="load"); page.wait_for_selector("#hostedYoloBar", timeout=10000)
        check(f"[{label}] hosted YOLO bar present, initially OFF", page.evaluate(STATE) == "OFF")
        page.locator("#hostedYoloBar [data-role=toggle]").scroll_into_view_if_needed()
        # 1. not configured
        page.click("#hostedYoloBar [data-role=toggle]")
        check(f"[{label}] not configured -> clear message, no frame uploaded", wait_state(page, "NOT CONFIGURED") and not POSTS, page.evaluate(STATE))
        # 2. success path
        MODE.update(configured=True, detect="ok"); page.evaluate(INJECT_VIDEO)
        page.click("#hostedYoloBar [data-role=toggle]")
        check(f"[{label}] success -> counts shown, faces labelled DETECTED only", wait_state(page, "2 OBJECT(S)") and "1 PERSON" in page.evaluate(STATE) and "1 FACE(S) DETECTED" in page.evaluate(STATE), page.evaluate(STATE))
        ct, magic, size = POSTS[0]
        check(f"[{label}] request is image/jpeg JPEG bytes, downscaled and < 1.5MB", ct == "image/jpeg" and magic == b"\xff\xd8\xff" and 0 < size < 1_500_000, (ct, magic, size))
        drawn = page.evaluate("() => { const c = document.querySelector('.hostedYoloCanvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n }")
        check(f"[{label}] overlay boxes drawn on canvas", drawn > 100, drawn)
        txt = page.evaluate("() => document.getElementById('hostedYoloBar').innerText.toLowerCase()")
        check(f"[{label}] UI never claims identity/recognition", not any(w in txt for w in ("recogni", "identif", "known", "unknown", "match")), txt)
        check(f"[{label}] no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        # 3. upstream failure
        MODE["detect"] = "502"
        check(f"[{label}] upstream failure -> visible error + retry, overlay cleared", wait_state(page, "DETECTION FAILED", 10000) and "UNAVAILABLE" in page.evaluate(STATE), page.evaluate(STATE))
        cleared = page.evaluate("() => { const c = document.querySelector('.hostedYoloCanvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true }")
        check(f"[{label}] stale boxes not left on screen after failure", cleared)
        # 4. recovery
        MODE["detect"] = "ok"
        check(f"[{label}] recovers automatically after backend returns", wait_state(page, "2 OBJECT(S)", 15000), page.evaluate(STATE))
        # 5. expired session
        MODE["detect"] = "401"
        check(f"[{label}] 401 -> SESSION EXPIRED and stops polling", wait_state(page, "SESSION EXPIRED", 10000) and not page.evaluate("window.DEFENX_HOSTED_YOLO.isRunning()"))
        # 6. stop button
        MODE["detect"] = "ok"; page.click("#hostedYoloBar [data-role=toggle]"); wait_state(page, "OBJECT(S)")
        page.click("#hostedYoloBar [data-role=toggle]")
        check(f"[{label}] STOP returns to OFF", page.evaluate(STATE) == "OFF")
        check(f"[{label}] no uncaught page errors", not errors, errors)
        ctx.close()
    browser.close()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)

