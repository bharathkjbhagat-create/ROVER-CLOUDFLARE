"""Dependency-free checks for the monitor's GPS provenance and map layers."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MonitorTrackingStaticTests(unittest.TestCase):
    def test_monitor_uses_four_real_map_layers(self):
        source = (ROOT / "public" / "monitor.js").read_text(encoding="utf-8")
        for mode in ('"satellite"', '"map"', '"terrain"', '"hybrid"'):
            self.assertIn(mode, source)
        self.assertIn("World_Boundaries_and_Places", source)
        self.assertIn("OpenTopoMap contributors", source)
        self.assertIn("L.control.scale", source)

    def test_only_verified_rover_device_samples_enter_actual_trail(self):
        source = (ROOT / "public" / "monitor.js").read_text(encoding="utf-8")
        self.assertIn('p.source !== "ROVER_DEVICE"', source)
        self.assertIn('t.gps_source === "ROVER_DEVICE"', source)
        self.assertIn("Reject implausible GPS teleports", source)
        self.assertIn("loadTrackHistory", source)

    def test_backend_tags_each_track_source(self):
        source = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertIn('add_track("ROVER_DEVICE")', source)
        self.assertIn('add_track("LIVE_GPS")', source)
        self.assertIn('add_track("SIMULATION")', source)
        self.assertIn('snapshot["track"]', source)


if __name__ == "__main__":
    unittest.main()
