// Simulation tests for firmware/rover_core/nav_core.h  (NO physical hardware involved).
// Build & run:  g++ -std=c++17 -O1 -Wall -Wextra -I../rover_core sim_test.cpp -o sim_test && ./sim_test
// This is a software simulation with a simple differential-drive model and ray-cast range
// sensors.  Passing it proves the state machine logic; it does NOT prove real motors,
// real ultrasonic behaviour, real GPS noise or real heading sensors.
#include <cstdio>
#include <cstdlib>
#include <random>
#include <vector>
#include <functional>
#include "nav_core.h"

using namespace defenx;

static int g_fail = 0, g_pass = 0;
#define CHECK(cond, msg) do { if (cond) { g_pass++; } else { g_fail++; printf("  FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)

struct Seg { double x1, y1, x2, y2; };
static const double LAT0 = 12.9716, LON0 = 77.5946;
static double mPerDegLat() { return 111320.0; }
static double mPerDegLon() { return 111320.0 * cos(toRad(LAT0)); }

struct World {
  std::vector<Seg> walls;                       // obstacles are line segments (circles approximated by polygons)
  double x = 0, y = 0, hdg = 0;                 // metres, degrees clockwise from north
  double base_x = 0, base_y = 0;
  std::mt19937 rng{42};
  std::normal_distribution<double> n01{0.0, 1.0};
  double gps_noise = 0.5;
  uint32_t last_gps_ms = 0; double gps_x = 0, gps_y = 0;
  int collisions = 0; double min_clear = 1e9; double travelled = 0;
  bool moved_with_bad_front = false;

  void addBox(double cx, double cy, double w, double h) {
    double a = cx - w / 2, b = cx + w / 2, c = cy - h / 2, d = cy + h / 2;
    walls.push_back({a, c, b, c}); walls.push_back({b, c, b, d}); walls.push_back({b, d, a, d}); walls.push_back({a, d, a, c});
  }
  static double raySeg(double ox, double oy, double dx, double dy, const Seg& s) {
    double ex = s.x2 - s.x1, ey = s.y2 - s.y1, den = dx * ey - dy * ex;
    if (fabs(den) < 1e-9) return 1e9;
    double t = ((s.x1 - ox) * ey - (s.y1 - oy) * ex) / den, u = ((s.x1 - ox) * dy - (s.y1 - oy) * dx) / den;
    return (t >= 0 && u >= 0 && u <= 1) ? t : 1e9;
  }
  double range(double rel_deg) const {          // cone of 3 rays like an HC-SR04
    double best = 4.0;
    for (double off : {-12.0, 0.0, 12.0}) {
      double a = toRad(hdg + rel_deg + off), dx = sin(a), dy = cos(a);
      for (auto& s : walls) best = fmin(best, raySeg(x, y, dx, dy, s));
    }
    return fmax(0.0, best - 0.15) * 100.0;      // cm from rover body edge
  }
  double distToWalls() const {
    double best = 1e9;
    for (auto& s : walls) {
      double ex = s.x2 - s.x1, ey = s.y2 - s.y1, l2 = ex * ex + ey * ey;
      double t = l2 > 0 ? fmax(0, fmin(1, ((x - s.x1) * ex + (y - s.y1) * ey) / l2)) : 0;
      best = fmin(best, hypot(x - (s.x1 + t * ex), y - (s.y1 + t * ey)));
    }
    return best;
  }
  void step(const Motors& m, double dt) {
    double v = (m.left + m.right) / 2.0 / 255.0 * 1.0;               // max 1 m/s
    double w = (m.left - m.right) / 255.0 * 90.0;                    // deg/s, + = clockwise
    hdg = fmod(hdg + w * dt + 720.0, 360.0);
    double a = toRad(hdg);
    x += v * sin(a) * dt; y += v * cos(a) * dt; travelled += fabs(v) * dt;
    double d = distToWalls();
    min_clear = fmin(min_clear, d);
    if (d < 0.15) collisions++;
  }
};

