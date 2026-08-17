// ============================================================================
// js/net.js — transport layer. Everything that is not rendering lives here.
//
// Two transports, one interface. `send()` takes the same message on either, so
// script.js never branches on how the game is being hosted:
//
//   p2p    one player's browser runs the engine and fans out state over WebRTC.
//          This is the original mode and the fallback — it needs no server.
//   server the engine runs on a shared machine; every browser, INCLUDING the
//          room's owner, is a plain client. Owner controls travel over the wire.
//
// The dual-transport rule: server mode is purely additive. Joining tries the
// server first and falls back to peer-to-peer for the same code exactly once, so
// a server outage never makes a peer-to-peer room unjoinable — and a code that
// only exists on the server is still reachable when the probe was pessimistic.
//
// script.js calls bind() once with its render/toast hooks; this module never
// touches the DOM.
// ============================================================================

import { GameEngine, PHASES, cleanName } from './engine.js';
import { SERVER_URL, SERVER_HEALTH, serverConfigured } from './config.js';

export const APP_VERSION = 2;

const CLIENT_ID_KEY = 'localsecrethitler.clientId';
const SESSION_KEY = 'localsecrethitler.session';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_ATTEMPTS = 3;
const HEALTH_BACKOFF_MS = 300;

const RECONNECT_MAX_TRIES = 6;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 20000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/I/0/1
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const HEALTH_TRIES = HEALTH_ATTEMPTS;
export const RECONNECT_TRIES = RECONNECT_MAX_TRIES;

// ---------------------------------------------------------------------------
// Shared app state. script.js reads this to render; it never writes to it.
// ---------------------------------------------------------------------------
export const app = {
  mode: null,             // 'p2p' | 'server'
  role: null,             // 'host' | 'client'  (always 'client' in server mode)
  intent: null,           // 'create' | 'join'
  code: null,
  name: '',
  meId: null,
  isOwner: false,

  pub: null,              // last public projection
  priv: null,             // last private projection (this device only)

  serverAvailable: false,
  serverProbe: 'idle',    // 'idle' | 'checking' | 'up' | 'down'
  serverProbeTry: 0,

  netStatus: 'ok',        // 'ok' | 'reconnecting' | 'lost'
  netTry: 0,

  kicked: false,
  triedP2PFallback: false,
};

let hooks = { render: () => {}, toast: () => {}, home: () => {} };

export function bind(h) { hooks = { ...hooks, ...h }; }

// ---------------------------------------------------------------------------
// Device identity
//
// A clientId is a per-device SECRET. It is what lets a player reclaim their seat
// — and its secret role — after a drop. Names are printed in the lobby, so a name
// can never serve this purpose. Memoised so a browser with storage blocked
// (private-mode Safari throws) still keeps one stable id for the page's lifetime.
// ---------------------------------------------------------------------------
let _clientId = null;

