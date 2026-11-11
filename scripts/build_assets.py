#!/usr/bin/env python3
"""Build standalone WebP files from the checked-in rover reference assets.

The dashboard's app.js already points to /rover-device.webp and
/rover-left.webp. The original images are retained as data URIs in the
corresponding *-photo.js source files; extract them here during CI.
"""
from __future__ import annotations

import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    "ROVER_DEVICE_IMAGE": (
        ROOT / "public" / "rover-device-photo.js",
        ROOT / "public" / "rover-device.webp",
    ),
    "ROVER_LEFT_IMAGE": (
        ROOT / "public" / "rover-left-photo.js",
        ROOT / "public" / "rover-left.webp",
    ),
}

for variable, (source_path, output_path) in ASSETS.items():
    if not source_path.is_file():
        raise SystemExit(f"Missing source image file: {source_path.relative_to(ROOT)}")

    source = source_path.read_text(encoding="utf-8")
    pattern = r'window\\.' + re.escape(variable) + r'\\s*=\\s*["\\']data:image/webp;base64,([A-Za-z0-9+/=]+)["\\']'
    match = re.search(pattern, source)
    if not match:
        raise SystemExit(f"Missing embedded WebP data URI for {variable} in {source_path.name}")

    try:
        data = base64.b64decode(match.group(1), validate=True)
    except Exception as exc:
        raise SystemExit(f"Invalid embedded WebP data for {variable}: {exc}") from exc

    if len(data) < 16 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise SystemExit(f"Decoded asset is not a valid WebP container: {output_path.name}")

    output_path.write_bytes(data)
    print(f"Generated {output_path.relative_to(ROOT)} ({len(data)} bytes)")
