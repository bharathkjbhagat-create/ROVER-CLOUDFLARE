#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// DEFENX telemetry-only example. No motor or steering commands are sent.
const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// Set this locally. Never commit a real device token to GitHub or a public
// Wokwi project. It must match the Cloudflare ROVER_DEVICE_TOKEN secret.
const char* ROVER_DEVICE_TOKEN = "PASTE_DEVICE_TOKEN_LOCALLY";

// Paste the verified root CA PEM for the exact HTTPS hostname below.
// Do not use client.setInsecure(); certificate validation must remain enabled.
static const char ROOT_CA_CERT[] PROGMEM = R"PEM(
PASTE_VERIFIED_ROOT_CA_PEM_HERE
)PEM";

const char* TELEMETRY_URL =
  "https://defenx.bindukjagadish.workers.dev/api/device/telemetry";

constexpr int TRIG_PIN = 5;
constexpr int ECHO_PIN = 18;
constexpr unsigned long ECHO_TIMEOUT_US = 30000UL;

WiFiClientSecure tlsClient;
HTTPClient http;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  const unsigned long duration =
    pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);

  if (duration == 0) {
    return -1.0f; // No valid echo; do not report a fake zero distance.
  }

  return (duration * 0.0343f) / 2.0f;
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  const unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - started < 20000UL) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected; IP: ");
    Serial.println(WiFi.localIP());
    return true;
  }

  Serial.println("Wi-Fi connection failed");
  return false;
}

void postTelemetry() {
  if (!connectWiFi()) return;

  const float distanceCm = readDistanceCm();

  // Build only fields actually measured by this example.
  String payload = "{\"network\":\"ESP32-WIFI\"";
  if (distanceCm >= 0.0f) {
    payload += ",\"obstacle_cm\":";
    payload += String(distanceCm, 1);
  }
  payload += "}";

  tlsClient.setCACert(ROOT_CA_CERT);

  if (!http.begin(tlsClient, TELEMETRY_URL)) {
    Serial.println("Could not initialize HTTPS request");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Rover-Device-Token", ROVER_DEVICE_TOKEN);

  const int status = http.POST(payload);
  Serial.print("Telemetry HTTP status: ");
  Serial.println(status);

  if (status > 0) {
    Serial.println(http.getString());
  } else {
    Serial.print("HTTPS error: ");
    Serial.println(http.errorToString(status));
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  Serial.println("DEFENX telemetry-only test");
  Serial.println("No motor commands are implemented.");
  connectWiFi();
}

void loop() {
  postTelemetry();
  delay(2000);
}
