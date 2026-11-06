"""Face verification tests: crypto, decision policy, API authorisation, dedupe, privacy.

These exercise the real server-side matching/classification code using synthetic
128-d embeddings. They do not (and cannot) test the in-browser neural networks;
see docs/FACE_RECOGNITION.md for the field-test protocol.
"""
from __future__ import annotations

import base64
import os
import random
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("SESSION_SECRET", "defenx-face-test-session")
os.environ.setdefault("ADMIN_USERNAME", "ROVERADMIN")
os.environ.setdefault("ADMIN_PASSWORD", "test-only-admin-password")

import app as rover_app  # noqa: E402
import faces  # noqa: E402

KEY = "k" * 40
ADMIN = {"id": "a", "username": "ROVERADMIN", "display_name": "Admin", "role": "admin",
         "enabled": True, "can_control": True, "can_manage_users": True}
USER = {"id": "u", "username": "DHANUSH", "display_name": "User", "role": "user",
        "enabled": True, "can_control": True, "can_manage_users": False}
JPEG = b"\xff\xd8\xff" + b"\x11" * 900 + b"\xff\xd9"


def vec(seed):
    r = random.Random(seed)
    return [r.uniform(-0.2, 0.2) for _ in range(128)]


def jitter(v, amount, seed):
    r = random.Random(seed)
    return [x + r.uniform(-amount, amount) for x in v]


def dist(a, b):
    return faces.euclid(a, b)


