// ============================================================================
// scripts/test-engine.mjs — headless harness for the pure rules engine.
//
//   node scripts/test-engine.mjs
//
// Covers the full round lifecycle, every win condition, all four presidential
// powers, term limits, the election tracker's chaos rule, the veto, and the
// state-projection guarantees that keep hidden roles hidden. The seat-reclaim
// tests are security regressions — see the Part D note in js/engine.js.
// ============================================================================

import {
  GameEngine, PHASES, ROLE_DIST, POWER_TRACK, MIN_PLAYERS, MAX_PLAYERS,
} from '../js/engine.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}: expected ${e}, got ${a}`);
}

function expectOk(res, msg) {
  assert(res && res.ok, `${msg || 'intent'} should succeed, got error: ${res && res.error}`);
}

function expectFail(res, msg) {
  assert(res && res.ok === false, `${msg || 'intent'} should be refused but succeeded`);
}

// Deterministic PRNG so shuffles are reproducible across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let clock = 1_700_000_000_000;
function newEngine(seed = 42) {
  return new GameEngine({ rng: mulberry32(seed), now: () => (clock += 1000) });
}

function seat(eng, n, opts = {}) {
  for (let i = 0; i < n; i++) {
    const res = eng.join({
      id: `p${i}`,
      name: `P${i}`,
      clientId: opts.noClientIds ? null : `cid-${i}`,
      isHost: i === 0,
    });
    expectOk(res, `join P${i}`);
  }
  return eng;
}

/** Force the draw pile so a test can steer which policies come up. */
function stackDeck(eng, cards) {
  eng.state.drawPile = cards.slice();
  eng.state.discardPile = [];
}

function readyAll(eng) {
  for (const id of eng.livingIds()) expectOk(eng.setReady(id), `ready ${id}`);
}

/** President nominates the first eligible player; everyone alive votes `vote`. */
function runElection(eng, vote = 'ja') {
  const priv = eng.privateStateFor(eng.state.presidentId);
  const target = priv.eligibleChancellors[0];
  expectOk(eng.nominate(eng.state.presidentId, target), 'nominate');
  for (const id of eng.livingIds()) expectOk(eng.castVote(id, vote), `vote ${id}`);
  return target;
}

/** Full legislative session: president discards index 0, chancellor enacts 0. */
function legislate(eng, presIdx = 0, chanIdx = 0) {
  expectOk(eng.presidentDiscard(eng.state.presidentId, presIdx), 'presidentDiscard');
  expectOk(eng.chancellorEnact(eng.state.chancellorId, chanIdx), 'chancellorEnact');
}

/** Start a game and get past the role-reveal gate. */
function started(n = 5, seed = 42) {
  const eng = seat(newEngine(seed), n);
  expectOk(eng.startGame('p0'), 'startGame');
  readyAll(eng);
  return eng;
}

// ---------------------------------------------------------------------------
// Seating and lobby
// ---------------------------------------------------------------------------
check('first player becomes host', () => {
  const eng = seat(newEngine(), 3);
  eq(eng.hostId, 'p0', 'hostId');
  assert(eng.byId('p0').isHost, 'p0 should be host');
  assert(!eng.byId('p1').isHost, 'p1 should not be host');
});

check('duplicate names are refused in the lobby', () => {
  const eng = seat(newEngine(), 2);
  expectFail(eng.join({ id: 'x', name: 'P1', clientId: 'other' }), 'duplicate name');
});

check('lobby is capped at MAX_PLAYERS', () => {
  const eng = seat(newEngine(), MAX_PLAYERS);
  expectFail(eng.join({ id: 'extra', name: 'Extra', clientId: 'cid-extra' }), 'over cap');
});

check('names are cleaned of control characters and clamped', () => {
  const eng = newEngine();
  eng.join({ id: 'a', name: '  Ana\u0007\u0000  ', clientId: 'c' });
  eq(eng.byId('a').name, 'Ana', 'cleaned name');
  eng.join({ id: 'b', name: 'x'.repeat(50), clientId: 'd' });
  eq(eng.byId('b').name.length, 14, 'clamped name length');
});

check('start requires 5-10 players', () => {
  const four = seat(newEngine(), 4);
  expectFail(four.startGame('p0'), 'start with 4');
  const five = seat(newEngine(), 5);
  expectOk(five.startGame('p0'), 'start with 5');
});

check('only the host can start', () => {
  const eng = seat(newEngine(), 5);
  expectFail(eng.startGame('p3'), 'non-host start');
});

check('host can kick in the lobby only', () => {
  const eng = seat(newEngine(), 5);
  expectFail(eng.kickPlayer('p1', 'p2'), 'non-host kick');
  expectFail(eng.kickPlayer('p0', 'p0'), 'kick the host');
  expectOk(eng.kickPlayer('p0', 'p4'), 'host kicks p4');
  eq(eng.players.length, 4, 'player count after kick');
  const live = started(5);
  expectFail(live.kickPlayer('p0', 'p4'), 'kick mid-game');
});

check('a lobby drop frees the seat; a mid-game drop keeps it', () => {
  const lobby = seat(newEngine(), 5);
  expectOk(lobby.markOffline('p4'), 'lobby drop');
  eq(lobby.players.length, 4, 'lobby seat freed');

  const live = started(5);
  expectOk(live.markOffline('p4'), 'mid-game drop');
  eq(live.players.length, 5, 'mid-game seat kept');
  assert(!live.byId('p4').connected, 'p4 marked disconnected');
  assert(live.byId('p4').role, 'p4 keeps their role');
});

