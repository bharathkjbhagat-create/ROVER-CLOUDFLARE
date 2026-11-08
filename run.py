"""Standalone Flask launcher for the DEFENX dashboard.

Cloudflare deployments continue to use src/worker.py. This launcher is for
local development or a conventional Python/WSGI host and does not alter the
existing dashboard assets or Cloudflare entrypoint.
"""
from __future__ import annotations

import os
from pathlib import Path
from flask import send_from_directory

from src.app import app, BASE_DIR

# Local HTTP development must allow the browser to return the signed session
# cookie. Production HTTPS hosts should set COOKIE_SECURE=1.
app.config["SESSION_COOKIE_SECURE"] = os.getenv("COOKIE_SECURE", "0").strip().lower() in {"1", "true", "yes", "on"}

# Cloudflare serves static assets through its Assets binding. A standalone
# Flask host needs a safe equivalent for all existing public assets.
@app.get("/<path:asset_path>")
def public_asset(asset_path: str):
    candidate = (Path(BASE_DIR) / asset_path).resolve()
    root = Path(BASE_DIR).resolve()
    if root not in candidate.parents or not candidate.is_file():
        return ("Not found", 404)
    return send_from_directory(root, asset_path)

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}
    app.run(host=host, port=port, debug=debug, threaded=True)