class CryptoTests(unittest.TestCase):
    def test_roundtrip_tamper_and_binding(self):
        blob = faces.encrypt_blob(KEY, b"secret-face-template", "person:aaaaaaaaaaaaaaaa")
        self.assertNotIn("secret", blob)
        self.assertEqual(faces.decrypt_blob(KEY, blob, "person:aaaaaaaaaaaaaaaa"), b"secret-face-template")
        with self.assertRaises(faces.FaceCryptoError):
            faces.decrypt_blob(KEY, blob, "person:bbbbbbbbbbbbbbbb")
        with self.assertRaises(faces.FaceCryptoError):
            faces.decrypt_blob("x" * 40, blob, "person:aaaaaaaaaaaaaaaa")
        raw = bytearray(base64.urlsafe_b64decode(blob[3:]))
        raw[20] ^= 1
        with self.assertRaises(faces.FaceCryptoError):
            faces.decrypt_blob(KEY, "v1." + base64.urlsafe_b64encode(bytes(raw)).decode(), "person:aaaaaaaaaaaaaaaa")
        self.assertNotEqual(blob, faces.encrypt_blob(KEY, b"secret-face-template", "person:aaaaaaaaaaaaaaaa"))

    def test_short_key_refused_and_large_payload(self):
        with self.assertRaises(faces.FaceCryptoError):
            faces.encrypt_blob("short", b"x", "a")
        data = os.urandom(20000)
        self.assertEqual(faces.decrypt_blob(KEY, faces.encrypt_blob(KEY, data, "snap:x"), "snap:x"), data)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = faces.Policy()
        self.alice, self.bob = vec(1), vec(2)
        self.people = [{"id": "a" * 16, "templates": [self.alice]}, {"id": "b" * 16, "templates": [self.bob]}]

    def obs(self, descs, **kw):
        base = {"state": "face", "descriptors": descs, "occluded": False, "quality_ok": True, "persisted_s": 0}
        base.update(kw)
        return base

    def test_registered_person_is_authorized(self):
        descs = [jitter(self.alice, 0.02, s) for s in range(3)]
        self.assertLess(dist(descs[0], self.alice), self.policy.match)
        r = faces.classify(self.obs(descs), self.people, self.policy)
        self.assertEqual(r["category"], faces.CATEGORY_AUTHORIZED)
        self.assertEqual(r["person_id"], "a" * 16)

    def test_poor_quality_blocks_even_a_close_face_match(self):
        descs = [jitter(self.alice, 0.005, s) for s in range(3)]
        result = faces.classify(
            self.obs(descs, quality_ok=False, quality_reason="low_light"),
            self.people, self.policy,
        )
        self.assertEqual(result["category"], faces.CATEGORY_REVIEW)
        self.assertIsNone(result["person_id"])

    def test_unknown_person_is_unverified_not_hostile(self):
        descs = [vec(99)] * 3
        r = faces.classify(self.obs(descs), self.people, self.policy)
        self.assertEqual(r["category"], faces.CATEGORY_UNKNOWN)
        self.assertEqual(faces.CATEGORIES[r["category"]]["classification"], "UNVERIFIED PERSON")
        for meta in faces.CATEGORIES.values():
            self.assertNotIn("HOSTILE", (meta["label"] + meta["classification"]).upper())
            self.assertNotIn("THREAT", (meta["label"] + meta["classification"]).upper())

    def test_uncertain_distance_falls_back_to_verification_required(self):
        # Distance between match and unknown thresholds.
        r = random.Random(5)
        direction = [r.uniform(-1, 1) for _ in range(128)]
        norm = dist(direction, [0] * 128)
        target = (self.policy.match + self.policy.unknown) / 2
        d = [a + b * target / norm for a, b in zip(self.alice, direction)]
        res = faces.classify(self.obs([d] * 3), self.people, self.policy)
        self.assertEqual(res["category"], faces.CATEGORY_REVIEW)
        res = faces.classify(self.obs([d] * 3, persisted_s=30), self.people, self.policy)
        self.assertEqual(res["category"], faces.CATEGORY_UNVERIFIED)

    def test_obscured_face_never_unknown_or_hostile(self):
        res = faces.classify(self.obs([vec(77)] * 3, occluded=True), self.people, self.policy)
        self.assertEqual(res["category"], faces.CATEGORY_OBSCURED)
        self.assertEqual(faces.CATEGORIES[res["category"]]["label"], "IDENTITY UNVERIFIED \u2013 FACE OBSCURED")

    def test_obscured_authorized_person_still_recognised_only_if_strong(self):
        strong = [jitter(self.alice, 0.01, s) for s in range(3)]
        self.assertEqual(faces.classify(self.obs(strong, occluded=True), self.people, self.policy)["category"],
                         faces.CATEGORY_AUTHORIZED)
        weak = [jitter(self.alice, 0.09, s) for s in range(3)]
        self.assertGreater(dist(weak[0], self.alice), self.policy.obscured_match)
        self.assertEqual(faces.classify(self.obs(weak, occluded=True), self.people, self.policy)["category"],
                         faces.CATEGORY_OBSCURED)

    def test_poor_quality_never_creates_unknown_alert(self):
        res = faces.classify(self.obs([vec(55)] * 3, quality_ok=False, quality_reason="low_light"), self.people, self.policy)
        self.assertEqual(res["category"], faces.CATEGORY_REVIEW)

    def test_ambiguous_between_two_people_is_not_authorized(self):
        mid = [(a + b) / 2 for a, b in zip(self.alice, self.bob)]
        close = faces.Policy(match=0.60, unknown=0.70, obscured_match=0.40)
        people = [{"id": "a" * 16, "templates": [self.alice]},
                  {"id": "b" * 16, "templates": [[x + 0.001 for x in self.alice]]}]
        res = faces.classify(self.obs([self.alice] * 3), people, close)
        self.assertNotEqual(res["category"], faces.CATEGORY_AUTHORIZED)
        self.assertNotEqual(faces.classify(self.obs([mid] * 3), self.people, self.policy)["category"],
                            faces.CATEGORY_AUTHORIZED)

    def test_inconsistent_frames_not_authorized(self):
        descs = [self.alice, vec(41), vec(42)]
        self.assertNotEqual(faces.classify(self.obs(descs), self.people, self.policy)["category"],
                            faces.CATEGORY_AUTHORIZED)

    def test_single_frame_and_no_face_and_registry_failure(self):
        self.assertEqual(faces.classify(self.obs([self.alice]), self.people, self.policy)["category"], faces.CATEGORY_REVIEW)
        self.assertEqual(faces.classify({"state": "no_face", "descriptors": []}, self.people, self.policy)["category"],
                         faces.CATEGORY_REVIEW)
        self.assertEqual(faces.classify(self.obs([self.alice] * 3), self.people, self.policy, registry_ok=False)["category"],
                         faces.CATEGORY_REVIEW)

    def test_no_registered_people_is_unknown_but_unverified(self):
        self.assertEqual(faces.classify(self.obs([vec(3)] * 3), [], self.policy)["category"], faces.CATEGORY_UNKNOWN)

    def test_descriptor_validation(self):
        self.assertIsNotNone(faces.validate_descriptor(vec(1)))
        for bad in (None, [], [0.1] * 127, [float("nan")] * 128, ["a"] * 128, [True] * 128, [0.0] * 128, [99] * 128):
            self.assertIsNone(faces.validate_descriptor(bad))

    def test_policy_clamps_unsafe_config(self):
        p = faces.policy_from_config(lambda n, d=None: {"FACE_MATCH_THRESHOLD": "0.99", "FACE_UNKNOWN_THRESHOLD": "0.1"}.get(n, d))
        self.assertLessEqual(p.match, 0.60)
        self.assertGreater(p.unknown, p.match)