check('host is reassigned when the host leaves the lobby', () => {
  const eng = seat(newEngine(), 5);
  expectOk(eng.markOffline('p0'), 'host leaves');
  eq(eng.hostId, 'p1', 'new host');
  assert(eng.byId('p1').isHost, 'p1 flagged host');
});

// ---------------------------------------------------------------------------
// SECURITY: seat reclaim (Part D — the highest-severity item)
// ---------------------------------------------------------------------------
check('SECURITY mid-game reclaim by name alone is refused', () => {
  const eng = started(5);
  const role = eng.byId('p4').role;
  eng.markOffline('p4');
  // An attacker on another device knows only the public name.
  const res = eng.join({ id: 'attacker', name: 'P4', clientId: 'attacker-cid' });
  expectFail(res, 'name-only mid-game reclaim');
  eq(eng.byId('p4').role, role, "victim's role untouched");
  assert(!eng.byId('attacker'), 'attacker got no seat');
});

check('SECURITY mid-game reclaim needs the exact clientId', () => {
  const eng = started(5);
  eng.markOffline('p4');
  expectFail(eng.join({ id: 'x', name: 'P4', clientId: 'cid-4-WRONG' }), 'near-miss clientId');
  expectFail(eng.join({ id: 'x', name: 'P4', clientId: null }), 'absent clientId');
  expectFail(eng.join({ id: 'x', name: 'P4' }), 'undefined clientId');
});

check('mid-game reclaim with the right clientId restores the same seat and role', () => {
  const eng = started(5);
  const role = eng.byId('p4').role;
  eng.markOffline('p4');
  const res = eng.join({ id: 'ignored-new-id', name: 'P4', clientId: 'cid-4' });
  expectOk(res, 'clientId reclaim');
  eq(res.playerId, 'p4', 'seat id is stable across reconnect');
  assert(res.reclaimed, 'flagged as reclaimed');
  eq(eng.byId('p4').role, role, 'same role');
  assert(eng.byId('p4').connected, 'reconnected');
  eq(eng.players.length, 5, 'no duplicate seat created');
});

check('pre-game reclaim by name is allowed (nothing to steal yet)', () => {
  const eng = seat(newEngine(), 5, { noClientIds: true });
  eng.byId('p4').connected = false; // a drop that did not free the seat
  const res = eng.join({ id: 'newconn', name: 'P4', clientId: 'fresh-device' });
  expectOk(res, 'lobby name reclaim');
  eq(res.playerId, 'p4', 'same lobby seat');
  eq(eng.byId('p4').clientId, 'fresh-device', 'adopts the new device');
});

check('a late joiner cannot enter a running game', () => {
  const eng = started(5);
  expectFail(eng.join({ id: 'late', name: 'Late', clientId: 'cid-late' }), 'late join');
});

check('owner reclaim restores host controls', () => {
  const eng = started(5);
  eng.markOffline('p0');
  expectOk(eng.join({ id: 'p0b', name: 'P0', clientId: 'cid-0' }), 'owner reclaim');
  eq(eng.hostId, 'p0', 'still host');
});

// ---------------------------------------------------------------------------
// Role distribution and knowledge
// ---------------------------------------------------------------------------
for (const n of [5, 6, 7, 8, 9, 10]) {
  check(`role distribution is correct for ${n} players`, () => {
    const eng = started(n, 7 + n);
    const roles = eng.players.map((p) => p.role);
    const libs = roles.filter((r) => r === 'liberal').length;
    const fas = roles.filter((r) => r === 'fascist').length;
    const hitler = roles.filter((r) => r === 'hitler').length;
    eq([libs, fas], ROLE_DIST[n], `distribution for ${n}`);
    eq(hitler, 1, 'exactly one Hitler');
    eq(libs + fas + hitler, n, 'every seat has a role');
    eng.players.forEach((p) => {
      eq(p.party, p.role === 'liberal' ? 'Liberal' : 'Fascist', `party for ${p.role}`);
    });
  });

  check(`fascist knowledge is correct for ${n} players`, () => {
    const eng = started(n, 100 + n);
    const fascists = eng.players.filter((p) => p.role === 'fascist');
    const hitler = eng.players.find((p) => p.role === 'hitler');

    fascists.forEach((f) => {
      const labels = f.knownAllies.map((a) => a.label).sort();
      const expectedFascistPeers = fascists.length - 1;
      eq(labels.filter((l) => l === 'Fascist').length, expectedFascistPeers, 'knows fascist peers');
      eq(labels.filter((l) => l === 'Hitler').length, 1, 'knows Hitler');
      assert(!f.knownAllies.some((a) => a.name === f.name), 'does not list itself');
    });

    if (n <= 6) {
      eq(hitler.knownAllies.length, fascists.length, 'Hitler knows the fascist(s) at 5-6p');
    } else {
      eq(hitler.knownAllies, null, 'Hitler is in the dark at 7-10p');
    }
    eng.players.filter((p) => p.role === 'liberal').forEach((l) => {
      eq(l.knownAllies, null, 'liberals know nobody');
    });
  });
}

check('the policy deck is 6 Liberal and 11 Fascist', () => {
  const eng = started(5);
  const deck = eng.state.drawPile;
  eq(deck.length, 17, 'deck size');
  eq(deck.filter((c) => c === 'L').length, 6, 'liberal cards');
  eq(deck.filter((c) => c === 'F').length, 11, 'fascist cards');
});

