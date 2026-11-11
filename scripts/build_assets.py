#!/usr/bin/env python3
"""Build standalone WebP assets from embedded source data, with checked-in asset fallback."""
from __future__ import annotations

import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    "ROVER_DEVICE_IMAGE": (ROOT / "public/rover-device-photo.js", ROOT / "public/rover-device.webp"),
    "ROVER_LEFT_IMAGE": (ROOT / "public/rover-left-photo.js", ROOT / "public/rover-left.webp"),
}

def valid_webp(path: Path) -> bool:
    if not path.is_file():
        return False
    data = path.read_bytes()
    return len(data) >= 16 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"

for variable, (source_path, output_path) in ASSETS.items():
    marker = "data:image/webp;base64,"
    source_line = None
    if source_path.is_file():
        source_line = next(
            (line.strip() for line in source_path.read_text(encoding="utf-8").splitlines()
             if line.strip().startswith(f"window.{variable}=")),
            None,
        )

    if source_line and marker in source_line:
        encoded = source_line.split(marker, 1)[1].rsplit('"', 1)[0].rsplit("'", 1)[0]
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise SystemExit(f"Invalid embedded WebP data for {variable}: {exc}") from exc
        if len(data) < 16 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
            raise SystemExit(f"Decoded asset is not a valid WebP container: {output_path.name}")
        output_path.write_bytes(data)
        print(f"Generated {output_path.relative_to(ROOT)} ({len(data)} bytes) from embedded source")
    elif valid_webp(output_path):
        print(f"Using checked-in {output_path.relative_to(ROOT)} ({output_path.stat().st_size} bytes)")
    else:
        raise SystemExit(
            f"No embedded data URI for {variable} and no valid checked-in asset at "
            f"{output_path.relative_to(ROOT)}"
        )
