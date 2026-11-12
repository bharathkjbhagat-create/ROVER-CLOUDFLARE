// DEFENX rover firmware (ESP32, Arduino core 2.x/3.x). Libraries: ArduinoJson 7, TinyGPSPlus.
// NOT compiled or run on a real ESP32 in the delivery environment: see docs/HARDWARE_AND_AUTONOMY.md "verification status".
// Navigation/safety logic lives in nav_core.h, which IS compiled and simulated on a PC (firmware/test/sim_test.cpp).
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <LittleFS.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>
#include <esp_task_wdt.h>
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include "config.h"
#include "nav_core.h"

using namespace defenx;

static Config cfgCore;
static Controller rover(cfgCore);
static TinyGPSPlus gpsParser;
static HardwareSerial gpsSerial(2);

// ---------------------------------------------------------------- hardware -
static Range rFront, rLeft, rRight, rRear;
static Gps gpsIn; static Heading hdgIn; static Battery battIn;
static uint32_t lastGpsFixMs = 0;
static bool sensorBusOk = true;

static float readUltrasonicCm(int trig, int echo, bool &ok) {
  digitalWrite(trig, LOW); delayMicroseconds(3);
  digitalWrite(trig, HIGH); delayMicroseconds(10); digitalWrite(trig, LOW);
  unsigned long us = pulseIn(echo, HIGH, 25000);           // 25 ms timeout (~4.3 m)
  if (us == 0) { ok = false; return 0; }                    // timeout => INVALID, never "0 cm" or "far"
  float cm = us / 58.0f; ok = (cm >= 2.0f && cm <= 400.0f); return cm;
}
static void sampleRange(Range &r, int trig, int echo) {
  bool ok; float a = readUltrasonicCm(trig, echo, ok); bool ok2; float b = readUltrasonicCm(trig, echo, ok2);
  r.valid = ok && ok2 && fabsf(a - b) < 40.0f; r.cm = fminf(a, b); r.t_ms = millis();   // two agreeing samples, closer one wins
}
static void setMotor(int in1, int in2, int en, int pwm) {
  if (pwm == 0) { digitalWrite(in1, LOW); digitalWrite(in2, LOW); analogWrite(en, 0); return; }
  digitalWrite(in1, pwm > 0); digitalWrite(in2, pwm < 0); analogWrite(en, abs(pwm));
}
static void driveMotors(int l, int r) {
  setMotor(PIN_MOTOR_L_IN1, PIN_MOTOR_L_IN2, PIN_MOTOR_L_EN, l);
  setMotor(PIN_MOTOR_R_IN1, PIN_MOTOR_R_IN2, PIN_MOTOR_R_EN, r);
}
static float readBatteryPct(bool &ok) {
  uint32_t mv = 0; for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(PIN_BATT_ADC);
  float v = (mv / 8.0f) / 1000.0f * BATT_DIV_RATIO;
  ok = v > 3.0f;                                            // unplugged/floating divider => invalid
  float p = (v - BATT_EMPTY_V) / (BATT_FULL_V - BATT_EMPTY_V) * 100.0f;
  return p < 0 ? 0 : (p > 100 ? 100 : p);
}
// QMC5883L minimal driver (I2C 0x0D). Needs calibration + level mounting; invalid on any bus error.
static bool readCompass(float &deg) {
  Wire.beginTransmission(0x0D); Wire.write(0x00);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(0x0D, 6) != 6) return false;
  int16_t x = Wire.read() | (Wire.read() << 8), y = Wire.read() | (Wire.read() << 8); Wire.read(); Wire.read();
  if (x == 0 && y == 0) return false;
  float h = atan2f((float)y, (float)x) * 180.0f / PI + COMPASS_DECLINATION_DEG + COMPASS_MOUNT_OFFSET_DEG;
  while (h < 0) h += 360; while (h >= 360) h -= 360; deg = h; return true;
}

