#!/usr/bin/env bash
# Run DEFENX locally using the vendored Flask (no pip install needed). Set secrets in your shell first.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SESSION_SECRET:?set SESSION_SECRET}"; : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
PYTHONPATH="vendor:src${PYTHONPATH:+:$PYTHONPATH}" exec python src/app.py