export function clientId() {
  if (_clientId) return _clientId;
  let v = null;
  try { v = localStorage.getItem(CLIENT_ID_KEY); } catch (_) { /* storage blocked */ }
  if (!v || !CLIENT_ID_RE.test(v)) {
    v = (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`)
      .replace(/[^A-Za-z0-9_-]/g, '');
    try { localStorage.setItem(CLIENT_ID_KEY, v); } catch (_) { /* storage blocked */ }
  }
  _clientId = v;
  return v;
}

// Host-side validation of what a peer claims. Mirrors server/session.js so both
// transports accept exactly the same shape.
function cleanClientId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return CLIENT_ID_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Session persistence
//
// sessionStorage, not localStorage: an accidental reload should put you back in
// the game, but closing the tab should not drag you into a stale room on your
// next visit.
// ---------------------------------------------------------------------------
function saveSession() {
  if (!app.code || !app.mode) return;
  const s = {
    v: APP_VERSION, at: Date.now(),
    mode: app.mode, role: app.role, intent: app.intent,
    code: app.code, name: app.name, meId: app.meId, isOwner: app.isOwner,
  };
  if (app.mode === 'p2p' && app.role === 'host' && engine) s.snapshot = engine.serialize();
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (_) { /* storage blocked */ }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* storage blocked */ }
}

function readSession() {
  let raw = null;
  try { raw = sessionStorage.getItem(SESSION_KEY); } catch (_) { return null; }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s || s.v !== APP_VERSION || !s.code) return null;
    if (Date.now() - (s.at || 0) > SESSION_TTL_MS) return null;
    return s;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Health probe
//
// Retried, because one timeout on a phone waking up its radio is not an outage.
// The result only decides whether "Host on server" is offered — it must never
// gate JOINING, which always tries the server and falls back on its own.
// ---------------------------------------------------------------------------
let _probing = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function pingHealth() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  return fetch(SERVER_HEALTH, { signal: ctl.signal, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => !!(j && j.ok))
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

export async function probeServer() {
  if (!serverConfigured() || _probing) return;
  _probing = true;
  app.serverProbe = 'checking';
  app.serverProbeTry = 0;
  hooks.render();

  for (let i = 1; i <= HEALTH_ATTEMPTS; i++) {
    app.serverProbeTry = i;
    hooks.render();
    if (await pingHealth()) {
      app.serverAvailable = true;
      app.serverProbe = 'up';
      _probing = false;
      hooks.render();
      return;
    }
    if (i < HEALTH_ATTEMPTS) await sleep(HEALTH_BACKOFF_MS * i);
  }
  // A failed probe redraws too — otherwise the pill sits on "checking" forever.
  app.serverAvailable = false;
  app.serverProbe = 'down';
  _probing = false;
  hooks.render();
}

// ---------------------------------------------------------------------------
// Peer-to-peer host state
// ---------------------------------------------------------------------------
let engine = null;                  // only ever non-null for a p2p host
let peer = null;                    // PeerJS instance (host or client)
const conns = new Map();            // connId -> DataConnection
const seatByConn = new Map();       // connId -> playerId
const connBySeat = new Map();       // playerId -> connId

let link = null;                    // active client link (p2p client or server)
let reconnectTimer = null;
let reconnectTries = 0;

function randCode4() {
  const out = new Uint32Array(4);
  crypto.getRandomValues(out);
  return Array.from(out, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}

function newPeer(idOrNull) {
  return new Promise((resolve, reject) => {
    try { if (peer) peer.destroy(); } catch (_) { /* already gone */ }
    peer = idOrNull ? new window.Peer(idOrNull) : new window.Peer();
    let settled = false;
    peer.on('open', (id) => { settled = true; resolve(id); });
    peer.on('error', (err) => {
      if (!settled) { settled = true; reject(err); return; }
      onPeerError(err);
    });
  });
}

function onPeerError(err) {
  // A host losing one guest is routine; a client losing the host is not. The
  // link guard matters: PeerJS reports the same failure twice (conn error, then
  // peer error), and by the second one we may already have torn everything down.
  if (!link || app.role !== 'client') return;
  if (!err || err.type !== 'peer-unavailable') return;
  if (link.openedOnce) scheduleReconnect();
  else if (!fallbackToP2P()) fatal('No game found with that code.');
}

// ---------------------------------------------------------------------------
// Unified send
// ---------------------------------------------------------------------------
export function send(msg) {
  if (app.mode === 'p2p' && app.role === 'host') { hostApply(app.meId, msg); return; }
  if (link && link.isOpen()) { link.send(msg); return; }
  hooks.toast('Not connected — trying to reconnect…');
}

// ---------------------------------------------------------------------------
// Peer-to-peer host: authoritative engine in this browser
// ---------------------------------------------------------------------------
function hostBroadcast() {
  if (!engine) return;
  const pub = engine.publicState();
  app.pub = pub;
  app.priv = engine.privateStateFor(app.meId);
  saveSession();
  hooks.render();
  for (const [seatId, connId] of connBySeat) {
    const c = conns.get(connId);
    if (c && c.open) {
      try { c.send({ t: 'state', pub, priv: engine.privateStateFor(seatId) }); } catch (_) { /* dropping */ }
    }
  }
}

function toastTo(id, message) {
  if (id === app.meId) { hooks.toast(message); return; }
  const connId = connBySeat.get(id);
  const c = connId ? conns.get(connId) : null;
  if (c && c.open) { try { c.send({ t: 'error', message }); } catch (_) { /* dropping */ } }
}

// Maps a wire intent onto the engine. Deliberately the same switch as
// server/session.js: the authority checks live in the engine, so both transports
// enforce identical rules and neither can drift.
function hostApply(fromId, msg) {
  const e = engine;
  if (!e || !msg || typeof msg.t !== 'string') return;
  const relay = (res) => {
    if (res && res.ok === false && res.error) toastTo(fromId, res.error);
    hostBroadcast();
  };

  switch (msg.t) {
    case 'start': relay(e.startGame(fromId)); break;
    case 'playAgain': relay(e.playAgain(fromId)); break;
    case 'kick': {
      const res = e.kickPlayer(fromId, msg.targetId);
      if (!res.ok) { relay(res); break; }
      const connId = connBySeat.get(msg.targetId);
      const victim = connId ? conns.get(connId) : null;
      if (victim) {
        try { victim.send({ t: 'kicked' }); } catch (_) { /* dropping */ }
        // Let the message flush before tearing the connection down.
        setTimeout(() => { try { victim.close(); } catch (_) { /* already closing */ } }, 200);
      }
      if (connId) { conns.delete(connId); seatByConn.delete(connId); }
      connBySeat.delete(msg.targetId);
      hostBroadcast();
      break;
    }

    case 'ready': relay(e.setReady(fromId)); break;
    case 'nominate': relay(e.nominate(fromId, msg.targetId)); break;
    case 'vote': relay(e.castVote(fromId, msg.vote)); break;
    case 'continueResult': relay(e.continueResult(fromId)); break;
    case 'presDiscard': relay(e.presidentDiscard(fromId, msg.index)); break;
    case 'chanEnact': relay(e.chancellorEnact(fromId, msg.index)); break;
    case 'proposeVeto': relay(e.proposeVeto(fromId)); break;
    case 'vetoResponse': relay(e.vetoResponse(fromId, !!msg.consent)); break;
    case 'power': relay(e.usePower(fromId, msg.targetId)); break;
    case 'powerDone': relay(e.powerDone(fromId)); break;
    default: break;
  }
}

function onHostConnection(conn) {
  conn.on('open', () => { conns.set(conn.peer, conn); });
  conn.on('data', (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (msg.t === 'join') { hostOnJoin(conn, msg); return; }
    const seatId = seatByConn.get(conn.peer);
    if (!seatId) return;   // not seated — nothing to act on
    hostApply(seatId, msg);
  });
  conn.on('close', () => hostOnConnLost(conn.peer));
  conn.on('error', () => hostOnConnLost(conn.peer));
}

function hostOnJoin(conn, msg) {
  const e = engine;
  if (!e) return;
  const reject = (message) => { try { conn.send({ t: 'rejected', message }); } catch (_) { /* dropping */ } };

  // One seat per connection, so one socket cannot fill the room with phantoms.
  if (seatByConn.has(conn.peer)) { reject('You are already in this room.'); return; }

  const name = cleanName(msg.name);
  const cid = cleanClientId(msg.clientId);

  // SECURITY: mirrors server/session.js. A name is public, so once roles are
  // dealt only the device secret may reclaim a seat — otherwise typing somebody
  // else's name would hand over their secret role.
  if (e.phase !== PHASES.LOBBY) {
    const bySecret = cid ? e.players.find((p) => p.clientId === cid) : null;
    if (!bySecret) {
      const nameHeld = e.players.some((p) => p.name.toLowerCase() === name.toLowerCase() && !p.connected);
      reject(nameHeld
        ? 'That player dropped mid-game — rejoin from the same device and browser to reclaim the seat.'
        : 'This game has already started.');
      return;
    }
  }

  const res = e.join({ id: conn.peer, name, clientId: cid });
  if (!res.ok) { reject(res.error); return; }

  // A reclaim keeps the seat id, so the seat may still hold a stale connection.
  // Retire it, and drop it from both maps first so its own close handler sees it
  // is no longer current and leaves the live connection alone.
  const staleId = connBySeat.get(res.playerId);
  if (staleId && staleId !== conn.peer) {
    const stale = conns.get(staleId);
    conns.delete(staleId);
    seatByConn.delete(staleId);
    if (stale) { try { stale.close(); } catch (_) { /* already closing */ } }
  }

  conns.set(conn.peer, conn);
  seatByConn.set(conn.peer, res.playerId);
  connBySeat.set(res.playerId, conn.peer);

  try { conn.send({ t: 'welcome', playerId: res.playerId, code: app.code, owner: false }); } catch (_) { /* dropping */ }
  hostBroadcast();
}

function hostOnConnLost(connId) {
  conns.delete(connId);
  const seatId = seatByConn.get(connId);
  if (!seatId) return;                          // stale handler — already replaced
  seatByConn.delete(connId);
  if (connBySeat.get(seatId) !== connId) return;
  connBySeat.delete(seatId);
  if (engine) { engine.markOffline(seatId); hostBroadcast(); }
}

// ---------------------------------------------------------------------------
// Client links. Both expose the same shape so one reconnect loop drives both.
// ---------------------------------------------------------------------------
function announce() {
  // On a fresh socket the server knows nothing about us, so even the owner
  // re-announces with `join` — ownership is recovered from the clientId.
  if (app.intent === 'create' && !app.code) {
    return { t: 'createRoom', name: app.name, clientId: clientId() };
  }
  return { t: 'join', code: app.code, name: app.name, clientId: clientId() };
}

function serverLink() {
  let sock = null;
  const self = {
    kind: 'server',
    openedOnce: false,
    isOpen: () => !!sock && sock.readyState === WebSocket.OPEN,
    send: (msg) => { try { sock.send(JSON.stringify(msg)); } catch (_) { /* dropping */ } },
    destroy() { const s = sock; sock = null; if (s) { s.onclose = null; try { s.close(); } catch (_) {} } },
    reconnect() { self.destroy(); self.open(); },
    open() {
      try { sock = new WebSocket(SERVER_URL); } catch (_) { onLinkDown(self); return; }
      sock.onopen = () => {
        self.openedOnce = true;
        onLinkUp();
        self.send(announce());
      };
      sock.onmessage = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && typeof msg.t === 'string') onLinkMessage(msg);
      };
      sock.onclose = () => { if (sock) onLinkDown(self); };
      sock.onerror = () => { /* onclose always follows */ };
    },
  };
  return self;
}

function p2pClientLink() {
  let conn = null;
  const self = {
    kind: 'p2p',
    openedOnce: false,
    isOpen: () => !!conn && conn.open,
    send: (msg) => { try { conn.send(msg); } catch (_) { /* dropping */ } },
    destroy() { const c = conn; conn = null; if (c) { try { c.close(); } catch (_) {} } },
    reconnect() { self.destroy(); self.open(); },
    async open() {
      if (!peer || peer.destroyed) {
        try { await newPeer(null); } catch (_) { onLinkDown(self); return; }
      }
      conn = peer.connect(app.code, {
        reliable: true, serialization: 'json', metadata: { v: APP_VERSION },
      });
      conn.on('open', () => { self.openedOnce = true; onLinkUp(); self.send(announce()); });
      conn.on('data', (msg) => {
        if (msg && typeof msg === 'object' && typeof msg.t === 'string') onLinkMessage(msg);
      });
      conn.on('close', () => { if (conn) onLinkDown(self); });
      conn.on('error', () => { if (conn) onLinkDown(self); });
    },
  };
  return self;
}

function onLinkUp() {
  reconnectTries = 0;
  app.netStatus = 'ok';
  app.netTry = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  hooks.render();
}

function onLinkDown(which) {
  if (which !== link) return;              // a retired link reporting in
  // Never opened + still joining: the transport itself is the suspect, so try
  // the other one for the same code before burning retries on this one.
  if (!which.openedOnce) {
    if (fallbackToP2P()) return;
    if (app.intent === 'create') {
      app.serverAvailable = false;
      app.serverProbe = 'down';
      fatal('Could not reach the server. Host on this phone instead.');
      return;
    }
    if (app.mode === 'p2p') { fatal('No game found with that code.'); return; }
  }
  scheduleReconnect();
}

function onLinkMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      app.meId = msg.playerId;
      app.code = msg.code;
      app.isOwner = !!msg.owner;
      saveSession();
      hooks.render();
      break;
    case 'state':
      app.pub = msg.pub;
      app.priv = msg.priv;
      saveSession();
      hooks.render();
      break;
    case 'error':
      hooks.toast(String(msg.message || 'That move was not allowed.'));
      break;
    case 'rejected':
      // A code the server has never heard of may still be a peer-to-peer room.
      if (msg.reason === 'no-room' && fallbackToP2P()) break;
      fatal(String(msg.message || 'Could not join that room.'));
      break;
    case 'kicked':
      app.kicked = true;
      fatal('The host removed you. Tap Join to rejoin.', { keepCode: true });
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Reconnect loop
//
// Bounded and jittered, and it gives up honestly rather than spinning forever —
// a banner that lies about progress is worse than one that admits defeat.
// ---------------------------------------------------------------------------
function scheduleReconnect() {
  if (!link || app.kicked || reconnectTimer) return;
  if (reconnectTries >= RECONNECT_MAX_TRIES) {
    app.netStatus = 'lost';
    hooks.render();
    return;
  }
  reconnectTries += 1;
  app.netStatus = 'reconnecting';
  app.netTry = reconnectTries;
  hooks.render();

  const base = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectTries - 1), RECONNECT_MAX_MS);
  const delay = Math.round(base * (0.8 + Math.random() * 0.4));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (link) link.reconnect();
  }, delay);
}

/** Retry now instead of waiting out the backoff — the network just changed. */
export function retryNow() {
  if (!link || app.kicked) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectTries = 0;
  link.reconnect();
}

function wake() {
  if (!link || app.kicked) return;
  if (app.netStatus === 'reconnecting' || app.netStatus === 'lost') retryNow();
}

window.addEventListener('online', wake);
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

// ---------------------------------------------------------------------------
// Transport switching
// ---------------------------------------------------------------------------
function destroyLink() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (link) { try { link.destroy(); } catch (_) { /* already gone */ } }
  link = null;
}

/**
 * One-shot, one-directional: server -> peer-to-peer, only while joining. Without
 * this a peer-to-peer room becomes unjoinable whenever the server happens to be
 * up, because the server would answer first and simply not know the code.
 */
function fallbackToP2P() {
  if (app.triedP2PFallback) return false;
  if (app.mode !== 'server' || app.intent !== 'join' || !app.code) return false;
  app.triedP2PFallback = true;
  destroyLink();
  app.mode = 'p2p';
  reconnectTries = 0;
  app.netStatus = 'ok';
  hooks.render();
  link = p2pClientLink();
  link.open();
  return true;
}

function fatal(message, opts = {}) {
  const code = app.code;
  reset();
  hooks.toast(message);
  hooks.home(opts.keepCode ? code : null);
}

/** Tear everything down and return to a clean slate. */
export function reset() {
  destroyLink();
  for (const c of conns.values()) { try { c.close(); } catch (_) { /* already closing */ } }
  conns.clear(); seatByConn.clear(); connBySeat.clear();
  try { if (peer) peer.destroy(); } catch (_) { /* already gone */ }
  peer = null;
  engine = null;
  reconnectTries = 0;
  clearSession();

  app.mode = null; app.role = null; app.intent = null;
  app.code = null; app.meId = null; app.isOwner = false;
  app.pub = null; app.priv = null;
  app.netStatus = 'ok'; app.netTry = 0;
  app.triedP2PFallback = false;
  hooks.render();
}

export function leaveRoom() {
  app.kicked = false;
  reset();
  hooks.home(null);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
/** Host in this browser over WebRTC. Needs no server at all. */
export async function createLocal(name) {
  reset();
  app.mode = 'p2p'; app.role = 'host'; app.intent = 'create'; app.name = name;
  app.kicked = false;

  let code = null;
  for (let attempt = 0; attempt < 14 && !code; attempt++) {
    const candidate = randCode4();
    try { await newPeer(candidate); code = candidate; } catch (_) { /* id taken */ }
  }
  if (!code) { reset(); hooks.toast('Could not create a room. Try again.'); return false; }

  app.code = code;
  engine = new GameEngine();
  const res = engine.join({ id: code, name, clientId: clientId(), isHost: true });
  if (!res.ok) { reset(); hooks.toast(res.error); return false; }
  app.meId = res.playerId;
  app.isOwner = true;

  peer.on('connection', onHostConnection);
  hostBroadcast();
  return true;
}

/** Host on the shared server. Every browser here is a client, owner included. */
export function createOnServer(name) {
  reset();
  app.mode = 'server'; app.role = 'client'; app.intent = 'create'; app.name = name;
  app.kicked = false;
  link = serverLink();
  link.open();
  return true;
}

/**
 * Join a code. Tries the server first whenever one is configured and has not
 * been proven down — the probe gates HOSTING, never joining.
 */
export async function joinRoom(name, code) {
  reset();
  app.name = name; app.code = code; app.intent = 'join'; app.role = 'client';
  app.kicked = false;

  if (serverConfigured() && app.serverProbe !== 'down') {
    app.mode = 'server';
    app.triedP2PFallback = false;
    link = serverLink();
    link.open();
    return true;
  }
  app.mode = 'p2p';
  app.triedP2PFallback = true;
  link = p2pClientLink();
  await link.open();
  return true;
}

/**
 * Restore a room after a reload. Called synchronously at boot, BEFORE the health
 * probe can resolve — otherwise a slow probe would decide the transport for a
 * room that already exists on the other one.
 */
export function tryResume() {
  const s = readSession();
  if (!s) return false;

  app.mode = s.mode; app.role = s.role; app.intent = s.intent;
  app.code = s.code; app.name = s.name; app.meId = s.meId; app.isOwner = !!s.isOwner;
  app.kicked = false;
  app.triedP2PFallback = true;    // a resume must not silently switch transport

  if (s.mode === 'p2p' && s.role === 'host') {
    if (!s.snapshot) { clearSession(); return false; }
    engine = GameEngine.deserialize(s.snapshot);
    // Every guest's connection died with the old page. Show them as offline and
    // let their own reconnect loops bring them back.
    engine.state.players.forEach((p) => { if (p.id !== app.meId) p.connected = false; });
    newPeer(s.code)
      .then(() => { peer.on('connection', onHostConnection); hostBroadcast(); })
      .catch(() => { hooks.toast('Could not reclaim the room code.'); reset(); hooks.home(s.code); });
    hostBroadcast();
    return true;
  }

  link = s.mode === 'server' ? serverLink() : p2pClientLink();
  link.open();
  return true;
}
