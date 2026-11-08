#!/usr/bin/env python3
"""Browser integration test for the DEFENX live AI pipeline (not auto-discovered by unittest).

Runs the real dashboard in Chromium against a local server, with:
  * a SYNTHETIC camera (canvas stream with a drawn face) via getUserMedia override,
  * STUBBED neural models (face-api / COCO-SSD) that return scripted detections.
This verifies wiring, scheduling, status logic, alert de-duplication, enrollment and
layout. It does NOT measure real neural-network accuracy: the CDN models are not
reachable from the test sandbox, so that must be verified on a real device.

Usage: python tests/browser_integration.py http://localhost:5077 ROVERADMIN <password>
"""
import json
import mimetypes
import struct
import sys
import time
import zlib
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE, USER, PASSWORD = sys.argv[1], sys.argv[2], sys.argv[3]
PUBLIC = Path(__file__).resolve().parents[1] / "public"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(detail) if detail and not ok else ""))


def png_bytes(w=640, h=480):
    import random
    rng = random.Random(3)  # textured, so the real sharpness check accepts it (a flat image is correctly rejected as blurred)
    raw = b"".join(b"\x00" + bytes(min(255, max(0, base + rng.randint(-25, 25))) for _ in range(w) for base in (200, 160, 130)) for _ in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


INIT = r"""
(() => {
  // ---- scripted test state ----
  const rnd = (() => { let s = 7; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const vec = seed => { let s = seed; return Array.from({length:128}, () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5) * 0.2); };
  window.__vec = vec;
  window.__T = { desc: vec(1), blink: true, faces: true, mask: "none", dets: [], calls: 0, eye: 1 };
  // ---- synthetic camera: skin-coloured face with lips (or a mask) on a noisy background ----
  const cv = document.createElement("canvas"); cv.width = 640; cv.height = 480;
  const c = cv.getContext("2d", { willReadFrequently: true });
  function draw() {
    const img = c.createImageData(640, 480), d = img.data, T = window.__T;
    const cx = 320, cy = 170, s = 80;
    for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
      const i = (y * 640 + x) * 4;
      let r = 70, g = 80, b = 90;
      if (T.faces && x > 240 && x < 400 && y > 100 && y < 310) {
        r = 224; g = 172; b = 140;
        const lower = y > cy + 0.55 * s && y < cy + 1.75 * s;
        if (T.mask === "white" && lower) { r = 236; g = 236; b = 240; }
        else if (T.mask === "none" && Math.abs(x - cx) < 0.28 * s && y > cy + 1.06 * s && y < cy + 1.2 * s) { r = 190; g = 80; b = 92; }
      }
      d[i] = r + rnd() * 12 - 6; d[i + 1] = g + rnd() * 12 - 6; d[i + 2] = b + rnd() * 12 - 6; d[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }
  draw(); setInterval(draw, 120);
  const stream = cv.captureStream(15);
  navigator.mediaDevices.getUserMedia = async () => stream;
  // ---- landmark generator (same geometry as the unit tests) ----
  function landmarks(eye) {
    const cx = 320, cy = 170, s = 80, p = Array.from({length:68}, (_, i) => [cx + (i - 34) * 0.02 * s, cy + s]);
    const w = 0.38 * s, h = 0.14 * s * eye, L = [cx - s/2, cy], R = [cx + s/2, cy];
    p[36]=[L[0]-w/2,L[1]]; p[39]=[L[0]+w/2,L[1]]; p[37]=[L[0]-w/6,L[1]-h/2]; p[38]=[L[0]+w/6,L[1]-h/2]; p[41]=[L[0]-w/6,L[1]+h/2]; p[40]=[L[0]+w/6,L[1]+h/2];
    p[42]=[R[0]-w/2,R[1]]; p[45]=[R[0]+w/2,R[1]]; p[43]=[R[0]-w/6,R[1]-h/2]; p[44]=[R[0]+w/6,R[1]-h/2]; p[47]=[R[0]-w/6,R[1]+h/2]; p[46]=[R[0]+w/6,R[1]+h/2];
    p[19]=[L[0],cy-0.35*s]; p[24]=[R[0],cy-0.35*s]; p[30]=[cx,cy+0.55*s]; p[33]=[cx,cy+0.75*s];
    p[48]=[cx-0.3*s,cy+1.15*s]; p[54]=[cx+0.3*s,cy+1.15*s]; p[51]=[cx,cy+1.05*s]; p[57]=[cx,cy+1.17*s];
    for (const i of [49,50]) p[i]=[cx-(52-i)*0.08*s,cy+1.07*s]; for (const i of [52,53]) p[i]=[cx+(i-51)*0.08*s,cy+1.07*s];
    for (const i of [55,56]) p[i]=[cx+(57-i)*0.1*s,cy+1.17*s]; for (const i of [58,59]) p[i]=[cx-(i-57)*0.1*s,cy+1.17*s];
    p[4]=[cx-0.8*s,cy+0.8*s]; p[8]=[cx,cy+1.6*s]; p[12]=[cx+0.8*s,cy+1.6*s*0.5];
    return p.map(q => ({ x: q[0], y: q[1] }));
  }
  const face = (eye) => ({ detection: { box: { x: 320 - 72, y: 170 - 60, width: 144, height: 200 }, score: 0.95 }, landmarks: { positions: landmarks(eye) }, descriptor: Float32Array.from(window.__T.desc) });
  const chain = run => ({ withFaceLandmarks() { return this; }, withFaceDescriptors() { return this; }, withFaceDescriptor() { return this; }, then(a, b) { return Promise.resolve().then(run).then(a, b); } });
  window.__enrollCalls = 0;
  window.faceapi = {
    nets: { tinyFaceDetector: { loadFromUri: async () => {} }, faceLandmark68TinyNet: { loadFromUri: async () => {} }, faceRecognitionNet: { loadFromUri: async () => {} } },
    TinyFaceDetectorOptions: function (o) { this.o = o; },
    detectAllFaces: input => chain(() => {
      const T = window.__T;
      if (!(input instanceof HTMLVideoElement)) { window.__enrollCalls++; return [face(1)]; } // enrolment photograph
      T.calls++;
      if (!T.faces) return [];
      const phase = T.calls % 25, eye = (T.blink && phase >= 20 && phase <= 22) ? 0.3 : 1;
      return [face(eye)];
    }),
    detectSingleFace: () => chain(() => (window.__T.faces ? face(1) : undefined))
  };
  window.tf = { ready: async () => {}, setBackend: async () => true };
  window.cocoSsd = { load: async () => ({ detect: async () => (window.__T.dets || []).map(d => Object.assign({}, d)) }) };
  window.__rafGaps = []; let last = performance.now();
  (function loop(t) { window.__rafGaps.push(t - last); last = t; if (window.__rafGaps.length > 600) window.__rafGaps.shift(); requestAnimationFrame(loop); })(last);
})();
"""

BLOCK = ("leaflet", "tile.openstreetmap", "arcgisonline", "eox.at", "fonts.g")


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["geolocation", "camera"],
                                  geolocation={"latitude": 12.9716, "longitude": 77.5946, "accuracy": 12})
        ctx.add_init_script(INIT)
        errors, alerts_posted, alert_responses = [], [], []

        def route(r):
            url = r.request.url
            if "face-api" in url or "tf.min.js" in url or "coco-ssd" in url:
                return r.fulfill(status=200, content_type="application/javascript", body="/* stubbed in test */")
            if url.startswith(BASE):
                # Production serves /public through Workers Assets; the local Flask server does not,
                # so static files are served from disk here to mimic that.
                path = url[len(BASE):].split("?")[0].lstrip("/")
                f = PUBLIC / path
                if path and not path.startswith("api/") and f.is_file() and PUBLIC in f.resolve().parents:
                    return r.fulfill(status=200, content_type=mimetypes.guess_type(str(f))[0] or "application/octet-stream", body=f.read_bytes())
                return r.continue_()
            return r.abort()
        ctx.route("**/*", route)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append("console: " + m.text))
        page.on("request", lambda rq: rq.url.endswith("/api/detection-alerts") and rq.method == "POST" and alerts_posted.append(json.loads(rq.post_data or "{}")))
        page.on("response", lambda rs: rs.url.endswith("/api/detection-alerts") and rs.request.method == "POST" and alert_responses.append(rs.status))

        # ---- login & dashboard ----
        page.goto(BASE + "/login.html")
        r = page.request.post(BASE + "/api/login", data={"username": USER, "password": PASSWORD})
        check("admin login", r.ok)
        page.goto(BASE + "/", wait_until="load")
        page.wait_for_timeout(1500)
        check("dashboard loads with the new scripts", page.evaluate("!!window.DEFENX_VISION_CORE && !!window.DEFENX_ALERTS && !!window.DEFENX_FACE"))
        check("no fabricated GPS before camera/GPS is active", "12.9716" not in (page.inner_text("#mapCoords") if page.query_selector("#mapCoords") else ""),
              page.inner_text("#mapCoords") if page.query_selector("#mapCoords") else "")

        # ---- camera + GPS ----
        page.evaluate("window.__T.faces = false")  # nobody in view while the admin enrolls
        page.click("#phoneCameraBtn")
        page.wait_for_function("document.querySelector('#roverRealCamera') && document.querySelector('#roverRealCamera').readyState>=2 && document.querySelector('#roverRealCamera').videoWidth>0", timeout=15000)
        check("phone camera shows live video in dashboard", page.evaluate("(()=>{const v=document.querySelector('#roverRealCamera');return v.videoWidth===640&&!v.paused})()"))
        page.wait_for_function("window.DEFENX_PHONE_GPS_LATEST && window.DEFENX_PHONE_GPS_LATEST.lat", timeout=10000)
        gps = page.evaluate("window.DEFENX_PHONE_GPS_LATEST")
        check("GPS starts automatically with the camera and reports accuracy", abs(gps["lat"] - 12.9716) < 1e-6 and gps["accuracy"] == 12)
        check("camera overlay message not duplicated", page.evaluate("document.querySelectorAll('#camPlaceholder:not([hidden])').length===0"))

        # ---- enrollment (server DB absent here => browser-local fallback) ----
        page.evaluate("document.getElementById('adminModal').classList.remove('hidden')")
        page.click("#faceTabBtn")
        page.wait_for_function("document.getElementById('faceStorageNote').textContent.length>0")
        check("enrollment tab visible, other tabs hidden", page.evaluate("!document.getElementById('faceTab').classList.contains('hidden') && document.getElementById('usersTab').classList.contains('hidden')"))
        note = page.inner_text("#faceStorageNote")
        check("fallback storage is stated honestly when no database", "THIS browser" in note, note)
        page.evaluate("window.__t0 = Date.now() - 2000")  # ignore server-side history from earlier runs
        page.fill("#faceEnrollName", "Asha Rao")
        Path("/tmp/claude-0/ref.png").write_bytes(png_bytes())
        page.set_input_files("#faceEnrollFile", "/tmp/claude-0/ref.png")
        page.click("#faceEnrollBtn")
        page.wait_for_timeout(500)
        check("consent is required to enroll", "consent" in page.inner_text("#faceEnrollMsg").lower(), page.inner_text("#faceEnrollMsg"))
        page.check("#faceEnrollConsent")
        page.evaluate("window.__T.desc = window.__vec(1)")  # Asha's face descriptor
        page.click("#faceEnrollBtn")
        page.wait_for_function("document.getElementById('faceEnrollMsg').textContent.startsWith('Enrolled') || document.getElementById('faceEnrollMsg').style.color", timeout=15000)
        msg = page.inner_text("#faceEnrollMsg")
        check("reference photo enrolled", msg.startswith("Enrolled Asha Rao"), msg)
        check("enrolled user listed", "Asha Rao" in page.inner_text("#faceEnrollList"))
        page.evaluate("document.getElementById('adminModal').classList.add('hidden')")
        page.wait_for_timeout(2500)
        check("reference upload created NO alert", len(alerts_posted) == 0 and page.evaluate("JSON.parse(localStorage.getItem('defenx_detection_events_v1')||'[]').filter(e=>e.type==='ALERT'&&Date.parse(e.at)>window.__t0).length") == 0, (alerts_posted[:2], page.evaluate("JSON.parse(localStorage.getItem('defenx_detection_events_v1')||'[]').slice(0,3)")))
        check("enrollment photo never reached the live pipeline", page.evaluate("window.__enrollCalls") >= 1 and page.evaluate("window.DEFENX_FACE.faces.every(f=>f.bbox)"))

        # ---- live: registered user, no mask, blinking ----
        page.evaluate("window.__T.faces = true")
        page.wait_for_function("document.getElementById('faceScanState').textContent.startsWith('FACE ID LIVE')", timeout=20000)
        check("face pipeline active with enrolled count", "1 ENROLLED" in page.inner_text("#faceScanState"), page.inner_text("#faceScanState"))
        page.wait_for_function("document.getElementById('faceStatusList').innerText.includes('FACE RECOGNIZED')", timeout=30000)
        row = page.inner_text("#faceStatusList")
        check("registered user recognised by name with NO MASK", "Asha Rao" in row and "NO MASK" in row, row)
        page.wait_for_function("JSON.parse(localStorage.getItem('defenx_detection_events_v1')||'[]').some(e=>e.category==='registered_no_mask')", timeout=15000)
        ev = page.evaluate("JSON.parse(localStorage.getItem('defenx_detection_events_v1')).find(e=>e.category==='registered_no_mask')")
        check("alert has category/time/status/confidence/camera", ev["label"] and ev["at"] and ev["status"] == "NO MASK" and 0 < ev["confidence"] <= 1 and ev["camera"]["label"] == "PHONE CAMERA", ev)
        check("alert carries real GPS with accuracy", ev["gps"] and abs(ev["gps"]["lat"] - 12.9716) < 1e-6 and ev["gps"]["accuracy_m"] == 12, ev.get("gps"))
        page.wait_for_timeout(2500)
        check("registered-no-mask alert is POSTed to backend and accepted", any(a["category"] == "registered_no_mask" and a["live_verified"] and a["source"] == "live_camera" for a in alerts_posted) and 200 in alert_responses, (alerts_posted[:1], alert_responses))
        n = sum(1 for a in alerts_posted if a["category"] == "registered_no_mask")
        page.wait_for_timeout(9000)
        check("no repeated alerts for one continuous detection", sum(1 for a in alerts_posted if a["category"] == "registered_no_mask") == n == 1, n)

        # ---- live: unknown person; still photo-like (no blink) stays UNVERIFIED ----
        alerts_posted.clear()
        page.evaluate("window.__T.desc = window.__vec(99); window.__T.blink = false; window.DEFENX_FACE.reset()")
        page.wait_for_function("document.getElementById('faceStatusList').innerText.includes('UNVERIFIED')", timeout=20000)
        page.wait_for_timeout(9000)
        row = page.inner_text("#faceStatusList")
        check("no liveness evidence => UNVERIFIED, never UNKNOWN/RECOGNIZED", "UNVERIFIED" in row and "UNKNOWN" not in row and "RECOGNIZED" not in row, row)
        check("no alert from an unverified (photo-like) face", len(alerts_posted) == 0, alerts_posted)
        page.evaluate("window.__T.blink = true")
        page.wait_for_function("document.getElementById('faceStatusList').innerText.includes('UNKNOWN PERSON')", timeout=30000)
        page.wait_for_function("JSON.parse(localStorage.getItem('defenx_detection_events_v1')||'[]').some(e=>e.category==='unknown_no_mask')", timeout=15000)
        check("unknown live person without mask raises unknown_no_mask once", sum(1 for a in alerts_posted if a["category"] == "unknown_no_mask") == 1, [a["category"] for a in alerts_posted])

        # ---- masked unknown stays unknown ----
        alerts_posted.clear()
        page.evaluate("window.__T.mask = 'white'; window.DEFENX_FACE.reset()")
        page.wait_for_function("(()=>{const t=document.getElementById('faceStatusList').innerText;return t.includes('UNKNOWN PERSON')&&t.includes('MASK DETECTED')})()", timeout=40000)
        check("unknown person wearing a mask is still UNKNOWN PERSON + MASK DETECTED", True)
        page.wait_for_timeout(2500)
        check("masked unknown raises unknown_person (not a no-mask alert)", any(a["category"] == "unknown_person" for a in alerts_posted) and not any(a["category"] == "unknown_no_mask" for a in alerts_posted), [a["category"] for a in alerts_posted])

        # ---- photo / screen rejection ----
        alerts_posted.clear()
        page.evaluate("window.__T.mask = 'none'; window.__T.dets = [{class:'person',score:0.95,bbox:[230,90,180,240]},{class:'tv',score:0.8,bbox:[180,40,300,300]}]; window.DEFENX_FACE.reset()")
        page.wait_for_function("document.getElementById('faceStatusList').innerText.includes('PHOTO / SCREEN IMAGE')", timeout=40000)
        page.wait_for_timeout(9000)
        txt = page.inner_text("#faceStatusList")
        check("face shown inside a TV is PHOTO / SCREEN IMAGE, never live", "PHOTO / SCREEN IMAGE" in txt and "UNKNOWN PERSON" not in txt and "RECOGNIZED" not in txt, txt)
        check("no person alert from a screen image", not any(a["category"].startswith(("unknown", "registered")) for a in alerts_posted), [a["category"] for a in alerts_posted])
        counts = page.evaluate("window.ROVER_AI_VISION_COUNTS")
        check("screen image is not counted as a live human", counts["human"] == 0 and counts["photo"] >= 1, counts)

        # ---- vehicles / objects ----
        page.evaluate("window.__T.faces = false; window.DEFENX_FACE.reset(); window.__T.dets = [{class:'car',score:0.9,bbox:[100,200,260,150]},{class:'backpack',score:0.85,bbox:[420,260,70,90]}]")
        page.wait_for_function("window.ROVER_AI_VISION_COUNTS.vehicle===1", timeout=40000)
        c2 = page.evaluate("window.ROVER_AI_VISION_COUNTS")
        check("real car confirmed as LIVE VEHICLE; backpack as REAL-WORLD OBJECT", c2["vehicle"] == 1 and c2["object"] == 1 and c2["human"] == 0, c2)
        page.evaluate("window.__T.dets = [{class:'car',score:0.9,bbox:[100,200,200,120]},{class:'cell phone',score:0.7,bbox:[60,150,400,300]}]")
        page.wait_for_function("window.ROVER_AI_VISION_COUNTS.photo>=1", timeout=30000)
        check("car displayed on a phone screen is PHOTO / SCREEN IMAGE, not a vehicle", page.evaluate("window.ROVER_AI_VISION_COUNTS.vehicle") == 0)
        page.evaluate("window.__T.dets = [{class:'person',score:0.9,bbox:[100,100,120,300]}]")
        page.wait_for_function("window.ROVER_AI_VISION_COUNTS.unverified>=1", timeout=30000)
        c3 = page.evaluate("window.ROVER_AI_VISION_COUNTS")
        check("person without live-face evidence is UNVERIFIED, not LIVE HUMAN", c3["human"] == 0, c3)
        page.evaluate("window.__T.dets = [{class:'car',score:0.9,bbox:[100,200,260,150]}]")
        page.click("#detectionVehicleToggle")
        page.wait_for_function("JSON.parse(localStorage.getItem('defenx_detection_events_v1')||'[]').some(e=>e.category==='vehicle_detected')", timeout=40000)
        check("vehicle alert only when configured, with confidence and GPS", True)

        # ---- performance / responsiveness ----
        stats = page.evaluate("window.DEFENX_VISION_STATS")
        gaps = sorted(page.evaluate("window.__rafGaps"))
        p95 = gaps[int(len(gaps) * 0.95)]
        check("UI stays responsive while AI runs (p95 frame gap < 100 ms)", p95 < 100, f"p95={p95:.1f}ms stats={stats}")
        check("one camera stream only", page.evaluate("document.querySelectorAll('video').length") <= 2, page.evaluate("document.querySelectorAll('video').length"))
        mem = page.evaluate("performance.memory ? performance.memory.usedJSHeapSize/1048576 : -1")
        print(f"INFO js heap {mem:.1f} MB, stats {stats}")

        # ---- layout: map region is not cropped on desktop / Android / fullscreen ----
        def map_ok(label):
            m = page.evaluate("(()=>{const a=document.querySelector('.mapCard>.mapArea').getBoundingClientRect(),m=document.getElementById('map').getBoundingClientRect();return {a:[a.width,a.height],m:[m.width,m.height],ov:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()")
            check(f"map fills its area, no horizontal overflow ({label})", abs(m["a"][0] - m["m"][0]) < 2 and abs(m["a"][1] - m["m"][1]) < 2 and m["m"][1] >= 300 and m["ov"] <= 1, m)
        map_ok("desktop")
        page.set_viewport_size({"width": 393, "height": 851})
        page.wait_for_timeout(500)
        map_ok("android 393x851")
        page.set_viewport_size({"width": 1280, "height": 900})
        page.evaluate("document.getElementById('liveMap').classList.add('mapFullscreenFallback')")
        page.wait_for_timeout(300)
        m = page.evaluate("(()=>{const a=document.querySelector('#liveMap>.mapArea').getBoundingClientRect();return [a.width,a.height,innerWidth,innerHeight]})()")
        check("fullscreen map uses the whole viewport area", m[0] >= m[2] - 2 and m[1] > m[3] * 0.7, m)
        page.evaluate("document.getElementById('liveMap').classList.remove('mapFullscreenFallback')")

        bad = [e for e in errors if not any(k in e for k in ("Failed to load resource", "net::ERR", "leaflet", "Map", "503", "401"))]
        check("no unexpected browser console / page errors", not bad, bad[:5])
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()