// ----------------------------------------------------------- event journal -
// Append-only JSONL in LittleFS so offline history survives reboot. An event is removed ONLY after the
// server confirms it is stored (stored_ids), so a lost reply just causes an idempotent re-send.
static String bootId; static uint32_t evCounter = 0;
static const char *JOURNAL = "/events.jsonl";
static int pendingEvents = 0;
static void journal(const char *type, const char *msg, const char *sev, bool offline, const String &dataJson = "") {
  evCounter++;
  char id[40]; snprintf(id, sizeof id, "%s-%06lu", bootId.c_str(), (unsigned long)evCounter);
  JsonDocument d; d["id"] = id; d["type"] = type; d["message"] = msg; d["severity"] = sev;
  d["t"] = (double)time(nullptr); d["offline"] = offline;
  if (dataJson.length()) { JsonDocument inner; if (!deserializeJson(inner, dataJson)) d["data"] = inner; }
  File f = LittleFS.open(JOURNAL, FILE_APPEND); if (!f) return;
  if (f.size() > 120000) { f.close(); LittleFS.remove(JOURNAL); f = LittleFS.open(JOURNAL, FILE_WRITE); } // bounded: drop oldest history
  serializeJson(d, f); f.print('\n'); f.close(); pendingEvents++;
}

// ------------------------------------------------------------------ crypto -
static String hexOf(const uint8_t *b, size_t n) { String s; for (size_t i = 0; i < n; i++) { char t[3]; snprintf(t, 3, "%02x", b[i]); s += t; } return s; }
static String sha256Hex(const String &data) {
  uint8_t out[32]; mbedtls_sha256((const unsigned char *)data.c_str(), data.length(), out, 0); return hexOf(out, 32);
}
static String hmacHex(const String &key, const String &msg) {
  uint8_t out[32]; mbedtls_md_context_t c; mbedtls_md_init(&c);
  mbedtls_md_setup(&c, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&c, (const unsigned char *)key.c_str(), key.length());
  mbedtls_md_hmac_update(&c, (const unsigned char *)msg.c_str(), msg.length());
  mbedtls_md_hmac_finish(&c, out); mbedtls_md_free(&c); return hexOf(out, 32);
}
static bool constTimeEq(const String &a, const String &b) { if (a.length() != b.length()) return false; uint8_t d = 0; for (size_t i = 0; i < a.length(); i++) d |= a[i] ^ b[i]; return d == 0; }
static String randomNonce() { uint8_t b[12]; esp_fill_random(b, sizeof b); return hexOf(b, sizeof b); }

// Signed POST. Returns HTTP status (or -1) and verifies the server's response signature.
static int signedPost(const char *path, const String &body, String &resp) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  time_t now = time(nullptr); if (now < 1700000000) return -2;            // clock not synced yet
  char ts[24]; snprintf(ts, sizeof ts, "%ld.000", (long)now);
  String nonce = randomNonce();
  String canonical = String("POST\n") + path + "\n" + DEVICE_ID + "\n" + ts + "\n" + nonce + "\n" + sha256Hex(body);
  String sig = hmacHex(DEVICE_SECRET, canonical);
  WiFiClientSecure tls; WiFiClient plain; HTTPClient http; http.setTimeout(4000);
#if DEFENX_USE_TLS
  if (!TLS_ROOT_CA || TLS_ROOT_CA[0] == '\0') {
    Serial.println("TLS_ROOT_CA is required; refusing insecure HTTPS");
    return -4;
  }
  tls.setCACert(TLS_ROOT_CA);
  if (!http.begin(tls, DEFENX_HOST, DEFENX_PORT, path, true)) return -1;
#else
  if (!http.begin(plain, DEFENX_HOST, DEFENX_PORT, path)) return -1;
