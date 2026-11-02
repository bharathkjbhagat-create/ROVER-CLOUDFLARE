#!/usr/bin/env python3
"""DEFENX Raspberry Pi telemetry heartbeat.

This first-stage agent sends only a device-online heartbeat and network label.
It deliberately does not read GPIO, drive motors, or issue rover commands.
The Pi's default TLS certificate validation remains enabled.
"""

import json
import os
import time
import urllib.error
import urllib.request

API_URL = os.environ.get(
    "DEFENX_API_URL",
    "https://defenx.bindukjagadish.workers.dev/api/device/telemetry",
)
DEVICE_TOKEN = os.environ.get("ROVER_DEVICE_TOKEN", "").strip()
DEVICE_ID = os.environ.get("ROVER_DEVICE_ID", "ROVER-01").strip()
NETWORK_LABEL = os.environ.get("DEFENX_NETWORK_LABEL", "raspberry-pi").strip()
INTERVAL_SECONDS = max(5, int(os.environ.get("DEFENX_INTERVAL_SECONDS", "10")))


def send_heartbeat():
    if not DEVICE_TOKEN:
        raise RuntimeError("ROVER_DEVICE_TOKEN is not set")

    # Do not invent sensor values. Sensor fields are added only after the
    # corresponding hardware has been connected and its readings verified.
    payload = {
        "source_id": DEVICE_ID,
        "network": NETWORK_LABEL,
    }
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Rover-Device-Token": DEVICE_TOKEN,
            "User-Agent": "DEFENX-RaspberryPi-Telemetry/1.0",
        },
        method="POST",
    )

    # urllib uses the operating system's trusted CA certificates and verifies
    # the HTTPS certificate by default. Do not disable certificate checking.
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", errors="replace")
        if response.status != 200:
            raise RuntimeError(f"Telemetry returned HTTP {response.status}")
        result = json.loads(body)
        if not result.get("ok"):
            raise RuntimeError("Telemetry endpoint did not confirm success")
        return result


def main():
    delay = INTERVAL_SECONDS
    print("DEFENX Pi telemetry heartbeat starting (telemetry only).")
    while True:
        try:
            result = send_heartbeat()
            print("DEFENX telemetry accepted; device heartbeat is online.")
            delay = INTERVAL_SECONDS
        except urllib.error.HTTPError as exc:
            # Avoid printing request headers or secrets.
            print(f"Telemetry HTTP error: {exc.code}")
            delay = min(max(delay * 2, INTERVAL_SECONDS), 60)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, RuntimeError) as exc:
            print(f"Telemetry not confirmed: {type(exc).__name__}")
            delay = min(max(delay * 2, INTERVAL_SECONDS), 60)
        time.sleep(delay)


if __name__ == "__main__":
    main()
