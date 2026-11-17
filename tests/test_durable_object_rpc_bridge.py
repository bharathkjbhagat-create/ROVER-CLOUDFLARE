"""Regression tests for Python/JavaScript Durable Object RPC result conversion."""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("SESSION_SECRET", "defenx-vision-backend-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")
sys.path.insert(0, str(ROOT / "src"))

import app as rover_app  # noqa: E402


class FakeJsProxy:
    def __init__(self, value):
        self.value = value

    def to_py(self):
        return self.value


class FakeStub:
    def __init__(self, result):
        self.result = result
        self.operation = None

    def face_enrollment_op(self, payload):
        self.operation = json.loads(payload)
        return object()

    def get_state(self):
        return object()


class DurableObjectRpcBridgeTests(unittest.TestCase):
    def test_generic_realtime_call_converts_pyodide_proxy(self):
        stub = FakeStub(None)
        expected = {"lat": 12.9, "lon": 77.5, "sync_version": "live-test"}

        with patch.object(rover_app, "_realtime_stub", return_value=stub), patch.object(
            rover_app, "run_sync", return_value=FakeJsProxy(expected)
        ):
            actual = rover_app._realtime_call("get_state")

        self.assertEqual(actual, expected)
        self.assertIsInstance(actual, dict)

    def test_encrypted_face_store_converts_pyodide_proxy(self):
        stub = FakeStub(None)
        expected = {"ok": True, "enrollments": []}

        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_realtime_stub", return_value=stub
        ), patch.object(rover_app, "run_sync", return_value=FakeJsProxy(expected)):
            actual = rover_app._face_store({"op": "list"})

        self.assertEqual(actual, expected)
        self.assertEqual(stub.operation, {"op": "list"})

    def test_face_store_keeps_rejecting_failed_durable_object_result(self):
        stub = FakeStub(None)
        failed = {"ok": False, "error": "storage_unavailable"}

        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_realtime_stub", return_value=stub
        ), patch.object(rover_app, "run_sync", return_value=FakeJsProxy(failed)):
            with self.assertRaisesRegex(RuntimeError, "storage_unavailable"):
                rover_app._face_store({"op": "list"})


if __name__ == "__main__":
    unittest.main()
