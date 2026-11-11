# Vendored Flask (for local/offline runs and tests)

Flask 3.1.3, Werkzeug 3.1.9, Jinja2 3.1.6, MarkupSafe 3.0.4 (pure-Python fallback, C speedups removed), ItsDangerous 2.2.0, Click 8.5.0, Blinker 1.9.0.
Copied unmodified from a working install, with their licences (see each `*.dist-info/`). Pure Python, so they run on any OS.

Use: `PYTHONPATH=vendor:src python src/app.py` (or `scripts/run_local.sh`).
Cloudflare deployment is unchanged: `pywrangler`/`pyproject.toml` still resolve Flask for the Worker; this folder is **not** deployed.
Update by re-copying from a newer `pip install flask`; check security advisories first.
