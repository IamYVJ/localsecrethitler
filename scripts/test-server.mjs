// ============================================================================
// scripts/test-server.mjs — exercises the server's session layer over stub
// sockets. No `ws`, no listening port, no network: handleMessage/handleClose are
// the entire public surface, so driving them directly tests the real protocol
// while staying runnable anywhere.
//
//   node scripts/test-server.mjs
//
// The security regressions here are the point of the file. The seat-reclaim and
// state-projection checks encode the two ways a hidden-role game leaks: letting
// someone take a seat they don't own, and putting secrets in public state.
// ============================================================================

import { handleMessage, handleClose } from '../server/session.js';
import { RoomManager } from '../server/rooms.js';
import { TokenBucket } from '../server/ratelimit.js';
import { PHASES } from '../js/engine.js';

let passed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed += 1; return; }
  failures.push(label);
}
function eq(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function newCtx(maxRooms = 50) {
  const manager = new RoomManager({ maxRooms });
  return { manager, maxRooms };
}

/** A socket that records what the server sent it, shaped like the `ws` API. */
function stub(name = '?') {
  return {
    name,
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close() { this.readyState = 3; },
    // Most recent message of a type, or null.
    last(t) {
      for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].t === t) return this.sent[i];
      return null;
    },
    count(t) { return this.sent.filter((m) => m.t === t).length; },
  };
}

function wire(ctx, ws, msg) { handleMessage(ctx, ws, JSON.stringify(msg)); }

/** Seat `n` players (owner first) and return the sockets plus the room. */
function seatRoom(ctx, n) {
  const socks = [];
  const owner = stub('p0');
  wire(ctx, owner, { t: 'createRoom', name: 'p0', clientId: 'cid-0000-0' });
  socks.push(owner);
  const code = owner.last('welcome').code;
  for (let i = 1; i < n; i++) {
    const s = stub(`p${i}`);
    wire(ctx, s, { t: 'join', code, name: `p${i}`, clientId: `cid-0000-${i}` });
    socks.push(s);
  }
  const room = ctx.manager.get(code);
  const byId = new Map();
  socks.forEach((s) => byId.set(s.last('welcome').playerId, s));
  return { socks, code, room, byId };
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const owner = stub();
  wire(ctx, owner, { t: 'createRoom', name: '  Ana  ', clientId: 'cid-ana-000001' });
  const w = owner.last('welcome');
  assert(!!w, 'createRoom answers with a welcome');
  eq(w.owner, true, 'the creator is the owner');
  eq(typeof w.code, 'string', 'welcome carries a room code');
  eq(w.code.length, 4, 'the code is four characters');
  assert(/^[A-HJ-NP-Z2-9]{4}$/.test(w.code), 'the code avoids look-alike glyphs');
  eq(ctx.manager.size, 1, 'the room is registered');

  const st = owner.last('state');
  assert(!!st, 'the creator immediately receives state');
  eq(st.pub.phase, PHASES.LOBBY, 'a new room starts in the lobby');
  eq(st.priv.name, 'Ana', 'the name is trimmed');
  eq(st.pub.hostId, w.playerId, 'the creator holds the host seat');

  // One room per connection, so a single socket cannot walk the room cap up.
  wire(ctx, owner, { t: 'createRoom', name: 'Ana', clientId: 'cid-ana-000001' });
  assert(!!owner.last('rejected'), 'a second createRoom on the same socket is refused');
  eq(ctx.manager.size, 1, 'the refused createRoom left no room behind');
}

{
  const ctx = newCtx(1);
  const a = stub();
  wire(ctx, a, { t: 'createRoom', name: 'a', clientId: 'cid-aaaa-0001' });
  const b = stub();
  wire(ctx, b, { t: 'createRoom', name: 'b', clientId: 'cid-bbbb-0001' });
  assert(/capacity/i.test(b.last('rejected').message), 'the room cap is enforced');
  eq(ctx.manager.size, 1, 'a room over the cap is not created');
}

