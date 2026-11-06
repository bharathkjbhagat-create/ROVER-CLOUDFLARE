"""Security regression checks for the DEFENX Flask/Workers application."""
from __future__ import annotations

import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-security-regression-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402


class SecurityRegressionTests(unittest.TestCase):
    def setUp(self):
        self.client = rover_app.app.test_client()
        rover_app.clear_login_failures("security-test-ip")

    def tearDown(self):
        rover_app.clear_login_failures("security-test-ip")

    def _set_admin_session(self, include_user_cache=True):
        admin = {
            "id": "security-test-admin",
            "username": rover_app.ADMIN_USERNAME,
            "display_name": "ROVER Administrator",
            "role": "admin",
            "enabled": True,
            "can_control": True,
            "can_manage_users": True,
        }
        with self.client.session_transaction() as session:
            session["fallback_user"] = dict(admin)
            if include_user_cache:
                session["user_cache"] = dict(admin)
            session["dashboard_entry"] = True
            session["audit_session_id"] = "security-test-session"

    def test_security_headers_are_present(self):
        response = self.client.get("/api/ping")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
        self.assertIn("camera=", response.headers.get("Permissions-Policy", ""))
        self.assertIn("max-age=31536000", response.headers.get("Strict-Transport-Security", ""))

    def test_cross_origin_state_change_is_rejected_before_handler(self):
        response = self.client.post("/api/command",
            headers={"Origin": "https://attacker.example"},
            json={"command": "FORWARD"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("Cross-origin", response.get_json().get("error", ""))

    def test_sensitive_api_routes_require_authentication(self):
        self.assertEqual(self.client.get("/api/bootstrap").status_code, 401)
        self.assertEqual(self.client.get("/api/telemetry").status_code, 401)
        self.assertEqual(self.client.post("/api/command", json={"command": "FORWARD"}).status_code, 401)
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_detection_event_endpoint_requires_login(self):
        response = self.client.post("/api/detection-events", json={"type": "PERSON_PRESENT"})
        self.assertEqual(response.status_code, 401)

    def test_detection_event_accepts_only_generic_presence_transitions(self):
        self._set_admin_session()
        with patch.object(rover_app, "audit") as audit_mock:
            accepted = self.client.post("/api/detection-events", json={"type": "PERSON_PRESENT"})
            rejected = self.client.post("/api/detection-events", json={"type": "IDENTIFY_UNKNOWN_PERSON"})
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        self.assertTrue(accepted.get_json().get("recorded"))
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(audit_mock.call_count, 1)
        args = audit_mock.call_args.args
        self.assertEqual(args[0], "PERSON_DETECTED")
        self.assertIn("no image or identity data stored", args[1])

    def test_login_throttle_activates_after_configured_failures(self):
        ip = "security-test-ip"
        for _ in range(rover_app.LOGIN_MAX_ATTEMPTS):
            rover_app.record_login_failure(ip)
        self.assertTrue(rover_app.login_rate_limited(ip))
        rover_app.clear_login_failures(ip)
        self.assertFalse(rover_app.login_rate_limited(ip))

    def test_login_throttle_storage_is_bounded(self):
        now = rover_app.time.monotonic()
        with patch.object(rover_app, "LOGIN_MAX_TRACKED_IPS", 2):
            with rover_app._login_lock:
                for index in range(5):
                    rover_app._login_attempts[f"capacity-test-{index}"] = [now - index / 1000]
                rover_app._prune_login_attempts(now)
                self.assertLessEqual(len(rover_app._login_attempts), 2)
                for index in range(5):
                    rover_app._login_attempts.pop(f"capacity-test-{index}", None)

    def test_worker_only_revokes_sessions_for_post_logout(self):
        source = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        self.assertIn('url.path == "/api/logout" and str(request.method).upper() == "POST"', source)
        self.assertNotIn('url.path == "/api/logout" and str(request.method).upper() in {"GET", "POST"}', source)

    def test_legacy_regular_user_fallback_session_is_rejected(self):
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

    def test_logout_clears_both_session_and_auth_marker_cookies(self):
        self._set_admin_session()
        response = self.client.post("/api/logout")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json().get("ok"))
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        set_cookie_headers = response.headers.getlist("Set-Cookie")
        self.assertTrue(any(value.startswith("rover_session=;") and ("Max-Age=0" in value or "Expires=" in value) for value in set_cookie_headers),
            f"Logout must expire rover_session. Set-Cookie headers: {set_cookie_headers!r}")
        self.assertTrue(any(value.startswith("rover_auth=;") and ("Max-Age=0" in value or "Expires=" in value) for value in set_cookie_headers),
            f"Logout must expire rover_auth. Set-Cookie headers: {set_cookie_headers!r}")


if __name__ == "__main__":
    unittest.main()