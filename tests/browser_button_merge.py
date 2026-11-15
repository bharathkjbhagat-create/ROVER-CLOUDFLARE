#!/usr/bin/env python3
"""Real-Chromium check of the merged dashboard controls (software only, no rover hardware).
Run: python tests/browser_button_merge.py   (needs Playwright + Chromium; not auto-discovered by unittest)"""
import json, os, socket, subprocess, sys, time, urllib.error, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]; PW = "merge-admin-pass-1"; results = []
def check(name, ok, detail=""):
    results.append(bool(ok)); print(("PASS " if ok else "FAIL ") + name + ("" if ok or not detail else " - " + str(detail)))
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close(); BASE = f"http://127.0.0.1:{port}"
env = dict(os.environ, SESSION_SECRET="s" * 40, ADMIN_USERNAME="ADMIN", ADMIN_PASSWORD=PW, FLEET_MASTER_SECRET="m" * 40, PYTHONPATH=str(ROOT / "src"))
srv = subprocess.Popen([sys.executable, "-c", f"import sys;sys.path.insert(0,{str(ROOT)!r});import run;run.app.config['SESSION_COOKIE_SECURE']=False;run.app.run(host='127.0.0.1',port={port},threaded=True,use_reloader=False)"],
                       cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try: urllib.request.urlopen(BASE + "/api/health", timeout=1); break
        except urllib.error.HTTPError: break
        except Exception: time.sleep(0.3)
    with sync_playwright() as p:
        br = p.chromium.launch()
        for label, vp in (("desktop", {"width": 1440, "height": 900}), ("mobile", {"width": 390, "height": 844})):
            ctx = br.new_context(viewport=vp); pg = ctx.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
            pg.request.post(BASE + "/api/login", data=json.dumps({"username": "ADMIN", "password": PW}), headers={"Content-Type": "application/json"})
            pg.goto(BASE + "/index.html"); pg.wait_for_timeout(3000)
            q = lambda js: pg.evaluate(js)
            check(f"[{label}] exactly one RETURN TO BASE button", q("()=>[...document.querySelectorAll('button')].filter(b=>/RETURN TO BASE/i.test(b.textContent)).length") == 1)
            check(f"[{label}] duplicate Center/Screenshot quick actions are gone", q("()=>!document.getElementById('quickCenterBtn')&&!document.getElementById('screenShotBtn')"))
            check(f"[{label}] map center + camera screenshot controls still present", q("()=>!!document.getElementById('recenterCrossBtn')&&!!document.getElementById('camShotBtn')"))
            check(f"[{label}] camera icon buttons have accessible names", q("()=>['camShotBtn','camRecordBtn','camFullscreenBtn'].every(i=>(document.getElementById(i).getAttribute('aria-label')||'').length>3)"))
            check(f"[{label}] no duplicate DOM ids", q("()=>{const a=[...document.querySelectorAll('[id]')].map(e=>e.id);return a.length===new Set(a).size}"))
            check(f"[{label}] no horizontal overflow", q("()=>document.documentElement.scrollWidth<=innerWidth"))
            # quick actions: all remaining buttons visible & inside the viewport once opened
            q("()=>{const d=document.getElementById('quickActionsSection');if(d)d.open=true}"); pg.wait_for_timeout(300)
            check(f"[{label}] quick-action buttons laid out inside the viewport", q("()=>[...document.querySelectorAll('.quickGrid button')].every(b=>{const r=b.getBoundingClientRect();return r.width>20&&r.left>=0&&r.right<=innerWidth+1})"))
            # confirmation on fleet return-to-base: stub the fleet API, dismiss then accept the dialog
            q("()=>{window.__rtb=0;window.DEFENX_FLEET={active:()=>true,returnToBase:async()=>{window.__rtb++;return{ok:true}}}}")
            pg.once("dialog", lambda d: d.dismiss())
            pg.evaluate("()=>document.getElementById('returnToBaseBtn').click()"); pg.wait_for_timeout(300)
            check(f"[{label}] declining the confirmation sends NO return command", q("()=>window.__rtb")==0)
            check(f"[{label}] declining shows a cancelled status", "CANCELLED" in (q("()=>document.getElementById('returnBaseStatus').textContent") or "").upper())
            msgs = []
            pg.once("dialog", lambda d: (msgs.append(d.message), d.accept()))
            pg.evaluate("()=>document.getElementById('returnToBaseBtn').click()"); pg.wait_for_timeout(500)
            check(f"[{label}] accepting sends exactly one return command", q("()=>window.__rtb")==1)
            check(f"[{label}] confirmation warns about the emergency stop", msgs and "EMERGENCY STOP" in msgs[0], msgs)
            real = [e for e in errs]
            check(f"[{label}] no uncaught page errors", not real, real[:2])
            ctx.close()
        br.close()
finally:
    srv.kill()
print(f"{sum(results)}/{len(results)} browser checks passed"); sys.exit(0 if all(results) else 1)

