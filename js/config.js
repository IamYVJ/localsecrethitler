// ============================================================================
// config.js — optional authoritative-server hosting.
//
// Secret Hitler is peer-to-peer FIRST: with the two constants below left empty
// the app behaves exactly as it always has — one player's browser hosts and the
// others connect to it over WebRTC. Fill them in to ALSO offer "Host on server",
// which runs the game on a shared always-on machine. That helps when players are
// not on the same Wi-Fi, or when the host's phone can't keep a tab alive.
//
// At boot the client probes SERVER_HEALTH. Only if that answers does the "Host on
// server" button appear. Joining tries the server first and falls back to
// peer-to-peer for the same code, so either transport can be unavailable without
// breaking the other — server mode is purely additive.
//
//   SERVER_URL     WebSocket base. TRAILING SLASH REQUIRED — the reverse proxy's
//                  path route does not match a bare "/secrethitler".
//   SERVER_HEALTH  Plain-HTTP liveness probe, answers { ok: true, ... }.
//
// Set BOTH to '' to hard-disable server mode.
// ============================================================================

export const SERVER_URL = 'wss://pi.tail360216.ts.net/secrethitler/';
export const SERVER_HEALTH = 'https://pi.tail360216.ts.net/secrethitler/health';

/**
 * True when a server endpoint is configured at all. Server mode may still be off
 * if the boot health probe fails.
 */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