#endif
  http.addHeader("Content-Type", "application/json"); http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Timestamp", ts); http.addHeader("X-Nonce", nonce); http.addHeader("X-Signature", sig);
  const char *keys[] = {"X-Server-Signature"}; http.collectHeaders(keys, 1);
  int code = http.POST(body);
  if (code <= 0) { http.end(); return -1; }
  resp = http.getString(); String got = http.header("X-Server-Signature"); http.end();
  String expect = hmacHex(DEVICE_SECRET, String("RESP\n") + DEVICE_ID + "\n" + nonce + "\n" + sha256Hex(resp));
  if (code == 401) return 401;
  if (!constTimeEq(expect, got)) return -3;                               // unsigned/forged reply => ignore everything in it
  return code;
}


// ------------------------------------------------------------------ links ---
static bool serverOk = false; static uint32_t lastServerOkMs = 0, lastInternetProbe = 0; static bool internetOk = true;

static WebSocketsClient deviceSocket;
static bool deviceSocketConnected = false, wsResponseReady = false;
static String wsPendingNonce, wsResponseBody;
static int wsResponseStatus = 0;
static uint32_t wsPendingAt = 0, wsReconnectAt = 0, wsRetryMs = 2000;

static bool sendWsRequest(const char *path, const String &body) {
  if (!deviceSocketConnected || wsPendingNonce.length() || WiFi.status() != WL_CONNECTED) return false;
  time_t now = time(nullptr); if (now < 1700000000) return false;
  char ts[24]; snprintf(ts, sizeof ts, "%ld.000", (long)now);
  String nonce = randomNonce();
  String canonical = String("POST\n") + path + "\n" + DEVICE_ID + "\n" + ts + "\n" + nonce + "\n" + sha256Hex(body);
  JsonDocument frame;
  frame["type"] = "device_request"; frame["path"] = path; frame["timestamp"] = ts;
  frame["nonce"] = nonce; frame["signature"] = hmacHex(DEVICE_SECRET, canonical); frame["body"] = body;
  String message; serializeJson(frame, message);
  if (!deviceSocket.sendTXT(message)) return false;
  wsPendingNonce = nonce; wsPendingAt = millis();
  return true;
}

static void onDeviceSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) {
    deviceSocketConnected = true; wsRetryMs = 2000; serverOk = true; lastServerOkMs = millis();
    return;
  }
  if (type == WStype_DISCONNECTED) {
    deviceSocketConnected = false; wsReconnectAt = millis() + wsRetryMs;
    wsRetryMs = wsRetryMs < 15000 ? wsRetryMs * 2 : 30000;
    wsPendingNonce = ""; wsResponseReady = false;
    return;
  }
  if (type != WStype_TEXT || !payload || !length || length > 32768) return;
  JsonDocument frame; if (deserializeJson(frame, payload, length)) return;
  if (String(frame["type"] | "") != "device_response") return;
  String nonce = frame["nonce"] | "";
  if (!wsPendingNonce.length() || nonce != wsPendingNonce) return;
  String body = frame["body"] | "";
  String got = frame["signature"] | "";
  String expected = hmacHex(DEVICE_SECRET, String("RESP\n") + DEVICE_ID + "\n" + nonce + "\n" + sha256Hex(body));
  if (!constTimeEq(expected, got)) { wsPendingNonce = ""; serverOk = false; return; }
  wsResponseStatus = frame["status"] | 0; wsResponseBody = body;
  wsResponseReady = true; wsPendingNonce = "";
}

