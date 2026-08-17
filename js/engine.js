// ============================================================================
// engine.js — the pure Secret Hitler rules engine. NO DOM, NO network.
//
// This is the single source of truth for the rules, imported by BOTH transports:
//   - the browser peer-to-peer host (script.js), where one player's phone is the
//     authority, and
//   - the authoritative Node server (server/rooms.js), where nobody's phone is.
//
// Everything here is deterministic given (state, rng). The engine never talks to
// a socket and never renders: intent methods return { ok, error? } and the caller
// decides who to tell. Callers broadcast after a successful intent.
//
// STATE PROJECTION — the security-critical part.
//   publicState()      what EVERY device may see.
//   privateStateFor(id) what exactly ONE device may see (its role, its hand, its
//                      peek, its investigation result).
// Hidden information must only ever leave via privateStateFor. Roles enter the
// public projection at exactly one moment: game over.
// ============================================================================

export const PHASES = {
  LOBBY: 'lobby',
  REVEAL: 'reveal',
  NOMINATION: 'nomination',
  ELECTION: 'election',
  ELECTION_RESULT: 'electionResult',
  LEG_PRESIDENT: 'legPresident',
  LEG_CHANCELLOR: 'legChancellor',
  VETO_PROMPT: 'vetoPrompt',
  EXECUTIVE: 'executive',
  GAMEOVER: 'gameover',
};

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;
export const NAME_MAX = 14;

// [liberals, fascists (excluding Hitler)]; Hitler is always exactly 1.
export const ROLE_DIST = {
  5: [3, 1], 6: [4, 1], 7: [4, 2],
  8: [5, 2], 9: [5, 3], 10: [6, 3],
};

// Power granted as the Nth fascist policy (1..5) is enacted, by player count.
export const POWER_TRACK = {
  5:  [null, null, 'peek', 'execution', 'execution'],
  6:  [null, null, 'peek', 'execution', 'execution'],
  7:  [null, 'investigate', 'special', 'execution', 'execution'],
  8:  [null, 'investigate', 'special', 'execution', 'execution'],
  9:  ['investigate', 'investigate', 'special', 'execution', 'execution'],
  10: ['investigate', 'investigate', 'special', 'execution', 'execution'],
};

export const POWER_LABEL = {
  investigate: 'Investigate Loyalty',
  special: 'Special Election',
  peek: 'Policy Peek',
  execution: 'Execution',
};

const LIBERAL_TARGET = 5;   // liberal policies to win
const FASCIST_TARGET = 6;   // fascist policies to win
const VETO_UNLOCK_AT = 5;   // fascist policies before veto is available
const HITLER_CHANCELLOR_AT = 3; // fascist policies before electing Hitler wins
const TRACKER_MAX = 3;      // failed elections before chaos
const LOG_MAX = 60;

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

// Card indices arrive as untrusted JSON. Number() would silently coerce null,
// '', false and [] to 0 — a hostile client could discard a card it never chose
// by sending nothing at all. Accept only a real integer or its digit string.
function cardIndex(value, length) {
  let i = -1;
  if (typeof value === 'number' && Number.isInteger(value)) i = value;
  else if (typeof value === 'string' && /^\d+$/.test(value)) i = Number(value);
  return i >= 0 && i < length ? i : -1;
}

function freshState() {
  return {
    phase: PHASES.LOBBY,
    players: [],          // join order; seat order is `seatOrder`
    seatOrder: [],         // player ids, shuffled and fixed at game start
    numPlayers: 0,
    hostId: null,

    rotationSeat: 0,       // seat index of the regular-rotation president
    firstRound: false,     // first round uses the seeded president (no advance)
    presidentId: null,
    chancellorId: null,
    presidentIsSpecial: false,
    nomineeId: null,
    specialElectionTargetId: null,

    lastElectedPresidentId: null,
    lastElectedChancellorId: null,

    votes: {},             // playerId -> 'ja' | 'nein'
    lastVotes: null,       // snapshot revealed during electionResult
    lastOutcome: null,     // 'pass' | 'fail'

    liberalPolicies: 0,
    fascistPolicies: 0,
    electionTracker: 0,
    vetoUnlocked: false,
    vetoUsedThisGov: false,

    drawPile: [],
    discardPile: [],
    presidentDraw: [],     // 3 cards — president's eyes only
    chancellorCards: [],   // 2 cards — chancellor's eyes only
    vetoProposed: false,

    pendingPower: null,
    peekCards: null,       // top 3 — president's eyes only
    investigation: null,   // { byId, name, party } — president's eyes only

    winner: null,
    winReason: '',
    log: [],
  };
}

