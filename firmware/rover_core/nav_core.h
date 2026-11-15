// DEFENX rover safety supervisor + offline navigation core.
//
// Header-only, no Arduino/ESP32 dependencies, no dynamic allocation, so the SAME
// code runs on the ESP32 (firmware/esp32_rover) and on a PC in the simulation
// test (firmware/test/sim_test.cpp).
//
// Design rules (see docs/HARDWARE_AND_AUTONOMY.md):
//  * Finite-state machine, never a free-running command loop.
//  * Emergency stop has absolute priority and is latched.
//  * Every motor output passes through enforce(), an independent last-stage
//    limiter that does not trust the FSM.
//  * Motion is only ever produced from FRESH, VALID sensor data.  Missing,
//    stale or implausible data => motors stop (fail-safe), never "keep going".
//  * Nothing here depends on cloud connectivity.  Link loss is an input that can
//    only make the rover MORE conservative for manual driving, and enables the
//    local return-to-base logic.
#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>

namespace defenx {

// ----------------------------------------------------------------- config ---
struct Config {
  // obstacle thresholds (cm)
  float stop_cm = 30.0f;          // forward motion forbidden at/below this
  float slow_cm = 80.0f;          // speed reduced below this
  float side_clear_cm = 50.0f;    // side must be at least this clear to detour
  float side_stop_cm = 20.0f;     // forward motion forbidden if a fresh side sensor reads this close
  float side_slow_cm = 45.0f;     // steer away from a wall closer than this
  uint32_t sensor_max_age_ms = 500;
  // GPS plausibility
  uint32_t gps_max_age_ms = 3000;
  float gps_max_accuracy_m = 15.0f;
  int gps_min_sats = 4;
  float gps_max_jump_mps = 6.0f;      // faster implied motion = GPS glitch
  uint32_t gps_untrusted_ms = 4000;   // after a glitch
  uint32_t heading_max_age_ms = 1500;
  // battery (%)
  float battery_low_pct = 20.0f;
  float battery_crit_pct = 12.0f;
  float battery_rtb_min_pct = 25.0f;
  // links / watchdogs
  uint32_t manual_link_timeout_ms = 1500;
  uint32_t link_loss_declare_ms = 5000;
  uint32_t offline_max_autonomy_ms = 15UL * 60UL * 1000UL;
  bool offline_auto_rtb = false;                 // opt-in: bench-test first
  uint32_t offline_auto_rtb_delay_ms = 30000;
  // motion (PWM units 0..255; deliberately slow)
  int pwm_manual = 140, pwm_auto = 110, pwm_turn = 100;
  float turn_threshold_deg = 25.0f, heading_tol_deg = 12.0f;
  uint32_t turn_timeout_ms = 10000;
  float steer_gain = 1.2f;
  // navigation
  float arrive_radius_m = 2.5f;
  int arrive_confirm_samples = 5;
  uint32_t arrive_sample_gap_ms = 400;
  float detour_m = 3.0f;
  int max_detours = 4;
  uint32_t progress_timeout_ms = 25000;
  uint32_t settle_ms = 600;
  uint32_t resume_window_ms = 10000;
  int max_resumes = 2;
};

// ----------------------------------------------------------------- inputs ---
struct Range { float cm = 0; bool valid = false; uint32_t t_ms = 0; };
struct Gps { bool fix = false; double lat = 0, lon = 0; float acc_m = 999; int sats = 0; uint32_t t_ms = 0; };
struct Heading { bool valid = false; float deg = 0; uint32_t t_ms = 0; };
struct Battery { bool valid = false; float pct = 0; };
enum LinkState : uint8_t { LINK_ONLINE = 0, LINK_WIFI_DOWN, LINK_INTERNET_DOWN, LINK_SERVER_DOWN };
enum CmdType : uint8_t { CMD_NONE = 0, CMD_FORWARD, CMD_REVERSE, CMD_LEFT, CMD_RIGHT, CMD_STOP, CMD_ESTOP,
                         CMD_RESET_ESTOP, CMD_RTB, CMD_CANCEL_RTB };
struct Command {
  CmdType type = CMD_NONE;
  uint32_t ttl_ms = 0;
  bool has_base = false;
  double base_lat = 0, base_lon = 0;
};
struct Inputs {
  uint32_t now_ms = 0;
  Range front, left, right, rear;
  Gps gps;
  Heading hdg;
  Battery batt;
  LinkState link = LINK_ONLINE;
  bool hw_ok = true;            // motor driver / sensor bus self-check
  bool estop_button = false;    // physical latching e-stop (also cuts motor power in hardware)
  float odom_m = -1;            // cumulative distance from wheel encoders, <0 = unavailable
};

// ----------------------------------------------------------------- states ---
enum Fsm : uint8_t {
  FSM_BOOT = 0, FSM_IDLE, FSM_MANUAL, FSM_RTB_PRECHECK, FSM_RTB_NAVIGATE, FSM_RTB_AVOID, FSM_RTB_VERIFY_DOCK,
  FSM_RTB_ARRIVED, FSM_PAUSED_OBSTACLE, FSM_PAUSED_LOCALIZATION, FSM_PAUSED_SENSOR_FAULT, FSM_PAUSED_LOW_BATTERY,
  FSM_ESTOP, FSM_FAILED
};
enum Reason : uint8_t {
  R_NONE = 0, R_SUCCESS, R_NO_BASE, R_NO_GPS, R_NO_HEADING, R_SENSOR_FAULT, R_BATTERY_LOW, R_ESTOP_LATCHED, R_OBSTACLE,
  R_NO_SAFE_ROUTE, R_NO_PROGRESS, R_TURN_TIMEOUT, R_AUTONOMY_TIMEOUT, R_MANUAL_LINK_LOSS, R_CMD_EXPIRED,
  R_USER_STOP, R_HW_FAULT, R_GPS_GLITCH, R_REJECTED, R_OFFLINE_AUTO, R_BUTTON_HELD
};
enum EventType : uint8_t {
  EV_STATE = 1, EV_OBSTACLE_STOP, EV_ESTOP, EV_LINK_LOST, EV_LINK_RESTORED, EV_GPS_LOST, EV_SENSOR_FAULT, EV_LOW_BATT,
  EV_RTB_STARTED, EV_RTB_ARRIVED, EV_RTB_FAILED, EV_CMD_REJECTED, EV_MANUAL_STOP, EV_DETOUR, EV_RESUME
};
struct Event { uint32_t t_ms; EventType type; uint8_t a, b; Reason reason; float x, y; };
struct Motors { int left = 0, right = 0; };

inline const char* fsmName(Fsm s) {
  static const char* n[] = {"BOOT", "IDLE", "MANUAL", "RTB_PRECHECK", "RTB_NAVIGATE", "RTB_AVOID", "RTB_VERIFY_DOCK",
                            "RTB_ARRIVED", "PAUSED_OBSTACLE", "PAUSED_LOCALIZATION", "PAUSED_SENSOR_FAULT",
                            "PAUSED_LOW_BATTERY", "ESTOP", "FAILED"};
  return n[s];
}
inline const char* reasonName(Reason r) {
  static const char* n[] = {"NONE", "OK", "NO_BASE", "NO_GPS", "NO_HEADING", "SENSOR_FAULT", "BATTERY_LOW",
                            "ESTOP_LATCHED", "OBSTACLE", "NO_SAFE_ROUTE", "NO_PROGRESS", "TURN_TIMEOUT",
                            "AUTONOMY_TIMEOUT", "MANUAL_LINK_LOSS", "CMD_EXPIRED", "USER_STOP", "HW_FAULT",
                            "GPS_GLITCH", "REJECTED", "OFFLINE_AUTO", "BUTTON_HELD"};
  return n[r];
}

// ------------------------------------------------------------------ math ----
constexpr double kPi = 3.14159265358979323846;
inline double toRad(double d) { return d * kPi / 180.0; }
inline double toDeg(double r) { return r * 180.0 / kPi; }
inline double distanceM(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371000.0, p1 = toRad(lat1), p2 = toRad(lat2), dp = p2 - p1, dl = toRad(lon2 - lon1);
  const double a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2);
  return 2 * R * asin(fmin(1.0, sqrt(a)));
}
inline double bearingDeg(double lat1, double lon1, double lat2, double lon2) {
  const double p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lon2 - lon1);
  const double y = sin(dl) * cos(p2), x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl);
  double b = toDeg(atan2(y, x));
  return b < 0 ? b + 360.0 : b;
}
inline float wrap180(float d) {
  while (d > 180.0f) d -= 360.0f;
  while (d < -180.0f) d += 360.0f;
  return d;
}

