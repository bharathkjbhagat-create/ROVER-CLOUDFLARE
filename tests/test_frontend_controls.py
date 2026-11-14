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
        cls.camera_webrtc = (ROOT / "public" / "camera-webrtc.js").read_text(encoding="utf-8")
        cls.worker = (ROOT / "src" / "worker.py").read_text(encoding="utf-8")
        cls.server_app = (ROOT / "src" / "app.py").read_text(encoding="utf-8")
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

    def test_cross_device_state_rejects_stale_telemetry_versions(self):
        # WebSocket pushes and the polling fallback share one monotonic version gate.
        self.assertIn('const staleVersion=incomingVersion&&currentVersion&&(', self.js)
        self.assertIn('incomingStamp<currentStamp', self.js)
        self.assertIn('if(staleVersion)return false;', self.js)
        self.assertIn('if(incomingVersion)window.ROVER_SYNC_VERSION=incomingVersion;', self.js)
        self.assertIn('const applied=updateUI(message.telemetry);', self.js)
        self.assertIn('const applied=updateUI(d);', self.js)
        self.assertIn('if(applied===false)return;', self.js)
        # A stale poll or socket message must not replace the newer snapshot.
        self.assertNotIn('if(message.telemetry.sync_version)window.ROVER_SYNC_VERSION=message.telemetry.sync_version;', self.js)
        self.assertNotIn('if(d&&d.sync_version)window.ROVER_SYNC_VERSION=d.sync_version;', self.js)

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
        self.assertIn('let facing="environment"', self.phone_camera)  # rear camera remains the default
        self.assertIn('facingMode:{ideal:facing}', self.phone_camera)
        self.assertIn('phoneCameraFlipBtn', self.phone_camera)  # front/rear selection
        self.assertIn("created.srcObject=acquired", self.phone_camera)
        self.assertIn("stopTracks(acquired)", self.phone_camera)
        self.assertIn('window.__defenxSetPhoneCameraActive?.(true)', self.phone_camera)
        self.assertIn('window.__defenxSetPhoneCameraActive?.(false)', self.phone_camera)
        self.assertIn('id="phoneCameraBtn"', self.html)
        self.assertIn('src="/phone-camera.js?v=20261107-07"', self.html)
        self.assertIn('href="/phone-camera.css?v=20261107-01"', self.html)
        self.assertIn("if(phoneCameraActive||window.__defenxRemoteCameraActive)return;", self.js)
        self.assertIn("!phoneCameraActive", self.js)

    def test_live_phone_camera_streams_to_other_authenticated_dashboards(self):
        # Local preview remains active while WebRTC sends the same MediaStream to peers.
        self.assertIn('new CustomEvent("defenx-camera-stream"', self.phone_camera)
        self.assertIn('detail:{stream:acquired,active:true}', self.phone_camera)
        self.assertIn('detail:{stream:null,active:false}', self.phone_camera)
        self.assertIn('new RTCPeerConnection(', self.camera_webrtc)
        self.assertIn('pc.addTransceiver("video", { direction: "sendrecv" })', self.camera_webrtc)
        self.assertIn('entry.transceiver.sender.replaceTrack(track)', self.camera_webrtc)
        self.assertIn('pc.ontrack = event =>', self.camera_webrtc)
        self.assertIn('type: "rtc_signal"', self.camera_webrtc)
        self.assertIn('type: "rtc_join"', self.camera_webrtc)
        self.assertIn('data-defenx-remote-camera', self.camera_webrtc)
        self.assertIn('video.dataset.defenxPeerId = safeId;', self.camera_webrtc)
        self.assertIn('function promoteRemoteVideo(video)', self.camera_webrtc)
        self.assertIn('video.id = "roverRealCamera";', self.camera_webrtc)
        self.assertIn('promoteRemoteVideo(video);', self.camera_webrtc)
        self.assertIn('function updateRemoteCameraActiveFlag()', self.camera_webrtc)
        self.assertIn('video.dataset.defenxCameraActive = active ? "1" : "0";', self.camera_webrtc)
        self.assertIn('remoteCameraStates.set(safeId, active === true);', self.camera_webrtc)
        self.assertIn('activeFromSignal || activeFromVideo', self.camera_webrtc)
        self.assertIn('video = document.createElement("video");', self.camera_webrtc)
        self.assertIn('viewport.appendChild(video);', self.camera_webrtc)
        self.assertNotIn('const canReuseEmptySource', self.camera_webrtc)
        self.assertIn('promoteRemoteVideo(video);', self.camera_webrtc)
        self.assertIn('el.dataset?.defenxRemoteCamera === "1" && el.dataset.defenxCameraActive !== "1"', self.ai)
        self.assertIn('const hasActiveRemoteVideo = remoteVideos.some(video => video.dataset.defenxCameraActive === "1");', self.camera_webrtc)
        self.assertIn('if (hasActiveRemoteVideo || hasActiveRemoteSignal) return;', self.camera_webrtc)
        self.assertIn('viewport.appendChild(fallbackCameraNode);', self.camera_webrtc)
        self.assertIn('status(remoteActive ? "REMOTE DEVICE CAMERA • LIVE" : "REMOTE DEVICE CAMERA • CONNECTING", remoteActive);', self.camera_webrtc)
        self.assertIn('stun:stun.cloudflare.com:3478', self.camera_webrtc)
        self.assertIn('/^(stun|stuns|turn|turns):/i.test(url.trim())', self.camera_webrtc)
        self.assertIn('const turnEnabled = config.turnEnabled === true;', self.camera_webrtc)
        self.assertIn('return !isRelay || (turnEnabled && hasCredentials);', self.camera_webrtc)
        self.assertIn('entry.username = server.username;', self.camera_webrtc)
        self.assertIn('entry.credential = server.credential;', self.camera_webrtc)
        self.assertIn('iceTransportPolicy: "all"', self.camera_webrtc)
        self.assertIn('iceCandidatePoolSize: 4', self.camera_webrtc)
        self.assertIn('let roomJoined = false;', self.camera_webrtc)
        self.assertIn('if (roomJoined && lastSentCameraState !== cameraActive)', self.camera_webrtc)
        self.assertIn('roomJoined = true;', self.camera_webrtc)
        self.assertIn('if (lastSentCameraState !== cameraActive)', self.camera_webrtc)
        self.assertNotIn('if (localStream) send({ type: "rtc_camera", active: true });', self.camera_webrtc)
        self.assertIn('status(remoteActive ? "LOCAL + REMOTE CAMERA LIVE" : "PHONE CAMERA LIVE");', self.camera_webrtc)
        self.assertIn('pc.connectionState === "failed"', self.camera_webrtc)
        self.assertIn('setRemoteCameraActive(id, false);', self.camera_webrtc)
        self.assertIn('if(phoneCameraActive||window.__defenxRemoteCameraActive)return;', self.js)
        self.assertIn('src="/camera-webrtc.js?v=20261114-02"', self.html)
        self.assertIn('async function loadIceServers()', self.camera_webrtc)
        self.assertIn('fetch("/api/rtc/ice-config"', self.camera_webrtc)
        self.assertIn('Camera sync heartbeat timeout', self.camera_webrtc)
        self.assertIn('url.path == "/api/rtc/ice-config"', self.worker)
        self.assertIn('RTC_TURN_KEY_ID', self.worker)
        self.assertIn('RTC_TURN_API_TOKEN', self.worker)
        self.assertIn('generate-ice-servers', self.worker)
        self.assertIn('stun:stun.cloudflare.com:3478', self.server_app)
        self.assertIn('setInterval(() => {', self.camera_webrtc)
        self.assertIn('@app.get("/api/rtc/ice-config")', self.server_app)
        self.assertIn('turnEnabled', self.server_app)

    def test_phone_gps_syncs_ephemerally_to_other_authenticated_dashboards(self):
        phone_gps = (ROOT / "public" / "phone-gps.js").read_text(encoding="utf-8")
        self.assertIn('type:"phone_gps"', phone_gps)
        self.assertIn("window.DEFENX_PHONE_GPS_SYNC", phone_gps)
        self.assertIn("window.DEFENX_PHONE_GPS_REMOTE=showRemote", phone_gps)
        self.assertIn("setTimeout(()=>removeRemote(sessionId),45000)", phone_gps)
        self.assertNotIn("fetch(", phone_gps)
        self.assertIn('if(message.type==="phone_gps")', self.js)
        self.assertIn("window.DEFENX_PHONE_GPS_SYNC?.()", self.js)
        self.assertIn("def _handle_phone_gps_message", self.worker)
        self.assertIn("def _active_phone_gps", self.worker)
        self.assertIn("self._broadcast_operator", self.worker)
        self.assertIn('kind") != "operator"', self.worker)
        self.assertIn('"type": "phone_gps"', self.worker)
        self.assertIn('"phone_gps":', self.worker)
        self.assertIn('id="cameraSyncStatus"', self.html)
        self.assertIn("DEVICE SYNC ONLINE • WAITING FOR SECOND DEVICE", self.camera_webrtc)
        self.assertIn("CAMERA LINK FAILED • CHECK NETWORK / TURN", self.camera_webrtc)

    def test_webrtc_signaling_is_authenticated_and_relayed_by_existing_durable_object(self):
        self.assertIn('if action in {"rtc_join", "rtc_camera", "rtc_signal", "phone_gps"}:', self.worker)
        self.assertIn('self._handle_rtc_message(ws, data, attachment)', self.worker)
        self.assertIn('def _rtc_broadcast(self, payload, exclude_peer=None, target_peer=None):', self.worker)
        self.assertIn('if info.get("rtc_room") != "defenx-global" or not peer_id:', self.worker)
        self.assertIn('"rtc_peer_list"', self.worker)
        self.assertIn('"rtc_peer_left"', self.worker)
        self.assertIn('Authentication expired', self.worker)

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

