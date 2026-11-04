"""Regression checks for DEFENX detailed maps and GPS-gated navigation."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


class MapNavigationRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = (PUBLIC / "app.js").read_text(encoding="utf-8")
        cls.roads = (PUBLIC / "road-detail-overlay.js").read_text(encoding="utf-8")
        cls.camera = (PUBLIC / "camera-target-overlay.js").read_text(encoding="utf-8")
        cls.html = (PUBLIC / "index.html").read_text(encoding="utf-8")

    def test_new_overlay_modules_have_server_routes(self):
        server = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
        self.assertIn('@app.get("/road-detail-overlay.js")', server)
        self.assertIn('@app.get("/camera-target-overlay.js")', server)
        self.assertIn('cached_static("road-detail-overlay.js", "application/javascript")', server)
        self.assertIn('cached_static("camera-target-overlay.js", "application/javascript")', server)

    def test_new_overlay_modules_load_before_dashboard(self):
        road = self.html.index('/road-detail-overlay.js')
        camera = self.html.index('/camera-target-overlay.js')
        app = self.html.index('/app.js')
        self.assertLess(road, app)
        self.assertLess(camera, app)
        self.assertIn('DEFENX_ROAD_DETAILS', self.app)
        self.assertIn('DEFENX_CAMERA_OBSTACLES', self.app)

    def test_road_overlay_includes_small_mapped_ways_and_metadata(self):
        self.assertIn('way["highway"]', self.roads)
        for road_class in (
            "residential", "living_street", "service", "track",
            "path", "footway", "cycleway", "steps",
        ):
            self.assertIn(road_class, self.roads)
        for field in ("width", "lanes", "surface", "access"):
            self.assertIn(field, self.roads)
        self.assertIn("MIN_REQUEST_INTERVAL=5*60*1000", self.roads)
        self.assertIn("CACHE_TTL=15*60*1000", self.roads)

    def test_live_rover_position_requires_recent_device_gps(self):
        self.assertIn('telemetry.gps_source!=="ROVER_DEVICE"', self.app)
        self.assertIn("telemetry.gps_last_epoch", self.app)
        self.assertIn("age<=maxAgeSeconds", self.app)
        self.assertIn("isFreshRoverGps(incoming,30,100)", self.app)

    def test_route_preview_and_return_precheck_require_precise_fresh_gps(self):
        self.assertIn("isFreshRoverGps(latestTelemetry,10,25)", self.app)
        self.assertIn("isFreshRoverGps(telemetry,10,25)", self.app)
        self.assertIn("autonomous_navigation!==true", self.app)
        self.assertIn("obstacle_sensor_healthy!==true", self.app)
        self.assertIn("safety_controller_healthy!==true", self.app)

    def test_osrm_failure_does_not_fall_back_to_direct_line(self):
        start = self.app.index("async function previewReturnRoute")
        end = self.app.index("function clearReturnRoutePreview", start)
        preview = self.app[start:end]
        self.assertIn("router.project-osrm.org", preview)
        self.assertIn("ROAD ROUTE UNAVAILABLE", preview)
        self.assertIn("return;", preview)
        self.assertIn("PREVIEW ONLY", preview)


if __name__ == "__main__":
    unittest.main()