check('the game waits for every player to memorise their role', () => {
  const eng = seat(newEngine(), 5);
  eng.startGame('p0');
  eq(eng.phase, PHASES.REVEAL, 'reveal phase');
  for (const id of ['p0', 'p1', 'p2', 'p3']) eng.setReady(id);
  eq(eng.phase, PHASES.REVEAL, 'still waiting on the last player');
  eng.setReady('p4');
  eq(eng.phase, PHASES.NOMINATION, 'advances once all are ready');
});

// ---------------------------------------------------------------------------
// SECURITY: state projection
// ---------------------------------------------------------------------------
check('SECURITY publicState never carries roles or hands mid-game', () => {
  const eng = started(5);
  stackDeck(eng, ['F', 'L', 'F', 'L', 'F', 'L', 'F', 'L', 'F', 'L', 'F', 'F', 'F', 'F', 'F', 'L', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eq(eng.phase, PHASES.LEG_PRESIDENT, 'legislative session open');

  const raw = JSON.stringify(eng.publicState());
  for (const banned of ['"role"', '"party"', '"knownAllies"', '"presCards"',
    '"chanCards"', '"peek"', '"investigation"', '"drawPile"', '"discardPile"',
    '"presidentDraw"', '"chancellorCards"', '"peekCards"', '"clientId"']) {
    assert(!raw.includes(banned), `publicState must not contain ${banned}`);
  }
  assert(!('revealRoles' in eng.publicState()), 'no revealRoles before game over');
});

check('SECURITY only the president sees the drawn policies', () => {
  const eng = started(5);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  const presId = eng.state.presidentId;
  eq(eng.privateStateFor(presId).presCards.length, 3, 'president sees three cards');
  for (const p of eng.players) {
    if (p.id === presId) continue;
    eq(eng.privateStateFor(p.id).presCards, null, `${p.id} must not see the draw`);
  }
});

check('SECURITY only the chancellor sees the passed policies', () => {
  const eng = started(5);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  const chanId = eng.state.chancellorId;
  eq(eng.privateStateFor(chanId).chanCards.length, 2, 'chancellor sees two cards');
  for (const p of eng.players) {
    if (p.id === chanId) continue;
    eq(eng.privateStateFor(p.id).chanCards, null, `${p.id} must not see the hand`);
  }
});

check('SECURITY a private projection reveals only the viewer own role', () => {
  const eng = started(5);
  for (const p of eng.players) {
    const priv = eng.privateStateFor(p.id);
    eq(priv.role, p.role, 'own role');
    eq(priv.id, p.id, 'own id');
  }
  eq(eng.privateStateFor('not-a-player'), null, 'unknown id gets nothing');
});

check('SECURITY votes stay secret until the ballot closes', () => {
  const eng = started(5);
  eng.nominate(eng.state.presidentId, eng.privateStateFor(eng.state.presidentId).eligibleChancellors[0]);
  eng.castVote('p0', 'ja');
  eng.castVote('p1', 'nein');
  const mid = eng.publicState();
  eq(mid.lastVotes, null, 'no tally mid-ballot');
  eq(mid.voteWaiting.voted, 2, 'progress count is public');
  assert(Array.isArray(mid.voteWaiting.pending), 'pending names are public');
  for (const id of eng.livingIds()) if (!eng.state.votes[id]) eng.castVote(id, 'ja');
  assert(eng.publicState().lastVotes, 'tally revealed once closed');
});

check('roles are revealed to everyone at game over', () => {
  const eng = started(5);
  eng.endGame('liberal', 'test');
  const pub = eng.publicState();
  eq(pub.revealRoles.length, 5, 'all roles revealed');
  assert(pub.revealRoles.every((r) => r.role), 'each has a role');
});

// ---------------------------------------------------------------------------
// Election mechanics
// ---------------------------------------------------------------------------
check('a strict majority is required and a tie fails', () => {
  const eng = started(6, 11);
  eng.nominate(eng.state.presidentId, eng.privateStateFor(eng.state.presidentId).eligibleChancellors[0]);
  const living = eng.livingIds();
  living.forEach((id, i) => eng.castVote(id, i % 2 === 0 ? 'ja' : 'nein')); // 3-3
  eq(eng.state.lastOutcome, 'fail', 'a tie fails');
});

check('a vote can be changed until the last ballot is in', () => {
  const eng = started(5);
  eng.nominate(eng.state.presidentId, eng.privateStateFor(eng.state.presidentId).eligibleChancellors[0]);
  eng.castVote('p0', 'ja');
  eq(eng.privateStateFor('p0').myVote, 'ja', 'first choice');
  eng.castVote('p0', 'nein');
  eq(eng.privateStateFor('p0').myVote, 'nein', 'changed choice');
  eq(eng.phase, PHASES.ELECTION, 'still open');
});

check('dead players cannot vote and are not awaited', () => {
  const eng = started(5);
  eng.byId('p4').alive = false;
  eng.nominate(eng.state.presidentId, eng.privateStateFor(eng.state.presidentId).eligibleChancellors[0]);
  expectFail(eng.castVote('p4', 'ja'), 'dead vote');
  const living = eng.livingIds();
  eq(living.length, 4, 'four living');
  living.forEach((id) => eng.castVote(id, 'ja'));
  eq(eng.phase, PHASES.ELECTION_RESULT, 'resolved without the dead player');
});

check('term limits block the last elected government', () => {
  const eng = started(9, 3);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  const lastPres = eng.state.lastElectedPresidentId;
  const lastChan = eng.state.lastElectedChancellorId;
  legislate(eng);
  // Whatever happened, get to a fresh nomination.
  if (eng.phase === PHASES.EXECUTIVE) {
    const power = eng.state.pendingPower;
    if (power === 'peek') eng.powerDone(eng.state.presidentId);
    else {
      const t = eng.publicState().players.find((p) => p.alive && p.id !== eng.state.presidentId);
      eng.usePower(eng.state.presidentId, t.id);
      if (eng.phase === PHASES.EXECUTIVE) eng.powerDone(eng.state.presidentId);
    }
  }
  assert(eng.phase === PHASES.NOMINATION, `expected nomination, got ${eng.phase}`);
  assert(eng.livingCount() > 5, 'more than five alive so both limits apply');
  assert(!eng.isEligibleChancellor(lastChan), 'last chancellor is blocked');
  if (lastPres !== eng.state.presidentId) {
    assert(!eng.isEligibleChancellor(lastPres), 'last president is blocked');
  }
  assert(!eng.isEligibleChancellor(eng.state.presidentId), 'president cannot self-nominate');
});

check('with five alive only the last chancellor is term limited', () => {
  const eng = started(7, 5);
  eng.state.lastElectedPresidentId = 'p1';
  eng.state.lastElectedChancellorId = 'p2';
  eng.state.presidentId = 'p0';
  // Kill down to five alive.
  eng.byId('p5').alive = false;
  eng.byId('p6').alive = false;
  eq(eng.livingCount(), 5, 'five alive');
  assert(eng.isEligibleChancellor('p1'), 'last president is eligible again at five alive');
  assert(!eng.isEligibleChancellor('p2'), 'last chancellor is still blocked');
});

check('the presidency rotates to the next living player', () => {
  const eng = started(5);
  const order = eng.state.seatOrder;
  const startSeat = eng.state.rotationSeat;
  const deadId = order[(startSeat + 1) % 5];
  eng.byId(deadId).alive = false;
  eng.beginNextRound();
  eq(eng.state.presidentId, order[(startSeat + 2) % 5], 'skips the dead seat');
});

// ---------------------------------------------------------------------------
// Election tracker / chaos
// ---------------------------------------------------------------------------
check('three failed elections throw the country into chaos', () => {
  const eng = started(5);
  stackDeck(eng, ['L', 'L', 'L', 'L', 'L', 'L', 'F', 'F', 'F', 'F', 'F']);
  eng.state.lastElectedPresidentId = 'p1';
  eng.state.lastElectedChancellorId = 'p2';

  for (let i = 1; i <= 2; i++) {
    runElection(eng, 'nein');
    eng.continueResult(eng.state.presidentId);
    eq(eng.state.electionTracker, i, `tracker at ${i}`);
    eq(eng.phase, PHASES.NOMINATION, 'next round');
  }
  runElection(eng, 'nein');
  eng.continueResult(eng.state.presidentId);

  eq(eng.state.electionTracker, 0, 'tracker reset');
  eq(eng.state.liberalPolicies, 1, 'top policy enacted automatically');
  eq(eng.state.lastElectedPresidentId, null, 'term limits cleared');
  eq(eng.state.lastElectedChancellorId, null, 'term limits cleared');
  eq(eng.phase, PHASES.NOMINATION, 'straight into the next round');
});

check('a chaos policy grants no presidential power', () => {
  const eng = started(9, 21); // 9p: the first fascist policy would grant Investigate
  stackDeck(eng, ['F', 'F', 'F', 'F', 'F', 'F', 'L', 'L']);
  eng.state.electionTracker = 2;
  runElection(eng, 'nein');
  eng.continueResult(eng.state.presidentId);
  eq(eng.state.fascistPolicies, 1, 'fascist policy enacted by chaos');
  eq(eng.state.pendingPower, null, 'no power granted');
  eq(eng.phase, PHASES.NOMINATION, 'no executive phase');
});

check('a successful election resets the tracker', () => {
  const eng = started(5);
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F', 'F', 'F', 'F']);
  eng.state.electionTracker = 2;
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eq(eng.state.electionTracker, 0, 'tracker reset on success');
});

// ---------------------------------------------------------------------------
// Legislative session
// ---------------------------------------------------------------------------
check('the president discards one of three and the chancellor enacts one of two', () => {
  const eng = started(5);
  stackDeck(eng, ['L', 'F', 'F', 'L', 'L', 'L', 'F', 'F', 'F', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eq(eng.privateStateFor(eng.state.presidentId).presCards, ['L', 'F', 'F'], 'top three drawn');
  eng.presidentDiscard(eng.state.presidentId, 1); // discard the first F
  eq(eng.privateStateFor(eng.state.chancellorId).chanCards, ['L', 'F'], 'two passed on');
  eng.chancellorEnact(eng.state.chancellorId, 0); // enact L
  eq(eng.state.liberalPolicies, 1, 'liberal policy enacted');
  eq(eng.state.discardPile.length, 2, 'both rejects discarded');
});

check('out-of-range card indices are refused', () => {
  const eng = started(5);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  const pres = eng.state.presidentId;
  expectFail(eng.presidentDiscard(pres, 3), 'index 3 of 3');
  expectFail(eng.presidentDiscard(pres, -1), 'negative index');
  expectFail(eng.presidentDiscard(pres, 'x'), 'non-numeric index');
  expectFail(eng.presidentDiscard(pres, null), 'null index');
});

check('only the sitting president and chancellor may legislate', () => {
  const eng = started(5);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  const outsider = eng.players.find((p) => p.id !== eng.state.presidentId).id;
  expectFail(eng.presidentDiscard(outsider, 0), 'outsider discards');
  eng.presidentDiscard(eng.state.presidentId, 0);
  const notChan = eng.players.find((p) => p.id !== eng.state.chancellorId).id;
  expectFail(eng.chancellorEnact(notChan, 0), 'outsider enacts');
});

check('the draw pile reshuffles with discards when short', () => {
  const eng = started(5);
  eng.state.drawPile = ['L', 'F'];
  eng.state.discardPile = ['F', 'F', 'L', 'F'];
  eng.ensureDraw(3);
  eq(eng.state.drawPile.length, 6, 'reshuffled');
  eq(eng.state.discardPile.length, 0, 'discards consumed');
});

// ---------------------------------------------------------------------------
// Veto
// ---------------------------------------------------------------------------
check('veto unlocks at five fascist policies', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 4;
  stackDeck(eng, ['F', 'F', 'F', 'L', 'L', 'L']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  expectFail(eng.proposeVeto(eng.state.chancellorId), 'veto before unlock');
  eng.chancellorEnact(eng.state.chancellorId, 0); // fifth fascist policy
  eq(eng.state.fascistPolicies, 5, 'five fascist policies');
  assert(eng.state.vetoUnlocked, 'veto now unlocked');
});

check('an agreed veto discards both and advances the tracker', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 5;
  eng.state.vetoUnlocked = true;
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  expectOk(eng.proposeVeto(eng.state.chancellorId), 'propose veto');
  eq(eng.phase, PHASES.VETO_PROMPT, 'veto prompt');
  const pres = eng.state.presidentId;
  expectOk(eng.vetoResponse(pres, true), 'agree');
  eq(eng.state.electionTracker, 1, 'counts as a failed government');
  eq(eng.state.liberalPolicies, 0, 'nothing enacted');
  eq(eng.phase, PHASES.NOMINATION, 'next round');
});

check('a rejected veto forces the chancellor to enact', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 5;
  eng.state.vetoUnlocked = true;
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  eng.proposeVeto(eng.state.chancellorId);
  expectOk(eng.vetoResponse(eng.state.presidentId, false), 'reject');
  eq(eng.phase, PHASES.LEG_CHANCELLOR, 'back to the chancellor');
  expectFail(eng.proposeVeto(eng.state.chancellorId), 'one veto per government');
  expectOk(eng.chancellorEnact(eng.state.chancellorId, 0), 'must enact');
});

check('only the chancellor proposes and only the president answers', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 5;
  eng.state.vetoUnlocked = true;
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  expectFail(eng.proposeVeto(eng.state.presidentId), 'president proposes');
  eng.proposeVeto(eng.state.chancellorId);
  expectFail(eng.vetoResponse(eng.state.chancellorId, true), 'chancellor answers');
});

// ---------------------------------------------------------------------------
// Presidential powers
// ---------------------------------------------------------------------------
check('the power track matches the player count', () => {
  for (const n of [5, 6, 7, 8, 9, 10]) {
    eq(POWER_TRACK[n].length, 5, `track length for ${n}`);
  }
  eq(POWER_TRACK[5][2], 'peek', '5p third fascist policy is a peek');
  eq(POWER_TRACK[9][0], 'investigate', '9p first fascist policy investigates');
  eq(POWER_TRACK[7][2], 'special', '7p third fascist policy is a special election');
});

function driveToPower(n, seed, fascistPoliciesBefore) {
  const eng = started(n, seed);
  eng.state.fascistPolicies = fascistPoliciesBefore;
  stackDeck(eng, ['F', 'F', 'F', 'L', 'L', 'L', 'L', 'L', 'L']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  eng.presidentDiscard(eng.state.presidentId, 0);
  eng.chancellorEnact(eng.state.chancellorId, 0);
  return eng;
}

check('policy peek shows the top three to the president alone', () => {
  const eng = driveToPower(5, 31, 2); // 5p, third fascist policy
  eq(eng.phase, PHASES.EXECUTIVE, 'executive phase');
  eq(eng.state.pendingPower, 'peek', 'peek power');
  const pres = eng.state.presidentId;
  eq(eng.privateStateFor(pres).peek.length, 3, 'president peeks three');
  eq(eng.privateStateFor(pres).peek, eng.state.drawPile.slice(0, 3), 'top of the pile, in order');
  for (const p of eng.players) {
    if (p.id === pres) continue;
    eq(eng.privateStateFor(p.id).peek, null, `${p.id} must not peek`);
  }
  // That a peek is happening is public knowledge; the three cards are not.
  const pub = eng.publicState();
  eq(pub.pendingPower, 'peek', 'the power itself is public');
  assert(!('peek' in pub) && !('peekCards' in pub), 'the peeked cards never reach public state');
  assert(!JSON.stringify(pub).includes(eng.state.drawPile[0] === 'L' ? '"L","' : '"F","'),
    'no card array in public state');
  expectOk(eng.powerDone(pres), 'acknowledge');
  eq(eng.phase, PHASES.NOMINATION, 'round advances');
});

check('investigate reveals party only, once per player, to the president alone', () => {
  const eng = driveToPower(9, 41, 0); // 9p, first fascist policy
  eq(eng.state.pendingPower, 'investigate', 'investigate power');
  const pres = eng.state.presidentId;
  const target = eng.publicState().players.find((p) => p.alive && p.id !== pres);

  expectFail(eng.usePower(pres, pres), 'cannot investigate yourself');
  expectFail(eng.powerDone(pres), 'cannot finish before investigating');
  expectOk(eng.usePower(pres, target.id), 'investigate');

  const result = eng.privateStateFor(pres).investigation;
  eq(result.name, target.name, 'target name');
  assert(result.party === 'Liberal' || result.party === 'Fascist', 'party revealed');
  assert(!('role' in result), 'never reveals whether they are Hitler');
  for (const p of eng.players) {
    if (p.id === pres) continue;
    eq(eng.privateStateFor(p.id).investigation, null, `${p.id} must not see the result`);
  }
  assert(eng.byId(target.id).investigated, 'marked investigated');
  expectOk(eng.powerDone(pres), 'acknowledge');
  eq(eng.phase, PHASES.NOMINATION, 'round advances');

  // Already-investigated players are off limits for the rest of the game.
  eng.state.pendingPower = 'investigate';
  eng.state.phase = PHASES.EXECUTIVE;
  expectFail(eng.usePower(eng.state.presidentId, target.id), 'investigate twice');
});

// The investigate branch is the one power that waits for a separate powerDone, so
// the president keeps the turn after a successful use. Nothing else stops them
// spending it again on a fresh target — and each result is readable from priv
// before the next call overwrites it, so one power would leak the whole table.
check('investigate cannot be re-fired at a second target in the same turn', () => {
  const eng = driveToPower(9, 41, 0);
  const pres = eng.state.presidentId;
  const others = eng.publicState().players.filter((p) => p.alive && p.id !== pres);
  const [first, second] = others;

  expectOk(eng.usePower(pres, first.id), 'first investigation');
  eq(eng.privateStateFor(pres).investigation.name, first.name, 'first result readable');

  expectFail(eng.usePower(pres, second.id), 'second target in the same power');
  eq(eng.privateStateFor(pres).investigation.name, first.name, 'result still the first target');
  assert(!eng.byId(second.id).investigated, 'second target was never touched');

  // Only after acknowledging does the power end — and it does not come back.
  expectOk(eng.powerDone(pres), 'acknowledge');
  eq(eng.phase, PHASES.NOMINATION, 'round advances');

  // The parties actually differ across the table, so a successful re-fire would
  // have leaked real information rather than repeating one value.
  const parties = new Set(others.map((p) => eng.byId(p.id).party));
  eq(parties.size, 2, 'table has both parties');
});

check('special election makes the chosen player the next president, then order resumes', () => {
  const eng = driveToPower(7, 51, 2); // 7p, third fascist policy → special
  eq(eng.state.pendingPower, 'special', 'special election');
  const pres = eng.state.presidentId;
  const pick = eng.publicState().players.find((p) => p.alive && p.id !== pres);
  const rotationBefore = eng.state.rotationSeat;

  expectFail(eng.usePower(pres, pres), 'cannot pick yourself');
  expectOk(eng.usePower(pres, pick.id), 'special election');
  eq(eng.state.presidentId, pick.id, 'chosen player is president');
  assert(eng.state.presidentIsSpecial, 'flagged as a special election');
  eq(eng.state.rotationSeat, rotationBefore, 'rotation pointer untouched');

  // Next round returns to the regular rotation.
  eng.beginNextRound();
  assert(!eng.state.presidentIsSpecial, 'special flag cleared');
  eq(eng.state.presidentId, eng.state.seatOrder[eng.nextLivingSeatAfter(rotationBefore)], 'order resumes');
});

check('execution removes a player and keeps their role hidden', () => {
  const eng = driveToPower(5, 61, 3); // 5p, fourth fascist policy → execution
  eq(eng.state.pendingPower, 'execution', 'execution power');
  const pres = eng.state.presidentId;
  const victim = eng.publicState().players.find(
    (p) => p.alive && p.id !== pres && eng.byId(p.id).role !== 'hitler',
  );
  expectFail(eng.usePower(pres, pres), 'cannot execute yourself');
  expectOk(eng.usePower(pres, victim.id), 'execute');
  assert(!eng.byId(victim.id).alive, 'victim is dead');
  eq(eng.phase, PHASES.NOMINATION, 'round advances');
  const shown = eng.publicState().players.find((p) => p.id === victim.id);
  assert(!('role' in shown), "dead player's role stays hidden");
  expectFail(eng.usePower(pres, victim.id), 'cannot target the dead');
});

check('a power cannot be used by anyone but the president', () => {
  const eng = driveToPower(5, 71, 3);
  const outsider = eng.players.find((p) => p.id !== eng.state.presidentId).id;
  expectFail(eng.usePower(outsider, eng.state.presidentId), 'outsider uses a power');
  expectFail(eng.powerDone(outsider), 'outsider acknowledges');
});

// ---------------------------------------------------------------------------
// Win conditions
// ---------------------------------------------------------------------------
check('five liberal policies win for the liberals', () => {
  const eng = started(5);
  eng.state.liberalPolicies = 4;
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  legislate(eng);
  eq(eng.state.liberalPolicies, 5, 'fifth liberal policy');
  eq(eng.phase, PHASES.GAMEOVER, 'game over');
  eq(eng.state.winner, 'liberal', 'liberals win');
});

check('six fascist policies win for the fascists', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 5;
  eng.state.vetoUnlocked = true;
  stackDeck(eng, ['F', 'F', 'F', 'L', 'L', 'L']);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  legislate(eng);
  eq(eng.state.fascistPolicies, 6, 'sixth fascist policy');
  eq(eng.phase, PHASES.GAMEOVER, 'game over');
  eq(eng.state.winner, 'fascist', 'fascists win');
  eq(eng.state.pendingPower, null, 'a winning policy grants no power');
});

check('electing Hitler chancellor after three fascist policies wins for the fascists', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 3;
  const hitler = eng.players.find((p) => p.role === 'hitler');
  // Put a non-Hitler player in the chair so Hitler can be nominated.
  const pres = eng.players.find((p) => p.role !== 'hitler');
  eng.state.presidentId = pres.id;
  eng.state.lastElectedPresidentId = null;
  eng.state.lastElectedChancellorId = null;

  expectOk(eng.nominate(pres.id, hitler.id), 'nominate Hitler');
  for (const id of eng.livingIds()) eng.castVote(id, 'ja');
  eng.continueResult(pres.id);
  eq(eng.phase, PHASES.GAMEOVER, 'game over');
  eq(eng.state.winner, 'fascist', 'fascists win');
  eq(eng.state.winReason, 'Hitler was elected Chancellor.', 'reason');
});

