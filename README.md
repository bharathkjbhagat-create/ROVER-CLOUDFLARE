# ROVER / DEFENX — Cloudflare Production

This is the clean Cloudflare deployment repository for the ROVER / DEFENX control centre.

## Stack
- Cloudflare Workers Python
- Flask backend
- Durable Objects for realtime state and WebSockets
- Cloudflare Workers Assets
- Mobile-first dashboard and login UI

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
python scripts/build_assets.py
python scripts/check_performance_budget.py
python tests/smoke.py
python -m unittest discover -s tests -p 'test_*.py'
```

Do not merge authentication changes or deploy to production until the GitHub Actions checks pass and the deployed login/session flow has been verified.
