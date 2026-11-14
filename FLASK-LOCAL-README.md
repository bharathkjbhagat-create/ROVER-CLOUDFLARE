# DEFENX Flask backend (standalone)

The project already contains the Flask application in `src/app.py`. The
Cloudflare production entrypoint remains `src/worker.py`; `run.py` is an
additional standalone launcher for local development or a conventional WSGI
host. Existing `public/` dashboard files are served without redesigning them.

## Run locally

1. Install Python 3.12 or newer.
2. Create and activate a virtual environment.
3. Install dependencies: `python -m pip install -r requirements.txt`.
4. Copy `.env.local.example` to `.env` and set a unique `SESSION_SECRET` and
   strong `ADMIN_PASSWORD`. Export those variables in your shell (or use your
   hosting platform's environment-variable settings); this app does not load
   `.env` files automatically.
5. Start: `python run.py`.
6. Open `http://127.0.0.1:5000/login.html`.

Set `COOKIE_SECURE=1` when served over HTTPS. Never use `COOKIE_SECURE=0` on a
public HTTPS deployment. Do not commit real secrets. For persistent users,
biometric enrollment records and audit history, configure PostgreSQL via
`DATABASE_URL` before exposing the service publicly.

## Cloudflare

Do not replace the Worker entrypoint. Continue deploying with `wrangler.jsonc`
and `.github/workflows/cloudflare-deploy.yml`; Cloudflare bindings, Durable
Objects, WebSockets and static assets are handled by `src/worker.py`.

## Simulation Lab on Flask

The dashboard's **Simulation Lab** (software rover simulation, `docs/SIMULATION_LAB.md`) runs in the browser and can sync its
offline event journal to this Flask server:

* Start with `python run.py` or `scripts/run_local.sh` (both bind to `127.0.0.1`; set `HOST`/`PORT` to change, `HOST=0.0.0.0` only deliberately).
* Log in as the administrator, open **SIMULATION LAB → OPEN SIMULATION LAB**, choose **Cloud: real Flask server**.
* Events are posted to `POST /api/fleet/sim/events` (administrator session, max 50 per batch, idempotent by event id) and stored under the
  reserved id `SIM-ROVER` with `source: "simulation"`. View them with `GET /api/fleet/events?device=SIM-ROVER`; they never appear in the
  normal rover event feed and never create a device.
* The Flask app now serves every file in `public/` itself (whitelisted extensions, plain top-level names only), so no separate static server is needed.

## Optional local YOLOv8n CPU vision

Cloudflare still hosts the dashboard and signaling service. To use the verified
local Python 3.11 + CPU PyTorch + YOLOv8n + OpenCV setup, run the loopback-only
inference API on the same PC as the browser. It analyzes frames from the
dashboard's current live camera stream; it does not open the webcam itself. The
existing browser TensorFlow.js AI remains available.

1. Keep `C:\DEFENX\venv` and the existing model file. Do not reinstall Python,
   PyTorch, Ultralytics, or OpenCV.
2. Start the existing FastAPI server on the same PC as the browser:

   ```cmd
   cd /d C:\DEFENX
   venv\Scripts\activate
   set DEFENX_AI_ALLOWED_ORIGINS=https://defenx.bindukjagadish.workers.dev,http://127.0.0.1:5000,http://localhost:5000,http://127.0.0.1:8000,http://localhost:8000
   python -m uvicorn ai_server:app --host 127.0.0.1 --port 8000
   ```

   Keep this window open. The dashboard sends JPEG uploads to `/detect` on
   `127.0.0.1:8000`; the API accepts the deployed dashboard origin listed
   above, binds only to loopback, and needs no Cloudflare credentials. For a
   custom deployed domain, add its exact `https://` origin to the variable.
3. Sign in to the dashboard, open its live camera, and press **START LOCAL
   YOLO**. The local row reports YOLOv8n CPU detections separately from the
   existing browser AI counts. Turn on **VEHICLE ALERTS** or **OBJECT ALERTS**
   in **DETECTION EVENTS & ALERTS** to add configured live YOLO detections to
   the dashboard feed and authenticated admin audit. Vehicle alerts cover
   detected vehicle classes; object alerts use the existing configured object
   classes. Repeated same-class detections are limited to one alert per six
   seconds. Browser notifications additionally require **ALERTS ON** and browser
   permission. Press **STOP LOCAL YOLO** to stop frame transfer.

The local inference process, camera permissions, browser loopback access, and
physical rover are separate from Cloudflare deployment. Python runs on the
Windows PC; Cloudflare hosts the website and its authenticated alert API. API
and mock-based software checks do not verify those user-specific components.


## PC-local face recognition panel

The dashboard includes an operator-started **PC-LOCAL FACE ID** panel for the FastAPI service in `C:\DEFENX`. It uses the existing live camera only after the operator starts the panel. Frames go to `127.0.0.1:8000/face-detect`; the browser draws recognized names and unknown-face alerts locally. The panel also lets the operator capture one live frame and enroll it under a name such as **Bharath** using `/faces/enroll`. Enrollment requires exactly one clear face; the face template is saved in `C:\DEFENX\face_gallery.json`, and the photograph itself is not saved. The gallery list can remove an old placeholder label before re-enrolling with the correct name. Names and face alerts stay in this browser and are not sent to Cloudflare. This local gallery is separate from the encrypted administrator face registry.

Start the existing FastAPI server in a second Command Prompt on the same PC as the browser:

```cmd
cd /d C:\DEFENX
venv\Scripts\activate
set DEFENX_AI_ALLOWED_ORIGINS=https://defenx.bindukjagadish.workers.dev,http://127.0.0.1:5000,http://localhost:5000,http://127.0.0.1:8000,http://localhost:8000
python -m uvicorn ai_server:app --host 127.0.0.1 --port 8000
```

For another dashboard hostname, replace the production origin in the comma-separated allowlist with that exact `https://` origin. Restart FastAPI after changing its code or origin list. The panel does not open or stop the dashboard camera; use the existing camera controls for that. Press **START LOCAL FACE ID** to send frames to this PC and **STOP LOCAL FACE ID** to stop analysis. Close the dashboard or stop its camera separately when camera capture should end.

When Chromium asks, allow the dashboard to access local-network/loopback services. If access still fails, confirm the server window is running and the dashboard origin exactly matches `DEFENX_AI_ALLOWED_ORIGINS`. The FastAPI process remains bound to `127.0.0.1`; do not change it to `0.0.0.0` or expose port 8000 publicly.


