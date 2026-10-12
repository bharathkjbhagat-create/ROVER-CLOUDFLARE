"""Security regression checks for the DEFENX Flask/Workers application."""
from __future__ import annotations

import os
import sys
from pathlib import Path
import unittest

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

    def test_security_headers_are_present(self):
        response = self.client.get("/api/ping")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(response.headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
        self.assertIn("camera=", response.headers.get("Permissions-Policy", ""))
        self.assertIn("max-age=31536000", response.headers.get("Strict-Transport-Security", ""))

    def test_cross_origin_state_change_is_rejected_before_handler(self):
        response = self.client.post(
            "/api/command",
            headers={"Origin": "https://attacker.example"},
            json={"command": "FORWARD"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertIn("Cross-origin", response.get_json().get("error", ""))

    def test_sensitive_api_routes_require_authentication(self):
        self.assertEqual(self.client.get("/api/bootstrap").status_code, 401)
        self.assertEqual(self.client.get("/api/telemetry").status_code, 401)
        self.assertEqual(
            self.client.post("/api/command", json={"command": "FORWARD"}).status_code,
            401,
        )
        self.assertEqual(self.client.get("/api/me").status_code, 401)

    def test_login_throttle_activates_after_configured_failures(self):
        ip = "security-test-ip"
        for _ in range(rover_app.LOGIN_MAX_ATTEMPTS):
            rover_app.record_login_failure(ip)
        self.assertTrue(rover_app.login_rate_limited(ip))
        rover_app.clear_login_failures(ip)
        self.assertFalse(rover_app.login_rate_limited(ip))

    def test_logout_clears_authenticated_session(self):
        with self.client.session_transaction() as session:
            session["fallback_user"] = {
                "id": "security-test-user",
                "username": "SECURITYTEST",
                "display_name": "Security Test",
                "role": "user",
                "enabled": True,
                "can_control": True,
                "can_manage_users": False,
            }
            session["user_cache"] = dict(session["fallback_user"])
            session["dashboard_entry"] = True
        response = self.client.post("/api/logout")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertTrue(response.get_json().get("ok"))
        self.assertEqual(self.client.get("/api/me").status_code, 401)
        self.assertTrue(any("rover_auth=;" in value or "rover_auth" in value and "Max-Age=0" in value
                            for value in response.headers.getlist("Set-Cookie")))


if __name__ == "__main__":
    unittest.main()