static void connectDeviceSocket() {
#if DEFENX_USE_TLS
  if (deviceSocketConnected || WiFi.status() != WL_CONNECTED || millis() < wsReconnectAt) return;
  if (!TLS_ROOT_CA || TLS_ROOT_CA[0] == '\0') return;
  String resp;
  if (signedPost("/api/fleet/ws-ticket", "{}", resp) != 200) {
    wsReconnectAt = millis() + wsRetryMs; wsRetryMs = min<uint32_t>(30000, wsRetryMs * 2); return;
  }
  JsonDocument ticketBody;
  if (deserializeJson(ticketBody, resp) || !ticketBody["ticket"].is<const char *>()) {
    wsReconnectAt = millis() + wsRetryMs; return;
  }
  String url = String("/api/ws?device_ticket=") + String(ticketBody["ticket"].as<const char *>());
  deviceSocket.onEvent(onDeviceSocketEvent);
  deviceSocket.setReconnectInterval(30000);
  deviceSocket.enableHeartbeat(25000, 5000, 2);
  deviceSocket.beginSslWithCA(DEFENX_HOST, DEFENX_PORT, url.c_str(), TLS_ROOT_CA);
  wsReconnectAt = millis() + 30000;
#endif
}
static uint32_t hbSeq = 0; static String lastCmdIds[8]; static int lastCmdIdx = 0;
static LinkState currentLink() {
  bool wifi = WiFi.status() == WL_CONNECTED;
  if (!wifi) return LINK_WIFI_DOWN;
  if (!serverOk && millis() - lastInternetProbe > 4000) {              // distinguish server failure from internet failure
    lastInternetProbe = millis(); WiFiClient c; internetOk = c.connect("1.1.1.1", 53, 1500); c.stop();
  }
  return classifyLink(wifi, serverOk ? true : internetOk, serverOk);
}
static bool seenCmd(const String &id) { for (auto &s : lastCmdIds) if (s == id) return true; lastCmdIds[lastCmdIdx++ & 7] = id; return false; }

static CmdType cmdFromName(const char *n) {
  struct M { const char *n; CmdType t; } m[] = {{"FORWARD", CMD_FORWARD}, {"REVERSE", CMD_REVERSE}, {"LEFT", CMD_LEFT}, {"RIGHT", CMD_RIGHT}, {"STOP", CMD_STOP},
    {"EMERGENCY_STOP", CMD_ESTOP}, {"RESET_ESTOP", CMD_RESET_ESTOP}, {"RETURN_TO_BASE", CMD_RTB}, {"CANCEL_RETURN", CMD_CANCEL_RTB}};
  for (auto &e : m) if (!strcmp(e.n, n)) return e.t; return CMD_NONE;
}

static void processHeartbeatResponse(const String &resp) {
  JsonDocument in; if (deserializeJson(in, resp)) return;
  if (!in["base"].isNull() && !rover.hasBase()) rover.setBase(in["base"]["lat"], in["base"]["lon"]);
  for (JsonObject c2 : in["commands"].as<JsonArray>()) {
    String id = c2["id"].as<String>(); const char *name = c2["command"];
    bool dup = seenCmd(id);
    Command cm; cm.type = cmdFromName(name); cm.ttl_ms = c2["ttl_ms"] | 1500;
    if (!dup && cm.type != CMD_NONE) {
      if (cm.type == CMD_RTB && !c2["base"].isNull()) { cm.has_base = true; cm.base_lat = c2["base"]["lat"]; cm.base_lon = c2["base"]["lon"]; }
      rover.onCommand(cm, millis());
    }
    JsonDocument a; a["id"] = id; a["status"] = dup ? "ignored" : (cm.type == CMD_NONE ? "rejected" : "executed"); a["detail"] = dup ? "duplicate" : "";
    String ab, ar; serializeJson(a, ab); signedPost("/api/fleet/commands/ack", ab, ar);
  }
}

