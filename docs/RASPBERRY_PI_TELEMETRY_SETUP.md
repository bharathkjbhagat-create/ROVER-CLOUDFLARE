# DEFENX Raspberry Pi Zero 2 W telemetry starter

This is the first Raspberry Pi integration stage for the DEFENX website. It sends a small authenticated heartbeat to the existing device telemetry API so the dashboard can receive the Pi's online status.

## What this starter does

- Sends an HTTPS POST to `/api/device/telemetry`.
- Authenticates with the Cloudflare `ROVER_DEVICE_TOKEN` secret using the `X-Rover-Device-Token` header.
- Sends the device ID as `source_id` and a network label.
- Retries after network or server errors.
- Uses Python's normal HTTPS certificate verification.

## What it does not do

- It does not read GPIO pins or sensor values yet.
- It does not stream camera video.
- It does not read GPS.
- It does not control motors, servos, relays, or rover movement.
- It does not configure the SIMCom A7670C modem or mobile-network APN.

Do not treat an online heartbeat as proof that sensors, camera, GPS, cellular modem, or drive hardware are working.

## Before running on the Pi

1. Configure the Cloudflare Worker secret named `ROVER_DEVICE_TOKEN`. Use a long, unique random token. Never commit it to GitHub or put it in a public screenshot.
2. Confirm the Worker is deployed with that secret and that the website's existing authenticated dashboard is available.
3. Install Raspberry Pi OS on the microSD card and connect the Pi to the internet. For the first test, ordinary Wi-Fi is simplest. The A7670C cellular connection must be separately set up using the exact carrier-board manual and the mobile operator's APN details.
4. Use a terminal on the Pi and confirm Python 3 is available:

   ```bash
   python3 --version
   ```

5. Download or clone this repository branch and open `examples/raspberry-pi/`.

## Run a stationary heartbeat test

In the same terminal session, set the token without putting it in the source file:

```bash
export ROVER_DEVICE_TOKEN='PASTE_YOUR_PRIVATE_TOKEN_HERE'
export ROVER_DEVICE_ID='ROVER-01'
export DEFENX_NETWORK_LABEL='raspberry-pi-wifi'
python3 examples/raspberry-pi/telemetry_heartbeat.py
```

Keep the rover stationary and its drive power disconnected during this first software test. The script should print that telemetry was accepted. Then sign in to the DEFENX dashboard and check whether the device status becomes online.

The endpoint returns HTTP 200 with an `ok: true` response when it accepts the heartbeat. If it does not:

- HTTP 401: check that the Cloudflare secret and local token match exactly.
- Network/timeout error: confirm the Pi has internet access and the endpoint URL is correct.
- No online indicator: confirm the Worker deployment and dashboard live-state display; a successful HTTP response should be checked separately from the dashboard.

## Next integration stages

Only after the heartbeat is confirmed:

1. Add verified sensor readings, one sensor at a time, using the Pi-safe signal interface described in the DEFENX hardware specification.
2. Add GPS fields after confirming a valid GPS fix.
3. Add camera capture and a separately tested video transport path.
4. Integrate external AI-server results after video transport is working.

The HC-SR04 Echo output is 5 V and must not be connected directly to Raspberry Pi GPIO. The purchase specification requires a voltage divider for each sensor. Verify the divider and signal levels before connecting GPIO.

Do not add motor-control software as part of this telemetry starter. Keep the rover stationary during network and sensor integration.
