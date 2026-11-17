"""Regression tests for the pg8000 DB-API compatibility layer."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("SESSION_SECRET", "defenx-vision-backend-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import app as rover_app  # noqa: E402


class FakeCursor:
    description = [("value", None), ("count", None)]

    def __init__(self):
        self.closed = False
        self.executed = []

    def execute(self, *args, **kwargs):
        self.executed.append((args, kwargs))
        return self

    def executemany(self, *args, **kwargs):
        self.executed.append((args, kwargs))
        return self

    def fetchone(self):
        return ("ok", 7)

    def fetchall(self):
        return [("ok", 7), ("ready", 8)]

    def fetchmany(self, size=1):
        return [("ok", 7)][:size]

    def close(self):
        self.closed = True


class FakeConnection:
    def __init__(self):
        self.autocommit = False
        self.cursor_instance = FakeCursor()
        self.committed = 0
        self.rolled_back = 0
        self.closed = False

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        self.closed = True


class FakeDriver:
    def __init__(self):
        self.connection = FakeConnection()
        self.kwargs = None

    def connect(self, **kwargs):
        self.kwargs = kwargs
        return self.connection


class Pg8000AdapterTests(unittest.TestCase):
    def test_hyperdrive_parameters_and_dict_rows(self):
        driver = FakeDriver()
        adapter = rover_app._Pg8000Compat(driver)

        with adapter.connect(
            host="hyperdrive.internal",
            port=5432,
            user="rover",
            password="secret",
            dbname="defenx",
            sslmode="disable",
            autocommit=True,
            connect_timeout=3,
        ) as connection:
            self.assertIsNone(driver.kwargs["ssl_context"])
            self.assertEqual(driver.kwargs["database"], "defenx")
            self.assertEqual(driver.kwargs["timeout"], 3.0)
            self.assertTrue(connection.autocommit)

            with connection.cursor(row_factory=adapter.rows.dict_row) as cursor:
                self.assertIs(cursor.execute("SELECT %s", (1,)), cursor)
                self.assertEqual(cursor.fetchone(), {"value": "ok", "count": 7})
                self.assertEqual(cursor.fetchall(), [
                    {"value": "ok", "count": 7},
                    {"value": "ready", "count": 8},
                ])

        self.assertEqual(driver.connection.committed, 1)
        self.assertTrue(driver.connection.closed)
        self.assertTrue(driver.connection.cursor_instance.closed)

    def test_database_url_decodes_credentials_and_honors_sslmode(self):
        driver = FakeDriver()
        adapter = rover_app._Pg8000Compat(driver)

        with adapter.connect(
            "postgresql://rover%2Fadmin:p%40ss%3Aword@db.example.test:5433/defenx"
            "?sslmode=require&connect_timeout=4"
        ):
            pass

        self.assertEqual(driver.kwargs["user"], "rover/admin")
        self.assertEqual(driver.kwargs["password"], "p@ss:word")
        self.assertEqual(driver.kwargs["database"], "defenx")
        self.assertEqual(driver.kwargs["port"], 5433)
        self.assertEqual(driver.kwargs["timeout"], 4.0)
        self.assertIsNotNone(driver.kwargs["ssl_context"])

    def test_exception_rolls_back_and_closes_connection(self):
        driver = FakeDriver()
        adapter = rover_app._Pg8000Compat(driver)

        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with adapter.connect(host="localhost", user="rover", sslmode="disable"):
                raise RuntimeError("test failure")

        self.assertEqual(driver.connection.rolled_back, 1)
        self.assertEqual(driver.connection.committed, 0)
        self.assertTrue(driver.connection.closed)


if __name__ == "__main__":
    unittest.main()
