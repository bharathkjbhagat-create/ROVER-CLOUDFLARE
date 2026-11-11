# DEFENX Fleet Sync, Rover Hardware & Offline Autonomy

## Architecture
```
Dashboard (browser) --cookie session--> /api/fleet/*  (Flask on Cloudflare Python Worker)
Phone (device-client.html) --HMAC-signed HTTPS--> /api/fleet/heartbeat | events/upload | commands/ack
ESP32 rover (firmware)     --HMAC-signed HTTPS--> same endpoints, replies are HMAC-signed too
Persistence: Durable Object RealtimeHub.fleet_op -> src/fleet_do.py (registry, status, nonces, command queue, event ring)
Autonomy: firmware/rover_core/nav_core.h  (runs ON the rover; no cloud dependency)
```
* Device secret = HMAC(`FLEET_MASTER_SECRET`, `defenx-device-v<ver>:<id>`); shown once at registration; rotate/revoke from the Fleet panel.
* Request signature: HMAC-SHA256 over `METHOD\nPATH\nDEVICE_ID\nTIMESTAMP\nNONCE\nSHA256(body)`; ±60 s clock window; each nonce accepted once (replay protection); heartbeat `seq` per `boot_id` rejects out-of-order packets.
* Server replies are signed over the request nonce: a device ignores any command not signed by the server for that request.
* Devices cannot command each other: there is no device→command endpoint. Commands come only from logged-in operators, pass `FleetService.preflight` (battery, fresh GPS, obstacle data, e-stop, RTB state, base saved, rover role) and are repeated by the device's own safety checks. `RETURN_TO_BASE`, `RESET_ESTOP`, base saving and device management are admin-only.
* Movement commands expire after 1.5 s (rover stops itself); STOP/E-STOP supersede queued motion and are accepted even if the rover is offline (delivered on reconnect).
* Offline events: rover journals events + GPS track to flash; uploaded in batches; a record leaves the queue only after the server returns it in `stored_ids`, server dedupes by `(device, event id)`.
* Transport is HTTPS request/response at ~1 Hz (not device-side WebSockets). Dashboard refreshes by polling every 1.5 s. See "Known limitations".

## Deploy
1. `npx wrangler secret put FLEET_MASTER_SECRET` (≥32 random chars), keep existing secrets. Optional vars: `FLEET_PRIMARY_ROVER`, `DEVICE_OFFLINE_AFTER_SECONDS`.
2. `npx wrangler deploy` (no schema migration needed: fleet data lives in the existing `REALTIME_HUB` Durable Object; no SQL tables added).
3. Dashboard → Fleet & Autonomy → register `ROVER-01` (role rover) and `PHONE-01` (role phone). Copy each secret immediately.
4. Phone: open `https://<your-worker>/device-client.html`, enter ID + secret, START (grant location permission).
5. Rover: copy `firmware/esp32_rover/config.example.h` to `config.h`, fill values, flash with Arduino IDE (libraries: ArduinoJson 7, TinyGPSPlus; board ESP32).

## Wiring (ESP32 DevKit; pins are all in config.h)
| Part | Connection |
|---|---|
| L298N/TB6612 | IN1/IN2/EN to pins in config; **EN pull-down 10 kΩ to GND** so motors are off during boot/reset |
| HC-SR04 ×3 (front/left/right) | TRIG→GPIO, ECHO→GPIO through a 5 V→3.3 V divider (1 kΩ/2 kΩ) |
| GPS u-blox NEO-6M/M8N | GPS TX→GPIO16, GPS RX→GPIO17, 3.3–5 V per module; antenna with sky view |
| QMC5883L compass | SDA/SCL (GPIO21/22 default I²C — **move the right HC-SR04 off 21/22** or change pins in config) level mount, away from motors; calibrate. (I²C uses default GPIO21/22; right ultrasonic is on 23/13) |
| Battery | 3S pack → divider (ratio in config) → GPIO35; never connect pack directly to ADC |
| E-STOP | Latching NC switch: reads HIGH when pressed/open **and** cuts motor supply in hardware (a software-only e-stop is not enough) |
| ESP32-CAM | Separate board running the Arduino CameraWebServer example; set `ROVER_CAMERA_STREAM_URL` (existing dashboard setting) to its MJPEG `/stream`. Existing dashboard handles reconnect. Camera health is not yet reported by the ESP32 firmware (`camera:false` in heartbeat) |