check('electing Hitler chancellor below three fascist policies is safe', () => {
  const eng = started(5);
  eng.state.fascistPolicies = 2;
  stackDeck(eng, ['L', 'L', 'L', 'F', 'F', 'F']);
  const hitler = eng.players.find((p) => p.role === 'hitler');
  const pres = eng.players.find((p) => p.role !== 'hitler');
  eng.state.presidentId = pres.id;
  eng.nominate(pres.id, hitler.id);
  for (const id of eng.livingIds()) eng.castVote(id, 'ja');
  eng.continueResult(pres.id);
  eq(eng.phase, PHASES.LEG_PRESIDENT, 'game continues into the legislative session');
});

check('executing Hitler wins for the liberals', () => {
  const eng = driveToPower(5, 61, 3); // execution power
  const hitler = eng.players.find((p) => p.role === 'hitler');
  const pres = eng.state.presidentId;
  if (hitler.id === pres) {
    // This seed put Hitler in the chair; move the presidency so Hitler is targetable.
    const other = eng.players.find((p) => p.id !== pres && p.alive);
    eng.state.presidentId = other.id;
  }
  expectOk(eng.usePower(eng.state.presidentId, hitler.id), 'execute Hitler');
  eq(eng.phase, PHASES.GAMEOVER, 'game over');
  eq(eng.state.winner, 'liberal', 'liberals win');
  eq(eng.state.winReason, 'Hitler was executed.', 'reason');
});

