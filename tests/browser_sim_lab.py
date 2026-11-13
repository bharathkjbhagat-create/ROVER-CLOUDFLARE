#!/usr/bin/env python3
"""Real-browser (Chromium) test of the Simulation Lab panel on the authenticated dashboard.
SOFTWARE ONLY: exercises the browser-side rover simulation; no hardware, no external network.
Leaflet cannot load offline, so the map overlay is verified against a recording stand-in for the Leaflet API.
Run: python tests/browser_sim_lab.py   (not auto-discovered by unittest)"""
import mimetypes, os, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]; PUBLIC = ROOT / "public"; PY = sys.executable
PW = "browser-admin-pass-1"; results = []


def check(name, ok, detail=""):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " — " + str(detail)))


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


port = free_port(); BASE = f"http://127.0.0.1:{port}"
env = dict(os.environ, SESSION_SECRET="s" * 40, ADMIN_USERNAME="ADMIN", ADMIN_PASSWORD=PW, FLEET_MASTER_SECRET="browser-master-secret-0123456789abcdef", PYTHONPATH=str(ROOT / "src"))
server = subprocess.Popen([PY, "-c", f"import app; app.app.config['SESSION_COOKIE_SECURE']=False; app.app.run(host='127.0.0.1', port={port}, threaded=True, use_reloader=False)"],
                          cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

FAKE_LEAFLET = r"""
window.__calls = [];
(function(){
  const rec = (n, a) => window.__calls.push([n, a]);
  function Layer(kind, args){ this.kind = kind; this.args = args; this.ll = null; this.r = null; this.lls = [];
    this.setLatLng = ll => { this.ll = ll; rec(kind + '.setLatLng', ll); return this; }; this.setLatLngs = l => { this.lls = l; return this; };
    this.setRadius = r => { this.r = r; rec(kind + '.setRadius', r); return this; }; this.addTo = g => { rec(kind + '.addTo'); return this; };
    this.bindTooltip = () => this; this.setTooltipContent = t => { this.tip = t; return this; }; this.getElement = () => null; this.getBounds = () => [[0,0],[1,1]];
    if (kind === 'marker') this.ll = args[0]; if (kind === 'circle') { this.ll = args[0]; this.r = args[1].radius; } }
  window.L = { layerGroup: () => ({ addTo: () => { rec('group.addTo'); return window.L.__g; } }), divIcon: o => o,
    marker: (ll, o) => new Layer('marker', [ll, o]), polyline: (l, o) => new Layer('polyline', [l, o]), circle: (ll, o) => new Layer('circle', [ll, o]), rectangle: (b, o) => new Layer('rect', [b, o]) };
  window.L.__g = {};
  window.__layers = [];
  const origMarker = window.L.marker; window.L.marker = (a, b) => { const l = origMarker(a, b); window.__layers.push(l); return l; };
  const origCircle = window.L.circle; window.L.circle = (a, b) => { const l = origCircle(a, b); window.__layers.push(l); return l; };
  const origPoly = window.L.polyline; window.L.polyline = (a, b) => { const l = origPoly(a, b); window.__layers.push(l); return l; };
  window.__handlers = {};
  window.__fakeMap = { getCenter: () => ({ lat: 13.0, lng: 77.6 }), on: (e, f) => { window.__handlers[e] = f; }, off: (e, f) => { delete window.__handlers[e]; rec('map.off', e); }, removeLayer: () => rec('map.removeLayer'), fitBounds: () => rec('map.fitBounds') };
})();
"""

try:
    for _ in range(60):
        try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
        except urllib.error.HTTPError: break
        except Exception: time.sleep(0.3)
    BLOCK = ("leaflet", "tile.openstreetmap", "arcgisonline", "eox.at", "fonts.g", "face-api", "tf.min.js", "coco-ssd", "onnxruntime-web", "huggingface.co/skillsafe-ai/yolox-nano")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for label, vp in (("mobile", {"width": 390, "height": 844}), ("desktop", {"width": 1280, "height": 900})):
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
            page = ctx.new_page(); errors = []; requested = []
            page.on("request", lambda rq: requested.append(rq.url))
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("dialog", lambda d: d.accept())
            page.goto(BASE + "/login.html")
            check(f"[{label}] admin login", page.request.post(BASE + "/api/login", data={"username": "ADMIN", "password": PW}).ok)
            page.goto(BASE + "/index.html", wait_until="load")
            page.wait_for_selector("#simLabOpen", timeout=10000)
            check(f"[{label}] first dashboard load does NOT download the simulation files", not any(n in u for u in requested for n in ("sim-core.js", "sim-lab.js", "sim-lab.css")), [u for u in requested if "sim-" in u])
            page.locator("#simLabOpen").click(); page.wait_for_selector("#simLabSection .simCanvas", timeout=10000)
            check(f"[{label}] OPEN SIMULATION LAB downloads and starts it", any("sim-core.js" in u for u in requested) and any("sim-lab.js" in u for u in requested))
            P = lambda t: page.locator("#simLabSection " + t)
            cell = lambda k: page.locator(f"#simLabSection .simGrid > div:has(> span:text-is('{k}')) > b").inner_text()
            msg = lambda: P(".simMsg").inner_text()
            adv = lambda s: page.evaluate(f"window.__defenxSimLab.advance({s})")
            click = lambda i: page.locator(f"#sim_{i}").click()
            sim = lambda expr: page.evaluate(f"(() => {{ const s = window.__defenxSimLab.sim(); return {expr}; }})()")
            page.locator("#simLabSection").scroll_into_view_if_needed()

            check(f"[{label}] panel renders and is labelled SOFTWARE ONLY", "SOFTWARE ONLY" in P(".simChips").inner_text() and "does not control" in P(".simNote").inner_text())
            sim_errs = [e for e in errors if "sim" in e.lower()]
            check(f"[{label}] no script errors from the simulation files", not sim_errs, sim_errs)
            box = page.locator("#simLabSection .simCanvas").bounding_box()
            check(f"[{label}] grid view fits the screen width", box and box["width"] <= vp["width"] and box["width"] > 200, box)

            # --- exploration, pause, stop, resume ---
            click("start"); adv(5)
            check(f"[{label}] START EXPLORATION -> exploring", "EXPLORING" in cell("STATE"), cell("STATE"))
            check(f"[{label}] GPS fix and sensor readings displayed", cell("GPS").startswith("FIX") and cell("SENSORS F/L/R").count("/") == 2, (cell("GPS"), cell("SENSORS F/L/R")))
            click("pause"); t0 = sim("s.t"); page.wait_for_timeout(800)
            check(f"[{label}] PAUSE SIM freezes the clock and flips to RESUME SIM", sim("s.t") == t0 and "RESUME" in P("#sim_pause").inner_text())
            click("pause"); page.wait_for_timeout(800)
            check(f"[{label}] RESUME SIM restarts the clock", sim("s.t") > t0)
            click("stop"); adv(1)
            check(f"[{label}] STOP ROVER -> IDLE and motors stopped", cell("STATE").startswith("IDLE") and sim("s.speed") == 0, cell("STATE"))
            check(f"[{label}] RESUME AUTONOMY disabled unless safe-stopped", P("#sim_resume").is_disabled())

            # --- faults ---
            click("start"); adv(3); click("frontf"); adv(1)
            check(f"[{label}] FRONT SENSOR FAULT -> safe stop, shows FAULT", "SAFE STOP" in cell("STATE") and "FAULT" in cell("SENSORS F/L/R"), (cell("STATE"), cell("SENSORS F/L/R")))
            click("resume"); check(f"[{label}] resume refused while the sensor fault persists", "Refused" in msg() and "sensor" in msg().lower(), msg())
            click("frontf"); adv(1); click("resume"); adv(1)
            check(f"[{label}] clearing the fault then RESUME AUTONOMY works", "EXPLORING" in cell("STATE"), (cell("STATE"), msg()))
            click("gpsf"); adv(5)
            check(f"[{label}] DROP GPS -> NO FIX and the rover holds still", cell("GPS") == "NO FIX" and sim("Math.abs(s.speed)") < 0.01, (cell("GPS"), sim("s.speed")))
            click("gpsf"); adv(4)
            check(f"[{label}] GPS recovers and exploration continues", cell("GPS").startswith("FIX") and "EXPLORING" in cell("STATE"), (cell("GPS"), cell("STATE")))
            n0 = sim("s.world.occ.reduce((a,b)=>a+b,0)"); click("block"); n1 = sim("s.world.occ.reduce((a,b)=>a+b,0)")
            for _ in range(6):
                if n1 > n0: break
                adv(8); n0 = sim("s.world.occ.reduce((a,b)=>a+b,0)"); click("block"); n1 = sim("s.world.occ.reduce((a,b)=>a+b,0)")
            check(f"[{label}] BLOCK ROUTE AHEAD adds a real obstacle", n1 > n0 and "Obstacle dropped" in msg(), (n0, n1, msg()))
            adv(60); check(f"[{label}] rover avoided it with no collision", sim("s.stats.collisions") == 0)
            click("estop"); adv(1)
            check(f"[{label}] E-STOP latches", "EMERGENCY STOP" in cell("STATE") and P("#sim_start").is_disabled() and P("#sim_rtb").is_disabled())
            click("estopr"); adv(1)
            check(f"[{label}] RESET E-STOP -> idle, not moving", cell("STATE").startswith("IDLE") and sim("s.speed") == 0, cell("STATE"))

            # --- offline, local journal, sync ---
            click("start"); adv(20); click("link"); adv(7)
            check(f"[{label}] GO OFFLINE -> OFFLINE shown, rover keeps exploring", cell("LINK").startswith("OFFLINE") and "EXPLORING" in cell("STATE") and "GO ONLINE" in P("#sim_link").inner_text(), (cell("LINK"), cell("STATE")))
            q0 = sim("s.pending().length"); adv(120)
            check(f"[{label}] events queue locally while offline (and persist)", sim("s.pending().length") > q0 and page.evaluate("JSON.parse(localStorage.getItem('defenx-sim:ROVER-SIM:journal')).events.length") > 3, sim("s.pending().length"))
            check(f"[{label}] offline autonomy countdown visible", "left" in cell("OFFLINE AUTONOMY"), cell("OFFLINE AUTONOMY"))
            click("rtb"); check(f"[{label}] RETURN TO BASE refused while rover unreachable (no fake success)", "Refused" in msg() and "unreachable" in msg(), msg())
            page.select_option("#sim_cloudmode", "lose_ack"); click("link"); adv(40)
            check(f"[{label}] lost cloud replies cause re-sends, not duplicates", page.evaluate("window.__defenxSimLab.cloud().stats.ackLost") > 0 and page.evaluate("window.__defenxSimLab.cloud().stats.duplicates") > 0)
            page.select_option("#sim_cloudmode", "ok"); adv(40)
            check(f"[{label}] reconnect syncs everything, nothing lost or duplicated", sim("s.pending().length") == 0 and page.evaluate("window.__defenxSimLab.cloud().events.size") == sim("new Set(s.events.map(e=>e.id)).size"), (sim("s.pending().length"),))
            check(f"[{label}] event journal lists synced events", "✓" in P(".simLog").inner_text())

            # --- real Flask backend as the cloud ---
            page.select_option("#sim_cloudmode", "flask"); click("link"); adv(40)
            pend_ids = sim("s.pending().map(e => e.id)")
            check(f"[{label}] Flask cloud: events queue locally while offline", len(pend_ids) >= 1, len(pend_ids))
            click("link"); adv(3)
            for _ in range(60):
                adv(2); page.wait_for_timeout(250)
                if sim("s.pending().length") == 0: break
            ids = pend_ids
            srv = page.request.get(BASE + "/api/fleet/events?device=SIM-ROVER&limit=500").json()["events"]
            srv_ids = {e["id"] for e in srv}
            check(f"[{label}] Flask cloud: queued events reach the real server and the queue empties", sim("s.pending().length") == 0 and len(ids) >= 1, (sim("s.pending().length"), len(ids)))
            check(f"[{label}] Flask cloud: server holds every simulated event exactly once (no loss, no duplicates)", set(ids) <= srv_ids and len([e for e in srv if e["id"] in set(ids)]) == len(set(ids)) and len(set(ids)) == len(ids), (len(ids), len(srv_ids)))
            check(f"[{label}] Flask cloud: server marks them as simulation", all(e["source"] == "simulation" and e["data"]["sim"] is True for e in srv))
            check(f"[{label}] Flask cloud: simulated events stay out of the real event feed", not [e for e in page.request.get(BASE + "/api/fleet/events?limit=500").json()["events"] if e.get("source") == "simulation"])
            page.select_option("#sim_cloudmode", "ok")

            # --- return to base with picked base and radius ---
            click("stop"); adv(1)
            tgt = sim("(()=>{let b=null;for(let i=0;i<s.known.length;i++){const p=s._cellXY(i);if(s.known[i]===1&&s.pass[i]&&Math.hypot(p.x-s.truth.x,p.y-s.truth.y)>5&&Math.hypot(p.x-s.start.x,p.y-s.start.y)>5){b=p;break;}}return b;})()")
            check(f"[{label}] a mapped free cell exists to use as base", tgt is not None)
            page.fill("#sim_radius", "3"); click("pick"); check(f"[{label}] PICK BASE arms the grid", "CLICK" in P("#sim_pick").inner_text())
            page.locator("#simLabSection .simCanvas").scroll_into_view_if_needed(); cv = page.locator("#simLabSection .simCanvas").bounding_box(); w, h = sim("s.w*0.5"), sim("s.h*0.5")
            page.mouse.click(cv["x"] + cv["width"] * tgt["x"] / w, cv["y"] + cv["height"] * (1 - tgt["y"] / h))
            b = sim("s.base"); check(f"[{label}] clicking the grid sets base + radius", abs(b["x"] - tgt["x"]) < 0.6 and abs(b["y"] - tgt["y"]) < 0.6 and b["radius"] == 3, (b, tgt))
            click("pick"); click("pick"); page.keyboard.press("Escape"); check(f"[{label}] Escape cancels base picking", "PICK BASE" == P("#sim_pick").inner_text())
            click("rtb"); adv(3)
            check(f"[{label}] RETURN TO BASE starts, remaining distance + progress shown", "RETURNING" in cell("STATE") and "m left" in cell("RETURN TO BASE"), (cell("STATE"), cell("RETURN TO BASE")))
            click("cancelrtb"); adv(1); check(f"[{label}] CANCEL RETURN stops the return", cell("RETURN TO BASE") == "NOT ACTIVE" and cell("STATE").startswith("IDLE"), cell("RETURN TO BASE"))
            click("rtb"); mid_arrived = False
            for _ in range(120):
                adv(5)
                if "ARRIVED" in cell("RETURN TO BASE") and not cell("RETURN TO BASE").startswith("RETURNING"): break
                if sim("s.state") == "RTB_NAVIGATE" and sim("s.arrived"): mid_arrived = True
            check(f"[{label}] arrival shown only after the rover reports stopped inside the radius", "ARRIVED" in cell("RETURN TO BASE") and sim("s.speed") == 0 and sim("Math.hypot(s.truth.x-s.base.x,s.truth.y-s.base.y)") <= 3 and not mid_arrived, (cell("RETURN TO BASE"), sim("Math.hypot(s.truth.x-s.base.x,s.truth.y-s.base.y)")))
            page.fill("#sim_radius", "0.2"); click("setbase"); check(f"[{label}] SET RADIUS rejects out-of-range", "Refused" in msg() and "radius" in msg(), msg())
            page.fill("#sim_radius", "5"); click("setbase"); check(f"[{label}] SET RADIUS applies", sim("s.base.radius") == 5, msg())

            # --- map overlay (recording Leaflet stand-in) ---
            page.evaluate("(src) => { eval(src); window.__defenxGetMap = () => window.__fakeMap; }", FAKE_LEAFLET)
            page.locator("#sim_onmap").check(); adv(1); page.wait_for_timeout(700)
            calls = page.evaluate("window.__calls.map(c => c[0])")
            check(f"[{label}] 'Show on live map' creates rover, track, route, base overlays", all(k in calls for k in ("marker.addTo", "circle.addTo", "polyline.addTo", "map.fitBounds")), calls[:12])
            rover_ll = page.evaluate("window.__layers.find(l => l.kind === 'marker').ll"); base_ll = page.evaluate("window.__layers.find(l => l.kind === 'circle').ll")
            check(f"[{label}] overlay rover is placed at real lat/lon near the sim origin", rover_ll and abs(rover_ll[0] - 13.0) < 0.001 and abs(rover_ll[1] - 77.6) < 0.001, rover_ll)
            check(f"[{label}] overlay base circle uses the arrival radius", page.evaluate("window.__layers.find(l => l.kind === 'circle').r") == 5, page.evaluate("window.__layers.find(l => l.kind === 'circle').r"))
            click("pick"); handler = page.evaluate("typeof window.__handlers.click")
            check(f"[{label}] map click handler registered for base picking", handler == "function")
            ll = page.evaluate("(()=>{const s=window.__defenxSimLab.sim();let p=null;for(let i=0;i<s.known.length&&!p;i++){const c=s._cellXY(i);if(s.known[i]===1&&s.pass[i]&&Math.hypot(c.x-s.start.x,c.y-s.start.y)>3)p=c;}const o=s.o.origin;return {lat:o.lat+p.y/111320,lng:o.lon+p.x/(111320*Math.cos(o.lat*Math.PI/180)),x:p.x,y:p.y};})()")
            page.evaluate("(ll) => window.__handlers.click({ latlng: ll })", ll)
            b = sim("s.base"); check(f"[{label}] picking on the map sets the base at the clicked point", abs(b["x"] - ll["x"]) < 0.6 and abs(b["y"] - ll["y"]) < 0.6, (b, ll))
            page.locator("#sim_onmap").uncheck(); check(f"[{label}] unchecking removes the overlay", "map.removeLayer" in page.evaluate("window.__calls.map(c => c[0])"))

            # --- world/scenario/speed/reset/checkbox controls ---
            page.select_option("#sim_scenario", "warehouse"); adv(1)
            check(f"[{label}] changing scenario resets the world", sim("s.scenario") == "warehouse" and sim("s.stats.distance") == 0, sim("s.scenario"))
            page.select_option("#sim_speed", "60"); t1 = sim("s.t"); page.wait_for_timeout(1000); click("start")
            page.wait_for_timeout(1500); check(f"[{label}] 60x speed runs the clock faster than real time", sim("s.t") - t1 > 20, sim("s.t") - t1)
            page.locator("#sim_truth").check(); check(f"[{label}] 'show true obstacles' toggles", page.locator("#sim_truth").is_checked())
            click("reset"); adv(1); check(f"[{label}] RESET returns to a fresh idle simulation", sim("s.stats.distance") == 0 and cell("STATE").startswith("IDLE") and sim("s.events.length") <= 1, (cell("STATE"), sim("s.events.map(e=>e.type)"), sim("s.t")))
            page.select_option("#sim_scenario", "open_field"); page.select_option("#sim_speed", "60")

            # --- 15-minute offline test button ---
            click("offdemo"); done = False
            for _ in range(80):
                page.wait_for_timeout(500)
                if "Offline test finished" in msg(): done = True; break
            check(f"[{label}] 15-MIN OFFLINE TEST runs to completion", done, msg())
            check(f"[{label}] offline test: ran >= 10 simulated minutes with no server contact", sim("s.offlineSeconds()") >= 600 or sim("s.net === 'OFFLINE' && s.t - s.offlineSince") >= 600, (sim("s.offlineSeconds()"), sim("s.t")))
            check(f"[{label}] offline test: zero collisions", sim("s.stats.collisions") == 0)
            q = sim("s.pending().length"); click("link"); adv(40)
            check(f"[{label}] GO ONLINE after the test syncs all {q} queued events", q > 0 and sim("s.pending().length") == 0 and "synchronised" in msg(), (q, msg()))
            check(f"[{label}] no uncaught script errors during the whole session", not [e for e in errors if "sim" in e.lower()], errors[:3])
            ctx.close()
        # demo view must hide the lab
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}); ctx.route("**/*", lambda r: r.fulfill(status=200, content_type="application/javascript", body="/* stub */") if any(b in r.request.url for b in BLOCK) else (r.fulfill(status=200, content_type=mimetypes.guess_type(r.request.url.split('?')[0])[0] or "text/html", body=(PUBLIC / (r.request.url[len(BASE):].split('?')[0].lstrip('/') or 'index.html')).read_bytes()) if r.request.url.startswith(BASE) and (PUBLIC / (r.request.url[len(BASE):].split('?')[0].lstrip('/') or 'index.html')).is_file() else r.continue_() if r.request.url.startswith(BASE) else r.abort()))
        pg = ctx.new_page(); pg.goto(BASE + "/index.html?demo=1", wait_until="load"); pg.wait_for_timeout(800)
        check("demo view (?demo=1) hides the simulation lab", pg.locator("#simLabMount").is_hidden())
        ctx.close(); browser.close()
finally:
    if server.poll() is None: server.kill()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
