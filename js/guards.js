// ============================================================================
// guards.js — Bounds on anything that arrived from another device.
//
// WHY A PEER-TO-PEER GAME NEEDS THESE AT ALL
//   The tempting reasoning is that a server is exposed to the internet while a
//   browser host only ever hears from people on the same sofa. The second half
//   is false. PeerJS signalling goes through a broker on the public internet
//   and the data channel falls back to a relay, so the host tab is reachable
//   from anywhere by anyone who has — or guesses — the room code. The host here
//   is somebody's phone: the weaker of the two machines, the one with a
//   battery, and the one holding nineteen rounds of everybody's score. If
//   anything it deserves tighter bounds than a server would get.
//
// WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
//   Not rule enforcement. js/state.js is already the enforcement point and is
//   defensive on its own account: playCard() runs canPlay() against the hand
//   the HOST holds, placeBid() runs bidIsLegal() against the round the HOST
//   dealt, and normalizeConfig() rebuilds a config from a fixed key list so a
//   hostile key is dropped rather than stored. Deleting this entire file would
//   not make a single illegal move legal.
//
//   What it does instead is bound WORK AND MEMORY before the engine is reached.
//   A 60 KiB string would be compared against all seventeen cards of a hand; a
//   patch with ten thousand keys would be spread into an object before
//   normalizeConfig() ever saw it; a name a megabyte long would be walked one
//   codepoint at a time by cleanName() before being cut to sixteen characters.
//   None of those are rule violations. All of them are the host's phone.
//
//   There is exactly ONE guard in here that prevents a real exploit rather than
//   a cost, and it is validSeat(). The mechanism is spelled out at that
//   function; it is worth reading, because it is the counterexample to the
//   comfortable idea that a guard layer is only ever belt-and-braces.
//
//   None of this is authentication. Nothing here decides who you are — that is
//   the clientId reclaim rule in js/state.js, and a clientId that passes
//   validClientId() is well-formed, not trusted.
//
//   The ceiling on how MANY connections a host accepts is not here either. It
//   belongs with the connection lifecycle in js/net.js; this file only ever
//   sees one message at a time and cannot count.
//
// WHY THIS IMPORTS rules.js
//   A card in this game IS its two-character code — one deck, so the code is
//   already unique and doubles as identity. That means the check can be exact
//   rather than a length cap, and an exact check written out by hand would be a
//   second copy of RANKS and SUITS free to drift from the first. Same for the
//   seat ceiling and the bid ceiling: both are derived below, neither is typed
//   out. rules.js imports only js/scoring.js and neither imports anything else,
//   so this stays a leaf — `node` can exercise it alone and the browser loads
//   it with no build step.
// ============================================================================

import { RANKS, SUITS, MAX_PLAYERS, MAX_HAND_CEILING } from './rules.js';

// A type is a short verb like 'playCard'. Anything longer is not a type,
// whatever else it might be.
export const MAX_TYPE_LEN = 40;

/**
 * The shape every wire message must have, checked after parsing and before any
 * dispatch. Shared so the two directions cannot disagree about what counts as a
 * message at all.
 *
 * An ARRAY parses fine as JSON and would sail past a `typeof === 'object'`
 * check while having no `.type`, so it is excluded by name.
 */
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