class ApiTests(unittest.TestCase):
    def setUp(self):
        faces.local_store.reset()
        rover_app._face_rate.clear()
        self.env = patch.dict(os.environ, {"FACE_DATA_KEY": KEY})
        self.env.start()
        self.client = rover_app.app.test_client()
        self.audits = []
        self.audit_patch = patch.object(rover_app, "audit", lambda a, d="", user=None: self.audits.append((a, d)))
        self.audit_patch.start()
        self.who = patch.object(rover_app, "current_user", lambda: self.current)
        self.who.start()
        self.current = ADMIN
        self.alice = vec(11)

    def tearDown(self):
        self.who.stop()
        self.audit_patch.stop()
        self.env.stop()

    def register(self, label="Alice", descs=None):
        descs = descs or [jitter(self.alice, 0.02, s) for s in range(3)]
        r = self.client.post("/api/faces/people", json={"label": label, "descriptors": descs})
        self.assertEqual(r.status_code, 201, r.get_data(as_text=True))
        return r.get_json()["id"]

    def observe(self, descs, **kw):
        body = {"state": "face", "descriptors": descs, "occluded": False, "quality_ok": True, "persisted_s": 0}
        body.update(kw)
        r = self.client.post("/api/faces/observe", json=body)
        return r.status_code, r.get_json()

    def test_requires_login(self):
        self.current = None
        for method, path in (("get", "/api/faces/status"), ("get", "/api/faces/events"), ("post", "/api/faces/observe"),
                             ("get", "/api/faces/people"), ("post", "/api/faces/people")):
            self.assertEqual(getattr(self.client, method)(path).status_code, 401, path)

    def test_admin_only_registration_listing_deletion_and_snapshots(self):
        pid = self.register()
        self.current = USER
        self.assertEqual(self.client.get("/api/faces/people").status_code, 403)
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "X", "descriptors": [vec(1)]}).status_code, 403)
        self.assertEqual(self.client.patch(f"/api/faces/people/{pid}", json={"enabled": False}).status_code, 403)
        self.assertEqual(self.client.delete(f"/api/faces/people/{pid}").status_code, 403)
        self.assertEqual(self.client.get("/api/faces/events/" + "a" * 16 + "/snapshot").status_code, 403)
        self.assertEqual(self.client.post("/api/faces/events/" + "a" * 16 + "/review", json={"action": "verify"}).status_code, 403)

    def test_templates_encrypted_at_rest_and_never_returned(self):
        pid = self.register("Alice Secret Name")
        stored = faces.local_store.people[pid]["blob"]
        self.assertNotIn("Alice", stored)
        listing = self.client.get("/api/faces/people")
        text = listing.get_data(as_text=True)
        self.assertEqual(listing.status_code, 200)
        self.assertIn("Alice Secret Name", text)
        self.assertNotIn("templates\":[[", text)
        self.assertNotIn(str(round(self.alice[0], 5)), text)
        self.assertEqual(listing.headers["Cache-Control"], "no-store")

    def test_authorized_person_is_verified_without_any_alert(self):
        self.register()
        self.current = USER  # a normal operator's browser sees the camera
        code, body = self.observe([jitter(self.alice, 0.02, 100 + s) for s in range(3)])
        self.assertEqual(code, 200)
        self.assertEqual(body["category"], faces.CATEGORY_AUTHORIZED)
        self.assertEqual(body["label"], "AUTHORIZED PERSONNEL \u2013 VERIFIED")
        self.assertFalse(body["need_snapshot"])
        self.assertNotIn("person_label", body)
        self.assertNotIn("match_distance", body)
        self.assertEqual([a for a, _ in self.audits if a == "FACE_ALERT"], [])
        ev = faces.local_store.events[0]
        self.assertFalse(ev["notify_admin"])
        self.assertTrue(ev["alert_ack"])

    def test_unknown_person_alerts_admin_once_and_dedupes(self):
        self.register()
        stranger = [jitter(vec(500), 0.01, s) for s in range(3)]
        code, first = self.observe(stranger)
        self.assertEqual(first["category"], faces.CATEGORY_UNKNOWN)
        self.assertEqual(first["label"], "UNKNOWN PERSON DETECTED")
        self.assertTrue(first["created"] and first["need_snapshot"])
        code, second = self.observe(stranger)
        self.assertFalse(second["created"])
        self.assertEqual(second["event_id"], first["event_id"])
        self.assertEqual(len([a for a, _ in self.audits if a == "FACE_ALERT"]), 1)
        self.assertEqual(len(faces.local_store.events), 1)
        self.assertEqual(faces.local_store.events[0]["count"], 2)
        ev = faces.local_store.events[0]
        self.assertTrue(ev["first_seen"] and ev["camera"] and "lat" in ev["location"])

    def test_dedupe_window_expires(self):
        stranger = [jitter(vec(501), 0.01, s) for s in range(3)]
        _, first = self.observe(stranger)
        faces.local_store.events[0]["last_seen_epoch"] -= 120
        _, again = self.observe(stranger)
        self.assertTrue(again["created"])
        self.assertNotEqual(again["event_id"], first["event_id"])

    def test_masked_person_is_obscured_alert_not_hostile(self):
        self.register()
        _, body = self.observe([jitter(vec(777), 0.01, s) for s in range(3)], occluded=True)
        self.assertEqual(body["category"], faces.CATEGORY_OBSCURED)
        self.assertEqual(body["label"], "IDENTITY UNVERIFIED \u2013 FACE OBSCURED")
        self.assertEqual(len([a for a, _ in self.audits if a == "FACE_ALERT"]), 1)
        self.assertNotIn("HOSTILE", body["classification"])

    def test_poor_lighting_is_verification_required_without_alert(self):
        self.register()
        _, body = self.observe([vec(901)] * 3, quality_ok=False, quality_reason="low_light")
        self.assertEqual(body["category"], faces.CATEGORY_REVIEW)
        self.assertEqual([a for a, _ in self.audits if a == "FACE_ALERT"], [])

    def test_revoked_person_is_no_longer_authorized_and_delete_erases(self):
        pid = self.register()
        descs = [jitter(self.alice, 0.02, 200 + s) for s in range(3)]
        self.assertEqual(self.observe(descs)[1]["category"], faces.CATEGORY_AUTHORIZED)
        self.assertEqual(self.client.patch(f"/api/faces/people/{pid}", json={"enabled": False}).status_code, 200)
        faces.local_store.events.clear()
        self.assertEqual(self.observe(descs)[1]["category"], faces.CATEGORY_UNKNOWN)
        self.assertEqual(self.client.delete(f"/api/faces/people/{pid}").status_code, 200)
        self.assertEqual(faces.local_store.people, {})
        self.assertEqual(self.client.delete(f"/api/faces/people/{pid}").status_code, 404)
        actions = [a for a, _ in self.audits]
        for needed in ("FACE_REGISTER", "FACE_REVOKE", "FACE_DELETE"):
            self.assertIn(needed, actions)

    def test_snapshot_flow_is_encrypted_and_admin_only(self):
        stranger = [jitter(vec(600), 0.01, s) for s in range(3)]
        _, body = self.observe(stranger)
        eid = body["event_id"]
        payload = {"image_b64": base64.b64encode(JPEG).decode()}
        self.assertEqual(self.client.post(f"/api/faces/events/{eid}/snapshot", json=payload).status_code, 200)
        self.assertNotIn(b"\x11\x11\x11\x11", faces.local_store.snaps[eid].encode())
        self.assertEqual(self.client.post(f"/api/faces/events/{eid}/snapshot", json=payload).status_code, 409)
        view = self.client.get(f"/api/faces/events/{eid}/snapshot")
        self.assertEqual((view.status_code, view.data, view.mimetype), (200, JPEG, "image/jpeg"))
        self.assertIn("no-store", view.headers["Cache-Control"])
        self.current = USER
        self.assertEqual(self.client.get(f"/api/faces/events/{eid}/snapshot").status_code, 403)
        listing = self.client.get("/api/faces/events").get_json()["events"][0]
        self.assertFalse(listing["has_snapshot"])
        self.assertNotIn("person_id", listing)

    def test_snapshot_validation(self):
        _, body = self.observe([jitter(vec(601), 0.01, s) for s in range(3)])
        eid = body["event_id"]
        for bad in ("!!!", base64.b64encode(b"not a jpeg" * 100).decode(), base64.b64encode(b"\xff\xd8\xff" + b"0" * 30000 + b"\xff\xd9").decode()):
            self.assertIn(self.client.post(f"/api/faces/events/{eid}/snapshot", json={"image_b64": bad}).status_code, (400, 413))
        self.assertEqual(self.client.post("/api/faces/events/zzzz/snapshot", json={}).status_code, 400)

    def test_snapshot_not_accepted_for_authorized_event(self):
        self.register()
        _, body = self.observe([jitter(self.alice, 0.02, 300 + s) for s in range(3)])
        r = self.client.post(f"/api/faces/events/{body['event_id']}/snapshot", json={"image_b64": base64.b64encode(JPEG).decode()})
        self.assertEqual(r.status_code, 409)

    def test_review_actions(self):
        _, body = self.observe([jitter(vec(602), 0.01, s) for s in range(3)])
        r = self.client.post(f"/api/faces/events/{body['event_id']}/review", json={"action": "verify"})
        self.assertEqual(r.get_json()["event"]["status"], "VERIFIED_BY_ADMIN")
        self.assertEqual(self.client.post(f"/api/faces/events/{body['event_id']}/review", json={"action": "bogus"}).status_code, 400)

    def test_invalid_input_rejected(self):
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "", "descriptors": [vec(1)]}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "A", "descriptors": []}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "A", "descriptors": [vec(2)]}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "A", "descriptors": [vec(2), vec(3)]}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/people", json={"label": "A", "descriptors": [[0.1] * 5]}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/observe", json={"descriptors": [[1] * 5]}).status_code, 400)
        self.assertEqual(self.client.post("/api/faces/observe", json={"descriptors": [vec(1)] * 6}).status_code, 400)

    def test_unconfigured_key_fails_closed(self):
        with patch.dict(os.environ, {"FACE_DATA_KEY": "short"}):
            self.assertEqual(self.client.post("/api/faces/observe", json={"descriptors": [vec(1)] * 3}).status_code, 503)
            self.assertEqual(self.client.post("/api/faces/people", json={"label": "A", "descriptors": [vec(1)]}).status_code, 503)
            self.assertFalse(self.client.get("/api/faces/status").get_json()["configured"])

    def test_corrupt_registry_record_fails_safe_not_unknown(self):
        pid = self.register()
        faces.local_store.people[pid]["blob"] = faces.local_store.people[pid]["blob"][:-6] + "AAAAAA"
        _, body = self.observe([vec(1234)] * 3)
        self.assertEqual(body["category"], faces.CATEGORY_REVIEW)

    def test_observe_rate_limited(self):
        for _ in range(90):
            self.observe([vec(1)] * 2)
        self.assertEqual(self.client.post("/api/faces/observe", json={"descriptors": [vec(1)] * 2}).status_code, 429)

    def test_admin_events_include_person_label_non_admin_do_not(self):
        self.register("Alice")
        self.observe([jitter(self.alice, 0.02, 400 + s) for s in range(3)])
        admin_ev = self.client.get("/api/faces/events").get_json()["events"][0]
        self.assertEqual(admin_ev["person_label"], "Alice")
        self.current = USER
        user_ev = self.client.get("/api/faces/events").get_json()["events"][0]
        self.assertNotIn("person_label", user_ev)
        self.assertNotIn("Alice", str(user_ev))

    def test_existing_features_unaffected(self):
        self.assertEqual(self.client.get("/api/ping").status_code, 200)
        self.assertEqual(self.client.get("/api/bootstrap").status_code, 200)


if __name__ == "__main__":
    unittest.main()
