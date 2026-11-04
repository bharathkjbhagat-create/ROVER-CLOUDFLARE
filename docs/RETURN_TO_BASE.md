# DEFENX Return-to-Base Architecture and Safety Contract

## Status

The dashboard now includes a detailed OpenStreetMap road overlay, road-network route preview, and clear-preview controls. The overlay is a map-data aid, not a sensor or a guarantee that a narrow lane is physically traversable. The synthetic blocked-route display remains a visual demonstration only. Physical movement remains disabled until a verified software command/acknowledgement path and onboard safety telemetry exist. This document does not certify autonomous navigation.

## Recommended architecture

- **Website / Cloudflare control centre:** authenticated operator selects a base on the map, requests return, cancels, and views acknowledged state. The website is not the real-time motor controller.
- **Onboard navigation computer:** recommended Raspberry Pi-class computer for route planning, localization fusion, and camera inference. Select final model only after measuring camera workload, power budget, heat, and cost.
- **Independent safety controller:** ESP32-class microcontroller supervises motor outputs, sensor freshness, speed limits, watchdog, and emergency stop. Navigation software cannot override its stop state.
- **Localization:** GNSS/GPS plus wheel encoders and IMU; use GNSS accuracy/fix age and consistency checks. GPS coordinates alone do not prove traversability or precise docking.
- **Obstacle sensing:** multi-direction ranging sensors appropriate to the environment plus camera-based object/scene detection. Camera inference is supplementary, not the sole collision-protection layer.
- **Motor driver:** compatible with motor voltage and stall/startup current, with a hardware means to disable motor power safely.
- **Communications:** authenticated, replay-resistant, time-bounded command protocol with request ID, expiry, explicit acknowledgement, and telemetry. Network loss must not leave a stale movement command active.

## Software-only dashboard simulation

- Zoom the map to street level (zoom 15 or closer) to request mapped highway geometry for the visible area. The overlay includes major roads, residential streets, service roads, living streets, tracks, paths and pedestrian/cycle ways. It remains geographically aligned above the street, satellite, terrain and hybrid base layers.
- Select a base on the map. Preview Route requests a road-network route from a fresh, verified rover-device GPS fix. It is a visual preview only and sends no movement command.
- Use Simulate Blocked Route only to demonstrate a synthetic offset line; it does not detect an obstacle or calculate a safe detour. Use Clear Preview to remove the route overlay.
- The authenticated dashboard does not place a rover marker at a simulated coordinate. It displays a rover marker and track only from valid, recent `ROVER_DEVICE` GPS telemetry. Missing or stale GPS is shown as unavailable.
- A mapped width, lane count, access or surface field may be absent. Missing values are shown as “Not mapped”; they are never guessed. A mapped road does not prove the rover physically fits or has permission to enter.

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


## Precision mapping and cross-layer consistency

- The dashboard uses separate street, Esri World Imagery satellite, and OpenTopoMap terrain tile sources. Road vectors are a separate OpenStreetMap overlay; they do not modify or refresh satellite photographs.
- At zoom level 15 and closer, `public/road-detail-overlay.js` requests nearby OSM highway geometry from the public Overpass API. The overlay differentiates road classes and displays mapped name, width, lane count, surface and access tags when available. It is rendered as a geographic Leaflet layer above all existing map types, so its coordinates remain aligned when switching map style.
- The overlay caches viewed areas in the browser for 15 minutes and rate-limits new public Overpass requests to at most one every five minutes per browser session. Public Overpass instances can be overloaded; production should use a maintained commercial service or a self-hosted instance with regional extracts and update controls. Do not treat this public endpoint as a guaranteed navigation dependency.
- Road preview requests GeoJSON driving geometry from the public OSRM demo service. It is an on-demand preview only. When routing is unavailable, the app reports the failure and never substitutes a straight-line path. A production routing engine must use a rover-appropriate vehicle profile and verified map data.
- The authenticated rover marker requires device-reported `ROVER_DEVICE` GPS, a valid coordinate pair, reported accuracy at or below 100 m, a positive `gps_last_epoch`, and a GPS timestamp no more than 30 seconds old. Road preview and Return-to-Base prechecks apply a stricter limit of 25 m accuracy and 10 seconds GPS age.
- Pedestrian and cycle-only way classes are marked as such; mapped `access=no` or `private` ways are visually warned. These tags may still be missing or out of date. OSM geometry does not prove actual road width, legal permission, overhead clearance, turning space, surface condition, slope, or rover traversability. Onboard sensors and a measured rover envelope remain mandatory.
- Offline road extracts, offline tile storage, offline route planning, and local autonomous navigation are not implemented by this change. Satellite imagery is not live video; imagery freshness can only be shown when the imagery provider exposes trustworthy acquisition metadata.

## Production requirements before autonomous Return-to-Base

1. Select and operate a production routing service or self-host a routing engine with a suitable vehicle profile; do not depend on the public OSRM demo endpoint.
2. Add a maintained map-data ingestion/update strategy and regional offline extracts with licensing/attribution checks.
3. Define rover width, length, ground clearance, turning radius, maximum slope, permitted surfaces, and access policy; reject routes when required attributes are unknown.
4. Implement onboard localization (GNSS + IMU + wheel odometry as available), sensor health checks, obstacle sensing, and independent motor safety controller.
5. Implement authenticated device command/acknowledgement and state-machine endpoints. Until these are verified, Return-to-Base must remain blocked and preview-only.
6. Test with recorded routes and simulation, then motors disconnected, wheels raised, and finally a controlled low-speed test area.