struct Faults {
  std::function<bool(uint32_t)> gps_dead = [](uint32_t) { return false; };
  std::function<bool(uint32_t)> front_dead = [](uint32_t) { return false; };
  std::function<bool(uint32_t)> side_dead = [](uint32_t) { return false; };
  std::function<bool(uint32_t)> hdg_dead = [](uint32_t) { return false; };
  std::function<float(uint32_t)> battery = [](uint32_t) { return 80.0f; };
  std::function<LinkState(uint32_t)> link = [](uint32_t) { return LINK_ONLINE; };
  std::function<bool(uint32_t)> estop_btn = [](uint32_t) { return false; };
  std::function<bool(uint32_t)> gps_jump = [](uint32_t) { return false; };
};

struct Run {
  Controller c; World w; Faults f; uint32_t t = 1000; int events[32] = {0};
  uint32_t zero_motor_violation = 0;
  Run(const Config& cfg = Config()) : c(cfg) {}
  Inputs inputs() {
    Inputs in; in.now_ms = t;
    auto rng = [&](double s) { return w.n01(w.rng) * s; };
    auto mk = [&](double rel, bool dead) { Range r; r.cm = (float)(w.range(rel) + rng(1.0)); r.valid = !dead; r.t_ms = t; return r; };
    in.front = mk(0, f.front_dead(t)); in.left = mk(-90, f.side_dead(t)); in.right = mk(90, f.side_dead(t));
    in.rear = mk(180, false);
    if (t - w.last_gps_ms >= 1000) { w.last_gps_ms = t; w.gps_x = w.x + rng(w.gps_noise); w.gps_y = w.y + rng(w.gps_noise); }
    double jx = f.gps_jump(t) ? 80.0 : 0.0;
    in.gps.fix = !f.gps_dead(t); in.gps.lat = LAT0 + w.gps_y / mPerDegLat(); in.gps.lon = LON0 + (w.gps_x + jx) / mPerDegLon();
    in.gps.acc_m = 2.0f; in.gps.sats = 9; in.gps.t_ms = w.last_gps_ms;
    in.hdg.valid = !f.hdg_dead(t); in.hdg.deg = (float)fmod(w.hdg + rng(2.0) + 720.0, 360.0); in.hdg.t_ms = t;
    in.batt.valid = true; in.batt.pct = f.battery(t);
    in.link = f.link(t); in.estop_button = f.estop_btn(t); in.hw_ok = true;
    return in;
  }
  void setBase(double bx, double by) {
    w.base_x = bx; w.base_y = by;
    c.setBase(LAT0 + by / mPerDegLat(), LON0 + bx / mPerDegLon());
  }
  // run `ms` of simulated time; stop early if pred() true
  void run(uint32_t ms, std::function<bool()> stop = nullptr) {
    uint32_t end = t + ms;
    while (t < end) {
      Inputs in = inputs();
      Motors m = c.tick(in);
      // Safety invariant verified every tick: forward motion only with fresh valid front data and clearance.
      if ((m.left + m.right) > 0 && (!c.sensorHealthy() || in.front.cm <= c.config().stop_cm)) zero_motor_violation++;
      if (c.estop() && (m.left != 0 || m.right != 0)) zero_motor_violation++;
      w.step(m, 0.1);
      Event e; while (c.popEvent(e)) if (e.type < 32) events[e.type]++;
      t += 100;
      if (stop && stop()) break;
    }
  }
  void rtb() { Command cm; cm.type = CMD_RTB; c.onCommand(cm, t); }
  double distBase() const { return hypot(w.x - w.base_x, w.y - w.base_y); }
};

static void section(const char* n) { printf("\n[%s]\n", n); }

