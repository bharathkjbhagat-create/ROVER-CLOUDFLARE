# DEFENX Simulation Lab (software only)

A rover simulated entirely in the browser. **It is not hardware and proves nothing about physical motors, GPS modules or sensors.**
Open it from the dashboard card **SIMULATION LAB → OPEN SIMULATION LAB** (loaded on demand; hidden in the read-only demo view).

## What is simulated
| Part | Model |
|---|---|
| World | Ground-truth grid (0.5 m cells): open field, warehouse, corridor, large field. Obstacles are hidden from the rover. |
| Obstacle sensors | Front, left, right ultrasonic beams (4 m, noise, faults). |
| GPS | 1 Hz fixes with Gaussian noise (σ 0.3 m), dropouts; pose = odometry corrected by GPS. |
| Autonomy | Frontier exploration, 360° scans, clearance-inflated Dijkstra planner, detours, safe stop on no route / no progress / sensor fault / GPS lost / low battery / 15-min offline limit. |
| Offline storage | Event journal + explored map saved to `localStorage` (power-cycle safe; the rover stays idle after a reset). |
| Sync | Idempotent: an event leaves the queue only when the (simulated) cloud returns its id. Cloud modes: normal / lose replies / reject uploads (all in-browser) / **real Flask server** (`POST /api/fleet/sim/events`, administrator login, stored under `SIM-ROVER`, tagged `simulation`). |
| Return to base | Base picked on the grid or the live map, arrival radius 1–20 m, route progress + remaining distance, arrival declared **only** by the rover after it has stopped and 3 consecutive GPS fixes are inside the radius. Refused (fail closed) when offline, no GPS, sensor fault, low battery, e-stop. |

## Controls (every one performs a real action)
World/scenario, speed (1×–60×), RESET · START EXPLORATION, PAUSE/RESUME SIM, STOP ROVER, RESUME AUTONOMY · GO OFFLINE/ONLINE, 15-MIN OFFLINE TEST, cloud mode · PICK BASE, radius, SET RADIUS, RETURN TO BASE, CANCEL RETURN · DROP GPS, FRONT SENSOR FAULT, BLOCK ROUTE AHEAD, E-STOP, RESET E-STOP · Show on live map · Show true obstacles.

## How to test it yourself (2 minutes)
1. Log in, scroll to **SIMULATION LAB**, press **OPEN SIMULATION LAB**.
2. **START EXPLORATION**, set speed 20×. Watch the map fill in.
3. **GO OFFLINE** → status shows OFFLINE, events queue (`…`). Let it run, then **GO ONLINE** → events turn `✓`, message reports synced / duplicates / lost.
4. Set cloud mode **lose replies**, go offline → online: events are re-sent, the cloud still holds each id once. Choose **real Flask server** to sync the same way into the actual backend (check `GET /api/fleet/events?device=SIM-ROVER`).
5. **PICK BASE**, click a mapped cell, **RETURN TO BASE**. Try **BLOCK ROUTE AHEAD** mid-return (detour) and, in the *Corridor* world, block the only passage (safe stop: NO SAFE ROUTE).
6. **15-MIN OFFLINE TEST** (60×): runs ≥10 simulated minutes without any server contact; **GO ONLINE** syncs everything.
7. Tick **Show on live map** to see the simulated rover, route, base circle and distance on the Leaflet map (labelled simulation).
8. Reload the page: the journal and map come back; the rover is idle (as after a real power cycle).

## Automated tests
`scripts/run_all_tests.sh` runs everything. Simulation-specific: `tests/sim_core.test.js` (28), `tests/browser_sim_lab.py` (115 checks, mobile + desktop Chromium), `tests/test_sim_server_sync.py` (replays the simulated journal through the real signed `/api/fleet/events/upload`), `tests/test_sim_flask_endpoint.py` (6, the Lab's Flask endpoint), `tests/spoof_attacks.test.js` (8).

## Limits
- Simulated GPS/sensors/motors only. Real hardware will behave differently (wheel slip, GPS multipath, ultrasonic false echoes).
- The browser test checks the map overlay against a recording stand-in for Leaflet (Leaflet and map tiles cannot load without internet in the test sandbox). Confirm once in a real browser with internet.
- Cloud modes other than *real Flask server* are in-browser stand-ins. With *real Flask server* the events go through the real Flask app (tested locally); they were **not** tested against the deployed Cloudflare Worker.
