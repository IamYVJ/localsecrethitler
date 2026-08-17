/* ============================================================
   Secret Hitler — local
   Rendering and UI only. Every transport concern lives in js/net.js, and every
   rule in js/engine.js, so this file reads the two projections the engine
   produces and draws them:

     app.pub    what everyone may see
     app.priv   what THIS device may see — roles, hands, peeks, investigations

   Hidden information therefore never has to be filtered here; it simply never
   arrives on a device that is not entitled to it.
   ============================================================ */

import { PHASES, POWER_TRACK, POWER_LABEL, MIN_PLAYERS, MAX_PLAYERS, cleanName } from './js/engine.js';
import { serverConfigured } from './js/config.js';
import * as net from './js/net.js';

const { app } = net;
const $ = (id) => document.getElementById(id);

/* ============================================================
   VIEW ROUTING
   ============================================================ */
function show(viewId) {
  ['viewHome', 'viewLobby', 'viewGame'].forEach((v) => {
    $(v).classList.toggle('hidden', v !== viewId);
  });
}

function showHome(keepCode) {
  show('viewHome');
  if (keepCode) $('codeInput').value = keepCode;
  document.body.classList.remove('in-game');
  $('peekBar').classList.add('hidden');
  hideRolePeek();
}

function routeView() {
  if (!app.code || !app.pub) { show('viewHome'); return; }
  if (app.pub.phase === PHASES.LOBBY) { show('viewLobby'); renderLobby(); }
  else { show('viewGame'); renderGame(); }
  updatePeekUI();
}

/** Single redraw entry point — net.js calls this on every state change. */
function render() {
  renderServerUI();
  renderNetBanner();
  routeView();
}

/**
 * Whoever the engine currently calls host is the one with owner controls. Reading
 * it from authoritative state rather than a local flag means it stays correct
 * after a host transfer or an owner reconnecting on a new seat.
 */
function amHost() {
  if (app.pub && app.meId) return app.pub.hostId === app.meId;
  return app.mode === 'p2p' ? app.role === 'host' : app.isOwner;
}

/* ============================================================
   RENDER: SERVER PILL + NET BANNER
   ============================================================ */
const PROBE_TEXT = {
  idle: () => 'Server: not checked',
  checking: () => `Checking server… ${app.serverProbeTry}/${net.HEALTH_TRIES}`,
  up: () => 'Server online',
  down: () => 'Server offline · tap to retry',
};