int main() {
  // ---------------------------------------------------------------- unit
  section("unit: math + link classification");
  CHECK(fabs(distanceM(12.0, 77.0, 12.001, 77.0) - 111.2) < 0.5, "haversine 0.001deg lat ~111m");
  CHECK(fabs(bearingDeg(12, 77, 12.001, 77) - 0) < 0.01, "bearing north");
  CHECK(fabs(bearingDeg(12, 77, 12, 77.001) - 90) < 0.1, "bearing east");
  CHECK(fabs(wrap180(350) - (-10)) < 1e-4 && fabs(wrap180(-190) - 170) < 1e-4, "wrap180");
  CHECK(classifyLink(false, false, false) == LINK_WIFI_DOWN, "wifi down => local network failure");
  CHECK(classifyLink(true, false, false) == LINK_INTERNET_DOWN, "wifi up, no internet => internet down");
  CHECK(classifyLink(true, true, false) == LINK_SERVER_DOWN, "internet ok, server down => server failure");
  CHECK(classifyLink(true, true, true) == LINK_ONLINE, "all ok => online");

  // ---------------------------------------------------------------- 1 open field RTB
  section("RTB in open field arrives, confirmed only after verification");
  {
    Run r; r.w.x = 0; r.w.y = 0; r.w.hdg = 90; r.setBase(40, 25); r.run(500); r.rtb();
    bool seen_verify = false, arrived_before_verify = false;
    r.run(180000, [&] { if (r.c.fsm() == FSM_RTB_VERIFY_DOCK) seen_verify = true; if (r.c.arrived() && !seen_verify) arrived_before_verify = true; return r.c.arrived(); });
    CHECK(r.c.arrived(), "rover reports ARRIVED");
    CHECK(seen_verify && !arrived_before_verify, "VERIFY_DOCK precedes ARRIVED");
    CHECK(r.distBase() < 4.0, "physically near base when arrived");
    CHECK(r.events[EV_RTB_ARRIVED] == 1, "exactly one arrival event");
    CHECK(r.zero_motor_violation == 0, "no unsafe motor output");
    r.run(2000); Motors m = r.c.tick(r.inputs()); CHECK(m.left == 0 && m.right == 0, "motors stopped after arrival");
  }

  // ---------------------------------------------------------------- 2 obstacle detour
  section("RTB detours around a box in the path and still arrives");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.w.addBox(20, 0, 2.0, 6.0); r.run(500); r.rtb();
    r.run(300000, [&] { return r.c.arrived() || r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.arrived(), "arrived after avoiding obstacle");
    CHECK(r.w.collisions == 0, "zero collisions");
    CHECK(r.events[EV_DETOUR] >= 1, "detour event recorded");
    CHECK(r.zero_motor_violation == 0, "no unsafe motor output");
  }

  // ---------------------------------------------------------------- 3 no safe route
  section("No safe route: long walls on every side => stop safely, never collide");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.w.addBox(20, 0, 1.0, 400.0); r.run(500); r.rtb();
    r.run(300000, [&] { return r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.fsm() == FSM_FAILED, "FAILED state reached");
    CHECK(r.c.reason() == R_NO_SAFE_ROUTE || r.c.reason() == R_NO_PROGRESS, "reason is no-safe-route/no-progress");
    CHECK(r.w.collisions == 0, "zero collisions");
    CHECK(r.zero_motor_violation == 0, "no unsafe motor output");
    r.run(3000); Motors m = r.c.tick(r.inputs()); CHECK(m.left == 0 && m.right == 0, "motors remain stopped");
    CHECK(r.events[EV_RTB_FAILED] >= 1, "failure recorded");
  }
  section("Dead end with side sensors failed => refuses to turn blindly");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.w.addBox(10, 0, 1.0, 30.0);
    r.f.side_dead = [](uint32_t) { return true; };
    r.run(500); r.rtb(); r.run(120000, [&] { return r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.fsm() == FSM_FAILED && r.c.reason() == R_NO_SAFE_ROUTE, "fails closed without side sensors");
    CHECK(r.w.collisions == 0, "zero collisions");
  }

  // ---------------------------------------------------------------- 4 GPS loss
  section("GPS loss mid-route => stop (localization failure)");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.run(500); r.rtb();
    r.f.gps_dead = [&](uint32_t t) { return t > 1000 + 12000; };
    r.f.gps_dead = [](uint32_t t) { return t > 14000; };
    r.run(30000, [&] { return r.c.fsm() == FSM_PAUSED_LOCALIZATION; });
    CHECK(r.c.fsm() == FSM_PAUSED_LOCALIZATION, "paused for localization");
    double x0 = r.w.x; r.run(5000); CHECK(fabs(r.w.x - x0) < 0.05, "rover did not move blindly");
  }
  section("GPS glitch (implausible jump) => untrusted, rover stops");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.run(500); r.rtb();
    r.f.gps_jump = [](uint32_t t) { return t > 12000 && t < 13500; };
    r.run(30000, [&] { return r.c.fsm() == FSM_PAUSED_LOCALIZATION; });
    CHECK(r.c.fsm() == FSM_PAUSED_LOCALIZATION, "paused after GPS jump");
    CHECK(r.zero_motor_violation == 0, "no unsafe output");
  }
  section("Bounded safe-resume after transient GPS dropout");
  {
    Run r; r.w.hdg = 90; r.setBase(60, 0); r.run(500); r.rtb();
    r.f.gps_dead = [](uint32_t t) { return t > 12000 && t < 16000; };
    r.run(240000, [&] { return r.c.arrived() || r.c.fsm() == FSM_FAILED; });
    CHECK(r.events[EV_RESUME] >= 1, "resume event after healthy GPS returns");
    CHECK(r.c.arrived(), "arrives after resume");
  }
  section("No heading source => RTB refused, no motion");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.f.hdg_dead = [](uint32_t) { return true; }; r.run(500); r.rtb(); r.run(5000);
    CHECK(r.c.fsm() == FSM_PAUSED_LOCALIZATION && r.c.reason() == R_NO_HEADING, "paused: no heading");
    CHECK(r.w.travelled < 0.01, "no movement");
  }
  section("No base saved => RTB fails closed");
  { Run r; r.run(500); r.rtb(); r.run(1000); CHECK(r.c.fsm() == FSM_FAILED && r.c.reason() == R_NO_BASE, "fails: no base"); CHECK(r.w.travelled < 0.01, "no movement"); }

  // ---------------------------------------------------------------- 5 sensor failure
  section("Front obstacle sensor failure mid-route => immediate stop");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.run(500); r.rtb();
    r.f.front_dead = [](uint32_t t) { return t > 10000; };
    r.run(30000, [&] { return r.c.fsm() == FSM_PAUSED_SENSOR_FAULT; });
    CHECK(r.c.fsm() == FSM_PAUSED_SENSOR_FAULT, "paused: sensor fault");
    double x0 = r.w.x; r.run(5000); CHECK(fabs(r.w.x - x0) < 0.05, "no motion with failed sensor");
    CHECK(r.zero_motor_violation == 0, "no unsafe output");
    CHECK(r.events[EV_SENSOR_FAULT] >= 1, "sensor fault event logged");
  }
  section("Stale sensor data (timestamp too old) is treated as invalid");
  {
    Controller c; c.setBase(12.97, 77.59);
    Inputs in; in.now_ms = 5000; in.front.cm = 200; in.front.valid = true; in.front.t_ms = 1000;
    in.gps.fix = true; in.gps.lat = 12.9716; in.gps.lon = 77.5946; in.gps.sats = 8; in.gps.acc_m = 2; in.gps.t_ms = 5000;
    in.hdg.valid = true; in.hdg.deg = 0; in.hdg.t_ms = 5000; in.batt.valid = true; in.batt.pct = 90;
    c.tick(in); Command f; f.type = CMD_FORWARD; f.ttl_ms = 1000; c.onCommand(f, 5000);
    in.now_ms = 5100; Motors m = c.tick(in);
    CHECK(m.left == 0 && m.right == 0, "stale front reading => no motion");
  }

  // ---------------------------------------------------------------- 6 battery
  section("Low battery: RTB refused below reserve; critical battery stops motion");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.f.battery = [](uint32_t) { return 18.0f; }; r.run(500); r.rtb(); r.run(2000);
    CHECK(r.c.fsm() == FSM_FAILED && r.c.reason() == R_BATTERY_LOW, "RTB refused with 18% battery");
  }
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.f.battery = [](uint32_t t) { return t < 15000 ? 60.0f : 10.0f; }; r.run(500); r.rtb();
    r.run(40000, [&] { return r.c.fsm() == FSM_PAUSED_LOW_BATTERY; });
    CHECK(r.c.fsm() == FSM_PAUSED_LOW_BATTERY, "paused at critical battery");
    CHECK(r.events[EV_LOW_BATT] >= 1, "low battery event");
  }

  // ---------------------------------------------------------------- 7 emergency stop
  section("Emergency stop has priority and is latched");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.run(500); r.rtb(); r.run(8000);
    Command e; e.type = CMD_ESTOP; r.c.onCommand(e, r.t);
    Motors m = r.c.tick(r.inputs());
    CHECK(m.left == 0 && m.right == 0 && r.c.estop(), "motors zero on the same tick as ESTOP command");
    Command rb; rb.type = CMD_RTB; r.c.onCommand(rb, r.t); r.run(2000);
    CHECK(r.c.estop(), "RTB cannot override latched e-stop");
    Command rs; rs.type = CMD_RESET_ESTOP; r.c.onCommand(rs, r.t); r.run(300);
    CHECK(r.c.fsm() == FSM_IDLE, "explicit reset returns to IDLE (no automatic motion)");
    CHECK(r.zero_motor_violation == 0, "no unsafe output");
  }
  section("Physical e-stop button works with no network at all");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.f.link = [](uint32_t) { return LINK_WIFI_DOWN; };
    r.f.estop_btn = [](uint32_t t) { return t > 14000 && t < 20000; };
    r.run(500); r.rtb(); r.run(30000, [&] { return r.c.estop(); });
    CHECK(r.c.estop(), "button latches e-stop offline");
    Command rs; rs.type = CMD_RESET_ESTOP; r.run(8000); r.c.onCommand(rs, r.t); r.run(300);
    CHECK(r.c.fsm() == FSM_IDLE || r.c.estop() == false, "reset accepted after button released");
  }

  // ---------------------------------------------------------------- 8 manual + link loss
  section("Manual drive: TTL expiry, obstacle stop, link-loss stop");
  {
    Run r; r.run(500);
    Command f; f.type = CMD_FORWARD; f.ttl_ms = 1000; r.c.onCommand(f, r.t); r.run(300);
    CHECK(r.c.fsm() == FSM_MANUAL && r.w.travelled > 0.01, "moves while command valid");
    r.run(1500); CHECK(r.c.fsm() == FSM_IDLE && r.c.reason() == R_CMD_EXPIRED, "stops when command TTL expires");
  }
  {
    Run r; r.w.addBox(3, 0, 1, 10); r.w.hdg = 90; r.run(500);
    Command f; f.type = CMD_FORWARD; f.ttl_ms = 30000; r.c.onCommand(f, r.t);
    for (int i = 0; i < 100 && r.c.fsm() == FSM_MANUAL; i++) { r.c.onCommand(f, r.t); r.run(100); }
    CHECK(r.c.fsm() == FSM_IDLE && r.c.reason() == R_OBSTACLE, "stops for obstacle in manual mode");
    CHECK(r.w.collisions == 0 && r.zero_motor_violation == 0, "no collision");
  }
  {
    Run r; r.f.link = [](uint32_t t) { return t > 3000 ? LINK_SERVER_DOWN : LINK_ONLINE; }; r.run(500);
    Command f; f.type = CMD_FORWARD; f.ttl_ms = 60000; r.c.onCommand(f, r.t);
    r.run(2500); CHECK(r.c.fsm() == FSM_MANUAL, "still driving before timeout");
    r.run(2500); CHECK(r.c.fsm() == FSM_IDLE && r.c.reason() == R_MANUAL_LINK_LOSS, "manual drive stops on link loss");
  }

  // ---------------------------------------------------------------- 9 offline autonomy
  section("Offline autonomy: link classification, local RTB without any server, autonomy timeout");
  {
    Run r; r.w.hdg = 90; r.setBase(40, 0); r.run(500); r.rtb();
    r.f.link = [](uint32_t t) { return t > 3000 ? LINK_INTERNET_DOWN : LINK_ONLINE; };
    r.run(300000, [&] { return r.c.arrived() || r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.offline() && r.c.linkClass() == LINK_INTERNET_DOWN, "offline, classified as internet failure");
    CHECK(r.c.arrived(), "RTB completed with no cloud connectivity");
    CHECK(r.events[EV_LINK_LOST] == 1, "link-lost event logged once");
  }
  {
    Config cfg; cfg.offline_auto_rtb = true; cfg.offline_auto_rtb_delay_ms = 10000;
    Run r(cfg); r.w.hdg = 90; r.setBase(40, 0); r.f.link = [](uint32_t t) { return t > 3000 ? LINK_SERVER_DOWN : LINK_ONLINE; };
    r.run(300000, [&] { return r.c.arrived() || r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.arrived(), "opt-in automatic offline return reached base");
  }
  {
    Config cfg; cfg.offline_auto_rtb = false;
    Run r(cfg); r.w.hdg = 90; r.setBase(40, 0); r.f.link = [](uint32_t t) { return t > 3000 ? LINK_WIFI_DOWN : LINK_ONLINE; };
    r.run(120000); CHECK(r.c.fsm() == FSM_IDLE && r.w.travelled < 0.01, "auto-RTB is opt-in: default stays safely idle");
    CHECK(r.c.linkClass() == LINK_WIFI_DOWN, "classified as local network failure");
  }
  {
    Config cfg; cfg.offline_max_autonomy_ms = 20000; cfg.link_loss_declare_ms = 2000;
    Run r(cfg); r.w.hdg = 90; r.setBase(400, 0); r.f.link = [](uint32_t t) { return t > 2000 ? LINK_SERVER_DOWN : LINK_ONLINE; };
    r.run(500); r.rtb(); r.run(120000, [&] { return r.c.fsm() == FSM_FAILED; });
    CHECK(r.c.fsm() == FSM_FAILED && r.c.reason() == R_AUTONOMY_TIMEOUT, "stops when offline autonomy limit is reached");
  }
  section("Reconnect: link restored event");
  {
    Run r; r.f.link = [](uint32_t t) { return (t > 2000 && t < 12000) ? LINK_SERVER_DOWN : LINK_ONLINE; }; r.run(25000);
    CHECK(r.events[EV_LINK_LOST] == 1 && r.events[EV_LINK_RESTORED] == 1 && !r.c.offline(), "lost then restored exactly once");
  }

  // ---------------------------------------------------------------- 10 cancel / no-progress
  section("Cancel RTB stops the rover");
  {
    Run r; r.w.hdg = 90; r.setBase(80, 0); r.run(500); r.rtb(); r.run(6000);
    Command cc; cc.type = CMD_CANCEL_RTB; r.c.onCommand(cc, r.t); Motors m = r.c.tick(r.inputs());
    CHECK(r.c.fsm() == FSM_IDLE && m.left == 0 && m.right == 0, "cancel => idle + motors zero");
  }

  // ---------------------------------------------------------------- 11 randomised safety property
  section("Randomised safety property: 300 random worlds with random faults never collide");
  {
    std::mt19937 rg(7); int collisions = 0, violations = 0, arrived = 0, ran = 0;
    for (int i = 0; i < 300; i++) {
      Run r; std::uniform_real_distribution<double> U(0, 1);
      r.w.rng.seed(1000 + i);
      r.w.hdg = U(rg) * 360; r.setBase((U(rg) - 0.5) * 120, (U(rg) - 0.5) * 120);
      int nbox = 1 + (int)(U(rg) * 6);
      for (int k = 0; k < nbox; k++) {
        double cx = (U(rg) - 0.5) * 100, cy = (U(rg) - 0.5) * 100;
        double bw = 1 + U(rg) * 8, bh = 1 + U(rg) * 8;
        // keep the start point and the base at least 1.5 m outside every box (a rover placed inside a wall is not a valid scenario)
        auto inside = [&](double px, double py) { return fabs(px - cx) < bw / 2 + 1.5 && fabs(py - cy) < bh / 2 + 1.5; };
        if (inside(0, 0) || inside(r.w.base_x, r.w.base_y)) continue;
        r.w.addBox(cx, cy, bw, bh);
      }
      uint32_t gps_off = U(rg) < 0.3 ? 5000 + (uint32_t)(U(rg) * 60000) : 0xFFFFFFFF;
      uint32_t front_off = U(rg) < 0.2 ? 5000 + (uint32_t)(U(rg) * 60000) : 0xFFFFFFFF;
      r.f.gps_dead = [gps_off](uint32_t t) { return t > gps_off && t < gps_off + 8000; };
      r.f.front_dead = [front_off](uint32_t t) { return t > front_off && t < front_off + 4000; };
      r.run(500); r.rtb(); r.run(240000, [&] { return r.c.arrived() || r.c.fsm() == FSM_FAILED; });
      if (r.w.collisions) printf("  info: collision in run %d: pos=(%.1f,%.1f) fsm=%s reason=%s min_clear=%.3f ticks=%d detours=%d\n", i, r.w.x, r.w.y, fsmName(r.c.fsm()), reasonName(r.c.reason()), r.w.min_clear, r.w.collisions, r.c.detours());
      collisions += r.w.collisions; violations += r.zero_motor_violation; ran++; if (r.c.arrived()) arrived++;
    }
    printf("  info: %d random runs, %d arrived, %d collisions, %d output violations\n", ran, arrived, collisions, violations);
    CHECK(collisions == 0, "no collisions in any random scenario");
    CHECK(violations == 0, "no unsafe motor output in any random scenario");
  }

  printf("\n==== sim_test: %d checks passed, %d failed ====\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