// ---------------------------------------------------------------------------
// Play again / snapshot
// ---------------------------------------------------------------------------
check('play again returns everyone to the lobby with roles cleared', () => {
  const eng = started(5);
  eng.endGame('liberal', 'test');
  expectFail(eng.playAgain('p2'), 'non-host restart');
  expectOk(eng.playAgain('p0'), 'host restart');
  eq(eng.phase, PHASES.LOBBY, 'back in the lobby');
  eq(eng.players.length, 5, 'players kept');
  eq(eng.hostId, 'p0', 'host kept');
  eng.players.forEach((p) => {
    eq(p.role, null, 'role cleared');
    eq(p.party, null, 'party cleared');
    assert(p.alive, 'revived');
    assert(!p.ready, 'ready cleared');
    assert(p.clientId, 'device identity kept for reclaim');
  });
  eq(eng.state.liberalPolicies, 0, 'board cleared');
  eq(eng.state.fascistPolicies, 0, 'board cleared');
  eq(eng.state.electionTracker, 0, 'tracker cleared');
  assert(!eng.state.vetoUnlocked, 'veto relocked');
});

check('play again is refused mid-game', () => {
  const eng = started(5);
  expectFail(eng.playAgain('p0'), 'restart mid-game');
});

// A lobby drop frees the seat, so a disconnected seat can only survive into the
// lobby via playAgain. Those seats still carry a device secret, and the name is
// public — so the name alone must not take the seat, or the rightful owner is
// locked out of a room they can still prove is theirs.
check('a name alone cannot take a held seat in the post-restart lobby', () => {
  const eng = started(5);
  const victim = eng.players.find((p) => p.id === 'p3');
  const heldBy = victim.clientId;
  assert(heldBy, 'the victim seat carries a device secret');

  eng.markOffline('p3');            // drops mid-game, so the seat is kept
  eng.endGame('liberal', 'test');
  expectOk(eng.playAgain('p0'), 'host restart');
  eq(eng.phase, PHASES.LOBBY, 'back in the lobby');
  assert(!eng.byId('p3').connected, 'the dropped player is still offline');

  const thief = eng.join({ id: 'thief', name: victim.name, clientId: 'attacker-device' });
  assert(!thief.ok, 'a name-only claim on a held seat is refused');
  eq(eng.byId('p3').clientId, heldBy, 'the seat still answers to the original device');
  assert(!eng.byId('p3').connected, 'and was not marked back online');

  // The rightful device still gets its seat back, under a new name if it likes.
  const back = eng.join({ id: 'ignored', name: 'Renamed', clientId: heldBy });
  assert(back.ok && back.reclaimed, 'the original device reclaims');
  eq(back.playerId, 'p3', 'the same seat');
  eq(eng.byId('p3').name, 'Renamed', 'rename allowed');
});

