"""Regression tests for DEFENX admin-only authentication."""
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
        rover_app.clear_login_failures("127.0.0.1")

    def tearDown(self):
        rover_app.clear_login_failures("127.0.0.1")

    def test_configured_admin_can_login_without_database(self):
        with patch.object(rover_app, "DATABASE_URL", None), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": rover_app.ADMIN_USERNAME,
                "password": rover_app.ADMIN_PASSWORD,
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(self.client.get("/api/me").status_code, 200)

    def test_only_three_approved_regular_user_ids_are_whitelisted(self):
        self.assertEqual(rover_app.KNOWN_FRIEND_USERNAMES, ("MAHANTESH", "DHANUSH", "MAMALESHWAR"))
        self.assertNotIn("ANIRUDH", rover_app.KNOWN_FRIEND_USERNAMES)
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertIn("DELETE FROM users WHERE UPPER(username)='ANIRUDH'", source)
        self.assertNotIn("DELETE FROM users\\n                           WHERE id NOT IN", source)

    def test_old_regular_user_fallback_session_is_rejected_without_user_cache(self):
        with self.client.session_transaction() as session:
            session["fallback_user"] = {
                "id": "old-user-session", "username": "UNAPPROVED",
                "display_name": "Unknown User", "role": "user", "enabled": True,
                "can_control": True, "can_manage_users": False,
            }
        response = self.client.get("/api/me")
        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))

    def test_old_regular_user_fallback_session_is_rejected_without_user_cache(self):
        with self.client.session_transaction() as session:
            session["fallback_user"] = {
                "id": "old-user-session",
                "username": "DHANUSH",
                "display_name": "Legacy Friend",
                "role": "user",
                "enabled": True,
                "can_control": True,
                "can_manage_users": False,
            }
        response = self.client.get("/api/me")
        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))

    def test_approved_user_id_reaches_database_authentication(self):
        with patch.object(rover_app, "DATABASE_URL", "postgres://test-only"), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": "DHANUSH", "password": "test-only-password",
            })
        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))
        self.assertEqual(response.get_json().get("field"), "password")

    def test_retired_anirudh_id_is_rejected_before_password_lookup(self):
        with patch.object(rover_app, "DATABASE_URL", "postgres://test-only"), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": "ANIRUDH", "password": "test-only-password",
            })
        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))
        self.assertEqual(response.get_json().get("field"), "username")

    def test_worker_checks_database_auth_before_legacy_auth_and_allows_only_approved_ids(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        start = source.index("async def _handle_login")
        end = source.index("async def fetch(self, request)", start)
        handler = source[start:end]
        self.assertLess(handler.index("fallback_response = await wsgi.fetch"), handler.index("legacy_user = await self._legacy_authenticate"))
        self.assertIn('approved_users = {"MAHANTESH", "DHANUSH", "MAMALESHWAR"}', handler)
        self.assertNotIn("if self._normalize_login(username) not in admin_aliases:", handler)

    def test_worker_injects_live_bindings_into_flask_before_wsgi(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        fetch_start = source.rindex("async def fetch(self, request)")
        fetch_end = source.find("\\n    async def ", fetch_start + 1)
        fetch_body = source[fetch_start:fetch_end if fetch_end >= 0 else len(source)]
        self.assertIn("rover_app.CF_ENV = self.env", fetch_body)
        self.assertLess(fetch_body.index("rover_app.CF_ENV = self.env"), fetch_body.index("wsgi.fetch"))

    def test_worker_signed_session_keeps_auth_source_metadata(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        self.assertIn('def _session_cookie(user, auth_source="environment"):', source)
        self.assertIn('"auth_source": auth_source', source)
        self.assertIn('"auth_version": int(user.get("auth_version", 0))', source)
        self.assertIn('self._login_response(legacy_user, auth_source="legacy")', source)

    def test_worker_revokes_signed_sessions_on_logout_and_checks_protected_routes(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        self.assertIn("async def revoke_session(self, session_hash, expires_at):", source)
        self.assertIn("async def is_session_revoked(self, session_hash, now=None):", source)
        self.assertIn('url.path == "/api/logout"', source)
        self.assertIn("self._needs_revocation_check(url.path)", source)
        self.assertIn("if await self.is_session_revoked(session_hash):", source)

    def test_database_cleanup_preserves_approved_users_and_removes_anirudh_only(self):
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertIn("DELETE FROM users WHERE UPPER(username)='ANIRUDH'", source)
        self.assertIn("role='admin',enabled=TRUE", source)
        self.assertIn('KNOWN_FRIEND_USERNAMES = ("MAHANTESH", "DHANUSH", "MAMALESHWAR")', source)
        self.assertIn("runtime_users = {}", source)
        self.assertIn("runtime_password_hashes = {}", source)


class LoginErrorUniformityTests(unittest.TestCase):
    """User-visible login errors must not reveal whether a login ID exists."""

    def setUp(self):
        self.client = rover_app.app.test_client()
        rover_app.clear_login_failures("127.0.0.1")

    def tearDown(self):
        rover_app.clear_login_failures("127.0.0.1")

    def test_unknown_id_and_wrong_admin_password_show_identical_error_text(self):
        with patch.object(rover_app, "DATABASE_URL", None), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            unknown = self.client.post("/api/login", json={"username": "NO-SUCH-ID", "password": "x" * 12})
            wrong = self.client.post("/api/login", json={"username": rover_app.ADMIN_USERNAME, "password": "wrong-password-1"})
        self.assertEqual(unknown.status_code, 401)
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(unknown.get_json()["error"], wrong.get_json()["error"])

    def test_no_failure_path_uses_the_distinguishing_legacy_messages(self):
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn('"error": "Invalid password."', source)
        self.assertNotIn('"error": "Invalid login ID."', source)

    def test_health_reports_whether_session_secret_is_dedicated(self):
        body = self.client.get("/api/health").get_json()
        self.assertIn("session_secret_dedicated", body)
        self.assertIsInstance(body["session_secret_dedicated"], bool)
        self.assertNotIn(os.environ["SESSION_SECRET"], str(body))

    def test_derived_session_secret_is_reported_as_not_dedicated(self):
        import json, subprocess
        env = {k: v for k, v in os.environ.items() if k != "SESSION_SECRET"}
        env.update(ADMIN_USERNAME="ROVERADMIN", ADMIN_PASSWORD="derived-secret-test-pw", PYTHONPATH=str(ROOT / "src"))
        code = "import app,json;print(json.dumps(app.app.test_client().get('/api/health').get_json()))"
        out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertIn("SECURITY WARNING", out.stdout)
        body = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertTrue(body["session_configured"])
        self.assertFalse(body["session_secret_dedicated"])
        self.assertNotIn("derived-secret-test-pw", out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
