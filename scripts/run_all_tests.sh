#!/usr/bin/env bash
# Runs every automated check. Exits non-zero on the first failure. No hardware needed.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PYTHON:-$(command -v python3 || command -v python)}"
echo "== Python unit/regression tests =="; "$PY" -m unittest discover -s tests -p 'test_*.py'
echo "== Existing smoke + vision tests =="; "$PY" tests/smoke.py; node tests/vision_core.test.js | tail -3
echo "== Protocol cross-language test =="; node --test tests/fleet_protocol.test.js | grep -E "^# (pass|fail)"
echo "== Simulation core + presentation-attack tests =="; node --test tests/sim_core.test.js tests/spoof_attacks.test.js tests/browser_vision_sync.test.js | grep -E "^# (pass|fail)"
echo "== Performance budgets =="; "$PY" scripts/check_performance_budget.py | tail -1
echo "== JS syntax checks =="; for f in public/*.js; do node --check "$f"; done
echo "== Firmware navigation simulation (C++) =="; g++ -std=c++17 -O1 -Wall -Wextra -Ifirmware/rover_core firmware/test/sim_test.cpp -o /tmp/defenx_sim_test && /tmp/defenx_sim_test | tail -3
diff -q firmware/rover_core/nav_core.h firmware/esp32_rover/nav_core.h
echo "== Multi-process two-client integration =="; "$PY" tests/integration_two_clients.py 2>&1 | tail -4
echo "== Browser dashboard test (needs playwright chromium) =="; "$PY" tests/browser_fleet_dashboard.py | tail -2
echo "== Simulation Lab browser test (every control, offline test, RTB, map overlay) =="; "$PY" tests/browser_sim_lab.py | tail -2
echo "== Camera view browser test (fake camera device) =="; "$PY" tests/browser_camera_check.py | tail -1
echo "== Merged-controls browser test (desktop + mobile) =="; "$PY" tests/browser_button_merge.py | tail -1
echo "== Secret scan =="; ! grep -RInE "(FLEET_MASTER_SECRET|DEVICE_SECRET|SESSION_SECRET)\s*=\s*['\"][A-Za-z0-9_-]{20,}" --include='*.py' --include='*.js' --include='*.h' --include='*.ino' --include='*.jsonc' . | grep -v tests/
echo ALL CHECKS PASSED