static void sendHeartbeat(Fsm fsm) {
  JsonDocument d;
  d["seq"] = ++hbSeq; d["boot_id"] = bootId; d["fw"] = "defenx-esp32-1"; d["fsm"] = fsmName(fsm); d["fsm_reason"] = reasonName(rover.reason());
  d["estop"] = rover.estop(); d["offline_autonomy"] = rover.offline(); d["motors_enabled"] = !rover.estop(); d["uptime_s"] = millis() / 1000;
  d["link"] = rover.linkClass() == LINK_ONLINE ? "ONLINE" : (rover.linkClass() == LINK_WIFI_DOWN ? "WIFI_DOWN" : (rover.linkClass() == LINK_INTERNET_DOWN ? "INTERNET_DOWN" : "SERVER_DOWN"));
  d["network"] = "wifi"; d["signal"] = constrain(2 * (WiFi.RSSI() + 100), 0, 100); d["pending_events"] = pendingEvents; d["camera"] = false;
  if (battIn.valid) d["battery"] = battIn.pct;
  if (gpsIn.fix) { d["lat"] = gpsIn.lat; d["lon"] = gpsIn.lon; d["gps_fix"] = true; d["accuracy_m"] = gpsIn.acc_m; d["gps_sats"] = gpsIn.sats; d["gps_age_ms"] = millis() - gpsIn.t_ms; d["speed_kmh"] = gpsParser.speed.kmph(); }
  else d["gps_fix"] = false;
  if (hdgIn.valid) d["heading"] = hdgIn.deg;
  JsonObject o = d["obstacle"].to<JsonObject>();
  auto put = [&](const char *k, const Range &r) { JsonObject x = o[k].to<JsonObject>(); x["cm"] = r.cm; x["valid"] = r.valid; x["age_ms"] = millis() - r.t_ms; };
  put("front", rFront); put("left", rLeft); put("right", rRight);
  JsonObject c = d["caps"].to<JsonObject>();
  c["obstacle_sensor_healthy"] = rover.sensorHealthy(); c["safety_controller_healthy"] = sensorBusOk; c["gps_module"] = gpsParser.charsProcessed() > 10;
  c["autonomous_navigation"] = hdgIn.valid && rover.hasBase(); c["obstacle_avoidance"] = rLeft.valid && rRight.valid && rFront.valid; c["motors"] = true;
  JsonObject r = d["rtb"].to<JsonObject>(); r["state"] = fsmName(fsm); r["distance_m"] = rover.rtbDistanceM(); r["arrived"] = rover.arrived(); r["reason"] = reasonName(rover.reason());
  String body, resp; serializeJson(d, body);
  if (deviceSocketConnected) {
    sendWsRequest("/api/fleet/heartbeat", body);
    return;
  }
  int code = signedPost("/api/fleet/heartbeat", body, resp);
  if (code != 200) { serverOk = false; return; }
  serverOk = true; lastServerOkMs = millis();
  processHeartbeatResponse(resp);
}

