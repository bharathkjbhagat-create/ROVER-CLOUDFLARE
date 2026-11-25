"""Hosted YOLO object / face DETECTION proxy logic (no network I/O here).

Scope (by design):
  * Object detection and face *detection* (a bounding box that says "a face is
    here") only.
  * NO face identification, biometric matching, identity tracking or
    enrollment. Output dicts are built from a strict whitelist
    (class_name, confidence, normalized box) so identity-like fields returned by
    an upstream provider can never reach the browser.

Secrets (YOLO_API_KEY, YOLO_API_URL) are read from Worker bindings by the
caller and passed in; this module never logs them and never returns them.
The upstream request format is the Roboflow Serverless Cloud API format
(POST base64 image, bearer key in the Authorization header).
"""
from __future__ import annotations

import base64
import ipaddress
import math
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

MAX_IMAGE_BYTES = 1_500_000
MAX_DETECTIONS = 50
DEFAULT_MIN_CONFIDENCE = 0.35
UPSTREAM_TIMEOUT_SECONDS = 12
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class YoloError(Exception):
    """Error that is safe to show to the client (never contains secrets)."""

    def __init__(self, message: str, status: int = 502, code: str = "upstream_error"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def validate_upstream_url(raw_url: str) -> str:
    """Return a safe https URL or raise YoloError(503). Blocks SSRF targets."""
    raw_url = str(raw_url or "").strip()
    if not raw_url:
        raise YoloError("Hosted YOLO is not configured.", 503, "not_configured")
    parsed = urlparse(raw_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not host:
        raise YoloError("Hosted YOLO endpoint must be an https URL.", 503, "bad_config")
    if parsed.username or parsed.password:
        raise YoloError("Hosted YOLO endpoint must not embed credentials.", 503, "bad_config")
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        raise YoloError("Hosted YOLO endpoint host is not allowed.", 503, "bad_config")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and (
        address.is_private or address.is_loopback or address.is_link_local
        or address.is_reserved or address.is_multicast or address.is_unspecified
    ):
        raise YoloError("Hosted YOLO endpoint host is not allowed.", 503, "bad_config")
    return raw_url


def decode_image(body: bytes, content_type: str) -> bytes:
    """Accept a raw JPEG/PNG body. Validates size and magic bytes."""
    if not isinstance(body, (bytes, bytearray)) or not body:
        raise YoloError("No image received.", 400, "empty_image")
    if len(body) > MAX_IMAGE_BYTES:
        raise YoloError("Image is too large (limit 1.5 MB).", 413, "image_too_large")
    ctype = str(content_type or "").split(";")[0].strip().lower()
    if ctype not in {"image/jpeg", "image/jpg", "image/png"}:
        raise YoloError("Send the frame as image/jpeg or image/png.", 415, "bad_content_type")
    data = bytes(body)
    if not (data.startswith(JPEG_MAGIC) or data.startswith(PNG_MAGIC)):
        raise YoloError("Body is not a valid JPEG/PNG image.", 400, "bad_image")
    return data


def build_upstream(api_url: str, api_key: str, image: bytes):
    """Return (url, headers, body_bytes) for the hosted inference POST."""
    url = validate_upstream_url(api_url)
    api_key = str(api_key or "").strip()
    if not api_key:
        raise YoloError("Hosted YOLO is not configured.", 503, "not_configured")
    parsed = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
             if k not in {"api_key", "confidence"}]
    full = urlunparse(parsed._replace(query=urlencode(query)))
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }
    return full, headers, base64.b64encode(image)


def _num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_response(payload, min_confidence: float = DEFAULT_MIN_CONFIDENCE) -> dict:
    """Convert a Roboflow-style response to DEFENX's detection snapshot shape.

    Returns {"ok": True, "detections": [...], "faces": [...], "image": {w, h}}.
    Raises YoloError if the payload is not a recognisable detection response.
    Faces carry ONLY box + confidence: detection, never identification.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("predictions"), list):
        raise YoloError("Hosted YOLO returned an unexpected response.", 502, "bad_upstream_response")
    image = payload.get("image") if isinstance(payload.get("image"), dict) else {}
    width, height = _num(image.get("width")), _num(image.get("height"))
    if not width or not height or width <= 0 or height <= 0:
        raise YoloError("Hosted YOLO response is missing image size.", 502, "bad_upstream_response")
    detections, faces = [], []
    for item in payload["predictions"]:
        if not isinstance(item, dict):
            continue
        cx, cy, w, h = (_num(item.get(k)) for k in ("x", "y", "width", "height"))
        conf = _num(item.get("confidence"))
        if None in (cx, cy, w, h, conf) or w <= 0 or h <= 0:
            continue
        if conf < min_confidence or conf > 1.0:
            continue
        x1, y1 = max(0.0, (cx - w / 2) / width), max(0.0, (cy - h / 2) / height)
        x2, y2 = min(1.0, (cx + w / 2) / width), min(1.0, (cy + h / 2) / height)
        if x2 <= x1 or y2 <= y1:
            continue
        name = str(item.get("class") or item.get("class_name") or "object").strip().lower()[:32] or "object"
        entry = {
            "class_name": name,
            "confidence": round(conf, 4),
            "box": {"x1": round(x1, 5), "y1": round(y1, 5), "x2": round(x2, 5), "y2": round(y2, 5)},
        }
        if name in {"face", "human face", "human_face"}:
            faces.append({"confidence": entry["confidence"], "box": entry["box"]})
        else:
            detections.append(entry)
    detections.sort(key=lambda d: -d["confidence"])
    faces.sort(key=lambda d: -d["confidence"])
    return {
        "ok": True,
        "source": "hosted-yolo",
        "detections": detections[:MAX_DETECTIONS],
        "faces": faces[:MAX_DETECTIONS],
        "image": {"width": int(width), "height": int(height)},
    }


def map_upstream_status(status: int) -> YoloError:
    """Translate an upstream HTTP status into a client-safe error."""
    if status in (401, 403):
        return YoloError("Hosted YOLO rejected the server credentials.", 502, "upstream_auth")
    if status == 429:
        return YoloError("Hosted YOLO rate limit reached. Retrying shortly.", 429, "upstream_rate_limited")
    if status == 404:
        return YoloError("Hosted YOLO model endpoint was not found.", 502, "upstream_not_found")
    if 400 <= status < 500:
        return YoloError("Hosted YOLO rejected the request.", 502, "upstream_rejected")
    return YoloError("Hosted YOLO service is unavailable.", 502, "upstream_unavailable")

