// ============================================================================
// server/index.js — HTTP + WebSocket bootstrap for the Secret Hitler server.
//
// Endpoints. The server is prefix-agnostic: the Pi's Caddy strips /secrethitler
// before forwarding, so all this process ever sees is /health and the WS upgrade
// at /. Never hard-code the prefix here.
//   GET /health  -> { ok, version, rooms }   liveness probe used by the client
//   WS  /        -> game traffic (protocol in session.js)
//
// Hardening:
//   - Origin allowlist on the upgrade. Browsers always send Origin, so this is
//     CSRF defence — NOT authentication, since a non-browser client can forge the
//     header. The caps below are what actually bound abuse. Header-less upgrades
//     are permitted only outside production so the test harness can connect.
//   - maxPayload caps a single frame. Game messages are a few hundred bytes.
//   - MAX_CONNS is the load-bearing DoS guard. The per-IP cap is best-effort
//     only: behind Tailscale Funnel the real client address is not exposed and
//     X-Forwarded-For is client-spoofable, so it can never be trusted.
//   - A token bucket per connection drops floods before they can fan out into a
//     broadcast to every socket in the room.
//   - MAX_ROOMS here, one room and one seat per connection in session.js.
// ============================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';

import { RoomManager } from './rooms.js';
import { handleMessage, handleClose } from './session.js';
import { TokenBucket } from './ratelimit.js';

const PORT = Number(process.env.PORT) || 9000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 50;
const MAX_CONNS = Number(process.env.MAX_CONNS) || 200;                  // global backstop
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 30;     // best-effort
const MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD_BYTES) || 64 * 1024;  // 64 KiB/frame
const MSG_RATE = Number(process.env.MSG_RATE_PER_SEC) || 20;             // sustained msgs/sec
const MSG_BURST = Number(process.env.MSG_BURST) || 40;                   // bucket size
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS) || 30 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';
const VERSION = process.env.APP_VERSION || 'dev';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://iamyvj.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

const manager = new RoomManager({ maxRooms: MAX_ROOMS });
const ctx = { manager, maxRooms: MAX_ROOMS };

function originAllowed(origin) {
  if (!origin) return !IS_PROD;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && !IS_PROD) return true;
  } catch (_) { /* malformed Origin header */ }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP (health probe only)
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Permissive CORS: the response carries only a liveness flag and a room count,
  // and the client is served from a different origin (GitHub Pages).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION, rooms: manager.size }));
    return;
  }
  res.writeHead(404); res.end();
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
const ipCounts = new Map();
let totalConns = 0;

// BEST EFFORT ONLY — do not treat this as an identity.
//
// The container sits behind Funnel -> Caddy, so remoteAddress is always the proxy
// and would put every client in one bucket, turning MAX_CONNS_PER_IP into a global
// cap that locks the server at that many players. So we read X-Forwarded-For, which
// a client can forge: the cap spreads honest users out but will not stop a
// determined attacker. That is deliberate — the controls that actually bound abuse
// are MAX_CONNS, the per-socket token bucket, one-room-per-connection, and the
// lobby sweep in rooms.js. Picking a trustworthy entry here needs the real header
// measured on the Pi first; guessing would risk the self-inflicted cap above.
function ipOf(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  if (!originAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  if (totalConns >= MAX_CONNS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
  }
  const ip = ipOf(req);
  const n = ipCounts.get(ip) || 0;
  if (n >= MAX_CONNS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    totalConns += 1;
    ipCounts.set(ip, n + 1);
    ws._ip = ip;
    ws._bucket = new TokenBucket(MSG_BURST, MSG_RATE);
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  // A half-open TCP connection never fires 'close', so without a heartbeat it
  // would hold a connection slot, a seat and its room open indefinitely. Any
  // frame from the peer counts as proof of life, not just the pong.
  ws._alive = true;
  const alive = () => { ws._alive = true; };
  ws.on('pong', alive);
  ws.on('message', alive);

  ws.on('message', (data) => {
    if (!ws._bucket.take()) return; // over budget — drop silently
    // A single malformed or hostile message must never take the process down.
    try { handleMessage(ctx, ws, data.toString()); } catch (_) { /* swallow */ }
  });
  ws.on('close', () => {
    totalConns = Math.max(0, totalConns - 1);
    const ip = ws._ip;
    if (ip) {
      const c = (ipCounts.get(ip) || 1) - 1;
      if (c <= 0) ipCounts.delete(ip); else ipCounts.set(ip, c);
    }
    try { handleClose(ctx, ws); } catch (_) { /* swallow */ }
  });
  ws.on('error', () => { /* the close handler does the cleanup */ });
});

// A port that is taken (or otherwise unusable) is fatal and must be LOUD: exit
// non-zero so `restart: unless-stopped` retries and the reason is in the logs,
// rather than the process lingering with nothing listening.
server.on('error', (err) => {
  console.error(`[secrethitler-server] cannot listen on :${PORT} —`, err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[secrethitler-server] listening on :${PORT} prod=${IS_PROD} origins=${ALLOWED_ORIGINS.join('|')}`);
});

// Idle-room sweep. unref so it never holds the process open by itself.
setInterval(() => {
  try { manager.sweep(); } catch (err) { console.error('[sweep]', err); }
}, 60 * 1000).unref();

// Heartbeat: anything that has not spoken since the last tick is presumed gone and
// terminated, which fires 'close' and releases its seat, room and budget.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { try { ws.terminate(); } catch (_) { /* already gone */ } continue; }
    ws._alive = false;
    try { ws.ping(); } catch (_) { /* already gone */ }
  }
}, HEARTBEAT_MS).unref();

// Last-resort logging for anything the per-call try/catches missed, then DIE.
//
// Logging and continuing is tempting — it would spare the other rooms — but it
// leaves the process in an undefined state, and in this app an undefined state can
// mean a mis-projected broadcast, i.e. a leaked role. That is the one failure we
// refuse. Rooms are in-memory and a restart is already expected to drop games, so
// exiting non-zero and letting `restart: unless-stopped` bring us back clean is
// both safer and far easier to debug than a zombie that half-works.
function die(kind) {
  return (err) => {
    console.error(`[secrethitler-server] fatal ${kind}:`, err);
    process.exit(1);
  };
}
process.on('uncaughtException', die('uncaughtException'));
process.on('unhandledRejection', die('unhandledRejection'));
