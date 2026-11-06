"""DEFENX face verification: decision policy, encryption and registry operations.

Design rules
- Recognition is never evidence of hostile intent. Nothing here emits a
  "threat"/"hostile" classification. Unrecognised people are UNVERIFIED.
- Face templates (128-d embeddings produced in the browser by face-api.js) are
  stored only as authenticated ciphertext. Matching happens on the server so
  templates are never sent to any browser.
- Uncertain evidence falls back to VERIFICATION REQUIRED, never to AUTHORIZED.
- Standard library only, so it runs unchanged inside Cloudflare Python Workers.
"""
import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import statistics
import time
import uuid
from datetime import datetime, timezone

DESCRIPTOR_LEN = 128
MAX_PEOPLE = 50
MAX_EVENTS = 200
MAX_TEMPLATES_PER_PERSON = 10
SNAPSHOT_RETENTION_SECONDS = 7 * 24 * 3600
MAX_SNAPSHOT_BYTES = 18000
ID_RE = re.compile(r"^[0-9a-f]{16}$")

CATEGORY_AUTHORIZED = "AUTHORIZED_PERSONNEL"
CATEGORY_UNKNOWN = "UNKNOWN_PERSON"
CATEGORY_UNVERIFIED = "IDENTITY_UNVERIFIED"
CATEGORY_OBSCURED = "FACE_OBSCURED"
CATEGORY_REVIEW = "VERIFICATION_REQUIRED"

CATEGORIES = {
    CATEGORY_AUTHORIZED: {"label": "AUTHORIZED PERSONNEL \u2013 VERIFIED", "classification": "AUTHORIZED", "notify_admin": False},
    CATEGORY_UNKNOWN: {"label": "UNKNOWN PERSON DETECTED", "classification": "UNVERIFIED PERSON", "notify_admin": True},
    CATEGORY_UNVERIFIED: {"label": "IDENTITY UNVERIFIED", "classification": "UNVERIFIED PERSON", "notify_admin": True},
    CATEGORY_OBSCURED: {"label": "IDENTITY UNVERIFIED \u2013 FACE OBSCURED", "classification": "UNVERIFIED PERSON", "notify_admin": True},
    CATEGORY_REVIEW: {"label": "VERIFICATION REQUIRED", "classification": "PENDING VERIFICATION", "notify_admin": False},
}
SNAPSHOT_CATEGORIES = {CATEGORY_UNKNOWN, CATEGORY_UNVERIFIED, CATEGORY_OBSCURED}
REVIEW_ACTIONS = {
    "verify": "VERIFIED_BY_ADMIN",
    "dismiss": "DISMISSED",
    "acknowledge": "ACKNOWLEDGED",
}


class FaceCryptoError(Exception):
    pass