// ------------------------------------------------------- link classification -
// Distinguishes a local network failure from an internet or DEFENX-server failure.
inline LinkState classifyLink(bool wifi_up, bool internet_ok, bool server_ok) {
  if (!wifi_up) return LINK_WIFI_DOWN;
  if (!internet_ok) return LINK_INTERNET_DOWN;
  if (!server_ok) return LINK_SERVER_DOWN;
  return LINK_ONLINE;
}

// -------------------------------------------------------------- controller ---
class Controller {
 public:
  explicit Controller(const Config& c = Config()) : cfg_(c) {}

  // ---- configuration / base
  void setBase(double lat, double lon) {
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) || (lat == 0 && lon == 0)) return;
    base_lat_ = lat; base_lon_ = lon; has_base_ = true;
  }
  bool hasBase() const { return has_base_; }
  double baseLat() const { return base_lat_; }
  double baseLon() const { return base_lon_; }

  // ---- command intake.  Never moves motors itself; tick() decides.
  void onCommand(const Command& c, uint32_t now) {
    switch (c.type) {
      case CMD_ESTOP: latchEstop(now, R_ESTOP_LATCHED); break;
      case CMD_STOP:
        manual_ = CMD_NONE;
        if (fsm_ != FSM_ESTOP && fsm_ != FSM_BOOT) { setFsm(FSM_IDLE, R_USER_STOP, now); push(EV_MANUAL_STOP, now, R_USER_STOP); }
        break;
      case CMD_RESET_ESTOP: reset_req_ = true; break;
      case CMD_FORWARD: case CMD_REVERSE: case CMD_LEFT: case CMD_RIGHT:
        if (fsm_ == FSM_IDLE || fsm_ == FSM_MANUAL) {
          manual_ = c.type; manual_at_ = now;
          manual_ttl_ = c.ttl_ms ? c.ttl_ms : 1500;
          if (fsm_ != FSM_MANUAL) setFsm(FSM_MANUAL, R_SUCCESS, now);
        } else {
          push(EV_CMD_REJECTED, now, R_REJECTED);
        }
        break;
      case CMD_RTB:
        if (c.has_base) setBase(c.base_lat, c.base_lon);
        if (fsm_ == FSM_IDLE || fsm_ == FSM_MANUAL || fsm_ == FSM_RTB_ARRIVED || fsm_ == FSM_PAUSED_OBSTACLE ||
            fsm_ == FSM_PAUSED_LOCALIZATION || fsm_ == FSM_PAUSED_SENSOR_FAULT || fsm_ == FSM_PAUSED_LOW_BATTERY ||
            fsm_ == FSM_FAILED) {
          manual_ = CMD_NONE; resumes_ = 0; detours_ = 0;
          startRtb(now, R_SUCCESS);
        } else {
          push(EV_CMD_REJECTED, now, R_REJECTED);
        }
        break;
      case CMD_CANCEL_RTB:
        if (fsm_ >= FSM_RTB_PRECHECK && fsm_ <= FSM_RTB_VERIFY_DOCK) setFsm(FSM_IDLE, R_USER_STOP, now);
        else if (fsm_ >= FSM_PAUSED_OBSTACLE && fsm_ <= FSM_PAUSED_LOW_BATTERY) setFsm(FSM_IDLE, R_USER_STOP, now);
        break;
      default: break;
    }
  }

  // ---- main control step (call at >= 10 Hz).  Returns the ONLY motor output.
  Motors tick(const Inputs& in) {
    const uint32_t now = in.now_ms;
    updateLink(in);
    updateSensors(in);
    updateGps(in);

    // 1. Absolute priority: emergency stop / hardware fault.
    if (in.estop_button) latchEstop(now, R_BUTTON_HELD);
    if (!in.hw_ok && fsm_ != FSM_ESTOP) { latchEstop(now, R_HW_FAULT); }
    if (reset_req_) {
      reset_req_ = false;
      if (fsm_ == FSM_ESTOP && !in.estop_button && in.hw_ok && front_ok_) setFsm(FSM_IDLE, R_SUCCESS, now);
      else push(EV_CMD_REJECTED, now, R_REJECTED);
    }
    if (fsm_ == FSM_BOOT) { if (in.hw_ok) setFsm(FSM_IDLE, R_SUCCESS, now); return finish(Motors(), in); }

    // 2. Battery state machine (events once per transition).
    batteryCheck(in, now);

    Motors m;
    switch (fsm_) {
      case FSM_ESTOP: case FSM_FAILED: case FSM_RTB_ARRIVED:
      case FSM_PAUSED_OBSTACLE: case FSM_PAUSED_SENSOR_FAULT: case FSM_PAUSED_LOW_BATTERY:
        break;
      case FSM_PAUSED_LOCALIZATION: stepLocalizationPause(in, now); break;
      case FSM_IDLE: stepIdle(in, now); break;
      case FSM_MANUAL: m = stepManual(in, now); break;
      case FSM_RTB_PRECHECK: stepPrecheck(in, now); break;
      case FSM_RTB_NAVIGATE: m = stepNavigate(in, now); break;
      case FSM_RTB_AVOID: m = stepAvoid(in, now); break;
      case FSM_RTB_VERIFY_DOCK: stepVerify(in, now); break;
      default: break;
    }
    return finish(m, in);
  }

  // ---- status
  Fsm fsm() const { return fsm_; }
  Reason reason() const { return reason_; }
  bool estop() const { return fsm_ == FSM_ESTOP; }
  bool offline() const { return offline_; }
  LinkState linkClass() const { return link_class_; }
  bool arrived() const { return fsm_ == FSM_RTB_ARRIVED; }
  bool sensorHealthy() const { return front_ok_; }
  bool gpsTrusted() const { return gps_ok_; }
  double rtbDistanceM() const { return rtb_dist_; }
  uint32_t offlineSinceMs() const { return offline_since_; }
  int detours() const { return detours_; }
  bool rtbActive() const { return fsm_ >= FSM_RTB_PRECHECK && fsm_ <= FSM_RTB_VERIFY_DOCK; }
  bool popEvent(Event& e) {
    if (ev_tail_ == ev_head_) return false;
    e = ev_[ev_tail_]; ev_tail_ = (ev_tail_ + 1) % kEv; return true;
  }
  uint32_t droppedEvents() const { return ev_dropped_; }
  const Config& config() const { return cfg_; }

 private:
  Config cfg_;
  Fsm fsm_ = FSM_BOOT; Reason reason_ = R_NONE;
  bool has_base_ = false; double base_lat_ = 0, base_lon_ = 0;
  CmdType manual_ = CMD_NONE; uint32_t manual_at_ = 0, manual_ttl_ = 0;
  bool reset_req_ = false;
  // link
  bool offline_ = false; uint32_t link_bad_since_ = 0; bool link_bad_ = false; uint32_t offline_since_ = 0;
  LinkState link_class_ = LINK_ONLINE; bool offline_auto_started_ = false;
  // sensors / gps
  bool front_ok_ = false, left_ok_ = false, right_ok_ = false, rear_ok_ = false;
  bool gps_ok_ = false, gps_have_prev_ = false; double prev_lat_ = 0, prev_lon_ = 0; uint32_t prev_t_ = 0;
  uint32_t gps_untrusted_until_ = 0; bool gps_lost_reported_ = false, sensor_fault_reported_ = false;
  bool hdg_ok_ = false;
  // battery
  uint8_t batt_state_ = 0;  // 0 ok/unknown, 1 low, 2 critical
  // rtb
  double rtb_dist_ = 0, best_dist_ = 1e9; uint32_t last_progress_ = 0;
  int detours_ = 0, resumes_ = 0, confirm_ = 0; uint32_t last_confirm_ = 0, pause_since_ = 0;
  uint32_t turn_started_ = 0; bool turning_ = false;
  // avoid
  enum Phase : uint8_t { PH_SETTLE, PH_TURN, PH_ADVANCE } phase_ = PH_SETTLE;
  uint32_t phase_at_ = 0; float avoid_target_ = 0; int avoid_dir_ = 0;
  double adv_lat_ = 0, adv_lon_ = 0; float adv_odom_ = 0;
  // events
  static constexpr int kEv = 64;
  Event ev_[kEv]; int ev_head_ = 0, ev_tail_ = 0; uint32_t ev_dropped_ = 0;

  void push(EventType t, uint32_t now, Reason r, uint8_t a = 0, uint8_t b = 0, float x = 0, float y = 0) {
    int next = (ev_head_ + 1) % kEv;
    if (next == ev_tail_) { ev_tail_ = (ev_tail_ + 1) % kEv; ev_dropped_++; }  // overwrite oldest
    ev_[ev_head_] = Event{now, t, a, b, r, x, y};
    ev_head_ = next;
  }
  void setFsm(Fsm s, Reason r, uint32_t now) {
    if (s == fsm_ && r == reason_) return;
    if (s != fsm_) push(EV_STATE, now, r, fsm_, s);
    fsm_ = s; reason_ = r; turning_ = false;
  }
  void latchEstop(uint32_t now, Reason r) {
    manual_ = CMD_NONE;
    if (fsm_ != FSM_ESTOP) { push(EV_ESTOP, now, r); setFsm(FSM_ESTOP, r, now); }
  }
  void fail(uint32_t now, Reason r) { push(EV_RTB_FAILED, now, r); setFsm(FSM_FAILED, r, now); }

  // ---- inputs
  void updateLink(const Inputs& in) {
    const uint32_t now = in.now_ms;
    if (in.link == LINK_ONLINE) {
      link_bad_ = false;
      if (offline_) { offline_ = false; push(EV_LINK_RESTORED, now, R_SUCCESS, link_class_, 0, (float)(now - offline_since_) / 1000.f); }
      link_class_ = LINK_ONLINE;
      return;
    }
    if (!link_bad_) { link_bad_ = true; link_bad_since_ = now; }
    link_class_ = in.link;
    if (!offline_ && now - link_bad_since_ >= cfg_.link_loss_declare_ms) {
      offline_ = true; offline_since_ = now; offline_auto_started_ = false;
      push(EV_LINK_LOST, now, R_SUCCESS, in.link);
    }
  }
  bool fresh(const Range& r, uint32_t now) const {
    return r.valid && isfinite(r.cm) && r.cm >= 2.0f && r.cm <= 600.0f && now - r.t_ms <= cfg_.sensor_max_age_ms;
  }
  void updateSensors(const Inputs& in) {
    const uint32_t now = in.now_ms;
    front_ok_ = fresh(in.front, now); left_ok_ = fresh(in.left, now);
    right_ok_ = fresh(in.right, now); rear_ok_ = fresh(in.rear, now);
    hdg_ok_ = in.hdg.valid && isfinite(in.hdg.deg) && now - in.hdg.t_ms <= cfg_.heading_max_age_ms;
    if (!front_ok_ && !sensor_fault_reported_) { sensor_fault_reported_ = true; push(EV_SENSOR_FAULT, now, R_SENSOR_FAULT); }
    if (front_ok_) sensor_fault_reported_ = false;
  }
  void updateGps(const Inputs& in) {
    const uint32_t now = in.now_ms; const Gps& g = in.gps;
    bool ok = g.fix && isfinite(g.lat) && isfinite(g.lon) && g.lat >= -90 && g.lat <= 90 && g.lon >= -180 &&
              g.lon <= 180 && !(g.lat == 0 && g.lon == 0) && g.sats >= cfg_.gps_min_sats &&
              g.acc_m <= cfg_.gps_max_accuracy_m && now - g.t_ms <= cfg_.gps_max_age_ms;
    if (ok && g.t_ms != prev_t_) {                       // plausibility vs. previous distinct fix
      if (gps_have_prev_ && g.t_ms > prev_t_) {
        const double dt = (g.t_ms - prev_t_) / 1000.0;
        const double d = distanceM(prev_lat_, prev_lon_, g.lat, g.lon);
        if (dt > 0 && d / dt > cfg_.gps_max_jump_mps && d > 3.0) { gps_untrusted_until_ = now + cfg_.gps_untrusted_ms; }
      }
      prev_lat_ = g.lat; prev_lon_ = g.lon; prev_t_ = g.t_ms; gps_have_prev_ = true;
    }
    if (now < gps_untrusted_until_) ok = false;
    gps_ok_ = ok;
    if (!ok && !gps_lost_reported_) { gps_lost_reported_ = true; push(EV_GPS_LOST, now, now < gps_untrusted_until_ ? R_GPS_GLITCH : R_NO_GPS); }
    if (ok) gps_lost_reported_ = false;
  }
  void batteryCheck(const Inputs& in, uint32_t now) {
    uint8_t s = 0;
    if (in.batt.valid) s = in.batt.pct <= cfg_.battery_crit_pct ? 2 : (in.batt.pct <= cfg_.battery_low_pct ? 1 : 0);
    if (s > batt_state_) push(EV_LOW_BATT, now, R_BATTERY_LOW, s, 0, in.batt.pct);
    batt_state_ = s;
    if (s == 2 && (fsm_ == FSM_MANUAL || rtbActive())) { manual_ = CMD_NONE; setFsm(FSM_PAUSED_LOW_BATTERY, R_BATTERY_LOW, now); }
  }

  // ---- states
  void stepIdle(const Inputs& in, uint32_t now) {
    if (offline_ && cfg_.offline_auto_rtb && has_base_ && !offline_auto_started_ &&
        now - offline_since_ >= cfg_.offline_auto_rtb_delay_ms && batt_state_ == 0) {
      offline_auto_started_ = true; resumes_ = 0; detours_ = 0;
      startRtb(now, R_OFFLINE_AUTO);
    }
    (void)in;
  }
  Motors stepManual(const Inputs& in, uint32_t now) {
    Motors m;
    if (manual_ == CMD_NONE) { setFsm(FSM_IDLE, R_USER_STOP, now); return m; }
    if (now - manual_at_ > manual_ttl_) { manual_ = CMD_NONE; push(EV_MANUAL_STOP, now, R_CMD_EXPIRED); setFsm(FSM_IDLE, R_CMD_EXPIRED, now); return m; }
    // Manual driving needs a live operator link.
    if (in.link != LINK_ONLINE && link_bad_ && now - link_bad_since_ >= cfg_.manual_link_timeout_ms) {
      manual_ = CMD_NONE; push(EV_MANUAL_STOP, now, R_MANUAL_LINK_LOSS); setFsm(FSM_IDLE, R_MANUAL_LINK_LOSS, now); return m;
    }
    if (batt_state_ != 0) { manual_ = CMD_NONE; setFsm(FSM_IDLE, R_BATTERY_LOW, now); return m; }
    if (!front_ok_) { manual_ = CMD_NONE; setFsm(FSM_IDLE, R_SENSOR_FAULT, now); return m; }
    const int p = cfg_.pwm_manual;
    switch (manual_) {
      case CMD_FORWARD:
        if (sideTight(in)) { manual_ = CMD_NONE; push(EV_OBSTACLE_STOP, now, R_OBSTACLE, 1, 0, in.left.cm < in.right.cm ? in.left.cm : in.right.cm); setFsm(FSM_IDLE, R_OBSTACLE, now); return m; }
        if (in.front.cm <= cfg_.stop_cm) { manual_ = CMD_NONE; push(EV_OBSTACLE_STOP, now, R_OBSTACLE, 0, 0, in.front.cm); setFsm(FSM_IDLE, R_OBSTACLE, now); return m; }
        { int pp = in.front.cm < cfg_.slow_cm ? (p * 6) / 10 : p; m.left = pp; m.right = pp; }
        break;
      case CMD_REVERSE:
        if (!rear_ok_ || in.rear.cm <= cfg_.stop_cm) { manual_ = CMD_NONE; setFsm(FSM_IDLE, rear_ok_ ? R_OBSTACLE : R_SENSOR_FAULT, now); return m; }
        m.left = -(p * 6) / 10; m.right = m.left;
        break;
      case CMD_LEFT: m.left = -(p * 7) / 10; m.right = (p * 7) / 10; break;
      case CMD_RIGHT: m.left = (p * 7) / 10; m.right = -(p * 7) / 10; break;
      default: break;
    }
    return m;
  }
  void startRtb(uint32_t now, Reason r) {
    setFsm(FSM_RTB_PRECHECK, r, now);
    push(EV_RTB_STARTED, now, r);
    best_dist_ = 1e9; last_progress_ = now; confirm_ = 0;
  }
  // Returns false (and sets the right pause/fail state) when a precondition is missing.
  bool precheck(const Inputs& in, uint32_t now, bool initial) {
    if (!has_base_) { fail(now, R_NO_BASE); return false; }
    if (!in.batt.valid || in.batt.pct < cfg_.battery_rtb_min_pct) {
      if (initial) { fail(now, R_BATTERY_LOW); return false; }
    }
    if (!front_ok_) { setFsm(FSM_PAUSED_SENSOR_FAULT, R_SENSOR_FAULT, now); push(EV_RTB_FAILED, now, R_SENSOR_FAULT); return false; }
    if (!gps_ok_) { pause_since_ = now; setFsm(FSM_PAUSED_LOCALIZATION, R_NO_GPS, now); push(EV_RTB_FAILED, now, R_NO_GPS); return false; }
    if (!hdg_ok_) { pause_since_ = now; setFsm(FSM_PAUSED_LOCALIZATION, R_NO_HEADING, now); push(EV_RTB_FAILED, now, R_NO_HEADING); return false; }
    return true;
  }
  void stepPrecheck(const Inputs& in, uint32_t now) {
    if (!precheck(in, now, true)) return;
    setFsm(FSM_RTB_NAVIGATE, R_SUCCESS, now); last_progress_ = now; best_dist_ = 1e9;
  }
  void stepLocalizationPause(const Inputs& in, uint32_t now) {
    // Bounded, explicit safe-resume policy: only localisation faults, only with fresh healthy data,
    // only a limited number of times.  Anything else needs a new operator command.
    if (now - pause_since_ > cfg_.resume_window_ms) return;
    if (resumes_ < cfg_.max_resumes && gps_ok_ && hdg_ok_ && front_ok_ && has_base_) {
      resumes_++; push(EV_RESUME, now, R_SUCCESS, resumes_);
      setFsm(FSM_RTB_PRECHECK, R_SUCCESS, now);
    }
    (void)in;
  }
  // Lateral protection: never drive forward alongside something touching the body; steer away early.
  bool sideTight(const Inputs& in) const {
    return (left_ok_ && in.left.cm <= cfg_.side_stop_cm) || (right_ok_ && in.right.cm <= cfg_.side_stop_cm);
  }
  Motors rotateAway(const Inputs& in) const {
    Motors m; const int t = cfg_.pwm_turn;
    const bool leftNear = left_ok_ && in.left.cm <= cfg_.side_stop_cm;
    const bool rightNear = right_ok_ && in.right.cm <= cfg_.side_stop_cm;
    int dir = (leftNear && (!rightNear || in.left.cm <= in.right.cm)) ? +1 : -1;   // +1 = clockwise (away from left wall)
    m.left = dir * t; m.right = -dir * t; return m;
  }
  int lateralBias(const Inputs& in) const {
    int b = 0;
    if (left_ok_ && in.left.cm < cfg_.side_slow_cm) b += (int)(2.0f * (cfg_.side_slow_cm - in.left.cm));
    if (right_ok_ && in.right.cm < cfg_.side_slow_cm) b -= (int)(2.0f * (cfg_.side_slow_cm - in.right.cm));
    return b;
  }
  Motors stepNavigate(const Inputs& in, uint32_t now) {
    Motors m;
    if (!front_ok_) { setFsm(FSM_PAUSED_SENSOR_FAULT, R_SENSOR_FAULT, now); push(EV_RTB_FAILED, now, R_SENSOR_FAULT); return m; }
    if (!gps_ok_ || !hdg_ok_) { pause_since_ = now; setFsm(FSM_PAUSED_LOCALIZATION, gps_ok_ ? R_NO_HEADING : R_NO_GPS, now); push(EV_RTB_FAILED, now, gps_ok_ ? R_NO_HEADING : R_NO_GPS); return m; }
    if (offline_ && now - offline_since_ > cfg_.offline_max_autonomy_ms) { fail(now, R_AUTONOMY_TIMEOUT); return m; }
    rtb_dist_ = distanceM(in.gps.lat, in.gps.lon, base_lat_, base_lon_);
    if (rtb_dist_ <= cfg_.arrive_radius_m) { confirm_ = 0; last_confirm_ = 0; setFsm(FSM_RTB_VERIFY_DOCK, R_SUCCESS, now); return m; }
    if (rtb_dist_ < best_dist_ - 1.0) { best_dist_ = rtb_dist_; last_progress_ = now; }
    if (now - last_progress_ > cfg_.progress_timeout_ms) { fail(now, R_NO_PROGRESS); return m; }
    if (in.front.cm <= cfg_.stop_cm) {
      push(EV_OBSTACLE_STOP, now, R_OBSTACLE, 0, 0, in.front.cm);
      startAvoid(in, now); return m;
    }
    const float bearing = (float)bearingDeg(in.gps.lat, in.gps.lon, base_lat_, base_lon_);
    const float err = wrap180(bearing - in.hdg.deg);
    if (fabsf(err) > cfg_.turn_threshold_deg || turning_) {
      if (!turning_) { turning_ = true; turn_started_ = now; }
      if (fabsf(err) <= cfg_.heading_tol_deg) { turning_ = false; }
      else {
        if (now - turn_started_ > cfg_.turn_timeout_ms) { fail(now, R_TURN_TIMEOUT); return m; }
        const int t = cfg_.pwm_turn;
        m.left = err > 0 ? t : -t; m.right = -m.left; return m;
      }
    }
    if (sideTight(in)) return rotateAway(in);
    int base = cfg_.pwm_auto;
    if (in.front.cm < cfg_.slow_cm) base = (base * 6) / 10;
    int corr = (int)(cfg_.steer_gain * err) + lateralBias(in);
    if (corr > base / 2) corr = base / 2;
    if (corr < -base / 2) corr = -base / 2;
    m.left = base + corr; m.right = base - corr;
    return m;
  }
  void startAvoid(const Inputs& in, uint32_t now) {
    (void)in;
    detours_++;
    setFsm(FSM_RTB_AVOID, R_OBSTACLE, now);
    phase_ = PH_SETTLE; phase_at_ = now; avoid_dir_ = 0;
  }
  float travelled(const Inputs& in) const {
    if (in.odom_m >= 0 && adv_odom_ >= 0) return in.odom_m - adv_odom_;
    return (float)distanceM(adv_lat_, adv_lon_, in.gps.lat, in.gps.lon);
  }
  Motors stepAvoid(const Inputs& in, uint32_t now) {
    Motors m;
    // Any loss of required data while avoiding => stop and hold.
    if (!front_ok_) { setFsm(FSM_PAUSED_SENSOR_FAULT, R_SENSOR_FAULT, now); push(EV_RTB_FAILED, now, R_SENSOR_FAULT); return m; }
    if (!gps_ok_ || !hdg_ok_) { pause_since_ = now; setFsm(FSM_PAUSED_LOCALIZATION, R_NO_GPS, now); push(EV_RTB_FAILED, now, R_NO_GPS); return m; }
    if (offline_ && now - offline_since_ > cfg_.offline_max_autonomy_ms) { fail(now, R_AUTONOMY_TIMEOUT); return m; }
    if (detours_ > cfg_.max_detours) { fail(now, R_NO_SAFE_ROUTE); return m; }
    switch (phase_) {
      case PH_SETTLE: {
        if (now - phase_at_ < cfg_.settle_ms) return m;           // verified stop before any re-plan
        // Never turn blindly: both side sensors must be fresh and one side must be clear.
        if (!left_ok_ || !right_ok_) { fail(now, R_NO_SAFE_ROUTE); return m; }
        const float l = in.left.cm, r = in.right.cm;
        if (l < cfg_.side_clear_cm && r < cfg_.side_clear_cm) { fail(now, R_NO_SAFE_ROUTE); return m; }
        // Prefer the side that is clearer; if the base is clearly on one side, prefer that when both are clear.
        avoid_dir_ = (l >= r) ? -1 : +1;                          // -1 = turn left, +1 = turn right
        const float bearing = (float)bearingDeg(in.gps.lat, in.gps.lon, base_lat_, base_lon_);
        const float err = wrap180(bearing - in.hdg.deg);
        if (l >= cfg_.side_clear_cm && r >= cfg_.side_clear_cm) avoid_dir_ = err >= 0 ? +1 : -1;
        avoid_target_ = in.hdg.deg + 90.0f * avoid_dir_;
        phase_ = PH_TURN; phase_at_ = now; turn_started_ = now;
        push(EV_DETOUR, now, R_OBSTACLE, (uint8_t)detours_, avoid_dir_ > 0 ? 1 : 0, in.front.cm);
        return m;
      }
      case PH_TURN: {
        const float e = wrap180(avoid_target_ - in.hdg.deg);
        if (fabsf(e) <= cfg_.heading_tol_deg) {
          phase_ = PH_ADVANCE; phase_at_ = now;
          adv_lat_ = in.gps.lat; adv_lon_ = in.gps.lon; adv_odom_ = in.odom_m;
          return m;
        }
        if (now - turn_started_ > cfg_.turn_timeout_ms) { fail(now, R_TURN_TIMEOUT); return m; }
        const int t = cfg_.pwm_turn;
        m.left = e > 0 ? t : -t; m.right = -m.left;
        return m;
      }
      case PH_ADVANCE: {
        if (in.front.cm <= cfg_.stop_cm) {            // blocked again: re-settle, counts as another detour
          push(EV_OBSTACLE_STOP, now, R_OBSTACLE, 0, 0, in.front.cm);
          detours_++; phase_ = PH_SETTLE; phase_at_ = now; return m;
        }
        if (travelled(in) >= cfg_.detour_m) { setFsm(FSM_RTB_NAVIGATE, R_SUCCESS, now); last_progress_ = now; best_dist_ = 1e9; return m; }
        if (now - phase_at_ > cfg_.progress_timeout_ms) { fail(now, R_NO_PROGRESS); return m; }
        if (sideTight(in)) return rotateAway(in);
        int pp = cfg_.pwm_auto; if (in.front.cm < cfg_.slow_cm) pp = (pp * 6) / 10;
        int cb = lateralBias(in); if (cb > pp / 2) cb = pp / 2; if (cb < -pp / 2) cb = -pp / 2;
        m.left = pp + cb; m.right = pp - cb; return m;
      }
    }
    return m;
  }
  void stepVerify(const Inputs& in, uint32_t now) {
    // "Arrived" is only declared after N consecutive trusted fixes inside the radius while stopped.
    if (!gps_ok_) { pause_since_ = now; setFsm(FSM_PAUSED_LOCALIZATION, R_NO_GPS, now); push(EV_RTB_FAILED, now, R_NO_GPS); return; }
    rtb_dist_ = distanceM(in.gps.lat, in.gps.lon, base_lat_, base_lon_);
    if (rtb_dist_ > cfg_.arrive_radius_m * 1.6) { setFsm(FSM_RTB_NAVIGATE, R_SUCCESS, now); last_progress_ = now; best_dist_ = 1e9; return; }
    if (rtb_dist_ <= cfg_.arrive_radius_m && now - last_confirm_ >= cfg_.arrive_sample_gap_ms) {
      last_confirm_ = now;
      if (++confirm_ >= cfg_.arrive_confirm_samples) {
        push(EV_RTB_ARRIVED, now, R_SUCCESS, 0, 0, (float)rtb_dist_, in.gps.acc_m);
        setFsm(FSM_RTB_ARRIVED, R_SUCCESS, now);
      }
    }
  }

  // ---- independent final limiter (defence in depth; does NOT trust the FSM)
  static int clampPwm(int v, int lim) { return v > lim ? lim : (v < -lim ? -lim : v); }
  Motors finish(Motors m, const Inputs& in) {
    const int lim = cfg_.pwm_manual > cfg_.pwm_auto ? cfg_.pwm_manual : cfg_.pwm_auto;
    m.left = clampPwm(m.left, lim); m.right = clampPwm(m.right, lim);
    const bool allowed_state = (fsm_ == FSM_MANUAL || fsm_ == FSM_RTB_NAVIGATE || fsm_ == FSM_RTB_AVOID);
    if (fsm_ == FSM_ESTOP || in.estop_button || !in.hw_ok || !allowed_state || batt_state_ == 2) { m.left = 0; m.right = 0; return m; }
    const bool forward = (m.left + m.right) > 0;
    if (forward && (!front_ok_ || in.front.cm <= cfg_.stop_cm)) {
      // forward component forbidden: keep pure rotation only when sensor is healthy, else full stop
      if (front_ok_ && m.left * m.right < 0 && abs(m.left + m.right) < 4) return m;
      m.left = 0; m.right = 0;
    }
    if (forward && sideTight(in)) { m.left = 0; m.right = 0; }   // never drive forward with a body-contact side reading
    if ((m.left + m.right) < 0 && !(rear_ok_ && in.rear.cm > cfg_.stop_cm) && m.left * m.right > 0) { m.left = 0; m.right = 0; }
    if (!front_ok_) { m.left = 0; m.right = 0; }     // no fresh forward sensing => never move at all
    return m;
  }
};

}  // namespace defenx

