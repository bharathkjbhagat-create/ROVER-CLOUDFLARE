"""Regression tests for DEFENX auth ordering and runtime account IDs."""
from __future__ import annotations
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-auth-regression-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402


class AuthenticationRegressionTests(unittest.TestCase):
    def setUp(self):
        self.client = rover_app.app.test_client()
        self.old_hash = rover_app.runtime_password_hashes.get("DHANUSH")
        rover_app.runtime_password_hashes["DHANUSH"] = rover_app.generate_password_hash("test-only-old-password")
        rover_app.clear_login_failures("127.0.0.1")

    def tearDown(self):
        if self.old_hash is None:
            rover_app.runtime_password_hashes.pop("DHANUSH", None)
        else:
            rover_app.runtime_password_hashes["DHANUSH"] = self.old_hash
        rover_app.clear_login_failures("127.0.0.1")

    def test_runtime_account_id_login_works_without_database(self):
        with patch.object(rover_app, "DATABASE_URL", None), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            runtime_id = rover_app.runtime_users["DHANUSH"]["id"]
            response = self.client.post("/api/login", json={
                "username": runtime_id, "password": "test-only-old-password"
            })
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            self.assertTrue(response.get_json()["ok"])
            self.assertIn("rover_auth=", "; ".join(response.headers.getlist("Set-Cookie")))
            self.assertEqual(self.client.get("/api/bootstrap").status_code, 200)

    def test_runtime_injected_session_secret_allows_login(self):
        with patch.object(rover_app, "SESSION_SECRET_CONFIGURED", False), \
             patch.dict(rover_app.app.config, {"SECRET_KEY": "runtime-injected-test-session"}), \
             patch.object(rover_app, "DATABASE_URL", None), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": "ROVERADMIN", "password": "test-only-admin-password"
            })
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
            self.assertTrue(response.get_json()["ok"])

    def test_database_configured_disables_stale_runtime_fallback(self):
        with patch.object(rover_app, "DATABASE_URL", "postgres://test-only"), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = rover_app.app.test_client().post("/api/login", json={
                "username": "DHANUSH", "password": "test-only-old-password"
            })
            self.assertEqual(response.status_code, 401, response.get_data(as_text=True))

    def test_worker_checks_database_auth_before_legacy_auth(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        start = source.index("async def _handle_login")
        end = source.index("async def fetch(self, request)", start)
        handler = source[start:end]
        self.assertLess(
            handler.index("fallback_response = await wsgi.fetch"),
            handler.index("legacy_user = await self._legacy_authenticate"),
        )
        self.assertIn("if not database_configured and key in admin_aliases:", source)

    def test_worker_signed_session_keeps_auth_source_metadata(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        self.assertIn('def _session_cookie(user, auth_source="environment"):', source)
        self.assertIn('"auth_source": auth_source', source)
        self.assertIn('"auth_version": int(user.get("auth_version", 0))', source)
        self.assertIn('self._login_response(legacy_user, auth_source="legacy")', source)


if __name__ == "__main__":
    unittest.main()
