"""Audit Flask routes with safe, non-mutating local dispatch probes.

GET/HEAD routes are probed without credentials; write-only routes receive
OPTIONS only. Cloudflare-binding-only database health is verified by the
deployed Worker smoke test, not by Flask's local test client.
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

os.environ.setdefault("SESSION_SECRET", "defenx-route-audit-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "defenx-route-audit-test-password")
os.environ.setdefault("ROVER_DEVICE_TOKEN", "defenx-route-audit-device-token")

import app as rover_app  # noqa: E402

app = rover_app.app
client = app.test_client()


def sample_path(rule):
    path = rule.rule
    # The catch-all serves files from public/. Use a known, harmless asset
    # rather than a made-up path that correctly returns 404.
    if rule.endpoint == "fleet_static" and "<path:" in path:
        return path.split("<path:", 1)[0] + "app.js"
    path = re.sub(r"<int:[^>]+>", "1", path)
    path = re.sub(r"<float:[^>]+>", "1.0", path)
    path = re.sub(r"<uuid:[^>]+>", "00000000-0000-4000-8000-000000000000", path)
    path = re.sub(r"<path:[^>]+>", "app.js", path)
    path = re.sub(r"<string:[^>]+>", "route-audit-probe", path)
    path = re.sub(r"<[^>]+>", "route-audit-probe", path)
    return path


rules = sorted(
    (rule for rule in app.url_map.iter_rules() if rule.endpoint != "static"),
    key=lambda rule: (rule.rule, rule.endpoint),
)
assert rules, "No application routes were registered"

seen = set()
failures = []
skipped = 0
for rule in rules:
    key = (rule.rule, rule.endpoint)
    if key in seen:
        failures.append(f"duplicate route registration: {rule.rule} ({rule.endpoint})")
        continue
    seen.add(key)

    # This handler requires Cloudflare Hyperdrive, which is intentionally not
    # available in Flask's local test client. The deployed smoke test checks it.
    if rule.endpoint == "database_health":
        skipped += 1
        print("SKIP GET     /api/health/database (Cloudflare Hyperdrive integration; checked by deployed smoke test)")
        continue

    path = sample_path(rule)
    methods = set(rule.methods or ())
    method = "GET" if "GET" in methods else "HEAD" if "HEAD" in methods else "OPTIONS"
    try:
        response = client.open(path, method=method, follow_redirects=False)
        code = response.status_code
        if code in (404, 405) or code >= 500:
            failures.append(
                f"{method} {path} -> HTTP {code} "
                f"(endpoint={rule.endpoint}, registered_methods={','.join(sorted(methods))})"
            )
        else:
            print(f"PASS {method:7} {path:48} HTTP {code:3} {rule.endpoint}")
    except Exception as exc:  # surface route-specific exceptions as audit failures
        failures.append(f"{method} {path} raised {type(exc).__name__}: {exc}")

if failures:
    print("\\nROUTE AUDIT FAILURES:")
    for failure in failures:
        print("FAIL " + failure)
    raise SystemExit(1)

print(
    f"DEFENX route registry audit: PASS "
    f"({len(rules)} registered routes; {skipped} Cloudflare-only integration route "
    "deferred to deployed smoke tests; no write requests sent)"
)