check('serialize and deserialize round-trip a live game', () => {
  const eng = started(7, 91);
  runElection(eng, 'ja');
  eng.continueResult(eng.state.presidentId);
  const snap = eng.serialize();
  const restored = GameEngine.deserialize(snap);
  eq(restored.phase, eng.phase, 'phase');
  eq(restored.publicState(), eng.publicState(), 'public projection');
  for (const p of eng.players) {
    eq(restored.privateStateFor(p.id), eng.privateStateFor(p.id), `private projection ${p.id}`);
  }
  // The restored engine must be playable, not just readable.
  expectOk(restored.presidentDiscard(restored.state.presidentId, 0), 'still playable');
});

// ---------------------------------------------------------------------------
// Phase guards — every intent refuses to run out of turn
// ---------------------------------------------------------------------------
check('intents are refused outside their phase', () => {
  const eng = seat(newEngine(), 5);
  expectFail(eng.setReady('p0'), 'ready in lobby');
  expectFail(eng.nominate('p0', 'p1'), 'nominate in lobby');
  expectFail(eng.castVote('p0', 'ja'), 'vote in lobby');
  expectFail(eng.continueResult('p0'), 'continue in lobby');
  expectFail(eng.presidentDiscard('p0', 0), 'discard in lobby');
  expectFail(eng.chancellorEnact('p0', 0), 'enact in lobby');
  expectFail(eng.proposeVeto('p0'), 'veto in lobby');
  expectFail(eng.vetoResponse('p0', true), 'veto answer in lobby');
  expectFail(eng.usePower('p0', 'p1'), 'power in lobby');
  expectFail(eng.powerDone('p0'), 'power done in lobby');
});