class FaceOpError(Exception):
    """Registry operation rejected; .code is a short machine-readable reason."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class FaceStoreError(Exception):
    pass


# --------------------------------------------------------------------------
# Encryption: HMAC-SHA256 counter-mode stream + HMAC-SHA256 tag
# (encrypt-then-MAC, separate derived keys, record-bound associated data).
# --------------------------------------------------------------------------
def key_is_valid(secret):
    return isinstance(secret, str) and len(secret.strip()) >= 32


def _derive(secret):
    prk = hmac.new(b"defenx-face-salt-v1", secret.strip().encode("utf-8"), hashlib.sha256).digest()
    enc = hmac.new(prk, b"enc\x01", hashlib.sha256).digest()
    mac = hmac.new(prk, b"mac\x01", hashlib.sha256).digest()
    return enc, mac


def _keystream(enc_key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hmac.new(enc_key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest()
        counter += 1
    return bytes(out[:length])


def encrypt_blob(secret, plaintext, aad):
    if not key_is_valid(secret):
        raise FaceCryptoError("key_not_configured")
    enc, mac = _derive(secret)
    nonce = secrets.token_bytes(16)
    stream = _keystream(enc, nonce, len(plaintext))
    ct = (int.from_bytes(plaintext, "big") ^ int.from_bytes(stream, "big")).to_bytes(len(plaintext), "big") if plaintext else b""
    tag = hmac.new(mac, b"v1|" + aad.encode("utf-8") + b"|" + nonce + ct, hashlib.sha256).digest()
    return "v1." + base64.urlsafe_b64encode(nonce + ct + tag).decode("ascii")


def decrypt_blob(secret, blob, aad):
    if not key_is_valid(secret):
        raise FaceCryptoError("key_not_configured")
    try:
        if not isinstance(blob, str) or not blob.startswith("v1."):
            raise ValueError("format")
        raw = base64.urlsafe_b64decode(blob[3:].encode("ascii"))
        if len(raw) < 48:
            raise ValueError("short")
        nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
    except Exception:
        raise FaceCryptoError("bad_blob")
    enc, mac = _derive(secret)
    expected = hmac.new(mac, b"v1|" + aad.encode("utf-8") + b"|" + nonce + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise FaceCryptoError("auth_failed")
    stream = _keystream(enc, nonce, len(ct))
    if not ct:
        return b""
    return (int.from_bytes(ct, "big") ^ int.from_bytes(stream, "big")).to_bytes(len(ct), "big")


# --------------------------------------------------------------------------
# Policy and matching
# --------------------------------------------------------------------------
class Policy:
    def __init__(self, match=0.50, unknown=0.62, obscured_match=0.40, margin=0.06,
                 escalate_seconds=10.0, min_observations=2, min_agree=0.6):
        self.match = min(max(float(match), 0.30), 0.60)
        self.unknown = min(max(float(unknown), self.match + 0.02), 0.80)
        self.obscured_match = min(max(float(obscured_match), 0.25), self.match)
        self.margin = min(max(float(margin), 0.02), 0.20)
        self.escalate_seconds = min(max(float(escalate_seconds), 3.0), 120.0)
        self.min_observations = int(min_observations)
        self.min_agree = float(min_agree)

    def public(self):
        return {"match": self.match, "unknown": self.unknown, "obscured_match": self.obscured_match,
                "margin": self.margin, "escalate_seconds": self.escalate_seconds}


def policy_from_config(get):
    def num(name, default):
        try:
            value = float(get(name, default))
            return value if math.isfinite(value) else default
        except (TypeError, ValueError):
            return default
    return Policy(
        match=num("FACE_MATCH_THRESHOLD", 0.50),
        unknown=num("FACE_UNKNOWN_THRESHOLD", 0.62),
        obscured_match=num("FACE_OBSCURED_MATCH_THRESHOLD", 0.40),
        margin=num("FACE_MIN_MARGIN", 0.06),
        escalate_seconds=num("FACE_ESCALATE_SECONDS", 10.0),
    )


def validate_descriptor(value):
    """Return a clean list of 128 floats, or None."""
    if not isinstance(value, (list, tuple)) or len(value) != DESCRIPTOR_LEN:
        return None
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        number = float(item)
        if not math.isfinite(number) or abs(number) > 10:
            return None
        out.append(round(number, 5))
    if math.sqrt(sum(x * x for x in out)) < 1e-3:
        return None
    return out


def euclid(a, b):
    return math.sqrt(sum((x - y) * (x - y) for x, y in zip(a, b)))


def match_descriptors(observed, people):
    """people: [{id, templates:[[128]]}]. Returns ranking info or None."""
    if not observed or not people:
        return None
    scored = []
    for person in people:
        templates = person.get("templates") or []
        if not templates:
            continue
        per_obs = [min(euclid(o, t) for t in templates) for o in observed]
        scored.append((statistics.median(per_obs), person["id"], per_obs))
    if not scored:
        return None
    scored.sort(key=lambda row: row[0])
    best = scored[0]
    return {
        "person_id": best[1],
        "distance": best[0],
        "per_obs": best[2],
        "second": scored[1][0] if len(scored) > 1 else None,
    }


def _strong(m, threshold, policy):
    if not m or m["distance"] > threshold:
        return False
    agree = sum(1 for d in m["per_obs"] if d <= threshold) / float(len(m["per_obs"]))
    if agree < policy.min_agree:
        return False
    return m["second"] is None or (m["second"] - m["distance"]) >= policy.margin


def _band(distance, policy):
    if distance is None:
        return None
    if distance <= policy.obscured_match:
        return "HIGH"
    if distance <= policy.match:
        return "MEDIUM"
    return "LOW"


def classify(obs, people, policy, registry_ok=True):
    """Decide the verification category. Never returns a hostile label."""
    try:
        persisted = min(max(float(obs.get("persisted_s") or 0), 0.0), 3600.0)
    except (TypeError, ValueError):
        persisted = 0.0
    escalate = persisted >= policy.escalate_seconds
    uncertain = CATEGORY_UNVERIFIED if escalate else CATEGORY_REVIEW

    def out(category, reason, m=None):
        dist = round(m["distance"], 4) if m else None
        return {"category": category, "reason": reason,
                "person_id": m["person_id"] if (m and category == CATEGORY_AUTHORIZED) else None,
                "distance": dist, "confidence": _band(dist, policy)}

    if not registry_ok:
        return out(CATEGORY_REVIEW, "registry_unavailable")
    if obs.get("state") != "face":
        return out(uncertain, "face_not_visible")
    descs = obs.get("descriptors") or []
    if len(descs) < policy.min_observations:
        return out(CATEGORY_REVIEW, "insufficient_observations")
    m = match_descriptors(descs, people)

    if obs.get("occluded"):
        if _strong(m, policy.obscured_match, policy):
            return out(CATEGORY_AUTHORIZED, "matched_despite_partial_obstruction", m)
        return out(CATEGORY_OBSCURED, "face_obscured", m)
    if not obs.get("quality_ok"):
        if _strong(m, policy.obscured_match, policy):
            return out(CATEGORY_AUTHORIZED, "matched_with_strict_threshold", m)
        return out(uncertain, str(obs.get("quality_reason") or "poor_quality")[:40], m)
    if _strong(m, policy.match, policy):
        return out(CATEGORY_AUTHORIZED, "matched", m)
    if m is None:
        return out(CATEGORY_UNKNOWN, "no_registered_personnel")
    far = sum(1 for d in m["per_obs"] if d > policy.unknown) / float(len(m["per_obs"]))
    if m["distance"] > policy.unknown and far >= policy.min_agree:
        return out(CATEGORY_UNKNOWN, "no_match", m)
    return out(uncertain, "ambiguous_match", m)


# --------------------------------------------------------------------------
# Registry operations (shared by the Durable Object and the local fallback)
# --------------------------------------------------------------------------
def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def public_event(ev):
    hidden = {"last_seen_epoch", "first_epoch", "snapshot_requests"}
    return {k: v for k, v in ev.items() if k not in hidden}


def apply_op(req, people, events, now=None):
    """Mutates people (dict) / events (list, newest first) in place.

    Returns (result, mutations). mutations = {people, events, snap_put, snap_del}.
    """
    now = float(now if now is not None else time.time())
    op = str(req.get("op") or "")
    mut = {"people": False, "events": False, "snap_put": {}, "snap_del": []}

    def find(event_id):
        for ev in events:
            if ev.get("id") == event_id:
                return ev
        raise FaceOpError("not_found")

    if op == "people_list":
        return {"people": [dict(p) for p in people.values()]}, mut
    if op == "people_add":
        rec = req.get("person") or {}
        if not ID_RE.match(str(rec.get("id") or "")) or not rec.get("blob"):
            raise FaceOpError("bad_request")
        if len(people) >= MAX_PEOPLE:
            raise FaceOpError("registry_full")
        people[rec["id"]] = {
            "id": rec["id"], "blob": rec["blob"], "enabled": True,
            "created_at": rec.get("created_at"), "created_by": rec.get("created_by"),
            "count": int(rec.get("count") or 0),
        }
        mut["people"] = True
        return {"id": rec["id"]}, mut
    if op == "people_set_enabled":
        pid = str(req.get("id") or "")
        if pid not in people:
            raise FaceOpError("not_found")
        people[pid]["enabled"] = bool(req.get("enabled"))
        mut["people"] = True
        return {"id": pid, "enabled": people[pid]["enabled"]}, mut
    if op == "people_delete":
        pid = str(req.get("id") or "")
        if pid not in people:
            raise FaceOpError("not_found")
        del people[pid]
        mut["people"] = True
        return {"id": pid}, mut

    if op == "events_list":
        try:
            limit = min(max(int(req.get("limit") or 50), 1), 100)
        except (TypeError, ValueError):
            limit = 50
        return {"events": [public_event(e) for e in events[:limit]]}, mut
    if op == "event_get":
        return {"event": public_event(find(str(req.get("id") or "")))}, mut
    if op == "event_report":
        new = dict(req.get("event") or {})
        category = new.get("category")
        if category not in CATEGORIES:
            raise FaceOpError("bad_request")
        window = min(max(float(req.get("window") or 60), 5), 3600)
        found = None
        for ev in events:
            if (ev.get("category") == category and ev.get("camera_id") == new.get("camera_id")
                    and ev.get("person_id") == new.get("person_id")
                    and now - float(ev.get("last_seen_epoch") or 0) <= window):
                found = ev
                break
        created = found is None
        if created:
            found = {
                "id": uuid.uuid4().hex[:16], "category": category,
                "label": CATEGORIES[category]["label"],
                "classification": CATEGORIES[category]["classification"],
                "status": "OPEN" if CATEGORIES[category]["notify_admin"] else "INFO",
                "notify_admin": CATEGORIES[category]["notify_admin"],
                "alert_ack": not CATEGORIES[category]["notify_admin"],
                "camera_id": new.get("camera_id"), "camera": new.get("camera"),
                "location": new.get("location"), "person_id": new.get("person_id"),
                "reason": new.get("reason"), "match_distance": new.get("match_distance"),
                "confidence": new.get("confidence"),
                "first_seen": _iso(now), "first_epoch": now, "count": 0,
                "has_snapshot": False, "snapshot_requests": 0,
            }
            events.insert(0, found)
            for old in events[MAX_EVENTS:]:
                if old.get("has_snapshot"):
                    mut["snap_del"].append(old["id"])
            del events[MAX_EVENTS:]
        found["last_seen"] = _iso(now)
        found["last_seen_epoch"] = now
        found["count"] = int(found.get("count") or 0) + 1
        found["reason"] = new.get("reason", found.get("reason"))
        found["match_distance"] = new.get("match_distance", found.get("match_distance"))
        found["confidence"] = new.get("confidence", found.get("confidence"))
        for ev in events:
            if ev.get("has_snapshot") and now - float(ev.get("first_epoch") or now) > SNAPSHOT_RETENTION_SECONDS:
                ev["has_snapshot"] = False
                mut["snap_del"].append(ev["id"])
        need = (category in SNAPSHOT_CATEGORIES and not found["has_snapshot"]
                and int(found.get("snapshot_requests") or 0) < 3)
        if need:
            found["snapshot_requests"] = int(found.get("snapshot_requests") or 0) + 1
        mut["events"] = True
        return {"event": public_event(found), "created": created, "need_snapshot": need}, mut
    if op == "snap_put":
        ev = find(str(req.get("id") or ""))
        if ev.get("category") not in SNAPSHOT_CATEGORIES or ev.get("has_snapshot") or int(ev.get("snapshot_requests") or 0) < 1:
            raise FaceOpError("snapshot_not_expected")
        if not req.get("blob"):
            raise FaceOpError("bad_request")
        ev["has_snapshot"] = True
        mut["snap_put"][ev["id"]] = req["blob"]
        mut["events"] = True
        return {"id": ev["id"]}, mut
    if op == "event_review":
        action = str(req.get("action") or "")
        if action not in REVIEW_ACTIONS:
            raise FaceOpError("bad_request")
        ev = find(str(req.get("id") or ""))
        ev["status"] = REVIEW_ACTIONS[action]
        ev["alert_ack"] = True
        ev["reviewed_by"] = str(req.get("by") or "")[:64]
        ev["reviewed_at"] = _iso(now)
        mut["events"] = True
        return {"event": public_event(ev)}, mut
    if op == "event_delete":
        ev = find(str(req.get("id") or ""))
        events.remove(ev)
        if ev.get("has_snapshot"):
            mut["snap_del"].append(ev["id"])
        mut["events"] = True
        return {"id": ev["id"]}, mut
    raise FaceOpError("bad_request")


class LocalFaceStore:
    """In-process registry used only when no Durable Object is bound (local/dev/tests)."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.people, self.events, self.snaps = {}, [], {}

    def call(self, req):
        if req.get("op") == "snap_get":
            blob = self.snaps.get(str(req.get("id") or ""))
            if not blob:
                raise FaceOpError("not_found")
            return {"blob": blob}
        result, mut = apply_op(req, self.people, self.events)
        for sid in mut["snap_del"]:
            self.snaps.pop(sid, None)
        self.snaps.update(mut["snap_put"])
        return result


local_store = LocalFaceStore()


def local_op(req):
    return local_store.call(req)
