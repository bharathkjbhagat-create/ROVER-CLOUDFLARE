#!/usr/bin/env python3
"""Materialize the embedded ROVER WebP assets for Cloudflare deployment.

The dashboard keeps the original images embedded in public/app.js so the
repository remains text-only and Git-friendly. CI converts those data URIs
into real .webp files before Wrangler uploads the Workers Assets bundle.
"""
from __future__ import annotations

import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "public" / "app.js"

ASSETS = {
    "ROVER_DEVICE_IMAGE": ROOT / "public" / "rover-device.webp",
    "ROVER_LEFT_IMAGE": ROOT / "public" / "rover-left.webp",
}

source = APP_JS.read_text(encoding="utf-8")

for variable, output in ASSETS.items():
    pattern = rf'window\\.{re.escape(variable)}="data:image/webp;base64,([^"]+)"'
    match = re.search(pattern, source)
    if not match:
        raise SystemExit(f"Missing embedded WebP data URI: window.{variable}")

    try:
        data = base64.b64decode(match.group(1), validate=True)
    except Exception as exc:
        raise SystemExit(f"Invalid embedded WebP data for {variable}: {exc}") from exc

    if not data.startswith(b"RIFF") or data[8:12] != b"WEBP":
        raise SystemExit(f"Decoded asset is not a WebP file: {output.name}")

    output.write_bytes(data)
    print(f"Generated {output.relative_to(ROOT)} ({len(data)} bytes)")
