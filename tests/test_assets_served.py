"""Every local script/stylesheet/image the HTML pages reference must be served by the Flask app.

Regression for: the single-segment fleet route used to shadow public assets with a JSON 404 when the app
ran locally (run.py / scripts/run_local.sh), which silently broke face recognition, the monitor, etc.
On Cloudflare the Workers Assets binding serves these paths, so this test protects the standalone host.
"""
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "vendor"))
os.environ.setdefault("SESSION_SECRET", "s" * 40)
os.environ.setdefault("ADMIN_PASSWORD", "asset-test-password-1")

import app as app_module  # noqa: E402

PAGES = ("index.html", "login.html", "device-client.html")
REF = re.compile(r'(?:src|href)="(/[A-Za-z0-9._-]+\.(?:js|css|svg|png|webp|webmanifest))(?:\?[^"]*)?"')


class PublicAssetsServed(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_every_referenced_asset_exists_and_is_served(self):
        seen = set()
        for page in PAGES:
            html = (ROOT / "public" / page).read_text(encoding="utf-8")
            for ref in REF.findall(html):
                seen.add(ref)
        self.assertGreater(len(seen), 10, "expected the pages to reference many assets")
        for ref in sorted(seen):
            with self.subTest(asset=ref):
                self.assertTrue((ROOT / "public" / ref.lstrip("/")).is_file(), f"{ref} is referenced but missing on disk")
                resp = self.client.get(ref)
                self.assertEqual(resp.status_code, 200, f"{ref} not served")
                self.assertGreater(len(resp.data), 0)

    def test_sim_lab_loads_on_demand_and_every_part_is_served(self):
        html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
        self.assertIn("/sim-lab-loader.js", html, "the small loader must be on the page")
        for name in ("sim-core.js", "sim-lab.js", "sim-lab.css"):
            self.assertNotIn("/" + name, html, f"{name} must NOT load up front (performance)")
        loader = (ROOT / "public" / "sim-lab-loader.js").read_text(encoding="utf-8")
        for name in ("sim-core.js", "sim-lab.js", "sim-lab.css", "sim-lab-loader.js"):
            self.assertEqual(self.client.get("/" + name).status_code, 200, name)
            if name != "sim-lab-loader.js":
                self.assertIn("/" + name, loader, f"loader never loads {name}")

    def test_static_fallback_is_not_a_file_browser(self):
        for bad in ("/app.py", "/.env", "/..%2fsrc%2fapp.py", "/Images", "/wrangler.jsonc", "/README.md"):
            with self.subTest(path=bad):
                self.assertEqual(self.client.get(bad).status_code, 404)

    def test_dashboard_page_still_requires_login(self):
        resp = self.client.get("/index.html")
        self.assertIn(resp.status_code, (301, 302, 401, 403))


if __name__ == "__main__":
    unittest.main()
