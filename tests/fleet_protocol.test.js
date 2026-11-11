// Cross-language protocol test: JS signatures must equal the Python server's.
const test = require("node:test"), assert = require("node:assert");
const { execFileSync } = require("node:child_process"), path = require("node:path");
const P = require("../public/fleet-protocol.js");
const py = (code) => execFileSync("python3", ["-c", code], { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim();

test("request signature identical to Python", async () => {
  const body = '{"lat":12.9716,"battery":80,"note":"héllo"}';
  const bytes = P.enc.encode(body);
  const js = await P.signRequest("a".repeat(64), "POST", "/api/fleet/heartbeat", "PHONE-01", "1800000000.123", "nonce_nonce_nonce_01", bytes);
  const expected = py(`import sys;sys.path.insert(0,'src');import fleet as F;print(F.sign_request('${"a".repeat(64)}','POST','/api/fleet/heartbeat','PHONE-01','1800000000.123','nonce_nonce_nonce_01','{"lat":12.9716,"battery":80,"note":"héllo"}'.encode()))`);
  assert.equal(js, expected);
});
test("response signature identical to Python", async () => {
  const raw = P.enc.encode('{"ok":true,"commands":[]}');
  const js = await P.signResponse("b".repeat(64), "ROVER-01", "n".repeat(20), raw);
  const expected = py(`import sys;sys.path.insert(0,'src');import fleet as F;print(F.sign_response('${"b".repeat(64)}','ROVER-01','${"n".repeat(20)}',b'{"ok":true,"commands":[]}'))`);
  assert.equal(js, expected);
});
test("nonce format satisfies server regex and is unique", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) { const n = P.nonce(); assert.match(n, /^[A-Za-z0-9_-]{16,64}$/); seen.add(n); }
  assert.equal(seen.size, 500);
});
test("timingSafeEqualHex", () => {
  assert.ok(P.timingSafeEqualHex("ab", "ab")); assert.ok(!P.timingSafeEqualHex("ab", "ac")); assert.ok(!P.timingSafeEqualHex("ab", "abc")); assert.ok(!P.timingSafeEqualHex(null, "a"));
});
