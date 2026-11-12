"""Storage logic for ``RealtimeHub.fleet_op`` (Durable Object).

Kept as a separate pure-Python class over an abstract async ``storage``
(``get``/``put``/``delete``) so that it can be unit-tested with an in-memory
fake and so worker.py only needs a one-line delegation.

Durable Object values are limited (128 KiB), so data is sharded:
  fleet_keys            index of generic keys (no storage.list() needed)
  fleet_kv:<key>        generic values (device records, statuses, base)
  fleet_n:<device>      {nonce: expiry} replay table, per device
  fleet_q:<device>      command queue
  fleet_evc:<0..19>     ring of 50-event chunks   (1000 newest events)
  fleet_evmeta          {"counter": n}
  fleet_evid:<device>   {event_id: seq} dedupe table (newest 1500)
"""
from __future__ import annotations

import json
import time
import re

CHUNK = 50
CHUNKS = 20
MAX_DEDUPE = 1500
MAX_DATA_JSON = 600


class FleetDOLogic:
    def __init__(self, storage, clock=time.time):
        self.s = storage
        self.clock = clock

    async def handle(self, request):
        if isinstance(request, str):
            try:
                request = json.loads(request)
            except ValueError:
                return {"ok": False, "error": "bad_request"}
        if not isinstance(request, dict):
            return {"ok": False, "error": "bad_request"}
        op = str(request.get("op") or "")
        fn = getattr(self, "_op_" + op, None)
        if fn is None or op.startswith("_"):
            return {"ok": False, "error": "bad_request"}
        try:
            return await fn(request)
        except (KeyError, TypeError, ValueError):
            return {"ok": False, "error": "bad_request"}

    # generic kv ---------------------------------------------------------------
    async def _index(self):
        idx = await self.s.get("fleet_keys")
        return list(idx) if isinstance(idx, list) else []

    async def _op_get(self, r):
        return {"ok": True, "value": await self._get(str(r["key"]))}

    async def _get(self, key):
        v = await self.s.get("fleet_kv:" + key)
        return v if v is not None else None

    async def _op_put(self, r):
        key = str(r["key"])
        if len(key) > 120:
            return {"ok": False, "error": "bad_request"}
        idx = await self._index()
        if key not in idx:
            if len(idx) >= 500:
                return {"ok": False, "error": "limit"}
            idx.append(key)
            await self.s.put("fleet_keys", idx)
        await self.s.put("fleet_kv:" + key, r["value"])
        return {"ok": True}

    async def _op_delete(self, r):
        key = str(r["key"])
        idx = await self._index()
        if key in idx:
            idx.remove(key)
            await self.s.put("fleet_keys", idx)
        await self.s.delete("fleet_kv:" + key)
        return {"ok": True}

    async def _op_list(self, r):
        prefix, limit = str(r["prefix"]), min(int(r.get("limit", 200)), 500)
        keys = sorted(k for k in await self._index() if k.startswith(prefix))[:limit]
        items = []
        for k in keys:
            v = await self._get(k)
            if v is not None:
                items.append([k, v])
        return {"ok": True, "items": items}

    # replay table -------------------------------------------------------------
    async def _op_claim_nonce(self, r):
        device, _, nonce = str(r["key"]).partition(":")
        if not device or not nonce:
            return {"ok": False, "error": "bad_request"}
        now, ttl = self.clock(), float(r["ttl"])
        key = "fleet_n:" + device
        table = await self.s.get(key)
        table = {k: v for k, v in (table or {}).items() if v > now} if isinstance(table, dict) else {}
        if nonce in table:
            return {"ok": True, "claimed": False}
        if len(table) >= 2000:       # abnormal flood from a *valid* key: refuse rather than evict
            return {"ok": False, "error": "nonce_table_full"}
        table[nonce] = now + ttl
        await self.s.put(key, table)
        return {"ok": True, "claimed": True}

    # one-time WebSocket device tickets ------------------------------------------
    async def _op_ws_ticket_issue(self, r):
        digest = str(r.get("ticket_hash") or "")
        device = str(r.get("device_id") or "")
        try:
            expires = int(r.get("expires_at"))
            version = int(r.get("key_version"))
        except (TypeError, ValueError):
            return {"ok": False, "error": "bad_request"}
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or not device or version < 1:
            return {"ok": False, "error": "bad_request"}
        now = int(self.clock())
        if expires <= now or expires > now + 90:
            return {"ok": False, "error": "bad_request"}
        key = "fleet_ws_ticket:" + digest
        by_device = "fleet_ws_ticket_device:" + device
        previous = await self.s.get(by_device)
        if isinstance(previous, str) and re.fullmatch(r"[0-9a-f]{64}", previous):
            await self.s.delete("fleet_ws_ticket:" + previous)
        await self.s.put(key, {"device_id": device, "key_version": version, "expires_at": expires})
        await self.s.put(by_device, digest)
        return {"ok": True}

    async def _op_ws_ticket_consume(self, r):
        digest = str(r.get("ticket_hash") or "")
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            return {"ok": False, "error": "bad_request"}
        key = "fleet_ws_ticket:" + digest
        ticket = await self.s.get(key)
        # Delete before returning any result: tickets are single-use even when
        # expired, revoked, or presented with an obsolete device key.
        await self.s.delete(key)
        device_hint = str(ticket.get("device_id") or "") if isinstance(ticket, dict) else ""
        by_device = "fleet_ws_ticket_device:" + device_hint
        if device_hint and await self.s.get(by_device) == digest:
            await self.s.delete(by_device)
        if not isinstance(ticket, dict) or int(ticket.get("expires_at") or 0) <= int(self.clock()):
            return {"ok": False, "error": "ticket_invalid"}
        device = str(ticket.get("device_id") or "")
        rec = await self._get("dev:" + device)
        if (not isinstance(rec, dict) or rec.get("revoked") is True
                or int(rec.get("key_version") or 0) != int(ticket.get("key_version") or -1)):
            return {"ok": False, "error": "ticket_invalid"}
        return {"ok": True, "device_id": device, "key_version": int(ticket["key_version"])}

    # command queue --------------------------------------------------------------
    async def _queue(self, device):
        q = await self.s.get("fleet_q:" + device)
        return list(q) if isinstance(q, list) else []

    async def _op_q_push(self, r):
        device, cap = str(r["device"]), int(r.get("cap", 50))
        q = await self._queue(device)
        q.append(r["cmd"])
        await self.s.put("fleet_q:" + device, q[-cap:])
        return {"ok": True}

    async def _op_q_pending(self, r):
        device, now = str(r["device"]), float(r["now"])
        q = await self._queue(device)
        out, changed = [], False
        for c in q:
            if c.get("status") != "pending":
                continue
            if c["expires_at"] <= now:
                c["status"], changed = "expired", True
                continue
            c["deliveries"], changed = c.get("deliveries", 0) + 1, True
            out.append(dict(c))
        if changed:
            await self.s.put("fleet_q:" + device, q)
        return {"ok": True, "items": out}

    async def _op_q_cancel(self, r):
        device, now, keep = str(r["device"]), float(r["now"]), set(r.get("keep") or [])
        q, n = await self._queue(device), 0
        for c in q:
            if c.get("status") == "pending" and c.get("command") not in keep:
                c["status"], c["detail"], c["acked_at"] = "superseded", str(r.get("reason") or "")[:80], now
                n += 1
        if n:
            await self.s.put("fleet_q:" + device, q)
        return {"ok": True, "n": n}

    async def _op_q_ack(self, r):
        device = str(r["device"])
        q = await self._queue(device)
        for c in q:
            if c.get("id") == r["id"]:
                if c.get("status") in ("pending", "expired"):
                    c["status"], c["detail"], c["acked_at"] = r["status"], str(r.get("detail") or "")[:120], float(r["now"])
                    await self.s.put("fleet_q:" + device, q)
                return {"ok": True, "cmd": c}
        return {"ok": True, "cmd": None}

    async def _op_q_list(self, r):
        q = await self._queue(str(r["device"]))
        return {"ok": True, "items": q[-int(r.get("limit", 30)):]}

    # events ---------------------------------------------------------------------
    async def _op_ev_append(self, r):
        device = str(r["device"])
        ids = await self.s.get("fleet_evid:" + device)
        ids = dict(ids) if isinstance(ids, dict) else {}
        meta = await self.s.get("fleet_evmeta")
        counter = int(meta["counter"]) if isinstance(meta, dict) else 0
        accepted, dup, chunk_cache = [], [], {}
        for ev in r["events"]:
            if ev["id"] in ids:
                dup.append(ev["id"])
                continue
            counter += 1
            ids[ev["id"]] = counter
            accepted.append(ev["id"])
            stored = dict(ev)
            stored["seq"] = counter
            data = stored.get("data")
            if stored.get("type") == "gps_track" and isinstance(data, dict):
                await self._append_gps(device, data.get("points") or [])
                stored["data"] = {"points_count": len(data.get("points") or [])}
            elif data is not None and len(json.dumps(data, separators=(",", ":"))) > MAX_DATA_JSON:
                stored["data"] = {"truncated": True}
            idx = (counter - 1) // CHUNK
            ckey = "fleet_evc:" + str(idx % CHUNKS)
            if ckey not in chunk_cache:
                existing = await self.s.get(ckey)
                existing = list(existing) if isinstance(existing, list) else []
                # A chunk whose first event belongs to an older lap of the ring is stale: overwrite it.
                if existing and (existing[0]["seq"] - 1) // CHUNK != idx:
                    existing = []
                chunk_cache[ckey] = existing
            chunk_cache[ckey].append(stored)
        for ckey, rows in chunk_cache.items():
            await self.s.put(ckey, rows)
        if len(ids) > MAX_DEDUPE:
            keep = sorted(ids.items(), key=lambda kv: kv[1])[-MAX_DEDUPE:]
            ids = dict(keep)
        await self.s.put("fleet_evid:" + device, ids)
        await self.s.put("fleet_evmeta", {"counter": counter})
        return {"ok": True, "accepted": accepted, "duplicates": dup}

    async def _append_gps(self, device, points):
        ring = await self.s.get("fleet_gps:" + device)
        ring = list(ring) if isinstance(ring, list) else []
        ring.extend([p["t"], p["lat"], p["lon"]] for p in points)
        await self.s.put("fleet_gps:" + device, ring[-600:])

    async def _op_ev_list(self, r):
        limit = min(max(int(r.get("limit", 100)), 1), 500)
        device, since = r.get("device"), r.get("since")
        rows = []
        for i in range(CHUNKS):
            chunk = await self.s.get("fleet_evc:" + str(i))
            if isinstance(chunk, list):
                rows.extend(chunk)
        rows.sort(key=lambda e: e["seq"], reverse=True)
        out = []
        for ev in rows:
            if device and ev.get("device_id") != device:
                continue
            if since is not None and ev.get("received_at", 0) <= float(since):
                continue
            out.append(ev)
            if len(out) >= limit:
                break
        return {"ok": True, "items": out}

    async def _op_gps_history(self, r):
        ring = await self.s.get("fleet_gps:" + str(r["device"]))
        return {"ok": True, "items": ring if isinstance(ring, list) else []}