function renderServerUI() {
  const pill = $('serverPill');
  const btn = $('btnCreateServer');
  if (!serverConfigured()) {
    pill.classList.add('hidden');
    btn.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');
  pill.classList.toggle('is-checking', app.serverProbe === 'checking');
  pill.classList.toggle('is-up', app.serverProbe === 'up');
  pill.classList.toggle('is-down', app.serverProbe === 'down');
  pill.textContent = PROBE_TEXT[app.serverProbe]();
  // Offered only once the server has actually answered — a button that fails is
  // worse than one that isn't there.
  btn.classList.toggle('hidden', app.serverProbe !== 'up');
}

function renderNetBanner() {
  const b = $('netBanner');
  if (!app.code || app.netStatus === 'ok') { b.classList.add('hidden'); return; }
  const lost = app.netStatus === 'lost';
  b.classList.remove('hidden');
  b.classList.toggle('is-lost', lost);
  $('netBannerText').textContent = lost
    ? 'Connection lost. Your seat is still held.'
    : `Reconnecting… ${app.netTry}/${net.RECONNECT_TRIES}`;
  $('btnNetRetry').classList.toggle('hidden', !lost);
}

/* ============================================================
   RENDER: LOBBY
   ============================================================ */
function renderLobby() {
  const S = app.pub;
  if (!S) return;
  $('lobbyCode').textContent = app.code || '----';
  const list = S.lobbyPlayers || [];
  $('lobbyCount').textContent = list.length;
  const host = amHost();

  const ul = $('lobbyPlayers');
  ul.innerHTML = '';
  list.forEach((p) => {
    const li = document.createElement('li');
    const right = p.isHost
      ? '<span class="pl-tag">Host</span>'
      : (host ? `<button class="pl-kick" data-k="${esc(p.id)}">Kick</button>` : '');
    li.innerHTML = `<span class="pl-dot ${p.connected ? '' : 'off'}"></span>
      <span class="pl-name">${esc(p.name)}</span>
      ${right}`;
    ul.appendChild(li);
  });
  if (host) {
    ul.querySelectorAll('.pl-kick').forEach((b) => {
      b.onclick = () => net.send({ t: 'kick', targetId: b.dataset.k });
    });
  }

  const btnStart = $('btnStart');
  btnStart.classList.toggle('hidden', !host);
  btnStart.disabled = !(list.length >= MIN_PLAYERS && list.length <= MAX_PLAYERS);
  btnStart.textContent = list.length < MIN_PLAYERS
    ? `Need ${MIN_PLAYERS - list.length} more`
    : (list.length > MAX_PLAYERS ? 'Too many players' : 'Start game');
  $('lobbyWaitMsg').classList.toggle('hidden', host);

  const onServer = app.mode === 'server';
  $('lobbyHint').textContent = host
    ? (onServer
      ? `Share this code. Hosted on the server, so players can join from anywhere. Start once ${MIN_PLAYERS}–${MAX_PLAYERS} have joined.`
      : `Share this code. Everyone joins on the same Wi-Fi. Start once ${MIN_PLAYERS}–${MAX_PLAYERS} have joined.`)
    : 'Waiting in the lobby. The host will start the game.';
}

/* ============================================================
   RENDER: GAME
   ============================================================ */
function renderGame() {
  if (!app.pub || app.pub.phase === PHASES.LOBBY) return;
  renderBoard();
  renderAction();
  renderLog();
  updatePeekUI();
}

function renderBoard() {
  const S = app.pub;
  const board = $('board');

  if (S.phase === PHASES.GAMEOVER) { board.innerHTML = ''; return; }

  const govPres = S.presidentId ? nameOf(S.presidentId) : null;
  const govChan = S.chancellorId ? nameOf(S.chancellorId)
    : (S.nomineeId ? `${nameOf(S.nomineeId)} ?` : null);

  const libSlots = renderTrackSlots('lib', S.liberalPolicies, 5, null);
  const fasSlots = renderTrackSlots('fas', S.fascistPolicies, 6, POWER_TRACK[S.numPlayers]);

  const trackerDots = Array.from({ length: 3 }, (_, i) =>
    `<span class="tdot ${i < S.electionTracker ? 'on' : ''}"></span>`).join('');

  board.innerHTML = `
    <div class="gov-bar">
      <div class="gov-cell">
        <div class="card-label">President${S.presidentIsSpecial ? ' ⚡' : ''}</div>
        <div class="gov-name ${govPres ? '' : 'empty'}">${govPres ? esc(govPres) : '—'}</div>
      </div>
      <div class="gov-cell">
        <div class="card-label">Chancellor</div>
        <div class="gov-name ${govChan ? '' : 'empty'}">${govChan ? esc(govChan) : '—'}</div>
      </div>
    </div>

    <div class="track lib">
      <div class="track-head"><span class="track-title">Liberal</span><span class="track-meta">${S.liberalPolicies}/5</span></div>
      <div class="slots">${libSlots}</div>
    </div>

    <div class="track fas">
      <div class="track-head"><span class="track-title">Fascist</span><span class="track-meta">${S.fascistPolicies}/6${S.vetoUnlocked ? ' · veto' : ''}</span></div>
      <div class="slots">${fasSlots}</div>
    </div>

    <div class="tracker">
      <div class="card-label">Election tracker</div>
      <div class="tracker-dots">${trackerDots}</div>
    </div>

    <div class="card">
      <div class="card-label">Players · draw ${S.drawCount} · discard ${S.discardCount}</div>
      <div class="players-grid">${renderPlayerChips()}</div>
    </div>
  `;
}

function renderTrackSlots(kind, filled, total, powers) {
  let html = '';
  for (let i = 0; i < total; i++) {
    const isFilled = i < filled;
    const isWin = i === total - 1;
    let pw = '';
    if (kind === 'fas' && powers && i < 5 && powers[i]) {
      pw = `<span class="pw">${POWER_LABEL[powers[i]].replace(' ', '<br>')}</span>`;
    }
    if (kind === 'fas' && i === 5) pw = '<span class="pw">F WIN</span>';
    if (kind === 'lib' && i === 4) pw = '<span class="pw">L WIN</span>';
    html += `<div class="slot ${isFilled ? 'filled' : ''} ${isWin ? 'win' : ''}">${pw}</div>`;
  }
  return html;
}

function renderPlayerChips() {
  return (app.pub.players || []).map((p) => {
    const cls = ['pchip'];
    if (!p.alive) cls.push('dead');
    if (p.isPresident) cls.push('pres');
    else if (p.isChancellor) cls.push('chan');
    let tag = '';
    if (p.isPresident) tag = '<span class="role-mini">PRES</span>';
    else if (p.isChancellor) tag = '<span class="role-mini">CHAN</span>';
    else if (p.isNominee) tag = '<span class="role-mini">NOM</span>';
    else if (!p.connected) tag = '<span class="role-mini">OFFLINE</span>';
    return `<span class="${cls.join(' ')}">${esc(p.name)}${tag}</span>`;
  }).join('');
}

/* ---------------- private role card (peek overlay only) ---------------- */
function roleCardHTML(you) {
  if (!you || !you.role) return '';
  const roleNames = { liberal: 'Liberal', fascist: 'Fascist', hitler: 'Hitler' };
  const icon = { liberal: 'L', fascist: 'F', hitler: 'H' }[you.role];
  let sub = '';
  if (you.role === 'liberal') sub = 'Enact 5 Liberal policies, or expose Hitler.';
  else if (you.role === 'fascist') sub = 'Help enact 6 Fascist policies — or get Hitler elected.';
  else sub = 'Stay hidden. If elected Chancellor after 3 Fascist policies, you win.';

  let allies = '';
  if (you.knownAllies && you.knownAllies.length) {
    allies = `<div class="role-sub">Allies: ${you.knownAllies
      .map((a) => `${esc(a.name)} <i>(${esc(a.label)})</i>`).join(', ')}</div>`;
  }
  return `
    <div class="role-card ${you.role}">
      <div class="role-icon">${icon}</div>
      <div class="role-text">
        <div class="role-name">${roleNames[you.role]}${you.alive ? '' : ' · dead'}</div>
        <div class="role-sub">${sub}</div>
        ${allies}
      </div>
    </div>`;
}

function updatePeekUI() {
  const you = app.priv;
  const S = app.pub;
  const inGame = !!(you && you.role && S && S.phase !== PHASES.LOBBY && S.phase !== PHASES.GAMEOVER);
  document.body.classList.toggle('in-game', inGame);
  $('peekBar').classList.toggle('hidden', !inGame);
  if (inGame) $('peekCode').textContent = app.code || '----';
  else hideRolePeek();
}

function showRolePeek() {
  const you = app.priv;
  if (!you || !you.role) return;
  $('roleRevealInner').innerHTML = roleCardHTML(you);
  $('roleReveal').classList.remove('hidden');
}

function hideRolePeek() {
  const r = $('roleReveal');
  if (r) r.classList.add('hidden');
}

/* ---------------- action panel (phase machine) ---------------- */
function renderAction() {
  const S = app.pub;
  const you = app.priv;
  const el = $('action');
  if (!you) { el.innerHTML = ''; return; }

  switch (S.phase) {
    case PHASES.REVEAL: return panelReveal(el, S, you);
    case PHASES.NOMINATION: return panelNomination(el, S, you);
    case PHASES.ELECTION: return panelElection(el, S, you);
    case PHASES.ELECTION_RESULT: return panelElectionResult(el, S, you);
    case PHASES.LEG_PRESIDENT: return panelLegPresident(el, S, you);
    case PHASES.LEG_CHANCELLOR: return panelLegChancellor(el, S, you);
    case PHASES.VETO_PROMPT: return panelVeto(el, S, you);
    case PHASES.EXECUTIVE: return panelExecutive(el, S, you);
    case PHASES.GAMEOVER: return panelGameOver(el, S, you);
    default: el.innerHTML = '';
  }
}

function panel(kicker, title, bodyHtml, actionsHtml) {
  return `<div class="panel">
    <div class="panel-kicker">${kicker}</div>
    <div class="panel-title">${title}</div>
    ${bodyHtml ? `<div class="panel-body">${bodyHtml}</div>` : ''}
    ${actionsHtml ? `<div class="panel-actions">${actionsHtml}</div>` : ''}
  </div>`;
}

function waitingPanel(kicker, title, body) {
  return `<div class="panel"><div class="panel-kicker">${kicker}</div>
    <div class="panel-title">${title}</div>
    <div class="waiting"><div class="spinner"></div><div class="panel-body">${body}</div></div></div>`;
}

function panelReveal(el, S, you) {
  if (you.ready) {
    el.innerHTML = waitingPanel('Setup', 'Role memorised', 'Waiting for everyone to be ready…');
    return;
  }
  el.innerHTML = panel('Setup', 'Check your secret role',
    'Hold the <b>“view your secret role”</b> button at the bottom of the screen to see your role privately. Memorise it, then tap below — the game begins when everyone is ready.',
    '<button class="btn btn-primary" id="aReady">I\'ve memorised my role</button>');
  $('aReady').onclick = () => net.send({ t: 'ready' });
}

function panelNomination(el, S, you) {
  if (!you.isPresident) {
    el.innerHTML = waitingPanel('Election', 'Nomination',
      `${esc(nameOf(S.presidentId))} is choosing a Chancellor…`);
    return;
  }
  const opts = (you.eligibleChancellors || []).map((id) =>
    `<button class="opt" data-k="${esc(id)}">${esc(nameOf(id))}</button>`).join('');
  el.innerHTML = panel('Election', 'Nominate a Chancellor',
    "Term-limited and dead players can't be picked.",
    `<div class="select-list">${opts}</div>`);
  wireTargets(el, (id) => net.send({ t: 'nominate', targetId: id }));
}

function panelElection(el, S, you) {
  const w = S.voteWaiting;
  const wait = w ? `${w.voted}/${w.total} voted` : '';
  const pendingNames = ((w && w.pending) || []).map((id) => esc(nameOf(id)));
  const stillOut = pendingNames.length
    ? `<div class="wait-names">Waiting on: ${pendingNames.join(', ')}</div>`
    : '<div class="wait-names">All votes are in…</div>';
  const presN = esc(nameOf(S.presidentId));
  const chanN = esc(nameOf(S.nomineeId));

  if (!you.alive) {
    el.innerHTML = waitingPanel('Vote', 'Election under way',
      `Government: ${presN} / ${chanN}. ${wait}${stillOut}`);
    return;
  }
  // Votes stay changeable until the last one is in, so the buttons remain live
  // and the current choice is highlighted rather than locked.
  const govLine = `President <b>${presN}</b> &nbsp;·&nbsp; Chancellor <b>${chanN}</b>`;
  const body = you.hasVoted
    ? `${govLine}<span class="vote-changeable">You voted <b>${you.myVote === 'ja' ? 'Ja' : 'Nein'}</b> — tap to change until everyone has voted.</span>`
    : govLine;
  el.innerHTML = panel('Vote', 'Elect this government?', body,
    `<div class="vote-row">
      <button class="vote-btn ja ${you.myVote === 'ja' ? 'sel' : ''}" id="vJa">Ja</button>
      <button class="vote-btn nein ${you.myVote === 'nein' ? 'sel' : ''}" id="vNein">Nein</button>
    </div>${stillOut}`);
  $('vJa').onclick = () => net.send({ t: 'vote', vote: 'ja' });
  $('vNein').onclick = () => net.send({ t: 'vote', vote: 'nein' });
}

function panelElectionResult(el, S, you) {
  const votesHtml = S.lastVotes ? Object.keys(S.lastVotes).map((id) =>
    `<span class="vres">${esc(nameOf(id))}<span class="v ${esc(S.lastVotes[id])}">${S.lastVotes[id] === 'ja' ? 'Ja' : 'Nein'}</span></span>`
  ).join('') : '';
  const outcome = S.lastOutcome === 'pass'
    ? '<div class="outcome pass">Government elected</div>'
    : '<div class="outcome fail">Rejected</div>';
  el.innerHTML = panel('Vote result', 'The votes are in',
    `<div class="vote-results">${votesHtml}</div>${outcome}`,
    you.isPresident
      ? '<button class="btn btn-primary" id="aCont">Continue</button>'
      : `<div class="hint-row">Waiting for ${esc(nameOf(S.presidentId))}…</div>`);
  if (you.isPresident) $('aCont').onclick = () => net.send({ t: 'continueResult' });
}

function panelLegPresident(el, S, you) {
  if (!you.isPresident) {
    el.innerHTML = waitingPanel('Legislative session', 'President is legislating',
      `${esc(nameOf(S.presidentId))} is discarding one policy in secret…`);
    return;
  }
  el.innerHTML = panel('Legislative session', 'Discard one policy',
    'These three are secret. Tap one to <b>discard</b> it; the other two pass to the Chancellor.',
    `${renderHand(you.presCards)}<div class="hand-hint">Tap a card to discard it</div>`);
  wireHand(el, (idx) => net.send({ t: 'presDiscard', index: idx }));
}

function panelLegChancellor(el, S, you) {
  if (!you.isChancellor) {
    el.innerHTML = waitingPanel('Legislative session', 'Chancellor is legislating',
      `${esc(nameOf(S.chancellorId))} is enacting a policy in secret…`);
    return;
  }
  const canVeto = you.vetoUnlocked && !you.vetoUsedThisGov;
  el.innerHTML = panel('Legislative session', 'Enact one policy',
    `Tap a card to <b>enact</b> it onto its track. The other is discarded.${canVeto ? ' Or propose a veto to discard both.' : ''}`,
    `${renderHand(you.chanCards)}<div class="hand-hint">Tap a card to enact it</div>${
      canVeto ? '<div style="margin-top:14px"><button class="btn" id="aVeto">Propose veto</button></div>' : ''}`);
  wireHand(el, (idx) => net.send({ t: 'chanEnact', index: idx }));
  if (canVeto) $('aVeto').onclick = () => net.send({ t: 'proposeVeto' });
}

function panelVeto(el, S, you) {
  if (you.isPresident) {
    el.innerHTML = panel('Veto', 'Chancellor proposes a veto',
      'Agree to discard <b>both</b> policies (counts as a failed government, tracker advances), or reject and force the Chancellor to enact one.',
      `<div class="btn-row">
        <button class="btn btn-danger" id="aVetoYes">Agree to veto</button>
        <button class="btn" id="aVetoNo">Reject</button>
      </div>`);
    $('aVetoYes').onclick = () => net.send({ t: 'vetoResponse', consent: true });
    $('aVetoNo').onclick = () => net.send({ t: 'vetoResponse', consent: false });
  } else if (you.isChancellor) {
    el.innerHTML = waitingPanel('Veto', 'Veto proposed', `Waiting for ${esc(nameOf(S.presidentId))} to respond…`);
  } else {
    el.innerHTML = waitingPanel('Veto', 'Veto proposed', 'The government is considering a veto…');
  }
}

function panelExecutive(el, S, you) {
  const power = S.pendingPower;
  if (!you.isPresident) {
    el.innerHTML = waitingPanel('Executive action', POWER_LABEL[power] || 'Presidential power',
      `${esc(nameOf(S.presidentId))} is using a presidential power…`);
    return;
  }

  if (power === 'peek') {
    const cards = you.peek || [];
    el.innerHTML = panel('Executive action', 'Policy Peek',
      'The top three policies of the draw pile, in order (top first). For your eyes only.',
      `<div class="hand">${cards.map(cardFace).join('')}</div>
       <div class="panel-actions"><button class="btn btn-primary" id="aDone">Done</button></div>`);
    $('aDone').onclick = () => net.send({ t: 'powerDone' });
    return;
  }

  if (power === 'investigate') {
    if (you.investigation) {
      const party = you.investigation.party;
      el.innerHTML = panel('Executive action', 'Investigation result',
        `<div class="reveal"><div class="big">${esc(you.investigation.name)} is a <span class="${party === 'Liberal' ? 'lib' : 'fas'}">${esc(party)}</span></div></div>
         This reveals party membership only — never whether they are Hitler. For your eyes only.`,
        '<button class="btn btn-primary" id="aDone">Done</button>');
      $('aDone').onclick = () => net.send({ t: 'powerDone' });
      return;
    }
    el.innerHTML = panel('Executive action', 'Investigate Loyalty',
      'Choose a player to inspect their party membership. Each player can be investigated only once per game.',
      `<div class="select-list">${targetOptions(you, { excludeInvestigated: true })}</div>`);
    wireTargets(el, (id) => net.send({ t: 'power', targetId: id }));
    return;
  }

  if (power === 'special') {
    el.innerHTML = panel('Executive action', 'Special Election',
      'Choose any living player to be the <b>next</b> Presidential candidate. Normal order resumes afterward.',
      `<div class="select-list">${targetOptions(you, {})}</div>`);
    wireTargets(el, (id) => net.send({ t: 'power', targetId: id }));
    return;
  }

  if (power === 'execution') {
    el.innerHTML = panel('Executive action', 'Execution',
      'Choose a player to execute. They are removed from the game and their role stays hidden. If they were Hitler, Liberals win.',
      `<div class="select-list">${targetOptions(you, {})}</div>`);
    wireTargets(el, (id) => net.send({ t: 'power', targetId: id }));
  }
}

function panelGameOver(el, S) {
  const cls = S.winner === 'liberal' ? 'lib' : 'fas';
  const title = S.winner === 'liberal' ? 'Liberals win' : 'Fascists win';
  const roles = (S.revealRoles || []).map((r) =>
    `<div class="rr">${esc(r.name)}<span class="rr-role ${esc(r.role)}">${esc(r.role)}</span></div>`).join('');
  const host = amHost();
  el.innerHTML = `<div class="gameover ${cls}">
    <div class="panel-kicker">${esc(S.winReason)}</div>
    <h2>${title}</h2>
    <div class="reveal-roles">${roles}</div>
    <div class="panel-actions" style="margin-top:20px">${
      host ? '<button class="btn btn-primary" id="aAgain">Play again</button>'
           : '<div class="hint-row">Waiting for the host to start a new game…</div>'
    }</div>
  </div>`;
  if (host) $('aAgain').onclick = () => net.send({ t: 'playAgain' });
}

/* ---------------- render helpers ---------------- */
function cardFace(c) {
  return `<div class="pcard ${c === 'L' ? 'L' : 'F'}"><span class="pcard-mark">${c === 'L' ? 'L' : 'F'}</span>${c === 'L' ? 'Liberal' : 'Fascist'}</div>`;
}

function renderHand(cards) {
  if (!cards) return '';
  return `<div class="hand">${cards.map((c, i) =>
    `<div class="pcard ${c === 'L' ? 'L' : 'F'}" data-i="${i}"><span class="pcard-mark">${c === 'L' ? 'L' : 'F'}</span>${c === 'L' ? 'Liberal' : 'Fascist'}</div>`
  ).join('')}</div>`;
}

function wireHand(el, cb) {
  const cards = el.querySelectorAll('.pcard[data-i]');
  cards.forEach((card) => {
    card.onclick = () => {
      if (card.classList.contains('locked')) return;
      cards.forEach((c) => c.classList.add('locked'));
      cb(parseInt(card.dataset.i, 10));
    };
  });
}

function targetOptions(you, opts) {
  return (app.pub.players || []).filter((p) => p.alive && p.id !== you.id).map((p) => {
    const disabled = opts.excludeInvestigated && p.investigated;
    return `<button class="opt" data-k="${esc(p.id)}" ${disabled ? 'disabled' : ''}>${esc(p.name)}${
      disabled ? '<span class="opt-meta">investigated</span>' : ''}</button>`;
  }).join('');
}

function wireTargets(el, cb) {
  el.querySelectorAll('.opt[data-k]').forEach((b) => {
    b.onclick = () => { if (!b.disabled) cb(b.dataset.k); };
  });
}

// The engine stamps log entries with epoch ms because the server runs in a UTC
// container — the wall-clock time has to be formed here, in the viewer's zone.
function logTime(t) {
  const d = new Date(Number(t));
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLog() {
  $('logList').innerHTML = ((app.pub && app.pub.log) || []).map((e) =>
    `<li><span class="lt">${logTime(e.t)}</span>${esc(e.text)}</li>`).join('');
}

function nameOf(id) {
  const list = (app.pub && app.pub.players) || [];
  const p = list.find((x) => x.id === id);
  if (p) return p.name;
  const lob = ((app.pub && app.pub.lobbyPlayers) || []).find((x) => x.id === id);
  return lob ? lob.name : '?';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ============================================================
   UI WIRING
   ============================================================ */
function getName() {
  const v = $('nameInput').value.trim();
  return v ? cleanName(v) : '';
}

function wireUI() {
  $('btnCreate').onclick = async () => {
    const name = getName();
    if (!name) { toast('Enter your name first.'); $('nameInput').focus(); return; }
    $('btnCreate').disabled = true;
    await net.createLocal(name);
    $('btnCreate').disabled = false;
  };

  $('btnCreateServer').onclick = () => {
    const name = getName();
    if (!name) { toast('Enter your name first.'); $('nameInput').focus(); return; }
    net.createOnServer(name);
  };

  $('btnJoin').onclick = async () => {
    const name = getName();
    const code = $('codeInput').value.trim().toUpperCase();
    if (!name) { toast('Enter your name first.'); $('nameInput').focus(); return; }
    if (code.length !== 4) { toast('Enter the 4-letter room code.'); $('codeInput').focus(); return; }
    $('btnJoin').disabled = true;
    await net.joinRoom(name, code);
    $('btnJoin').disabled = false;
  };

  $('btnStart').onclick = () => net.send({ t: 'start' });
  $('btnLeaveLobby').onclick = () => net.leaveRoom();
  $('btnLeaveGame').onclick = () => { if (confirm('Leave the game?')) net.leaveRoom(); };
  $('btnNetRetry').onclick = () => net.retryNow();

  // A failed probe is usually a slow network, not an outage — let them re-ask.
  const reprobe = () => { if (app.serverProbe === 'down') net.probeServer(); };
  $('serverPill').onclick = reprobe;
  $('serverPill').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reprobe(); } };

  $('codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  wirePeek();
  wireRules();
}

// Hold-to-peek: the secret role is on screen only while the button is pressed.
function wirePeek() {
  const btn = $('peekBtn');
  const press = (e) => { e.preventDefault(); showRolePeek(); };
  const release = () => hideRolePeek();
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
  // Fallbacks for browsers without pointer events.
  btn.addEventListener('touchstart', press, { passive: false });
  btn.addEventListener('touchend', release);
  btn.addEventListener('mousedown', press);
  btn.addEventListener('mouseup', release);
  btn.addEventListener('mouseleave', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  $('roleReveal').addEventListener('pointerdown', release);
  // Never leave a role on screen if focus or visibility is lost.
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
}

function wireRules() {
  $('rulesBody').innerHTML = RULES_HTML();
  const open = () => $('rulesModal').classList.remove('hidden');
  const close = () => $('rulesModal').classList.add('hidden');
  document.querySelectorAll('.js-rules').forEach((b) => { b.onclick = open; });
  $('btnCloseRules').onclick = close;
  $('rulesModal').addEventListener('click', (e) => { if (e.target.id === 'rulesModal') close(); });
}

function RULES_HTML() {
  return `
    <h3>Goal</h3>
    <ul>
      <li><b>Liberals</b> win by enacting 5 Liberal policies, or by executing Hitler.</li>
      <li><b>Fascists</b> win by enacting 6 Fascist policies, or by electing Hitler as Chancellor once 3+ Fascist policies are on the board.</li>
    </ul>
    <h3>Roles</h3>
    <ul>
      <li>Each device sees only its own role. Fascists know each other and know Hitler.</li>
      <li>In 5–6 player games Hitler also learns who the Fascist is; in 7–10 player games Hitler is in the dark.</li>
    </ul>
    <h3>Each round</h3>
    <ul>
      <li><b>Election:</b> the President nominates a Chancellor, then everyone votes Ja/Nein. A strict majority of Ja passes (ties fail).</li>
      <li>The last <i>elected</i> President and Chancellor can't be nominated as Chancellor (when only 5 are alive, only the last Chancellor is blocked).</li>
      <li><b>Legislative session:</b> the President draws 3 policies and discards 1 in secret; the Chancellor enacts 1 of the remaining 2.</li>
      <li>3 failed elections in a row throws the country into chaos: the top policy is enacted automatically and term limits reset.</li>
    </ul>
    <h3>Presidential powers</h3>
    <ul>
      <li>Some Fascist track slots grant the President a one-time power: Investigate Loyalty, Special Election, Policy Peek, or Execution. Which slots depends on player count.</li>
      <li>Once 5 Fascist policies are enacted, the Chancellor may propose a <b>veto</b>.</li>
    </ul>
    <h3>Hosting</h3>
    <ul>
      <li><b>Host on this phone</b> needs no server — everyone must be on the same Wi-Fi, and the host's tab has to stay open.</li>
      <li><b>Host on server</b> appears when a shared server is reachable. Players can then join from anywhere, and no one device has to stay awake.</li>
      <li>If you drop, your seat is held. Rejoin from the <i>same device and browser</i> to reclaim it — your role is tied to the device, not to your name.</li>
    </ul>
    <h3>Privacy</h3>
    <ul>
      <li>Drawn policies show only on the President's / Chancellor's device. Investigations and peeks show only on the acting President's device.</li>
    </ul>`;
}

/* ============================================================
   BOOT
   ============================================================ */
net.bind({ render, toast, home: showHome });
wireUI();

// Resume BEFORE the probe is started: a room that already exists must not have
// its transport decided by whichever health check happens to resolve first.
if (!net.tryResume()) showHome(null);
render();
if (serverConfigured()) net.probeServer();
