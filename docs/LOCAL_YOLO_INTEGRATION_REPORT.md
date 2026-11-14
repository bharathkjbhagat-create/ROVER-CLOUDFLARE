# DEFENX local YOLO integration handoff

## Architecture

- Cloudflare Worker, Durable Object/WebRTC signaling, existing dashboard controls,
  ESP32 protocol, browser TensorFlow.js AI, and offline-patrol sync remain in
  their existing paths.
- `public/local-yolo.js` adds an operator-started second inference option. It
  reads only the current live camera element (`roverRealCamera`), scales a frame
  to at most 640 pixels wide, and sends JPEG bytes to `127.0.0.1:8765`.
- `src/local_ai_api.py` is a separate loopback-only Flask service. It decodes the
  frame with OpenCV and calls the installed Ultralytics YOLO model with
  `device="cpu"`; detections return to the dashboard as boxes, class names, and
  confidence. No camera is opened by the service and no image is sent to
  Cloudflare. The model path defaults to `yolov8n.pt` in the project root and
  can be set with `DEFENX_YOLO_MODEL`.
- The browser shows local YOLO counts and status separately from the existing
  browser-AI counts. Demo mode cannot activate this service. The local endpoint
  binds to IPv4 loopback, checks the request Host and allowed Origin, handles
  browser preflight, caps frames at 2 MiB, and never enables Flask debug mode.

## Changed files

- Added `src/local_ai_api.py` and `public/local-yolo.js`.
- Added local YOLO panel and script reference in `public/index.html`; added its
  styles in `public/style.css`.
- Added `tests/test_local_yolo_api.py` with mocked inference coverage.
- Added setup and limitation notes to `FLASK-LOCAL-README.md` and `README.md`;
  added a 12 KB frontend budget for the new client.

## Verification

- **PASS:** Python syntax compilation of the new API/test and existing `src/app.py`
  and `src/worker.py` using host Python 3.15.
- **PASS:** `node --check` for the new browser client and existing dashboard AI
  scripts.
- **PASS:** Frontend performance budgets; generated embedded WebP assets.
- **PASS:** Existing vision-core tests, 19/19.
- **PARTIAL:** Simulation + spoof suite, 35/37. Two spoof assertions failed in
  the supplied source tree: animated-screen test setup expected motion that was
  not present, and the full-frame replay case expected `LIVE HUMAN` while the
  code returned `UNVERIFIED`.
- **PARTIAL:** Fleet protocol suite, 2/4. Its Python cross-language checks could
  not start because the test invokes `python3`, which is not installed here.
- **NOT RUN:** New Flask API tests and Flask smoke/browser suites. Host Python
  has no Flask, and package downloads are unavailable. The reported
  `C:\DEFENX\venv\Scripts\python.exe` also failed to launch because its base
  Python 3.11 executable path is unavailable in this environment; it was not
  changed. Full Python discovery ran 167 tests and reported 8 failures and 6
  errors, driven by missing `cryptography`/`pyodide` for biometric checks and
  resulting fail-closed biometric responses.
- **NOT RUN:** Live camera-to-YOLO inference, browser loopback permission, custom
  production-domain CORS, Cloudflare deployment/credentials, ESP32 firmware
  build (`g++` unavailable), or physical rover behavior.

The supplied conversation verifies that YOLOv8n and camera inference worked
previously on the user's PC. This report does not claim the new dashboard/API
connection has been exercised on that PC; follow `FLASK-LOCAL-README.md` and
verify the live camera connection there.

## Dashboard-alert continuation (2026-11-14)

- The local YOLO client forwards configured vehicle and object detections
  through the existing `DEFENX_ALERTS` dashboard event path. The operator must
  enable the corresponding VEHICLE ALERTS or OBJECT ALERTS toggle. Object alerts
  use the existing configured alert classes.
- Repeated detections of the same class are rate-limited locally; the existing
  alert gate also suppresses continuous repeats. Alerts appear in the dashboard
  event list with class, confidence, time, and `YOLOv8n CPU` label.
- The existing authenticated `POST /api/detection-alerts` and admin-only history
  API persist alert metadata. Person alerts retain the separate verified-live-
  face safeguards; general YOLO person boxes do not create person identity alerts.
- **PASS:** dashboard script syntax checks; browser vision-core tests (19/19);
  Python syntax compilation.
- **NOT RUN:** Flask API tests and full browser-to-Cloudflare persistence. The
  available Python environment lacks Flask. Live camera inference, browser
  loopback permission, and production Cloudflare deployment also remain
  unverified.