// Upload queued events (<=20) and drop only those the server confirms.
static void syncJournal() {
  if (!serverOk || pendingEvents <= 0) return;
  File f = LittleFS.open(JOURNAL, FILE_READ); if (!f) return;
  JsonDocument batch; JsonArray arr = batch["events"].to<JsonArray>(); int n = 0;
  while (f.available() && n < 20) { String line = f.readStringUntil('\n'); JsonDocument e; if (!deserializeJson(e, line)) { arr.add(e); n++; } }
  f.close(); if (!n) { pendingEvents = 0; return; }
  String body, resp; serializeJson(batch, body);
  if (signedPost("/api/fleet/events/upload", body, resp) != 200) return;
  JsonDocument r; if (deserializeJson(r, resp)) return;
  JsonArray stored = r["stored_ids"].as<JsonArray>();
  File in = LittleFS.open(JOURNAL, FILE_READ), out = LittleFS.open("/events.tmp", FILE_WRITE); int left = 0;
  while (in.available()) { String line = in.readStringUntil('\n'); if (line.length() < 3) continue; JsonDocument e; if (deserializeJson(e, line)) continue;
    bool confirmed = false; for (JsonVariant s : stored) if (e["id"] == s) { confirmed = true; break; }
    if (!confirmed) { out.print(line); out.print('\n'); left++; } }
  in.close(); out.close(); LittleFS.remove(JOURNAL); LittleFS.rename("/events.tmp", JOURNAL); pendingEvents = left;
}
static void drainCoreEvents(bool offline) {
  Event e;
  while (rover.popEvent(e)) {
    const char *t = "state"; const char *sev = "info";
    switch (e.type) { case EV_OBSTACLE_STOP: t = "obstacle_stop"; sev = "warn"; break; case EV_ESTOP: t = "emergency_stop"; sev = "critical"; break;
      case EV_LINK_LOST: t = "link_lost"; sev = "warn"; break; case EV_LINK_RESTORED: t = "link_restored"; break; case EV_GPS_LOST: t = "gps_lost"; sev = "warn"; break;
      case EV_SENSOR_FAULT: t = "sensor_fault"; sev = "critical"; break; case EV_LOW_BATT: t = "low_battery"; sev = "warn"; break; case EV_RTB_STARTED: t = "rtb_started"; break;
      case EV_RTB_ARRIVED: t = "rtb_arrived"; break; case EV_RTB_FAILED: t = "rtb_failed"; sev = "critical"; break; case EV_DETOUR: t = "detour"; break;
      case EV_CMD_REJECTED: t = "cmd_rejected"; sev = "warn"; break; case EV_MANUAL_STOP: t = "manual_stop"; break; case EV_RESUME: t = "rtb_resume"; break; default: break; }
    char data[96]; snprintf(data, sizeof data, "{\"reason\":\"%s\",\"x\":%.1f,\"y\":%.1f}", reasonName(e.reason), e.x, e.y);
    journal(t, reasonName(e.reason), sev, offline || rover.offline(), String(data));
  }
}
// GPS track while offline: 1 point / 5 s, batched into one gps_track event per 30 points.
static String trackBuf; static int trackN = 0; static uint32_t lastTrackMs = 0;
static void trackPoint() {
  if (!gpsIn.fix || millis() - lastTrackMs < 5000) return; lastTrackMs = millis();
  char p[80]; snprintf(p, sizeof p, "%s{\"t\":%ld,\"lat\":%.6f,\"lon\":%.6f,\"acc\":%.1f}", trackN ? "," : "", (long)time(nullptr), gpsIn.lat, gpsIn.lon, gpsIn.acc_m);
  trackBuf += p;
  if (++trackN >= 30) { journal("gps_track", "GPS history", "info", rover.offline(), String("{\"points\":[") + trackBuf + "]}"); trackBuf = ""; trackN = 0; }
}

// -------------------------------------------------------------------- setup -
void setup() {
  // Motors OFF first, before anything else can fail.
  pinMode(PIN_MOTOR_L_IN1, OUTPUT); pinMode(PIN_MOTOR_L_IN2, OUTPUT); pinMode(PIN_MOTOR_R_IN1, OUTPUT); pinMode(PIN_MOTOR_R_IN2, OUTPUT);
  pinMode(PIN_MOTOR_L_EN, OUTPUT); pinMode(PIN_MOTOR_R_EN, OUTPUT); driveMotors(0, 0);
  pinMode(PIN_ESTOP_BTN, INPUT);
  int pins[][2] = {{PIN_US_FRONT_TRIG, PIN_US_FRONT_ECHO}, {PIN_US_LEFT_TRIG, PIN_US_LEFT_ECHO}, {PIN_US_RIGHT_TRIG, PIN_US_RIGHT_ECHO}};
  for (auto &p : pins) { pinMode(p[0], OUTPUT); pinMode(p[1], INPUT); }
  Serial.begin(115200); gpsSerial.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX); Wire.begin();
  LittleFS.begin(true);
  uint8_t b[4]; esp_fill_random(b, 4); bootId = hexOf(b, 4);
  esp_task_wdt_deinit(); esp_task_wdt_config_t wc = {.timeout_ms = 3000, .idle_core_mask = 0, .trigger_panic = true}; esp_task_wdt_init(&wc); esp_task_wdt_add(NULL);  // hardware watchdog: reset => motors off
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  cfgCore.offline_auto_rtb = OFFLINE_AUTO_RTB;
  Preferences_loadBase();
  File f = LittleFS.open(JOURNAL, FILE_READ); if (f) { while (f.available()) { if (f.readStringUntil('\n').length() > 2) pendingEvents++; } f.close(); }
  journal("boot", "Firmware started", "info", false);
}
#include <Preferences.h>
static Preferences prefs;
void Preferences_loadBase() { prefs.begin("defenx", false); if (prefs.getBool("hasbase", false)) rover.setBase(prefs.getDouble("blat", 0), prefs.getDouble("blon", 0)); }
static void Preferences_saveBase() { prefs.putDouble("blat", rover.baseLat()); prefs.putDouble("blon", rover.baseLon()); prefs.putBool("hasbase", true); }

