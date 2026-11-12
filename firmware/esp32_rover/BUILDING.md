# Building DEFENX ESP32 firmware

The repository includes a PlatformIO build for the ESP32 DevKit:

```powershell
Copy-Item firmware/esp32_rover/config.example.h firmware/esp32_rover/config.h
pio run -e esp32dev
```

The example configuration is only for compilation. Fill in Wi-Fi credentials, the Worker hostname, the registered device secret, and the trusted CA PEM in a local `config.h` before use. Never commit `config.h`.

Every pull request that changes the firmware runs the same compile in GitHub Actions. A successful compile does not verify wiring, sensor calibration, TLS connectivity, rover motion, or safety behavior on physical hardware.