## Safety model (nav_core.h)
FSM states: BOOT, IDLE, MANUAL, RTB_PRECHECK, RTB_NAVIGATE, RTB_AVOID, RTB_VERIFY_DOCK, RTB_ARRIVED, PAUSED_OBSTACLE/LOCALIZATION/SENSOR_FAULT/LOW_BATTERY, ESTOP, FAILED.
* E-stop (command, button, hardware fault) latches; only an explicit `RESET_ESTOP` with button released and healthy sensors clears it, and returns to IDLE (never straight to motion).
* Every motor output passes `finish()`: speed clamp, forward blocked unless the front ultrasonic is fresh (≤500 ms), valid and >30 cm, forward blocked if a side sensor reads ≤20 cm, reverse needs a rear sensor, battery ≤12 % → zero.
* Invalid/timeout/stale/implausible sensor reading ⇒ stop. GPS needs fix, ≥4 sats, accuracy ≤15 m (HDOP×2.5 estimate), age ≤3 s, and no teleport (>6 m/s implied). Heading needs a compass.
* RTB: precheck (base, GPS, heading, sensor, battery ≥25 %) → navigate by bearing/compass → obstacle ⇒ stop, settle, pick clear side (both side sensors must be valid, else FAILED NO_SAFE_ROUTE), turn 90°, advance 3 m, re-plan; max 4 detours; 25 s no-progress watchdog; 10 s turn timeout. Arrival = N consecutive trusted fixes inside 2.5 m **while stopped** (RTB_VERIFY_DOCK) and is reported by the rover only. GPS accuracy limits what "arrived" means (metre-scale, not a physical dock).
* Localisation dropouts allow a bounded auto-resume (≤2, within 10 s, fresh data). Sensor/battery/obstacle failures require a new operator command.
* Link loss: classified WIFI_DOWN / INTERNET_DOWN / SERVER_DOWN (1.1.1.1:53 probe). Manual driving stops after 1.5 s. Offline declared after 5 s; autonomy capped at 15 min. Automatic return after link loss is **opt-in** (`OFFLINE_AUTO_RTB`, default off) with 30 s delay and all RTB preconditions.
* Hardware watchdog 3 s (reset ⇒ pull-downs keep motors off). Motors are driven in exactly one place (`driveMotors(rover.tick(...))`).
* **First power-up: wheels off the ground, battery power only through the e-stop.**

## Verification status (be honest)
| Item | Status |
|---|---|
| Fleet protocol, auth, replay, gating, persistence logic | Automated tests pass (unit, HTTP, multi-process, Chromium) |
| Durable Object storage code | Logic tested against a fake storage; **not run on a real Workers runtime** |
| nav_core.h state machine | Passes C++ simulation incl. 300 random worlds; simulation uses idealised sensors |
| ESP32 sketch | **Not compiled or flashed**; expect to fix compile/pin issues |
| GPS, ultrasonic, compass, motors, battery, camera, real RTB | **Not tested - no hardware** |
| Two physical phones | **Not tested** (software processes only) |
| Face recognition accuracy / anti-spoof | **Not validated with real people/attacks** |

### Physical test checklist (must be done on real equipment)
1. Wheels lifted: boot, confirm motors idle; press hardware e-stop; confirm motor power cut; pull ESP32 USB/reset ⇒ motors stay off.
2. Sensors: each HC-SR04 vs tape measure at 10/30/100 cm; cover/unplug each ⇒ SENSOR FAULT and no motion.
3. GPS outdoors: fix time, accuracy vs known point, unplug antenna ⇒ GPS UNAVAILABLE and RTB refused.
4. Compass calibration against a handheld compass at 8 headings.
5. Command latency + 1.5 s TTL stop; kill Wi-Fi ⇒ stop in ≈1.5 s.
6. Link-loss classification: router off (WIFI_DOWN), router on/WAN unplugged (INTERNET_DOWN), block Worker host (SERVER_DOWN).
7. Offline run (≥10–15 min, battery logged): events/GPS track persisted; reconnect ⇒ upload, no duplicates, dashboard restored.
8. RTB on open ground at low PWM with a person on the e-stop: obstacle (box) detour, no-route (wall) ⇒ safe stop, GPS-block ⇒ pause, low battery.
9. Two real phones + dashboard: location/status propagate, airplane-mode phone shows OFFLINE then recovers.
10. Face recognition: enrol ≥3 people, test lighting/angles, printed photo + screen replay attacks; record FAR/FRR before trusting it.

## Known limitations
* No device-side WebSocket; ~1 s signed HTTPS polling.
* Per-instance rate limiter (add Cloudflare WAF rate-limit rules for production).
* Server preflight sees telemetry up to 4 s old; the rover re-validates locally.
* Phone device secret lives in browser storage if "Remember" is ticked.
* Camera metadata upload: only camera up/down events; no frames.
* TLS: `TLS_ROOT_CA nullptr` uses `setInsecure()` – bench only; pin your CA for field use.
