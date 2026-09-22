// ============================================================================
// util.js — Small shared helpers. No game logic, no network, no engine.
//
// The module layout in the brief gives this file "storage, ids, formatting",
// and as of checkpoint 8 all three are here. The DOM helpers and the
// formatters came first because js/ui.js needed them; the storage half waited
// for js/net.js, which is the first thing that actually reads it. Writing it
// earlier would have meant writing it against an imagined caller and testing
// it against nothing.
//
// EVERY KEY THIS FILE WRITES IS PREFIXED `judgement.`, and the prefix is not
// cosmetic. These games are served from one origin as sibling paths on GitHub
// Pages, so `sequence`, `courtpiece` and this share a single localStorage.
// js/state.js binds a seat to the clientId below; two games sharing one key
// would hand a player the wrong identity in the wrong room.
//
// WHY el() AND clear() ARE HERE AND NOT IN ui.js
//   Because js/main.js needs clear() too, for the one node ui.js must never
//   touch: the #announce live region lives OUTSIDE #app precisely so that
//   render()'s clear(root) cannot destroy it, and the controller that copies
//   text into it is therefore not the renderer. Two callers, so it is shared.
// ============================================================================

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/**
 * Build an element. `attrs` takes `class`, `style`, any `on*` handler, and
 * anything else as an attribute; children may be strings, nodes, arrays, or
 * null/undefined/false, which are skipped so a conditional child can be written
 * inline as `cond && el(...)`.
 *
 * DELIBERATELY NO `html:` ESCAPE HATCH, which is the one difference from
 * sequence's version of this function. Every string that reaches this UI is
 * either a player's own name or a log line built from one, and both arrive over
 * a data channel from a peer nobody has authenticated. sequence has an `html`
 * branch and gets away with it because nothing untrusted is ever passed to it;
 * that is a property of its call sites, not of the helper, and properties of
 * call sites are exactly what stops being true later. Text goes through
 * createTextNode, always, so there is no path from a peer's name to innerHTML.
 *
 * A boolean `true` renders as a bare attribute (`disabled`), and false/null/
 * undefined omit it entirely — so `disabled: !canPlay` is safe either way, where
 * `setAttribute('disabled', false)` would have disabled the button.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'string') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Remove every child. The first line of render(), and the reason #announce
 *  must be a sibling of #app rather than inside it. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// Number formatting
//
// Square scoring goes negative — the brief flags it with a warning — so the
// minus sign is not an afterthought here.
// ---------------------------------------------------------------------------

/**
 * A score, with a REAL minus sign: U+2212 MINUS, not U+002D HYPHEN-MINUS.
 *
 * Three reasons, and the third is the one that matters. It is the right glyph
 * and it is the width of a digit in a tabular-numerals font, so a column of
 * scores stays aligned whether or not the numbers are negative. And a screen
 * reader says "minus one hundred" for U+2212 where a hyphen in a number is
 * ambiguous enough that some voices read "dash" or skip it — which turns a
 * disastrous round into a triumphant one.
 */
export function score(n) {
  return n < 0 ? `−${Math.abs(n)}` : String(n);
}

/** A round delta, always signed, so +0 and 0 are visibly different things:
 *  "+0" is a made zero bid and "0" would look like nothing happened. */