// ---------------------------------------------------------------------------
// Per-connection message rate limit.
//
// The point is not to stop one client being annoying to itself — it is that
// every accepted message fans out into a broadcast to the whole room. At seven
// seats, one peer sending in a loop has its flood multiplied by seven before it
// leaves the host's phone. So the bucket sits in FRONT of the dispatch, not
// behind it.
//
// A refill rate rather than a fixed window, because real play is bursty: the
// last card of a trick and the first of the next arrive a heartbeat apart, and
// the owner dragging the max-hand slider sends one message per step.
//
// `now` IS A PARAMETER, with a default rather than an internal clock, for the
// same reason tick() takes one in js/state.js: a bucket that reads Date.now()
// itself can only be tested by sleeping, and a test that sleeps is a test
// nobody runs. The default exists so js/net.js need not thread a clock through
// its connection handler for the one case where the real time is the right
// answer.
// ---------------------------------------------------------------------------
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.stamp = now;
  }

  /** True if this message may proceed. Costs one token. */
  take(now = Date.now()) {
    // Clamped at zero so a clock that steps backwards — which happens, on
    // phones, across a sleep — refills nothing rather than draining the bucket
    // by a negative amount and locking the player out until it catches up.
    const elapsed = Math.max(0, now - this.stamp) / 1000;
    this.stamp = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Every one of these returns a usable value or null — never
// throws, and never hands back something half-cleaned.
//
// Returning null rather than a boolean is deliberate: it makes the cleaned
// value and the verdict the same expression, so there is no way to test one
// thing and then use another.
// ---------------------------------------------------------------------------

// Long enough that collisions across a friend group are impossible, short
// enough to be obviously not a payload. The character class rules out anything
// that could confuse a log line or a JSON key.
//
// The lower bound is 8 rather than 22 (what a real 128-bit id base64url-encodes
// to) because this must keep accepting ids minted by older builds, and because
// a length check is not what stops anyone guessing someone else's id. Nothing
// does; see the seat-ticket note in addPlayer().
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

/** A PeerJS connection id, or the host's own. Not checked against a character
 *  class: the id is minted by the broker, not by us, and guessing at its format
 *  would break the day PeerJS changes it. Length only. */
export function validPlayerId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 64 ? raw : null;
}

// Rank then suit, exactly two characters. Built from the arrays in rules.js so
// the two cannot drift; every character in both is alphanumeric, so none of
// them needs escaping inside a character class.
const CARD_CODE_RE = new RegExp(`^[${RANKS.join('')}][${SUITS.join('')}]$`);

/** A card code as this app writes them: 'AS', 'TH', '2C'. */
export function validCardCode(raw) {
  return typeof raw === 'string' && CARD_CODE_RE.test(raw) ? raw : null;
}

/**
 * One of 'S', 'D', 'C', 'H'.
 *
 * Nothing inbound currently carries a suit — and that absence is a rule, not an
 * oversight. Court Piece has a declareTrump intent because a player chooses the
 * trump there; in Judgement the trump is either read off the Kachuful rotation
 * by round number or turned up off the stock, so it is DERIVED BY THE HOST and
 * never travels as an argument. If a suit ever does arrive from a peer,
 * something has been added that needs thinking about first. This exists so the
 * check is ready and so the export list makes the omission visible.
 */
export function validSuit(raw) {
  return typeof raw === 'string' && SUITS.includes(raw) ? raw : null;
}

/**
 * A seat index. THE ONE GUARD IN THIS FILE THAT STOPS AN ACTUAL EXPLOIT.
 *
 * Here is the exploit it stops. The only intent carrying a seat is removeSeat,
 * and the engine's removeSeat() is written the sensible way:
 *
 *     const s = this.seats[seat];
 *     if (!s) return { ok: false, error: 'no such seat' };
 *     if (!s.isBot && s.connected) return { ok: false, error: '...is still here' };
 *     this.seats.splice(seat, 1);
 *
 * Hand it the string '__proto__'. `this.seats['__proto__']` is Array.prototype,
 * which is an object and therefore truthy, so the `!s` line does not fire. Its
 * `.isBot` and `.connected` are both undefined, so `!s.isBot && s.connected` is
 * false and the "still here" line does not fire either. Then splice coerces
 * '__proto__' to an integer, which is 0 — and SEAT ZERO IS REMOVED.
 *
 * Seat zero is the owner, and the damage does not stop at losing them. The
 * `if (s.isOwner) this._promoteOwner()` line reads Array.prototype.isOwner,
 * which is undefined, so no heir is appointed; but `this.ownerId` still names
 * the evicted player, who no longer has a seat. _isOwner() now answers false
 * for everybody. The room cannot be configured, cannot add a bot, cannot be
 * started, and cannot appoint a new owner — a total and permanent denial of
 * service from one malformed message. (Verified against the real engine, not
 * reasoned about: the log line it leaves behind reads "undefined left".)
 *
 * Every link in that chain is individually reasonable and the combination is a
 * hole. Integer-only closes it here rather than asking removeSeat() to be
 * paranoid about a type its signature already implies.
 *
 * Bounded by MAX_PLAYERS and not by the actual seat count, because a guard sees
 * one message and has no engine to ask. Whether seat 5 exists at THIS table is
 * the engine's question and removeSeat() still asks it; whether 5 is a seat
 * number at all is this one's.
 */
