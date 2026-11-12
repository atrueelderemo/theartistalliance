# Battle Map — The Artist Alliance

A live, shared battle map for D&D and other tabletop games. Start a table, send the link, and everyone sees token moves, dice rolls and turn order as they happen. No accounts needed.

**Features:** a whiteboard-style table where you can place several maps side by side (move, resize, stack, lock), six ready-made maps (tavern, forest, dungeon, cave, crossroads, village — most can be reshuffled), upload your own maps, character tokens made from your own images (transparent PNGs stand on the map as-is) or simple round tokens, HP / AC / conditions / notes per token, shared dice roller with advantage/disadvantage, initiative tracker with rounds, pings (long-press or double-click), invite links.

## How it runs

- `public/index.html` — the whole front end (one file).
- `src/worker.js` — a Cloudflare Worker that serves the page and routes each table to its own **Durable Object**, which stores the table (tokens, map, rolls, uploaded images) and relays live moves over WebSockets.
- `src/room.js` — the table's game logic, shared with the local test server.
- `test/server.mjs` — a local stand-in for Cloudflare (`node test/server.mjs`, then open http://localhost:8787).

All of this fits within Cloudflare's free Workers plan.

## Deploying (one-time setup in the Cloudflare dashboard)

1. Go to **Workers & Pages → Create application → Import a repository**.
2. Connect GitHub if asked, then pick **atrueelderemo/theartistalliance**.
3. Keep the project name **theartistalliance** (it must match `name` in `wrangler.jsonc`) and the default deploy command `npx wrangler deploy`. Select **Save and Deploy**.
4. When it finishes, open the Worker → **Settings → Domains & Routes → Add → Custom domain**, and enter `theartistalliance.co` (or a subdomain such as `map.theartistalliance.co`). Cloudflare sets up the DNS record for you. If the domain already has a DNS record for that exact name, delete it first.

After that, every push to `main` redeploys automatically.

## Playing

Open the site, enter your name, and tap **Start a new table**. Use **Invite** to copy the table link and send it to your party. Anyone with the link can join and edit, so only share it with your group.