// --------------------------------------------------------------------- loop -
static uint32_t lastHb = 0, lastSample = 0, lastSync = 0; static bool prevHadBase = false;
void loop() {
  esp_task_wdt_reset();
  deviceSocket.loop();
  if (wsResponseReady) {
    wsResponseReady = false;
    if (wsResponseStatus == 200) {
      serverOk = true; lastServerOkMs = millis();
      const String response = wsResponseBody; wsResponseBody = "";
      processHeartbeatResponse(response);
    } else {
      serverOk = false; wsResponseBody = "";
    }
  }
  if (wsPendingNonce.length() && (uint32_t)(millis() - wsPendingAt) > 8000) { wsPendingNonce = ""; serverOk = false; }
  connectDeviceSocket();
  while (gpsSerial.available()) gpsParser.encode(gpsSerial.read());
  uint32_t now = millis();
  if (now - lastSample >= 100) {                                         // 10 Hz control + sensing
    lastSample = now;
    sampleRange(rFront, PIN_US_FRONT_TRIG, PIN_US_FRONT_ECHO); sampleRange(rLeft, PIN_US_LEFT_TRIG, PIN_US_LEFT_ECHO); sampleRange(rRight, PIN_US_RIGHT_TRIG, PIN_US_RIGHT_ECHO);
    rRear.valid = false;                                                 // no rear sensor fitted: reverse will be refused
    bool locValid = gpsParser.location.isValid() && gpsParser.location.age() < 2000 && gpsParser.hdop.isValid();
    gpsIn.fix = locValid; if (locValid) { gpsIn.lat = gpsParser.location.lat(); gpsIn.lon = gpsParser.location.lng(); gpsIn.t_ms = now - gpsParser.location.age(); }
    gpsIn.sats = gpsParser.satellites.isValid() ? gpsParser.satellites.value() : 0; gpsIn.acc_m = gpsParser.hdop.isValid() ? gpsParser.hdop.hdop() * 2.5f : 999;  // HDOP*2.5 m is an ESTIMATE
    float deg; hdgIn.valid = readCompass(deg); if (hdgIn.valid) { hdgIn.deg = deg; hdgIn.t_ms = now; }
    bool bok; float bp = readBatteryPct(bok); battIn.valid = bok; battIn.pct = bp;
    sensorBusOk = true;
    Inputs in; in.now_ms = now; in.front = rFront; in.left = rLeft; in.right = rRight; in.rear = rRear; in.gps = gpsIn; in.hdg = hdgIn; in.batt = battIn;
    in.link = currentLink(); in.hw_ok = sensorBusOk; in.estop_button = digitalRead(PIN_ESTOP_BTN) == HIGH;
    Motors m = rover.tick(in);
    driveMotors(m.left, m.right);                                        // the ONLY place motors are driven
    drainCoreEvents(false); if (rover.offline()) trackPoint();
    if (rover.hasBase() && !prevHadBase) { Preferences_saveBase(); prevHadBase = true; }
  }
  if (now - lastHb >= 1000) {                                            // 1 Hz authenticated heartbeat over WebSocket; HTTPS fallback
    lastHb = now; sendHeartbeat(rover.fsm());
  }
  if (now - lastSync >= 3000) { lastSync = now; syncJournal(); }
}