check('a full 5-player game runs start to finish', () => {
  const eng = started(5, 12345);
  let guard = 0;
  while (eng.phase !== PHASES.GAMEOVER && guard++ < 400) {
    switch (eng.phase) {
      case PHASES.NOMINATION: {
        const priv = eng.privateStateFor(eng.state.presidentId);
        expectOk(eng.nominate(eng.state.presidentId, priv.eligibleChancellors[0]), 'nominate');
        break;
      }
      case PHASES.ELECTION:
        for (const id of eng.livingIds()) eng.castVote(id, 'ja');
        break;
      case PHASES.ELECTION_RESULT:
        expectOk(eng.continueResult(eng.state.presidentId), 'continue');
        break;
      case PHASES.LEG_PRESIDENT:
        expectOk(eng.presidentDiscard(eng.state.presidentId, 0), 'discard');
        break;
      case PHASES.LEG_CHANCELLOR:
        expectOk(eng.chancellorEnact(eng.state.chancellorId, 0), 'enact');
        break;
      case PHASES.VETO_PROMPT:
        expectOk(eng.vetoResponse(eng.state.presidentId, false), 'reject veto');
        break;
      case PHASES.EXECUTIVE: {
        const pres = eng.state.presidentId;
        if (eng.state.pendingPower === 'peek') {
          expectOk(eng.powerDone(pres), 'peek done');
        } else {
          const t = eng.publicState().players.find(
            (p) => p.alive && p.id !== pres && !(eng.state.pendingPower === 'investigate' && p.investigated),
          );
          expectOk(eng.usePower(pres, t.id), `use ${eng.state.pendingPower}`);
          if (eng.phase === PHASES.EXECUTIVE) expectOk(eng.powerDone(pres), 'power done');
        }
        break;
      }
      default:
        throw new Error(`unexpected phase ${eng.phase}`);
    }
  }
  assert(guard < 400, 'game terminated rather than looping forever');
  eq(eng.phase, PHASES.GAMEOVER, 'reached game over');
  assert(eng.state.winner === 'liberal' || eng.state.winner === 'fascist', 'someone won');
  assert(eng.state.winReason.length > 0, 'win reason recorded');
  assert(eng.publicState().revealRoles.length === 5, 'roles revealed');
});

