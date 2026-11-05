// Local stand-in for the Cloudflare Worker, for testing without wrangler.
// Uses the same room logic (src/room.js) with in-memory storage.
// Run: node test/server.mjs  → http://localhost:8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { handleMessage, sendPeers, rid } from "../src/room.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../public");
const rooms = new Map(); // code -> {data: Map, socks: Set, imgs: Map}
const room = (c) => { if (!rooms.has(c)) rooms.set(c, { data: new Map(), socks: new Set(), imgs: new Map() }); return rooms.get(c); };
const storeOf = (r) => ({
  get: async (k) => structuredClone(r.data.get(k)),
  put: async (k, v) => void r.data.set(k, structuredClone(v)),
  delete: async (k) => void r.data.delete(k),
  list: async (p) => new Map([...r.data].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k, structuredClone(v)])),
});
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

function frame(str) {
  const p = Buffer.from(str); let h;
  if (p.length < 126) h = Buffer.from([0x81, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const m = /^\/api\/r\/([a-z0-9-]{3,40})(\/.*)?$/.exec(url.pathname);
  if (m) {
    const r = room(m[1]); const sub = m[2] || "/";
    if (sub === "/img" && req.method === "POST") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const id = rid(); r.imgs.set(id, { type: req.headers["content-type"], buf: Buffer.concat(chunks) });
      res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ id }));
    }
    const im = /^\/img\/(\w+)$/.exec(sub);
    if (im && r.imgs.has(im[1])) { const i = r.imgs.get(im[1]); res.writeHead(200, { "Content-Type": i.type }); return res.end(i.buf); }
    res.writeHead(404); return res.end();
  }
  let f = path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});

server.on("upgrade", (req, sock) => {
  const m = /^\/api\/r\/([a-z0-9-]{3,40})\/ws$/.exec(new URL(req.url, "http://x").pathname);
  if (!m) return sock.destroy();
  const r = room(m[1]); const store = storeOf(r);
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const w = { info: { id: rid(), name: "Adventurer", color: "#888888", joined: false }, send: (s) => sock.write(frame(s)) };
  r.socks.add(w);
  const sockets = () => [...r.socks];
  let buf = Buffer.alloc(0), queue = Promise.resolve();
  const close = () => { if (r.socks.delete(w)) sendPeers(sockets); sock.destroy(); };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); const p = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return close();
      if (op === 1) { const s = p.toString(); queue = queue.then(() => handleMessage(store, sockets, w, s)).catch((e) => console.error(e)); }
    }
  });
  sock.on("close", close); sock.on("error", close);
});

const PORT = Number(process.env.PORT) || 8787;
server.listen(PORT, () => console.log("Battle map test server on http://localhost:" + PORT));
