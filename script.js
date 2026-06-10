/* ============================================================
   Secret Hitler — local (P2P over PeerJS / WebRTC)
   Host-authoritative model mirrored from localmafia.

   - Host's PeerJS id IS the 4-char room code.
   - Clients connect to that id.
   - Host holds full authoritative state; broadcasts a personalised
     PUBLIC+private snapshot to each device. Hidden info only ever
     reaches the device entitled to see it.
   ============================================================ */
(function () {
  "use strict";

  const APP_VERSION = 1;
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/I/0/1
  const $ = (id) => document.getElementById(id);

  /* ---------------- Rules data ---------------- */

  // [liberals, fascists(excl. hitler)] ; hitler always 1
  const ROLE_DIST = {
    5:  [3, 1], 6:  [4, 1], 7:  [4, 2],
    8:  [5, 2], 9:  [5, 3], 10: [6, 3],
  };

  // Power granted as the Nth fascist policy (1..5) is enacted, by player count.
  const POWER_TRACK = {
    5:  [null, null, "peek", "execution", "execution"],
    6:  [null, null, "peek", "execution", "execution"],
    7:  [null, "investigate", "special", "execution", "execution"],
    8:  [null, "investigate", "special", "execution", "execution"],
    9:  ["investigate", "investigate", "special", "execution", "execution"],
    10: ["investigate", "investigate", "special", "execution", "execution"],
  };

  const POWER_LABEL = {
    investigate: "Investigate Loyalty",
    special: "Special Election",
    peek: "Policy Peek",
    execution: "Execution",
  };

  function randCode4() {
    return Array.from({ length: 4 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join("");
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ============================================================
     GLOBAL CLIENT/HOST STATE (per device)
     ============================================================ */
  let peer = null;
  let isHost = false;
  let myKey = null;        // stable player key (host: roomCode)
  let myName = "";
  let roomCode = null;

  // Host-side
  let hostState = null;
  const conns = new Map();  // connId -> DataConnection

  // Client-side
  let hostConn = null;
  let publicState = null;   // last snapshot received (or built locally if host)
  let reconnectTimer = null;

  /* ============================================================
     PEER SETUP
     ============================================================ */
  function createPeerWithId(idOrNull) {
    return new Promise((resolve, reject) => {
      try { if (peer) peer.destroy(); } catch (e) {}
      peer = idOrNull ? new Peer(idOrNull) : new Peer();
      let settled = false;
      peer.on("open", (id) => { settled = true; resolve(id); });
      peer.on("error", (err) => {
        if (!settled) reject(err);
        else handlePeerError(err);
      });
    });
  }

  function handlePeerError(err) {
    console.warn("peer error", err);
    if (err && err.type === "peer-unavailable") {
      if (!isHost) toast("Host unavailable. Trying to reconnect…");
    }
  }

  /* ---------------- HOST: create game ---------------- */
  async function hostCreateGame(name) {
    isHost = true;
    myName = name;
    let code = null;
    for (let attempt = 0; attempt < 14; attempt++) {
      const candidate = randCode4();
      try {
        await createPeerWithId(candidate);
        code = candidate;
        break;
      } catch (e) {
        // id taken — try another
      }
    }
    if (!code) { toast("Could not create a room. Try again."); return; }

    roomCode = code;
    myKey = code;
    hostState = newHostState(code);
    // add host as first player
    addOrReconnectPlayer(code, name, null);

    peer.on("connection", onHostConnection);

    showLobby();
    renderAll();
  }

  function onHostConnection(conn) {
    conn.on("open", () => {
      conns.set(conn.peer, conn);
    });
    conn.on("data", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "join") {
        const key = addOrReconnectPlayer(conn.peer, String(msg.name || "Player").slice(0, 14), conn.peer);
        conn.send({ t: "joined", youKey: key, roomCode });
        broadcast();
        return;
      }
      // all gameplay actions route through one handler, keyed by sender
      const key = connIdToKey(conn.peer);
      if (key) handleAction(key, msg);
    });
    conn.on("close", () => { onConnLost(conn.peer); });
    conn.on("error", () => { onConnLost(conn.peer); });
  }

  function connIdToKey(connId) {
    for (const k in hostState.players) {
      if (hostState.players[k].connId === connId) return k;
    }
    return null;
  }

  function onConnLost(connId) {
    conns.delete(connId);
    const key = connIdToKey(connId);
    if (key && hostState.players[key]) {
      hostState.players[key].connected = false;
    }
    broadcast();
  }

  /* ---------------- CLIENT: join game ---------------- */
  async function clientJoin(name, code) {
    isHost = false;
    myName = name;
    roomCode = code;
    try {
      await createPeerWithId(null);
    } catch (e) {
      toast("Network error. Check connection.");
      return;
    }
    connectToHost();
  }

  function connectToHost() {
    if (!peer || peer.destroyed) return;
    hostConn = peer.connect(roomCode, {
      reliable: true, serialization: "json", metadata: { v: APP_VERSION },
    });

    let opened = false;
    hostConn.on("open", () => {
      opened = true;
      hostConn.send({ t: "join", name: myName, v: APP_VERSION });
    });
    hostConn.on("data", onClientData);
    hostConn.on("close", () => { scheduleReconnect(); });
    hostConn.on("error", () => { if (!opened) toast("Room not found."); scheduleReconnect(); });
  }

  function scheduleReconnect() {
    if (isHost) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isHost && roomCode) {
        toast("Reconnecting…");
        connectToHost();
      }
    }, 1500);
  }

  function onClientData(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "joined":
        myKey = msg.youKey;
        roomCode = msg.roomCode;
        break;
      case "state":
        publicState = msg.state;
        routeView();
        renderGame();
        break;
      case "toast":
        toast(msg.msg);
        break;
    }
  }

  function clientSend(msg) {
    if (hostConn && hostConn.open) hostConn.send(msg);
  }

  /* ---------------- unified action dispatch ---------------- */
  // Host calls this directly for its own actions; clients send over the wire.
  function dispatch(msg) {
    if (isHost) handleAction(myKey, msg);
    else clientSend(msg);
  }

  /* ============================================================
     HOST STATE + GAME LOGIC
     ============================================================ */
  function newHostState(code) {
    return {
      roomCode: code,
      phase: "lobby",                 // lobby | reveal | nomination | election | electionResult |
                                      // legPresident | legChancellor | vetoPrompt | executive | gameover
      players: {},                    // key -> player
      seatOrder: [],                  // array of keys, fixed at game start
      numPlayers: 0,

      rotationSeat: 0,                // seat index of the regular-rotation president
      firstRound: false,              // first round uses the seeded president (no advance)
      presidentKey: null,
      chancellorKey: null,
      presidentIsSpecial: false,
      nomineeKey: null,
      specialElectionTargetKey: null,

      lastElectedPresidentKey: null,
      lastElectedChancellorKey: null,

      votes: {},                      // key -> 'ja'|'nein'
      lastVotes: null,                // snapshot for reveal
      lastOutcome: null,              // 'pass'|'fail'

      liberalPolicies: 0,
      fascistPolicies: 0,
      electionTracker: 0,
      vetoUnlocked: false,
      vetoUsedThisGov: false,

      drawPile: [],
      discardPile: [],
      presidentDraw: [],              // 3 cards (president only)
      chancellorCards: [],            // 2 cards (chancellor only)
      vetoProposed: false,

      pendingPower: null,             // power string during 'executive'
      peekCards: null,                // top-3 for president
      investigation: null,            // {byKey, name, party}

      winner: null,                   // 'liberal'|'fascist'
      winReason: "",

      log: [],
    };
  }

  function addOrReconnectPlayer(connId, name, connIdForSend) {
    // Reconnect: match a disconnected player by (case-insensitive) name.
    const lname = name.toLowerCase();
    for (const k in hostState.players) {
      const p = hostState.players[k];
      if (!p.connected && p.name.toLowerCase() === lname) {
        p.connected = true;
        p.connId = connIdForSend;
        return k;
      }
    }
    // New player only allowed in lobby
    if (hostState.phase !== "lobby") {
      // Late join after start is rejected silently (they’ll just see nothing).
      return null;
    }
    if (Object.keys(hostState.players).length >= 10) return null;

    const key = connId; // first-seen peer id becomes the stable key
    hostState.players[key] = {
      key,
      connId: connIdForSend,
      name,
      isHost: connIdForSend === null,
      connected: true,
      alive: true,
      role: null,
      party: null,
      investigated: false,
      knownAllies: null,
      ready: false,
    };
    return key;
  }

  function livingKeys() {
    return hostState.seatOrder.filter((k) => hostState.players[k].alive);
  }
  function livingCount() { return livingKeys().length; }

  function nextLivingSeatAfter(seat) {
    const n = hostState.seatOrder.length;
    for (let i = 1; i <= n; i++) {
      const s = (seat + i) % n;
      if (hostState.players[hostState.seatOrder[s]].alive) return s;
    }
    return seat;
  }

  function pushLog(text) {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    hostState.log.unshift({ ts, text });
    if (hostState.log.length > 60) hostState.log.pop();
  }

  /* ---------------- start / role assignment ---------------- */
  function hostStartGame() {
    const keys = Object.keys(hostState.players);
    if (keys.length < 5 || keys.length > 10) {
      toast("Need 5–10 players to start.");
      return;
    }
    const n = keys.length;
    hostState.numPlayers = n;
    hostState.seatOrder = shuffle(keys); // randomise seating order

    // Build & assign roles
    const [libs, fas] = ROLE_DIST[n];
    let roles = [];
    for (let i = 0; i < libs; i++) roles.push("liberal");
    for (let i = 0; i < fas; i++) roles.push("fascist");
    roles.push("hitler");
    roles = shuffle(roles);

    hostState.seatOrder.forEach((k, i) => {
      const p = hostState.players[k];
      p.role = roles[i];
      p.party = roles[i] === "liberal" ? "Liberal" : "Fascist";
      p.alive = true;
      p.investigated = false;
      p.ready = false;
      p.knownAllies = null;
    });

    // Knowledge: fascists know each other + Hitler. Hitler knows the single
    // fascist only in 5–6 player games.
    const fascistKeys = hostState.seatOrder.filter((k) => hostState.players[k].role === "fascist");
    const hitlerKey = hostState.seatOrder.find((k) => hostState.players[k].role === "hitler");

    hostState.seatOrder.forEach((k) => {
      const p = hostState.players[k];
      if (p.role === "fascist") {
        p.knownAllies = [];
        fascistKeys.forEach((fk) => {
          if (fk !== k) p.knownAllies.push({ name: hostState.players[fk].name, label: "Fascist" });
        });
        p.knownAllies.push({ name: hostState.players[hitlerKey].name, label: "Hitler" });
      } else if (p.role === "hitler") {
        if (n <= 6) {
          p.knownAllies = fascistKeys.map((fk) => ({ name: hostState.players[fk].name, label: "Fascist" }));
        } else {
          p.knownAllies = null; // Hitler is in the dark in 7–10p
        }
      } else {
        p.knownAllies = null;
      }
    });

    // Policy deck: 6 Liberal + 11 Fascist
    const deck = [];
    for (let i = 0; i < 6; i++) deck.push("L");
    for (let i = 0; i < 11; i++) deck.push("F");
    hostState.drawPile = shuffle(deck);
    hostState.discardPile = [];

    // Random starting president (kept for the first round; later rounds rotate)
    hostState.rotationSeat = Math.floor(Math.random() * hostState.seatOrder.length);
    hostState.presidentKey = hostState.seatOrder[hostState.rotationSeat];
    hostState.presidentIsSpecial = false;
    hostState.firstRound = true;

    hostState.phase = "reveal";
    pushLog("Game started. Roles dealt. Memorise your secret role.");
    broadcast();
  }

  /* ---------------- deck helpers ---------------- */
  function ensureDraw(min) {
    if (hostState.drawPile.length < min) {
      hostState.drawPile = shuffle(hostState.drawPile.concat(hostState.discardPile));
      hostState.discardPile = [];
      pushLog("Draw pile reshuffled with discards.");
    }
  }

  /* ---------------- round lifecycle ---------------- */
  function beginNextRound() {
    // clear per-round transient state
    hostState.chancellorKey = null;
    hostState.nomineeKey = null;
    hostState.votes = {};
    hostState.lastVotes = null;
    hostState.lastOutcome = null;
    hostState.presidentDraw = [];
    hostState.chancellorCards = [];
    hostState.vetoProposed = false;
    hostState.vetoUsedThisGov = false;
    hostState.pendingPower = null;
    hostState.peekCards = null;
    hostState.investigation = null;

    if (hostState.firstRound) {
      // Use the president seeded at game start; do not rotate.
      hostState.firstRound = false;
      hostState.presidentIsSpecial = false;
    } else if (hostState.specialElectionTargetKey) {
      hostState.presidentKey = hostState.specialElectionTargetKey;
      hostState.specialElectionTargetKey = null;
      hostState.presidentIsSpecial = true;
    } else {
      hostState.rotationSeat = nextLivingSeatAfter(hostState.rotationSeat);
      hostState.presidentKey = hostState.seatOrder[hostState.rotationSeat];
      hostState.presidentIsSpecial = false;
    }
    hostState.phase = "nomination";
    pushLog(`${pname(hostState.presidentKey)} is President. Nominate a Chancellor.`);
  }

  function pname(key) { return hostState.players[key] ? hostState.players[key].name : "?"; }

  function isEligibleChancellor(candidateKey) {
    const p = hostState.players[candidateKey];
    if (!p || !p.alive) return false;
    if (candidateKey === hostState.presidentKey) return false;
    if (candidateKey === hostState.lastElectedChancellorKey) return false;
    // President term-limit only applies when more than 5 players are alive.
    if (livingCount() > 5 && candidateKey === hostState.lastElectedPresidentKey) return false;
    return true;
  }

  /* ---------------- win checks ---------------- */
  function checkPolicyWin() {
    if (hostState.liberalPolicies >= 5) { return endGame("liberal", "Five Liberal policies enacted."); }
    if (hostState.fascistPolicies >= 6) { return endGame("fascist", "Six Fascist policies enacted."); }
    return false;
  }

  function endGame(winner, reason) {
    hostState.winner = winner;
    hostState.winReason = reason;
    hostState.phase = "gameover";
    pushLog(`${winner === "liberal" ? "LIBERALS" : "FASCISTS"} win — ${reason}`);
    return true;
  }

  /* ---------------- enact policy ---------------- */
  // fromChaos = enacted by the election tracker (no power, no credit)
  function enactPolicy(card, fromChaos) {
    if (card === "L") {
      hostState.liberalPolicies++;
      pushLog(`A Liberal policy was enacted. (${hostState.liberalPolicies}/5)`);
    } else {
      hostState.fascistPolicies++;
      if (hostState.fascistPolicies >= 5) hostState.vetoUnlocked = true;
      pushLog(`A Fascist policy was enacted. (${hostState.fascistPolicies}/6)`);
    }

    if (checkPolicyWin()) return;

    if (card === "F" && !fromChaos) {
      const power = POWER_TRACK[hostState.numPlayers][hostState.fascistPolicies - 1];
      if (power) {
        hostState.pendingPower = power;
        hostState.phase = "executive";
        pushLog(`Presidential power unlocked: ${POWER_LABEL[power]}.`);
        if (power === "peek") {
          ensureDraw(3);
          hostState.peekCards = hostState.drawPile.slice(0, 3);
        }
        return;
      }
    }
    // no power → next round
    beginNextRound();
  }

  /* ---------------- election tracker / chaos ---------------- */
  function advanceTrackerForFailure() {
    hostState.electionTracker++;
    pushLog(`Election failed. Tracker at ${hostState.electionTracker}/3.`);
    if (hostState.electionTracker >= 3) {
      // Country thrown into chaos: enact the top policy, no power, reset, clear limits.
      ensureDraw(1);
      const top = hostState.drawPile.shift();
      hostState.electionTracker = 0;
      hostState.lastElectedPresidentKey = null;
      hostState.lastElectedChancellorKey = null;
      pushLog("Three failed elections — the country is thrown into chaos!");
      enactPolicy(top, true);
      // term-limits already cleared; if enactPolicy didn't end game or open a
      // power (it can't on chaos), it already called beginNextRound().
      return true;
    }
    return false;
  }

  /* ============================================================
     ACTION HANDLER (authoritative, host-only execution)
     ============================================================ */
  function handleAction(fromKey, msg) {
    if (!isHost) return; // only host mutates state
    const S = hostState;
    const me = S.players[fromKey];
    if (!me) return;

    switch (msg.t) {
      case "ready": {
        if (S.phase !== "reveal") break;
        me.ready = true;
        const allReady = livingKeys().every((k) => S.players[k].ready);
        if (allReady) {
          beginNextRound();
        }
        break;
      }

      case "nominate": {
        if (S.phase !== "nomination" || fromKey !== S.presidentKey) break;
        if (!isEligibleChancellor(msg.targetKey)) { toastTo(fromKey, "That player isn't eligible."); break; }
        S.nomineeKey = msg.targetKey;
        S.votes = {};
        S.phase = "election";
        pushLog(`${pname(S.presidentKey)} nominates ${pname(msg.targetKey)} for Chancellor.`);
        break;
      }

      case "vote": {
        if (S.phase !== "election") break;
        if (!me.alive) break;
        if (msg.vote !== "ja" && msg.vote !== "nein") break;
        S.votes[fromKey] = msg.vote;
        const living = livingKeys();
        const allVoted = living.every((k) => S.votes[k]);
        if (allVoted) resolveElection();
        break;
      }

      case "continueResult": {
        if (S.phase !== "electionResult") break;
        if (fromKey !== S.presidentKey) break;
        applyElectionOutcome();
        break;
      }

      case "presDiscard": {
        if (S.phase !== "legPresident" || fromKey !== S.presidentKey) break;
        const idx = msg.index;
        if (idx == null || idx < 0 || idx >= S.presidentDraw.length) break;
        const remaining = S.presidentDraw.slice();
        const discarded = remaining.splice(idx, 1)[0];
        S.discardPile.push(discarded);
        S.chancellorCards = remaining;        // 2 cards to chancellor
        S.presidentDraw = [];
        S.phase = "legChancellor";
        pushLog(`${pname(S.presidentKey)} passed two policies to ${pname(S.chancellorKey)}.`);
        break;
      }

      case "chanEnact": {
        if (S.phase !== "legChancellor" || fromKey !== S.chancellorKey) break;
        const idx = msg.index;
        if (idx == null || idx < 0 || idx >= S.chancellorCards.length) break;
        const remaining = S.chancellorCards.slice();
        const enacted = remaining.splice(idx, 1)[0];
        S.discardPile.push(remaining[0]);     // the other is discarded
        S.chancellorCards = [];
        // credit lastElected already set on pass
        enactPolicy(enacted, false);
        break;
      }

      case "proposeVeto": {
        if (S.phase !== "legChancellor" || fromKey !== S.chancellorKey) break;
        if (!S.vetoUnlocked || S.vetoUsedThisGov) break;
        S.vetoProposed = true;
        S.phase = "vetoPrompt";
        pushLog(`${pname(S.chancellorKey)} proposes a VETO.`);
        break;
      }

      case "vetoResponse": {
        if (S.phase !== "vetoPrompt" || fromKey !== S.presidentKey) break;
        S.vetoProposed = false;
        S.vetoUsedThisGov = true;
        if (msg.consent) {
          // Both discarded; treated as a failed government for the tracker.
          S.discardPile.push(...S.chancellorCards);
          S.chancellorCards = [];
          pushLog(`${pname(S.presidentKey)} agrees to the veto. Both policies discarded.`);
          const chaos = advanceTrackerForFailure();
          if (!chaos && S.phase !== "gameover") beginNextRound();
        } else {
          // Refused — chancellor must enact one of the two.
          S.phase = "legChancellor";
          pushLog(`${pname(S.presidentKey)} rejects the veto. The Chancellor must enact.`);
        }
        break;
      }

      case "power": {
        if (S.phase !== "executive" || fromKey !== S.presidentKey) break;
        resolvePower(msg);
        break;
      }

      case "powerDone": {
        if (S.phase !== "executive" || fromKey !== S.presidentKey) break;
        // peek / investigation acknowledgement (no target needed)
        if (S.pendingPower === "peek" || S.pendingPower === "investigate") {
          S.pendingPower = null;
          S.peekCards = null;
          S.investigation = null;
          beginNextRound();
        }
        break;
      }

      case "playAgain": {
        if (S.phase !== "gameover") break;
        if (fromKey !== hostKeyOfState()) break; // only host restarts
        resetForNewGame();
        break;
      }
    }

    broadcast();
  }

  function hostKeyOfState() {
    for (const k in hostState.players) if (hostState.players[k].isHost) return k;
    return null;
  }

  function resolveElection() {
    const living = livingKeys();
    let ja = 0, nein = 0;
    living.forEach((k) => { (hostState.votes[k] === "ja" ? ja++ : nein++); });
    hostState.lastVotes = {};
    living.forEach((k) => { hostState.lastVotes[k] = hostState.votes[k]; });
    hostState.lastOutcome = ja > nein ? "pass" : "fail"; // strict majority; tie fails
    hostState.phase = "electionResult";
    pushLog(`Vote: ${ja} Ja / ${nein} Nein — ${hostState.lastOutcome === "pass" ? "ELECTED" : "REJECTED"}.`);
  }

  function applyElectionOutcome() {
    const S = hostState;
    if (S.lastOutcome === "pass") {
      S.chancellorKey = S.nomineeKey;
      S.lastElectedPresidentKey = S.presidentKey;
      S.lastElectedChancellorKey = S.chancellorKey;
      S.electionTracker = 0;

      // Hitler-as-Chancellor win check (3+ fascist policies on the board)
      if (S.fascistPolicies >= 3 && S.players[S.chancellorKey].role === "hitler") {
        endGame("fascist", "Hitler was elected Chancellor.");
        return;
      }
      // Legislative session
      ensureDraw(3);
      S.presidentDraw = S.drawPile.splice(0, 3);
      S.phase = "legPresident";
      pushLog(`${pname(S.presidentKey)} & ${pname(S.chancellorKey)} elected. President draws three policies.`);
    } else {
      S.nomineeKey = null;
      const chaos = advanceTrackerForFailure();
      if (!chaos && S.phase !== "gameover") beginNextRound();
    }
  }

  function resolvePower(msg) {
    const S = hostState;
    const power = S.pendingPower;
    const target = msg.targetKey ? S.players[msg.targetKey] : null;

    if (power === "investigate") {
      if (!target || !target.alive || msg.targetKey === S.presidentKey || target.investigated) {
        toastTo(S.presidentKey, "Invalid target."); return;
      }
      target.investigated = true;
      S.investigation = { byKey: S.presidentKey, name: target.name, party: target.party };
      pushLog(`${pname(S.presidentKey)} investigated ${target.name}.`);
      // wait for 'powerDone' acknowledgement
    } else if (power === "special") {
      if (!target || !target.alive || msg.targetKey === S.presidentKey) {
        toastTo(S.presidentKey, "Invalid target."); return;
      }
      S.specialElectionTargetKey = msg.targetKey;
      S.pendingPower = null;
      pushLog(`${pname(S.presidentKey)} calls a Special Election: ${target.name} will be next President.`);
      beginNextRound();
    } else if (power === "execution") {
      if (!target || !target.alive || msg.targetKey === S.presidentKey) {
        toastTo(S.presidentKey, "Invalid target."); return;
      }
      target.alive = false;
      pushLog(`${pname(S.presidentKey)} executed ${target.name}.`);
      if (target.role === "hitler") {
        endGame("liberal", "Hitler was executed.");
        return;
      }
      S.pendingPower = null;
      beginNextRound();
    }
  }

  function resetForNewGame() {
    // keep players & connections, reset game
    const keep = hostState.players;
    const code = hostState.roomCode;
    const fresh = newHostState(code);
    fresh.players = keep;
    for (const k in fresh.players) {
      const p = fresh.players[k];
      p.alive = true; p.role = null; p.party = null;
      p.investigated = false; p.knownAllies = null; p.ready = false;
    }
    hostState = fresh;
    hostState.phase = "lobby";
    pushLog("Returned to lobby for a new game.");
  }

  function toastTo(key, message) {
    const p = hostState.players[key];
    if (!p) return;
    if (p.isHost) { toast(message); return; }
    const c = conns.get(p.connId);
    if (c && c.open) c.send({ t: "toast", msg: message });
  }

  /* ============================================================
     SNAPSHOT (personalised public + private)
     ============================================================ */
  function buildSnapshotFor(viewerKey) {
    const S = hostState;
    const me = S.players[viewerKey];

    const players = S.seatOrder.length
      ? S.seatOrder.map((k) => publicPlayer(k))
      : Object.keys(S.players).map((k) => publicPlayer(k));

    const snap = {
      v: APP_VERSION,
      roomCode: S.roomCode,
      phase: S.phase,
      numPlayers: S.numPlayers,
      players,
      lobbyPlayers: Object.keys(S.players).map((k) => ({
        name: S.players[k].name, isHost: S.players[k].isHost, connected: S.players[k].connected,
      })),

      presidentKey: S.presidentKey,
      chancellorKey: S.chancellorKey,
      presidentIsSpecial: S.presidentIsSpecial,
      nomineeKey: S.nomineeKey,
      lastElectedPresidentKey: S.lastElectedPresidentKey,
      lastElectedChancellorKey: S.lastElectedChancellorKey,

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

      // personalised
      you: null,
    };

    // Election: who still needs to vote (names only — never which way they voted)
    if (S.phase === "election") {
      const living = livingKeys();
      const pending = living.filter((k) => !S.votes[k]);
      snap.voteWaiting = { voted: living.length - pending.length, total: living.length, pending };
    }
    // Reveal votes during result phase
    if (S.phase === "electionResult" && S.lastVotes) {
      snap.lastVotes = S.lastVotes;
    }

    // Reveal all roles on game over
    if (S.phase === "gameover") {
      snap.revealRoles = S.seatOrder.map((k) => ({
        name: S.players[k].name, role: S.players[k].role,
      }));
    }

    // ---- personalised "you" payload ----
    if (me) {
      const you = {
        key: viewerKey,
        name: me.name,
        isHost: me.isHost,
        alive: me.alive,
        role: me.role,
        party: me.party,
        knownAllies: me.knownAllies,
        ready: me.ready,
        isPresident: viewerKey === S.presidentKey,
        isChancellor: viewerKey === S.chancellorKey,
        isNominee: viewerKey === S.nomineeKey,
        hasVoted: !!S.votes[viewerKey],
        myVote: S.votes[viewerKey] || null,
        presCards: null,
        chanCards: null,
        peek: null,
        investigation: null,
        vetoProposed: S.vetoProposed,
        vetoUnlocked: S.vetoUnlocked,
        vetoUsedThisGov: S.vetoUsedThisGov,
        eligibleChancellors: null,
      };

      if (S.phase === "nomination" && you.isPresident) {
        you.eligibleChancellors = S.seatOrder.filter((k) => isEligibleChancellor(k));
      }
      if (S.phase === "legPresident" && you.isPresident) {
        you.presCards = S.presidentDraw.slice();
      }
      if ((S.phase === "legChancellor" || S.phase === "vetoPrompt") && you.isChancellor) {
        you.chanCards = S.chancellorCards.slice();
      }
      if (S.phase === "executive" && you.isPresident) {
        if (S.pendingPower === "peek" && S.peekCards) you.peek = S.peekCards.slice();
        if (S.pendingPower === "investigate" && S.investigation && S.investigation.byKey === viewerKey) {
          you.investigation = { name: S.investigation.name, party: S.investigation.party };
        }
      }
      snap.you = you;
    }
    return snap;
  }

  function publicPlayer(k) {
    const p = hostState.players[k];
    return {
      key: k,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      investigated: p.investigated,
      isPresident: k === hostState.presidentKey,
      isChancellor: k === hostState.chancellorKey,
      isNominee: k === hostState.nomineeKey,
    };
  }

  /* ---------------- broadcast ---------------- */
  function broadcast() {
    if (!isHost) return;
    // host's own snapshot drives local render
    publicState = buildSnapshotFor(myKey);
    routeView();
    renderGame();
    // send personalised snapshots to each connected client
    for (const k in hostState.players) {
      const p = hostState.players[k];
      if (p.isHost) continue;
      const c = conns.get(p.connId);
      if (c && c.open) c.send({ t: "state", state: buildSnapshotFor(k) });
    }
  }

  /* ============================================================
     VIEW ROUTING
     ============================================================ */
  function show(viewId) {
    ["viewHome", "viewLobby", "viewGame"].forEach((v) => {
      $(v).classList.toggle("hidden", v !== viewId);
    });
  }
  function showHome() { show("viewHome"); }
  function showLobby() { show("viewLobby"); renderLobby(); }

  function routeView() {
    if (!publicState) return;
    if (publicState.phase === "lobby") { show("viewLobby"); renderLobby(); }
    else { show("viewGame"); }
    updatePeekUI();
  }

  /* ============================================================
     RENDER: LOBBY
     ============================================================ */
  function renderLobby() {
    if (!publicState) return;
    $("lobbyCode").textContent = publicState.roomCode || roomCode || "----";
    const list = publicState.lobbyPlayers || [];
    $("lobbyCount").textContent = list.length;

    const ul = $("lobbyPlayers");
    ul.innerHTML = "";
    list.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="pl-dot ${p.connected ? "" : "off"}"></span>
        <span class="pl-name">${esc(p.name)}</span>
        ${p.isHost ? '<span class="pl-tag">Host</span>' : ""}`;
      ul.appendChild(li);
    });

    const canStart = isHost && list.length >= 5 && list.length <= 10;
    $("btnStart").classList.toggle("hidden", !isHost);
    $("btnStart").disabled = !canStart;
    $("btnStart").textContent = list.length < 5
      ? `Need ${5 - list.length} more`
      : (list.length > 10 ? "Too many players" : "Start game");
    $("lobbyWaitMsg").classList.toggle("hidden", isHost);
    $("lobbyHint").textContent = isHost
      ? "Share this code. Start once 5–10 players have joined."
      : "Waiting in the lobby. The host will start the game.";
  }

  /* ============================================================
     RENDER: GAME
     ============================================================ */
  function renderGame() {
    if (!publicState || publicState.phase === "lobby") return;
    renderBoard();
    renderAction();
    renderLog();
    updatePeekUI();
  }

  function renderBoard() {
    const S = publicState;
    const board = $("board");

    if (S.phase === "gameover") { board.innerHTML = ""; return; }

    const govPres = S.presidentKey ? nameOf(S.presidentKey) : null;
    const govChan = S.chancellorKey ? nameOf(S.chancellorKey)
                  : (S.nomineeKey ? nameOf(S.nomineeKey) + " ?" : null);

    // tracks
    const libSlots = renderTrackSlots("lib", S.liberalPolicies, 5, null, S.numPlayers);
    const fasSlots = renderTrackSlots("fas", S.fascistPolicies, 6, POWER_TRACK[S.numPlayers], S.numPlayers);

    const trackerDots = Array.from({ length: 3 }, (_, i) =>
      `<span class="tdot ${i < S.electionTracker ? "on" : ""}"></span>`).join("");

    board.innerHTML = `
      <div class="gov-bar">
        <div class="gov-cell">
          <div class="card-label">President${S.presidentIsSpecial ? " ⚡" : ""}</div>
          <div class="gov-name ${govPres ? "" : "empty"}">${govPres ? esc(govPres) : "—"}</div>
        </div>
        <div class="gov-cell">
          <div class="card-label">Chancellor</div>
          <div class="gov-name ${govChan ? "" : "empty"}">${govChan ? esc(govChan) : "—"}</div>
        </div>
      </div>

      <div class="track lib">
        <div class="track-head"><span class="track-title">Liberal</span><span class="track-meta">${S.liberalPolicies}/5</span></div>
        <div class="slots">${libSlots}</div>
      </div>

      <div class="track fas">
        <div class="track-head"><span class="track-title">Fascist</span><span class="track-meta">${S.fascistPolicies}/6${S.vetoUnlocked ? " · veto" : ""}</span></div>
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

  function renderTrackSlots(kind, filled, total, powers, n) {
    let html = "";
    for (let i = 0; i < total; i++) {
      const isFilled = i < filled;
      const isWin = i === total - 1;
      let pw = "";
      if (kind === "fas" && powers && i < 5 && powers[i]) {
        pw = `<span class="pw">${POWER_LABEL[powers[i]].replace(" ", "<br>")}</span>`;
      }
      if (kind === "fas" && i === 5) pw = `<span class="pw">F WIN</span>`;
      if (kind === "lib" && i === 4) pw = `<span class="pw">L WIN</span>`;
      html += `<div class="slot ${isFilled ? "filled" : ""} ${isWin ? "win" : ""}">${pw}</div>`;
    }
    return html;
  }

  function renderPlayerChips() {
    const S = publicState;
    return S.players.map((p) => {
      const cls = ["pchip"];
      if (!p.alive) cls.push("dead");
      if (p.isPresident) cls.push("pres");
      else if (p.isChancellor) cls.push("chan");
      let tag = "";
      if (p.isPresident) tag = '<span class="role-mini">PRES</span>';
      else if (p.isChancellor) tag = '<span class="role-mini">CHAN</span>';
      else if (p.isNominee) tag = '<span class="role-mini">NOM</span>';
      else if (!p.connected) tag = '<span class="role-mini">OFFLINE</span>';
      return `<span class="${cls.join(" ")}">${esc(p.name)}${tag}</span>`;
    }).join("");
  }

  // Build the (private) role card markup. The role is never shown on the main
  // screen — it is only rendered into the peek overlay while the button is held.
  function roleCardHTML(you) {
    if (!you || !you.role) return "";
    const roleNames = { liberal: "Liberal", fascist: "Fascist", hitler: "Hitler" };
    const icon = { liberal: "L", fascist: "F", hitler: "H" }[you.role];
    let sub = "";
    if (you.role === "liberal") sub = "Enact 5 Liberal policies, or expose Hitler.";
    else if (you.role === "fascist") sub = "Help enact 6 Fascist policies — or get Hitler elected.";
    else sub = "Stay hidden. If elected Chancellor after 3 Fascist policies, you win.";

    let allies = "";
    if (you.knownAllies && you.knownAllies.length) {
      allies = `<div class="role-sub">Allies: ${you.knownAllies.map((a) => `${esc(a.name)} <i>(${a.label})</i>`).join(", ")}</div>`;
    }
    return `
      <div class="role-card ${you.role}">
        <div class="role-icon">${icon}</div>
        <div class="role-text">
          <div class="role-name">${roleNames[you.role]}${you.alive ? "" : " · dead"}</div>
          <div class="role-sub">${sub}</div>
          ${allies}
        </div>
      </div>`;
  }

  // Show/hide the sticky peek button depending on whether we are in a live game.
  function updatePeekUI() {
    const you = publicState && publicState.you;
    const inGame = !!(you && you.role && publicState.phase !== "lobby" && publicState.phase !== "gameover");
    document.body.classList.toggle("in-game", inGame);
    $("peekBar").classList.toggle("hidden", !inGame);
    if (!inGame) hideRolePeek();
  }

  function showRolePeek() {
    const you = publicState && publicState.you;
    if (!you || !you.role) return;
    $("roleRevealInner").innerHTML = roleCardHTML(you);
    $("roleReveal").classList.remove("hidden");
  }
  function hideRolePeek() {
    const r = $("roleReveal");
    if (r) r.classList.add("hidden");
  }

  /* ---------------- action panel (phase machine, client view) ---------------- */
  function renderAction() {
    const S = publicState;
    const you = S.you;
    const el = $("action");
    if (!you) { el.innerHTML = ""; return; }

    switch (S.phase) {
      case "reveal":      return panelReveal(el, S, you);
      case "nomination":  return panelNomination(el, S, you);
      case "election":    return panelElection(el, S, you);
      case "electionResult": return panelElectionResult(el, S, you);
      case "legPresident":  return panelLegPresident(el, S, you);
      case "legChancellor": return panelLegChancellor(el, S, you);
      case "vetoPrompt":    return panelVeto(el, S, you);
      case "executive":     return panelExecutive(el, S, you);
      case "gameover":      return panelGameOver(el, S, you);
      default: el.innerHTML = "";
    }
  }

  function panel(kicker, title, bodyHtml, actionsHtml) {
    return `<div class="panel">
      <div class="panel-kicker">${kicker}</div>
      <div class="panel-title">${title}</div>
      ${bodyHtml ? `<div class="panel-body">${bodyHtml}</div>` : ""}
      ${actionsHtml ? `<div class="panel-actions">${actionsHtml}</div>` : ""}
    </div>`;
  }

  function waitingPanel(kicker, title, body) {
    return `<div class="panel"><div class="panel-kicker">${kicker}</div>
      <div class="panel-title">${title}</div>
      <div class="waiting"><div class="spinner"></div><div class="panel-body">${body}</div></div></div>`;
  }

  function panelReveal(el, S, you) {
    if (you.ready) {
      el.innerHTML = waitingPanel("Setup", "Role memorised", "Waiting for everyone to be ready…");
    } else {
      el.innerHTML = panel("Setup", "Check your secret role",
        "Hold the <b>“view your secret role”</b> button at the bottom of the screen to see your role privately. Memorise it, then tap below — the game begins when everyone is ready.",
        `<button class="btn btn-primary" id="aReady">I've memorised my role</button>`);
      $("aReady").onclick = () => dispatch({ t: "ready" });
    }
  }

  function panelNomination(el, S, you) {
    if (!you.isPresident) {
      el.innerHTML = waitingPanel("Election", "Nomination",
        `${esc(nameOf(S.presidentKey))} is choosing a Chancellor…`);
      return;
    }
    const opts = (you.eligibleChancellors || []).map((k) =>
      `<button class="opt" data-k="${k}">${esc(nameOf(k))}</button>`).join("");
    el.innerHTML = panel("Election", "Nominate a Chancellor",
      "Term-limited and dead players can't be picked.",
      `<div class="select-list">${opts}</div>`);
    el.querySelectorAll(".opt").forEach((b) => {
      b.onclick = () => dispatch({ t: "nominate", targetKey: b.dataset.k });
    });
  }

  function panelElection(el, S, you) {
    const w = S.voteWaiting;
    const wait = w ? `${w.voted}/${w.total} voted` : "";
    const pendingNames = (w && w.pending || []).map((k) => esc(nameOf(k)));
    const stillOut = pendingNames.length
      ? `<div class="wait-names">Waiting on: ${pendingNames.join(", ")}</div>`
      : `<div class="wait-names">All votes are in…</div>`;
    const presN = esc(nameOf(S.presidentKey));
    const chanN = esc(nameOf(S.nomineeKey));
    if (!you.alive) {
      el.innerHTML = waitingPanel("Vote", "Election under way",
        `Government: ${presN} / ${chanN}. ${wait}${stillOut}`);
      return;
    }
    if (you.hasVoted) {
      el.innerHTML = waitingPanel("Vote", "Vote cast",
        `You voted <b>${you.myVote === "ja" ? "Ja" : "Nein"}</b>. ${wait}${stillOut}`);
      return;
    }
    el.innerHTML = panel("Vote", "Elect this government?",
      `President <b>${presN}</b> &nbsp;·&nbsp; Chancellor <b>${chanN}</b>`,
      `<div class="vote-row">
        <button class="vote-btn ja" id="vJa">Ja</button>
        <button class="vote-btn nein" id="vNein">Nein</button>
      </div>${stillOut}`);
    $("vJa").onclick = () => dispatch({ t: "vote", vote: "ja" });
    $("vNein").onclick = () => dispatch({ t: "vote", vote: "nein" });
  }

  function panelElectionResult(el, S, you) {
    const votesHtml = S.lastVotes ? Object.keys(S.lastVotes).map((k) =>
      `<span class="vres">${esc(nameOf(k))}<span class="v ${S.lastVotes[k]}">${S.lastVotes[k] === "ja" ? "Ja" : "Nein"}</span></span>`
    ).join("") : "";
    const outcome = S.lastOutcome === "pass"
      ? `<div class="outcome pass">Government elected</div>`
      : `<div class="outcome fail">Rejected</div>`;
    let actions = "";
    if (you.isPresident) {
      actions = `<button class="btn btn-primary" id="aCont">Continue</button>`;
    }
    el.innerHTML = panel("Vote result", "The votes are in",
      `<div class="vote-results">${votesHtml}</div>${outcome}`,
      actions || `<div class="hint-row">Waiting for ${esc(nameOf(S.presidentKey))}…</div>`);
    if (you.isPresident) $("aCont").onclick = () => dispatch({ t: "continueResult" });
  }

  function panelLegPresident(el, S, you) {
    if (!you.isPresident) {
      el.innerHTML = waitingPanel("Legislative session", "President is legislating",
        `${esc(nameOf(S.presidentKey))} is discarding one policy in secret…`);
      return;
    }
    el.innerHTML = panel("Legislative session", "Discard one policy",
      "These three are secret. Tap one to <b>discard</b> it; the other two pass to the Chancellor.",
      renderHand(you.presCards, "presPick") + `<div class="hand-hint">Tap a card to discard it</div>`);
    wireHand(el, you.presCards, (idx) => dispatch({ t: "presDiscard", index: idx }));
  }

  function panelLegChancellor(el, S, you) {
    if (!you.isChancellor) {
      el.innerHTML = waitingPanel("Legislative session", "Chancellor is legislating",
        `${esc(nameOf(S.chancellorKey))} is enacting a policy in secret…`);
      return;
    }
    const canVeto = you.vetoUnlocked && !you.vetoUsedThisGov;
    const vetoBtn = canVeto ? `<button class="btn" id="aVeto">Propose veto</button>` : "";
    el.innerHTML = panel("Legislative session", "Enact one policy",
      "Tap a card to <b>enact</b> it onto its track. The other is discarded." +
      (canVeto ? " Or propose a veto to discard both." : ""),
      renderHand(you.chanCards, "chanPick") + `<div class="hand-hint">Tap a card to enact it</div>` +
      (vetoBtn ? `<div style="margin-top:14px">${vetoBtn}</div>` : ""));
    wireHand(el, you.chanCards, (idx) => dispatch({ t: "chanEnact", index: idx }));
    if (canVeto) $("aVeto").onclick = () => dispatch({ t: "proposeVeto" });
  }

  function panelVeto(el, S, you) {
    if (you.isPresident) {
      el.innerHTML = panel("Veto", "Chancellor proposes a veto",
        "Agree to discard <b>both</b> policies (counts as a failed government, tracker advances), or reject and force the Chancellor to enact one.",
        `<div class="btn-row">
          <button class="btn btn-danger" id="aVetoYes">Agree to veto</button>
          <button class="btn" id="aVetoNo">Reject</button>
        </div>`);
      $("aVetoYes").onclick = () => dispatch({ t: "vetoResponse", consent: true });
      $("aVetoNo").onclick = () => dispatch({ t: "vetoResponse", consent: false });
    } else if (you.isChancellor) {
      el.innerHTML = waitingPanel("Veto", "Veto proposed", `Waiting for ${esc(nameOf(S.presidentKey))} to respond…`);
    } else {
      el.innerHTML = waitingPanel("Veto", "Veto proposed", "The government is considering a veto…");
    }
  }

  function panelExecutive(el, S, you) {
    const power = S.pendingPower;
    if (!you.isPresident) {
      el.innerHTML = waitingPanel("Executive action", POWER_LABEL[power] || "Presidential power",
        `${esc(nameOf(S.presidentKey))} is using a presidential power…`);
      return;
    }

    if (power === "peek") {
      const cards = you.peek || [];
      el.innerHTML = panel("Executive action", "Policy Peek",
        "The top three policies of the draw pile, in order (top first). For your eyes only.",
        `<div class="hand">${cards.map(cardFace).join("")}</div>
         <div class="panel-actions"><button class="btn btn-primary" id="aDone">Done</button></div>`);
      $("aDone").onclick = () => dispatch({ t: "powerDone" });
      return;
    }

    if (power === "investigate") {
      if (you.investigation) {
        const party = you.investigation.party;
        el.innerHTML = panel("Executive action", "Investigation result",
          `<div class="reveal"><div class="big">${esc(you.investigation.name)} is a <span class="${party === "Liberal" ? "lib" : "fas"}">${party}</span></div></div>
           This reveals party membership only — never whether they are Hitler. For your eyes only.`,
          `<button class="btn btn-primary" id="aDone">Done</button>`);
        $("aDone").onclick = () => dispatch({ t: "powerDone" });
      } else {
        const opts = targetOptions(S, you, { excludeInvestigated: true });
        el.innerHTML = panel("Executive action", "Investigate Loyalty",
          "Choose a player to inspect their party membership. Each player can be investigated only once per game.",
          `<div class="select-list">${opts}</div>`);
        wireTargets(el, (k) => dispatch({ t: "power", targetKey: k }));
      }
      return;
    }

    if (power === "special") {
      const opts = targetOptions(S, you, {});
      el.innerHTML = panel("Executive action", "Special Election",
        "Choose any living player to be the <b>next</b> Presidential candidate. Normal order resumes afterward.",
        `<div class="select-list">${opts}</div>`);
      wireTargets(el, (k) => dispatch({ t: "power", targetKey: k }));
      return;
    }

    if (power === "execution") {
      const opts = targetOptions(S, you, {});
      el.innerHTML = panel("Executive action", "Execution",
        "Choose a player to execute. They are removed from the game and their role stays hidden. If they were Hitler, Liberals win.",
        `<div class="select-list">${opts}</div>`);
      wireTargets(el, (k) => dispatch({ t: "power", targetKey: k }));
      return;
    }
  }

  function panelGameOver(el, S, you) {
    const win = S.winner;
    const cls = win === "liberal" ? "lib" : "fas";
    const title = win === "liberal" ? "Liberals win" : "Fascists win";
    const roles = (S.revealRoles || []).map((r) =>
      `<div class="rr">${esc(r.name)}<span class="rr-role ${r.role}">${r.role}</span></div>`).join("");
    let actions = "";
    if (you.isHost) actions = `<button class="btn btn-primary" id="aAgain">Back to lobby</button>`;
    else actions = `<div class="hint-row">Waiting for the host…</div>`;

    el.innerHTML = `<div class="gameover ${cls}">
      <div class="panel-kicker">${esc(S.winReason)}</div>
      <h2>${title}</h2>
      <div class="reveal-roles">${roles}</div>
      <div class="panel-actions" style="margin-top:20px">${actions}</div>
    </div>`;
    if (you.isHost) $("aAgain").onclick = () => dispatch({ t: "playAgain" });
  }

  /* ---------------- render helpers ---------------- */
  function cardFace(c) {
    return `<div class="pcard ${c}"><span class="pcard-mark">${c}</span>${c === "L" ? "Liberal" : "Fascist"}</div>`;
  }
  function renderHand(cards, cls) {
    if (!cards) return "";
    return `<div class="hand">` + cards.map((c, i) =>
      `<div class="pcard ${c}" data-i="${i}"><span class="pcard-mark">${c}</span>${c === "L" ? "Liberal" : "Fascist"}</div>`
    ).join("") + `</div>`;
  }
  function wireHand(el, cards, cb) {
    el.querySelectorAll(".pcard[data-i]").forEach((card) => {
      card.onclick = () => {
        if (card.classList.contains("locked")) return;
        el.querySelectorAll(".pcard[data-i]").forEach((c) => c.classList.add("locked"));
        cb(parseInt(card.dataset.i, 10));
      };
    });
  }
  function targetOptions(S, you, opts) {
    return S.players.filter((p) => p.alive && p.key !== you.key).map((p) => {
      const disabled = opts.excludeInvestigated && p.investigated;
      return `<button class="opt" data-k="${p.key}" ${disabled ? "disabled" : ""}>${esc(p.name)}${disabled ? '<span class="opt-meta">investigated</span>' : ""}</button>`;
    }).join("");
  }
  function wireTargets(el, cb) {
    el.querySelectorAll(".opt[data-k]").forEach((b) => {
      b.onclick = () => { if (!b.disabled) cb(b.dataset.k); };
    });
  }

  function renderLog() {
    const ul = $("logList");
    ul.innerHTML = (publicState.log || []).map((e) =>
      `<li><span class="lt">${e.ts}</span>${esc(e.text)}</li>`).join("");
  }

  function nameOf(key) {
    const p = (publicState.players || []).find((x) => x.key === key);
    return p ? p.name : "?";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderAll() {
    if (!publicState && isHost && hostState) publicState = buildSnapshotFor(myKey);
    routeView();
    renderGame();
  }

  /* ============================================================
     TOAST
     ============================================================ */
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  /* ============================================================
     LEAVE / CLEANUP
     ============================================================ */
  function cleanupAll() {
    try { if (hostConn) hostConn.close(); } catch (e) {}
    for (const [, c] of conns.entries()) { try { c.close(); } catch (e) {} }
    conns.clear();
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null; isHost = false; myKey = null; roomCode = null;
    hostState = null; hostConn = null; publicState = null;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    document.body.classList.remove("in-game");
    $("peekBar").classList.add("hidden");
    hideRolePeek();
    showHome();
  }

  /* ============================================================
     UI WIRING
     ============================================================ */
  function getName() {
    const v = $("nameInput").value.trim();
    return v.slice(0, 14);
  }

  $("btnCreate").onclick = async () => {
    const name = getName();
    if (!name) { toast("Enter your name first."); $("nameInput").focus(); return; }
    $("btnCreate").disabled = true;
    await hostCreateGame(name);
    $("btnCreate").disabled = false;
  };

  $("btnJoin").onclick = async () => {
    const name = getName();
    const code = $("codeInput").value.trim().toUpperCase();
    if (!name) { toast("Enter your name first."); $("nameInput").focus(); return; }
    if (code.length !== 4) { toast("Enter the 4-letter room code."); $("codeInput").focus(); return; }
    $("btnJoin").disabled = true;
    await clientJoin(name, code);
    showLobby();
    $("btnJoin").disabled = false;
  };

  $("btnStart").onclick = () => { if (isHost) hostStartGame(); };

  $("btnLeaveLobby").onclick = cleanupAll;
  $("btnLeaveGame").onclick = () => {
    if (confirm("Leave the game?")) cleanupAll();
  };

  $("codeInput").addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  // Hold-to-peek: the secret role is shown only while the button is pressed.
  (function wirePeek() {
    const btn = $("peekBtn");
    const press = (e) => { e.preventDefault(); showRolePeek(); };
    const release = () => hideRolePeek();
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
    // Fallbacks for browsers without pointer events
    btn.addEventListener("touchstart", press, { passive: false });
    btn.addEventListener("touchend", release);
    btn.addEventListener("mousedown", press);
    btn.addEventListener("mouseup", release);
    btn.addEventListener("mouseleave", release);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    // Tapping the dark overlay also hides it (safety net).
    $("roleReveal").addEventListener("pointerdown", release);
    // Never leave the role on screen if focus/visibility is lost.
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", () => { if (document.hidden) release(); });
  })();

  // Rules modal
  $("rulesBody").innerHTML = RULES_HTML();
  $("btnRulesHome").onclick = () => $("rulesModal").classList.remove("hidden");
  $("btnCloseRules").onclick = () => $("rulesModal").classList.add("hidden");
  $("rulesModal").addEventListener("click", (e) => {
    if (e.target.id === "rulesModal") $("rulesModal").classList.add("hidden");
  });

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
      <h3>Privacy</h3>
      <ul>
        <li>Drawn policies show only on the President's / Chancellor's device. Investigations and peeks show only on the acting President's device.</li>
      </ul>`;
  }

  // Boot
  showHome();
})();
