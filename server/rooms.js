// ============================================================================
// server/rooms.js — in-memory room registry + the authoritative broadcast loop.
//
// Each Room owns ONE GameEngine — the very same module the browser runs
// (../js/engine.js), so server games and peer-to-peer games cannot drift apart.
// The server validates every intent through the engine and then pushes tailored
// state to each socket.
//
// Secret Hitler needs no server-side timers: every beat of the round is an
// explicit intent by a named player (ready, continueResult, powerDone), so there
// is nothing to auto-advance. That is why there is no scheduleAdvances() here.
//
// Rooms are in-memory only. A restart drops every game in progress and codes are
// reused once a room is collected — deliberate for this size of deployment.
// ============================================================================

import { randomInt } from 'node:crypto';

import { GameEngine, PHASES, MAX_PLAYERS } from '../js/engine.js';

// Same alphabet as the browser's randCode4 (no O/I/0/1) so a code looks
// identical whichever transport produced it.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// A room with no open sockets is collected after this idle window.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 30 * 60 * 1000;

// A room that never left the lobby is collected this long after it was CREATED,
// even while sockets are still open. Without it, holding a socket open keeps
// hasOpenConns() true forever, so a handful of connections could squat every room
// slot on the server and lock real players out. Measured from creation, not from
// last activity, so chatter on the socket cannot extend the squat indefinitely.
const LOBBY_TTL_MS = Number(process.env.LOBBY_TTL_MS) || 60 * 60 * 1000;

const WS_OPEN = 1; // ws readyState for an open socket

export function send(ws, msg) {
  try {
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  } catch (_) { /* socket already gone */ }
}

export class Room {
  constructor(code, ownerName) {
    this.code = code;
    this.ownerName = ownerName;
    this.ownerClientId = null; // stable device id of the owner (survives reconnect)
    this.ownerId = null;       // current playerId of the owner
    this.engine = new GameEngine();
    this.conns = new Map();    // playerId -> ws
    this.createdAt = Date.now();
    this.lastActive = this.createdAt;
  }

  hasOpenConns() {
    for (const ws of this.conns.values()) if (ws.readyState === WS_OPEN) return true;
    return false;
  }

  // Drop every socket attached to a collected room, so the connection budget is
  // released with the room slot rather than being held by a room that is gone.
  closeAll() {
    for (const ws of this.conns.values()) {
      try { ws.close(); } catch (_) { /* already closing */ }
    }
    this.conns.clear();
  }
}

export class RoomManager {
  constructor({ maxRooms = 50 } = {}) {
    this.rooms = new Map(); // CODE -> Room
    this.maxRooms = maxRooms;
  }

  get size() { return this.rooms.size; }

  get(code) {
    if (code == null) return null;
    return this.rooms.get(String(code).toUpperCase()) || null;
  }

  create(ownerName) {
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = new Room(code, ownerName);
    this.rooms.set(code, room);
    return room;
  }

  delete(code) {
    const room = this.get(code);
    if (room) this.rooms.delete(room.code);
  }

  // Collect rooms whose sockets have all gone and that have been idle past the
  // TTL, plus lobbies that were created long ago and never started a game.
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const idle = !room.hasOpenConns() && (now - room.lastActive) > ROOM_TTL_MS;
      const squatted = room.engine.phase === PHASES.LOBBY
        && (now - room.createdAt) > LOBBY_TTL_MS;
      if (!idle && !squatted) continue;
      this.rooms.delete(room.code);
      room.closeAll();
    }
  }
}

function genCode() {
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return out;
}

/**
 * Give every socket the public state plus ONLY its own private slice. This split
 * is the whole reason hidden roles stay hidden in server mode: publicState()
 * contains no role, party, hand, peek or investigation, and privateStateFor(id)
 * is sent down exactly one socket.
 */
export function broadcastState(room) {
  const e = room.engine;
  const pub = e.publicState();
  for (const [playerId, ws] of room.conns) {
    if (ws.readyState !== WS_OPEN) continue;
    send(ws, { t: 'state', pub, priv: e.privateStateFor(playerId) });
  }
}

/** The server's analogue of the browser host's broadcast(). */
export function sync(room) {
  room.lastActive = Date.now();
  broadcastState(room);
}

export function roomIsJoinable(room) {
  const e = room.engine;
  return e.phase === PHASES.LOBBY && e.players.length < MAX_PLAYERS;
}
