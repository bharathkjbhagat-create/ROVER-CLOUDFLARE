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

## Quality and accessibility notes
- Keyboard users get a visible focus indicator on dashboard controls.
- Reduced-motion preferences are respected on the dashboard and sign-in page.
- Authentication pages and API responses are marked `Cache-Control: no-store`.
- Smoke tests cover security headers and sign-in form label associations.

## Local checks
```bash
uv run --group dev python tests/smoke.py
python -m py_compile src/app.py src/worker.py
node --check public/app.js
```
