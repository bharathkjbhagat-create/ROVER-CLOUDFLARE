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
        cls.ai = (ROOT / "public" / "ai-vision.js").read_text(encoding="utf-8")
        cls.face = (ROOT / "public" / "face-recognition.js").read_text(encoding="utf-8")
        cls.phone_camera = (ROOT / "public" / "phone-camera.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "public" / "style.css").read_text(encoding="utf-8")

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

    def test_ai_controls_are_enabled_on_authenticated_root_dashboard(self):
        self.assertIn('window.location.pathname === "/demo"', self.ai)
        self.assertNotIn('window.location.pathname === "/"', self.ai)
        self.assertIn('toggle.textContent = paused ? "RESUME AI" : canRetry ? "RETRY AI" : "PAUSE AI";', self.ai)

    def test_ai_error_state_allows_retry_when_camera_is_ready(self):
        self.assertIn('state === "error" && sourceReady(source) && !paused', self.ai)
        self.assertIn('if (bar.dataset.state === "error" && !paused)', self.ai)
        self.assertIn('startDetection();', self.ai)

    def test_face_scan_rechecks_same_camera_element_after_first_frame(self):
        self.assertIn('if (node !== lastNode)', self.face)  # same element keeps its tracking state
        self.assertIn('refreshBar(); bootModels();', self.face)
        self.assertIn('WAITING FOR LIVE CAMERA', self.face)

    def test_temporary_phone_camera_uses_local_stream_and_can_stop(self):
        self.assertIn("navigator.mediaDevices?.getUserMedia", self.phone_camera)
        self.assertIn('facingMode:{ideal:"environment"}', self.phone_camera)
        self.assertIn("created.srcObject=acquired", self.phone_camera)
        self.assertIn("stopTracks(acquired)", self.phone_camera)
        self.assertIn('window.__defenxSetPhoneCameraActive?.(true)', self.phone_camera)
        self.assertIn('window.__defenxSetPhoneCameraActive?.(false)', self.phone_camera)
        self.assertIn('id="phoneCameraBtn"', self.html)
        self.assertIn('src="/phone-camera.js?v=20261107-07"', self.html)
        self.assertIn('href="/phone-camera.css?v=20261107-01"', self.html)
        self.assertIn("if(phoneCameraActive)return;", self.js)
        self.assertIn("!phoneCameraActive", self.js)

    def test_live_camera_is_visible_in_the_normal_dashboard_view(self):
        self.assertIn('#cameraViewport #roverRealCamera[data-defenxLiveStream="1"]', self.css)
        self.assertIn('frame.dataset.defenxLiveStream="1";', self.js)

    def test_face_scan_and_object_detection_do_not_compete_for_mobile_cpu(self):
        # one sequential scheduler: a task never starts while another is running, and both
        # detectors back off in proportion to how long inference took
        self.assertIn("if (!running || paused || busy) return;", self.ai)
        self.assertIn("nextObj = performance.now() + Math.max(OBJECT_DELAY, objMs * 2)", self.ai)
        self.assertIn("nextFace = performance.now() + Math.max(FACE_DELAY, ms * 1.3)", self.ai)
        self.assertIn("if (!active() || working) return lastFaces;", self.face)
        self.assertIn("stats.skippedFrames++", self.ai)  # duplicate frames are not re-processed

    def test_live_camera_is_never_covered_by_stale_overlays(self):
        mon = (ROOT / "public/monitor.js").read_text(encoding="utf-8")
        css = (ROOT / "public/monitor.css").read_text(encoding="utf-8")
        # inline display:flex on the placeholder used to defeat the [hidden] attribute
        self.assertNotIn("placeholder.style.cssText", self.js)
        self.assertIn(".camPlaceholder[hidden]{display:none!important}", css)
        # abort/emptied fire during normal load()/srcObject swaps and must not trigger reconnects
        self.assertNotIn('"abort", "emptied"', mon)
        self.assertIn('cameraViewport[data-feed="live"] .camTargetBox', css)
        self.assertIn("decodedFrame(activeEl)", mon)

    def test_person_detection_only_accepts_configured_live_camera_sources(self):
        self.assertIn('dataset.defenxLiveStream === "1"', self.ai)
        self.assertIn('dataset.defenxLiveStream === "1"', self.face)
        self.assertIn('img.dataset.defenxLiveStream="1"', self.js)
        self.assertIn('video.dataset.defenxLiveStream="1"', self.js)
        self.assertNotIn('return element.complete &&', self.ai)
        self.assertNotIn('if (node.tagName === "IMG") return node.complete', self.face)

    def test_camera_record_button_uses_real_video_recorder(self):
        self.assertIn("new MediaRecorder(stream", self.js)
        self.assertIn("video.captureStream", self.js)
        self.assertIn('$("camRecordBtn")', self.js)
        self.assertNotIn('recording=!recording;const b=$("camRecordBtn")', self.js)


if __name__ == "__main__":
    unittest.main()