#!/usr/bin/env python3
"""Real-browser (Chromium) test of the DEFENX fleet & autonomy panel against a live local server with an
independent rover-simulator process.  Software only: the rover is a SIMULATOR, not hardware.
Run: python tests/browser_fleet_dashboard.py   (not auto-discovered by unittest)"""
import json, mimetypes, os, signal, socket, subprocess, sys, tempfile, time, urllib.request, http.cookiejar
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]; PUBLIC = ROOT / "public"; PY = sys.executable
MASTER = "browser-master-secret-0123456789abcdef"; PW = "browser-admin-pass-1"
results = []
def check(name, ok, detail=""):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " — " + str(detail)))

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

port = free_port(); BASE = f"http://127.0.0.1:{port}"
env = dict(os.environ, SESSION_SECRET="s" * 40, ADMIN_USERNAME="ADMIN", ADMIN_PASSWORD=PW, FLEET_MASTER_SECRET=MASTER,
           DEVICE_OFFLINE_AFTER_SECONDS="5", PYTHONPATH=str(ROOT / "src"))
server = subprocess.Popen([PY, "-c", f"import app; app.app.config['SESSION_COOKIE_SECURE']=False; app.app.run(host='127.0.0.1', port={port}, threaded=True, use_reloader=False)"],
                          cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
procs = [server]
def cleanup():
    for p in procs:
        if p.poll() is None: p.kill()
try:
    for _ in range(60):
        try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
        except urllib.error.HTTPError: break
        except Exception: time.sleep(0.3)
    jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    def call(method, path, body=None):
        req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json"})
        with op.open(req, timeout=5) as r: return json.loads(r.read().decode())
    call("POST", "/api/login", {"username": "ADMIN", "password": PW})
    sec = {d: call("POST", "/api/fleet/devices", {"id": d, "name": d, "role": r})["secret"] for d, r in (("ROVER-01", "rover"), ("PHONE-01", "phone"))}
    procs.append(subprocess.Popen([PY, str(ROOT / "tools/rover_sim.py"), "--hz", "4"], env=dict(os.environ, DEVICE_SECRET=sec["ROVER-01"], DEVICE_ID="ROVER-01", FLEET_URL=BASE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    procs.append(subprocess.Popen([PY, str(ROOT / "tools/fleet_client.py"), "--lat", "13.0", "--lon", "77.6", "--battery", "71", "--interval", "1"], env=dict(os.environ, DEVICE_SECRET=sec["PHONE-01"], DEVICE_ID="PHONE-01", FLEET_URL=BASE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    time.sleep(2.5)

    BLOCK = ("leaflet", "tile.openstreetmap", "arcgisonline", "eox.at", "fonts.g", "face-api", "tf.min.js", "coco-ssd", "onnxruntime-web", "huggingface.co/skillsafe-ai/yolox-nano")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for label, vp in (("mobile", {"width": 390, "height": 844}), ("desktop", {"width": 1280, "height": 900})):  # desktop last: it kills the rover
            ctx = browser.new_context(viewport=vp, is_mobile=(label == "mobile"), has_touch=(label == "mobile"))
            def route(r):
                url = r.request.url
                if any(b in url for b in BLOCK): return r.fulfill(status=200, content_type="application/javascript", body="/* stub */")
                if url.startswith(BASE):
                    path = url[len(BASE):].split("?")[0].lstrip("/"); f = PUBLIC / path
                    if path and not path.startswith("api/") and f.is_file(): return r.fulfill(status=200, content_type=mimetypes.guess_type(str(f))[0] or "application/octet-stream", body=f.read_bytes())
                    return r.continue_()
                return r.abort()
            ctx.route("**/*", route)
            page = ctx.new_page(); errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())
            page.goto(BASE + "/login.html")
            check(f"[{label}] admin login", page.request.post(BASE + "/api/login", data={"username": "ADMIN", "password": PW}).ok)
            page.goto(BASE + "/index.html", wait_until="load")
            cell = lambda k: page.locator(f"#fleetSection .fleetGrid > div:has(> span:text-is('{k}')) > b")
            try:
                page.wait_for_selector("#fleetSection .fleetConn[data-s=online]", timeout=10000)
                check(f"[{label}] panel connects to server", True)
            except Exception as e: check(f"[{label}] panel connects to server", False, e)
            page.wait_for_timeout(1500)
            check(f"[{label}] link shows ONLINE from real heartbeats", cell("LINK").inner_text() == "ONLINE", cell("LINK").inner_text())
            check(f"[{label}] GPS fix displayed", cell("GPS").inner_text().startswith("FIX"), cell("GPS").inner_text())
            check(f"[{label}] obstacle distance displayed", cell("OBSTACLE").inner_text().startswith("F "), cell("OBSTACLE").inner_text())
            check(f"[{label}] camera status LIVE", cell("CAMERA").inner_text() == "LIVE")
            devs = page.locator("#fleetSection .fleetDev").all_inner_texts()
            check(f"[{label}] both devices listed online", len(devs) == 2 and all("ONLINE" in d for d in devs), devs)
            check(f"[{label}] simulator is labelled as simulator", any("SIMULATOR" in d for d in devs))
            check(f"[{label}] no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
            if label == "desktop":
                page.click("#fleetSection .estop")
                page.wait_for_function("document.querySelector('#fleetSection .fleetGrid > div:nth-child(2) > b').textContent === 'EMERGENCY STOP'", timeout=10000)
                check("E-STOP button -> rover reports EMERGENCY STOP (device-confirmed)", True)
                try: page.wait_for_selector(".control.forward:not([disabled])", timeout=15000)
                except Exception: print("DEBUG", page.evaluate("[document.getElementById('permissionNotice').textContent, document.getElementById('connStatus').textContent]")); raise
                page.click(".control.forward")
                page.wait_for_timeout(600)
                check("drive button refused while e-stop latched (safety gate message shown)", "refused" in page.locator("#fleetMsg").inner_text().lower() or "COMMAND REFUSED" in page.locator("#permissionNotice").inner_text().upper(), page.locator("#fleetMsg").inner_text())
                page.click("#fleetSection button:text-is('RESET E-STOP')")
                page.wait_for_function("document.querySelector('#fleetSection .fleetGrid > div:nth-child(2) > b').textContent === 'IDLE'", timeout=10000)
                check("RESET E-STOP -> rover returns to IDLE", True)
                page.click("#fleetSection button:text-is('SAVE BASE = ROVER GPS')")
                page.wait_for_function("document.getElementById('returnBaseStatus').textContent.includes('BASE SAVED ON SERVER')", timeout=10000)
                check("save base persisted on server and shown", True)
                page.click("#returnToBaseBtn")
                page.wait_for_function("document.querySelector('#fleetSection .fleetGrid > div:nth-child(7) > b').textContent.startsWith('ARRIVED')", timeout=20000)
                check("RETURN TO BASE -> ARRIVED shown only after rover confirms", True)
                page.click(".control.forward")
                page.wait_for_timeout(2500)
                cmds = call("GET", "/api/fleet/commands?device_id=ROVER-01")["commands"]
                check("dashboard drive button reaches rover and is acknowledged", any(c["command"] == "FORWARD" and c["status"] == "executed" for c in cmds), [(c["command"], c["status"]) for c in cmds][-4:])
                # kill the rover -> panel must show offline, camera/gps unavailable are not faked
                for p in procs:
                    if p.args and "rover_sim" in " ".join(map(str, p.args)): p.send_signal(signal.SIGKILL)
                page.wait_for_function("document.querySelector('#fleetSection .fleetGrid > div:nth-child(1) > b').textContent === 'ROVER OFFLINE'", timeout=20000)
                check("rover process killed -> dashboard shows ROVER OFFLINE", True)
                check("GPS no longer shown as live when rover offline", cell("GPS").inner_text() == "GPS UNAVAILABLE", cell("GPS").inner_text())
                page.click(".control.forward"); page.wait_for_timeout(600)
                check("movement refused while rover offline", "COMMAND REFUSED" in page.locator("#permissionNotice").inner_text().upper() or "refused" in page.locator("#fleetMsg").inner_text().lower())
                try:
                    page.wait_for_function("document.querySelector('#fleetSection .fleetEvents').textContent.includes('device_offline')", timeout=15000); ok = True
                except Exception: ok = False
                check("offline event visible in persisted event list", ok, page.locator("#fleetSection .fleetEvents").inner_text()[:200])
            page.screenshot(path=f"/tmp/fleet_{label}.png", full_page=False)
            fleet_errs = [e for e in errors if "fleet" in e.lower()]
            check(f"[{label}] no JavaScript errors from fleet panel", not fleet_errs, fleet_errs)
            ctx.close()
        browser.close()
finally:
    cleanup()
print(f"\n{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)
