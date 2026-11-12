"""Backend tests for registered-user enrollment and live detection alerts.

The database is replaced by a small in-memory fake that understands only the
statements these routes issue, so these tests exercise access control,
validation and data flow (not PostgreSQL itself).
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import types
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-vision-backend-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x11" * 400).decode()
DESCRIPTOR = [round((i - 64) / 700, 6) for i in range(128)]


class FakeDB:
    def __init__(self):
        self.faces, self.audit = [], []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self, row_factory=None):
        return FakeCursor(self, row_factory is not None)


class FakeCursor:
    def __init__(self, db, as_dict):
        self.db, self.as_dict, self.rows = db, as_dict, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        sql = " ".join(sql.split())
        db = self.db
        if sql.startswith("SELECT COUNT(*) FROM face_enrollments"):
            self.rows = [(len(db.faces),)]
        elif sql.startswith("INSERT INTO face_enrollments"):
            ident, name, descriptor, photo, created_by = params
            assert "TRUE" in sql  # consent is only ever stored as granted
            db.faces.append({"id": ident, "name": name, "descriptor": descriptor, "photo_b64": photo,
                             "created_by": created_by, "created_at": datetime.now(timezone.utc)})
        elif sql.startswith("SELECT id,name,consent,descriptor,photo_b64,created_by,created_at FROM face_enrollments"):
            self.rows = [dict(f) for f in db.faces]
        elif sql.startswith("SELECT id,name,descriptor,photo_b64,created_at FROM face_enrollments"):
            self.rows = [dict(f) for f in db.faces]
        elif sql.startswith("UPDATE face_enrollments SET descriptor=%s, photo_b64=%s WHERE id=%s"):
            descriptor, photo, ident = params
            for row in db.faces:
                if row["id"] == ident:
                    row["descriptor"], row["photo_b64"] = descriptor, photo
        elif sql.startswith("SELECT photo_b64 FROM face_enrollments WHERE id"):
            self.rows = [(f["photo_b64"],) for f in db.faces if f["id"] == params[0]]
        elif sql == "DELETE FROM face_enrollments":
            db.faces = []
        elif sql.startswith("DELETE FROM face_enrollments WHERE id"):
            hit = [f for f in db.faces if f["id"] == params[0]]
            db.faces = [f for f in db.faces if f["id"] != params[0]]
            self.rows = [(f["name"],) for f in hit]
        elif sql.startswith("INSERT INTO audit_log"):
            db.audit.append({"action": params[3], "details": params[4], "created_at": datetime.now(timezone.utc)})
        elif sql.startswith("SELECT details,created_at FROM audit_log WHERE action='DETECTION_ALERT'"):
            self.rows = [dict(a) for a in reversed(db.audit) if a["action"] == "DETECTION_ALERT"][: params[0]]
        elif sql.startswith("DELETE FROM audit_log"):
            pass
        else:
            raise AssertionError("Unexpected SQL: " + sql)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class VisionBackendTests(unittest.TestCase):
    def setUp(self):
        self.client = rover_app.app.test_client()
        self.db = FakeDB()
        rover_app._LOCAL_FACE_ENROLLMENTS.clear()
        fake_psycopg = types.SimpleNamespace(rows=types.SimpleNamespace(dict_row=object()))
        self.patches = [
            patch.object(rover_app, "db_available", lambda: True),
            patch.object(rover_app, "ensure_db", lambda: None),
            patch.object(rover_app, "get_db", lambda: self.db),
            patch.object(rover_app, "psycopg", fake_psycopg, create=True),
            patch.dict(os.environ, {"FACE_DATA_KEY": "unit-test-random-biometric-key-material-32-chars"}),
        ]
        for p in self.patches:
            p.start()
        self.login()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def login(self):
        admin = {"id": "t", "username": rover_app.ADMIN_USERNAME, "display_name": "Admin", "role": "admin",
                 "enabled": True, "can_control": True, "can_manage_users": True}
        with self.client.session_transaction() as s:
            s["fallback_user"] = dict(admin)
            s["user_cache"] = dict(admin)
            s["dashboard_entry"] = True
            s["audit_session_id"] = "vision-test"

    def enroll(self, **over):
        body = {"name": "Asha Rao", "consent": True, "descriptor": DESCRIPTOR, "photo": "data:image/jpeg;base64," + JPEG}
        body.update(over)
        return self.client.post("/api/face-enrollments", json=body)

    def alert(self, **over):
        body = {"category": "unknown_person", "status": "UNKNOWN PERSON", "source": "live_camera", "live_verified": True,
                "confidence": 0.83, "subject": "UNKNOWN", "mask": "NO MASK",
                "camera": {"label": "PHONE CAMERA", "source": "phone"},
                "gps": {"lat": 12.97, "lon": 77.59, "accuracy": 8.4}}
        body.update(over)
        return self.client.post("/api/detection-alerts", json=body)

    def durable_face_store_for_test(self, operation):
        op = operation.get("op")
        if op == "list":
            return {"ok": True, "enrollments": list(rover_app._LOCAL_FACE_ENROLLMENTS.values())}
        if op == "add":
            row = dict(operation["enrollment"])
            if row["id"] in rover_app._LOCAL_FACE_ENROLLMENTS:
                raise RuntimeError("duplicate")
            rover_app._LOCAL_FACE_ENROLLMENTS[row["id"]] = row
            return {"ok": True, "id": row["id"]}
        if op == "get":
            row = rover_app._LOCAL_FACE_ENROLLMENTS.get(operation["id"])
            if row is None:
                raise RuntimeError("not_found")
            return {"ok": True, "enrollment": dict(row)}
        raise AssertionError("Unexpected face-store operation: " + str(op))

    # ---------- access control ----------
    def test_everything_requires_an_admin_session(self):
        anon = rover_app.app.test_client()
        rid = str(uuid.uuid4())
        for method, url in [("get", "/api/face-enrollments"), ("post", "/api/face-enrollments"),
                            ("get", f"/api/face-enrollments/{rid}/photo"), ("delete", f"/api/face-enrollments/{rid}"),
                            ("get", "/api/detection-alerts"), ("post", "/api/detection-alerts")]:
            self.assertEqual(getattr(anon, method)(url).status_code, 401, url)

    def test_non_admin_cannot_read_biometrics(self):
        with self.client.session_transaction() as s:
            s.clear()
        self.assertIn(self.client.get("/api/face-enrollments").status_code, (401, 403))

    def test_cross_origin_enrollment_is_blocked(self):
        r = self.client.post("/api/face-enrollments", headers={"Origin": "https://evil.example"}, json={})
        self.assertEqual(r.status_code, 403)

    # ---------- enrollment ----------
    def test_enrollment_round_trip_and_no_store_headers(self):
        r = self.enroll()
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        ident = r.get_json()["id"]
        listing = self.client.get("/api/face-enrollments")
        self.assertEqual(listing.status_code, 200)
        self.assertIn("no-store", listing.headers["Cache-Control"])
        items = listing.get_json()["enrollments"]
        self.assertEqual([i["name"] for i in items], ["Asha Rao"])
        self.assertEqual(len(items[0]["descriptor"]), 128)
        stored = rover_app._LOCAL_FACE_ENROLLMENTS[ident]
        self.assertTrue(stored["blob"].startswith("a256gcm.v1."))
        self.assertNotIn(JPEG[:40], stored["blob"])
        self.assertNotIn("photo", items[0])  # photographs are served only by the dedicated protected route
        photo = self.client.get(f"/api/face-enrollments/{ident}/photo")
        self.assertEqual(photo.status_code, 200)
        self.assertEqual(photo.mimetype, "image/jpeg")
        self.assertIn("no-store", photo.headers["Cache-Control"])
        self.assertEqual(photo.data[:3], b"\xff\xd8\xff")
        self.assertEqual(self.client.delete(f"/api/face-enrollments/{ident}").status_code, 200)
        self.assertEqual(self.client.get("/api/face-enrollments").get_json()["enrollments"], [])
        self.assertEqual(self.client.get(f"/api/face-enrollments/{ident}/photo").status_code, 404)

    def test_multiple_face_references_round_trip_encrypted_and_individually_retrievable(self):
        second = [value + 0.01 for value in DESCRIPTOR]
        third = [value - 0.01 for value in DESCRIPTOR]
        r = self.enroll(descriptors=[DESCRIPTOR, second, third],
                        photos=["data:image/jpeg;base64," + JPEG] * 3)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        ident = r.get_json()["id"]
        items = self.client.get("/api/face-enrollments").get_json()["enrollments"]
        self.assertEqual(items[0]["photo_count"], 3)
        self.assertEqual(len(items[0]["descriptors"]), 3)
        self.assertEqual(items[0]["descriptor"], DESCRIPTOR)
        stored = rover_app._LOCAL_FACE_ENROLLMENTS[ident]
        self.assertTrue(stored["blob"].startswith("a256gcm.v1."))
        self.assertNotIn(JPEG[:40], stored["blob"])
        for index in range(3):
            suffix = "/photo" if index == 0 else "/photo/" + str(index)
            photo = self.client.get(f"/api/face-enrollments/{ident}" + suffix)
            self.assertEqual(photo.status_code, 200)
            self.assertEqual(photo.data[:3], b"\xff\xd8\xff")

    def test_multiple_face_references_require_matching_one_to_three_photos_and_descriptors(self):
        r = self.enroll(descriptors=[DESCRIPTOR, DESCRIPTOR], photos=["data:image/jpeg;base64," + JPEG])
        self.assertEqual(r.status_code, 400)
        r = self.enroll(descriptors=[DESCRIPTOR] * 4, photos=["data:image/jpeg;base64," + JPEG] * 4)
        self.assertEqual(r.status_code, 400)

    def test_legacy_plaintext_records_are_encrypted_before_source_rows_are_deleted(self):
        ident = str(uuid.uuid4())
        self.db.faces.append({
            "id": ident, "name": "Legacy person", "consent": True,
            "descriptor": json.dumps(DESCRIPTOR), "photo_b64": JPEG,
            "created_by": "admin", "created_at": datetime.now(timezone.utc),
        })
        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_face_store", side_effect=self.durable_face_store_for_test
        ):
            response = self.client.get("/api/face-enrollments")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["enrollments"][0]["name"], "Legacy person")
        self.assertEqual(self.db.faces, [])
        stored = rover_app._LOCAL_FACE_ENROLLMENTS[ident]
        self.assertTrue(stored["blob"].startswith("a256gcm.v1."))
        self.assertNotIn(JPEG[:40], stored["blob"])

    def test_unconsented_legacy_biometric_rows_are_purged_without_migration(self):
        self.db.faces.append({
            "id": str(uuid.uuid4()), "name": "No consent", "consent": False,
            "descriptor": json.dumps(DESCRIPTOR), "photo_b64": JPEG,
            "created_by": "admin", "created_at": datetime.now(timezone.utc),
        })
        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_face_store", side_effect=self.durable_face_store_for_test
        ):
            response = self.client.get("/api/face-enrollments")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.db.faces, [])
        self.assertEqual(rover_app._LOCAL_FACE_ENROLLMENTS, {})

    def test_legacy_unconsented_rows_are_purged_without_migration(self):
        ident = str(uuid.uuid4())
        self.db.faces.append({
            "id": ident, "name": "No Consent",
            "consent": False, "descriptor": "not-valid", "photo_b64": "not-valid",
            "created_by": "admin", "created_at": datetime.now(timezone.utc),
        })
        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_face_store", side_effect=self.durable_face_store_for_test
        ):
            response = self.client.get("/api/face-enrollments")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["enrollments"], [])
        self.assertEqual(self.db.faces, [])
        self.assertEqual(rover_app._LOCAL_FACE_ENROLLMENTS, {})

    def test_legacy_plaintext_rows_are_preserved_when_encryption_fails(self):
        ident = str(uuid.uuid4())
        self.db.faces.append({
            "id": ident, "name": "Legacy person", "consent": True,
            "descriptor": json.dumps(DESCRIPTOR), "photo_b64": JPEG,
            "created_by": "admin", "created_at": datetime.now(timezone.utc),
        })
        with patch.object(rover_app, "CF_ENV", object()), patch.object(
            rover_app, "_face_store", side_effect=self.durable_face_store_for_test
        ), patch.object(rover_app, "encrypt_biometric_bytes", side_effect=rover_app.BiometricCryptoError("test")):
            response = self.client.get("/api/face-enrollments")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(len(self.db.faces), 1)
        self.assertEqual(rover_app._LOCAL_FACE_ENROLLMENTS, {})

    def test_cloudflare_crypto_check_endpoint_contract(self):
        response = self.client.get("/api/face-enrollments/crypto-check")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["algorithm"], "AES-256-GCM")

    def test_missing_face_key_fails_closed_without_storing_biometrics(self):
        with patch.dict(os.environ, {"FACE_DATA_KEY": ""}):
            response = self.enroll()
            self.assertEqual(response.status_code, 503)
            self.assertEqual(rover_app._LOCAL_FACE_ENROLLMENTS, {})
            self.assertEqual(self.client.get("/api/face-enrollments").status_code, 503)

    def test_tampered_ciphertext_is_never_returned(self):
        response = self.enroll()
        self.assertEqual(response.status_code, 200)
        ident = response.get_json()["id"]
        row = rover_app._LOCAL_FACE_ENROLLMENTS[ident]
        blob = row["blob"]
        index = len("a256gcm.v1.") + 24
        row["blob"] = blob[:index] + ("A" if blob[index] != "A" else "B") + blob[index + 1:]
        listing = self.client.get("/api/face-enrollments")
        self.assertEqual(listing.status_code, 503)
        self.assertEqual(listing.get_json()["enrollments"] if "enrollments" in listing.get_json() else [], [])

    def test_enrollment_validation(self):
        bad_cases = [
            {"name": ""}, {"consent": False}, {"consent": "true"}, {"descriptor": DESCRIPTOR[:127]},
            {"descriptor": [float("nan")] * 128}, {"descriptor": ["x"] * 128}, {"descriptor": [9.0] * 128},
            {"photo": "data:image/png;base64," + JPEG}, {"photo": base64.b64encode(b"GIF89a" + b"0" * 300).decode()},
            {"photo": "A" * 30000}, {"photo": "!!!not base64!!!"},
        ]
        for case in bad_cases:
            self.assertEqual(self.enroll(**case).status_code, 400, case if "photo" not in case else list(case))
        self.assertEqual(self.db.faces, [])

    def test_enrollment_works_without_postgres_using_shared_store(self):
        with patch.object(rover_app, "db_available", lambda: False):
            r = self.enroll()
            self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
            listing = self.client.get("/api/face-enrollments")
            self.assertEqual(listing.status_code, 200)
            self.assertEqual(listing.get_json()["storage"], "durable-object-encrypted")

    def test_enrollment_limit(self):
        for i in range(rover_app.MAX_FACE_ENROLLMENTS):
            ident = str(uuid.uuid4())
            rover_app._LOCAL_FACE_ENROLLMENTS[ident] = {
                "id": ident, "blob": "a256gcm.v1.synthetic", "created_at": "2026-01-01T00:00:00Z",
            }
        self.assertEqual(self.enroll().status_code, 400)

    def test_reference_upload_never_creates_an_alert_or_leaks_biometrics_to_audit(self):
        self.assertEqual(self.enroll().status_code, 200)
        actions = [a["action"] for a in self.db.audit]
        self.assertEqual(actions, ["FACE_ENROLLED"])
        details = self.db.audit[0]["details"]
        self.assertNotIn(JPEG[:40], details)
        self.assertNotIn(str(DESCRIPTOR[5]), details)
        self.assertEqual(self.client.get("/api/detection-alerts").get_json()["alerts"], [])
        # An enrollment payload is not an acceptable alert payload either.
        r = self.client.post("/api/detection-alerts", json={"category": "unknown_person", "name": "Asha Rao",
                                                              "descriptor": DESCRIPTOR, "photo": JPEG})
        self.assertEqual(r.status_code, 400)

    # ---------- alerts ----------
    def test_valid_live_alert_is_stored_with_category_time_status_confidence_camera_gps(self):
        r = self.alert()
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        alerts = self.client.get("/api/detection-alerts").get_json()
        self.assertTrue(alerts["persistent"])
        a = alerts["alerts"][0]
        self.assertEqual(a["category"], "unknown_person")
        self.assertEqual(a["label"], "UNKNOWN PERSON")
        self.assertEqual(a["status"], "UNKNOWN PERSON")
        self.assertEqual(a["confidence"], 0.83)
        self.assertEqual(a["camera"]["label"], "PHONE CAMERA")
        self.assertEqual(a["gps"], {"lat": 12.97, "lon": 77.59, "accuracy_m": 8.4})
        self.assertTrue(a["at"])
        self.assertTrue(a["live_verified"])

    def test_person_alerts_require_verified_live_presence_and_live_source(self):
        for category in ("unknown_person", "registered_no_mask", "unknown_no_mask"):
            self.assertEqual(self.alert(category=category, live_verified=False).status_code, 400, category)
            self.assertEqual(self.alert(category=category, live_verified="yes").status_code, 400, category)
        self.assertEqual(self.alert(source="reference_upload").status_code, 400)
        self.assertEqual(self.alert(source=None).status_code, 400)
        self.assertEqual(self.db.audit, [])

    def test_alert_validation(self):
        self.assertEqual(self.alert(category="made_up").status_code, 400)
        self.assertEqual(self.alert(status="PHOTO / SCREEN IMAGE").status_code, 400)  # photos never alert
        self.assertEqual(self.alert(status="UNVERIFIED").status_code, 400)
        self.assertEqual(self.alert(confidence=1.5).status_code, 400)
        self.assertEqual(self.alert(confidence="high").status_code, 400)

    def test_vehicle_alert_and_gps_is_never_fabricated(self):
        r = self.alert(category="vehicle_detected", status="LIVE VEHICLE", live_verified=False, subject="car",
                       gps={"lat": 999, "lon": 77.59, "accuracy": 5})
        self.assertEqual(r.status_code, 200)
        a = self.client.get("/api/detection-alerts").get_json()["alerts"][0]
        self.assertIsNone(a["gps"])
        r = self.alert(category="object_detected", status="REAL-WORLD OBJECT", subject="backpack", gps=None, camera={})
        self.assertEqual(r.status_code, 200)
        a = self.client.get("/api/detection-alerts").get_json()["alerts"][0]
        self.assertIsNone(a["gps"])

    def test_rapid_duplicate_alerts_are_dropped(self):
        self.assertEqual(self.alert().get_json().get("recorded"), True)
        self.assertEqual(self.alert().get_json().get("duplicate"), True)
        self.assertEqual(len(self.client.get("/api/detection-alerts").get_json()["alerts"]), 1)
        self.assertEqual(self.alert(category="unknown_no_mask", status="UNKNOWN PERSON").get_json().get("recorded"), True)

    def test_alert_history_falls_back_to_memory_without_database(self):
        with patch.object(rover_app, "db_available", lambda: False), \
             patch.object(rover_app, "prune_local_login_events", lambda: None):
            self.assertEqual(self.alert(subject="Fallback").status_code, 200)
            data = self.client.get("/api/detection-alerts").get_json()
            self.assertFalse(data["persistent"])
            self.assertTrue(any(a["subject"] == "Fallback" for a in data["alerts"]))


if __name__ == "__main__":
    unittest.main()