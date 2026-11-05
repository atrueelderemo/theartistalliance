// Game-table logic shared by the Durable Object (production) and the local test server.
// `store` must offer async get(key), put(key, value), delete(key), list(prefix) -> Map.
// `sockets()` returns the open connections; each has send(str) and an `info` object {id,name,color}.

const MAX_TOKENS = 400;
const MAX_ROLLS = 40;
const MAX_MSG = 32 * 1024;

const okColor = (c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const okId = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
export const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function snapshot(store) {
  const toks = await store.list("tok:");
  const tokens = {};
  for (const [k, v] of toks) tokens[k.slice(4)] = v;
  return {
    game: (await store.get("game")) || {},
    tokens,
    rolls: (await store.get("rolls")) || [],
  };
}

function peersOf(sockets, except) {
  return sockets()
    .filter((s) => s !== except && s.info && s.info.joined)
    .map((s) => ({ id: s.info.id, name: s.info.name, color: s.info.color }));
}

function broadcast(sockets, msg, except) {
  const str = JSON.stringify(msg);
  for (const s of sockets()) {
    if (s === except || !s.info || !s.info.joined) continue;
    try { s.send(str); } catch (e) { /* socket going away */ }
  }
}

export function sendPeers(sockets, except) {
  broadcast(sockets, { t: "peers", peers: peersOf(sockets, except) }, except);
}

export async function handleMessage(store, sockets, ws, raw) {
  if (typeof raw !== "string" || raw.length > MAX_MSG) return;
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  if (!isObj(m)) return;
  const me = ws.info;

  switch (m.t) {
    case "hello": {
      me.name = clean(m.name, 24) || "Adventurer";
      if (okColor(m.color)) me.color = m.color;
      me.joined = true;
      const snap = await snapshot(store);
      ws.send(JSON.stringify({ t: "state", you: me.id, ...snap, peers: peersOf(sockets) }));
      sendPeers(sockets);
      return "info";
    }
    case "tok": {
      if (!me.joined || !okId(m.id) || !isObj(m.patch)) return;
      const key = "tok:" + m.id;
      const cur = await store.get(key);
      if (!cur) {
        const n = (await store.list("tok:")).size;
        if (n >= MAX_TOKENS) { ws.send(JSON.stringify({ t: "error", msg: "This table has too many tokens. Delete some first." })); return; }
      }
      const data = { ...(cur || {}), ...m.patch };
      if (JSON.stringify(data).length > 8000) return;
      await store.put(key, data);
      broadcast(sockets, { t: "tok", id: m.id, data }, ws);
      return;
    }
    case "tokdel": {
      if (!me.joined || !okId(m.id)) return;
      await store.delete("tok:" + m.id);
      broadcast(sockets, { t: "tokdel", id: m.id }, ws);
      return;
    }
    case "game": {
      if (!me.joined || !isObj(m.patch)) return;
      const game = { ...((await store.get("game")) || {}), ...m.patch };
      if (JSON.stringify(game).length > 8000) return;
      await store.put("game", game);
      broadcast(sockets, { t: "game", game }, ws);
      return;
    }
    case "roll": {
      if (!me.joined || !isObj(m.roll)) return;
      const r = m.roll;
      const roll = {
        id: rid(),
        name: me.name,
        color: me.color,
        expr: clean(r.expr, 40),
        label: clean(r.label, 30),
        rolls: Array.isArray(r.rolls) ? r.rolls.slice(0, 40).map((n) => Math.round(Number(n) || 0)) : [],
        total: Math.round(Number(r.total) || 0),
        crit: !!r.crit,
        fumble: !!r.fumble,
        ts: Date.now(),
      };
      const rolls = [roll, ...((await store.get("rolls")) || [])].slice(0, MAX_ROLLS);
      await store.put("rolls", rolls);
      broadcast(sockets, { t: "roll", roll });
      return;
    }
    case "drag": {
      if (!me.joined || !okId(m.id) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      broadcast(sockets, { t: "drag", from: me.id, id: m.id, x: m.x, y: m.y }, ws);
      return;
    }
    case "dragend": {
      if (!me.joined) return;
      broadcast(sockets, { t: "dragend", from: me.id }, ws);
      return;
    }
    case "ping": {
      if (!me.joined || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      broadcast(sockets, { t: "ping", x: m.x, y: m.y, color: me.color, name: me.name });
      return;
    }
    case "rename": {
      me.name = clean(m.name, 24) || me.name;
      if (okColor(m.color)) me.color = m.color;
      sendPeers(sockets);
      return "info";
    }
  }
}
