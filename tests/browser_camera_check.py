
"""Headless-Chromium check of the dashboard camera view (not part of the unittest run: needs Playwright).
Uses Chromium's *fake* camera device, so it proves overlay/status behaviour, NOT real rover hardware.
Usage: python tests/browser_camera_check.py [path-to-public-dir]"""
import io, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

PUBLIC = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "public")
MODE = {"cfg": {"enabled": False}}
def jpeg(c):
    b = io.BytesIO(); Image.new("RGB", (640, 480), c).save(b, "JPEG"); return b.getvalue()
USER = {"display_name": "Test", "role": "admin", "username": "t", "can_control": True, "can_manage_users": True}
TEL = {"battery": 80, "signal": 80, "device_online": True, "gps_source": "ROVER_DEVICE", "camera_source": "ROVER_DEVICE", "camera": True, "lat": 12.97, "lon": 77.59, "gps_fix": True}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, o, code=200):
        d = json.dumps(o).encode(); self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def do_POST(self): self._json({"ok": True})
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/me": return self._json({"user": USER})
        if p == "/api/bootstrap": return self._json({"user": USER, "telemetry": TEL})
        if p == "/api/telemetry": return self._json(TEL)
        if p == "/api/camera-config": return self._json(MODE["cfg"])
        if p == "/stream.mjpg":
            self.send_response(200); self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=f"); self.end_headers()
            try:
                for i in range(600):
                    j = jpeg((30 + i % 200, 90, 160))
                    self.wfile.write(b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(j) + j + b"\r\n"); time.sleep(0.1)
            except Exception: pass
            return
        if p.startswith("/api/"): return self._json({})
        f = PUBLIC / ("index.html" if p in ("/", "") else p.lstrip("/"))
        if not f.is_file(): self.send_response(404); self.end_headers(); return
        d = f.read_bytes(); ct = {".js": "application/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml"}.get(f.suffix, "application/octet-stream")
        self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)

srv = ThreadingHTTPServer(("127.0.0.1", 0), H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{port}/index.html"  # "/" is treated as demo mode by app.js; the real dashboard lives at /index.html

PROBE = """() => {
  const vp = document.getElementById('cameraViewport'), cam = document.getElementById('roverRealCamera');
  const disp = s => { const e = vp.querySelector(s); return e ? getComputedStyle(e).display : 'absent'; };
  const r = vp.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
  return {feed: vp.dataset.feed || '', placeholder: disp('#camPlaceholder'), target: disp('.camTargetBox'), crosshair: disp('.cameraCrosshair'),
    hudTop: disp('.cameraOverlayTop'), hudBottom: disp('.cameraOverlayBottom'), scene: disp('.camera3DScene'),
    badge: (document.querySelector('#liveCamera .liveBadge')||{}).textContent, cam: cam ? cam.tagName : 'none',
    topElement: top ? (top.id || top.className || top.tagName) : 'none', camInlineStyle: cam ? cam.getAttribute('style') : null};
}"""
res = {}
def check(name, cond, detail=""):
    res[name] = bool(cond); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if not cond else ""))

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    def page(cfg):
        MODE["cfg"] = cfg
        ctx = br.new_context(permissions=["camera"], viewport={"width": 1280, "height": 800}); pg = ctx.new_page()
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(URL); pg.wait_for_timeout(2500); return pg, errs

    # 1. no rover camera configured -> operator starts the phone camera (fake device)
    pg, errs = page({"enabled": False})
    pre = pg.evaluate(PROBE); print("before phone camera:", pre["placeholder"], pre["feed"])
    pg.click("#phoneCameraBtn"); pg.wait_for_timeout(2500)
    s = pg.evaluate(PROBE); print("phone camera probe:", s)
    check("phone: no-feed placeholder hidden once camera is live", s["placeholder"] == "none", s["placeholder"])
    check("phone: demo HUD hidden over live footage", s["target"] == "none" and s["crosshair"] == "none" and s["hudBottom"] == "none" and s["hudTop"] == "none", s)
    check("phone: footage (not an overlay) is the top element", s["topElement"] in ("roverRealCamera", "aiVisionCanvas", "faceScanCanvas"), s["topElement"])
    check("phone: header badge says LIVE", "LIVE" in (s["badge"] or ""), s["badge"])
    # 2. full screen monitor and back
    pg.click("#viewFullBtn"); pg.wait_for_timeout(1200)
    fs = pg.evaluate("() => ({open: document.getElementById('mvRoot').classList.contains('mv-open'), inStage: !!document.querySelector('#mvStage #roverRealCamera'), banner: !document.getElementById('mvBanner').hidden, pill: document.getElementById('mvCamLabel').textContent})")
    print("fullscreen probe:", fs)
    check("fullscreen: camera moved into monitor and status LIVE, no banner", fs["open"] and fs["inStage"] and fs["pill"] == "LIVE" and not fs["banner"], fs)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
    back = pg.evaluate(PROBE)
    st = back["camInlineStyle"] or ""
    check("fullscreen close: camera restored to dashboard styling (no contain/z-index 8 leak)", back["cam"] == "VIDEO" and "contain" not in st and "z-index: 8" not in st, st)
    check("no uncaught page errors (phone scenario)", not errs, errs[:2])
    pg.context.close()

    # 3. MJPEG rover stream that works
    pg, errs = page({"enabled": True, "type": "mjpeg", "url": "/stream.mjpg"})
    m = pg.evaluate(PROBE); print("mjpeg probe:", m)
    check("mjpeg: LIVE badge, placeholder + HUD hidden", "LIVE" in (m["badge"] or "") and m["placeholder"] == "none" and m["target"] == "none", m)
    pg.context.close()

    # 4. stream URL that really fails -> warning appears, but only after the grace period
    pg, errs = page({"enabled": True, "type": "mjpeg", "url": "/missing.mjpg"})
    pg.wait_for_timeout(500)
    g = pg.evaluate(PROBE); print("failed stream (early):", g["placeholder"], g["badge"])
    pg.wait_for_timeout(4000)
    g2 = pg.evaluate(PROBE)
    txt = pg.evaluate("() => [document.getElementById('camPlaceholder').hidden, document.getElementById('camPlaceholderMsg').textContent]")
    print("failed stream (after grace):", g2["placeholder"], g2["badge"], txt)
    check("genuine failure: reconnect warning shown after grace period", g2["placeholder"] != "none" and "RECONNECT" in (txt[1] or "").upper(), txt)
    pg.context.close(); br.close()
print(json.dumps(res)); sys.exit(0 if all(res.values()) else 1)