{
  const ctx = newCtx();
  const a = stub();
  wire(ctx, a, { t: 'createRoom', name: '   ', clientId: 'cid-aaaa-0001' });
  assert(!!a.last('rejected'), 'a blank name cannot create a room');
  eq(ctx.manager.size, 0, 'no room is left behind by a blank name');
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, code } = seatRoom(ctx, 5);
  eq(socks[0].last('state').pub.lobbyPlayers.length, 5, 'five players are seated');

  const dupe = stub();
  wire(ctx, dupe, { t: 'join', code, name: 'P2', clientId: 'cid-other-0001' });
  assert(/already taken/i.test(dupe.last('rejected').message), 'a name in use by a live player is refused');

  const bogus = stub();
  wire(ctx, bogus, { t: 'join', code: 'ZZZZ', name: 'x', clientId: 'cid-xxxx-0001' });
  eq(bogus.last('rejected').reason, 'no-room',
    'an unknown code is refused with the machine-readable reason the client falls back on');

  // One seat per connection: without this a single socket could fill the room.
  const second = stub();
  wire(ctx, second, { t: 'join', code, name: 'n1', clientId: 'cid-nnnn-0001' });
  wire(ctx, second, { t: 'join', code, name: 'n2', clientId: 'cid-nnnn-0002' });
  assert(/already in this room/i.test(second.last('rejected').message), 'a socket cannot take a second seat');
  eq(ctx.manager.get(code).engine.players.length, 6, 'the phantom seat was never created');

  // Codes are normalised the way the client's input filter normalises them.
  const lower = stub();
  wire(ctx, lower, { t: 'join', code: ` ${code.toLowerCase()} `, name: 'lc', clientId: 'cid-llll-0001' });
  assert(!!lower.last('welcome'), 'a lowercase, padded code still resolves');
}

{
  const ctx = newCtx();
  const { socks, code, room } = seatRoom(ctx, 10);
  eq(room.engine.players.length, 10, 'ten players fit');
  const late = stub();
  wire(ctx, late, { t: 'join', code, name: 'late', clientId: 'cid-late-0001' });
  assert(/full/i.test(late.last('rejected').message), 'the eleventh player is refused');
  assert(socks.length === 10, 'the seated players are unaffected');
}

// ---------------------------------------------------------------------------
// Owner controls
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);

  wire(ctx, socks[1], { t: 'start' });
  assert(/only the host/i.test(socks[1].last('error').message), 'a non-owner cannot start the game');
  eq(room.engine.phase, PHASES.LOBBY, 'the refused start did not begin the game');

  wire(ctx, socks[1], { t: 'kick', targetId: socks[0].last('welcome').playerId });
  assert(/only the host/i.test(socks[1].last('error').message), 'a non-owner cannot kick');
  eq(room.engine.players.length, 5, 'the refused kick removed nobody');

  const victimId = socks[4].last('welcome').playerId;
  wire(ctx, socks[0], { t: 'kick', targetId: victimId });
  assert(!!socks[4].last('kicked'), 'the kicked player is told');
  eq(room.engine.players.length, 4, 'the kicked seat is gone');
  // A kicked socket's later close must not disturb the room it already left.
  handleClose(ctx, socks[4]);
  eq(room.engine.players.length, 4, 'a kicked socket closing changes nothing');

  const back = stub();
  wire(ctx, back, { t: 'join', code: room.code, name: 'p4', clientId: 'cid-0000-4' });
  assert(!!back.last('welcome'), 'a kicked player may rejoin the lobby');
  eq(room.engine.players.length, 5, 'the rejoined seat is back');
}

// ---------------------------------------------------------------------------
// Start + state projection
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, room, byId } = seatRoom(ctx, 7);
  wire(ctx, socks[0], { t: 'start' });
  eq(room.engine.phase, PHASES.REVEAL, 'the owner starts the game');

  const pub = socks[0].last('state').pub;
  const pubJson = JSON.stringify(pub);
  assert(!/hitler/i.test(pubJson), 'public state never mentions Hitler before game over');
  assert(!pub.players.some((p) => 'role' in p || 'party' in p), 'public players carry no role or party');
  assert(!('drawPile' in pub) && !('discardPile' in pub), 'public state carries no deck contents');
  eq(typeof pub.drawCount, 'number', 'public state carries deck COUNTS instead');

  // Every device gets exactly one role, and the distribution is the real one.
  const roles = [...byId.values()].map((s) => s.last('state').priv.role);
  eq(roles.filter((r) => r === 'hitler').length, 1, 'exactly one Hitler is dealt');
  eq(roles.filter((r) => r === 'fascist').length, 2, 'seven players get two fascists');
  eq(roles.filter((r) => r === 'liberal').length, 4, 'seven players get four liberals');

  // Each socket's private slice is its own and nobody else's.
  let ownSlice = true;
  for (const [id, s] of byId) if (s.last('state').priv.id !== id) ownSlice = false;
  assert(ownSlice, 'each socket receives only its own private slice');

  // Fascists know each other; Hitler is in the dark at seven players.
  const hitler = [...byId.values()].find((s) => s.last('state').priv.role === 'hitler');
  assert(!hitler.last('state').priv.knownAllies, 'Hitler learns nothing in a seven-player game');
  const fascist = [...byId.values()].find((s) => s.last('state').priv.role === 'fascist');
  eq(fascist.last('state').priv.knownAllies.length, 2, 'a fascist sees the other fascist and Hitler');
}