export function delta(n) {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** "3 cards" / "1 card". Said often enough to be worth not getting wrong. */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// What the live region says
//
// For a long time the answer was "room code copied", and only that: app.announce
// in js/main.js had exactly one assignment, inside copyCode(). Everything the
// engine had to say — every bid, every trick, every round scored — went into
// pub.log, was rendered beautifully into a drawer nobody could open, and was
// never spoken. A player using a screen reader could hear that they had copied
// a code and then nothing at all for nineteen rounds.
//
// WHY THIS LIVES IN util.js AND NOT IN main.js. main.js touches the DOM, the
// transport and localStorage in its first twenty lines, so it cannot be
// imported by the headless harness and nothing in it can be swept. This is the
// one part of the announcement with a decision in it, so it is pulled out here
// as a pure function of (what we said last, the log now) and swept over whole
// matches in scripts/test-engine.mjs.
// ---------------------------------------------------------------------------

// A log entry's identity. Not the index: the engine caps the log at 60 lines
// and drops from the front, so indices shift under us mid-match and an
// index-based cursor would re-announce the whole drawer every time the cap
// bit.
//
// JSON.stringify OF THE THREE FIELDS, rather than joining them with a
// separator character. Engine sentences are built out of player names, so any
// printable separator is only safe until somebody works out which one it is:
// with '|', a player calling themselves "3|bid" could forge another line's key
// and make the real line go unannounced. JSON escapes its own delimiters, so
// there is no character to guess, and the source stays free of control bytes
// that break every text tool that touches this file.
const logKey = (l) => JSON.stringify([l.round, l.kind, l.text]);

/**
 * What to announce, given the log and where we had got to in it.
 *
 * Returns `{ cursor, text }`. The cursor is opaque — hand it straight back on
 * the next call. `text` is '' when there is no news, and a caller that gets ''
 * should LEAVE THE REGION ALONE rather than clearing it: a live region that is
 * emptied and refilled says everything twice.
 *
 * THE FIRST CALL ANNOUNCES ONE LINE, NOT SIXTY. Joining a match in round
 * fourteen hands you a log with the whole match in it, and reading all of it
 * aloud is worse than reading none of it. Same when the cursor has fallen off
 * the end of the cap — we are behind, and the useful thing is the newest line,
 * not a recap.
 *
 * Several lines at once is the normal case rather than the exceptional one:
 * the engine finishes a trick and scores a round inside a single tick, so one
 * push can carry "Dev takes it" and "Round 4: Ana 40, Ben 0" together. Both
 * get said, in the order they happened.
 *
 * ONE ASSUMPTION, AND IT IS CHECKED RATHER THAN BELIEVED: the engine never
 * writes the same line twice in a row. If it did, the cursor could not tell
 * "nothing happened" from "it happened again", and the second one would be
 * swallowed. scripts/test-engine.mjs asserts no two adjacent entries share a
 * key across every match it plays, so if that ever stops being true the suite
 * says so here rather than the app going quiet on somebody.
 */
export function announcementFor(cursor, log) {
  const lines = Array.isArray(log) ? log.filter((l) => l && typeof l.text === 'string') : [];
  if (lines.length === 0) return { cursor: null, text: '' };

  const keys = lines.map(logKey);
  const tail = keys[keys.length - 1];
  if (cursor === tail) return { cursor, text: '' };

  // lastIndexOf, not indexOf. A sentence can legitimately recur — the same
  // player bidding the same number in a later round — and the one we were
  // standing on is the most recent, not the first.
  const at = typeof cursor === 'string' ? keys.lastIndexOf(cursor) : -1;
  const fresh = at === -1 ? lines.slice(-1) : lines.slice(at + 1);
  // '. ' rather than a newline: this is read aloud, and the full stop is what
  // makes a voice pause between two sentences instead of running them
  // together into "Dev takes it Round 4".
  return { cursor: tail, text: fresh.map((l) => l.text).join('. ') };
}

// ---------------------------------------------------------------------------
// Room codes
//
// Four characters from an alphabet with no look-alikes: no O or 0, no I or 1.
// A code's whole job is to survive being read aloud across a table and typed
// into somebody else's phone, and "is that an oh or a zero" is the failure.
//
// THE ALPHABET IS 32 LONG FOR A SECOND REASON. 2^32 is an exact multiple of
// 32, so `random32 % 32` is perfectly uniform — no modulo bias, and no
// rejection loop to write and get wrong. Dropping one more ambiguous letter to
// make it 31 would quietly make some codes likelier than others. If a
// character ever has to go, another has to come back.
//
// 32^4 is 1,048,576 codes, and nothing here checks that one is free. It does
// not need to: the host's peer id is derived from the code, so a collision
// with a table that is live RIGHT NOW is refused by the broker as
// 'unavailable-id' and js/net.js turns that into "host again for a new one".
// A collision with a table that has finished is not a collision at all.
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function generateRoomCode() {
  const arr = new Uint32Array(CODE_LENGTH);
  (globalThis.crypto || window.crypto).getRandomValues(arr);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  return code;
}

/**
 * Normalise a typed code: uppercase, then keep only alphabet characters.
 *
 * The look-alikes are not in the alphabet, so a typed O is DROPPED rather than
 * silently read as a zero. That is deliberate and it is the conservative
 * choice: a code that is wrong by one character should fail to find a table,
 * not find the wrong one. Dropping shortens the code, and js/net.js refuses to
 * dial anything that is not exactly CODE_LENGTH.
 *
 * Separators survive the same way, so "QR-TX" and "qr tx" both normalise to
 * QRTX — which matters because a code gets pasted out of a chat message at
 * least as often as it gets typed.
 */
export function normalizeCode(raw) {
  let out = '';
  for (const ch of String(raw || '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clipboard
//
// Two paths, because the good one is not always available. navigator.clipboard
// needs a secure context, which `file://` and plain http are not — and this
// game is meant to be openable straight off a phone by whatever route works.
// The textarea fallback is deprecated and still the only thing that works
// there.
//
// Returns a boolean rather than throwing, because the caller's honest response
// to a failure is "select it yourself" and not an error dialog.
// ---------------------------------------------------------------------------
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Lightweight persistence
//
// EVERY ACCESS IS WRAPPED, and the empty catch blocks are load-bearing rather
// than lazy. `localStorage` is not merely empty in private browsing and inside
// a locked-down webview — reading the global THROWS, as does a write past the
// quota. An unwrapped getItem in the app's first ten lines is a blank page on
// somebody's work phone, and the thing they were trying to do was remember a
// name.
// ---------------------------------------------------------------------------
const NAME_KEY = 'judgement.name';
const CODE_KEY = 'judgement.lastCode';

export function loadName()  { try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; } }
export function saveName(n) { try { localStorage.setItem(NAME_KEY, n); } catch (_) {} }
export function loadCode()  { try { return localStorage.getItem(CODE_KEY) || ''; } catch (_) { return ''; } }
export function saveCode(c) { try { localStorage.setItem(CODE_KEY, c); } catch (_) {} }

// ---------------------------------------------------------------------------
// Device identity
//
// A random 128-bit value identifying THIS BROWSER to whichever machine is
// running the game. js/state.js calls it a seat ticket, and that is exactly
// what it is: the only thing a seat in progress is ever bound to, and the only
// thing that gets a hand back after a battery dies.
//
// WHY IT CANNOT BE THE DISPLAY NAME. Anyone holding a four-character room code
// can connect and type any name they like — the scoreboard is public by
// design, so every name at the table is readable by everybody at it. A seat
// that can be reclaimed by naming it can be stolen by naming it. The tempting
// objection is that a peer-to-peer host only ever hears from the same sofa; it
// doesn't. PeerJS signalling goes through a broker on the public internet and
// the data channel falls back to a public relay. See the header of js/net.js.
//
// A TICKET, NOT A CREDENTIAL, AND THE DIFFERENCE IS WORTH BEING PRECISE ABOUT.
// It authenticates nothing. Anybody who learns one can take that seat, and
// nothing in this app can tell them apart from its owner. What it buys is that
// learning one requires guessing 128 bits rather than reading a name off the
// screen. So it is handled with the care that implies and no more: never
// rendered, never logged, never put in a URL, never sent to anything except
// the machine running the game. Note what that rules out — it must not appear
// in publicState(), and judgement's publicState() does not even publish player
// ids, so there is nothing on the wire to correlate it with.
//
// GENERATED ONCE AND NEVER REGENERATED. There is no rotation and no expiry,
// because a fresh id is indistinguishable from a different device: the host
// would refuse the reclaim and lock somebody out of their own seat mid-deal.
// This is also why "Clear cache & reload" touches Cache Storage and service
// workers ONLY, and never localStorage. That button and this constant are one
// decision written in two files.
//
// The character class matches validClientId() in js/guards.js exactly (8–64 of
// [A-Za-z0-9_-]), so a value that would be refused on arrival cannot be minted
// here, and a value that has been tampered with in localStorage is replaced
// rather than sent.
// ---------------------------------------------------------------------------
const CLIENT_KEY = 'judgement.clientId';
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Used only when localStorage is unavailable — private browsing, storage
// denied, a locked-down embedded webview. A per-tab identity still lets a
// connection that blips reclaim its own seat; it just does not survive a
// reload, which is the best that can be done with nowhere to write. Held in a
// module variable rather than regenerated per call, because a clientId that
// changed between the join frame and the retry would reclaim nothing.
let volatileClientId = null;

function newClientId() {
  const bytes = new Uint8Array(16);   // 128 bits
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;   // 32 hex characters, comfortably inside the 8–64 bound
}

export function clientId() {
  try {
    const stored = localStorage.getItem(CLIENT_KEY);
    if (stored && CLIENT_ID_RE.test(stored)) return stored;
    const fresh = newClientId();
    localStorage.setItem(CLIENT_KEY, fresh);
    return fresh;
  } catch (_) {
    if (!volatileClientId) volatileClientId = newClientId();
    return volatileClientId;
  }
}

// ---------------------------------------------------------------------------
// Session resume
//
// Remembers whether this device was hosting or joining, the room code and the
// name — plus, for a host, a snapshot of the authoritative engine, because the
// host's device holds the only copy of the game that exists. A host reload
// without this ends the match for everybody at the table.
//
// The two are separate keys on purpose. A client writes a session and never an
// engine, and a host that dies between the two writes should resume with a
// stale-but-present snapshot rather than with a half-written single blob.
//
// WHY EIGHT HOURS. A judgement match is long — that length is the stated
// reason seat reclaim exists at all — but it is long in the two-to-three hour
// sense, not the overnight sense. Eight hours covers a game that started after
// dinner, was paused for an argument about the scoring, and resumed; it
// expires by morning. The failure a TTL prevents is specific: a reload the
// next day otherwise spends its first forty-five seconds trying to rejoin a
// table that stopped existing before bedtime, and shows "Reconnecting…" the
// whole time instead of a home screen.
// ---------------------------------------------------------------------------
const SESSION_KEY = 'judgement.session';
const ENGINE_KEY  = 'judgement.engine';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Is a stamp still inside the TTL?
 *
 * `Number.isFinite` RATHER THAN A TRUTHINESS TEST, and the difference is a
 * hole rather than a tidy-up. A ts of "yesterday" — a hand-edited entry, an
 * older format, half a write — makes `Date.now() - ts` NaN, and `NaN > TTL` is
 * FALSE. A bare comparison therefore declares that entry fresh, and keeps
 * declaring it fresh forever: the one value that is supposed to expire is the
 * one value that cannot. Caught by the suite, which is why the corrupt-entry
 * corpus over there has a ts that is a word.
 *
 * A stamp in the FUTURE is accepted rather than expired. Phone clocks step
 * backwards across a sleep and after an NTP correction, and ending a live
 * match because the device disagrees with itself by a few minutes is a worse
 * failure than honouring a slightly odd stamp. Same reasoning as the
 * `Math.max(0, ...)` in the TokenBucket in js/guards.js.
 */
function fresh(ts) {
  return Number.isFinite(ts) && (Date.now() - ts) <= SESSION_TTL_MS;
}

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ts: Date.now() })); } catch (_) {}
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !fresh(s.ts)) { clearSession(); return null; }
    return s;
  } catch (_) { return null; }
}

