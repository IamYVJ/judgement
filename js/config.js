// ============================================================================
// config.js — Where an optional authoritative server would live, if there were
// one. There is not. Both URLs below are blank and v1 ships that way.
//
// THIS FILE EXISTS PRECISELY BECAUSE IT IS EMPTY. In `sequence` the server
// seams were retrofitted after the peer-to-peer game was finished, and the
// rework was painful in a specific and avoidable way: every call site had grown
// its own answer to "are we networked, and to what", so adding a second kind of
// transport meant editing all of them. The fix is to ask the question in one
// place from day one and let it answer "no". A seam costs nothing while it is
// unused; a seam you wish you had costs a refactor.
//
// So: blank is not a fallback and not a disabled state. It is the shipping
// configuration. The game is a static peer-to-peer page with no backend, it
// works on a plane, and serverConfigured() returning false is the normal
// answer rather than an error to be handled.
//
// Nothing in here is imported by the engine. js/state.js, js/rules.js,
// js/scoring.js, js/cards.js and js/trick.js know nothing about networks and
// must stay that way — the engine is the same object whether it is driven by a
// data channel, a socket or a test harness.
// ============================================================================

/**
 * WebSocket endpoint for an authoritative server. BLANK IN V1.
 *
 * If this is ever filled in, the trailing slash matters. `sequence` is served
 * behind Caddy's `handle_path /sequence/*`, which matches `/sequence/` and
 * everything below it but NOT a bare `/sequence`; an upgrade to `wss://host/x`
 * reaches the proxy's fallback instead of the game server, and the symptom is
 * a socket that opens and closes again with no error worth reading. The slash
 * is load-bearing and is not a tidying opportunity.
 */
export const SERVER_URL = '';

/**
 * Cheap liveness probe. BLANK IN V1.
 *
 * Two rules come with it whenever it is filled in. First, sw.js — at the
 * repository ROOT, not in js/, because a worker's scope is the directory it is
 * served from — must never cache a path ending `/health`; a cached "yes"
 * strands the app in server mode
 * while the machine is actually off, and that failure looks like the game
 * hanging rather than like a stale cache. Second, see SERVER_TIMEOUT_MS below;
 * this is exactly the request that gets budgeted too tightly.
 */
export const SERVER_HEALTH = '';

/**
 * How long to wait on a server request before giving up, and how many times to
 * try. TEN SECONDS, AND TWICE — and both numbers are larger than they look
 * like they should be, on purpose.
 *
 * A cold TLS handshake to a Tailscale Funnel host measured about 4.6 seconds
 * against 0.8–1.2 warm. A four-second budget therefore failed the FIRST request
 * of every session and succeeded on every one after it, which is the worst
 * possible shape for a bug: it never reproduces once you are looking at it, and
 * it reads as "the server is down" to the only person who could tell you
 * otherwise. Budget generously and retry once before declaring anything dead.
 *
 * These live here rather than next to the fetch so that the day someone tunes
 * them, they tune them once and read the paragraph above first.
 */
export const SERVER_TIMEOUT_MS = 10000;
export const SERVER_RETRIES = 1;

/**
 * True when a server endpoint is configured at all — which in v1 is never.
 *
 * Everything server-shaped asks this first and a live health probe second. The
 * two questions are different: this one is "was a server ever compiled in",
 * which is static and free, and the probe is "is it answering right now", which
 * costs a round trip and can change between one call and the next. Anything
 * that skips straight to the probe pays for a request to the empty string.
 */
export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}
