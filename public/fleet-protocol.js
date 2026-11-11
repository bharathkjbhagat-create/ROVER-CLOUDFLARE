/* DEFENX device protocol (browser + Node). Signing MUST match src/fleet.py exactly.
 * canonical request = METHOD \n PATH \n DEVICE_ID \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 * signature         = HMAC_SHA256(device_secret, canonical)  (hex)
 * response signature = HMAC_SHA256(device_secret, "RESP\n" + DEVICE_ID + "\n" + NONCE + "\n" + SHA256_HEX(BODY))
 */
(function (root, factory) {
  const api = factory(root.crypto && root.crypto.subtle ? root.crypto : (typeof require === "function" ? require("node:crypto").webcrypto : null));
  if (typeof module === "object" && module.exports) module.exports = api; else root.DefenxFleetProtocol = api;
})(typeof self !== "undefined" ? self : globalThis, function (crypto) {
  "use strict";
  const enc = new TextEncoder();
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  async function sha256Hex(bytes) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
  async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return hex(await crypto.subtle.sign("HMAC", key, typeof message === "string" ? enc.encode(message) : message));
  }
  function nonce() {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function signRequest(secret, method, path, deviceId, ts, nonceStr, bodyBytes) {
    const canonical = [method.toUpperCase(), path, deviceId, String(ts), nonceStr, await sha256Hex(bodyBytes)].join("\n");
    return hmacHex(secret, canonical);
  }
  async function signResponse(secret, deviceId, nonceStr, bodyBytes) {
    return hmacHex(secret, ["RESP", deviceId, nonceStr, await sha256Hex(bodyBytes)].join("\n"));
  }
  function timingSafeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
  }
  return { sha256Hex, hmacHex, nonce, signRequest, signResponse, timingSafeEqualHex, enc };
});
