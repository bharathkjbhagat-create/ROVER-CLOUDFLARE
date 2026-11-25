# ROVER / DEFENX — Cloudflare Production

This is the clean Cloudflare deployment repository for the ROVER / DEFENX control centre.

## Stack
- Cloudflare Workers Python
- Flask backend
- Durable Objects for realtime state and WebSockets
- Cloudflare Workers Assets
- Mobile-first dashboard and login UI

## Hosted YOLO detection (no local Python required)

The dashboard has a **HOSTED YOLO** bar under the camera view. When started, the browser sends a downscaled JPEG of the visible
camera frame to the authenticated same-origin endpoint `POST /api/yolo/detect`. The Cloudflare Worker (`src/worker.py`, logic in
`src/yolo_proxy.py`) forwards it to your hosted inference endpoint using server-side secrets and returns normalized boxes.

* **Detection only.** Objects and "a face is here" boxes. There is no face identification, matching, enrollment or identity tracking in this path;
  responses are built from a whitelist (`class_name`, `confidence`, `box`), so identity-like fields from a provider are dropped.
* **Secrets stay server-side.** Set them once, never in Git or the frontend:

      npx wrangler secret put YOLO_API_KEY
      npx wrangler secret put YOLO_API_URL     # https://serverless.roboflow.com/<project>/<version>

  For GitHub-driven deploys add the same two names as repository secrets; the deploy workflow syncs them to the Worker.
* Request format is the Roboflow Serverless Cloud API format (base64 body, bearer API key in the `Authorization` header). For a deployed model, set `YOLO_API_URL` to `https://serverless.roboflow.com/<project>/<version>`. The endpoint must be `https` and not a private/loopback host.
* `GET /api/yolo/status` reports only `configured: true|false`. Failures (not configured, upstream 401/429/5xx, network) are shown to the operator, never hidden.

## Production
https://defenx.bindukjagadish.workers.dev

## Required GitHub Actions secrets
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID

Optional application secrets are synced when present: ADMIN_PASSWORD, friend passwords, ROVER_DEVICE_TOKEN, camera settings, LIVE_SYNC_SECRET, and COOKIE_SECURE.

## Local checks
Run from the repository root with Python 3.12+ and dependencies installed:

```bash
python -m pip install -e .
python -m py_compile src/app.py src/worker.py
node --check public/app.js
node --check public/ai-vision.js
node --check public/monitor.js
python scripts/build_assets.py
python scripts/check_performance_budget.py
python tests/smoke.py
python -m unittest discover -s tests -p 'test_*.py'
```

Do not merge authentication changes or deploy to production until the GitHub Actions checks pass and the deployed login/session flow has been verified.

## Browser AI Vision

The authenticated dashboard can run local human and vehicle detection on a direct rover MJPEG/image or video stream. It loads TensorFlow.js 4.22.0 and COCO-SSD 2.2.3 only after a readable live stream is available, using the lightweight MobileNet V2 model. It draws detections in the browser and does not upload camera frames or send AI results to the backend. Cross-origin camera streams must allow CORS; embedded iframe feeds cannot be analysed by the browser detector. Demo/simulated camera scenes are never treated as real detections.

An optional local YOLOv8n CPU service can also analyze the same authenticated live camera frames on the operator's PC. It binds only to loopback, reports its results separately, and sends no frames to Cloudflare. Setup and browser loopback requirements are documented in [`FLASK-LOCAL-README.md`](FLASK-LOCAL-README.md#optional-local-yolov8n-cpu-vision). The local model, camera, and Cloudflare deployment must be verified on the user's configured devices.

## Biometric data protection

Face enrollment descriptors and reference photographs are encrypted with AES-256-GCM using Cloudflare Workers Web Crypto before they enter the Durable Object. The Durable Object stores only authenticated ciphertext and record metadata; new enrollment does not require PostgreSQL. On the first administrator registry read, existing consented PostgreSQL rows are validated and encrypted into the Durable Object. The old plaintext table is cleared only after every legacy record has a verified encrypted copy; if migration fails, the source rows are preserved and the API fails closed without returning biometric data. The encryption key is supplied only through the `FACE_DATA_KEY` secret; without a valid key or the Durable Object binding, enrollment and retrieval fail closed. No browser IndexedDB or plaintext fallback is permitted. The deployment workflow performs an authenticated AES-GCM runtime self-test, and the isolated preview tests the full encrypted create/list/photo/delete lifecycle using synthetic data. Back up the key securely: changing or losing it makes existing encrypted enrollments unreadable.

## DEFENX Return to Base

The current feature branch contains dashboard scaffolding for selecting a base and a fail-closed Return to Base request. Physical autonomous movement is intentionally disabled until controller capabilities and a hardware command/acknowledgement protocol are implemented and tested. See [`docs/RETURN_TO_BASE.md`](docs/RETURN_TO_BASE.md) for the proposed GPS + obstacle sensors + camera architecture, fail-safe state machine, device protocol contract, and acceptance tests. Do not merge/deploy this feature as hardware-ready.

## DEFENX Simulation Lab (software only)
`docs/SIMULATION_LAB.md` — dashboard card that simulates autonomous exploration, 10–15 minute offline operation, offline event journal + sync, obstacle detours, safe stops and return-to-base (map-selected base, arrival radius, stop-and-verify arrival). Loaded on demand. Not hardware evidence.

## PC-local face recognition

The dashboard includes an operator-started **PC-LOCAL FACE ID** panel that connects to the FastAPI service on the same PC at `127.0.0.1:8000`. It analyzes only the dashboard's current live camera frames, displays local gallery matches and unknown-face alerts, and does not send those frames, names or events to Cloudflare. It uses a separate local gallery from the encrypted administrator face registry. See [`FLASK-LOCAL-README.md`](FLASK-LOCAL-README.md#pc-local-face-recognition-panel) for setup and loopback/CORS requirements. The local inference service remains bound to loopback on the operator PC.
