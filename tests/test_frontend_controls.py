"""Regression tests for important DEFENX dashboard controls."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class _Ids(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []

    def handle_starttag(self, tag, attrs):
        value = dict(attrs).get("id")
        if value:
            self.ids.append(value)


class FrontendControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
        cls.js = (ROOT / "public" / "app.js").read_text(encoding="utf-8")

    def test_dashboard_element_ids_are_unique(self):
        parser = _Ids()
        parser.feed(self.html)
        duplicates = [key for key, count in Counter(parser.ids).items() if count > 1]
        self.assertEqual(duplicates, [], f"Duplicate HTML IDs: {duplicates}")

    def test_devices_tab_opens_registered_devices_panel(self):
        self.assertIn(
            '$("devicesTabBtn")?.addEventListener("click",async()=>{closeModal("adminModal");await openDevices()});',
            self.js,
        )

    def test_alert_button_reveals_audit_tab(self):
        self.assertIn(
            '$("alertBtn")?.addEventListener("click",async()=>{openModal("adminModal");hide("usersTab");show("auditTab");',
            self.js,
        )

    def test_recent_view_all_reveals_audit_tab_for_admin(self):
        self.assertIn(
            '$("recentViewAll")?.addEventListener("click",()=>{if(me?.role==="admin"){openModal("adminModal");hide("usersTab");show("auditTab");loadAudit()}',
            self.js,
        )

    def test_rover_commands_and_modes_wait_for_api_confirmation(self):
        self.assertIn('api("/api/command"', self.js)
        self.assertIn('api("/api/mode"', self.js)
        self.assertIn('if(!r.ok||d.ok!==true)', self.js)

    def test_settings_buttons_open_quick_settings(self):
        self.assertIn("function openQuickSettings()", self.js)
        self.assertIn('$("settingsBtn")?.addEventListener("click",openQuickSettings);', self.js)
        self.assertIn('if(a==="settings"){openQuickSettings();return}', self.js)
        self.assertIn('id="quickActionsSection"', self.html)

    def test_demo_mode_can_preview_routes_but_never_move_rover(self):
        self.assertIn("DEMO · SELECT A BASE LOCATION ON THE MAP", self.js)
        self.assertIn("DEMO ROAD ROUTE · ", self.js)
        self.assertIn("DEMO MODE · ROVER MOVEMENT DISABLED", self.js)
        self.assertIn('if(demoMode){addLog("DEMO","Rover commands are disabled in the read-only demo");return false;}', self.js)

    def test_camera_record_button_uses_real_video_recorder(self):
        self.assertIn("new MediaRecorder(stream", self.js)
        self.assertIn("video.captureStream", self.js)
        self.assertIn('$("camRecordBtn")', self.js)
        self.assertNotIn('recording=!recording;const b=$("camRecordBtn")', self.js)


if __name__ == "__main__":
    unittest.main()
