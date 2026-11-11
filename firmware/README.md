# Firmware

* `rover_core/nav_core.h` - portable safety supervisor + offline navigation FSM (**compiled and simulated on a PC**).
* `test/sim_test.cpp` - simulation tests: `g++ -std=c++17 -O1 -Wall -Wextra -I rover_core test/sim_test.cpp -o sim_test && ./sim_test`
* `esp32_rover/` - ESP32 Arduino sketch. `nav_core.h` there is a copy; keep it in sync with `rover_core/` (`make sync` / `cp`).
  Copy `config.example.h` -> `config.h`. **Not compiled on ESP32 here** - see docs/HARDWARE_AND_AUTONOMY.md.