/** Forget the room. NOT the device — CLIENT_KEY is deliberately absent from
 *  this function, and that absence is the whole of the "never regenerated"
 *  rule above. Leaving a room and rejoining it must land on the same seat. */
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ENGINE_KEY);
  } catch (_) {}
}

/**
 * The host's engine, as state.js's serialize() produced it.
 *
 * THIS CONTAINS EVERY HAND IN THE GAME, which is fine — it is written by the
 * host, to the host's own device, and read back by the same tab. It must never
 * be sent anywhere, and there is nothing in this file that could send it.
 *
 * Stamped and expired on the same clock as the session, because the two are
 * one thing: a snapshot without a session has nothing to reconnect to it, and
 * a session without a snapshot rehydrates an empty lobby.
 */
export function saveEngineSnapshot(snap) {
  try { localStorage.setItem(ENGINE_KEY, JSON.stringify({ snap, ts: Date.now() })); } catch (_) {}
}

export function loadEngineSnapshot() {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !fresh(o.ts)) return null;
    // `?? null` because an entry that carries a stamp and no snapshot is a
    // half-written one, and "absent" has exactly one spelling in this file.
    // Handing back undefined would make the caller's `=== null` check wrong
    // without making it look wrong.
    return o.snap ?? null;
  } catch (_) { return null; }
}
