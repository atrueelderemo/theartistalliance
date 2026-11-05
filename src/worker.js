import { DurableObject } from "cloudflare:workers";
import { handleMessage, sendPeers, rid } from "./room.js";

const ROOM_RE = /^\/api\/r\/([a-z0-9-]{3,40})(\/.*)?$/;
const MAX_IMG = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = ROOM_RE.exec(url.pathname);
    if (m) {
      const stub = env.TABLE.get(env.TABLE.idFromName(m[1]));
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

// One Durable Object per table (room code). It keeps the table's state and
// relays live moves between everyone connected.
export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.wrappers = new WeakMap();
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS img (id TEXT, part INTEGER, type TEXT, data BLOB, PRIMARY KEY (id, part))"
    );
    const st = ctx.storage;
    this.store = {
      get: (k) => st.get(k),
      put: (k, v) => st.put(k, v),
      delete: (k) => st.delete(k),
      list: (prefix) => st.list({ prefix }),
    };
  }

  wrap(ws) {
    let w = this.wrappers.get(ws);
    if (!w) {
      w = { ws, info: ws.deserializeAttachment() || { id: rid(), name: "Adventurer", color: "#888888" }, send: (s) => ws.send(s) };
      this.wrappers.set(ws, w);
    }
    return w;
  }

  sockets(exceptWs) {
    return this.ctx.getWebSockets().filter((ws) => ws !== exceptWs).map((ws) => this.wrap(ws));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const sub = ROOM_RE.exec(url.pathname)?.[2] || "/";

    if (sub === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ id: rid(), name: "Adventurer", color: "#888888", joined: false });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (sub === "/img" && request.method === "POST") {
      const type = request.headers.get("Content-Type") || "";
      if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return json({ error: "Images only (PNG, JPG, WebP, GIF)." }, 415);
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.byteLength > MAX_IMG) return json({ error: "Image too large (max 10 MB)." }, 413);
      const id = rid();
      for (let i = 0, part = 0; i < buf.byteLength; i += CHUNK, part++) {
        this.ctx.storage.sql.exec("INSERT INTO img (id, part, type, data) VALUES (?, ?, ?, ?)", id, part, type, buf.slice(i, i + CHUNK));
      }
      return json({ id });
    }

    const im = /^\/img\/([A-Za-z0-9]{1,64})$/.exec(sub);
    if (im && request.method === "GET") {
      const rows = this.ctx.storage.sql.exec("SELECT type, data FROM img WHERE id = ? ORDER BY part", im[1]).toArray();
      if (!rows.length) return new Response("Not found", { status: 404 });
      const parts = rows.map((r) => new Uint8Array(r.data));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.byteLength; }
      return new Response(out, {
        headers: { "Content-Type": rows[0].type, "Cache-Control": "public, max-age=31536000, immutable" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    const w = this.wrap(ws);
    const r = await handleMessage(this.store, () => this.sockets(), w, typeof message === "string" ? message : "");
    if (r === "info") ws.serializeAttachment(w.info);
  }

  async webSocketClose(ws) {
    sendPeers(() => this.sockets(ws));
    try { ws.close(); } catch (e) { /* already closed */ }
  }

  async webSocketError(ws) {
    sendPeers(() => this.sockets(ws));
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
