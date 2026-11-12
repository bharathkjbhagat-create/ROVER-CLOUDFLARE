// Copy to config.h and fill in. NEVER commit config.h (it holds the device secret).
#pragma once
#define WIFI_SSID        "your-wifi"
#define WIFI_PASSWORD    "your-wifi-password"
#define DEFENX_HOST      "your-worker.your-subdomain.workers.dev"   // no scheme, no path
#define DEFENX_PORT      443
#define DEFENX_USE_TLS   1            // 0 only for a LAN test server
#define DEVICE_ID        "ROVER-01"
#define DEVICE_SECRET    "paste-64-hex-chars-shown-once-in-dashboard"
#define TLS_ROOT_CA      nullptr      // REQUIRED: set to your server CA PEM; nullptr makes HTTPS fail closed

// Pins (ESP32 DevKit). Motor driver: L298N / TB6612. ENA/ENB must have pull-downs so motors are OFF while the ESP32 boots/resets.
#define PIN_MOTOR_L_IN1 26
#define PIN_MOTOR_L_IN2 27
#define PIN_MOTOR_R_IN1 14
#define PIN_MOTOR_R_IN2 12
#define PIN_MOTOR_L_EN  25
#define PIN_MOTOR_R_EN  33
#define PIN_ESTOP_BTN   34            // normally-closed to GND through the latching e-stop; HIGH/open = STOP. Also cut motor power in hardware.
// HC-SR04 (use a voltage divider on ECHO: 5V -> 3.3V)
#define PIN_US_FRONT_TRIG 4
#define PIN_US_FRONT_ECHO 5
#define PIN_US_LEFT_TRIG  18
#define PIN_US_LEFT_ECHO  19
#define PIN_US_RIGHT_TRIG 23
#define PIN_US_RIGHT_ECHO 13
#define PIN_GPS_RX 16                 // ESP32 RX2  <- GPS TX (u-blox NEO-6M/M8N)
#define PIN_GPS_TX 17
#define PIN_BATT_ADC 35               // battery divider (see docs)
#define BATT_DIV_RATIO 3.2f           // (R1+R2)/R2
#define BATT_EMPTY_V 9.6f             // 3S Li-ion: 0%
#define BATT_FULL_V  12.6f            // 100%
#define COMPASS_DECLINATION_DEG 0.0f  // your local magnetic declination
#define COMPASS_MOUNT_OFFSET_DEG 0.0f // sensor rotation vs. rover front
#define OFFLINE_AUTO_RTB 0            // 1 = opt in to automatic return after link loss. Bench-test first!