// ---------------------------------------------------------------------------
// SECURITY: mid-game seat reclaim
//
// A name is public — it is printed in the lobby and in public state — so a name
// can never be the credential that hands back a secret role.
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, code, room, byId } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });

  const victim = socks[3];
  const victimId = victim.last('welcome').playerId;
  const victimRole = victim.last('state').priv.role;
  handleClose(ctx, victim);
  eq(room.engine.byId(victimId).connected, false, 'a dropped player is marked offline');
  assert(!!room.engine.byId(victimId), 'a mid-game drop KEEPS the seat for reclaim');

  const thief = stub('thief');
  wire(ctx, thief, { t: 'join', code, name: 'p3', clientId: 'cid-thief-0001' });
  // The precise wording matters: it proves the refusal came from the seat-reclaim
  // check and not incidentally from "name already taken" or "game has started".
  assert(/same device and browser/i.test(thief.last('rejected').message),
    'the name alone cannot reclaim a mid-game seat');
  assert(!thief.last('state'), 'the thief never receives any state');
  assert(!thief.last('welcome'), 'the thief is never seated');

  const noSecret = stub('nosecret');
  wire(ctx, noSecret, { t: 'join', code, name: 'p3' });
  assert(!!noSecret.last('rejected'), 'omitting the clientId entirely also fails');

  const shortSecret = stub('short');
  wire(ctx, shortSecret, { t: 'join', code, name: 'p3', clientId: 'abc' });
  assert(!!shortSecret.last('rejected'), 'a malformed clientId is treated as absent, not trusted');

  const stranger = stub('stranger');
  wire(ctx, stranger, { t: 'join', code, name: 'nobody', clientId: 'cid-strange-01' });
  assert(/already started/i.test(stranger.last('rejected').message), 'a brand-new player cannot join mid-game');

  eq(room.engine.players.length, 5, 'none of the refused attempts added a seat');

  // The rightful device gets its seat, its id and its role back.
  const rejoin = stub('rejoin');
  wire(ctx, rejoin, { t: 'join', code, name: 'p3', clientId: 'cid-0000-3' });
  eq(rejoin.last('welcome').playerId, victimId, 'the device secret reclaims the SAME seat id');
  eq(rejoin.last('state').priv.role, victimRole, 'the reclaimed seat keeps its role');
  eq(room.engine.byId(victimId).connected, true, 'the reclaimed seat is online again');
  eq(room.engine.players.length, 5, 'a reclaim does not add a seat');
  eq(byId.size, 5, 'the seat count is unchanged');

  // A rename between sessions is fine — the secret, not the label, is the key.
  const renamed = stub('renamed');
  wire(ctx, renamed, { t: 'join', code, name: 'p3-new-name', clientId: 'cid-0000-3' });
  eq(renamed.last('welcome').playerId, victimId, 'the same device reclaims after a rename');
  eq(room.engine.byId(victimId).name, 'p3-new-name', 'the new name is adopted');
}

// A replaced socket's close event must not evict the live connection.
{
  const ctx = newCtx();
  const { socks, code, room } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });
  const id = socks[2].last('welcome').playerId;

  const fresh = stub('fresh');
  wire(ctx, fresh, { t: 'join', code, name: 'p2', clientId: 'cid-0000-2' });
  eq(fresh.last('welcome').playerId, id, 'the new socket adopts the seat');
  handleClose(ctx, socks[2]);   // the stale socket finally notices it is gone
  eq(room.engine.byId(id).connected, true, 'the stale close left the live socket alone');
  eq(room.conns.get(id), fresh, 'the seat still points at the live socket');
}

