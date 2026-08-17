// ============================================================================
// server/session.js — per-connection message dispatch.
//
// Maps wire messages onto engine intents. The intent names are exactly the ones
// the peer-to-peer host already understood, so the browser can keep one dispatch
// function for both transports (script.js send()).
//
// The one structural difference from peer-to-peer play: nobody's browser is the
// host any more. The room CREATOR is the owner — they may start the game, kick
// from the lobby and restart — but they are otherwise just another client, so
// those controls now travel over the wire instead of being local calls.
//
// Per-connection identity lives on the ws object:
//   ws._id        playerId (the engine's seat id)
//   ws._clientId  stable per-device secret sent by the client
//   ws._code      room code this socket is attached to
//
// ---------------------------------------------------------------------------
// WIRE PROTOCOL (server mode)
// ---------------------------------------------------------------------------
// client -> server
//   createRoom     { name, clientId }            create a room and take seat 1
//   join           { code, name, clientId }      take or reclaim a seat
//   start          {}                            (owner)
//   kick           { targetId }                  (owner, lobby only)
//   playAgain      {}                            (owner, game over only)
//   ready          {}                            role reveal acknowledgement
//   nominate       { targetId }                  president
//   vote           { vote: 'ja' | 'nein' }       every living player
//   continueResult {}                            president
//   presDiscard    { index }                      president
//   chanEnact      { index }                      chancellor
//   proposeVeto    {}                            chancellor
//   vetoResponse   { consent }                   president
//   power          { targetId }                  president
//   powerDone      {}                            president
//
// server -> client
//   welcome  { playerId, code, owner }
//   state    { pub, priv }
//   rejected { message, reason? }  fatal for this attempt — bad code, name taken,
//                                  full. reason='no-room' tells the client the
//                                  code may still be a peer-to-peer room.
//   error    { message }   non-fatal — an illegal move, shown as a toast
//   kicked   {}            fatal — the owner removed this player
// ============================================================================

import { randomUUID } from 'node:crypto';

import { PHASES, cleanName } from '../js/engine.js';
import { sync, send } from './rooms.js';

function safeParse(raw) {
  try {
    const m = JSON.parse(raw);
    return (m && typeof m === 'object') ? m : null;
  } catch (_) { return null; }
}

