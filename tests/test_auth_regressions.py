"""Regression tests for DEFENX admin-only authentication."""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-auth-regression-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402


class CloudflarePbkdf2CompatibilityTests(unittest.TestCase):
    def test_password_hashing_works_without_hashlib_pbkdf2_hmac(self):
        # Cloudflare's Pyodide build omits hashlib.pbkdf2_hmac. Simulate that
        # exact runtime limitation while exercising the production helpers.
        with patch.object(rover_app.hashlib, "pbkdf2_hmac",
                          side_effect=AttributeError("not available"), create=True):
            encoded = rover_app.generate_password_hash("correct horse battery staple")
            self.assertTrue(encoded.startswith("pbkdf2:sha256:600000$"))
            self.assertTrue(rover_app.safe_check_password_hash(
                encoded, "correct horse battery staple"
            ))
            self.assertFalse(rover_app.safe_check_password_hash(
                encoded, "incorrect password"
            ))


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

    def test_configured_admin_can_login_when_hyperdrive_is_temporarily_unavailable(self):
        with patch.object(rover_app, "DATABASE_URL", None), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=object()), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": rover_app.ADMIN_USERNAME,
                "password": rover_app.ADMIN_PASSWORD,
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json()["ok"])
        self.assertFalse(response.get_json()["db_connected"])
        self.assertEqual(self.client.get("/api/me").status_code, 200)

    def test_worker_bindings_refresh_flask_admin_credentials_before_database_init(self):
        previous = {
            "CF_ENV": rover_app.CF_ENV,
            "DATABASE_URL": rover_app.DATABASE_URL,
            "ADMIN_USERNAME": rover_app.ADMIN_USERNAME,
            "ADMIN_PASSWORD": rover_app.ADMIN_PASSWORD,
            "ADMIN_PASSWORD_HASH": rover_app.ADMIN_PASSWORD_HASH,
        }
        env = SimpleNamespace(
            ADMIN_USERNAME="ADMIN",
            ADMIN_PASSWORD="",
            ADMIN_PASSWORD_HASH="pbkdf2:sha256:600000$test$salt-and-hash",
            DATABASE_URL="",
            HYPERDRIVE=object(),
        )
        try:
            with patch.dict(os.environ, {
                "ADMIN_USERNAME": "", "ADMIN_PASSWORD": "",
                "ADMIN_PASSWORD_HASH": "", "DATABASE_URL": "",
            }), patch.object(rover_app, "get_psycopg", return_value=object()), \
                 patch.object(rover_app, "_db_unavailable_until", 0):
                rover_app.sync_worker_bindings(env)
                self.assertEqual(rover_app.ADMIN_USERNAME, "ADMIN")
                self.assertEqual(rover_app.ADMIN_PASSWORD, "")
                self.assertTrue(rover_app.ADMIN_PASSWORD_HASH)
                self.assertTrue(rover_app.db_available())
        finally:
            for name, value in previous.items():
                setattr(rover_app, name, value)

    def test_all_four_approved_regular_user_ids_are_whitelisted_and_preserved(self):
        self.assertEqual(rover_app.KNOWN_FRIEND_USERNAMES, ("MAHANTESH", "DHANUSH", "ANIRUDH", "MAMALESHWAR"))
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("DELETE FROM users WHERE UPPER(username)='ANIRUDH'", source)
        self.assertIn("for username in KNOWN_FRIEND_USERNAMES:", source)
        self.assertIn("ON CONFLICT (username) DO NOTHING", source)
        self.assertIn("def sync_worker_bindings(env):", source)

    def test_old_regular_user_fallback_session_is_rejected_without_user_cache(self):
        with self.client.session_transaction() as session:
            session["fallback_user"] = {
                "id": "old-user-session", "username": "UNAPPROVED",
                "display_name": "Unknown User", "role": "user", "enabled": True,
                "can_control": True, "can_manage_users": False,
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

    def test_anirudh_is_an_approved_id_and_reaches_password_validation(self):
        with patch.object(rover_app, "DATABASE_URL", "postgres://test-only"), \
             patch.object(rover_app, "_cf_hyperdrive", return_value=None), \
             patch.object(rover_app, "db_available", return_value=False), \
             patch.object(rover_app, "ensure_db", return_value=None):
            response = self.client.post("/api/login", json={
                "username": "ANIRUDH", "password": "test-only-password",
            })
        self.assertEqual(response.status_code, 401, response.get_data(as_text=True))
        self.assertEqual(response.get_json().get("field"), "password")

    def test_worker_checks_database_auth_before_legacy_auth_and_allows_only_approved_ids(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        start = source.index("async def _handle_login")
        end = source.index("async def fetch(self, request)", start)
        handler = source[start:end]
        self.assertLess(handler.index("fallback_response = await wsgi.fetch"), handler.index("legacy_user = await self._legacy_authenticate"))
        self.assertIn('approved_users = {"MAHANTESH", "DHANUSH", "ANIRUDH", "MAMALESHWAR"}', handler)
        self.assertNotIn("if self._normalize_login(username) not in admin_aliases:", handler)

    def test_worker_injects_live_bindings_into_flask_before_wsgi(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        fetch_start = source.rindex("async def fetch(self, request)")
        fetch_end = source.find("\\n    async def ", fetch_start + 1)
        fetch_body = source[fetch_start:fetch_end if fetch_end >= 0 else len(source)]
        self.assertIn("rover_app.sync_worker_bindings(self.env)", fetch_body)
        self.assertLess(fetch_body.index("rover_app.sync_worker_bindings(self.env)"), fetch_body.index("wsgi.fetch"))

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

    def test_database_initialization_preserves_and_bootstraps_all_approved_users(self):
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertNotIn("DELETE FROM users WHERE UPPER(username)='ANIRUDH'", source)
        self.assertIn("role='admin',enabled=TRUE", source)
        self.assertIn('KNOWN_FRIEND_USERNAMES = ("MAHANTESH", "DHANUSH", "ANIRUDH", "MAMALESHWAR")', source)
        self.assertIn("runtime_users = {}", source)
        self.assertIn("runtime_password_hashes = {}", source)
        self.assertIn("for username in KNOWN_FRIEND_USERNAMES:", source)
        self.assertIn("ON CONFLICT (username) DO NOTHING", source)
        self.assertIn('"disabled$" + uuid.uuid4().hex', source)
        self.assertIn('if method == "disabled":', source)


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
