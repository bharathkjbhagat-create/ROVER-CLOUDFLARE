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
   PyTorch, Ultralytics, or OpenCV. If Flask is missing from that venv, install
   only Flask there: `C:\DEFENX\venv\Scripts\python.exe -m pip install Flask`.
2. In Command Prompt, set the existing model path and start the API using that
   venv (replace `<project-folder>` with the extracted project path):

   ```cmd
   set DEFENX_YOLO_MODEL=C:\DEFENX\yolov8n.pt
   set DEFENX_AI_ALLOWED_ORIGINS=https://defenx.bindukjagadish.workers.dev
   C:\DEFENX\venv\Scripts\python.exe <project-folder>\src\local_ai_api.py
   ```

   For a custom deployed domain, set its exact `https://` origin in
   `DEFENX_AI_ALLOWED_ORIGINS`. The API binds only to `127.0.0.1:8765` and
   needs no Cloudflare credentials.
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

