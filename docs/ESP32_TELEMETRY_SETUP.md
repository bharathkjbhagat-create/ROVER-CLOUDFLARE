# ESP32 → DEFENX telemetry integration

## Scope

This first integration stage is **telemetry only**. It sends the HC-SR04 distance reading from an ESP32 to the existing authenticated device endpoint and displays it through the existing live dashboard state.

It does not send motor commands, enable steering, or enable autonomous navigation. Keep the rover's motor power disconnected during this communication test.

## Existing backend contract

- URL: `https://defenx.bindukjagadish.workers.dev/api/device/telemetry`
- Method: `POST`
- Content type: `application/json`
- Authentication: `X-Rover-Device-Token: <the configured device token>`
- Cloudflare secret name: `ROVER_DEVICE_TOKEN`

The backend already validates the device token and accepts `obstacle_cm`, `battery`, `signal`, `speed_kmh`, `heading`, GPS fields, network status and selected sensor metadata. A successful response is JSON with `ok: true`.

## Cloudflare setup

1. In the Cloudflare Worker settings, create or verify the secret named `ROVER_DEVICE_TOKEN`.
2. Use a long random token. Do not put the real token in GitHub, screenshots, chat, or a public Wokwi project.
3. If the secret is newly created or changed, redeploy the Worker.
4. Keep the device token only in your local firmware configuration. Rotate it if it is exposed.

## ESP32 wiring for the existing DEFENX Wokwi circuit

Use the wiring already confirmed in the project:

| HC-SR04 | ESP32 |
|---|---|
| VCC | VIN / 5V |
| GND | GND |
| TRIG | GPIO 5 |
| ECHO | GPIO 18 |

Do not rewire the working sensor for this test. For a physical ESP32, make sure the HC-SR04 ECHO signal is reduced to a safe 3.3 V logic level before it reaches an ESP32 GPIO; the ESP32 pins are not 5 V tolerant. A Wokwi simulation does not prove physical voltage compatibility.

## Firmware setup

1. Open `examples/esp32-telemetry/esp32-telemetry.ino` in Arduino IDE or the Wokwi ESP32 sketch.
2. Set the Wi-Fi SSID and password. For Wokwi's virtual network, use SSID `Wokwi-GUEST` and an empty password.
3. Set `ROVER_DEVICE_TOKEN` in the local sketch to the same secret configured in Cloudflare. Never commit the real value.
4. Add the correct trusted root CA certificate for the deployed HTTPS hostname in `ROOT_CA_CERT`. Obtain and verify the certificate chain for the exact hostname; do not replace certificate validation with `setInsecure()`.
5. Upload/run the sketch. The Serial Monitor should report Wi-Fi status, HTTP status, and whether the backend accepted each telemetry update.

## Expected test

- With no valid HC-SR04 echo, the sketch omits `obstacle_cm` rather than reporting a false zero-distance obstacle.
- With a valid echo, it posts the measured distance in centimetres.
- HTTP 200 plus JSON `ok: true` confirms the backend accepted the authenticated telemetry request.
- The website's live telemetry should update from the device. Confirm the source is the rover device, not the dashboard's demo simulation.

## Troubleshooting

- HTTP 401: the token is missing, mismatched, or the Worker secret is not configured.
- TLS/certificate error: verify the hostname and root CA chain; do not disable certificate verification.
- HTTP 404: check the deployed Worker hostname and exact `/api/device/telemetry` path.
- No distance value: check the existing GPIO 5 / GPIO 18 wiring and sensor echo.
- Website still shows simulated values: verify the device request is returning 200 and check whether another telemetry source is overwriting the shared state.

## Safety boundary

This integration only publishes sensor telemetry. It intentionally contains no motor, servo, relay, or movement-control code. Do not treat a successful telemetry upload as proof that motor control, GPS navigation, obstacle avoidance, or return-to-base is ready. Those require a separate reviewed hardware protocol and supervised tests with an independent physical emergency stop.
