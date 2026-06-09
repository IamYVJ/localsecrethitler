# localsecrethitler

A digital, **local-network multiplayer** version of the social-deduction game
**Secret Hitler**. Everyone plays on their own phone over the same Wi-Fi — one
device hosts, the rest join with a short room code. No installs, no accounts, no
build step. It's a 100% static site (HTML + CSS + vanilla JS).

Companion to [localmafia](https://github.com/IamYVJ/localmafia) and
localavalon — same peer-to-peer model, same design language.

> **Play:** https://iamyvj.github.io/localsecrethitler/

---

## How to play

Secret Hitler is a hidden-role game for **5–10 players**. Liberals are the
majority but don't know who's who; Fascists know each other and are quietly
steering policy — and protecting a hidden Hitler.

- **Liberals win** by enacting **5 Liberal policies**, or by **executing Hitler**.
- **Fascists win** by enacting **6 Fascist policies**, or by getting **Hitler
  elected Chancellor** once **3+ Fascist policies** are already on the board.

### Setup knowledge
- The Fascists (excluding Hitler) always know each other **and** know who Hitler is.
- In **5–6 player** games, Hitler also learns who the (single) Fascist is.
- In **7–10 player** games, Hitler does **not** know the Fascists.
- Liberals know nothing about anyone.

### Each round
1. **Election.** The Presidency rotates clockwise. The President nominates a
   Chancellor, then **everyone votes Ja / Nein** at once. A **strict majority of
   Ja** elects the government (a tie fails). The most recently *elected* President
   and Chancellor can't be nominated as Chancellor (when only 5 players are alive,
   only the last Chancellor is blocked).
2. **Chaos.** Each failed election advances the election tracker. On the **3rd
   straight failure**, the top policy is enacted automatically (no power) and all
   term limits reset.
3. **Legislative session.** The President draws **3** policies, secretly discards
   **1**, and passes **2** to the Chancellor, who secretly discards **1** and
   **enacts** the last one.
4. **Presidential powers.** Some Fascist-track slots grant the President a
   one-time power when that policy is enacted (which slots depends on player
   count): **Investigate Loyalty**, **Special Election**, **Policy Peek**, or
   **Execution**. Once **5 Fascist policies** are enacted, the Chancellor may
   propose a **Veto**.

The in-app **“How to play”** screen has the full summary, and the shared board
always shows whose turn it is and what action is pending.

### Privacy of hidden info
Because this is a hidden-role game, each device only ever sees what that player
is entitled to see:
- You see only **your own** secret role (and your allies, if your role grants
  that knowledge).
- The 3 drawn policies show **only on the President's** device; the 2 passed
  policies show **only on the Chancellor's** device.
- Investigation results and Policy Peek show **only on the acting President's**
  device.
- The shared board shows **public state only** (tracks, election tracker, current
  government, living players, policy counts).

---

## Joining a game on the same network

1. One person taps **Create game** and becomes the **host**. A 4-letter room code
   appears.
2. Everyone else opens the same site, enters their **name** and the **room code**,
   and taps **Join**.
3. The host waits until **5–10** players are in the lobby, then taps **Start game**.

All players must be reachable to each other over the network (typical home Wi-Fi
works). If you reload or your phone drops, just **rejoin with the same name and
code** — the host restores your role and seat.

---

## Networking model

This mirrors localmafia's approach: **WebRTC peer-to-peer via
[PeerJS](https://peerjs.com/)** (loaded from a CDN), with a **host-authoritative**
design.

- The **host** holds the full, authoritative game state and runs all game logic.
  The host's PeerJS peer id **is** the room code, so clients connect straight to it.
- Each **client** opens a single reliable data connection to the host.
- The host broadcasts a **personalised snapshot** to every device: public state
  goes to everyone, and private info (your role, drawn policies, investigation
  results, peeks) is included **only** in the snapshot for the device entitled to
  it. Nothing secret is ever sent to a device that shouldn't see it.
- **Reconnect** is by name + code: a dropped player rejoins and the host resumes
  their state.

**Internet dependency:** PeerJS uses a small public **signaling/brokering server**
only to perform the initial handshake (so peers can find each other). After that,
game traffic is **peer-to-peer**. In practice this means the very first
connection needs internet access; gameplay messages then flow directly between
devices on your LAN. No game data is stored on any server.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup + screens (home / lobby / game), CDN + font tags |
| `style.css` | Weimar art-deco theme, board, cards, mobile-first layout |
| `script.js` | PeerJS networking + full Secret Hitler rule engine + rendering |

---

## License

[MIT](LICENSE) © Yashvardhan Jain
