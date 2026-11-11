#!/usr/bin/env python3
"""Build standalone WebP files from the checked-in rover reference assets."""
from __future__ import annotations

import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    "ROVER_DEVICE_IMAGE": (ROOT / "public/rover-device-photo.js", ROOT / "public/rover-device.webp"),
    "ROVER_LEFT_IMAGE": (ROOT / "public/rover-left-photo.js", ROOT / "public/rover-left.webp"),
}

for variable, (source_path, output_path) in ASSETS.items():
    if not source_path.is_file():
        raise SystemExit(f"Missing source image file: {source_path.relative_to(ROOT)}")

    source_line = next(
        (line.strip() for line in source_path.read_text(encoding="utf-8").splitlines()
         if line.strip().startswith(f"window.{variable}=")),
        None,
    )
    marker = "data:image/webp;base64,"
    if source_line is None or marker not in source_line:
        raise SystemExit(f"Missing embedded WebP data URI for {variable} in {source_path.name}")

    encoded = source_line.split(marker, 1)[1].rsplit('"', 1)[0].rsplit("'", 1)[0]
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise SystemExit(f"Invalid embedded WebP data for {variable}: {exc}") from exc

    if len(data) < 16 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise SystemExit(f"Decoded asset is not a valid WebP container: {output_path.name}")

    output_path.write_bytes(data)
    print(f"Generated {output_path.relative_to(ROOT)} ({len(data)} bytes)")