export function validSeat(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw < MAX_PLAYERS ? raw : null;
}

/**
 * A bid: a whole number of tricks, no more than the largest hand any legal
 * round could hold.
 *
 * NOT LOAD-BEARING, and worth saying so plainly rather than letting the file
 * imply otherwise. bidIsLegal() in the engine tests membership of legalBids(),
 * which is built from the round size, so a float, a string, a negative and a
 * billion are all already refused — and refused with the right reason, which
 * this cannot produce because it does not know the round size.
 *
 * It is here because it is the single written-down answer to "what shape is a
 * bid", so the dispatcher, the bot and any future server agree without each
 * inventing one. MAX_HAND_CEILING is three players at seventeen cards: the
 * widest hand the deck allows, hence the widest honest bound available to
 * something that cannot see the table.
 */
export function validBid(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw <= MAX_HAND_CEILING ? raw : null;
}

// A display name is capped at 16 characters by cleanName() in rules.js, but
// that function walks the whole string one codepoint at a time before it caps
// anything, so it must not be handed a megabyte. This is the bound; cleanName
// is the cleaning. Generous relative to the 16 that survive, because a name
// typed in an alphabet with combining marks can be several times its own
// rendered length and should be truncated, not rejected outright.
export const MAX_RAW_NAME_LEN = 256;

export function validName(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_RAW_NAME_LEN ? raw : null;
}

/**
 * A config patch as the lobby sends it: one key per tap, or the whole set at
 * once when a joining client is brought into line with the host.
 *
 * THE CAP IS THE POINT AND THE KEYS ARE NOT. setConfig() does
 * `normalizeConfig({ ...this.config, ...patch })`, and the spread happens
 * BEFORE normalizeConfig() throws the unknown keys away — so ten thousand keys
 * get allocated whatever the allow-list does about them afterwards. This bounds
 * that allocation. There are five real keys; sixteen leaves room for a sixth
 * without a second thought, because the number is about the spread and not
 * about the shape.
 *
 * A '__proto__' key is deliberately NOT rejected, because it is already inert
 * twice over and a third check would imply the other two were in doubt. Object
 * spread defines own data properties (CreateDataProperty), so unlike
 * Object.assign it does not invoke the `__proto__` setter and the prototype is
 * not touched; and normalizeConfig() then rebuilds the config from a fixed list
 * of five names, so the key is not copied forward either. If setConfig() is
 * ever rewritten to use Object.assign, the first of those two stops being true.
 */
export const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// The other direction: what a CLIENT accepts from its host.
//
// Easy to forget, because "the host" sounds trustworthy. It is not, necessarily.
// A room code is a handful of characters on a public broker (see js/net.js), so
// a code typed one character wrong resolves to whoever else holds that id — and
// the client then renders whatever that stranger sends. render() does no
// checking at all: it reads pub.seats.map(...) and pub.plays.length directly,
// because on the host's own device those always exist. A `seats: 7` instead of
// an array is a thrown TypeError inside render(), and since render() opens with
// clear(root) the result is a blank page with no way back.
//
// So these are shape checks and deliberately only shape checks. Whether the
// trick makes sense, whether the scores add up, whether the host is dealing
// itself aces — none of that is knowable from here, and a client that tried to
// referee its own host would need a second copy of the engine and a second copy
// of the deal. What this buys is that a malformed payload is a refused frame
// instead of a dead tab.
// ---------------------------------------------------------------------------

