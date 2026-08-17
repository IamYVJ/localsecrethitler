// ============================================================================
// scripts/test-live.mjs — end-to-end test over REAL WebSockets.
//
// test-server.mjs drives handleMessage() directly with stub sockets, so it never
// touches server/index.js: the origin check, the HTTP upgrade, maxPayload, the
// token bucket and the heartbeat are all invisible to it. This suite starts the
// actual server as a child process and talks to it over the wire, so that glue is
// exercised too — including the one property that matters most, that a public
// broadcast never carries a role.
//
//   node scripts/test-live.mjs        (needs `npm install` first, for `ws`)
//
// It picks its own free port and shuts the server down on the way out, so it can
// run alongside anything else.
// ============================================================================

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WebSocket } from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:5599';

let passed = 0;
const failures = [];
const assert = (cond, label) => { if (cond) passed += 1; else failures.push(label); };
const eq = (a, b, label) => assert(a === b,
  `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

// ---------------------------------------------------------------------------
// A client that remembers everything the server told it.
// ---------------------------------------------------------------------------
class Client {
  constructor(url, label, { origin = ORIGIN } = {}) {
    this.label = label;
    this.msgs = [];
    this.ws = new WebSocket(url, { origin, headers: { Origin: origin } });
    this.ws.on('message', (raw) => { this.msgs.push(JSON.parse(raw.toString())); });
    this.opened = new Promise((res, rej) => {
      this.ws.on('open', () => res(true));
      this.ws.on('error', (e) => rej(e));
      this.ws.on('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }
  last(t) { for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i]; return null; }
  get pub() { const m = this.last('state'); return m && m.pub; }
  get priv() { const m = this.last('state'); return m && m.priv; }
  close() { try { this.ws.close(); } catch (_) { /* already gone */ } }

  /** Wait until `fn(this)` is truthy, so we never race the network. */
  async until(fn, label, timeoutMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (fn(this)) return true;
      await sleep(15);
    }
    failures.push(`timeout: ${label} (${this.label})`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Play a whole game over the wire, mirroring the phase logic of test-server.mjs.
// ---------------------------------------------------------------------------
async function playGame(clients, byId) {
  const host = clients[0];
  const sockOf = (id) => byId.get(id);
  const living = () => host.pub.players.filter((p) => p.alive).map((p) => p.id);

  for (let n = 0; n < 400; n++) {
    const S = host.pub;
    if (!S) { await sleep(20); continue; }
    if (S.phase === 'gameover') return true;
    const pres = sockOf(S.presidentId);
    const before = JSON.stringify([S.phase, S.presidentId, S.chancellorId, S.pendingPower,
      S.liberalPolicies, S.fascistPolicies, S.electionTracker]);

    switch (S.phase) {
      case 'reveal':
        living().forEach((id) => sockOf(id).send({ t: 'ready' }));
        break;
      case 'nomination': {
        await pres.until((c) => c.priv && c.priv.eligibleChancellors, 'president gets nominees');
        pres.send({ t: 'nominate', targetId: pres.priv.eligibleChancellors[0] });
        break;
      }
      case 'election':
        living().forEach((id) => sockOf(id).send({ t: 'vote', vote: 'ja' }));
        break;
      case 'electionResult': pres.send({ t: 'continueResult' }); break;
      case 'legPresident':
        await pres.until((c) => c.priv && c.priv.presCards, 'president draws');
        pres.send({ t: 'presDiscard', index: 0 });
        break;
      case 'legChancellor': {
        const chan = sockOf(S.chancellorId);
        await chan.until((c) => c.priv && c.priv.chanCards, 'chancellor receives');
        chan.send({ t: 'chanEnact', index: 0 });
        break;
      }
      case 'vetoPrompt': pres.send({ t: 'vetoResponse', consent: false }); break;
      case 'executive': {
        if (S.pendingPower === 'peek') { pres.send({ t: 'powerDone' }); break; }
        const target = living().find((id) => id !== S.presidentId
          && !host.pub.players.find((p) => p.id === id).investigated);
        pres.send({ t: 'power', targetId: target });
        await sleep(60);
        if (host.pub.phase === 'executive') pres.send({ t: 'powerDone' });
        break;
      }
      default:
        failures.push(`unknown phase over the wire: ${S.phase}`);
        return false;
    }

    // Wait for the server to actually move before looking again.
    await host.until((c) => JSON.stringify([c.pub.phase, c.pub.presidentId, c.pub.chancellorId,
      c.pub.pendingPower, c.pub.liberalPolicies, c.pub.fascistPolicies,
      c.pub.electionTracker]) !== before, `advance past ${S.phase}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
async function main() {
  const port = await freePort();
  const base = `ws://127.0.0.1:${port}/`;

  const srv = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: ORIGIN, APP_VERSION: 'live-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  const stop = () => { try { srv.kill(); } catch (_) { /* already gone */ } };
  process.on('exit', stop);

  try {
    // -- health -------------------------------------------------------------
    let health = null;
    for (let i = 0; i < 100 && !health; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) health = await r.json();
      } catch (_) { await sleep(50); }
    }
    assert(!!health, 'the server answers /health');
    if (health) {
      eq(health.ok, true, 'health reports ok');
      eq(health.version, 'live-test', 'health carries the build version');
    }

    // -- origin is fail-closed ---------------------------------------------
    const evil = new Client(base, 'evil', { origin: 'https://evil.example' });
    let rejected = false;
    await evil.opened.then(() => { rejected = false; }).catch(() => { rejected = true; });
    assert(rejected, 'a WebSocket from a disallowed origin is refused at the upgrade');
    evil.close();

    // -- seat 5 players over real sockets -----------------------------------
    const N = 5;
    const clients = [];
    const host = new Client(base, 'p0');
    await host.opened;
    host.send({ t: 'createRoom', name: 'p0', clientId: 'device-p0-secret' });
    await host.until((c) => c.last('welcome'), 'owner is welcomed');
    const code = host.last('welcome').code;
    eq(host.last('welcome').owner, true, 'the creator is the owner');
    assert(/^[A-Z0-9]{4}$/.test(code), 'the room code is four uppercase characters');
    clients.push(host);

    for (let i = 1; i < N; i++) {
      const c = new Client(base, `p${i}`);
      await c.opened;
      c.send({ t: 'join', code, name: `p${i}`, clientId: `device-p${i}-secret` });
      await c.until((x) => x.last('welcome'), `p${i} is welcomed`);
      eq(c.last('welcome').owner, false, `p${i} is not the owner`);
      clients.push(c);
    }
    await host.until((c) => c.pub && c.pub.lobbyPlayers && c.pub.lobbyPlayers.length === N,
      'all five appear in the lobby');

    // -- an unknown code tells the client it may still be a peer-to-peer room
    const stray = new Client(base, 'stray');
    await stray.opened;
    stray.send({ t: 'join', code: 'ZZZZ', name: 'nobody', clientId: 'device-stray-secret' });
    await stray.until((c) => c.last('rejected'), 'the stray join is rejected');
    eq(stray.last('rejected').reason, 'no-room',
      'an unknown code is flagged machine-readably, so the client can fall back to peer-to-peer');
    stray.close();

    // -- only the owner may start ------------------------------------------
    clients[1].send({ t: 'start' });
    await clients[1].until((c) => c.last('error'), 'a non-owner start is refused');
    assert(/only the host/i.test(clients[1].last('error').message), 'and says why');
    eq(host.pub.phase, 'lobby', 'the refused start changed nothing');

    host.send({ t: 'start' });
    await host.until((c) => c.pub.phase === 'reveal', 'the owner starts the game');

    const byId = new Map(clients.map((c) => [c.last('welcome').playerId, c]));

    // -- THE property: a public broadcast never carries a role --------------
    for (const c of clients) {
      const raw = JSON.stringify(c.pub);
      assert(!/"role"/.test(raw), `no role field in the public state ${c.label} received`);
      assert(!/"party"/.test(raw), `no party field in the public state ${c.label} received`);
      assert(!/hitler/i.test(raw), `the word hitler never appears in public state (${c.label})`);
      assert(!/"clientId"/.test(raw), `no device secret in public state (${c.label})`);
    }
    const roles = clients.map((c) => c.priv.role);
    eq(roles.filter((r) => r === 'hitler').length, 1, 'exactly one Hitler was dealt');
    eq(roles.filter((r) => r === 'fascist').length, 1, 'one plain fascist at five players');
    eq(roles.filter((r) => r === 'liberal').length, 3, 'three liberals at five players');

    // Every client's private slice is its own and nobody else's.
    for (const c of clients) {
      eq(c.priv.id, c.last('welcome').playerId, `${c.label} receives its own private slice`);
    }

    // -- mid-game seat reclaim needs the DEVICE, not the name ---------------
    const victim = clients[3];
    const victimId = victim.last('welcome').playerId;
    const victimRole = victim.priv.role;
    const victimName = host.pub.players.find((p) => p.id === victimId).name;
    victim.close();
    await host.until((c) => !c.pub.players.find((p) => p.id === victimId).connected,
      'the room notices the drop');

    const thief = new Client(base, 'thief');
    await thief.opened;
    thief.send({ t: 'join', code, name: victimName, clientId: 'attacker-device-secret' });
    await thief.until((c) => c.last('rejected'), 'the impostor is rejected');
    assert(/same device and browser/i.test(thief.last('rejected').message),
      'and specifically because the seat is device-held — not merely because the name is taken');
    assert(!thief.last('welcome'), 'the impostor was never seated');
    assert(!thief.last('state'), 'and never received any state at all');
    thief.close();

    // The rightful device gets the same seat and the same secret role back.
    const returning = new Client(base, 'p3-again');
    await returning.opened;
    returning.send({ t: 'join', code, name: victimName, clientId: 'device-p3-secret' });
    await returning.until((c) => c.last('welcome'), 'the real player reconnects');
    eq(returning.last('welcome').playerId, victimId, 'they get the same seat back');
    await returning.until((c) => c.priv && c.priv.role, 'their role is restored');
    eq(returning.priv.role, victimRole, 'and it is the same role they were dealt');
    byId.set(victimId, returning);
    clients[3] = returning;

    // -- play it out --------------------------------------------------------
    const finished = await playGame(clients, byId);
    assert(finished, 'a five-player game plays to completion over real sockets');
    if (finished) {
      eq(host.pub.revealRoles.length, N, 'every role is revealed at game over');
      assert(host.pub.winner === 'liberal' || host.pub.winner === 'fascist', 'a side won');
    }

    // -- the owner can restart ---------------------------------------------
    host.send({ t: 'playAgain' });
    await host.until((c) => c.pub.phase === 'lobby', 'the owner restarts');
    eq(host.pub.lobbyPlayers.length, N, 'everyone is kept for the next game');

    clients.forEach((c) => c.close());
    await sleep(120);
    assert(!srvLog.join('').includes('fatal'), 'the server logged no fatal error');
  } finally {
    stop();
  }

  if (failures.length) {
    console.log(`live: ${passed} passed, ${failures.length} FAILED`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`live: ${passed} checks passed`);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
