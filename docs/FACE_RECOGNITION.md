# DEFENX Face Verification — implementation report

Recognition is **never** treated as evidence of hostile intent. No "threat"/"hostile" classification exists in the code; anyone not verified is `UNVERIFIED PERSON` until an administrator reviews them.

## Setup (required once)
1. Create a random secret of 32+ characters and add it as the GitHub/Cloudflare secret `FACE_DATA_KEY`. Without it the feature stays disabled (fails closed). **Back it up: losing it makes stored templates unreadable.**
2. Deploy. Sign in as the Admin → *Face Verification* card → *Authorized Personnel Registry*.
3. Enter a name, choose 3–5 clear front-facing photos per person (and/or "Add live camera frame" with the person standing in front of the rover), press **REGISTER**.

## How it works
| Stage | Where | Detail |
|---|---|---|
| Person gate | browser | Existing COCO-SSD detector; face models load only when a person is in view (keeps camera smooth). |
| Face detection, landmarks, 128-d embedding | browser | `@vladmandic/face-api@1.7.15` (TinyFaceDetector + 68-pt landmarks + ResNet-34 recognition net). Frames are not uploaded. |
| Quality gate | browser | face size, detection score, head angle, brightness, blur. Failing → **VERIFICATION REQUIRED**, never "unknown". |
| Mask / obstruction check | browser | Lower-face colour/skin analysis from landmark patches (mask, scarf), eye-region darkness (sunglasses). |
| Matching + decision | **server** (`src/faces.py`) | Embeddings of ≥2 frames are compared with decrypted templates; templates never leave the server. |
| Storage | Durable Object | Templates/names/snapshots are authenticated ciphertext (HMAC-SHA256 stream + HMAC tag, key from `FACE_DATA_KEY`, record-bound). Event metadata is plain. |

### Decision policy (all thresholds are Euclidean distance, env-tunable)
- `AUTHORIZED PERSONNEL – VERIFIED`: median distance ≤ **0.50**, ≥60 % of frames agree, and ≥0.06 better than the second-best person. No alert, no popup, no snapshot, no audit alert.
- Face partly covered: only authorized if distance ≤ **0.40** (stricter); otherwise `IDENTITY UNVERIFIED – FACE OBSCURED` + admin notice.
- Clear face, distance > **0.62** in ≥60 % of frames: `UNKNOWN PERSON DETECTED` (classification `UNVERIFIED PERSON`) + encrypted snapshot + time + camera/GPS + admin notice + audit entry.
- In-between / poor light / bad angle / too small / person facing away: `VERIFICATION REQUIRED` (no alarm). Still unresolved after 10 s → `IDENTITY UNVERIFIED` + admin notice.
- Registry unreadable, <2 frames, or server error → `VERIFICATION REQUIRED` (fail-safe, never authorized, never unknown).
- Duplicate suppression: one event per category/camera/person per 60 s of continuous detection (300 s for authorized), across all devices.

### Dashboard / sync
Five category tiles (24 h counts), event list with timestamp, camera, GPS, status, snapshot (admin only), admin actions *Mark verified / Dismiss / Delete*. Events live in the Durable Object, so every device sees the same list. The sensor-based "TARGET DETECTED" popup is suppressed only when the target is a person within 15 m **and** every person in view is currently authorized.

### Privacy / security
Admin-only: register, revoke, reinstate, delete, view snapshots, review events (all audit-logged: `FACE_REGISTER/REVOKE/REINSTATE/DELETE/ALERT/REVIEW`). Non-admins see only category/status — no names, no images. Revoke = keep data but stop authorizing; Delete = erase templates. Source photos are never uploaded. Snapshots auto-expire after 7 days. Observe endpoint is rate-limited (90/min/user) to limit probing.

## Test results
Run in this build environment (all passing; 47 Python tests including the 33 new ones, plus smoke, budgets and `node --check`):
- `tests/test_face_recognition.py` — encryption (tamper, wrong key, record-swap), registered→authorized with no alert, unknown→alert once + dedupe + window expiry, masked→obscured, poor light→verification required, ambiguous/inconsistent frames not authorized, revoke/delete, admin-only endpoints, non-admin data hiding, snapshot validation, fail-closed without key, corrupt record fails safe, rate limit.
- `tests/face_logic.test.js` — mask/scarf/sunglasses detection on synthetic pixel data across light/medium/dark skin tones and blue/white/black/green masks, monochrome feed handled as "cannot judge", quality fallbacks (small, angle, dark, bright, blur), tracking.
- Existing `smoke.py`, auth and security regression suites unchanged and passing.

## NOT tested here — please run before relying on it
This sandbox has no internet, no camera, and I was not given face photos, so the **neural networks were never executed**, and no real faces, masks, lighting or angles were tested. The tests above use synthetic embeddings and pixels, so they prove the decision logic, not real-world accuracy. Field test (record results, tune thresholds):

| Case | Expected |
|---|---|
| Each registered person, normal light, frontal | AUTHORIZED, no popup/alert |
| Same, ±25° yaw / dim room / 3 m away | AUTHORIZED or VERIFICATION REQUIRED — never UNKNOWN alert |
| Registered person wearing surgical mask | AUTHORIZED only if strong match, else FACE OBSCURED (admin notice) |
| Unregistered person (several, different ethnicities/ages) | UNKNOWN + snapshot + admin notice |
| Look-alike of a registered person | not AUTHORIZED |
| Photo of a registered person held up to the camera | **will likely pass** (no liveness check) |
| Revoke person → same face | UNKNOWN |

## Known limitations
- No liveness / anti-spoofing (photo or screen replay can authorize). Do not use as sole access control.
- face-api.js is older and less accurate than modern models; mask/angle/low-light accuracy is limited. Mask detection is a colour heuristic (beards, make-up, IR/monochrome video can mislead; monochrome is treated as "cannot judge").
- Camera must be a direct MJPEG/video stream with CORS (same as existing AI vision); iframes cannot be analysed and snapshots need a non-tainted canvas.
- Models/library load from jsDelivr (pinned version, no SRI). Self-host them for offline/air-gapped use.
- Face checks run only while the dashboard is open in a browser with the camera visible; nothing runs on the rover itself.
- Encryption is a standard-library HMAC construction (Workers have no AES package); the key lives in the same Worker as the data, so protection is against data-store disclosure, not a compromised Worker.
- Two different unknown people at once share one event (dedupe is per category/camera). Any signed-in user's browser can submit observations (needed for matching); responses reveal only category, not distances or names.
- "Another approved verification method" is limited to administrator manual verification (*Mark verified*); no badge/PIN/voice hardware is integrated.
