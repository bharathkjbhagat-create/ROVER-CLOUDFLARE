#!/usr/bin/env python3
"""Fail CI when frontend assets exceed agreed transfer-size budgets.

Run after scripts/build_assets.py so embedded WebP images have been externalized.
These are source-size guardrails, not a substitute for browser or load testing.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
BUDGETS = {
    "public/app.js": 93_000,  # map layers, rover tracking, route preview, camera flip (already compacted by build_assets.py; was 91_000)
    "public/style.css": 120_000,
    "public/ai-vision.js": 24_000,  # unified object + face scheduler, verdict rendering
    "public/local-vision.js": 24_000,  # shared loopback scheduler for YOLO and face scanning
    "public/vision-core.js": 22_000,
    "public/face-recognition.js": 24_000,
    "public/detection-events.js": 16_000,
    "public/index.html": 30_000,
    "public/sim-lab-loader.js": 2_500,  # only file loaded up front; the lab itself loads on demand
    "public/sim-core.js": 42_000,  # on demand
    "public/sim-lab.js": 30_000,  # on demand
    "public/sim-lab.css": 5_000,  # on demand
}
failed = False

for relative, budget in BUDGETS.items():
    path = ROOT / relative
    if not path.is_file():
        print(f"FAIL {relative}: missing")
        failed = True
        continue
    size = path.stat().st_size
    status = "PASS" if size <= budget else "FAIL"
    print(f"{status} {relative}: {size:,} bytes / {budget:,}-byte budget")
    if size > budget:
        failed = True

app_js = ROOT / "public/app.js"
if app_js.is_file():
    source = app_js.read_text(encoding="utf-8")
    if re.search(r'data:image/(?:webp|png|jpeg|jpg);base64,', source, re.I):
        print("FAIL public/app.js: embedded raster image remains in JavaScript")
        failed = True
    else:
        print("PASS public/app.js: no embedded raster data URI")

if failed:
    sys.exit(1)
print("Frontend performance budgets: PASS")