check('games terminate from many different shuffles', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const n = 5 + (seed % 6);
    const eng = started(n, seed * 977);
    let guard = 0;
    while (eng.phase !== PHASES.GAMEOVER && guard++ < 600) {
      const S = eng.state;
      if (eng.phase === PHASES.NOMINATION) {
        const elig = eng.privateStateFor(S.presidentId).eligibleChancellors;
        assert(elig.length > 0, `seed ${seed}: someone must be nominatable`);
        eng.nominate(S.presidentId, elig[seed % elig.length]);
      } else if (eng.phase === PHASES.ELECTION) {
        const living = eng.livingIds();
        living.forEach((id, i) => eng.castVote(id, (seed + i) % 3 === 0 ? 'nein' : 'ja'));
      } else if (eng.phase === PHASES.ELECTION_RESULT) {
        eng.continueResult(S.presidentId);
      } else if (eng.phase === PHASES.LEG_PRESIDENT) {
        eng.presidentDiscard(S.presidentId, seed % 3);
      } else if (eng.phase === PHASES.LEG_CHANCELLOR) {
        eng.chancellorEnact(S.chancellorId, seed % 2);
      } else if (eng.phase === PHASES.VETO_PROMPT) {
        eng.vetoResponse(S.presidentId, seed % 2 === 0);
      } else if (eng.phase === PHASES.EXECUTIVE) {
        const pres = S.presidentId;
        if (S.pendingPower === 'peek') {
          eng.powerDone(pres);
        } else {
          const t = eng.publicState().players.find(
            (p) => p.alive && p.id !== pres && !(S.pendingPower === 'investigate' && p.investigated),
          );
          if (!t) { eng.state.pendingPower = null; eng.beginNextRound(); continue; }
          eng.usePower(pres, t.id);
          if (eng.phase === PHASES.EXECUTIVE) eng.powerDone(pres);
        }
      } else {
        throw new Error(`seed ${seed}: unexpected phase ${eng.phase}`);
      }
      // Invariant: the board can never exceed a winning total.
      assert(S.liberalPolicies <= 5, `seed ${seed}: liberal track overflow`);
      assert(S.fascistPolicies <= 6, `seed ${seed}: fascist track overflow`);
      assert(eng.livingCount() >= 1, `seed ${seed}: everybody died`);
    }
    assert(eng.phase === PHASES.GAMEOVER, `seed ${seed}: did not terminate (${guard} steps)`);
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nengine: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error(`  ✗ ${f.name}\n      ${f.message}`);
  process.exit(1);
}
console.log(`engine: ${passed} checks passed`);