// Ownership follows the device, so the host keeps their controls across a drop.
{
  const ctx = newCtx();
  const { socks, code, room } = seatRoom(ctx, 5);
  const ownerId = socks[0].last('welcome').playerId;
  handleClose(ctx, socks[0]);

  const back = stub('owner-back');
  wire(ctx, back, { t: 'join', code, name: 'p0', clientId: 'cid-0000-0' });
  eq(back.last('welcome').owner, true, 'the owner is recognised on reconnect');
  eq(back.last('state').pub.hostId, back.last('welcome').playerId, 'the host seat follows the owner');
  wire(ctx, back, { t: 'start' });
  eq(room.engine.phase, PHASES.REVEAL, 'the reconnected owner can still start the game');
  assert(ownerId != null, 'the owner had a seat to begin with');
}

// A lobby drop frees the seat; a mid-game drop does not.
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  handleClose(ctx, socks[4]);
  eq(room.engine.players.length, 4, 'a lobby drop frees the seat — nothing to preserve');
}

// ---------------------------------------------------------------------------
// Hostile and malformed input
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });
  const before = JSON.stringify(room.engine.state);

  handleMessage(ctx, socks[1], 'not json at all');
  handleMessage(ctx, socks[1], 'null');
  handleMessage(ctx, socks[1], '[]');
  handleMessage(ctx, socks[1], '{"t":42}');
  handleMessage(ctx, socks[1], '{"noType":true}');
  wire(ctx, socks[1], { t: 'nonexistentIntent' });
  wire(ctx, socks[1], { t: 'nominate', targetId: null });
  wire(ctx, socks[1], { t: 'vote', vote: 'maybe' });
  wire(ctx, socks[1], { t: 'presDiscard', index: null });
  wire(ctx, socks[1], { t: 'chanEnact', index: '0' });
  wire(ctx, socks[1], { t: 'power', targetId: { evil: true } });
  eq(JSON.stringify(room.engine.state), before, 'no malformed message mutated the game');

  // A socket with no room gets told so rather than crashing the handler.
  const loose = stub('loose');
  wire(ctx, loose, { t: 'ready' });
  assert(/not in a room/i.test(loose.last('error').message), 'an unattached socket is handled cleanly');
}

// Out-of-turn intents are refused with a reason, never silently.
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });
  const notPres = socks.find((s) => !s.last('state').priv.isPresident);
  wire(ctx, notPres, { t: 'nominate', targetId: socks[1].last('welcome').playerId });
  assert(!!notPres.last('error'), 'acting out of turn is answered with a reason');
  eq(room.engine.phase, PHASES.REVEAL, 'the out-of-turn nomination did not advance the phase');
}

// ---------------------------------------------------------------------------
// A full game, played entirely over the wire
// ---------------------------------------------------------------------------
function drive(ctx, room, byId, { maxSteps = 500 } = {}) {
  const e = room.engine;
  const sockOf = (id) => byId.get(id);
  const living = () => e.state.seatOrder.filter((id) => e.byId(id).alive);

  for (let n = 0; n < maxSteps; n++) {
    const S = e.publicState();
    if (S.phase === PHASES.GAMEOVER) return true;
    const pres = sockOf(S.presidentId);

    switch (S.phase) {
      case PHASES.REVEAL:
        living().forEach((id) => wire(ctx, sockOf(id), { t: 'ready' }));
        break;
      case PHASES.NOMINATION: {
        const priv = pres.last('state').priv;
        wire(ctx, pres, { t: 'nominate', targetId: priv.eligibleChancellors[0] });
        break;
      }
      case PHASES.ELECTION:
        living().forEach((id) => wire(ctx, sockOf(id), { t: 'vote', vote: 'ja' }));
        break;
      case PHASES.ELECTION_RESULT:
        wire(ctx, pres, { t: 'continueResult' });
        break;
      case PHASES.LEG_PRESIDENT:
        wire(ctx, pres, { t: 'presDiscard', index: 0 });
        break;
      case PHASES.LEG_CHANCELLOR:
        wire(ctx, sockOf(S.chancellorId), { t: 'chanEnact', index: 0 });
        break;
      case PHASES.VETO_PROMPT:
        wire(ctx, pres, { t: 'vetoResponse', consent: false });
        break;
      case PHASES.EXECUTIVE: {
        if (S.pendingPower === 'peek') { wire(ctx, pres, { t: 'powerDone' }); break; }
        const target = living().find((id) => id !== S.presidentId
          && !(S.pendingPower === 'investigate' && e.byId(id).investigated));
        wire(ctx, pres, { t: 'power', targetId: target });
        if (e.phase === PHASES.EXECUTIVE) wire(ctx, pres, { t: 'powerDone' });
        break;
      }
      default:
        return false;
    }
  }
  return false;
}