/**
 * The public table, as far as anything can be checked without a game engine.
 *
 * Court Piece can assert `seats.length === 4` because four is the game. Here
 * the table is 3 to 7 and the lobby legitimately holds 0, 1 or 2 while people
 * are still arriving, so an exact length is not available. A ceiling is, and
 * the ceiling is what stops a `seats` array of a hundred thousand entries from
 * being mapped into a hundred thousand DOM rows.
 */
export function validPublicState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.phase !== 'string' || raw.phase.length > MAX_TYPE_LEN) return null;
  if (!Array.isArray(raw.seats) || raw.seats.length > MAX_PLAYERS) return null;
  // The six arrays every screen walks unconditionally. `plan` and `history`
  // drive the scoreboard, which is drawn in every phase including the lobby;
  // `tricks` is the round so far, which js/bot.js walks on every single turn
  // and which a bot covering an absent seat therefore walks on a CLIENT too.
  if (!Array.isArray(raw.plays) || !Array.isArray(raw.log)) return null;
  if (!Array.isArray(raw.plan) || !Array.isArray(raw.history)) return null;
  if (!Array.isArray(raw.leaders) || !Array.isArray(raw.tricks)) return null;
  // The renderer reads config.scoring and config.shape to label the lobby.
  if (!raw.config || typeof raw.config !== 'object' || Array.isArray(raw.config)) return null;
  // The four seat pointers, each of which gets used as an index.
  //
  // Checked for being a small non-negative integer, NOT for being in range of
  // the seats array above — because an empty lobby honestly reports
  // dealerSeat 0 with no seats to point at, and rejecting that would refuse
  // the very first frame of every session. Out of range is a `seats[n]` of
  // undefined, which renders as nothing; a non-integer is the Array.prototype
  // problem described at validSeat().
  for (const key of ['dealerSeat', 'leadSeat', 'turnSeat', 'trickIndex']) {
    const n = raw[key];
    if (!Number.isInteger(n) || n < 0 || n > MAX_PLAYERS * MAX_HAND_CEILING) return null;
  }
  return raw;
}

/** One device's own hand. Null is a legitimate value — a device that has
 *  connected but is not seated yet has no private state at all — so the caller
 *  must distinguish "absent" from "malformed", and does so by checking for null
 *  before calling this. */
export function validPrivateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.hand) || raw.hand.length > MAX_HAND_CEILING) return null;
  if (validSeat(raw.seat) === null) return null;
  // Null when it is not this device's bid, an array of options when it is.
  // The bid pad maps it, so anything else is a TypeError in the renderer.
  if (raw.bidOptions !== null && !Array.isArray(raw.bidOptions)) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Frame decoding for the PeerJS transport.
//
// A DataConnection hands back whatever the sender's serializer produced. This
// app sends JSON.stringify()'d text, so a string is the normal case, but
// PeerJS's own BinaryPack serializer would deliver an already-decoded object
// and a custom client could send binary.
//
// The size cap can only be applied to the text case, and that is not a gap
// worth pretending away: by the time an object arrives, PeerJS has already
// allocated it, so a cap there would be closing the door on an empty room. The
// cap that matters for the object path is the connection ceiling in js/net.js,
// which stops the flood rather than each frame in it.
//
// 64 KiB is comfortably above the largest thing this app legitimately sends. A
// full publicState at seven seats in round nineteen — nineteen history records,
// sixty log lines, the whole round plan — measures a few kilobytes.
// ---------------------------------------------------------------------------
export const MAX_FRAME_BYTES = 65536;

export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    // Compared against the character count rather than the encoded byte length:
    // multi-byte characters make this stricter than the stated cap, never
    // looser, and it avoids allocating a TextEncoder for every frame of every
    // game.
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  // ArrayBuffer, Blob, TypedArray: something no version of this client sends.
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}
