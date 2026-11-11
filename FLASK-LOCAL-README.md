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