{
  const ctx = newCtx();
  const { socks, room, byId } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });
  assert(drive(ctx, room, byId), 'a five-player game plays to completion over the wire');

  const pub = socks[0].last('state').pub;
  assert(pub.winner === 'liberal' || pub.winner === 'fascist', 'the game ends with a winner');
  assert(!!pub.winReason, 'the winner comes with a stated reason');
  eq(pub.revealRoles.length, 5, 'every role is revealed at game over');
  assert(pub.log.length > 0, 'the event log carries the story of the game');
  assert(pub.log.every((l) => typeof l.t === 'number'),
    'log entries carry epoch millis, so each client formats its own local time');

  // Restart is an owner control, and it returns everyone to the lobby.
  wire(ctx, socks[1], { t: 'playAgain' });
  assert(/only the host/i.test(socks[1].last('error').message), 'a non-owner cannot restart');
  eq(room.engine.phase, PHASES.GAMEOVER, 'the refused restart changed nothing');

  wire(ctx, socks[0], { t: 'playAgain' });
  eq(room.engine.phase, PHASES.LOBBY, 'the owner restarts back to the lobby');
  eq(room.engine.players.length, 5, 'everyone is kept for the next game');
  assert(room.engine.players.every((p) => p.role === null), 'roles are cleared for the next game');
  const relobby = socks[0].last('state').pub;
  assert(!relobby.revealRoles, 'the previous game\'s roles are gone from public state');
}

// Larger table, and the powers that only appear at higher counts.
for (const n of [6, 7, 8, 9, 10]) {
  const ctx = newCtx();
  const { socks, room, byId } = seatRoom(ctx, n);
  wire(ctx, socks[0], { t: 'start' });
  assert(drive(ctx, room, byId), `a ${n}-player game plays to completion over the wire`);
  const pub = socks[0].last('state').pub;
  eq(pub.revealRoles.length, n, `all ${n} roles are revealed at game over`);
}

// ---------------------------------------------------------------------------
// Room sweep + rate limiter
// ---------------------------------------------------------------------------
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  eq(room.hasOpenConns(), true, 'a room with live sockets is held');
  ctx.manager.sweep();
  eq(ctx.manager.size, 1, 'a live room survives the sweep');

  socks.forEach((s) => s.close());
  ctx.manager.sweep();
  eq(ctx.manager.size, 1, 'an idle room is kept until its TTL expires');
  room.lastActive = 0;
  ctx.manager.sweep();
  eq(ctx.manager.size, 0, 'an abandoned room past its TTL is collected');
}

// A lobby that never starts must not squat a room slot just by holding a socket
// open — otherwise a few connections could take every slot on the server.
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  room.createdAt = 0;
  room.lastActive = Date.now(); // still "active": chatter must not extend the squat
  eq(room.hasOpenConns(), true, 'the squatter keeps its sockets open');
  ctx.manager.sweep();
  eq(ctx.manager.size, 0, 'a long-lived lobby is collected despite open sockets');
  assert(socks.every((s) => s.readyState === 3),
    'its sockets are dropped, releasing the connection budget with the slot');
}

// The same sweep must never evict a real game that has simply run a long time.
{
  const ctx = newCtx();
  const { socks, room } = seatRoom(ctx, 5);
  wire(ctx, socks[0], { t: 'start' });
  assert(room.engine.phase !== PHASES.LOBBY, 'the game has started');
  room.createdAt = 0;
  ctx.manager.sweep();
  eq(ctx.manager.size, 1, 'a started game is never swept for age alone');
  assert(socks.every((s) => s.readyState === 1), 'its players stay connected');
}

{
  let clock = 1000;
  const bucket = new TokenBucket(3, 2, () => clock);
  eq(bucket.take(), true, 'the bucket starts full');
  eq(bucket.take(), true, 'a burst is allowed');
  eq(bucket.take(), true, 'up to the bucket size');
  eq(bucket.take(), false, 'a flood beyond the burst is dropped');
  clock += 500;
  eq(bucket.take(), true, 'tokens refill over time');
  eq(bucket.take(), false, 'but only at the sustained rate');
  clock += 60000;
  eq(bucket.take(), true, 'a long idle period refills the bucket');
  eq(bucket.take(), true, 'up to capacity');
  eq(bucket.take(), true, 'exactly capacity');
  eq(bucket.take(), false, 'and never more than capacity');
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`server: ${passed} passed, ${failures.length} FAILED`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`server: ${passed} checks passed`);
