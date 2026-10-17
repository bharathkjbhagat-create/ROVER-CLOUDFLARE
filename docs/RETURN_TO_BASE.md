# DEFENX Return-to-Base Architecture and Safety Contract

## Status

Software route-preview controls are now included for dashboard testing: direct preview, a synthetic alternate route for a simulated obstacle, and clear preview. These are illustrative map overlays only, not road routing, live obstacle detection, or autonomous navigation. Physical movement remains disabled until a verified software command/acknowledgement path and telemetry exist. This document does not certify that the rover can navigate autonomously.

## Recommended architecture

- **Website / Cloudflare control centre:** authenticated operator selects a base on the map, requests return, cancels, and views acknowledged state. The website is not the real-time motor controller.
- **Onboard navigation computer:** recommended Raspberry Pi-class computer for route planning, localization fusion, and camera inference. Select final model only after measuring camera workload, power budget, heat, and cost.
- **Independent safety controller:** ESP32-class microcontroller supervises motor outputs, sensor freshness, speed limits, watchdog, and emergency stop. Navigation software cannot override its stop state.
- **Localization:** GNSS/GPS plus wheel encoders and IMU; use GNSS accuracy/fix age and consistency checks. GPS coordinates alone do not prove traversability or precise docking.
- **Obstacle sensing:** multi-direction ranging sensors appropriate to the environment plus camera-based object/scene detection. Camera inference is supplementary, not the sole collision-protection layer.
- **Motor driver:** compatible with motor voltage and stall/startup current, with a hardware means to disable motor power safely.
- **Communications:** authenticated, replay-resistant, time-bounded command protocol with request ID, expiry, explicit acknowledgement, and telemetry. Network loss must not leave a stale movement command active.

## Software-only dashboard simulation

- Select a base on the map and use Preview Route to draw a direct illustrative line from the dashboard rover marker to the selected base.
- Use Simulate Blocked Route to draw a synthetic offset path that demonstrates the alternate-route UI concept; no obstacle is actually detected and no safe route is computed.
- Use Clear Preview to remove the overlay.
- These controls send no rover movement commands. The displayed rover marker can be a demo marker; do not treat this preview as a real route or live position.

## Return workflow

1. Operator selects a base on the live map. Validate coordinate bounds and persist the base with an explicit timestamp and device association.
2. Operator requests return. The server authenticates control permission, validates the selected device/base, records an audit event, and sends a request—not a sequence of raw steering commands.
3. Onboard controller checks valid fresh localization, sensor health, battery reserve, motor/safety controller status, geofence, route feasibility, and autonomous mode.
4. Controller plans a traversable route and follows it locally. Website displays only device-acknowledged states.
5. On obstacle detection, slow/stop, assess a collision-free alternative using current sensor data, and replan only when confidence and clearance thresholds pass. If no safe route exists, stop, report a fault, and await operator intervention.
6. At the base, verify arrival using position confidence plus a suitable docking landmark/beacon/contact sensor where precision matters. Stop and acknowledge ARRIVED only after verification.

## Required state machine

IDLE -> PRECHECK -> PLANNING -> RETURNING -> VERIFYING_DOCK -> ARRIVED

Failure transitions: PRECHECK/PLANNING/RETURNING -> PAUSED_OBSTACLE, PAUSED_LOCALIZATION, PAUSED_SENSOR_FAULT, PAUSED_LOW_BATTERY, LINK_LOST_SAFE_STOP, or FAILED. A valid operator cancellation or emergency stop must transition to STOPPING -> STOPPED. Recovery from a fault requires fresh healthy telemetry and an explicit safe resume policy; never automatically resume blindly.

## Fail-safe requirements

- Unknown/unconfigured controller capability: refuse to start; send no motor command.
- Invalid, stale, jumping, or low-confidence GPS/localization: stop autonomous movement.
- Sensor timeout, controller watchdog trip, or unsafe range: motor cutoff and fault status.
- No validated alternate route: stop and alert; do not attempt blind turns or reverse maneuvers.
- Low battery: stop or follow only a validated recovery policy with sufficient reserve.
- Network loss: onboard controller owns the decision; expire remote commands and stop if local autonomy/safety cannot continue.
- Emergency stop must be available locally and must not depend on the website, internet, camera AI, or cloud service.
- Do not claim arrival, obstacle clearance, GPS lock, or physical stop from a website-side optimistic update; require device acknowledgements and telemetry.
- Test initially with motors disconnected, then wheels lifted, then a controlled low-speed area with an operator and physical kill switch.

## Device protocol (future implementation contract)

The device must explicitly report capability and health fields before autonomous return is enabled, including: autonomous_navigation, obstacle_avoidance, gps_fix, gps_accuracy_m, gps_last_epoch (or equivalent timestamp), obstacle_sensor_healthy, camera_healthy (if required by the configured policy), safety_controller_healthy, battery_pct, and device_timestamp.

A return request should include a unique request ID, device ID, base latitude/longitude, request timestamp, and expiry. Device response must acknowledge the same request ID and provide a state plus reason code. Cancellation and emergency-stop commands must be separately handled and acknowledged.

These field names are a proposed contract, not fields known to exist in current firmware. Do not enable physical movement until firmware and server implement and validate this contract end-to-end.

## Acceptance tests before enabling hardware

- Unauthorized user cannot request return or cancel another device's operation.
- Missing base, stale GPS, invalid coordinates, poor GPS accuracy, low battery, unhealthy sensor, and unknown capability each fail closed.
- A valid request is acknowledged by the physical device; duplicate and expired requests do not trigger motion.
- Each detected obstacle causes a verified stop before replanning; a blocked/no-route scenario remains stopped and alerts.
- Loss of internet, camera, GNSS, range sensor, navigation process, or safety-controller heartbeat produces the specified safe state.
- Cancel and local emergency stop work independently of cloud connectivity.
- Arrival is verified physically, motors are stopped, and the dashboard/audit log reflect device-confirmed status.
- Automated tests/build and supervised field tests pass before the draft PR is merged or deployed.