// Normalise a room code the way the client's input filter does.
function normCode(c) {
  return (c == null ? '' : String(c)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

// A clientId is a device secret, not a display string: accept only a bounded
// token so it can neither bloat a broadcast nor smuggle control characters into
// logs. Anything else is treated as absent, which costs the caller its ability
// to reclaim a seat but never corrupts the room.
function cleanClientId(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

export function handleMessage(ctx, ws, raw) {
  const msg = safeParse(raw);
  if (!msg || typeof msg.t !== 'string') return;

  switch (msg.t) {
    case 'createRoom': return onCreateRoom(ctx, ws, msg);
    case 'join': return onJoin(ctx, ws, msg);
    default: break;
  }

  const room = ws._code ? ctx.manager.get(ws._code) : null;
  if (!room) { send(ws, { t: 'error', message: 'Not in a room.' }); return; }
  room.lastActive = Date.now();

  const e = room.engine;
  // The last clause only bites when the creator sent no device secret at all: the
  // seat they owned can be freed on a lobby drop, which would otherwise leave the
  // room with nobody able to start it. The engine moves hostId on a drop, so
  // deferring to it keeps exactly one owner instead of none.
  const isOwner = !!(ws._clientId && ws._clientId === room.ownerClientId)
    || (room.ownerId != null && ws._id === room.ownerId)
    || (room.ownerClientId == null && ws._id === e.hostId);

  // Every branch reports the engine's own refusal reason, so a mistimed tap
  // explains itself instead of failing silently. A refusal changed nothing, so it
  // must not broadcast: otherwise one client's illegal moves cost a full state
  // serialise for every socket in the room, turning garbage into fan-out.
  const relay = (res) => {
    if (res && res.ok === false) {
      if (res.error) send(ws, { t: 'error', message: res.error });
      return;
    }
    sync(room);
  };

  switch (msg.t) {
    // ---- owner controls (local calls in peer-to-peer mode) ------------------
    case 'start':
      if (!isOwner) { send(ws, { t: 'error', message: 'Only the host can start the game.' }); break; }
      relay(e.startGame(ws._id));
      break;
    case 'playAgain':
      if (!isOwner) { send(ws, { t: 'error', message: 'Only the host can restart.' }); break; }
      relay(e.playAgain(ws._id));
      break;
    case 'kick': {
      if (!isOwner) { send(ws, { t: 'error', message: 'Only the host can remove players.' }); break; }
      const res = e.kickPlayer(ws._id, msg.targetId);
      if (!res.ok) { relay(res); break; }
      const victim = room.conns.get(msg.targetId);
      if (victim) {
        send(victim, { t: 'kicked' });
        try { victim.close(); } catch (_) { /* already closing */ }
      }
      // handleClose finds the seat already gone and no-ops.
      room.conns.delete(msg.targetId);
      sync(room);
      break;
    }

    // ---- player intents ----------------------------------------------------
    case 'ready': relay(e.setReady(ws._id)); break;
    case 'nominate': relay(e.nominate(ws._id, msg.targetId)); break;
    case 'vote': relay(e.castVote(ws._id, msg.vote)); break;
    case 'continueResult': relay(e.continueResult(ws._id)); break;
    case 'presDiscard': relay(e.presidentDiscard(ws._id, msg.index)); break;
    case 'chanEnact': relay(e.chancellorEnact(ws._id, msg.index)); break;
    case 'proposeVeto': relay(e.proposeVeto(ws._id)); break;
    case 'vetoResponse': relay(e.vetoResponse(ws._id, !!msg.consent)); break;
    case 'power': relay(e.usePower(ws._id, msg.targetId)); break;
    case 'powerDone': relay(e.powerDone(ws._id)); break;

    default: break;
  }
}

function onCreateRoom(ctx, ws, msg) {
  // One room per connection — stops a single socket walking the room cap up.
  if (ws._code && ctx.manager.get(ws._code)) {
    send(ws, { t: 'rejected', message: 'You already have a room on this connection.' });
    return;
  }
  const name = cleanName(msg.name);
  if (!msg.name || !String(msg.name).trim()) {
    send(ws, { t: 'rejected', message: 'Enter a name first.' });
    return;
  }
  if (ctx.manager.size >= ctx.maxRooms) {
    send(ws, { t: 'rejected', message: 'Server is at capacity — try again shortly.' });
    return;
  }

  const clientId = cleanClientId(msg.clientId);
  const room = ctx.manager.create(name);
  const id = randomUUID();
  const res = room.engine.join({ id, name, clientId, isHost: true });
  if (!res.ok) {
    ctx.manager.delete(room.code);
    send(ws, { t: 'rejected', message: res.error });
    return;
  }

  ws._id = res.playerId;
  ws._clientId = clientId;
  ws._code = room.code;
  room.ownerClientId = clientId;
  room.ownerId = res.playerId;
  room.conns.set(res.playerId, ws);

  send(ws, { t: 'welcome', playerId: res.playerId, code: room.code, owner: true });
  sync(room);
}

function onJoin(ctx, ws, msg) {
  const code = normCode(msg.code);
  const room = ctx.manager.get(code);
  if (!room) {
    // `reason` is what lets the client fall back to peer-to-peer for this code.
    // It must stay a machine-readable flag: matching on the prose would break the
    // fallback the moment someone reworded the message.
    send(ws, { t: 'rejected', reason: 'no-room', message: 'No game found with that code.' });
    return;
  }
  // One seat per connection. Without this a single socket could send `join`
  // repeatedly under different names and fill a room with phantom players.
  if (ws._code) {
    send(ws, {
      t: 'rejected',
      message: ws._code === code
        ? 'You are already in this room.'
        : 'This connection is already in another room.',
    });
    return;
  }

  const name = cleanName(msg.name);
  const clientId = cleanClientId(msg.clientId);
  const e = room.engine;

  // SECURITY: a name is public — it is printed in the lobby and in public state —
  // so it is not a credential. Once roles are dealt, only the device secret may
  // reclaim a seat; a name-only attempt would hand the caller somebody else's
  // secret role. The engine enforces this too (see engine.join); this copy exists
  // so the refusal can explain itself precisely.
  if (e.phase !== PHASES.LOBBY) {
    const bySecret = clientId ? e.players.find((p) => p.clientId === clientId) : null;
    if (!bySecret) {
      const nameHeld = e.players.some(
        (p) => p.name.toLowerCase() === name.toLowerCase() && !p.connected,
      );
      send(ws, {
        t: 'rejected',
        message: nameHeld
          ? 'That player dropped mid-game — rejoin from the same device and browser to reclaim the seat.'
          : 'This game has already started.',
      });
      return;
    }
  }

  const res = e.join({ id: randomUUID(), name, clientId });
  if (!res.ok) { send(ws, { t: 'rejected', message: res.error }); return; }

  // A reclaim keeps the seat's id, so the seat may still hold a stale socket.
  // Adopt the new one FIRST, then retire the old, so the close handler below
  // sees it is no longer current and leaves the live connection alone.
  const stale = room.conns.get(res.playerId);
  ws._id = res.playerId;
  ws._clientId = clientId;
  ws._code = code;
  room.conns.set(res.playerId, ws);
  if (stale && stale !== ws) { try { stale.close(); } catch (_) { /* already closing */ } }

  // Ownership follows the device, so the owner keeps their controls across a drop.
  const owner = !!(clientId && clientId === room.ownerClientId);
  if (owner) {
    room.ownerId = res.playerId;
    e.transferHost(res.playerId);
  }

  send(ws, { t: 'welcome', playerId: res.playerId, code, owner });
  sync(room);
}

export function handleClose(ctx, ws) {
  if (!ws._code || !ws._id) return;
  const room = ctx.manager.get(ws._code);
  if (!room) return;

  // Only a socket that is still the current one for its seat may report a
  // disconnect: a stale handler from a replaced socket must not evict the live one.
  if (room.conns.get(ws._id) !== ws) return;
  room.conns.delete(ws._id);

  // A drop is not a departure. markOffline keeps a mid-game seat (and its role)
  // for reclaim, and frees it only in the lobby where there is nothing to keep.
  room.engine.markOffline(ws._id);
  sync(room);
}
