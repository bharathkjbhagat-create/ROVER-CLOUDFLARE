# DEFENX Return-to-Base Architecture and Safety Contract

## Implementation status

The repository contains two separate implementations. They must not be confused:

1. **Physical-device software path:** authenticated dashboard command -> fleet API -> signed, expiring device command -> ESP32 firmware state machine in `firmware/esp32_rover/nav_core.h`. The ESP32 makes local movement decisions and enforces sensor, GPS, battery, link-loss and emergency-stop checks. The device reports its own state and arrival.
2. **Simulation Lab:** `public/sim-core.js` and `public/sim-lab.js` simulate exploration, offline journaling, route planning and return-to-base in software. The simulation never drives a physical rover.

The firmware and server-side path are implemented in source and covered by software tests/simulation. They have **not** been compiled/flashed on the user's ESP32 or validated on a physical rover. No physical navigation or docking capability is certified.

## Implemented physical-device path

- The authenticated Fleet panel can register devices, save a base, request/cancel return, and display device-reported status.
- Device requests use per-device HMAC authentication, timestamp/nonce replay protection, signed server responses, command expiry and explicit acknowledgements.
- The server applies an admin-only return-to-base gate and preflight checks against fresh telemetry, device role/status, GPS, battery, obstacle sensors, safety-controller health, e-stop and saved base.
- The ESP32 runs the local finite-state machine in `firmware/esp32_rover/nav_core.h`; the website is not the motor controller.
- Local checks enforce motor output limits, stale/invalid sensor stops, GPS freshness/plausibility, compass freshness, battery reserve, watchdog and latched emergency stop.
- Offline event history is journalled to LittleFS and uploaded idempotently after reconnection. Manual movement commands expire; link-loss autonomy is time-limited. Automatic return after link loss is opt-in and disabled by default.
- Arrival is reported only by the device after it is stopped and multiple trusted GPS fixes are inside the configured arrival radius. This is a GPS arrival estimate, not proof of physical docking.

## Hardware configuration still required

Before any physical movement is enabled, the owner must configure and validate the exact motor driver, wheel polarity, sensor pinout, battery divider, GPS, compass, emergency-stop circuit, and device credentials. The example firmware configuration is a template, not a ready-to-drive configuration.

Important limitations in the current example:
- No rear range sensor is fitted; reverse movement is intentionally refused by the safety core.
- The example camera health field is false; the separate ESP32-CAM stream is not independently health-checked by this firmware.
- GPS accuracy is estimated from HDOP and is not a precision docking sensor.
- `TLS_ROOT_CA nullptr` uses insecure TLS for bench-only convenience. Do not use that configuration on an untrusted network; configure a trusted CA certificate before field use.
- `OFFLINE_AUTO_RTB` defaults to 0. Keep it disabled until supervised, controlled tests validate the complete physical setup.

## Simulation Lab

The Simulation Lab is an independent software-only environment. It supports exploration, simulated GPS and ultrasonic sensors, obstacle detours, offline event journaling, reconnection sync, base selection, return-to-base, arrival verification and injected fault scenarios. Its rover marker and map overlays are explicitly labelled as simulated. Simulation results do not establish physical rover safety or performance.

## Physical acceptance checklist

Do not test with wheels on the ground until the electrical safety checks are complete. A qualified adult/supervisor should oversee battery, motor-driver and wiring work.

1. With motors disconnected, verify boot/reset always leaves motor outputs disabled.
2. Verify the normally-closed emergency-stop switch and independent hardware motor-power cut; do not rely on software alone.
3. Verify each range sensor, its voltage divider, stale/timeout handling and obstacle-stop behavior.
4. Verify GPS fix quality, age and dropout handling outdoors; verify compass calibration and orientation.
5. Verify battery measurement and low-battery stop thresholds using a safe, appropriate power setup.
6. Verify command expiry, signed response validation, STOP and emergency stop before any low-speed movement test.
7. Verify link loss stops manual motion; keep automatic offline return disabled during initial tests.
8. Verify offline event persistence and deduplicated upload after reconnection.
9. Only after all previous checks pass, perform supervised low-speed tests in a clear, controlled area with a physical emergency stop operator.
10. Record measured stopping distance, GPS error, sensor errors and any failed test. Do not treat a passing simulation as a substitute.

## What is and is not verified

| Area | Current evidence |
|---|---|
| Fleet authentication, replay protection, command gating and acknowledgements | Automated software tests |
| Two independent device clients | Separate OS-process integration tests; not two physical phones |
| ESP32 navigation state machine | C++ simulation tests; not an ESP32 build/flash |
| Offline journal and server deduplication | Software tests and simulation |
| Dashboard Simulation Lab | Browser tests in a simulated environment |
| Cloudflare Durable Object runtime behavior for all fleet flows | Requires production runtime testing |
| Real camera recognition and anti-spoof accuracy | Not validated with real camera/model sessions |
| Physical GPS, compass, range sensors, motors, battery and return-to-base | Not tested on hardware |

## Required fail-safe behavior

Unknown capability, invalid or stale localization, sensor faults, unsafe obstacle range, low battery, e-stop, expired commands, or loss of a required safety input must result in refusal or a stopped state. No dashboard-side optimistic update may claim movement, obstacle clearance, GPS lock, stop, or arrival without device telemetry/acknowledgement.