function newPlayer({ id, name, clientId, isHost }) {
  return {
    id,
    name,
    clientId: clientId || null,
    isHost: !!isHost,
    connected: true,
    alive: true,
    role: null,
    party: null,
    investigated: false,
    knownAllies: null,
    ready: false,
  };
}

export class GameEngine {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.now = opts.now || (() => Date.now());
    this.state = freshState();
  }

  // --- convenience accessors used by both transports ------------------------
  get phase() { return this.state.phase; }
  get players() { return this.state.players; }
  get hostId() { return this.state.hostId; }

  byId(id) { return this.state.players.find((p) => p.id === id) || null; }

  get started() { return this.state.phase !== PHASES.LOBBY; }

  // -------------------------------------------------------------------------
  // Seating
  // -------------------------------------------------------------------------
  /**
   * Seat a player, or let one reclaim the seat they already hold.
   *
   * SECURITY (the highest-severity item in the platform playbook's Part D):
   * names are PUBLIC — they show in the lobby and in public state — so a name is
   * not a credential. A seat carries a secret role, therefore:
   *   - a matching secret `clientId` reclaims its seat in ANY phase;
   *   - a matching NAME reclaims a seat only while still in the lobby, where no
   *     roles have been dealt and there is nothing to steal;
   *   - mid-game, anything else is refused outright.
   * This lives in the engine so BOTH transports inherit it — the server layer
   * re-checks it as well so it can report a precise reason.
   *
   * Returns { ok, error?, playerId?, reclaimed? }. The engine keeps a seat's id
   * STABLE across reconnects: the caller re-points its socket at the same
   * playerId rather than the engine rewriting every id it appears under.
   */
  join({ id, name, clientId, isHost = false }) {
    const S = this.state;
    const clean = cleanName(name);

    if (clientId) {
      const seat = S.players.find((p) => p.clientId && p.clientId === clientId);
      if (seat) {
        seat.connected = true;
        seat.name = clean;             // allow a rename between sessions
        return { ok: true, playerId: seat.id, reclaimed: true };
      }
    }

    if (S.phase === PHASES.LOBBY) {
      const lname = clean.toLowerCase();
      const byName = S.players.find((p) => !p.connected && p.name.toLowerCase() === lname);
      if (byName) {
        // A lobby drop frees the seat outright, so a disconnected seat can only
        // exist here after playAgain kept last game's players. Those seats may
        // already carry a device secret, and a name is public — letting a
        // name-only claim overwrite it would hand the seat to whoever guessed the
        // name AND lock the rightful owner out for good.
        if (byName.clientId && byName.clientId !== clientId) {
          return fail('That seat belongs to another device — rejoin from the same device and browser.');
        }
        byName.connected = true;
        if (clientId) byName.clientId = clientId; // adopt the device from now on
        return { ok: true, playerId: byName.id, reclaimed: true };
      }
      if (S.players.some((p) => p.connected && p.name.toLowerCase() === lname)) {
        return fail('That name is already taken in this room.');
      }
      if (S.players.length >= MAX_PLAYERS) {
        return fail('This room is full.');
      }
      const p = newPlayer({ id, name: clean, clientId, isHost: isHost || S.players.length === 0 });
      S.players.push(p);
      if (p.isHost || !S.hostId) S.hostId = p.id;
      return { ok: true, playerId: p.id, reclaimed: false };
    }

    return fail('This game has already started.');
  }

  markOffline(id) {
    const p = this.byId(id);
    if (!p) return fail('No such player.');
    p.connected = false;
    // A drop is NOT a departure: mid-game the seat (and its role) is kept so the
    // player can reclaim it. In the lobby there is nothing to preserve, so the
    // seat is freed for someone else.
    if (this.state.phase === PHASES.LOBBY) this.removeSeat(id);
    return ok();
  }

  removeSeat(id) {
    const S = this.state;
    const i = S.players.findIndex((p) => p.id === id);
    if (i === -1) return;
    const wasHost = S.players[i].isHost;
    S.players.splice(i, 1);
    if (wasHost || S.hostId === id) {
      S.hostId = S.players.length ? S.players[0].id : null;
      S.players.forEach((p, idx) => { p.isHost = idx === 0; });
    }
  }

  transferHost(id) {
    const p = this.byId(id);
    if (!p) return fail('No such player.');
    this.state.players.forEach((q) => { q.isHost = q.id === id; });
    this.state.hostId = id;
    return ok();
  }

  kickPlayer(actorId, targetId) {
    const S = this.state;
    if (actorId !== S.hostId) return fail('Only the host can remove players.');
    if (S.phase !== PHASES.LOBBY) return fail('Players can only be removed in the lobby.');
    const t = this.byId(targetId);
    if (!t) return fail('No such player.');
    if (t.isHost) return fail('The host cannot be removed.');
    this.removeSeat(targetId);
    return ok();
  }

  // -------------------------------------------------------------------------
  // Start / role assignment
  // -------------------------------------------------------------------------
  startGame(actorId) {
    const S = this.state;
    if (actorId !== S.hostId) return fail('Only the host can start the game.');
    if (S.phase !== PHASES.LOBBY) return fail('The game has already started.');
    const n = S.players.length;
    if (n < MIN_PLAYERS) return fail(`Need ${MIN_PLAYERS}–${MAX_PLAYERS} players to start.`);
    if (n > MAX_PLAYERS) return fail(`Need ${MIN_PLAYERS}–${MAX_PLAYERS} players to start.`);

    S.numPlayers = n;
    S.seatOrder = this.shuffle(S.players.map((p) => p.id));

    const [libs, fas] = ROLE_DIST[n];
    let roles = [];
    for (let i = 0; i < libs; i++) roles.push('liberal');
    for (let i = 0; i < fas; i++) roles.push('fascist');
    roles.push('hitler');
    roles = this.shuffle(roles);

    S.seatOrder.forEach((id, i) => {
      const p = this.byId(id);
      p.role = roles[i];
      p.party = roles[i] === 'liberal' ? 'Liberal' : 'Fascist';
      p.alive = true;
      p.investigated = false;
      p.ready = false;
      p.knownAllies = null;
    });

    // Fascists know each other and know Hitler. Hitler learns the lone fascist
    // only in 5–6 player games; in 7–10 Hitler is in the dark.
    const fascistIds = S.seatOrder.filter((id) => this.byId(id).role === 'fascist');
    const hitlerId = S.seatOrder.find((id) => this.byId(id).role === 'hitler');

    S.seatOrder.forEach((id) => {
      const p = this.byId(id);
      if (p.role === 'fascist') {
        p.knownAllies = fascistIds
          .filter((fid) => fid !== id)
          .map((fid) => ({ name: this.byId(fid).name, label: 'Fascist' }));
        p.knownAllies.push({ name: this.byId(hitlerId).name, label: 'Hitler' });
      } else if (p.role === 'hitler' && n <= 6) {
        p.knownAllies = fascistIds.map((fid) => ({ name: this.byId(fid).name, label: 'Fascist' }));
      } else {
        p.knownAllies = null;
      }
    });

    // Policy deck: 6 Liberal + 11 Fascist.
    const deck = [];
    for (let i = 0; i < 6; i++) deck.push('L');
    for (let i = 0; i < 11; i++) deck.push('F');
    S.drawPile = this.shuffle(deck);
    S.discardPile = [];

    S.rotationSeat = Math.floor(this.rng() * S.seatOrder.length);
    S.presidentId = S.seatOrder[S.rotationSeat];
    S.presidentIsSpecial = false;
    S.firstRound = true;

    S.phase = PHASES.REVEAL;
    this.log('Game started. Roles dealt. Memorise your secret role.');
    return ok();
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------
  setReady(actorId) {
    const S = this.state;
    if (S.phase !== PHASES.REVEAL) return fail('Not in the reveal phase.');
    const me = this.byId(actorId);
    if (!me) return fail('No such player.');
    me.ready = true;
    if (this.livingIds().every((id) => this.byId(id).ready)) this.beginNextRound();
    return ok();
  }

  nominate(actorId, targetId) {
    const S = this.state;
    if (S.phase !== PHASES.NOMINATION) return fail('Not in the nomination phase.');
    if (actorId !== S.presidentId) return fail('Only the President can nominate.');
    if (!this.isEligibleChancellor(targetId)) return fail("That player isn't eligible.");
    S.nomineeId = targetId;
    S.votes = {};
    S.phase = PHASES.ELECTION;
    this.log(`${this.nameOf(S.presidentId)} nominates ${this.nameOf(targetId)} for Chancellor.`);
    return ok();
  }

  castVote(actorId, vote) {
    const S = this.state;
    if (S.phase !== PHASES.ELECTION) return fail('No election is running.');
    const me = this.byId(actorId);
    if (!me) return fail('No such player.');
    if (!me.alive) return fail('Dead players do not vote.');
    if (vote !== 'ja' && vote !== 'nein') return fail('Invalid vote.');
    S.votes[actorId] = vote;
    const living = this.livingIds();
    if (living.every((id) => S.votes[id])) this.resolveElection();
    return ok();
  }

  continueResult(actorId) {
    const S = this.state;
    if (S.phase !== PHASES.ELECTION_RESULT) return fail('No result to continue from.');
    if (actorId !== S.presidentId) return fail('Only the President can continue.');
    this.applyElectionOutcome();
    return ok();
  }

  presidentDiscard(actorId, index) {
    const S = this.state;
    if (S.phase !== PHASES.LEG_PRESIDENT) return fail('Not the presidential legislative step.');
    if (actorId !== S.presidentId) return fail('Only the President can discard.');
    const i = cardIndex(index, S.presidentDraw.length);
    if (i < 0) return fail('Invalid card.');
    const remaining = S.presidentDraw.slice();
    S.discardPile.push(remaining.splice(i, 1)[0]);
    S.chancellorCards = remaining;
    S.presidentDraw = [];
    S.phase = PHASES.LEG_CHANCELLOR;
    this.log(`${this.nameOf(S.presidentId)} passed two policies to ${this.nameOf(S.chancellorId)}.`);
    return ok();
  }

  chancellorEnact(actorId, index) {
    const S = this.state;
    if (S.phase !== PHASES.LEG_CHANCELLOR) return fail('Not the chancellor legislative step.');
    if (actorId !== S.chancellorId) return fail('Only the Chancellor can enact.');
    const i = cardIndex(index, S.chancellorCards.length);
    if (i < 0) return fail('Invalid card.');
    const remaining = S.chancellorCards.slice();
    const enacted = remaining.splice(i, 1)[0];
    S.discardPile.push(remaining[0]);
    S.chancellorCards = [];
    this.enactPolicy(enacted, false);
    return ok();
  }

  proposeVeto(actorId) {
    const S = this.state;
    if (S.phase !== PHASES.LEG_CHANCELLOR) return fail('Nothing to veto right now.');
    if (actorId !== S.chancellorId) return fail('Only the Chancellor can propose a veto.');
    if (!S.vetoUnlocked) return fail('Veto is not unlocked yet.');
    if (S.vetoUsedThisGov) return fail('This government has already used its veto.');
    S.vetoProposed = true;
    S.phase = PHASES.VETO_PROMPT;
    this.log(`${this.nameOf(S.chancellorId)} proposes a VETO.`);
    return ok();
  }

  vetoResponse(actorId, consent) {
    const S = this.state;
    if (S.phase !== PHASES.VETO_PROMPT) return fail('No veto is pending.');
    if (actorId !== S.presidentId) return fail('Only the President can answer a veto.');
    S.vetoProposed = false;
    S.vetoUsedThisGov = true;
    if (consent) {
      S.discardPile.push(...S.chancellorCards);
      S.chancellorCards = [];
      this.log(`${this.nameOf(S.presidentId)} agrees to the veto. Both policies discarded.`);
      const chaos = this.advanceTrackerForFailure();
      if (!chaos && S.phase !== PHASES.GAMEOVER) this.beginNextRound();
    } else {
      S.phase = PHASES.LEG_CHANCELLOR;
      this.log(`${this.nameOf(S.presidentId)} rejects the veto. The Chancellor must enact.`);
    }
    return ok();
  }

  usePower(actorId, targetId) {
    const S = this.state;
    if (S.phase !== PHASES.EXECUTIVE) return fail('No presidential power is pending.');
    if (actorId !== S.presidentId) return fail('Only the President can use this power.');
    const power = S.pendingPower;
    const target = this.byId(targetId);
    if (!target || !target.alive || targetId === S.presidentId) return fail('Invalid target.');

    if (power === 'investigate') {
      // This power alone survives its own use — it waits for powerDone so the
      // president can read the result. Without this guard they could spend it
      // again on a fresh target and read every party off one power.
      if (S.investigation) return fail('You have already investigated this turn.');
      if (target.investigated) return fail('That player has already been investigated.');
      target.investigated = true;
      S.investigation = { byId: S.presidentId, name: target.name, party: target.party };
      this.log(`${this.nameOf(S.presidentId)} investigated ${target.name}.`);
      return ok(); // waits for powerDone
    }

    if (power === 'special') {
      S.specialElectionTargetId = targetId;
      S.pendingPower = null;
      this.log(`${this.nameOf(S.presidentId)} calls a Special Election: ${target.name} will be next President.`);
      this.beginNextRound();
      return ok();
    }

    if (power === 'execution') {
      target.alive = false;
      this.log(`${this.nameOf(S.presidentId)} executed ${target.name}.`);
      if (target.role === 'hitler') {
        this.endGame('liberal', 'Hitler was executed.');
        return ok();
      }
      S.pendingPower = null;
      this.beginNextRound();
      return ok();
    }

    return fail('That power takes no target.');
  }

  powerDone(actorId) {
    const S = this.state;
    if (S.phase !== PHASES.EXECUTIVE) return fail('No presidential power is pending.');
    if (actorId !== S.presidentId) return fail('Only the President can do that.');
    if (S.pendingPower !== 'peek' && S.pendingPower !== 'investigate') {
      return fail('That power still needs a target.');
    }
    if (S.pendingPower === 'investigate' && !S.investigation) {
      return fail('Choose a player to investigate first.');
    }
    S.pendingPower = null;
    S.peekCards = null;
    S.investigation = null;
    this.beginNextRound();
    return ok();
  }

  playAgain(actorId) {
    const S = this.state;
    if (S.phase !== PHASES.GAMEOVER) return fail('The game is still running.');
    if (actorId !== S.hostId) return fail('Only the host can start a new game.');
    this.resetForNewGame();
    return ok();
  }

  // -------------------------------------------------------------------------
  // Round lifecycle
  // -------------------------------------------------------------------------
  beginNextRound() {
    const S = this.state;
    S.chancellorId = null;
    S.nomineeId = null;
    S.votes = {};
    S.lastVotes = null;
    S.lastOutcome = null;
    S.presidentDraw = [];
    S.chancellorCards = [];
    S.vetoProposed = false;
    S.vetoUsedThisGov = false;
    S.pendingPower = null;
    S.peekCards = null;
    S.investigation = null;

    if (S.firstRound) {
      S.firstRound = false;
      S.presidentIsSpecial = false;
    } else if (S.specialElectionTargetId) {
      S.presidentId = S.specialElectionTargetId;
      S.specialElectionTargetId = null;
      S.presidentIsSpecial = true;
    } else {
      S.rotationSeat = this.nextLivingSeatAfter(S.rotationSeat);
      S.presidentId = S.seatOrder[S.rotationSeat];
      S.presidentIsSpecial = false;
    }
    S.phase = PHASES.NOMINATION;
    this.log(`${this.nameOf(S.presidentId)} is President. Nominate a Chancellor.`);
  }

  resolveElection() {
    const S = this.state;
    const living = this.livingIds();
    let ja = 0, nein = 0;
    living.forEach((id) => { S.votes[id] === 'ja' ? ja++ : nein++; });
    S.lastVotes = {};
    living.forEach((id) => { S.lastVotes[id] = S.votes[id]; });
    S.lastOutcome = ja > nein ? 'pass' : 'fail'; // strict majority; a tie fails
    S.phase = PHASES.ELECTION_RESULT;
    this.log(`Vote: ${ja} Ja / ${nein} Nein — ${S.lastOutcome === 'pass' ? 'ELECTED' : 'REJECTED'}.`);
  }

  applyElectionOutcome() {
    const S = this.state;
    if (S.lastOutcome === 'pass') {
      S.chancellorId = S.nomineeId;
      S.lastElectedPresidentId = S.presidentId;
      S.lastElectedChancellorId = S.chancellorId;
      S.electionTracker = 0;

      if (S.fascistPolicies >= HITLER_CHANCELLOR_AT && this.byId(S.chancellorId).role === 'hitler') {
        this.endGame('fascist', 'Hitler was elected Chancellor.');
        return;
      }
      this.ensureDraw(3);
      S.presidentDraw = S.drawPile.splice(0, 3);
      S.phase = PHASES.LEG_PRESIDENT;
      this.log(`${this.nameOf(S.presidentId)} & ${this.nameOf(S.chancellorId)} elected. President draws three policies.`);
    } else {
      S.nomineeId = null;
      const chaos = this.advanceTrackerForFailure();
      if (!chaos && S.phase !== PHASES.GAMEOVER) this.beginNextRound();
    }
  }

  advanceTrackerForFailure() {
    const S = this.state;
    S.electionTracker++;
    this.log(`Election failed. Tracker at ${S.electionTracker}/${TRACKER_MAX}.`);
    if (S.electionTracker < TRACKER_MAX) return false;
    // Chaos: enact the top policy with no power and no credit, reset the tracker
    // and clear term limits.
    this.ensureDraw(1);
    const top = S.drawPile.shift();
    S.electionTracker = 0;
    S.lastElectedPresidentId = null;
    S.lastElectedChancellorId = null;
    this.log('Three failed elections — the country is thrown into chaos!');
    this.enactPolicy(top, true);
    return true;
  }

  // fromChaos — enacted by the election tracker: grants no power.
  enactPolicy(card, fromChaos) {
    const S = this.state;
    if (card === 'L') {
      S.liberalPolicies++;
      this.log(`A Liberal policy was enacted. (${S.liberalPolicies}/${LIBERAL_TARGET})`);
    } else {
      S.fascistPolicies++;
      if (S.fascistPolicies >= VETO_UNLOCK_AT) S.vetoUnlocked = true;
      this.log(`A Fascist policy was enacted. (${S.fascistPolicies}/${FASCIST_TARGET})`);
    }

    if (this.checkPolicyWin()) return;

    if (card === 'F' && !fromChaos) {
      const power = POWER_TRACK[S.numPlayers][S.fascistPolicies - 1];
      if (power) {
        S.pendingPower = power;
        S.phase = PHASES.EXECUTIVE;
        this.log(`Presidential power unlocked: ${POWER_LABEL[power]}.`);
        if (power === 'peek') {
          this.ensureDraw(3);
          S.peekCards = S.drawPile.slice(0, 3);
        }
        return;
      }
    }
    this.beginNextRound();
  }

  checkPolicyWin() {
    const S = this.state;
    if (S.liberalPolicies >= LIBERAL_TARGET) {
      return this.endGame('liberal', 'Five Liberal policies enacted.');
    }
    if (S.fascistPolicies >= FASCIST_TARGET) {
      return this.endGame('fascist', 'Six Fascist policies enacted.');
    }
    return false;
  }

  endGame(winner, reason) {
    const S = this.state;
    S.winner = winner;
    S.winReason = reason;
    S.phase = PHASES.GAMEOVER;
    this.log(`${winner === 'liberal' ? 'LIBERALS' : 'FASCISTS'} win — ${reason}`);
    return true;
  }

  resetForNewGame() {
    const S = this.state;
    const players = S.players;
    const hostId = S.hostId;
    const fresh = freshState();
    fresh.players = players;
    fresh.hostId = hostId;
    players.forEach((p) => {
      p.alive = true;
      p.role = null;
      p.party = null;
      p.investigated = false;
      p.knownAllies = null;
      p.ready = false;
    });
    this.state = fresh;
    this.log('Returned to lobby for a new game.');
  }

  // -------------------------------------------------------------------------
  // Rules helpers
  // -------------------------------------------------------------------------
  livingIds() {
    return this.state.seatOrder.filter((id) => {
      const p = this.byId(id);
      return p && p.alive;
    });
  }

  livingCount() { return this.livingIds().length; }

  nextLivingSeatAfter(seat) {
    const S = this.state;
    const n = S.seatOrder.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      const p = this.byId(S.seatOrder[s]);
      if (p && p.alive) return s;
    }
    return seat;
  }

  isEligibleChancellor(candidateId) {
    const S = this.state;
    const p = this.byId(candidateId);
    if (!p || !p.alive) return false;
    if (candidateId === S.presidentId) return false;
    if (candidateId === S.lastElectedChancellorId) return false;
    // The President term limit lifts once only 5 players are left alive.
    if (this.livingCount() > 5 && candidateId === S.lastElectedPresidentId) return false;
    return true;
  }

  ensureDraw(min) {
    const S = this.state;
    if (S.drawPile.length >= min) return;
    S.drawPile = this.shuffle(S.drawPile.concat(S.discardPile));
    S.discardPile = [];
    this.log('Draw pile reshuffled with discards.');
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  nameOf(id) {
    const p = this.byId(id);
    return p ? p.name : '?';
  }

  // Timestamps are stored as epoch ms and formatted by the client. The server
  // runs in a UTC container, so formatting here would show every player the
  // wrong wall-clock time.
  log(text) {
    const S = this.state;
    S.log.unshift({ t: this.now(), text });
    if (S.log.length > LOG_MAX) S.log.pop();
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------
  /**
   * What every device may see. Deliberately contains no role, party, hand, peek
   * or investigation result — those only reach a device via privateStateFor.
   * Roles enter here at exactly one moment: game over.
   */
  publicState() {
    const S = this.state;
    const order = S.seatOrder.length ? S.seatOrder : S.players.map((p) => p.id);

    const pub = {
      phase: S.phase,
      numPlayers: S.numPlayers,
      hostId: S.hostId,
      players: order.map((id) => this.publicPlayer(id)).filter(Boolean),
      lobbyPlayers: S.players.map((p) => ({
        id: p.id, name: p.name, isHost: p.isHost, connected: p.connected,
      })),

      presidentId: S.presidentId,
      chancellorId: S.chancellorId,
      presidentIsSpecial: S.presidentIsSpecial,
      nomineeId: S.nomineeId,
      lastElectedPresidentId: S.lastElectedPresidentId,
      lastElectedChancellorId: S.lastElectedChancellorId,

      liberalPolicies: S.liberalPolicies,
      fascistPolicies: S.fascistPolicies,
      electionTracker: S.electionTracker,
      vetoUnlocked: S.vetoUnlocked,

      drawCount: S.drawPile.length,
      discardCount: S.discardPile.length,

      voteWaiting: null,
      lastVotes: null,
      lastOutcome: S.lastOutcome,

      pendingPower: S.pendingPower,
      powerLabel: S.pendingPower ? POWER_LABEL[S.pendingPower] : null,

      winner: S.winner,
      winReason: S.winReason,
      log: S.log.slice(0, 30),
    };

    // During an election everyone may see WHO still owes a vote — never which
    // way anyone voted. The tally is revealed only once voting has closed.
    if (S.phase === PHASES.ELECTION) {
      const living = this.livingIds();
      const pending = living.filter((id) => !S.votes[id]);
      pub.voteWaiting = { voted: living.length - pending.length, total: living.length, pending };
    }
    if (S.phase === PHASES.ELECTION_RESULT && S.lastVotes) {
      pub.lastVotes = S.lastVotes;
    }
    if (S.phase === PHASES.GAMEOVER) {
      pub.revealRoles = S.seatOrder
        .map((id) => this.byId(id))
        .filter(Boolean)
        .map((p) => ({ name: p.name, role: p.role }));
    }
    return pub;
  }

  publicPlayer(id) {
    const S = this.state;
    const p = this.byId(id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      investigated: p.investigated,
      isPresident: id === S.presidentId,
      isChancellor: id === S.chancellorId,
      isNominee: id === S.nomineeId,
    };
  }

  /** What exactly ONE device may see. Returns null for an unknown id (spectator). */
  privateStateFor(id) {
    const S = this.state;
    const me = this.byId(id);
    if (!me) return null;

    const priv = {
      id,
      name: me.name,
      isHost: me.isHost,
      alive: me.alive,
      role: me.role,
      party: me.party,
      knownAllies: me.knownAllies,
      ready: me.ready,
      isPresident: id === S.presidentId,
      isChancellor: id === S.chancellorId,
      isNominee: id === S.nomineeId,
      hasVoted: !!S.votes[id],
      myVote: S.votes[id] || null,
      presCards: null,
      chanCards: null,
      peek: null,
      investigation: null,
      vetoProposed: S.vetoProposed,
      vetoUnlocked: S.vetoUnlocked,
      vetoUsedThisGov: S.vetoUsedThisGov,
      eligibleChancellors: null,
    };

    if (S.phase === PHASES.NOMINATION && priv.isPresident) {
      priv.eligibleChancellors = S.seatOrder.filter((k) => this.isEligibleChancellor(k));
    }
    if (S.phase === PHASES.LEG_PRESIDENT && priv.isPresident) {
      priv.presCards = S.presidentDraw.slice();
    }
    if ((S.phase === PHASES.LEG_CHANCELLOR || S.phase === PHASES.VETO_PROMPT) && priv.isChancellor) {
      priv.chanCards = S.chancellorCards.slice();
    }
    if (S.phase === PHASES.EXECUTIVE && priv.isPresident) {
      if (S.pendingPower === 'peek' && S.peekCards) priv.peek = S.peekCards.slice();
      if (S.pendingPower === 'investigate' && S.investigation && S.investigation.byId === id) {
        priv.investigation = { name: S.investigation.name, party: S.investigation.party };
      }
    }
    return priv;
  }

  // -------------------------------------------------------------------------
  // Snapshot (peer-to-peer host reload only — the server keeps state in memory)
  // -------------------------------------------------------------------------
  serialize() {
    return JSON.parse(JSON.stringify(this.state));
  }

  static deserialize(snap, opts = {}) {
    const eng = new GameEngine(opts);
    if (snap && typeof snap === 'object') {
      eng.state = { ...freshState(), ...snap };
    }
    return eng;
  }
}

export function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, NAME_MAX) || 'Player';
}
