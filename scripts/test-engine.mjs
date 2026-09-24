// Headless test of the Judgement engine. No browser, no network.
//   node scripts/test-engine.mjs
//
// Sections run in build order:
//
//   1. The pure card layer — vocabulary, the trump sentinel, CLOCKWISE turn
//      order, follow-suit legality, the trick winner with and without trumps,
//      and the deal at every legal player count and hand size.
//   2. The three scoring formulas, including Kachuful's zero-bid rule and
//      Square's negative penalties.
//   3. The four config axes — the trump rotations, the round ladder, the hook,
//      the allow-list, and the presets.
//   4. The engine: whole matches played to the end, with conservation laws and
//      the privacy boundary asserted at every intermediate state.
//   5. The wire: the guards that bound an inbound message, and the one
//      dispatcher that turns it into an engine call.
//   6. The bot: that it never plays or bids illegally, that it reads the
//      scoring mode as a parameter rather than carrying three strategies, and
//      above all that IT SOMETIMES TRIES TO LOSE.
//
// Two rules get more attention than everything else, because both produce a
// game that still runs, still finishes, and is quietly wrong:
//
//   * THE TURN DIRECTION. The sibling repo courtpiece runs ANTICLOCKWISE and
//     the two engines are close enough to copy between. A flipped sign is
//     wrong in every trick.
//   * "NOT YET TURNED" versus "NO TRUMP". Collapsing the two onto null hands
//     tricks to the wrong player in the gap before a turn-up reveal.
//
// Where a rule can be stated as a property it is tested as one rather than as
// a table of expected numbers — a table only ever proves the numbers have not
// changed, which is not the same as proving the rule still holds.

import {
  SUITS, RANKS, DECK_SIZE, NO_TRUMP, MIN_PLAYERS, MAX_PLAYERS, MAX_NAME_LEN,
  rankOf, suitOf, rankValue, rankLabel, cardName, suitName, suitGlyph,
  isRedSuit, isRedCard, isTrumpSuit, trumpGlyph, trumpName,
  maxHandSize, defaultMaxHand, cleanName,
  TRUMP_METHODS, ROUND_SHAPES, MAX_HAND_CEILING, DEFAULT_CONFIG, PRESETS,
  SCORING_LABELS, TRUMP_METHOD_LABELS, SHAPE_LABELS,
  needsTurnUp, trumpForRound, roundSizes, roundPlan, effectiveMaxHand,
  normalizeConfig, matchShape, presetMatching, presetConfig, axisLabel,
  forbiddenBid, legalBids, bidIsLegal, illegalBidReason,
} from '../js/rules.js';
import {
  CLOCKWISE, ANTICLOCKWISE, TABLE_DIRECTION,
  stepSeat, nextSeat, prevSeat, seatsFrom,
  legalPlays, canPlay, illegalReason, ledSuitOf, trickWinner, winningCard, wouldWin,
} from '../js/trick.js';
import {
  buildDeck, shuffle, deal, emptyHands, sortHand, suitCounts,
} from '../js/cards.js';
import {
  SCORING_MODES, scoreKachuful, scoreStandard, scoreSquare, scoreRound,
} from '../js/scoring.js';
// Only the names the engine itself adds. Everything else state.js re-exports
// is already imported above from the module that defines it, and importing it
// twice under one name would hide the day the two stopped being the same
// function — which is exactly the drift the re-export exists to prevent.
import { GameEngine, PHASES, TRICK_PAUSE_MS } from '../js/state.js';
import {
  MAX_TYPE_LEN, MAX_RAW_NAME_LEN, MAX_PATCH_KEYS, MAX_FRAME_BYTES,
  TokenBucket, validEnvelope, validClientId, validPlayerId, validCardCode,
  validSuit, validSeat, validBid, validName, validConfigPatch,
  validPublicState, validPrivateState, decodePeerFrame,
} from '../js/guards.js';
import {
  PLAYER_INTENTS, OWNER_INTENTS, GAME_INTENTS, SELF_GUARDED, LOCAL_ONLY,
  applyGameIntent,
} from '../js/intents.js';
import {
  SERVER_URL, SERVER_HEALTH, SERVER_TIMEOUT_MS, SERVER_RETRIES, serverConfigured,
} from '../js/config.js';
import {
  BOT_THINK_MS, OFFLINE_GRACE_MS, SAFE_ENOUGH,
  bidContext, trickChances, trickDistribution, bidValue,
  chooseBid, chooseCard, chooseIntent, appetite, createBotDriver,
} from '../js/bot.js';
// The renderer, and the few dozen lines of fake DOM that let it run out here.
// ui.js never touches `document` itself — everything goes through util.js's
// el() and clear() — so shimming those two functions covers the whole file.
import { installDOM, walk, byClass, byTag, interactive, dump } from './domshim.mjs';
import {
  el, clear, score as fmtScore, delta as fmtDelta, plural,
  CODE_LENGTH, generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode, clientId, announcementFor,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from '../js/util.js';
import { render, seatState } from '../js/ui.js';
// The transport, and the fake PeerJS that lets it be driven out here. Same
// bargain as domshim.mjs one layer up: net.js is pure logic wrapped around a
// browser API that node does not have, so the API is what gets faked.
import {
  BROKER_CONFIG, MAX_HOST_CONNS, MAX_REFUSED_FRAMES, MAX_REJECT_LEN,
  PEER_PREFIX, peerIdForCode, codeFromPeerId,
  CONN_ID_PREFIX, HOST_ID, playerIdForConn, connIdForPlayer,
  WIRE, joinFrame, readJoinFrame, stateFrameFor, readStateFrame,
  rejectFrame, readRejectFrame, replacedFrame, isReplacedFrame,
  peerAvailable, isFatalPeerError, describePeerError, createHost, joinHost,
} from '../js/net.js';
import { installPeerJS, installStorage, installClock, withoutPeerJS } from './peershim.mjs';
// Node's own, mostly for the last section. index.html, sw.js and the manifest
// are not modules and cannot be imported, so they are read off disk as text —
// and sw.js is then EXECUTED against a fake Cache API, because a list of files
// checked by eye is not the same as a worker that caches them.
// writeFileSync is here for ONE caller: --write-stamp, below. A test runner
// that can write to the repository is a thing to be suspicious of, so the
// single write it performs is fenced into that mode and that mode exits before
// a single assertion runs.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// For SHELL_STAMP only. sw.js names its cache after a fingerprint of the files
// it precaches, and the only way to check a fingerprint is to recompute it.
import { createHash } from 'node:crypto';

// Up here rather than beside the shell section that was its only caller,
// because the UI section now reads js/ui.js as text too. See SCREENS below.
const REPO = fileURLToPath(new URL('../', import.meta.url));
const readRepo = (rel) => readFileSync(REPO + rel, 'utf8');

/**
 * Every flat-bodied rule in a stylesheet, as { sel, body, at }.
 *
 * `at` is the at-rule prelude the rule sits inside — '' for a rule that always
 * applies, '@media (prefers-reduced-motion: reduce)' for one that does not.
 * Recording it is not decoration: the FIRST version of this walked the braces
 * with one regex, which flattens the nesting away, and the hand-geometry
 * section below then read `transform` off `.card-btn.sel .card` and got the
 * `none` from inside the reduced-motion block instead of the translateY from
 * the rule that normally applies. A parser that cannot tell "always" from
 * "sometimes" reports the last thing it saw and calls it the value.
 *
 * Comments are stripped first: this project's stylesheet quotes selectors at
 * length in its prose, and a parser that reads the prose finds rules that do
 * not exist.
 *
 * Up here rather than inside the seat-state section that first needed it,
 * because the hand-geometry section needs the same parse. A stylesheet parser
 * is exactly the kind of thing that gets copied into the second caller and
 * then improved in only one of the two.
 */
function cssRules(rel) {
  const src = readRepo(rel).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  const brace = /[{}]/g;
  let from = 0, m;
  while ((m = brace.exec(src))) {
    const text = src.slice(from, m.index);
    from = m.index + 1;
    if (m[0] === '{') {
      // Whatever we were inside has a nested block, so it is a wrapper and not
      // a rule of its own.
      if (stack.length) stack[stack.length - 1].wrapper = true;
      stack.push({ head: text.trim(), wrapper: false });
    } else {
      const frame = stack.pop();
      if (!frame) continue; // stray '}': malformed CSS, and not this file's job
      if (!frame.wrapper) out.push({ sel: frame.head, body: text, at: stack.map((f) => f.head).join(' ') });
    }
  }
  return out;
}

/**
 * The last value `prop` is given by the rule whose selector is exactly `sel`.
 * Last, not first, because that is what the cascade does with two declarations
 * of the same property at the same specificity — reading the first would make
 * this disagree with the browser precisely when someone has overridden
 * something, which is when it matters.
 *
 * Conditional rules are skipped. A declaration inside @media is the value for
 * the readers that match the query, not the value; callers here are asking
 * what the layout is, and the answer has to be the one that does not depend on
 * who is looking.
 */
function cssDecl(rules, sel, prop) {
  let found = null;
  for (const r of rules) {
    if (r.sel !== sel || r.at) continue;
    for (const d of r.body.split(';')) {
      const m = d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
      if (m && m[1] === prop) found = m[2];
    }
  }
  return found;
}

/**
 * sw.js's three constants, obtained by EXECUTING the file rather than by
 * regex — a regex over source is a parser that does not report syntax errors.
 *
 * Up here beside readRepo rather than down in the shell section that used to
 * be its only caller, because --write-stamp needs it too. Two copies of "how
 * you get SHELL out of sw.js" is the same shape of defect as two copies of the
 * seal: they agree until one is updated and the other is not.
 *
 * Returns the parse error rather than asserting on it. One caller counts a
 * failure and carries on with empty constants; the other has to refuse to
 * write anything at all. Neither of those decisions belongs in here.
 */
function loadSwConsts() {
  const src = readRepo('sw.js');
  let factory = null;
  try {
    // eslint-disable-next-line no-new-func
    factory = new Function(
      'self', 'caches', 'fetch', 'Response',
      src + '\n; return { CACHE_NAME, SHELL, SHELL_STAMP };'
    );
  } catch (e) {
    return { src, error: e, CACHE_NAME: '', SHELL: [], SHELL_STAMP: '' };
  }
  // A throwaway instantiation purely to read the constants. The handlers it
  // registers are dropped; the real drive happens in the shell section.
  const consts = factory(
    { addEventListener() {}, location: { origin: 'https://x.test' }, clients: {} },
    {}, () => {}, class {}
  );
  return { src, error: null, ...consts };
}

/**
 * THE FINGERPRINT, in one place. sw.js names its cache after a hash of the
 * files it precaches, so a stale name is a returning visitor pinned to a build
 * that was fixed weeks ago — and the only way to check a fingerprint is to
 * recompute it.
 *
 * This function is the ONLY implementation of that hash in the repository, and
 * that is deliberate rather than tidy. The checker below and the --write-stamp
 * writer both call it, and had the writer been given its own copy the two
 * would have agreed right up until one of them learned something the other did
 * not — a new binary extension, a different separator — at which point the
 * writer would confidently paste a value the checker rejects. That is the same
 * defect as the two sealers in #26 and the hand-written handler lists in #27,
 * and the fix is the same one: derive it once, call it twice.
 *
 * Returns the counts alongside the digest because a hash of nothing is still a
 * hash. Both callers need to know the sweep found something before they
 * believe the twelve characters it produced.
 */
function shellStampOf(SHELL) {
  // './' and './index.html' are the same bytes from any static host; hashing
  // both would count the page twice and, worse, would make the stamp depend on
  // a listing decision rather than on content. Mapped and de-duplicated.
  // Sorted, so the order of the SHELL array — which is written for humans, in
  // dependency order — cannot change the answer.
  const paths = [...new Set(SHELL.map((p) => (p === './' ? './index.html' : p)))].sort();

  const BINARY = /\.(png|jpg|jpeg|ico|woff2?)$/;
  const h = createHash('sha256');
  let hashed = 0;
  let unreadable = 0;
  for (const p of paths) {
    let bytes;
    try { bytes = readFileSync(REPO + p.slice(2)); } catch (_) { unreadable++; continue; }
    // LINE ENDINGS NORMALISED for text. A checkout on Windows and a checkout
    // on Linux hold different bytes for the same commit, and without this the
    // suite would fail on one of them for a reason that has nothing to do with
    // the app. Binaries are hashed as-is — there are no line endings in a PNG,
    // only pixels that happen to be 0x0D.
    if (!BINARY.test(p)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    // The path goes into the hash as well as the contents, with a separator, so
    // that renaming a file changes the stamp even when its bytes do not — and
    // so that two adjacent files cannot be concatenated into the same digest as
    // one longer file.
    h.update(p); h.update('\0'); h.update(bytes); h.update('\0');
    hashed++;
  }
  return { stamp: h.digest('hex').slice(0, 12), hashed, unreadable };
}

/** The one line --write-stamp is allowed to touch. */
const STAMP_ANCHOR = /^const SHELL_STAMP = '([0-9a-f]{12})';$/m;

/**
 * WHAT --write-stamp WOULD DO TO A GIVEN sw.js, decided without touching the
 * disk. Returns `{ refuse, stamp, hashed, unreadable, was, next }`, where
 * `refuse` is a reason string or null, and `next` is the complete new file
 * text or null if it refused.
 *
 * SPLIT OUT FROM THE WRITER SO THE SUITE CAN DRIVE IT. The guards below are
 * the entire reason a test runner is trusted with a write, and as long as they
 * lived inside `if (process.argv.includes(...))` nothing could reach them: the
 * suite never takes that branch, so deleting every one of them would have left
 * 121,000 assertions green and a writer that pastes a hash of an empty sweep
 * over the deploy blocker it was meant to fix. Untested safety code is
 * decoration, and it is the most dangerous kind because of how it reads.
 *
 * Pure, and takes the parsed file rather than reading it, so the suite can
 * hand it a two-anchor sw.js or a SHELL full of paths that do not exist —
 * inputs that cannot be produced any other way without damaging the working
 * tree to test the thing that protects it.
 */
function planStampWrite(sw) {
  const refuse = (why) => ({ refuse: why, stamp: null, hashed: 0, unreadable: 0, was: null, next: null });

  if (sw.error) return refuse(`sw.js does not parse — ${sw.error.message}`);
  if (!Array.isArray(sw.SHELL) || sw.SHELL.length === 0) return refuse('sw.js exports no usable SHELL');

  const { stamp, hashed, unreadable } = shellStampOf(sw.SHELL);
  // THE SAME PAIRING THE CHECKER USES, for a sharper reason. A hash over a
  // sweep that found nothing is a well-formed answer to the wrong question;
  // downstream of the checker that is a confusing failure, but downstream of
  // the writer it is a wrong value written into the file — and once written,
  // the checker agrees with it. The check and the fix cannot both be fooled by
  // the same bad input, so the fix has to be the more suspicious of the two.
  if (unreadable > 0) return refuse(`${unreadable} file(s) in SHELL could not be read off disk`);
  if (hashed < 20) return refuse(`the sweep covered only ${hashed} files — that is not the shell`);

  // The anchor has to be unique. A second occurrence means the file is not
  // shaped the way this assumes, and the honest response is to stop rather
  // than to edit whichever one happens to come first.
  const hits = sw.src.match(new RegExp(STAMP_ANCHOR.source, 'gm')) || [];
  if (hits.length !== 1) return refuse(`found ${hits.length} SHELL_STAMP declarations in sw.js, expected exactly 1`);

  return {
    refuse: null,
    stamp,
    hashed,
    unreadable,
    was: sw.src.match(STAMP_ANCHOR)[1],
    next: sw.src.replace(STAMP_ANCHOR, `const SHELL_STAMP = '${stamp}';`),
  };
}

/**
 * `node scripts/test-engine.mjs --write-stamp` — the one mode in which the
 * test runner writes to the repository.
 *
 * WHY THIS EXISTS. Every legitimate edit to a shell file makes the suite red
 * until somebody pastes twelve hex characters into sw.js. That is correct —
 * the stamp really is stale — but it costs a round trip on every change, and a
 * check that is red for a known and mechanical reason is a check people learn
 * to run last. Printing the answer was the first half of that fix; applying it
 * is the second.
 *
 * WHY IT IS FENCED THIS TIGHTLY. A test runner that can edit the code it
 * grades is exactly the tool you would build if you wanted a green suite that
 * means nothing, so the blast radius is cut down to the smallest thing that
 * still does the job:
 *
 *   - it runs HERE, above SCREENS and above every assertion, and exits. There
 *     is no path on which a run both writes a stamp and reports a pass count,
 *     so `npm test` cannot quietly repair what it was meant to catch. That the
 *     test script does not pass the flag is asserted in the shell section.
 *   - it writes ONE line, and only where planStampWrite() above allows it.
 *   - it reads the file back and re-parses before claiming success.
 *
 * Note it is safe for this to write sw.js at all only because sw.js is not in
 * SHELL: the file holding the hash is not among the files hashed, so writing
 * it does not move the target. That is asserted in the shell section too.
 */
if (process.argv.includes('--write-stamp')) {
  const plan = planStampWrite(loadSwConsts());

  if (plan.refuse) {
    console.error(`--write-stamp refused: ${plan.refuse}`);
    console.error('sw.js is unchanged. Fix the above and run it again.');
    process.exit(1);
  }

  if (plan.was === plan.stamp) {
    console.log(`shell stamp already current: ${plan.stamp} over ${plan.hashed} files. Nothing written.`);
    process.exit(0);
  }

  writeFileSync(REPO + 'sw.js', plan.next, 'utf8');

  // READ IT BACK. The difference between "wrote the file" and "the file now
  // says what I meant" is the whole reason this mode is allowed to exist, and
  // re-parsing is the only way to learn that the replacement landed inside a
  // string literal or broke the syntax on the way past.
  const after = loadSwConsts();
  if (after.error) {
    console.error(`--write-stamp: sw.js no longer parses after the write — ${after.error.message}`);
    process.exit(1);
  }
  if (after.SHELL_STAMP !== plan.stamp) {
    console.error(`--write-stamp: sw.js still reads ${after.SHELL_STAMP} after the write`);
    process.exit(1);
  }

  console.log(`shell stamp: ${plan.was} -> ${plan.stamp}  (over ${plan.hashed} files)`);
  console.log(`cache name:  ${after.CACHE_NAME}`);
  console.log('Review the diff, then run the suite.');
  process.exit(0);
}

/**
 * EVERY SCREEN render() DISPATCHES ON, read out of js/ui.js rather than typed
 * here.
 *
 * Three separate sweeps below used to carry their own hand-written copy of
 * this list — the render-everything sweep, the help-button sweep and the
 * drawer sweep. A fourth screen landing means remembering all three, and the
 * cost of forgetting is not a red suite: it is a screen that is never drawn
 * by any test, which is the most comfortable place in the codebase for a
 * crash to live. 'nonsense' is appended on purpose and is not in the file: a
 * screen name nothing should ever set must fall through to home rather than
 * to a blank page, and that is only asserted if something asks for one.
 */
const SCREENS = (() => {
  const src = readRepo('js/ui.js');
  const body = src.slice(src.indexOf('switch (app.screen)'));
  const found = [...body.slice(0, body.indexOf('\n  }')).matchAll(/case '([a-z]+)':/g)]
    .map((m) => m[1]);
  if (found.length < 5) throw new Error(`SCREENS found only ${found.length} cases in ui.js`);
  return [...found, 'nonsense'];
})();

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function same(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn, msg) {
  try { fn(); } catch (_) { passed++; return; }
  failed++; console.error('  ✗ FAIL:', msg, '— expected a throw, got none');
}
function section(t) { console.log('\n— ' + t); }

// ---------------------------------------------------------------------------
// Deterministic RNG.
//
// cards.js shuffles through crypto.getRandomValues, so an unseeded run deals a
// different game every time and a failure cannot be reproduced. cards.js reads
// `crypto` at call time, so replacing the global here — before anything is
// dealt — is enough. seed(n) restarts the stream.
// ---------------------------------------------------------------------------
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i++) {
        prng = (prng + 0x6D2B79F5) >>> 0;
        let t = prng;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        buf[i] = (t ^ (t >>> 14)) >>> 0;
      }
      return buf;
    },
  },
});
seed(1);

// ===========================================================================
section('Card vocabulary');
// ===========================================================================

eq(SUITS.length, 4, 'four suits');
eq(RANKS.length, 13, 'thirteen ranks');
eq(rankOf('TH'), 'T', 'rankOf reads the first character');
eq(suitOf('TH'), 'H', 'suitOf reads the second character');

// SUITS is the Kachuful rotation order, and js/rules.js generates the round's
// trump from it. Written down here so a "tidy-up" into bridge order fails a
// test rather than silently renaming every round's trump.
same([...SUITS], ['S', 'D', 'C', 'H'], 'SUITS is the KaChuFuL rotation: spades, diamonds, clubs, hearts');

// Ace high is the whole point; a silent off-by-one here inverts every trick.
ok(rankValue('AS') > rankValue('KS'), 'ace beats king');
ok(rankValue('KS') > rankValue('QS'), 'king beats queen');
ok(rankValue('TS') > rankValue('9S'), 'ten beats nine');
ok(rankValue('3S') > rankValue('2S'), 'three beats deuce');
eq(rankValue('2S'), 2, 'deuce is 2');
eq(rankValue('AS'), 14, 'ace is 14');

// RANKS is descending, so strength must fall monotonically across it.
let monotonic = true;
for (let i = 1; i < RANKS.length; i++) {
  if (rankValue(RANKS[i] + 'S') >= rankValue(RANKS[i - 1] + 'S')) monotonic = false;
}
ok(monotonic, 'rankValue falls monotonically across RANKS');

eq(rankLabel('TH'), '10', 'the ten displays as 10, not T');
eq(rankLabel('AH'), 'A', 'other ranks display as stored');
eq(cardName('QH'), 'Queen of hearts', 'spoken card name');
eq(cardName('TS'), '10 of spades', 'spoken ten');
eq(suitName('C'), 'clubs', 'spoken suit name');
eq(suitGlyph('D'), '♦', 'suit glyph');

ok(isRedSuit('H') && isRedSuit('D'), 'hearts and diamonds are red');
ok(!isRedSuit('S') && !isRedSuit('C'), 'spades and clubs are not');
ok(isRedCard('2D') && !isRedCard('AS'), 'card colour follows its suit');

eq(cleanName('  Asha   Rao  '), 'Asha Rao', 'names collapse whitespace and trim');
eq(cleanName('a'.repeat(40)).length, MAX_NAME_LEN, 'names are capped');
eq(cleanName('Ro\u0007hit'), 'Rohit', 'control characters are dropped, not rendered');

// ===========================================================================
section('Trump, and the absence of it');
// ===========================================================================

// Three states, not two. The bug this guards against is a trick resolved in the
// gap before a turn-up reveal being scored as though nothing were trump.
ok(!SUITS.includes(NO_TRUMP), 'the NO_TRUMP sentinel is not one of the four suits');
ok(isTrumpSuit('S') && isTrumpSuit('H'), 'a suit is a trump suit');
ok(!isTrumpSuit(NO_TRUMP), 'No Trump is not a trump suit');
ok(!isTrumpSuit(null), 'a trump that has not been turned yet is not a trump suit');
ok(!isTrumpSuit('X') && !isTrumpSuit(undefined), 'junk arriving over the wire is not a trump suit');

eq(trumpName('S'), 'spades', 'a named trump reads as its suit');
eq(trumpName(NO_TRUMP), 'no trump', 'No Trump has words of its own');
eq(trumpName(null), 'not yet turned', 'an unturned trump is distinguishable from No Trump');
ok(trumpGlyph(NO_TRUMP) !== suitGlyph('S'), 'No Trump does not borrow a suit pip');

// ===========================================================================
section('CLOCKWISE turn order');
// ===========================================================================
//
// Judgement deals and plays clockwise; seats are numbered clockwise; so the
// next player is seat + 1, and that is the player on your LEFT. courtpiece is
// the mirror image of every line in this block.

eq(CLOCKWISE, 1, 'clockwise is +1 because seat numbers ascend clockwise');
eq(ANTICLOCKWISE, -1, 'anticlockwise is -1');
eq(TABLE_DIRECTION, CLOCKWISE, 'JUDGEMENT RUNS CLOCKWISE');

eq(nextSeat(0, 4), 1, 'next after seat 0 of 4 is seat 1');
eq(nextSeat(3, 4), 0, 'the table wraps');
eq(prevSeat(0, 4), 3, 'previous wraps the other way');
eq(prevSeat(1, 4), 0, 'previous is the seat that just acted');

// The explicit disagreement with the sibling repo. If somebody pastes
// courtpiece's nextSeat() in here, this is the line that fails.
let agreesWithCourtPiece = 0;
for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
  for (let s = 0; s < n; s++) {
    if (nextSeat(s, n) === stepSeat(s, n, ANTICLOCKWISE)) agreesWithCourtPiece++;
  }
}
eq(agreesWithCourtPiece, 0,
  'at no seat and no table size does the clockwise next seat equal the anticlockwise one');

// Direction has no default, so a call that forgets it cannot quietly inherit
// this game's answer.
throws(() => stepSeat(0, 4, undefined), 'stepSeat refuses a missing direction');
throws(() => stepSeat(0, 4, 0), 'stepSeat refuses a direction that is neither');
throws(() => stepSeat(0, 4, 2), 'stepSeat refuses a two-seat step');

// Walking the whole table must return to the start and visit everyone once.
for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
  const order = seatsFrom(0, n);
  eq(order.length, n, `${n} players: the order names every seat`);
  eq(new Set(order).size, n, `${n} players: and names each of them once`);
  same(order, Array.from({ length: n }, (_, i) => i),
    `${n} players: play order from seat 0 ascends, which is clockwise`);
  eq(nextSeat(order[n - 1], n), 0, `${n} players: the last seat hands back to the first`);
}

same(seatsFrom(2, 5), [2, 3, 4, 0, 1], 'five players led by seat 2');
same(seatsFrom(6, 7), [6, 0, 1, 2, 3, 4, 5], 'seven players led by the last seat');

// The two rules that lean on the direction, stated as tests rather than left
// implied — see the banner in js/trick.js.
const DEALER = 2;
eq(nextSeat(DEALER, 5), 3, 'bidding opens to the dealer\'s left');
same(seatsFrom(nextSeat(DEALER, 5), 5), [3, 4, 0, 1, 2], 'and the dealer bids last');

// ===========================================================================
section('Follow-suit legality');
// ===========================================================================

const HAND = ['AS', 'KH', '7H', '2C', 'TD'];

same(legalPlays(HAND, null), HAND, 'leading, everything is legal');
same(legalPlays(HAND, 'H'), ['KH', '7H'], 'holding the led suit, only that suit is legal');
same(legalPlays(HAND, 'S'), ['AS'], 'a singleton in the led suit is the only legal card');

same(legalPlays(HAND, 'D'), ['TD'], 'holding one diamond, that diamond is forced');

// The rule people get wrong. A void player may discard from anywhere and is
// under no obligation to trump, even holding trumps.
const VOID_IN_HEARTS = ['AS', 'KS', '2C', 'TD'];
same(legalPlays(VOID_IN_HEARTS, 'H'), VOID_IN_HEARTS,
  'void in the led suit: every card is legal, including a discard over a trump');

ok(legalPlays(HAND, null) !== HAND, 'legalPlays never hands back the caller\'s own array');
ok(legalPlays(VOID_IN_HEARTS, 'H') !== VOID_IN_HEARTS, 'not even in the everything-legal case');

ok(canPlay(HAND, 'KH', 'H'), 'following suit is legal');
ok(!canPlay(HAND, 'AS', 'H'), 'holding hearts, a spade is not');
ok(canPlay(VOID_IN_HEARTS, 'AS', 'H'), 'void in hearts, a spade is');
ok(canPlay(VOID_IN_HEARTS, 'TD', 'H'), 'and so is a plain discard');
ok(!canPlay(HAND, '3D', 'D'), 'a card you do not hold is never legal');
ok(canPlay(HAND, 'AS', null), 'leading, anything in hand is legal');

// Legality is a question about the led suit alone. Neither function takes a
// trump argument, which is the strongest way to say it.
eq(legalPlays.length, 2, 'legalPlays takes a hand and a led suit, and nothing else');
eq(canPlay.length, 3, 'canPlay takes a hand, a card and a led suit, and nothing else');

eq(illegalReason(HAND, 'KH', 'H'), null, 'a legal card has no reason');
eq(illegalReason(HAND, 'AS', 'H'), 'cannot play, must follow hearts',
  'the reason names the suit in words, because it is read aloud');
eq(illegalReason(HAND, '3D', 'D'), 'not in your hand', 'and distinguishes a card you never had');

// ===========================================================================
section('The trick winner, with trumps');
// ===========================================================================

eq(trickWinner([], 'S'), null, 'an empty trick has no winner');
eq(trickWinner(null, 'S'), null, 'and neither does a missing one');

const FOLLOWED = [
  { seat: 0, code: '9H' },
  { seat: 1, code: 'KH' },
  { seat: 2, code: '2H' },
  { seat: 3, code: 'AH' },
];
eq(ledSuitOf(FOLLOWED), 'H', 'the led suit is the first card played');
eq(trickWinner(FOLLOWED, 'S'), 3, 'everyone followed: the highest of the led suit takes it');
eq(winningCard(FOLLOWED, 'S'), 'AH', 'and winningCard names it');

const TRUMPED = [
  { seat: 0, code: 'AH' },
  { seat: 1, code: 'KH' },
  { seat: 2, code: '2S' },
  { seat: 3, code: 'QH' },
];
eq(trickWinner(TRUMPED, 'S'), 2, 'the lowest trump beats the ace of the led suit');
eq(trickWinner(TRUMPED, 'H'), 0, 'and with hearts trump instead, the ace takes it back');
eq(trickWinner(TRUMPED, 'C'), 0, 'with an unrelated suit trump, the led suit decides');

const OVERTRUMPED = [
  { seat: 0, code: 'AH' },
  { seat: 1, code: '2S' },
  { seat: 2, code: '5S' },
  { seat: 3, code: 'KH' },
];
eq(trickWinner(OVERTRUMPED, 'S'), 2, 'the higher trump takes it from the lower');

// A discard cannot win, whatever it is. This is what makes ducking possible.
const DISCARDED = [
  { seat: 0, code: '3H' },
  { seat: 1, code: 'AC' },
  { seat: 2, code: 'AD' },
  { seat: 3, code: '2H' },
];
eq(trickWinner(DISCARDED, 'S'), 0, 'two off-suit aces lose to the three of the led suit');

// Part-played tricks have a leader too; the UI and the bot both ask.
eq(trickWinner(FOLLOWED.slice(0, 2), 'S'), 1, 'a part-played trick has a current leader');
eq(trickWinner(FOLLOWED.slice(0, 1), 'S'), 0, 'the lead card leads');

// Seven seats, to be sure nothing assumes four.
const SEVEN = [
  { seat: 3, code: '4D' }, { seat: 4, code: 'JD' }, { seat: 5, code: '2C' },
  { seat: 6, code: 'AD' }, { seat: 0, code: '3C' }, { seat: 1, code: 'QD' },
  { seat: 2, code: '9D' },
];
eq(trickWinner(SEVEN, 'H'), 6, 'seven players, no trump played: the ace of diamonds takes it');
eq(trickWinner(SEVEN, 'C'), 0, 'seven players: the three of clubs trumps the ace of diamonds');
eq(trickWinner(SEVEN, 'D'), 6, 'seven players: diamonds trump, same ace, same winner');

// ===========================================================================
section('The trick winner under No Trump');
// ===========================================================================
//
// A distinct code path, tested apart from the trump one because the failure it
// guards against — a discard winning because nothing outranked it — is silent.

eq(trickWinner(TRUMPED, NO_TRUMP), 0, 'No Trump: the two of spades does not beat the ace of hearts');
eq(trickWinner(OVERTRUMPED, NO_TRUMP), 0, 'No Trump: neither spade wins; the ace of hearts holds');
eq(trickWinner(FOLLOWED, NO_TRUMP), 3, 'No Trump with everyone following: highest of the led suit');
eq(trickWinner(SEVEN, NO_TRUMP), 6, 'No Trump at seven seats: the ace of diamonds');

// An unturned trump must behave identically. This is the gap before a turn-up
// reveal, and getting it wrong would hand the trick to the wrong player exactly
// once per round, which is the kind of bug nobody reports.
for (const t of [null, undefined, 'X']) {
  eq(trickWinner(TRUMPED, t), trickWinner(TRUMPED, NO_TRUMP),
    `a trump of ${JSON.stringify(t)} resolves like No Trump rather than like a suit`);
}

// The rule that only exists in No Trump rounds: void means you cannot win.
// Seat 1 holds the ace of all three other suits and loses with every one.
let voidEverWon = 0;
for (const discard of ['AS', 'AC', 'AD']) {
  const trick = [{ seat: 0, code: '2H' }, { seat: 1, code: discard }];
  if (trickWinner(trick, NO_TRUMP) === 1) voidEverWon++;
}
eq(voidEverWon, 0, 'No Trump: a player void in the led suit cannot take the trick with anything');

// The same three discards against a real trump, to show the branch is doing
// work rather than the cards being weak.
eq(trickWinner([{ seat: 0, code: '2H' }, { seat: 1, code: 'AS' }], 'S'), 1,
  'with spades trump the same discard wins, so the No Trump result was the branch and not the card');

// ===========================================================================
section('wouldWin — the bot\'s ducking question');
// ===========================================================================

const OPEN = [{ seat: 0, code: 'QH' }, { seat: 1, code: '4H' }];
ok(wouldWin(OPEN, 2, 'KH', 'S'), 'a higher heart takes the lead');
ok(!wouldWin(OPEN, 2, '2H', 'S'), 'a lower heart does not — which is how a bot ducks');
ok(wouldWin(OPEN, 2, '2S', 'S'), 'the lowest trump takes the lead');
ok(!wouldWin(OPEN, 2, '2S', NO_TRUMP), 'and under No Trump it does not');
ok(wouldWin([], 0, '2C', 'S'), 'leading always takes the lead');

// Ducking is "the highest card that does not win", not "the lowest card" — so
// the question has to be asked per card rather than answered by sorting.
const DUCKABLE = ['JH', '9H', '2H'].filter((c) => !wouldWin(OPEN, 2, c, 'S'));
same(DUCKABLE, ['JH', '9H', '2H'], 'every heart below the queen ducks, and the jack is the best duck');

// ===========================================================================
section('The deck and the deal');
// ===========================================================================

const deck = buildDeck();
eq(deck.length, DECK_SIZE, 'a deck is 52 cards');
eq(new Set(deck).size, DECK_SIZE, 'all distinct — one deck, so a code is an identity');

const shuffled = shuffle(deck);
eq(shuffled.length, DECK_SIZE, 'a shuffle keeps every card');
eq(new Set(shuffled).size, DECK_SIZE, 'and adds none');
ok(shuffled !== deck, 'a shuffle returns a new array');
ok(shuffled.join('') !== deck.join(''), 'and actually moves something');

eq(emptyHands(3).length, 3, 'three empty hands for three players');
same(emptyHands(7), [[], [], [], [], [], [], []], 'seven for seven');

// --- the deal reads the turn direction out loud ---------------------------
//
// Against an UNSHUFFLED deck, one-at-a-time clockwise from the dealer's left
// produces a specific answer, and the anticlockwise answer is different. This
// is the second, independent pin on the direction.
const KNOWN = deal(buildDeck(), { players: 4, handSize: 2, dealerSeat: 0 });
same(KNOWN.hands[1], ['AS', 'TS'], 'the dealer\'s left hand neighbour is dealt first');
same(KNOWN.hands[2], ['KS', '9S'], 'then the next seat clockwise');
same(KNOWN.hands[3], ['QS', '8S'], 'then the next');
same(KNOWN.hands[0], ['JS', '7S'], 'and the dealer is dealt last, both times round');
eq(KNOWN.turnUpCard, null, 'no turn-up card unless the method asks for one');
eq(KNOWN.stock.length, DECK_SIZE - 8, 'the rest of the deck stays face down');

// --- the turn-up card ------------------------------------------------------
const FLIPPED = deal(buildDeck(), { players: 4, handSize: 2, dealerSeat: 0, turnUp: true });
eq(FLIPPED.turnUpCard, '6S', 'the turn-up comes off the top of what remains after dealing');
eq(FLIPPED.stock.length, DECK_SIZE - 9, 'and is spent — it is not in the stock');
let turnUpInAHand = 0;
for (const hand of FLIPPED.hands) if (hand.includes(FLIPPED.turnUpCard)) turnUpInAHand++;
eq(turnUpInAHand, 0, 'and never in anybody\'s hand');

// --- caps ------------------------------------------------------------------
eq(maxHandSize(3), 17, '3 players can be dealt 17 each');
eq(maxHandSize(4), 13, '4 players, 13 each — the whole deck');
eq(maxHandSize(5), 10, '5 players, 10 each');
eq(maxHandSize(6), 8, '6 players, 8 each');
eq(maxHandSize(7), 7, '7 players, 7 each');

// The turn-up method spends a card, so the cap is against 51 rather than 52.
// It only actually bites at four players, and that is the case worth pinning.
eq(maxHandSize(4, true), 12, '4 players in turn-up mode lose a card from the cap');
eq(maxHandSize(3, true), 17, '3 players do not');
eq(maxHandSize(5, true), 10, 'nor 5');
eq(maxHandSize(6, true), 8, 'nor 6');
eq(maxHandSize(7, true), 7, 'nor 7');

eq(defaultMaxHand(3), 10, 'the house default ladder tops out at ten');
eq(defaultMaxHand(4), 10, 'for three, four');
eq(defaultMaxHand(5), 10, 'and five players');
eq(defaultMaxHand(6), 8, 'six players get eight');
eq(defaultMaxHand(7), 7, 'seven get seven');
for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
  ok(defaultMaxHand(n) <= maxHandSize(n, true),
    `${n} players: the default ladder fits even with a card turned up`);
}

throws(() => deal(buildDeck(), { players: 7, handSize: 8, dealerSeat: 0 }),
  'a deal that would need 56 cards throws rather than dealing a short hand');
throws(() => deal(buildDeck(), { players: 4, handSize: 13, dealerSeat: 0, turnUp: true }),
  'and so does the whole deck plus a turn-up');

// --- exhaustive: every player count, every legal hand size ----------------
//
// The definition of done asks that a deal never exceed 52 cards, and 51 in
// turn-up mode. Rather than reason about it, deal every one of them.
let deals = 0, worstLeftover = DECK_SIZE;
for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
  for (const turnUp of [false, true]) {
    const cap = maxHandSize(players, turnUp);
    for (let handSize = 1; handSize <= cap; handSize++) {
      for (let dealerSeat = 0; dealerSeat < players; dealerSeat++) {
        seed(players * 1000 + handSize * 10 + dealerSeat);
        const r = deal(shuffle(buildDeck()), { players, handSize, dealerSeat, turnUp });
        deals++;

        const dealt = r.hands.flat();
        const spent = dealt.length + (r.turnUpCard ? 1 : 0);
        if (dealt.length !== players * handSize) {
          ok(false, `${players}p x ${handSize}: every seat gets exactly its hand`);
        }
        if (r.hands.some((h) => h.length !== handSize)) {
          ok(false, `${players}p x ${handSize}: no seat is short or long`);
        }
        if (new Set(dealt).size !== dealt.length) {
          ok(false, `${players}p x ${handSize}: no card is dealt twice`);
        }
        if (spent + r.stock.length !== DECK_SIZE) {
          ok(false, `${players}p x ${handSize}: hands + turn-up + stock is still 52`);
        }
        // The definition of done, stated directly: the cards that reach hands
        // never exceed 52, and never exceed 51 once one has been turned up.
        if (dealt.length > (turnUp ? DECK_SIZE - 1 : DECK_SIZE)) {
          ok(false, `${players}p x ${handSize}: the deal overran the deck`);
        }
        worstLeftover = Math.min(worstLeftover, r.stock.length);
      }
    }
  }
}
ok(deals > 300, `every legal round shape deals cleanly: ${deals} deals`);
// Four players at thirteen cards is the one shape that consumes the deck
// exactly. If this stops being reachable, a cap has drifted.
eq(worstLeftover, 0, 'the tightest legal deal uses the whole deck and leaves nothing');

// ===========================================================================
section('Sorting a hand');
// ===========================================================================

const FAN = ['2C', 'AH', '7S', 'KD', '3H', 'TS'];

const plain = sortHand(FAN);
same(plain, ['TS', '7S', 'AH', '3H', '2C', 'KD'],
  'grouped by suit in black-red-black-red order, ranks descending inside a suit');
ok(sortHand(FAN) !== FAN, 'sortHand returns a new array');
eq(sortHand(FAN).length, FAN.length, 'and keeps every card');

same(sortHand(FAN, 'D'), ['KD', 'TS', '7S', 'AH', '3H', '2C'],
  'the trump suit is pulled to the front, because counting trumps is the question');
same(sortHand(FAN, NO_TRUMP), plain,
  'a No Trump round has no suit to promote, so the fan is plain colour alternation');
same(sortHand(FAN, null), plain, 'and neither does a trump that has not been turned');

same(suitCounts(FAN), { S: 2, H: 2, D: 1, C: 1 }, 'suit counts');
same(suitCounts([]), { S: 0, H: 0, D: 0, C: 0 }, 'an empty hand counts zero of everything');

// ===========================================================================
section('Scoring: Kachuful');
// ===========================================================================

eq(scoreKachuful(3, 3, 10), 30, 'a made bid of three is worth thirty');
eq(scoreKachuful(1, 1, 10), 10, 'and a made one, ten');
eq(scoreKachuful(3, 4, 10), 0, 'overshooting scores nothing');
eq(scoreKachuful(3, 2, 10), 0, 'and falling short scores the same nothing');

// MISSING IS FREE, and uniformly so — that is what makes this the loose mode.
// Bidding four and taking three costs exactly what bidding three and taking two
// does, so reaching for one more trick is upside with no downside attached and
// the optimistic bid is the correct one. The bot's bidding leans on this.
const kachufulMisses = new Set();
for (let bid = 0; bid <= 10; bid++) {
  for (let actual = 0; actual <= 10; actual++) {
    if (actual !== bid) kachufulMisses.add(scoreKachuful(bid, actual, 10));
  }
}
same([...kachufulMisses], [0],
  'every miss costs the same nothing, however big the bid and however wide the miss');

eq(scoreKachuful(0, 0, 10), 50, 'a made zero pays five times the round size, not ten times zero');
eq(scoreKachuful(0, 0, 1), 5, 'so it is worth five in a one-card round');
eq(scoreKachuful(0, 1, 10), 0, 'and a missed zero scores nothing — no mode-wide penalty exists');

// The zero bid's whole character is that its reward curve does not sit on the
// same line as every other bid's. Derived from the two halves of the formula
// rather than pinned to a table of numbers, so changing either half has to face
// this rather than just re-baselining an expectation.
let curveWrong = 0, zeroBest = 0, zeroWorst = 0;
for (let R = 1; R <= 17; R++) {
  const zero = scoreKachuful(0, 0, R);
  for (let b = 1; b <= R; b++) {
    const made = scoreKachuful(b, b, R);
    if (b * 2 < R) { if (zero > made) zeroBest++; else curveWrong++; }
    else if (b * 2 === R) { if (zero !== made) curveWrong++; }
    else if (zero < made) zeroWorst++; else curveWrong++;
  }
}
eq(curveWrong, 0, 'a made zero beats every made bid below half the round size, ties at half, loses above');
ok(zeroBest > 0 && zeroWorst > 0,
  'which makes it both the best and the worst bid on the board, depending on the round size');

// ===========================================================================
section('Scoring: Standard Oh Hell');
// ===========================================================================

eq(scoreStandard(0, 0, 10), 10, 'a made zero is worth ten');
eq(scoreStandard(3, 3, 10), 13, 'a made three, thirteen');
eq(scoreStandard(10, 10, 10), 20, 'a made ten, twenty');
eq(scoreStandard(3, 2, 10), 0, 'a miss scores nothing');
eq(scoreStandard(3, 4, 10), 0, 'in either direction');

// The flattest of the three, and deliberately so. Ambition buys almost nothing
// and accuracy buys everything, which is what makes the bid a prediction rather
// than a wager — and what tells the bot to name the likeliest count, full stop.
const ambition = scoreStandard(10, 10, 10) - scoreStandard(0, 0, 10);
const accuracy = scoreStandard(5, 5, 10) - scoreStandard(5, 4, 10);
eq(ambition, 10, 'the whole ambition spread of a ten-card round is ten points');
ok(ambition < accuracy,
  'less than the swing between making one middling bid and missing it');

// ===========================================================================
section('Scoring: Square, the mode that goes negative');
// ===========================================================================

eq(scoreSquare(0, 0, 10), 10, 'a made zero is worth ten');
eq(scoreSquare(3, 3, 10), 19, 'a made three is ten plus nine');
eq(scoreSquare(10, 10, 10), 110, 'a made ten is ten plus a hundred');

eq(scoreSquare(3, 4, 10), -1, 'overshooting by one costs one');
eq(scoreSquare(3, 6, 10), -9, 'by three, nine');
eq(scoreSquare(3, 0, 10), -9, 'and undershooting by three costs the same nine');

// The penalty is symmetric because the square is, and that symmetry is what
// forces the ducking the whole game turns on: once you have made your bid,
// every further trick is as expensive as a trick you failed to take.
let asymmetric = 0;
for (let b = 0; b <= 17; b++) {
  for (let k = 1; b + k <= 17; k++) {
    if (b - k < 0) continue;
    if (scoreSquare(b, b + k, 17) !== scoreSquare(b, b - k, 17)) asymmetric++;
  }
}
eq(asymmetric, 0, 'missing high and missing low by the same amount cost exactly the same');

// Negative RUNNING TOTALS are normal here rather than a corner case — the
// scoreboard in js/ui.js has to be built for them from the start.
const SQUARE_MATCH = [[2, 4], [1, 3], [0, 2], [3, 3]];  // three misses and a made three
let squareTotal = 0;
for (const [bid, actual] of SQUARE_MATCH) squareTotal += scoreSquare(bid, actual, 10);
eq(squareTotal, 7, 'three misses of two against one made three leaves seven');
let deepest = 0, running = 0;
for (const [bid, actual] of SQUARE_MATCH) {
  running += scoreSquare(bid, actual, 10);
  deepest = Math.min(deepest, running);
}
ok(deepest < 0, 'and the running total is below zero on the way there');
ok(scoreSquare(0, 10, 10) < -99, 'a player who ducks a zero bid and takes the lot is a hundred down');

// ===========================================================================
section('Scoring: the three modes are three different games');
// ===========================================================================

same(SCORING_MODES, ['kachuful', 'standard', 'square'],
  'the modes, in the order the lobby offers them');
ok(Object.isFrozen(SCORING_MODES), 'and the list is frozen');

// If two modes agreed about what a bid is worth there would be no reason for
// the host to choose between them. Each pair has to disagree somewhere.
const MODE_PAIRS = [['kachuful', 'standard'], ['kachuful', 'square'], ['standard', 'square']];
for (const [a, b] of MODE_PAIRS) {
  let differs = false;
  for (let bid = 0; bid <= 10 && !differs; bid++) {
    for (let actual = 0; actual <= 10 && !differs; actual++) {
      if (scoreRound(a, bid, actual, 10) !== scoreRound(b, bid, actual, 10)) differs = true;
    }
  }
  ok(differs, `${a} and ${b} score some round differently`);
}

// The one structural difference, stated as a property: only square can take
// points away, and it does so on EVERY miss.
let loose = 0, punishing = 0;
for (let bid = 0; bid <= 10; bid++) {
  for (let actual = 0; actual <= 10; actual++) {
    if (actual === bid) continue;
    if (scoreRound('kachuful', bid, actual, 10) === 0) loose++;
    if (scoreRound('standard', bid, actual, 10) === 0) loose++;
    if (scoreRound('square', bid, actual, 10) < 0) punishing++;
  }
}
eq(loose, 220, 'every miss in kachuful and standard is free');
eq(punishing, 110, 'and every miss in square costs something');

// ===========================================================================
section('Scoring: the dispatcher');
// ===========================================================================

eq(scoreKachuful.length, 3, 'scoreKachuful takes bid, actual and round size');
eq(scoreStandard.length, 3, 'so does scoreStandard, though it ignores the round size');
eq(scoreSquare.length, 3, 'and so does scoreSquare — a uniform signature is what makes the table lookup possible');
eq(scoreRound.length, 4, 'scoreRound takes the mode in front of those three');

eq(scoreRound('kachuful', 0, 0, 7), scoreKachuful(0, 0, 7), 'scoreRound dispatches to kachuful');
eq(scoreRound('standard', 4, 4, 7), scoreStandard(4, 4, 7), 'to standard');
eq(scoreRound('square', 4, 6, 7), scoreSquare(4, 6, 7), 'and to square');

// A mode in the lobby's list with no formula behind it would throw halfway
// through somebody's match, after the bids were in.
let undispatchable = 0;
for (const mode of SCORING_MODES) {
  try { scoreRound(mode, 1, 1, 5); } catch (_) { undispatchable++; }
}
eq(undispatchable, 0, 'every mode the lobby offers has a formula behind it');

throws(() => scoreRound('judgement', 1, 1, 5), 'an unrecognised mode throws rather than scoring a silent zero');
throws(() => scoreRound(undefined, 1, 1, 5), 'and so does a missing one');
throws(() => scoreRound('', 1, 1, 5), 'and an empty string');
// Inherited Object.prototype members are the reason the formula table has a
// null prototype. A plain object literal answers 'toString' with a function,
// walks past the guard, and scores the round '[object Undefined]'.
throws(() => scoreRound('toString', 1, 1, 5), 'toString is not a scoring mode');
throws(() => scoreRound('valueOf', 1, 1, 5), 'neither is valueOf');
throws(() => scoreRound('constructor', 1, 1, 5), 'nor constructor');
throws(() => scoreRound('__proto__', 1, 1, 5), 'nor __proto__');

// ===========================================================================
section('Scoring: every mode, every round size, every bid, every outcome');
// ===========================================================================

// Exhaustive over the whole legal space — 3 players at seventeen cards is the
// largest round the deck allows, so no real match reaches past R = 17.
let nonInteger = 0, negativeOutsideSquare = 0, madeBidPunished = 0, cells = 0;
for (const mode of SCORING_MODES) {
  for (let R = 1; R <= 17; R++) {
    for (let bid = 0; bid <= R; bid++) {
      for (let actual = 0; actual <= R; actual++) {
        const score = scoreRound(mode, bid, actual, R);
        cells++;
        if (!Number.isInteger(score)) nonInteger++;
        if (score < 0 && mode !== 'square') negativeOutsideSquare++;
        if (actual === bid && score <= 0) madeBidPunished++;
      }
    }
  }
}
ok(cells > 2000, `the whole legal scoring space is covered: ${cells} cells`);
eq(nonInteger, 0, 'every score is a whole number — no mode can produce a fraction to render');
eq(negativeOutsideSquare, 0, 'square is the only mode that can take points away');
eq(madeBidPunished, 0, 'and making your bid is always worth something, in every mode and every round');

// ===========================================================================
section('The four axes');
// ===========================================================================

// Not a fact about the number 54 — a fact about there being FOUR axes. A fifth
// added quietly is a fifth the bot and the scoreboard were never told about.
eq(SCORING_MODES.length * TRUMP_METHODS.length * ROUND_SHAPES.length * 2, 54,
  'three scoring modes x three trump methods x three shapes x the hook is 54 playable games');
ok(Object.isFrozen(TRUMP_METHODS) && Object.isFrozen(ROUND_SHAPES), 'the axis lists are frozen');
eq(Object.keys(DEFAULT_CONFIG).length, 5, 'a config is the four axes plus the biggest hand, and nothing else');
ok(Object.isFrozen(DEFAULT_CONFIG), 'and the default is frozen');

// ===========================================================================
section('Trump: the rotations and the turn-up');
// ===========================================================================

same([0, 1, 2, 3].map((i) => trumpForRound('rotation', i)), ['S', 'D', 'C', 'H'],
  'KaChuFuL — kari, chukat, falli, lal');
same([4, 5, 6, 7].map((i) => trumpForRound('rotation', i)), ['S', 'D', 'C', 'H'],
  'and round again, every four');

same([0, 1, 2, 3, 4].map((i) => trumpForRound('rotation-nt', i)), ['S', 'D', 'C', 'H', NO_TRUMP],
  'the No Trump rotation adds a fifth round where nothing trumps');
eq(trumpForRound('rotation-nt', 5), 'S', 'and then starts over');
eq(trumpForRound('rotation-nt', 9), NO_TRUMP, 'every fifth round is a No Trump round');

// Five against four, so the two rotations disagree almost immediately and a
// match under one is nothing like a match under the other. That is why both
// are offered, and it is worth knowing the day someone "tidies" the sequences.
let rotationsAgree = 0;
for (let i = 0; i < 20; i++) if (trumpForRound('rotation', i) === trumpForRound('rotation-nt', i)) rotationsAgree++;
ok(rotationsAgree < 10, 'the two rotations fall out of step within the first twenty rounds');

// NOT NO_TRUMP. Null is "not decided yet"; NO_TRUMP is "decided, and the
// decision is that nothing trumps". Collapsing them resolves tricks wrongly in
// the gap before the reveal.
eq(trumpForRound('turnup', 0), null, 'the turn-up method has no trump before the flip');
eq(trumpForRound('turnup', 7), null, 'in any round');
ok(trumpForRound('turnup', 0) !== NO_TRUMP, 'and "not yet turned" is not the same value as "no trump"');
eq(isTrumpSuit(trumpForRound('turnup', 0)), false, 'neither of them names a suit');

throws(() => trumpForRound('bridge', 0), 'an unrecognised trump method throws');
throws(() => trumpForRound('toString', 0), 'and so does an inherited object key');

eq(needsTurnUp('turnup'), true, 'only the turn-up method spends a card off the stock');
eq(needsTurnUp('rotation'), false, 'the rotation does not');
eq(needsTurnUp('rotation-nt'), false, 'nor does the No Trump rotation');

// ===========================================================================
section('Round shapes: the ladder');
// ===========================================================================

same(roundSizes('descending', 5), [5, 4, 3, 2, 1], 'descending runs down to the one-card round');
same(roundSizes('ascending', 5), [1, 2, 3, 4, 5], 'ascending runs up from it');
same(roundSizes('downup', 5), [5, 4, 3, 2, 1, 2, 3, 4, 5], 'down and back up turns at the bottom');

// The turn is the whole subtlety: 2n-1 rounds, not 2n. Playing the one-card
// round twice would be a whole extra hand nobody expected, and the lobby's
// advertised round count would be a lie.
eq(roundSizes('downup', 10).length, 19, 'ten cards down and back up is nineteen rounds, not twenty');
eq(roundSizes('downup', 10).filter((n) => n === 1).length, 1, 'because the one-card round is played once');
eq(roundSizes('downup', 10).filter((n) => n === 10).length, 2, 'while the biggest hand is played twice');

let shapesWrong = 0;
for (const shape of ROUND_SHAPES) {
  for (let top = 1; top <= MAX_HAND_CEILING; top++) {
    const sizes = roundSizes(shape, top);
    const expected = shape === 'downup' ? 2 * top - 1 : top;
    if (sizes.length !== expected) shapesWrong++;
    if (Math.max(...sizes) !== top) shapesWrong++;
    if (Math.min(...sizes) !== 1) shapesWrong++;
    // A ladder that jumps is not a ladder.
    for (let i = 1; i < sizes.length; i++) if (Math.abs(sizes[i] - sizes[i - 1]) !== 1) shapesWrong++;
  }
}
eq(shapesWrong, 0, 'every shape at every size reaches the top, reaches one, and moves a card a round');

// The degenerate table: one card is the whole match, and all three shapes agree.
same(roundSizes('descending', 1), [1], 'a one-card ladder is one round');
same(roundSizes('downup', 1), [1], 'even down and back up');
same(roundSizes('ascending', 1), [1], 'and ascending');

throws(() => roundSizes('spiral', 5), 'an unrecognised shape throws');
throws(() => roundSizes('constructor', 5), 'and so does an inherited object key');

// ===========================================================================
section('The hand-size cap, where the deck runs out');
// ===========================================================================

eq(MAX_HAND_CEILING, 17, 'three players is the widest table, so seventeen is the largest legal hand');

const ROT = normalizeConfig({ trumpMethod: 'rotation' });
const FLIP = normalizeConfig({ trumpMethod: 'turnup' });

eq(effectiveMaxHand(ROT, 5), 10, 'five players get the house default of ten');
eq(effectiveMaxHand(ROT, 6), 8, 'six get eight');
eq(effectiveMaxHand(ROT, 7), 7, 'seven get seven — forty-nine of the fifty-two cards on the table');
eq(effectiveMaxHand(FLIP, 7), 7, 'and seven still fits under the turn-up, at fifty of fifty-one');

eq(effectiveMaxHand(normalizeConfig({ trumpMethod: 'rotation', maxHand: 13 }), 4), 13,
  'four players may ask for thirteen, which is the whole deck exactly');
eq(effectiveMaxHand(normalizeConfig({ trumpMethod: 'turnup', maxHand: 13 }), 4), 12,
  'but the turn-up spends a card, so the same ask is capped at twelve');
eq(effectiveMaxHand(normalizeConfig({ maxHand: 99 }), 3), 17, 'an absurd ask lands on the ceiling');
eq(effectiveMaxHand(normalizeConfig({ maxHand: 1 }), 7), 1, 'and a single-card match is allowed');

// ===========================================================================
section('Every shape, every cap, every table — and the deck holds');
// ===========================================================================

// The definition-of-done requirement, stated as the sweep it is: no config the
// lobby can produce may ask deal() for more cards than exist. Three axes and a
// hand size against every legal seat count, dealing every round for real
// rather than reasoning about it.
let plans = 0, roundsDealt = 0, overDeck = 0, badSize = 0, overCap = 0;
for (const trumpMethod of TRUMP_METHODS) {
  for (const shape of ROUND_SHAPES) {
    for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
      const asks = [null];
      for (let m = 1; m <= MAX_HAND_CEILING; m++) asks.push(m);
      for (const maxHand of asks) {
        const cfg = normalizeConfig({ trumpMethod, shape, maxHand });
        const sizes = roundPlan(cfg, players);
        const turnUp = needsTurnUp(trumpMethod);
        const cap = maxHandSize(players, turnUp);
        plans++;
        if (!sizes.length) badSize++;
        for (const handSize of sizes) {
          if (handSize < 1) badSize++;
          if (handSize > cap) overCap++;
          const spent = players * handSize + (turnUp ? 1 : 0);
          if (spent > DECK_SIZE) overDeck++;
          // Dealt for real, not reasoned about — deal() throws if it is short.
          const round = deal(buildDeck(), { players, handSize, dealerSeat: players - 1, turnUp });
          roundsDealt++;
          if (round.hands.flat().length + (turnUp ? 1 : 0) + round.stock.length !== DECK_SIZE) badSize++;
        }
      }
    }
  }
}
ok(plans > 250, `every shape x cap x table is planned: ${plans} configs`);
ok(roundsDealt > 5000, `and every round of every one of them is dealt: ${roundsDealt} roundsDealt`);
eq(overCap, 0, 'no round the lobby can produce exceeds what the deck allows');
eq(overDeck, 0, 'no deal asks for more than fifty-two cards, or fifty-one plus a turn-up');
eq(badSize, 0, 'and every round accounts for all fifty-two cards');

// ===========================================================================
section('The hook: the dealer may not level the table');
// ===========================================================================

eq(forbiddenBid([2, 2], 5), 1, 'two and two of five leaves one forbidden');
eq(forbiddenBid([0, 0, 0], 5), 5, 'a silent table forbids the dealer the lot');
eq(forbiddenBid([5], 5), 0, 'and a table that has claimed everything forbids zero');
eq(forbiddenBid([], 0), 0, 'a zero-trick round would forbid zero, if such a round existed');
eq(forbiddenBid([4, 4], 5), null, 'once the table has over-bid past reach, nothing is forbidden');
eq(forbiddenBid([9], 5), null, 'however far past');

const AS_DEALER = { isDealer: true, hook: true };
const OTHER = { isDealer: false, hook: true };
const NO_HOOK = { isDealer: true, hook: false };

same(legalBids(3, [1, 1], AS_DEALER), [0, 2, 3], 'the dealer loses exactly the one number');
same(legalBids(3, [1, 1], OTHER), [0, 1, 2, 3], 'everybody else bids freely');
same(legalBids(3, [1, 1], NO_HOOK), [0, 1, 2, 3], 'and so does the dealer with the hook switched off');

eq(bidIsLegal(1, 3, [1, 1], AS_DEALER), false, 'the forbidden bid is refused');
eq(bidIsLegal(1, 3, [1, 1], NO_HOOK), true, 'and allowed when the hook is off');
eq(bidIsLegal(4, 3, [], OTHER), false, 'you cannot bid more tricks than the round holds');
eq(bidIsLegal(-1, 3, [], OTHER), false, 'nor fewer than none');

eq(illegalBidReason(0, 3, [1, 1], AS_DEALER), null, 'a legal bid has no reason attached');
eq(illegalBidReason(1, 3, [1, 1], AS_DEALER), 'would make the bids add up to 3, and someone must be wrong',
  'and the forbidden one says why, out loud, rather than just refusing the tap');
eq(illegalBidReason(9, 3, [], OTHER), 'there are only 3 tricks in this round', 'out of range says so');
eq(illegalBidReason(1.5, 3, [], OTHER), 'there are only 3 tricks in this round', 'and so does a fraction');

// Defaulting either flag would be wrong half the time and silent both times —
// the same reasoning that makes stepSeat() demand its direction.
throws(() => legalBids(3, [], {}), 'legalBids refuses a missing isDealer and hook');
throws(() => legalBids(3, [], { isDealer: true }), 'and a missing hook on its own');
throws(() => legalBids(3, [], { hook: true }), 'and a missing isDealer on its own');
throws(() => legalBids(3, []), 'and no options at all');

// There is always something to bid: one number is removed from a list of at
// least two, so the hook can never leave the dealer stuck.
let stuck = 0, hookBit = 0;
for (let roundSize = 1; roundSize <= MAX_HAND_CEILING; roundSize++) {
  for (let others = 0; others <= MAX_PLAYERS * MAX_HAND_CEILING; others++) {
    const bids = legalBids(roundSize, [others], AS_DEALER);
    if (!bids.length) stuck++;
    if (bids.length === roundSize) hookBit++;
  }
}
eq(stuck, 0, 'the hook never leaves the dealer with nothing to bid');
ok(hookBit > 0, 'and it does bite, whenever the forbidden number is in reach');

// The rule itself, end to end: with the hook on, no legal set of bids can add
// up to the tricks available. With it off, plenty can.
let levelled = 0, levelPossible = 0;
for (let roundSize = 1; roundSize <= 5; roundSize++) {
  for (let a = 0; a <= roundSize; a++) {
    for (let b = 0; b <= roundSize; b++) {
      for (const bid of legalBids(roundSize, [a, b], AS_DEALER)) {
        if (a + b + bid === roundSize) levelled++;
      }
      for (const bid of legalBids(roundSize, [a, b], NO_HOOK)) {
        if (a + b + bid === roundSize) levelPossible++;
      }
    }
  }
}
eq(levelled, 0, 'with the hook on, the bids can never add up to the tricks — somebody must go wrong');
ok(levelPossible > 0, 'with it off, a table that all makes its bid is perfectly possible');

// ===========================================================================
section('normalizeConfig: the allow-list');
// ===========================================================================

same(normalizeConfig({}), DEFAULT_CONFIG, 'an empty config is the default config');
same(normalizeConfig(null), DEFAULT_CONFIG, 'and so is nothing at all');
same(normalizeConfig('kachuful'), DEFAULT_CONFIG, 'and so is a string where an object belongs');
ok(Object.isFrozen(normalizeConfig({})), 'the result is frozen — nothing downstream edits a live config');

eq(normalizeConfig({ scoring: 'square' }).scoring, 'square', 'a recognised mode passes through');
eq(normalizeConfig({ scoring: 'poker' }).scoring, DEFAULT_CONFIG.scoring,
  'an unrecognised one falls back rather than throwing, so an older host still gets a game');
eq(normalizeConfig({ scoring: 'toString' }).scoring, DEFAULT_CONFIG.scoring, 'as does an inherited key');
eq(normalizeConfig({ trumpMethod: 'rotation-nt' }).trumpMethod, 'rotation-nt', 'trump methods likewise');
eq(normalizeConfig({ shape: 'ascending' }).shape, 'ascending', 'and shapes');

// Default ON means noise leaves it on. Only an explicit false turns it off.
eq(normalizeConfig({}).hook, true, 'the hook defaults on');
eq(normalizeConfig({ hook: false }).hook, false, 'an explicit false turns it off');
eq(normalizeConfig({ hook: 'no' }).hook, true, 'but a string does not — noise never deletes a rule');
eq(normalizeConfig({ hook: 0 }).hook, true, 'nor does a zero');
eq(normalizeConfig({ hook: true }).hook, true, 'and true is true');

eq(normalizeConfig({ maxHand: null }).maxHand, null, 'no hand size means "whatever suits the table"');
eq(normalizeConfig({ maxHand: 7 }).maxHand, 7, 'a number is taken as asked');
eq(normalizeConfig({ maxHand: '7' }).maxHand, 7, 'even as a string, which is what a range input gives you');
eq(normalizeConfig({ maxHand: 7.9 }).maxHand, 7, 'fractions floor');
eq(normalizeConfig({ maxHand: 500 }).maxHand, MAX_HAND_CEILING, 'an absurd ask clamps to the ceiling');
eq(normalizeConfig({ maxHand: -3 }).maxHand, 1, 'and a negative one to a single card');
eq(normalizeConfig({ maxHand: Infinity }).maxHand, MAX_HAND_CEILING,
  'an infinite ask means what an absurd one means, and lands in the same place');
eq(normalizeConfig({ maxHand: -Infinity }).maxHand, 1, 'and an infinitely small one, likewise');
eq(normalizeConfig({ maxHand: 'lots' }).maxHand, null,
  'a value that is not a number at all falls back to the table default');
eq(normalizeConfig({ maxHand: NaN }).maxHand, null, 'including the one that pretends to be one');

// Every axis of a hostile config lands somewhere playable, which is the whole
// job: js/guards.js runs this on inbound configs and must get a game back.
const HOSTILE = normalizeConfig({
  scoring: { toString: () => 'square' }, trumpMethod: ['rotation'], shape: 42,
  hook: { valueOf: () => false }, maxHand: {}, players: 99, extra: 'ignored',
});
same(HOSTILE, DEFAULT_CONFIG, 'a config built to break things is just the default config');
eq(HOSTILE.players, undefined, 'and unknown fields do not survive the trip');

let unplayable = 0;
for (const cfg of [HOSTILE, normalizeConfig({}), normalizeConfig({ shape: 'nope', trumpMethod: 'nope' })]) {
  for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
    if (!roundPlan(cfg, players).length) unplayable++;
    try { trumpForRound(cfg.trumpMethod, 0); scoreRound(cfg.scoring, 0, 0, 1); } catch (_) { unplayable++; }
  }
}
eq(unplayable, 0, 'and every normalized config is playable at every table size');

// ===========================================================================
section('What the lobby promises before you commit');
// ===========================================================================

const FIVE_DOWNUP = matchShape(normalizeConfig({ shape: 'downup' }), 5);
eq(FIVE_DOWNUP.rounds, 19, 'five players down and back up is nineteen rounds — the number the brief warns about');
eq(FIVE_DOWNUP.tricks, 109, 'and a hundred and nine tricks');
eq(FIVE_DOWNUP.maxHand, 10, 'topping out at ten cards');
ok(FIVE_DOWNUP.minutes >= 20, 'which is not a quarter of an hour, and the lobby has to say so');

const FIVE_DOWN = matchShape(normalizeConfig({ shape: 'descending' }), 5);
eq(FIVE_DOWN.rounds, 10, 'the same table descending is ten rounds');
ok(FIVE_DOWNUP.minutes > FIVE_DOWN.minutes, 'and down-and-back-up is visibly the longer game');

let estimateWrong = 0;
for (const shape of ROUND_SHAPES) {
  for (let players = MIN_PLAYERS; players <= MAX_PLAYERS; players++) {
    const s = matchShape(normalizeConfig({ shape }), players);
    if (!Number.isInteger(s.minutes) || s.minutes < 5) estimateWrong++;
    if (s.minutes % 5 !== 0) estimateWrong++;   // no false precision
    if (s.rounds < 1 || s.tricks < 1) estimateWrong++;
  }
}
eq(estimateWrong, 0, 'every estimate is a whole number of five minutes, and never claims less than five');

// ===========================================================================
section('Presets: three points in the space, not three games');
// ===========================================================================

eq(PRESETS.length, 3, 'three presets');
same(PRESETS.map((p) => p.id), ['kachuful', 'classic', 'cutthroat'], 'in the order the lobby offers them');

const BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p.config]));
same(BY_ID.kachuful, { scoring: 'kachuful', trumpMethod: 'rotation', shape: 'downup', hook: true, maxHand: null },
  'Kachuful: its own scoring, the KaChuFuL rotation, the hook, down and back up');
same(BY_ID.classic, { scoring: 'standard', trumpMethod: 'turnup', shape: 'descending', hook: true, maxHand: null },
  'Classic Oh Hell: standard scoring, a turned card, the hook, one descent');
same(BY_ID.cutthroat, { scoring: 'square', trumpMethod: 'rotation-nt', shape: 'downup', hook: true, maxHand: null },
  'Cutthroat: square scoring, the No Trump rotation, the hook, down and back up');

// Three points, and between them they touch every value on every axis — which
// is what makes them a tour of the game rather than three variations on one.
for (const mode of SCORING_MODES) ok(PRESETS.some((p) => p.config.scoring === mode), `a preset uses ${mode} scoring`);
for (const m of TRUMP_METHODS) ok(PRESETS.some((p) => p.config.trumpMethod === m), `a preset uses the ${m} trump`);

let presetDrift = 0;
for (const p of PRESETS) {
  if (presetMatching(p.config) !== p.id) presetDrift++;
  if (presetMatching(presetConfig(p.id)) !== p.id) presetDrift++;
  // A preset must survive the allow-list untouched — a preset naming a value
  // normalizeConfig would reject is a lobby button that silently does nothing.
  if (presetMatching(normalizeConfig(p.config)) !== p.id) presetDrift++;
}
eq(presetDrift, 0, 'every preset recognises itself, through the allow-list and back');

eq(presetMatching({ ...BY_ID.kachuful, hook: false }), null,
  'twiddle one toggle and you are on a custom game, which is what the lobby has to show');
eq(presetMatching({ ...BY_ID.kachuful, maxHand: 7 }), null, 'including the hand size');
eq(presetMatching(DEFAULT_CONFIG), 'kachuful', 'the default game is the Kachuful preset');
same(presetConfig('nonsense'), DEFAULT_CONFIG, 'and an unknown preset id falls back to it');

// ===========================================================================
section('Labels: one name per axis value, in one place');
// ===========================================================================

let unlabelled = 0;
for (const [labels, values] of [[SCORING_LABELS, SCORING_MODES], [TRUMP_METHOD_LABELS, TRUMP_METHODS], [SHAPE_LABELS, ROUND_SHAPES]]) {
  for (const v of values) {
    const hit = labels[v];
    if (!hit || !hit.label || !hit.blurb) unlabelled++;
    if (axisLabel(labels, v) !== hit.label) unlabelled++;
  }
}
eq(unlabelled, 0, 'every value on every axis has a name and a sentence explaining it');
eq(axisLabel(SHAPE_LABELS, 'downup'), 'Down and back up', 'the shape the host most needs warning about');
eq(axisLabel(SCORING_LABELS, 'sideways'), 'sideways', 'an unknown value renders as itself, not as blank space');
eq(axisLabel(SCORING_LABELS, 'toString'), 'toString', 'and an inherited key is not a label');

// ###########################################################################
//
//  4. THE ENGINE
//
//  Everything above is a pure function over its arguments. Everything below
//  is one mutable object that holds a whole match, and the failures it can
//  produce are a different kind: not a wrong number, but a card in the wrong
//  person's hands, a seat renumbered under a running score, or a secret in a
//  message that goes to everybody.
//
//  So the engine is tested by PLAYING MATCHES and asserting invariants at
//  every single state, rather than by stepping through a scripted game and
//  checking it against expected values. A scripted game proves one path
//  works. A conservation law checked at four thousand consecutive states
//  proves no path breaks it.
//
// ###########################################################################

// ---------------------------------------------------------------------------
// A match driver.
//
// Plays a whole match to MATCH_OVER, calling onState after every single
// engine call — mid-deal, mid-bid, mid-trick, with a finished trick still on
// the table. That hook is where the invariants live, and calling it that
// often is the point: the privacy leak this file most needs to catch would
// last for exactly one state send.
// ---------------------------------------------------------------------------

const ALL_CODES = buildDeck();

// A second, separate PRNG from the one driving the shuffle. Choosing bids and
// cards out of the same stream as the deal would correlate the two, and a
// strategy that happened to track the shuffle would be a strategy that never
// stresses the follow-suit path.
let pickState = 1;
function pickSeed(n) { pickState = n >>> 0 || 1; }
function rnd(n) {
  pickState = (Math.imul(pickState, 1103515245) + 12345) & 0x7FFFFFFF;
  return n <= 0 ? 0 : pickState % n;
}

// Three ways to play, because they stress different parts of the engine.
//   greedy  bids high and plays high — makes a lot of bids, few misses
//   timid   bids zero wherever legal then plays its highest card, which is a
//           machine for missing a zero bid. Under square that is the fastest
//           way to a deeply negative running total, which is the case the
//           brief says not to discover at the end.
//   random  the only one that reliably lands on the void-and-discard paths
const STRATEGIES = {
  greedy: {
    bid: (opts) => opts[opts.length - 1].bid,
    card: (legal) => legal[0].code,
  },
  timid: {
    bid: (opts) => opts[0].bid,
    card: (legal) => legal[0].code,
  },
  random: {
    bid: (opts) => opts[rnd(opts.length)].bid,
    card: (legal) => legal[rnd(legal.length)].code,
  },
};

function seatTable(g, names) {
  names.forEach((n, i) => g.addPlayer(`p${i}`, n, { clientId: `c${i}` }));
  return g;
}

// Thrown by playMatchUntil to abandon a match part-way. Declared up here
// beside the driver rather than beside its use, because `const` does not
// hoist and a Symbol referenced from a function defined above it is a
// temporal-dead-zone error that only fires when the test runs.
const STOP = Symbol('stop');

/** Drive a match only as far as a predicate, so a test can get hold of an
 *  engine in a specific mid-round state without scripting the whole game. */
function playMatchUntil(opts, predicate) {
  let found = null;
  try {
    playMatch({ ...opts, onState: (g) => { if (!found && predicate(g)) { found = g; throw STOP; } } });
  } catch (e) { if (e !== STOP) throw e; }
  if (!found) throw new Error('playMatchUntil: the predicate never held');
  return found;
}

// THREE CONFIGS THAT DISAGREE ON EVERY AXIS, so a sweep over them covers each
// scoring mode, each trump method and each round shape exactly once, with the
// hook both ways. Small hand sizes on purpose: the point is to reach round
// twelve and a long history quickly, not to play realistic hands.
//
// Declared up here rather than beside the UI sweeps that were its first
// caller, because the engine sections below now use it too and a const above
// its declaration is a TDZ crash.
const UI_CONFIGS = [
  { scoring: 'kachuful', trumpMethod: 'rotation', shape: 'descending', hook: true, maxHand: 4 },
  { scoring: 'square', trumpMethod: 'turnup', shape: 'downup', hook: false, maxHand: 3 },
  { scoring: 'standard', trumpMethod: 'rotation-nt', shape: 'ascending', hook: true, maxHand: 3 },
];

// ---------------------------------------------------------------------------
// TWO WAYS OF LOOKING AT AN OBJECT GRAPH, shared by the two sections that ask
// about the engine's boundaries: what can be reached from here, and what
// happens if you write to it. Up here rather than in the first section that
// needed them, because the second one needs the same pair and two copies of
// a probe drift apart exactly when one of them is quietly wrong.
// ---------------------------------------------------------------------------

/** Everything reachable from a value, following arrays and plain objects.
 *  Structural rather than a list of field names for the usual reason: a field
 *  added later is a field a hand-written list does not have, and the bugs
 *  these sections close ARE fields that were added and not covered. */
function reachable(v, out = [], seen = new Set()) {
  if (!v || typeof v !== 'object' || seen.has(v)) return out;
  seen.add(v);
  out.push(v);
  for (const child of Array.isArray(v) ? v : Object.values(v)) reachable(child, out, seen);
  return out;
}

/**
 * Does writing to this actually fail? Object.isFrozen is the claim; this is
 * the behaviour. They can disagree — a frozen object still accepts a write
 * silently in sloppy mode — and the behaviour is what a consumer meets. This
 * file is an ES module and therefore strict, which is the only reason the
 * throw can be relied on; there is an assertion pinning that too.
 *
 * IT MUST LEAVE NO TRACE, and on arrays that takes more than putting the old
 * value back. Writing index 0 of an EMPTY array moves `length` to 1, and
 * `delete` does not move it back — so the probe would hand the next sweep a
 * one-element array holding a hole, and the crash lands in the probe rather
 * than at the assertion, with no name on it. That is not hypothetical: it is
 * what this helper did the first time an engine array was both reachable and
 * writable, which is precisely the case it exists to report. A measurement
 * that damages what it measures reports the damage instead of the finding.
 */
function rejectsWrites(o) {
  const key = Array.isArray(o) ? 0 : '__probe__';
  const len = Array.isArray(o) ? o.length : -1;
  const had = Object.prototype.hasOwnProperty.call(o, key);
  const was = o[key];
  try {
    o[key] = '__mutated__';
    if (o[key] === '__mutated__') {
      if (had) o[key] = was; else delete o[key];
      if (len >= 0) o.length = len;
      return false;
    }
    return true;
  } catch (_) { return true; }
}

function playMatch({
  config = {}, players = 4, strategy = 'random', shuffleSeed = 1, pickerSeed = 1,
  onState = null, names = null,
} = {}) {
  seed(shuffleSeed);
  pickSeed(pickerSeed);
  const g = new GameEngine();
  // Names chosen so no name is ever a two-character card code — the privacy
  // scan looks for codes in a JSON blob and a player called "AS" would read
  // as the ace of spades sitting in the public state.
  const roster = names || ['Ana', 'Ben', 'Cleo', 'Dev', 'Esha', 'Finn', 'Gita'].slice(0, players);
  seatTable(g, roster);
  g.setConfig('p0', config);

  const started = g.startMatch('p0', 0);
  if (!started.ok) throw new Error(`startMatch refused: ${started.error}`);

  // A named strategy, or an object of the same shape passed in by a test that
  // needs to steer the game somewhere the three standard ones never go.
  const strat = typeof strategy === 'string' ? STRATEGIES[strategy] : strategy;
  let t = 0, guard = 0;
  if (onState) onState(g);

  while (g.phase !== PHASES.MATCH_OVER) {
    if (guard++ > 60000) throw new Error('match did not finish — the engine is stuck');
    // Always past every pause, so the driver never has to know how long any
    // of them are. The pauses are tested separately, on purpose, below.
    t += TRICK_PAUSE_MS + 1;

    if (g.phase === PHASES.BIDDING) {
      const seat = g.turnSeat;
      const opts = g.bidOptionsFor(seat).filter((o) => o.legal);
      const res = g.placeBid(g.seats[seat].id, strat.bid(opts, g, seat), t);
      if (!res.ok) throw new Error(`bid refused: ${res.error}`);
    } else if (g.phase === PHASES.PLAY && g.sweepAt === null) {
      const seat = g.turnSeat;
      const priv = g.privateStateFor(g.seats[seat].id);
      const legal = priv.hand.filter((c) => c.legal);
      const res = g.playCard(g.seats[seat].id, strat.card(legal, g, seat), t);
      if (!res.ok) throw new Error(`play refused: ${res.error}`);
    } else if (g.phase === PHASES.ROUND_OVER) {
      const res = g.nextRound('p0', t);
      if (!res.ok) throw new Error(`nextRound refused: ${res.error}`);
    } else {
      g.tick(t);
    }
    if (onState) onState(g);
  }
  return g;
}

// ===========================================================================
section('The engine: the phase ladder');
// ===========================================================================

{
  const g = new GameEngine();
  eq(g.phase, PHASES.LOBBY, 'a fresh engine is in the lobby');
  eq(g.startBlocker(), `needs ${MIN_PLAYERS} players, has 0`, 'and says why it cannot start');
  eq(g.startMatch('nobody', 0).ok, false, 'a stranger cannot start it');

  seatTable(g, ['Ana', 'Ben']);
  eq(g.startBlocker(), `needs ${MIN_PLAYERS} players, has 2`, 'two is not enough');
  eq(g.startMatch('p0', 0).ok, false, 'and the owner cannot start it either');
  g.addPlayer('p2', 'Cleo', { clientId: 'c2' });
  eq(g.startBlocker(), null, 'three is a game');
  eq(g.startMatch('p1', 0).ok, false, 'a non-owner still cannot start it');
  eq(g.phase, PHASES.LOBBY, 'and the refusal left the phase alone');
  ok(g.startMatch('p0', 0).ok, 'the owner can');
  eq(g.phase, PHASES.ROUND_DEAL, 'which deals the first round');
  eq(g.startMatch('p0', 0).ok, false, 'starting twice is refused');
}

// Every phase the engine passed through, in order, for each trump method.
// TRUMP_REVEAL is the one that must appear if and only if the host chose the
// turn-up — the phase diagram in the brief marks it with an asterisk and this
// is that asterisk, asserted.
for (const trumpMethod of TRUMP_METHODS) {
  const seen = [];
  playMatch({
    config: { trumpMethod, shape: 'descending', maxHand: 2 },
    players: 4,
    onState: (g) => { if (seen[seen.length - 1] !== g.phase) seen.push(g.phase); },
  });
  const order = [...new Set(seen)];
  ok(seen[0] === PHASES.ROUND_DEAL, `${trumpMethod}: the first phase after the lobby is the deal`);
  eq(seen[seen.length - 1], PHASES.MATCH_OVER, `${trumpMethod}: the match ends in MATCH_OVER`);
  eq(order.includes(PHASES.TRUMP_REVEAL), trumpMethod === 'turnup',
    `${trumpMethod}: there is a reveal phase if and only if a card is turned up`);
  eq(order.includes(PHASES.LOBBY), false, `${trumpMethod}: and the match never returns to the lobby`);

  // Every deal is followed by bidding, either directly or through the reveal,
  // and bidding is always followed by play. Stated as adjacency over the whole
  // run rather than checked once, so a round that skipped bidding in round
  // eleven could not hide behind ten rounds that did not.
  let badEdge = 0;
  const ALLOWED = {
    [PHASES.ROUND_DEAL]: [PHASES.TRUMP_REVEAL, PHASES.BIDDING],
    [PHASES.TRUMP_REVEAL]: [PHASES.BIDDING],
    [PHASES.BIDDING]: [PHASES.PLAY],
    [PHASES.PLAY]: [PHASES.ROUND_OVER],
    [PHASES.ROUND_OVER]: [PHASES.ROUND_DEAL, PHASES.MATCH_OVER],
  };
  for (let i = 1; i < seen.length; i++) {
    if (!ALLOWED[seen[i - 1]] || !ALLOWED[seen[i - 1]].includes(seen[i])) badEdge++;
  }
  eq(badEdge, 0, `${trumpMethod}: every phase transition is one the diagram allows`);
}

// ===========================================================================
section('The engine: the privacy boundary');
// ===========================================================================

// The card codes that appear anywhere in a JSON blob, found structurally
// rather than by guessing at keys — a leak through a field nobody thought to
// check is the only kind of leak that matters, and naming the fields to
// inspect would be checking the fields I already know about.
function codesIn(obj) {
  const json = JSON.stringify(obj);
  return ALL_CODES.filter((code) => json.includes(`"${code}"`));
}

// What is legitimately visible to everybody right now: the cards on the
// table, the cards of the trick still being looked at, every card already
// played this round, and the turn-up once it has been turned up. Nothing
// else, ever.
//
// THE THIRD ENTRY IS A DELIBERATE WIDENING, added for the bot in checkpoint 6
// and worth stating plainly rather than letting it slip in. publicState now
// carries `tricks`, the completed tricks of the current round. That is not a
// leak — every one of those cards was played face up in front of the whole
// table, and a player who was paying attention already knows them. It is the
// difference between what is SECRET and what is merely hard to remember, and
// only the first of those is this file's business.
//
// It buys two things. The bot cannot duck correctly without it: "is my king
// still a winner" depends on whether the ace has gone, and before this the
// public state said only what happened in the single most recent trick. And a
// player whose battery died mid-round gets the round back on reconnect, not
// just the trick in progress.
//
// What it does NOT include is the stock, or anybody's hand, and the two
// assertions below still prove that from both directions.
function publiclyVisible(g) {
  const seen = new Set();
  for (const p of g.plays) seen.add(p.code);
  for (const t of g.tricks) for (const p of t.plays) seen.add(p.code);
  if (g.lastTrick) for (const p of g.lastTrick.plays) seen.add(p.code);
  if (g.turnUpShown && g.turnUpCard) seen.add(g.turnUpCard);
  return seen;
}

for (const trumpMethod of TRUMP_METHODS) {
  let leaks = 0, handLeaks = 0, crossLeaks = 0, states = 0;
  let sawHiddenTurnUp = 0, structural = 0;

  playMatch({
    config: { trumpMethod, shape: 'downup', maxHand: 4 },
    players: 5,
    strategy: 'random',
    shuffleSeed: 7,
    onState: (g) => {
      states++;
      const pub = g.publicState();

      // The blunt structural check first: the two forbidden keys.
      if ('hands' in pub || 'stock' in pub) structural++;

      const allowed = publiclyVisible(g);
      for (const code of codesIn(pub)) if (!allowed.has(code)) leaks++;

      // The same rule from the other end. Above asks "is everything public
      // allowed"; this asks "is anything held also public". They catch the
      // same bug, and a change that defeats one rarely defeats both.
      for (const hand of g.hands) {
        for (const code of hand) if (codesIn(pub).includes(code)) handLeaks++;
      }
      // The stock is the rest of the deck. At three players under the turn-up
      // method that is most of it, and it is not on the table.
      for (const code of g.stock) if (codesIn(pub).includes(code)) handLeaks++;

      // A turn-up that has been dealt but not yet revealed. Counted so the
      // assertion below can prove this window actually occurred, rather than
      // passing because it never did.
      if (g.turnUpCard && !g.turnUpShown) {
        sawHiddenTurnUp++;
        if (pub.turnUpCard !== null) leaks++;
        if (pub.trump !== null) leaks++;
      }

      // And the private view: your own hand plus what everyone can see, and
      // not one card of anybody else's.
      for (let seat = 0; seat < g.seats.length; seat++) {
        const priv = g.privateStateFor(g.seats[seat].id);
        const mine = new Set(g.hands[seat] || []);
        for (const code of codesIn(priv)) {
          if (!mine.has(code) && !allowed.has(code)) crossLeaks++;
        }
      }
    },
  });

  ok(states > 150, `${trumpMethod}: the sweep covered ${states} states`);
  eq(structural, 0, `${trumpMethod}: publicState never carries a hands or stock key`);
  eq(leaks, 0, `${trumpMethod}: no card reaches publicState before it is on the table`);
  eq(handLeaks, 0, `${trumpMethod}: and nothing in a hand or the stock is ever in it`);
  eq(crossLeaks, 0, `${trumpMethod}: a private view shows your hand and the table, never another hand`);
  eq(sawHiddenTurnUp > 0, trumpMethod === 'turnup',
    `${trumpMethod}: the dealt-but-unrevealed window ${trumpMethod === 'turnup' ? 'happens and was tested' : 'never happens'}`);
}

// The distinction the sibling repo gets wrong, now at the engine layer. Under
// the turn-up there is a real window where trump is null meaning NOT YET
// TURNED; under the No Trump rotation the public trump is the NO_TRUMP
// sentinel and is never null, because "nothing trumps" is a decided state.
{
  let ntNulls = 0, ntSentinels = 0;
  playMatch({
    config: { trumpMethod: 'rotation-nt', shape: 'descending', maxHand: 5 },
    players: 5,
    onState: (g) => {
      if (g.roundIndex < 0) return;
      const pub = g.publicState();
      if (pub.trump === null) ntNulls++;
      if (pub.trump === NO_TRUMP) ntSentinels++;
    },
  });
  eq(ntNulls, 0, 'under the No Trump rotation the trump is never "not yet turned"');
  ok(ntSentinels > 0, 'and the No Trump rounds report the sentinel, which is a different thing');
}

// ===========================================================================
section('The engine: the public view cannot move the engine');
// ===========================================================================

// THE OTHER HALF OF THE PRIVACY BOUNDARY. The section above proves nothing
// secret gets OUT through publicState(). This proves nothing gets back IN —
// that a consumer holding a public state cannot reach through it and change
// the engine that produced it.
//
// It is the same boundary and it fails in the opposite direction, which is
// why it was missed: every assertion above reads the view and none of them
// writes to it. `pub.history[0].totals.sort()` — one line, in a scoreboard,
// the single most obvious thing anybody would write — reordered the engine's
// own frozen record of a finished round, and `pub.log.at(-1).text = x`
// rewrote a line in the engine's narration. Both of those were reachable and
// neither was caught, because the arrays hanging off a frozen record are not
// themselves frozen and Object.freeze does not say so.
//
// This matters on the HOST and essentially nowhere else, which is the reason
// it is easy to talk yourself out of. A client's public state has been
// through JSON and is a deep copy by construction, so a client that mutates
// it is only ever wrong about itself. The host runs js/ui.js and js/bot.js
// directly against the object the engine handed back — so the one peer where
// this is reachable is the one holding the authoritative game.
//
// Written as a sweep over every state of several whole matches rather than a
// fixture, because the interesting records are the ones built in round twelve
// under a config nobody used when writing this.
{
  // reachable() and rejectsWrites() are declared beside playMatchUntil — the
  // section below this one asks the same two questions of restore().

  let states = 0, liveRecords = 0, liveArrays = 0, liveLines = 0;
  let recordsSeen = 0, arraysSeen = 0, linesSeen = 0;
  let sharedRecords = 0, sharedLines = 0, writableReached = 0;

  for (const cfg of UI_CONFIGS) {
    playMatch({
      config: cfg, players: 5, strategy: 'random', shuffleSeed: 23,
      onState: (g) => {
        states++;
        const pub = g.publicState();

        for (const rec of pub.history) {
          recordsSeen++;
          if (!rejectsWrites(rec)) liveRecords++;
          // The point of the whole item: the arrays INSIDE the frozen record.
          for (const v of Object.values(rec)) {
            if (!Array.isArray(v)) continue;
            arraysSeen++;
            if (!rejectsWrites(v)) liveArrays++;
          }
        }
        for (const line of pub.log) {
          linesSeen++;
          if (!rejectsWrites(line)) liveLines++;
        }

        // Shared by reference, and that is the DESIGN rather than an
        // oversight — freezing is what makes sharing safe, and asserting the
        // sharing keeps the next reader from "fixing" it into a deep copy and
        // paying for it 900 times a match. If these ever stop matching,
        // somebody changed the strategy and should say so here.
        if (pub.history.length && pub.history[0] === g.history[0]) sharedRecords++;
        if (pub.log.length && pub.log[0] === g.log[g.log.length - pub.log.length]) sharedLines++;

        // The sweeping version of the two loops above: ANYTHING writable that
        // is also reachable from the engine. Copied nodes are exempt — a
        // consumer sorting pub.seats is sorting its own array — so this asks
        // only about nodes the engine can still see.
        const mine = new Set(reachable(g.history).concat(reachable(g.log)));
        for (const node of reachable(pub)) {
          if (mine.has(node) && !rejectsWrites(node)) writableReached++;
        }
      },
    });
  }

  ok(states > 150, `the sweep covered ${states} states across ${UI_CONFIGS.length} configs`);
  ok(recordsSeen > 100, `and reached ${recordsSeen} history records`);
  ok(arraysSeen > 400, `and ${arraysSeen} arrays hanging off them`);
  ok(linesSeen > 1000, `and ${linesSeen} log lines`);

  eq(liveRecords, 0, 'no history record in the public state accepts a write');
  eq(liveArrays, 0,
    'and neither does any array inside one — the freeze goes all the way down, not just to the record');
  eq(liveLines, 0, 'no log line in the public state accepts a write');
  eq(writableReached, 0,
    'nothing the engine can still see is writable through the public state, by any path');

  ok(sharedRecords > 100, 'the records really are shared, not copied — the freeze is what makes that safe');
  ok(sharedLines > 100, 'and so are the log lines');

  // The arrays THEMSELVES are still copies, and must be: a frozen record does
  // not stop `pub.log.push(...)` reaching the engine's log, only the slice
  // does. Freezing the entries and slicing the array are two mechanisms and
  // this is the one the freeze does not cover.
  {
    const g = playMatchUntil({ config: UI_CONFIGS[0], players: 4 }, (e) => e.history.length >= 2);
    const pub = g.publicState();
    ok(pub.history !== g.history, 'the history ARRAY is a copy, so a consumer cannot append a round');
    ok(pub.log !== g.log, 'and so is the log array');
    const rounds = g.history.length, lines = g.log.length;
    pub.history.push({ roundIndex: 999 });
    pub.log.push({ text: 'injected', kind: 'system' });
    eq(g.history.length, rounds, 'pushing a fabricated round onto the view does not reach the engine');
    eq(g.log.length, lines, 'nor does pushing a fabricated line');

    // And the sharpest version of the whole item, stated as the line somebody
    // would actually write. sort() mutates in place, so on a frozen array it
    // throws rather than quietly reordering a finished round.
    let threw = false;
    try { pub.history[0].totals.sort((a, b) => b - a); } catch (_) { threw = true; }
    ok(threw, 'sorting a score row through the public view throws instead of reordering the engine');
    let threwLine = false;
    try { pub.log[0].text = 'rewritten'; } catch (_) { threwLine = true; }
    ok(threwLine, 'and rewriting a log line throws instead of editing the engine narration');
  }

  // --- config: a LIVE reference, safe for a reason owned by another file ---
  //
  // pub.config === engine.config, uncopied and unfrozen by state.js. It is
  // safe only because normalizeConfig() freezes it and every value in it is a
  // primitive, so the shallow freeze happens to be a deep one. That is a
  // guarantee js/rules.js provides and js/state.js silently consumes, with a
  // file boundary in between and nothing previously stretched across it —
  // delete the freeze in rules.js and the suite went green while the privacy
  // boundary grew a hole.
  {
    const g = playMatchUntil({ config: UI_CONFIGS[1], players: 4 }, (e) => e.history.length >= 1);
    const pub = g.publicState();
    ok(pub.config === g.config, 'publicState hands out the config by reference, not as a copy');
    ok(Object.isFrozen(pub.config), 'which is only safe because normalizeConfig() froze it');
    const deep = Object.values(pub.config).every((v) => Object(v) !== v);
    ok(deep, 'and because every value in it is a primitive, so there is no second level to freeze');
    ok(rejectsWrites(pub.config), 'so a consumer writing to it fails rather than reconfiguring the match');

    // Derived, not restated: whatever normalizeConfig returns for any input
    // must have both properties, not just the one default config happens to.
    let unfrozen = 0, nested = 0;
    for (const raw of [undefined, null, {}, { hook: false }, { maxHand: 99 },
      { scoring: 'square', trumpMethod: 'turnup', shape: 'downup' },
      { scoring: 'nonsense', maxHand: 'x' }, { extra: [1, 2, 3] }]) {
      const c = normalizeConfig(raw);
      if (!Object.isFrozen(c)) unfrozen++;
      if (!Object.values(c).every((v) => Object(v) !== v)) nested++;
    }
    eq(unfrozen, 0, 'normalizeConfig freezes whatever it is given, not just the default');
    eq(nested, 0, 'and never returns a value with a second level for the freeze to miss');
  }

  // --- and after a reload, which is where a write-site freeze can lapse ----
  //
  // JSON has no idea what a frozen object is. A snapshot round-trips to plain
  // objects and plain arrays, so an engine restored from one would hand out
  // thawed records unless restore() re-freezes — and that is the worse half
  // to lose, because resume is exactly when history is longest.
  {
    const g = playMatchUntil({ config: UI_CONFIGS[2], players: 4 }, (e) => e.history.length >= 3);
    const snap = JSON.parse(JSON.stringify(g.serialize()));
    ok(!Object.isFrozen(snap.history[0]),
      'a snapshot through JSON really is thawed — otherwise this proves nothing');

    const back = new GameEngine();
    const r = back.restore(snap);
    ok(r.ok, 'the snapshot restores');
    ok(back.history.length >= 3, `and brought ${back.history.length} rounds with it`);

    const pub = back.publicState();
    let thawed = 0;
    for (const rec of pub.history) {
      if (!rejectsWrites(rec)) thawed++;
      for (const v of Object.values(rec)) if (Array.isArray(v) && !rejectsWrites(v)) thawed++;
    }
    for (const line of pub.log) if (!rejectsWrites(line)) thawed++;
    eq(thawed, 0, 'a RESTORED engine hands out the same sealed records a fresh one does');

    // Freezing must not have eaten the contents on the way through.
    same(pub.history.map((h) => h.totals.join(',')), g.history.map((h) => h.totals.join(',')),
      'and the scoreboard survived the round trip unchanged');
    same(pub.log.map((l) => l.text), g.publicState().log.map((l) => l.text),
      'and so did the narration');

    // freezeRound COPIES, so history stops aliasing the snapshot. A side
    // effect of freezing rather than the goal — and the reason to pin it is
    // that the other twelve fields restore() assigns are still aliased, which
    // is a separate audit entry. Two of fourteen is not "restore is safe".
    ok(back.history[0] !== snap.history[0],
      'restoring copies the history records rather than adopting the snapshot\'s');
    ok(back.log[0] !== snap.log[0], 'and the log lines too');
  }

  // A frozen write only throws in strict mode, and the whole argument for
  // freezing over copying is that the mistake is LOUD. ES modules are always
  // strict, so this holds for every file in js/ — but it is an assumption the
  // reasoning rests on rather than something obvious, so it gets a line.
  {
    let threw = false;
    try { Object.freeze({ a: 1 }).a = 2; } catch (_) { threw = true; }
    ok(threw, 'this file is strict, so a write to a frozen object throws — which is why freezing is loud');
  }
}

// ===========================================================================
section('The engine: a restored engine owns what it was given');
// ===========================================================================

// THE THIRD DIRECTION THE SAME BOUNDARY FAILS IN. publicState() is the view
// going out and restore() is the state coming in, and the mistake is the
// same one: a function that looks like it copies because it says `arr(...)`
// or `.slice()` somewhere nearby, and does not.
//
// restore() was scrupulous about TYPE — every field arrives through arr() or
// Number() or ?? so that a truncated localStorage write gives a lobby rather
// than a throw — and silent about OWNERSHIP. It adopted the caller's arrays:
// plan, totals, stock, bids, bidOrder, tricksWon, each hand, the plays of
// each finished trick, and the whole lastTrick record. Nine fields, all of
// them mutated in place by the engine all match long.
//
// WHY IT NEVER BIT, which is the only interesting part: the one shipped
// caller is js/main.js, and the snapshot it passes came from JSON.parse and
// is dropped on the next line. Nobody else holds it, so nobody notices the
// engine writing into it. The guarantee was real and it lived in a different
// file, in a line of util.js nobody would think to protect. That is the same
// shape as the config case above, and the answer is the same: assert it here
// so it stops depending on a caller's habits.
//
// Two engines from one snapshot is where it stops being theoretical. They
// share a `totals`, and the second match scores into the first.
{
  // --- (a) a snapshot shares nothing WRITABLE with the engine ---------------
  //
  // Not "shares nothing" — serialize() deliberately passes the frozen history
  // records and log lines straight through, because freezing is what makes
  // sharing safe and copying them again would be 900 copies a match for
  // nothing. So the property is the one #21 settled on: whatever is shared is
  // frozen. lastTrick was the single field that was neither.
  //
  // --- (b) an engine restored from it shares NOTHING with it ---------------
  //
  // Stricter than (a) on purpose. A snapshot is somebody else's object and
  // the engine is about to spend nineteen rounds writing to its own fields,
  // so the right relationship is no relationship: freezeRound copies the
  // records rather than reusing the frozen ones, so even the safe-to-share
  // nodes come out separate.
  let states = 0, shared = 0, sharedWritable = 0, overlap = 0;
  const writableKinds = new Set(), overlapKinds = new Set();

  // Name the offending node in the failure message. A count tells you the
  // boundary leaks; this tells you which field, which is the difference
  // between a diagnosis and a starting point.
  const label = (root, node) => {
    for (const [k, v] of Object.entries(root)) {
      if (v === node) return k;
      if (v && typeof v === 'object' && reachable(v).includes(node)) return `${k}[...]`;
    }
    return '?';
  };

  for (const cfg of UI_CONFIGS) {
    playMatch({
      config: cfg, players: 5, strategy: 'random', shuffleSeed: 37,
      onState: (g) => {
        states++;
        const snap = g.serialize();

        const mine = new Set(reachable(g));
        for (const node of reachable(snap)) {
          if (!mine.has(node)) continue;
          shared++;
          if (!rejectsWrites(node)) { sharedWritable++; writableKinds.add(label(snap, node)); }
        }

        const back = new GameEngine();
        back.restore(snap);
        const theirs = new Set(reachable(snap));
        for (const node of reachable(back)) {
          if (theirs.has(node)) { overlap++; overlapKinds.add(label(back, node)); }
        }
      },
    });
  }

  ok(states > 150, `the sweep covered ${states} states across ${UI_CONFIGS.length} configs`);
  ok(shared > 100, `and ${shared} nodes really are shared between engine and snapshot`);
  eq(sharedWritable, 0,
    `everything a snapshot shares with its engine is frozen — writable: [${[...writableKinds].join(', ')}]`);
  eq(overlap, 0,
    `a restored engine shares no object at all with the snapshot — shared: [${[...overlapKinds].join(', ')}]`);

  // --- (c) and what that is FOR: the snapshot does not drift forward -------
  //
  // The two assertions above are about identity; these two are about what
  // identity costs. Stated as the thing that actually goes wrong, so the
  // failure reads as a bug report rather than as a broken invariant.
  {
    const g = playMatchUntil(
      { config: UI_CONFIGS[0], players: 4, shuffleSeed: 5 },
      (e) => e.phase === PHASES.BIDDING && e.history.length >= 1,
    );
    const snap = g.serialize();
    const before = JSON.stringify(snap);

    const back = new GameEngine();
    back.restore(snap);
    const seat = back.turnSeat;
    // The first bid the restored engine itself says is legal — asking it
    // rather than picking a number, because under the hook the dealer has one
    // forbidden value and a hard-coded 0 would fail for a reason that has
    // nothing to do with what this section is testing.
    const choice = back.bidOptionsFor(seat).find((o) => o.legal);
    const r = back.placeBid(back.seats[seat].id, choice.bid, 1000);
    ok(r.ok, `a bid lands on the restored engine (${r.error || 'ok'})`);
    eq(back.bids[seat], choice.bid, 'and is recorded in its bids');

    eq(JSON.stringify(snap), before,
      'bidding on a restored engine does not write the bid into the snapshot it came from');
    eq(g.bids[seat], null,
      'and the engine the snapshot was taken from is still waiting for that seat to bid');
  }

  {
    // The same thing one level deeper: playCard splices the seat's HAND, so
    // this is the inner array rather than the outer one. With no cards on the
    // table there is no suit to follow, so any card in hand is legal and the
    // test does not have to know the rules to pick one.
    const g = playMatchUntil(
      { config: UI_CONFIGS[2], players: 4, shuffleSeed: 9 },
      (e) => e.phase === PHASES.PLAY && e.plays.length === 0 && e.sweepAt === null,
    );
    const snap = g.serialize();
    const before = JSON.stringify(snap);

    const back = new GameEngine();
    back.restore(snap);
    const seat = back.turnSeat;
    const held = back.hands[seat].length;
    const r = back.playCard(back.seats[seat].id, back.hands[seat][0], 1000);
    ok(r.ok, `a card is played on the restored engine (${r.error || 'ok'})`);
    eq(back.hands[seat].length, held - 1, 'and leaves that hand one card shorter');

    eq(JSON.stringify(snap), before,
      'playing a card on a restored engine does not take the card out of the snapshot');
    eq(g.hands[seat].length, held, 'nor out of the hand the original engine is still holding');
  }

  // --- (d) two engines, one snapshot ---------------------------------------
  //
  // The end state of the bug, and the reason this is worth a section rather
  // than a slice: restoring twice from one object gave two engines writing
  // into one set of arrays. Nothing in the app does this — but "nothing does
  // this today" is a fact about main.js, not about restore().
  {
    const g = playMatchUntil(
      { config: UI_CONFIGS[1], players: 4, shuffleSeed: 11 },
      (e) => e.phase === PHASES.BIDDING && e.history.length >= 1,
    );
    const snap = JSON.parse(JSON.stringify(g.serialize()));

    const a = new GameEngine(); a.restore(snap);
    const b = new GameEngine(); b.restore(snap);
    const bBefore = JSON.stringify(b.serialize());

    const seat = a.turnSeat;
    const choice = a.bidOptionsFor(seat).find((o) => o.legal);
    ok(a.placeBid(a.seats[seat].id, choice.bid, 1000).ok,
      'the first of two engines restored from one snapshot takes a bid');
    eq(JSON.stringify(b.serialize()), bBefore,
      'and the second one does not hear about it — they are two matches, not one');

    let sharedAB = 0;
    const setA = new Set(reachable(a));
    for (const node of reachable(b)) if (setA.has(node)) sharedAB++;
    eq(sharedAB, 0, 'the two engines share no object whatsoever');
  }
}

// ===========================================================================
section('The engine: a round record is sealed whatever shape it turns out to be');
// ===========================================================================

// THE PART OF THE SEAL NO REAL MATCH EXERCISES. Every field a round record has
// ever had is a number or an array of numbers, so "frozen all the way down"
// and "frozen one level down" are the same sentence about today's records and
// different sentences about the function that seals them. The sweep two
// sections up cannot tell them apart: it walks real records, and real records
// are flat.
//
// That is precisely the gap that made restore() adopt the caller's arrays for
// as long as it did — a guarantee that holds because of what the data happens
// to look like is a property of the data, not of the code, and it lapses
// silently the day the data changes. So this section makes the data change.
//
// A nested object arrives through the one door that can carry one: a SNAPSHOT
// FROM ANOTHER BUILD. Add a field to the record in _endRound, play a match,
// save, roll the deploy back — and the older engine restores a record with a
// shape it has never produced. That is a real sequence, not a contrivance, and
// it is the only way an unexpected shape reaches this code at all: restore()
// is fed from localStorage by js/main.js and from nowhere else, never from the
// wire. (Which is also why the recursion needs no depth limit — JSON.parse
// cannot build a cycle, and the only person who can plant a 10,000-deep
// snapshot in your own localStorage is you.)
{
  const g = playMatchUntil(
    { config: UI_CONFIGS[0], players: 4, shuffleSeed: 5 },
    (e) => e.history.length >= 2,
  );
  const snap = JSON.parse(JSON.stringify(g.serialize()));

  // The three shapes a future field could plausibly take, none of which the
  // one-level seal would have reached: a nested object, an array of objects,
  // and an object two levels below the record.
  const planted = {
    byTrick: [{ winner: 0, cards: ['AS', 'KH'] }, { winner: 2, cards: ['3C'] }],
    penalty: { kind: 'square', applied: true, detail: { seat: 1, amount: -40 } },
  };
  snap.history[0].byTrick = planted.byTrick;
  snap.history[0].penalty = planted.penalty;

  const back = new GameEngine();
  back.restore(snap);
  const rec = back.publicState().history[0];

  // PAIRED POSITIVE FIRST, because every assertion below is vacuously true of
  // a record that quietly dropped the fields. restore() does not filter the
  // record's own keys — it seals whatever is there — and if it ever starts to,
  // this is the line that says so rather than the suite going quietly green.
  //
  // EVERYTHING AFTER IT IS WRITTEN TO SURVIVE ITS FAILURE. A block whose
  // paired positive fails and then throws on the next line reports a CRASH,
  // and a crash says "something went wrong here" where a failure would have
  // said which guarantee broke. The optional chaining below is not defensive
  // coding, it is the difference between those two messages.
  eq(rec.penalty?.detail?.amount, -40,
    'the unknown fields survived the restore — otherwise nothing below is being tested');
  eq(rec.byTrick?.length, 2, 'and so did the array of objects');

  // 1. EVERYTHING, AT EVERY DEPTH, REJECTS A WRITE.
  const nodes = reachable(rec);
  const live = nodes.filter((n) => !rejectsWrites(n));
  for (const n of live) console.error(`  ✗ FAIL: a node inside a sealed record accepts a write: ${JSON.stringify(n).slice(0, 60)}`);
  eq(live.length, 0, 'nothing reachable inside a restored round record accepts a write, however deep');

  // The depth is the whole point, so count it rather than trust it: a seal
  // that stopped at one level would leave `detail` and the two trick objects
  // writable, and those are the nodes this number is here to guarantee exist.
  const deep = reachable(rec.penalty).concat(reachable(rec.byTrick));
  ok(deep.length >= 6, `with ${deep.length} nodes below the record's own fields, not zero`);
  ok(reachable(rec.penalty?.detail).length >= 1, 'including one two levels down');

  // 2. AND NONE OF THEM IS THE CALLER'S. The seal copies; a seal that froze in
  //    place would pass the check above while turning the snapshot read-only
  //    under the caller still holding it.
  const theirs = new Set(reachable(planted));
  const shared = nodes.filter((n) => theirs.has(n));
  eq(shared.length, 0, 'and the restored record shares no object with the snapshot it came from');

  // 3. THE OTHER HALF OF "IT COPIES": the snapshot is left exactly as writable
  //    as it was handed over. This is the guarantee that is easiest to lose by
  //    accident — deep-freezing the argument in place satisfies 1 and 2's
  //    spirit and breaks a caller that is still using its own object.
  //    THE WRITE IS THE ASSERTION, so it is the write that is caught. Probing
  //    with rejectsWrites() and then writing for real repeats the same
  //    operation twice, and when the guarantee is broken the second one throws
  //    — turning a named failure into a CRASH, which says "something went
  //    wrong in this block" where the name would have said which guarantee
  //    broke. One attempt, its outcome recorded, asserted on afterwards.
  let stillWritable = false;
  try {
    planted.penalty.detail.amount = -99;
    stillWritable = planted.penalty.detail.amount === -99;
  } catch (_) { /* frozen under us — that IS the failure, reported on the next line */ }
  ok(stillWritable,
    'the caller\'s own nested object is still writable — restore() did not freeze what it was lent');
  eq(rec.penalty?.detail?.amount, -40,
    'and writing to it afterwards does not reach into the engine');
}

// ===========================================================================
section('The engine: conservation laws');
// ===========================================================================

// Five things that must hold at EVERY state of EVERY match, whatever the
// config. Written as relations over the whole state rather than as expected
// values, so they hold at 3 players and at 7, in round 1 and in round 19.
function conservation(g, tag, counts) {
  const n = g.seats.length;

  // 1. The deck is conserved. Every card is in exactly one place: a hand, the
  //    stock, the trick on the table, or already taken. Nothing is duplicated
  //    and nothing evaporates. This is the single strongest assertion in the
  //    file — almost any mutation bug shows up here first.
  if (g.roundIndex >= 0 && g.phase !== PHASES.MATCH_OVER) {
    const seen = [];
    for (const hand of g.hands) seen.push(...hand);
    seen.push(...g.stock);
    for (const p of g.plays) seen.push(p.code);
    if (g.turnUpCard) seen.push(g.turnUpCard);
    // Cards from tricks already taken this round are gone from every list
    // above, so the total is the deck minus them.
    const taken = g.tricksWon.reduce((a, b) => a + b, 0) * n
      - (g.sweepAt !== null ? n : 0);
    if (new Set(seen).size !== seen.length) counts.dupes++;
    if (seen.length + taken !== DECK_SIZE) counts.lost++;
  }

  // 2. Nobody holds more cards than the round started with, and every seat
  //    holds the same number as every other — a deal that shorted one seat is
  //    a deal that nobody notices until the last trick.
  if (g.phase === PHASES.BIDDING) {
    for (const hand of g.hands) if (hand.length !== g.roundSize) counts.uneven++;
  }

  // 3. A bid, once made, is in range and never changes. Tracked across states
  //    rather than checked once, which is what makes "never changes" testable.
  for (let seat = 0; seat < n; seat++) {
    const bid = g.bids[seat];
    if (bid === null || bid === undefined) continue;
    if (!Number.isInteger(bid) || bid < 0 || bid > g.roundSize) counts.badBid++;
    const key = `${g.roundIndex}:${seat}`;
    if (counts.bidSeen.has(key) && counts.bidSeen.get(key) !== bid) counts.bidChanged++;
    counts.bidSeen.set(key, bid);
  }

  // 4. Tricks won never exceed the tricks that exist, and the tricks resolved
  //    so far are exactly the tricks played so far.
  const won = g.tricksWon.reduce((a, b) => a + b, 0);
  if (g.roundIndex >= 0 && won > g.roundSize) counts.overTricks++;
  if (g.phase === PHASES.ROUND_OVER && won !== g.roundSize) counts.underTricks++;

  // 5. The running total is the sum of the deltas. The scoreboard is not
  //    allowed to be an independent accumulator that happens to agree.
  for (let seat = 0; seat < n; seat++) {
    const fromHistory = g.history.reduce((sum, h) => sum + h.deltas[seat], 0);
    if (fromHistory !== g.totals[seat]) counts.totalDrift++;
  }

  counts.states++;
  counts.tag = tag;
}

for (const scoring of SCORING_MODES) {
  for (const players of [3, 5, 7]) {
    const counts = {
      states: 0, dupes: 0, lost: 0, uneven: 0, badBid: 0, bidChanged: 0,
      overTricks: 0, underTricks: 0, totalDrift: 0, bidSeen: new Map(),
    };
    const tag = `${scoring} at ${players}`;
    const g = playMatch({
      config: { scoring, trumpMethod: 'turnup', shape: 'downup', maxHand: 3 },
      players,
      strategy: 'random',
      shuffleSeed: players * 31,
      pickerSeed: players * 17,
      onState: (s) => conservation(s, tag, counts),
    });

    eq(counts.dupes, 0, `${tag}: no card is ever in two places`);
    eq(counts.lost, 0, `${tag}: and all ${DECK_SIZE} are always accounted for`);
    eq(counts.uneven, 0, `${tag}: every seat is dealt the same number of cards`);
    eq(counts.badBid, 0, `${tag}: every bid is between zero and the round size`);
    eq(counts.bidChanged, 0, `${tag}: and no bid ever changes once it is made`);
    eq(counts.overTricks, 0, `${tag}: a round never yields more tricks than it holds`);
    eq(counts.underTricks, 0, `${tag}: and never fewer by the time it is over`);
    eq(counts.totalDrift, 0, `${tag}: the running total is the sum of the round deltas`);

    // The hands are empty and the scores are final.
    eq(g.hands.every((h) => h.length === 0), true, `${tag}: every card is played by the end`);
    eq(g.history.length, g.plan.length, `${tag}: one history record per round in the plan`);
    eq(g.roundIndex, g.plan.length - 1, `${tag}: and the round index stops at the last round`);
  }
}

// ===========================================================================
section('The engine: clockwise, and the dealer moving round');
// ===========================================================================

// The turn direction again, at the layer that would actually misdeal. The
// helpers are pinned in section 1; this pins the engine's USE of them, which
// is where a copied courtpiece loop would land.
for (const players of [3, 4, 5, 6, 7]) {
  let wrongBidOrder = 0, wrongPlayOrder = 0, wrongDealer = 0, wrongLead = 0, rounds = 0;
  let prevSeatPlayed = null;

  playMatch({
    config: { shape: 'descending', maxHand: 3, trumpMethod: 'rotation' },
    players,
    strategy: 'random',
    shuffleSeed: players,
    onState: (g) => {
      if (g.roundIndex < 0 || g.phase === PHASES.MATCH_OVER) return;

      // The dealer advances one seat clockwise per round, from seat 0.
      if (g.dealerSeat !== g.roundIndex % players) wrongDealer++;

      if (g.phase === PHASES.ROUND_DEAL) {
        rounds++;
        // Bidding starts left of the dealer and the dealer bids last. The
        // second half is what the hook depends on: forbid a number for a
        // dealer who is not last and the arithmetic means nothing.
        same(g.bidOrder, seatsFrom(nextSeat(g.dealerSeat, players), players),
          `${players}p: bidding runs clockwise from the dealer's left`);
        if (g.bidOrder[g.bidOrder.length - 1] !== g.dealerSeat) wrongBidOrder++;
        if (g.leadSeat !== nextSeat(g.dealerSeat, players)) wrongLead++;
        prevSeatPlayed = null;
      }

      // Within a trick, each card comes from the next seat clockwise.
      if (g.phase === PHASES.PLAY && g.plays.length) {
        const last = g.plays[g.plays.length - 1].seat;
        if (prevSeatPlayed !== null && g.plays.length > 1
          && last !== nextSeat(prevSeatPlayed, players)) wrongPlayOrder++;
        prevSeatPlayed = last;
      } else {
        prevSeatPlayed = null;
      }
    },
  });

  ok(rounds >= 3, `${players}p: the sweep saw every round`);
  eq(wrongDealer, 0, `${players}p: the deal moves one seat clockwise each round`);
  eq(wrongBidOrder, 0, `${players}p: the dealer bids last, every round`);
  eq(wrongLead, 0, `${players}p: and the dealer's left leads the first trick`);
  eq(wrongPlayOrder, 0, `${players}p: every card comes from the next seat clockwise`);
}

// The trick winner leads the next trick. Its own assertion because it is the
// only thing that moves the lead off the dealer's left, and a version that
// forgot it would still produce a legal-looking game.
{
  let wrongNextLead = 0, checked = 0, pendingWinner = null;
  playMatch({
    config: { shape: 'downup', maxHand: 5, trumpMethod: 'rotation' },
    players: 4,
    strategy: 'random',
    shuffleSeed: 99,
    onState: (g) => {
      if (g.sweepAt !== null) { pendingWinner = g.lastTrick.winner; return; }
      if (pendingWinner !== null && g.phase === PHASES.PLAY && g.plays.length === 0) {
        checked++;
        if (g.turnSeat !== pendingWinner || g.leadSeat !== pendingWinner) wrongNextLead++;
      }
      if (g.plays.length === 0 && g.phase !== PHASES.PLAY) pendingWinner = null;
    },
  });
  ok(checked > 10, `the winner-leads rule was exercised ${checked} times`);
  eq(wrongNextLead, 0, 'the trick winner leads the next trick');
}

// ===========================================================================
section('The engine: the hook, at the dealer\'s seat');
// ===========================================================================

// The hook is arithmetic in js/rules.js and is tested there. What is tested
// here is that the engine applies it TO THE DEALER, LAST, AND TO NOBODY ELSE
// — the three things the pure function cannot check about its caller.
// A dealer that TRIES to level the table every round, behind four players
// who deliberately bid LOW.
//
// Both halves are necessary. The dealer half is what makes the hook-off arm
// mean anything — a random dealer would essentially never land on the
// levelling number by chance, so "no round was bid level" would pass whether
// the hook existed or not. The low-bidding half is what keeps the number
// reachable: four players bidding uniformly at random overshoot the round
// size almost every time, forbiddenBid() then has nothing to forbid, and the
// hook would spend the whole match not biting.
const LEVELLER = {
  bid: (opts, g, seat) => {
    if (seat === g.dealerSeat) {
      const soFar = g.bidOrder.map((s) => g.bids[s]).filter((b) => b !== null);
      const level = forbiddenBid(soFar, g.roundSize);
      if (opts.some((o) => o.bid === level)) return level;
    }
    return opts[rnd(Math.min(2, opts.length))].bid;
  },
  card: (legal) => legal[rnd(legal.length)].code,
};

for (const hook of [true, false]) {
  let levelRounds = 0, rounds = 0, forbiddenOffered = 0, nonDealerRestricted = 0;
  const bitable = new Set();

  playMatch({
    config: { hook, shape: 'downup', maxHand: 4, trumpMethod: 'rotation' },
    players: 5,
    strategy: LEVELLER,
    shuffleSeed: 42,
    pickerSeed: 11,
    onState: (g) => {
      if (g.phase === PHASES.BIDDING) {
        const seat = g.turnSeat;
        const opts = g.bidOptionsFor(seat);
        const soFar = g.bidOrder.map((s) => g.bids[s]).filter((b) => b !== null);
        const banned = forbiddenBid(soFar, g.roundSize);

        // Rounds where the dealer actually faced a forbidden number. Without
        // this, both arms below could be passing simply because the hook
        // never had anything to bite on all match.
        if (seat === g.dealerSeat && banned !== null) bitable.add(g.roundIndex);

        if (seat === g.dealerSeat && hook && banned !== null) {
          // Exactly one number is greyed out, it is that number, and the
          // reason is a sentence rather than a silent refusal.
          const illegal = opts.filter((o) => !o.legal);
          if (illegal.length !== 1 || illegal[0].bid !== banned) forbiddenOffered++;
          if (illegal.length === 1 && !illegal[0].reason) forbiddenOffered++;
          // And the engine refuses it even though the pad says so.
          if (g.placeBid(g.seats[seat].id, banned, 0).ok) forbiddenOffered++;
        } else {
          // Everyone else, always, and the dealer when the hook is off: every
          // number from zero to the round size is available.
          if (opts.some((o) => !o.legal)) nonDealerRestricted++;
        }
      }

      if (g.phase === PHASES.ROUND_OVER
        && g.history.length && g.history[g.history.length - 1].roundIndex === g.roundIndex) {
        const h = g.history[g.history.length - 1];
        rounds++;
        if (h.bids.reduce((a, b) => a + b, 0) === h.roundSize) levelRounds++;
      }
    },
  });

  eq(forbiddenOffered, 0,
    hook ? 'with the hook on, the dealer is refused exactly the levelling number'
      : 'with the hook off, nothing was greyed for the dealer');
  eq(nonDealerRestricted, 0, `hook=${hook}: nobody but the dealer is ever restricted`);
  ok(rounds >= 5, `hook=${hook}: the sweep covered ${rounds} scored rounds`);
  ok(bitable.size >= rounds - 1,
    `hook=${hook}: the dealer faced a levelling number in ${bitable.size} of ${rounds} rounds, so the rule had something to bite on`);

  if (hook) {
    eq(levelRounds, 0, 'with the hook on, no round is ever bid level — somebody must fail');
  } else {
    // The contrast is the evidence. If turning the hook off changed nothing,
    // the assertion above would be passing for the wrong reason.
    ok(levelRounds > 0, `with the hook off, ${levelRounds} rounds were bid level — the rule is doing the work`);
  }
}

// Bidding happens in turn, and the engine is what says so.
//
// THIS BLOCK EXISTS BECAUSE THE MUTATION RUN FOUND ITS ABSENCE. Deleting the
// turn check from placeBid() broke nothing at all: the driver above always
// bids in turn, so an engine that accepted a bid from anybody passed the
// entire suite. It is the clearest example in this file of why the pass count
// is not the evidence.
{
  const g = playMatchUntil({ config: { shape: 'descending', maxHand: 4 }, players: 5 },
    (s) => s.phase === PHASES.BIDDING && s.bids.filter((b) => b !== null).length === 2);

  const turn = g.turnSeat;
  const before = JSON.stringify(g.serialize());
  let accepted = 0;
  for (let seat = 0; seat < g.seats.length; seat++) {
    if (seat !== turn && g.placeBid(g.seats[seat].id, 0, 1).ok) accepted++;
  }
  eq(accepted, 0, 'nobody may bid out of turn, however eager — not the seats still to come');
  eq(JSON.stringify(g.serialize()), before, 'and the attempts left the bidding untouched');

  // Which also means the bid pad only exists for one person at a time. A pad
  // on everybody's screen is a table where three people tap at once and two
  // of them are told nothing happened.
  eq(g.privateStateFor(g.seats[turn].id).bidOptions !== null, true, 'the seat whose turn it is gets a bid pad');
  eq(g.privateStateFor(g.seats[turn].id).isTurn, true, 'and is told it is their turn');
  let extraPads = 0, extraTurns = 0;
  for (let seat = 0; seat < g.seats.length; seat++) {
    if (seat === turn) continue;
    const priv = g.privateStateFor(g.seats[seat].id);
    if (priv.bidOptions !== null) extraPads++;
    if (priv.isTurn) extraTurns++;
  }
  eq(extraPads, 0, 'and nobody else has one');
  eq(extraTurns, 0, 'and nobody else is told it is theirs');
  ok(g.placeBid(g.seats[turn].id, 0, 1).ok, 'the right seat is accepted');
  eq(g.turnSeat === turn, false, 'and the turn moves on');
}

// Nobody is ever told it is their turn in a phase that has no turn — the
// lobby, the deal, the round-over scoreboard.
{
  const g = new GameEngine();
  seatTable(g, ['Ana', 'Ben', 'Cleo', 'Dev']);
  let falseTurns = 0;
  const check = () => {
    for (const s of g.seats) if (g.privateStateFor(s.id).isTurn) falseTurns++;
  };
  check();                       // lobby
  g.startMatch('p0', 0); check(); // the deal
  eq(falseTurns, 0, 'nobody has a turn in the lobby or during the deal');
}

// ===========================================================================
section('The engine: rejecting an action changes nothing');
// ===========================================================================

// Rule 2 of the three in the header, checked as a byte-for-byte comparison of
// the entire engine before and after. Not "the hand is unchanged" — the WHOLE
// STATE, because the failure mode is a field nobody thought to look at.
{
  const g = playMatchUntil({ config: { shape: 'descending', maxHand: 5 }, players: 4 },
    (s) => s.phase === PHASES.PLAY && s.plays.length === 1);

  const turn = g.turnSeat;
  const other = nextSeat(turn, g.seats.length);
  const hand = g.hands[turn];
  const led = ledSuitOf(g.plays);
  const before = JSON.stringify(g.serialize());

  const rejections = [
    ['out of turn', () => g.playCard(g.seats[other].id, g.hands[other][0], 999)],
    ['a card not in hand', () => g.playCard(g.seats[turn].id, ALL_CODES.find((c) => !hand.includes(c)), 999)],
    ['a card that is not a card', () => g.playCard(g.seats[turn].id, 'ZZ', 999)],
    ['a bid during play', () => g.placeBid(g.seats[turn].id, 0, 999)],
    ['a stranger playing', () => g.playCard('nobody', hand[0], 999)],
    ['a stranger bidding', () => g.placeBid('nobody', 0, 999)],
    ['starting a started match', () => g.startMatch('p0', 999)],
    ['a non-owner advancing the round', () => g.nextRound('p1', 999)],
    ['advancing mid-round', () => g.nextRound('p0', 999)],
    ['changing the config mid-match', () => g.setConfig('p0', { scoring: 'square' })],
    ['seating somebody new mid-match', () => g.addPlayer('p9', 'Zoe', { clientId: 'c9' })],
    ['adding a bot mid-match', () => g.addBot('p0')],
    ['removing a seat mid-match', () => g.removeSeat('p0', 3)],
  ];

  let accepted = 0, mutated = 0, unexplained = 0;
  for (const [what, attempt] of rejections) {
    const res = attempt();
    if (res.ok) { accepted++; console.error('  ✗ accepted:', what); }
    if (!res.error) unexplained++;
    if (JSON.stringify(g.serialize()) !== before) { mutated++; console.error('  ✗ mutated:', what); }
  }
  eq(accepted, 0, `all ${rejections.length} illegal actions were refused`);
  eq(mutated, 0, 'and not one of them changed a single byte of the state');
  eq(unexplained, 0, 'every refusal came with a reason to show the player');

  // Follow-suit specifically, since it is the rule the brief says must be
  // enforced on the host rather than in the client's greying-out.
  const mustFollow = hand.filter((c) => suitOf(c) === led);
  if (mustFollow.length) {
    const offSuit = hand.find((c) => suitOf(c) !== led);
    if (offSuit) {
      const res = g.playCard(g.seats[turn].id, offSuit, 999);
      eq(res.ok, false, 'holding the led suit, an off-suit card is refused by the engine');
      ok(/follow/.test(res.error || ''), 'and the refusal says why, in words');
      eq(JSON.stringify(g.serialize()), before, 'and the hand still holds the card');
    }
  }
  ok(g.playCard(g.seats[turn].id, legalPlays(hand, led)[0], 999).ok, 'a legal card is accepted');
}

// ===========================================================================
section('The engine: the pauses, and time as a parameter');
// ===========================================================================

// There is not a timer in the engine. tick() is the only thing that moves a
// transient phase on, and it moves it on exactly when the caller's clock says
// so — which is what lets the driver above play nineteen rounds instantly.
{
  const g = new GameEngine();
  seatTable(g, ['Ana', 'Ben', 'Cleo', 'Dev']);
  g.setConfig('p0', { trumpMethod: 'turnup', shape: 'descending', maxHand: 3 });
  g.startMatch('p0', 1000);

  eq(g.phase, PHASES.ROUND_DEAL, 'the deal is a phase you can see');
  eq(g.tick(1000), false, 'no time has passed, so nothing moves');
  eq(g.phase, PHASES.ROUND_DEAL, 'still dealing');
  eq(g.tick(1000 + 10), false, 'and ten milliseconds is not enough');

  ok(g.tick(1000 + 5000), 'past the pause, tick moves it on');
  eq(g.phase, PHASES.TRUMP_REVEAL, 'to the reveal');
  eq(g.publicState().turnUpCard, g.turnUpCard, 'and now the card is public');
  ok(g.tick(1000 + 20000), 'and on again');
  eq(g.phase, PHASES.BIDDING, 'to bidding');
  eq(g.tick(1000 + 90000), false, 'bidding is not on a clock — it waits for people');
  eq(g.phase, PHASES.BIDDING, 'however long they take');
}

// A finished trick stays on the table until swept, and no card may be led
// into it. This is the sub-state that deliberately is NOT a phase.
{
  const g = playMatchUntil({ config: { shape: 'descending', maxHand: 4 }, players: 4 },
    (s) => s.sweepAt !== null);

  eq(g.phase, PHASES.PLAY, 'a finished trick leaves the phase at PLAY');
  eq(g.plays.length, g.seats.length, 'with every card still showing');
  eq(g.publicState().sweeping, true, 'and the public state says so');
  ok(g.lastTrick && g.lastTrick.winner !== null, 'the winner is already decided');

  const winner = g.lastTrick.winner;
  const res = g.playCard(g.seats[winner].id, g.hands[winner][0], g.sweepAt + 10);
  eq(res.ok, false, 'nobody may lead into a trick still on the table');
  eq(g.privateStateFor(g.seats[winner].id).isTurn, false, 'and nobody is told it is their turn');

  eq(g.tick(g.sweepAt + TRICK_PAUSE_MS - 1), false, 'the sweep waits for the pause');
  eq(g.plays.length, g.seats.length, 'cards still on the table');
  ok(g.tick(g.sweepAt + TRICK_PAUSE_MS), 'and then it fires');
  eq(g.plays.length, 0, 'the table is clear');
  ok(g.lastTrick !== null, 'but the trick just played is still there to look at');
}

// ===========================================================================
section('The engine: the scoreboard, negatives and all');
// ===========================================================================

// The brief's warning, tested rather than remembered: square produces
// negative scores and negative RUNNING TOTALS, and the engine must carry them
// through publicState without clamping anywhere.
{
  const g = playMatch({
    // Everybody bids the whole round, every round. At most one of the four
    // can be right, so three of them miss by several tricks and square
    // charges them the SQUARE of the gap — which is how a running total
    // goes properly negative rather than merely small.
    //
    // Bidding zero instead does not do it: a made zero still pays 10, and
    // missing it by one or two costs 1 or 4, so the totals drift upward.
    // That was the first version of this test and it passed for the wrong
    // reason at +9.
    config: { scoring: 'square', trumpMethod: 'rotation', shape: 'downup', maxHand: 6 },
    players: 4,
    strategy: 'greedy',
    shuffleSeed: 3,
  });

  const lowest = Math.min(...g.totals);
  ok(lowest < 0, `square drove a running total to ${lowest}, which is negative`);
  const everNegative = g.history.some((h) => h.totals.some((t) => t < 0));
  ok(everNegative, 'and it was negative in the scoreboard mid-match, not only at the end');
  ok(g.publicState().seats.some((s) => s.total < 0), 'the public scoreboard carries the minus sign');

  // Independently recomputed from the record, through the pure formula. If
  // the engine and scoring.js ever disagree, this is where it shows.
  let drift = 0;
  for (const h of g.history) {
    for (let seat = 0; seat < g.seats.length; seat++) {
      if (h.deltas[seat] !== scoreRound('square', h.bids[seat], h.tricks[seat], h.roundSize)) drift++;
    }
  }
  eq(drift, 0, 'every delta in the record is what the pure formula says it is');

  // Ties are an outcome, not an edge case. leaders() returns everybody on top.
  const best = Math.max(...g.totals);
  same(g.leaders(), g.totals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0),
    'the leader marker names everybody on the top score');
}

// The three modes over one identical deal produce three different matches —
// the same assertion made in section 2 about the formulas, made again about
// whole matches, because a mode that never reached the scorer would pass the
// first and fail this.
{
  const totalsByMode = SCORING_MODES.map((scoring) => playMatch({
    config: { scoring, trumpMethod: 'rotation', shape: 'descending', maxHand: 4 },
    players: 4, strategy: 'random', shuffleSeed: 555, pickerSeed: 555,
  }).totals.join(','));
  eq(new Set(totalsByMode).size, SCORING_MODES.length,
    'three scoring modes over the same deal give three different scoreboards');
}

// ===========================================================================
section('The engine: rejoining mid-match rebuilds the whole scoreboard');
// ===========================================================================

// The 19-round match will outlast somebody's battery. What they get back must
// be the same scoreboard everybody else is looking at, rebuilt from the
// public record alone — not just the round in progress.
{
  const g = playMatchUntil(
    { config: { scoring: 'square', shape: 'downup', maxHand: 4 }, players: 5, strategy: 'random', shuffleSeed: 8 },
    (s) => s.history.length >= 4 && s.phase === PHASES.PLAY,
  );

  const pub = g.publicState();
  // Everything a fresh tab has: publicState, and nothing else.
  const rebuilt = new Array(g.seats.length).fill(0);
  for (const h of pub.history) h.deltas.forEach((d, seat) => { rebuilt[seat] += d; });
  same(rebuilt, pub.seats.map((s) => s.total),
    'a tab with only the public state reconstructs every running total');
  eq(pub.history.length, g.roundIndex, 'and has a record of every round already played');
  same(pub.history[pub.history.length - 1].totals, pub.seats.map((s) => s.total),
    'the last record already carries the totals, so even the sum is not needed');

  // Now actually drop somebody and bring them back.
  const victim = 2;
  const heldHand = g.hands[victim].slice();
  const heldTotal = g.totals[victim];
  eq(g.disconnect(g.seats[victim].id).ok, true, 'a player drops');
  eq(g.seats.length, 5, 'the seat stays — renumbering would reassign hands and scores');
  eq(g.seats[victim].connected, false, 'and is shown as gone');
  same(g.hands[victim], heldHand, 'their hand is untouched');

  // Back on a new connection id, same clientId — the seat ticket.
  const back = g.addPlayer('p2-new', 'Cleo', { clientId: 'c2' });
  eq(back.ok && back.reclaimed, true, 'the clientId reclaims the seat');
  eq(back.seat, victim, 'the same seat');
  same(g.hands[victim], heldHand, 'with the same cards');
  eq(g.totals[victim], heldTotal, 'and the same score');
  eq(g.privateStateFor('p2-new').hand.length, heldHand.length, 'and they can see their hand again');
  eq(g.privateStateFor(g.seats[0].id).seat, 0, 'nobody else was disturbed');

  // The attack the clientId check exists to stop.
  eq(g.addPlayer('imposter', 'Cleo', { clientId: 'stolen' }).ok, false,
    'knowing a name is not enough to take a seat mid-match');
  eq(g.addPlayer('imposter', 'Cleo').ok, false, 'not even with no clientId at all');
  eq(g.seats[victim].id, 'p2-new', 'the seat still belongs to the person holding the ticket');
}

// ===========================================================================
section('The engine: serialize and restore');
// ===========================================================================

{
  const g = playMatchUntil(
    { config: { scoring: 'kachuful', trumpMethod: 'turnup', shape: 'downup', maxHand: 4 }, players: 5, shuffleSeed: 21 },
    (s) => s.history.length >= 2 && s.phase === PHASES.PLAY && s.plays.length === 2,
  );

  const snapshot = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new GameEngine();
  eq(g2.restore(snapshot).ok, true, 'a snapshot restores');

  // Everyone is marked away on a restore — a reloaded host has no
  // connections yet — so that field is expected to differ and only that one.
  for (const s of g2.seats) s.connected = true;
  same(g2.publicState(), g.publicState(), 'and the restored engine shows the identical public state');
  same(g2.hands, g.hands, 'holding the identical hands');
  same(g2.serialize(), g.serialize(), 'and serialises back to the identical snapshot');

  // It is not a museum piece: play continues from it.
  const seat = g2.turnSeat;
  const led = ledSuitOf(g2.plays);
  ok(g2.playCard(g2.seats[seat].id, legalPlays(g2.hands[seat], led)[0], 99999).ok,
    'and the next card can be played into it');

  // The restore path is what a truncated localStorage write lands on. It must
  // give a lobby, never a throw — a throw here is an app with no UI at all.
  for (const junk of [null, undefined, 42, 'nonsense', [], {}, { seats: 'no' }, { phase: 'hacked' }]) {
    const g3 = new GameEngine();
    let threw = false;
    try { g3.restore(junk); } catch (_) { threw = true; }
    ok(!threw, `restore survives ${JSON.stringify(junk)} without throwing`);
    ok(Object.values(PHASES).includes(g3.phase), 'and lands on a real phase');
  }
  eq(new GameEngine().restore({ phase: 'hacked' }).ok, true, 'an unknown phase is accepted');
  eq((() => { const e = new GameEngine(); e.restore({ phase: 'hacked' }); return e.phase; })(),
    PHASES.LOBBY, 'and normalised to the lobby rather than trusted');
}

// serialize() is the host's own snapshot and carries every hand. It is the
// one object in this codebase that must never go on the wire, so the
// difference between it and publicState() is asserted rather than assumed.
{
  const g = playMatchUntil({ config: { shape: 'descending', maxHand: 5 }, players: 4 },
    (s) => s.phase === PHASES.PLAY);
  const snap = g.serialize();
  ok('hands' in snap && 'stock' in snap, 'the snapshot holds the hands and the stock');
  ok(codesIn(snap).length > codesIn(g.publicState()).length,
    'so it knows far more cards than the public state — these two are not interchangeable');
}

// ===========================================================================
section('The engine: seating, ownership and bots');
// ===========================================================================

{
  const g = new GameEngine();
  eq(g.addPlayer('a', 'Ana', { clientId: 'ca' }).seat, 0, 'the first player takes seat zero');
  eq(g.seats[0].isOwner, true, 'and owns the room');
  eq(g.ownerId, 'a', 'which is recorded');
  eq(g.addPlayer('b', 'Ben', { clientId: 'cb' }).seat, 1, 'the next takes seat one');
  eq(g.seats[1].isOwner, false, 'and does not own it');

  // Two people called Sam is two unreadable scoreboard rows and a spoken
  // "Sam takes it" that means nothing.
  eq(g.addPlayer('c', 'Ana', { clientId: 'cc' }).seat, 2, 'a duplicate name is seated');
  eq(g.seats[2].name, 'Ana 2', 'under a name that can be told apart');
  eq(new Set(g.seats.map((s) => s.name)).size, 3, 'every name at the table is distinct');

  eq(g.addPlayer('d', '', { clientId: 'cd' }).ok, true, 'an empty name is accepted');
  eq(g.seats[3].name, 'Player', 'and given a default rather than a blank row');
  eq(g.addPlayer('e', '  \u0007Zoe\u0000  ', { clientId: 'ce' }).ok, true, 'a hostile name is accepted');
  eq(g.seats[4].name, 'Zoe', 'and cleaned, by the one function that cleans names');

  // The table has a ceiling and it is the deck's, not a preference.
  while (g.seats.length < MAX_PLAYERS) g.addPlayer(`x${g.seats.length}`, `X${g.seats.length}`, { clientId: `cx${g.seats.length}` });
  eq(g.seats.length, MAX_PLAYERS, `the table fills to ${MAX_PLAYERS}`);
  eq(g.addPlayer('over', 'Over', { clientId: 'cover' }).ok, false, 'and refuses the eighth');
  eq(g.addBot('a').ok, false, 'including a bot');

  // Bots, and the ownership rules around them.
  eq(g.removeSeat('b', 6).ok, false, 'a non-owner cannot remove a seat');
  eq(g.removeSeat('a', 6).ok, false, 'and the owner cannot remove somebody who is still here');
  eq(g.removeSeat('a', 0).ok, false, 'least of all themselves');
  eq(g.removeSeat('a', 99).ok, false, 'nor a seat that does not exist');
  eq(g.seats.length, MAX_PLAYERS, 'so the table is still full');
  // Dropping in the lobby is the thing that vacates a chair, because a lobby
  // seat holds nothing worth keeping.
  eq(g.disconnect('x6').removed, true, 'a player who drops in the lobby vacates their chair');
  eq(g.seats.length, MAX_PLAYERS - 1, 'and the table has room again');
  eq(g.addBot('a', 'Rex').ok, true, 'so a bot can join');
  const botSeat = g.seats.length - 1;
  eq(g.seats[botSeat].isBot, true, 'and is marked as one');
  eq(g.seats[botSeat].connected, true, 'a bot is never away — nothing may ever wait on one');
  eq(g.seats[botSeat].clientId, null, 'and holds no seat ticket, because it cannot reconnect');
  eq(g.removeSeat('a', botSeat).ok, true, 'the owner can remove it again');
}

// A lobby that deadlocks the first time somebody reloads is a lobby nobody
// can use. In the lobby a seat holds nothing, so a dropped player is removed;
// mid-match the opposite is true and the seat must stay.
{
  const g = new GameEngine();
  seatTable(g, ['Ana', 'Ben', 'Cleo', 'Dev']);
  eq(g.disconnect('p2').removed, true, 'a lobby drop removes the seat');
  eq(g.seats.length, 3, 'so the table shrinks');
  eq(g.startBlocker(), null, 'and the remaining three can still start');

  eq(g.disconnect('p0').removed, true, 'the owner drops too');
  eq(g.seats.length, 2, 'the table shrinks again');
  eq(g.seats[0].isOwner, true, 'and somebody else owns the room');
  eq(g.ownerId, g.seats[0].id, 'which is recorded, or nothing could ever be started again');

  // A bot cannot inherit the room — it would never press start.
  const h = new GameEngine();
  h.addPlayer('only', 'Ana', { clientId: 'ca' });
  h.addBot('only'); h.addBot('only');
  eq(h.disconnect('only').removed, true, 'the last human leaves a table of bots');
  eq(h.ownerId, null, 'and no bot inherits the room');
  eq(h.seats.every((s) => !s.isOwner), true, 'nothing claims to own it');
}

// Ownership moves on request, and moves only the owner half of the split.
{
  const g = new GameEngine();
  seatTable(g, ['Ana', 'Ben', 'Cleo']);
  g.startMatch('p0', 0);
  eq(g.nextRound('p1', 0).ok, false, 'a non-owner cannot advance the round');
  eq(g.resumeAsOwner('p1').ok, true, 'ownership can be handed over');
  eq(g.seats[1].isOwner, true, 'the new owner has it');
  eq(g.seats[0].isOwner, false, 'the old one does not');
  eq(g.seats.filter((s) => s.isOwner).length, 1, 'and there is exactly one owner, always');
  eq(g.resumeAsOwner('nobody').ok, false, 'a stranger cannot take it');
  // isHost is a property of a TAB and is not in this engine at all. If it ever
  // appears on a seat, the split the brief asked for has been undone.
  eq(g.seats.some((s) => 'isHost' in s), false, 'isHost is not a seat property — it belongs to js/net.js');
  eq('isHost' in g.publicState(), false, 'nor is it in the public state');
}

// ===========================================================================
section('The engine: the three presets, played end to end');
// ===========================================================================

// Not all 54 combinations — the brief says explicitly not to. Three points in
// the space, at the smallest and largest tables, played to the last card.
for (const preset of PRESETS) {
  for (const players of [MIN_PLAYERS, MAX_PLAYERS]) {
    const tag = `${preset.id} at ${players}`;
    const expected = matchShape(preset.config, players);
    const g = playMatch({
      config: preset.config, players, strategy: 'random',
      shuffleSeed: players * 13, pickerSeed: players * 7,
    });

    eq(g.phase, PHASES.MATCH_OVER, `${tag}: the match finished`);
    eq(g.history.length, expected.rounds, `${tag}: ${expected.rounds} rounds, as the lobby promised`);
    eq(g.history.reduce((sum, h) => sum + h.roundSize, 0), expected.tricks,
      `${tag}: ${expected.tricks} tricks, as the lobby promised`);
    eq(g.hands.every((h) => h.length === 0), true, `${tag}: every card was played`);
    eq(g.totals.length, players, `${tag}: everybody has a score`);
    ok(g.leaders().length >= 1, `${tag}: and somebody won`);

    // The ladder the engine actually dealt is the ladder rules.js planned.
    same(g.history.map((h) => h.roundSize), roundPlan(preset.config, players),
      `${tag}: the hand sizes dealt are the planned ladder`);
    // Every round's trump is a real decision by the time the round is over —
    // never still "not yet turned".
    eq(g.history.every((h) => h.trump !== null), true, `${tag}: every round had a trump decided`);
  }
}

// ###########################################################################
//
//  5. THE WIRE
//
//  Everything above assumes the caller is this program. Everything below
//  assumes it is somebody else's phone, reached through a public broker, and
//  possibly not running this program at all.
//
//  The guards do not enforce rules — the engine already does, and section 4
//  proved it. What they enforce is that a message cannot cost the host more
//  work than it is worth, and cannot reach an engine method by a shape the
//  method's signature did not anticipate. So the tests here come in three
//  kinds:
//
//    * CONTRACT, swept. Every guard, against one shared corpus of hostile
//      values, asserting the properties the file claims for all of them at
//      once: never throws, returns the input or null, and never something
//      in between.
//    * ACCEPT SET, swept. For each guard, the boundary between yes and no
//      stated as a relation over the whole input range rather than at a
//      sampled point — validCardCode says yes to a code exactly when the
//      deck contains it, and that is checked against the deck.
//    * CORRESPONDENCE. The guard's accept set versus what the engine can
//      actually survive. This is where validSeat earns its keep, and the
//      test for it starts by reproducing the exploit against the real
//      engine so that the guard is measured against a demonstrated hole
//      rather than an imagined one.
//
// ###########################################################################

// A printable, never-throwing rendering of an arbitrary value. eq() and same()
// both call JSON.stringify on what they are given, and JSON.stringify throws on
// a BigInt — so the fuzz sweeps below use ok() with a label built through this
// instead. A test harness that dies while formatting a failure message is worse
// than no test.
function show(v) {
  let s;
  try { s = typeof v === 'string' ? JSON.stringify(v) : String(v); } catch (_) { return '<unprintable>'; }
  return s.length > 32 ? `${s.slice(0, 32)}…` : s;
}

// One corpus, shared by every guard.
//
// Not a list of things that might break a particular function — a list of every
// SHAPE a value can have, so that adding a guard to the sweep below tests it
// against all of them without anyone thinking about which ones matter. The
// prototype-key strings are the ones that matter most and are easiest to leave
// out, because they are perfectly ordinary strings right up until something
// uses one as an index.
const HOSTILE_VALUES = Object.freeze([
  null, undefined, true, false,
  0, -0, 1, -1, 1.5, -1.5, 0.1, NaN, Infinity, -Infinity,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 1e308, 1e-308,
  1n,
  '', ' ', 'x', 'AS', '0', '1', '-1', '1.5',
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
  'S', 'N', 'as', 'A S', 'ASS', '\u0000', '\n', '\uD800',
  'x'.repeat(65), 'x'.repeat(257), 'x'.repeat(70000),
  [], [1], ['AS'], [[]],
  {}, { type: 'x' }, { length: 3 }, { valueOf() { return 3; } },
  Object.create(null),
  new Date(0), /re/, () => {}, Symbol('s'),
  { __proto__: { isBot: true, connected: false } },
  JSON.parse('{"__proto__": {"polluted": true}}'),
]);

// Every guard that takes one argument and answers with the value or null.
// Keyed so a failure names the guard; iterated so a new guard is swept the day
// it is added to this list and not one commit later.
const GUARDS = Object.freeze({
  validEnvelope, validClientId, validPlayerId, validCardCode, validSuit,
  validSeat, validBid, validName, validConfigPatch, validPublicState,
  validPrivateState,
});

// ===========================================================================
section('Guards: the contract every one of them keeps');
// ===========================================================================

for (const [name, guard] of Object.entries(GUARDS)) {
  for (const value of HOSTILE_VALUES) {
    let out, threw = false;
    try { out = guard(value); } catch (_) { threw = true; }
    ok(!threw, `${name}(${show(value)}) threw — a guard must answer, not raise`);
    if (threw) continue;

    // "Returns a usable value or null — never throws, and never hands back
    // something half-cleaned." That last clause is the one worth pinning: a
    // guard that trimmed, coerced or defaulted would let the checked thing and
    // the used thing drift apart, which is the bug the return-the-value idiom
    // exists to make impossible.
    ok(out === null || out === value || (Number.isNaN(out) && Number.isNaN(value)),
      `${name}(${show(value)}) returned something other than its input or null`);

    // And the answer is stable: feeding an accepted value back in accepts it
    // again. A guard whose output its own input check rejects would mean the
    // value changes meaning between the validation and the use.
    if (out !== null) {
      ok(guard(out) === out, `${name} does not accept its own output for ${show(value)}`);
    }
  }
}

// ===========================================================================
section('Guards: the accept set, swept rather than sampled');
// ===========================================================================

// A card code is valid exactly when the deck holds it. Swept over a superset of
// the alphabet — every rank character against every suit character plus some
// near misses — so the relation is checked on both sides, not just on the 52
// that are supposed to pass.
{
  const rankChars = [...RANKS, 'a', 's', '1', '0', 'N', 'X', ''];
  const suitChars = [...SUITS, 's', 'h', 'N', 'X', '', '1'];
  let yes = 0, no = 0;
  for (const r of rankChars) {
    for (const s of suitChars) {
      const code = r + s;
      const accepted = validCardCode(code) !== null;
      eq(accepted, ALL_CODES.includes(code),
        `validCardCode('${code}') should agree with the deck`);
      if (accepted) yes++; else no++;
    }
  }
  eq(yes, DECK_SIZE, 'and exactly the 52 cards of the deck were accepted');
  ok(no > 60, `with ${no} near misses refused, so the sweep is not one-sided`);
}

// A suit is one of the four. NO_TRUMP is not one of them, and that is the whole
// point of it being a sentinel rather than a fifth suit — see rules.js.
for (const s of [...SUITS, NO_TRUMP, 'n', 'X', 'SD', '']) {
  eq(validSuit(s) !== null, SUITS.includes(s), `validSuit('${s}')`);
}
eq(validSuit(NO_TRUMP), null, 'No Trump is not a suit, and the guard agrees');

// Seats and bids: integer, in range, both ends. Swept past both boundaries so
// an off-by-one at either end is a failure rather than an untested value.
for (let n = -4; n <= MAX_PLAYERS + 4; n++) {
  eq(validSeat(n) !== null, n >= 0 && n < MAX_PLAYERS, `validSeat(${n})`);
  eq(validSeat(n + 0.5), null, `validSeat(${n + 0.5}) — a float is not a seat`);
  eq(validSeat(String(n)), null, `validSeat('${n}') — a numeric string is not a seat`);
}
for (let n = -4; n <= MAX_HAND_CEILING + 4; n++) {
  eq(validBid(n) !== null, n >= 0 && n <= MAX_HAND_CEILING, `validBid(${n})`);
  eq(validBid(n + 0.5), null, `validBid(${n + 0.5}) — a fractional trick is not a bid`);
}
// The bid ceiling is the deck's, not a typed-in number: three players at
// seventeen cards is the largest hand any legal round can hold, so no legal bid
// can ever exceed it and no honest guard can be tighter.
eq(validBid(MAX_HAND_CEILING), MAX_HAND_CEILING, 'the widest legal hand is a biddable number');
eq(validBid(maxHandSize(MIN_PLAYERS)), MAX_HAND_CEILING, 'and that number is the deck talking');

// Lengths, both ends, for the three string guards that are bounded by length.
for (let n = 0; n <= 80; n++) {
  const s = 'a'.repeat(n);
  eq(validClientId(s) !== null, n >= 8 && n <= 64, `validClientId of length ${n}`);
  eq(validPlayerId(s) !== null, n >= 1 && n <= 64, `validPlayerId of length ${n}`);
}
for (const n of [0, 1, 2, MAX_RAW_NAME_LEN - 1, MAX_RAW_NAME_LEN, MAX_RAW_NAME_LEN + 1, 5000]) {
  eq(validName('a'.repeat(n)) !== null, n >= 1 && n <= MAX_RAW_NAME_LEN,
    `validName of length ${n}`);
}
// A name is bounded here and CLEANED in rules.js, and the division of labour is
// the point: anything that survives this is then cut to MAX_NAME_LEN, so a
// 256-character name is accepted by the guard and still renders as sixteen.
{
  const long = 'Bartholomew Fitzgerald III of Somewhere';
  ok(validName(long) !== null, 'a long-but-plausible name passes the guard');
  ok(cleanName(long).length <= MAX_NAME_LEN, 'and cleanName is what actually shortens it');
}

// The clientId character class. Anything outside [A-Za-z0-9_-] is refused, which
// is what keeps an id out of trouble in a log line or as a JSON key.
for (const bad of ['a'.repeat(7), 'abcdefg!', 'abcdefg ', 'abcdefg.', 'abcd efgh', 'abcdefg\n', '../abcdefg']) {
  eq(validClientId(bad), null, `validClientId rejects ${show(bad)}`);
}
for (const good of ['abcdefgh', 'A_b-C9'.repeat(4), '0'.repeat(64)]) {
  eq(validClientId(good), good, `validClientId accepts ${show(good)}`);
}

// A config patch is bounded by KEY COUNT, because setConfig spreads before
// normalizeConfig filters. Swept across the cap in both directions.
for (let n = 0; n <= MAX_PATCH_KEYS + 4; n++) {
  const patch = {};
  for (let k = 0; k < n; k++) patch[`k${k}`] = 1;
  eq(validConfigPatch(patch) !== null, n >= 1 && n <= MAX_PATCH_KEYS,
    `validConfigPatch with ${n} keys`);
}
// An empty patch is refused rather than treated as a no-op. Nothing sends one;
// a message that asks for no change is a message that should not have been
// sent, and answering it would mean rebroadcasting the state for nothing.
eq(validConfigPatch({}), null, 'an empty patch is not a setting');
// The real four-axis patch the lobby sends, and the full config a joining
// client is brought into line with, both fit comfortably.
ok(validConfigPatch({ scoring: 'square' }) !== null, 'one axis fits');
ok(validConfigPatch({ ...DEFAULT_CONFIG }) !== null, 'and so does the whole config at once');

// The envelope. A type is a short verb; an array is not a message.
eq(validEnvelope({ type: 'playCard' }) !== null, true, 'a typed object is a message');
eq(validEnvelope([{ type: 'playCard' }]), null, 'an array of messages is not a message');
eq(validEnvelope({ type: 'a'.repeat(MAX_TYPE_LEN) }) !== null, true, 'a type may be exactly the cap');
eq(validEnvelope({ type: 'a'.repeat(MAX_TYPE_LEN + 1) }), null, 'and not one character more');
eq(validEnvelope({ type: 42 }), null, 'a numeric type is not a type');

// ===========================================================================
section('Guards: validSeat against the hole it actually closes');
// ===========================================================================

// FIRST, THE EXPLOIT, AGAINST THE REAL ENGINE. The comment on validSeat claims
// a specific chain of events; a claim in a comment is worth nothing unless the
// thing it describes has been made to happen. This makes it happen, so that
// what follows is measured against a demonstrated hole rather than a feared
// one. If the engine is ever hardened so this no longer reproduces, this block
// fails and the comment gets rewritten — which is the correct outcome.
{
  const g = new GameEngine();
  g.addPlayer('p0', 'Ana', { clientId: 'c0' });
  g.addPlayer('p1', 'Ben', { clientId: 'c1' });
  g.addPlayer('p2', 'Cleo', { clientId: 'c2' });

  eq(g.seats[0].name, 'Ana', 'seat zero is the owner, before');
  eq(g.ownerId, 'p0', 'and ownerId names them');

  const res = g.removeSeat('p0', '__proto__');
  eq(res.ok, true, 'the raw engine ACCEPTS a __proto__ seat — this is the hole');
  eq(g.seats.length, 2, 'and a seat is gone');
  eq(g.seats[0].name, 'Ben', 'specifically seat zero, the owner');
  eq(g.ownerId, 'p0', 'while ownerId still names the evicted player');
  eq(g.seats.some((s) => s.isOwner), false, 'so nobody at the table owns the room');
  eq(g._isOwner('p0'), false, 'the named owner cannot act');
  eq(g._isOwner('p1'), false, 'and neither can anybody else');
  eq(g.startMatch('p0', 0).ok, false, 'the room can no longer be started');
  eq(g.setConfig('p0', { scoring: 'square' }).ok, false, 'or configured');
  eq(g.addBot('p0').ok, false, 'or filled — a permanent denial of service');
}

// NOW THE GUARD. Every hostile value, through the dispatcher, against a lobby
// that must survive all of them unchanged. Swept rather than sampled because
// '__proto__' is only the one I thought of.
{
  for (const value of HOSTILE_VALUES) {
    const g = new GameEngine();
    g.addPlayer('p0', 'Ana', { clientId: 'c0' });
    g.addPlayer('p1', 'Ben', { clientId: 'c1' });
    g.addPlayer('p2', 'Cleo', { clientId: 'c2' });
    const before = JSON.stringify(g.serialize());

    let out, threw = false;
    try { out = applyGameIntent(g, 'p0', { type: 'removeSeat', seat: value }, 0); } catch (_) { threw = true; }
    ok(!threw, `removeSeat with seat ${show(value)} threw`);
    if (threw) continue;

    // A seat that is not a seat number is refused. A seat number that is not a
    // seat at THIS table is also refused, but by the engine and with its own
    // reason — either way nothing moves.
    ok(out.handled, `removeSeat with seat ${show(value)} should be handled`);
    ok(!out.result.ok, `removeSeat with seat ${show(value)} should be refused`);
    eq(JSON.stringify(g.serialize()), before,
      `removeSeat with seat ${show(value)} changed the room`);
  }
}

// And the guard has not closed the door on the legitimate case: a bot is still
// removable by its seat number, which is the whole reason the intent exists.
{
  const g = new GameEngine();
  g.addPlayer('p0', 'Ana', { clientId: 'c0' });
  g.addPlayer('p1', 'Ben', { clientId: 'c1' });
  applyGameIntent(g, 'p0', { type: 'addBot' }, 0);
  eq(g.seats.length, 3, 'a bot was seated through the dispatcher');
  eq(g.seats[2].isBot, true, 'and it is a bot');
  const out = applyGameIntent(g, 'p0', { type: 'removeSeat', seat: 2 }, 0);
  eq(out.result.ok, true, 'and the owner can remove it again by seat number');
  eq(g.seats.length, 2, 'leaving two');
}

// ===========================================================================
section('Guards: the rate limit, with time as a parameter');
// ===========================================================================

// THE CLOCK IS A PARAMETER, and this is the assertion that pins it rather than
// trusting the signature. Date.now is replaced with a function that throws, so
// any hidden read of the wall clock is a thrown error instead of a test that
// passes today and cannot be replayed tomorrow.
{
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('the bucket read the wall clock'); };
    let threw = false;
    try {
      const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 0 });
      for (let i = 0; i < 10; i++) b.take(i * 1000);
    } catch (_) { threw = true; }
    ok(!threw, 'a TokenBucket given an explicit `now` never consults Date.now');
  } finally {
    Date.now = realNow;
  }
}

// Capacity: from full, exactly `capacity` messages pass at one instant.
// Swept over capacities so the relation is the assertion, not one number.
for (const capacity of [1, 2, 5, 40, 100]) {
  const b = new TokenBucket({ capacity, refillPerSec: 15, now: 0 });
  let n = 0;
  while (b.take(0)) { n++; if (n > capacity + 5) break; }
  eq(n, capacity, `a bucket of ${capacity} passes exactly ${capacity} at one instant`);
}

// Refill: after s whole seconds an emptied bucket has min(capacity, s * rate)
// back. Whole seconds and integer rates on purpose — (1000 * s) / 1000 is
// exactly s in binary floating point, so the expected value here is arithmetic
// rather than a re-implementation of the line being tested.
for (const rate of [1, 3, 15]) {
  for (let s = 0; s <= 12; s++) {
    const b = new TokenBucket({ capacity: 10, refillPerSec: rate, now: 0 });
    while (b.take(0)) { /* drain */ }
    let n = 0;
    while (b.take(s * 1000)) { n++; if (n > 20) break; }
    eq(n, Math.min(10, s * rate), `after ${s}s at ${rate}/s, ${Math.min(10, s * rate)} messages pass`);
  }
}

// Monotone in elapsed time, and never above the cap however long the wait.
{
  let last = -1;
  for (const ms of [0, 100, 500, 1000, 2000, 60000, 86400000, 1e15]) {
    const b = new TokenBucket({ capacity: 40, refillPerSec: 15, now: 0 });
    while (b.take(0)) { /* drain */ }
    let n = 0;
    while (b.take(ms)) { n++; if (n > 45) break; }
    ok(n >= last, `waiting ${ms}ms allows at least as much as waiting less`);
    ok(n <= 40, `waiting ${ms}ms never allows more than the capacity`);
    last = n;
  }
}

// A CLOCK THAT STEPS BACKWARDS, which is what a phone does across a sleep.
// The clamp means the bucket refills nothing rather than draining by a negative
// amount — so a player is throttled for a moment, never locked out until the
// clock catches up.
{
  const b = new TokenBucket({ capacity: 5, refillPerSec: 15, now: 100000 });
  let n = 0;
  for (let i = 0; i < 20; i++) if (b.take(100000 - i * 1000)) n++;
  eq(n, 5, 'a backwards clock grants no refill, and no more than a full bucket');
  ok(b.take(200000), 'and the bucket recovers once time moves forward again');
}

// Sustained rates: at the refill rate a player is never refused, at twice it
// they are. This is the property the limit exists for — bursty real play gets
// through, a loop does not.
for (const [perSec, shouldSurvive] of [[15, true], [10, true], [30, false], [200, false]]) {
  const b = new TokenBucket({ capacity: 40, refillPerSec: 15, now: 0 });
  let refused = 0;
  for (let i = 0; i < 600; i++) if (!b.take(Math.round((i * 1000) / perSec))) refused++;
  eq(refused === 0, shouldSurvive,
    `600 messages at ${perSec}/s against a 15/s bucket: ${shouldSurvive ? 'all pass' : 'some refused'}`);
}

// ===========================================================================
section('Guards: decoding a frame off the wire');
// ===========================================================================

// Round trip: everything this app actually sends survives being stringified
// and decoded. Derived from GAME_INTENTS so a new intent is round-tripped the
// day it is added.
for (const type of GAME_INTENTS) {
  const msg = { type, seat: 1, bid: 2, code: 'AS', config: { scoring: 'square' } };
  const back = decodePeerFrame(JSON.stringify(msg));
  same(back, msg, `a ${type} message survives the round trip`);
}

// A whole public state, which is the largest thing the host sends, fits inside
// the frame cap with room to spare. Measured against a real match at the widest
// table and the longest ladder rather than guessed at.
{
  const g = playMatchUntil(
    { config: { shape: 'downup', scoring: 'square' }, players: 7, shuffleSeed: 9 },
    (s) => s.roundIndex >= 5 && s.phase === PHASES.PLAY,
  );
  const wire = JSON.stringify({ type: 'state', pub: g.publicState() });
  ok(wire.length < MAX_FRAME_BYTES, `a seven-seat public state is ${wire.length} bytes, under the cap`);
  ok(decodePeerFrame(wire) !== null, 'and decodes');
}

// The cap itself, at the boundary. Padded to an exact character count so this
// is the cap being tested and not an approximation of it.
{
  const shell = JSON.stringify({ type: 'playCard', pad: '' });
  const atCap = JSON.stringify({ type: 'playCard', pad: 'x'.repeat(MAX_FRAME_BYTES - shell.length) });
  eq(atCap.length, MAX_FRAME_BYTES, 'the padded frame is exactly at the cap');
  ok(decodePeerFrame(atCap) !== null, 'a frame exactly at the cap is accepted');
  const overCap = JSON.stringify({ type: 'playCard', pad: 'x'.repeat(MAX_FRAME_BYTES - shell.length + 1) });
  eq(decodePeerFrame(overCap), null, 'and one character more is refused');
}

// Everything that is not a message this app would send.
eq(decodePeerFrame('not json'), null, 'a non-JSON string is refused, not thrown on');
eq(decodePeerFrame('[]'), null, 'a JSON array is refused');
eq(decodePeerFrame('null'), null, 'JSON null is refused');
eq(decodePeerFrame('42'), null, 'a bare JSON number is refused');
eq(decodePeerFrame('"playCard"'), null, 'a bare JSON string is refused');
eq(decodePeerFrame('{}'), null, 'an untyped object is refused');
eq(decodePeerFrame(new ArrayBuffer(8)), null, 'an ArrayBuffer is refused');
eq(decodePeerFrame(new Uint8Array(8)), null, 'a typed array is refused');
eq(decodePeerFrame(new DataView(new ArrayBuffer(8))), null, 'a DataView is refused');
// The object path: PeerJS's own BinaryPack serializer delivers an already
// decoded object, so the envelope check has to run on that path too.
ok(decodePeerFrame({ type: 'playCard', code: 'AS' }) !== null, 'a pre-decoded object is accepted');
eq(decodePeerFrame({ code: 'AS' }), null, 'a pre-decoded object with no type is refused');

// And nothing in the corpus makes it throw.
for (const value of HOSTILE_VALUES) {
  let threw = false;
  try { decodePeerFrame(value); } catch (_) { threw = true; }
  ok(!threw, `decodePeerFrame(${show(value)}) threw`);
}

// ===========================================================================
section('Guards: what a client accepts back from its host');
// ===========================================================================

// THE FAILURE MODE THAT MATTERS MOST HERE IS A FALSE NEGATIVE. A guard that
// refuses a legitimate frame does not protect anybody; it bricks the game, and
// it does so only in the states nobody tested. So: play matches across every
// trump method and a spread of table sizes, and assert at EVERY state that the
// real publicState and every real privateState pass.
{
  let states = 0, privates = 0;
  for (const trumpMethod of TRUMP_METHODS) {
    for (const players of [3, 5, 7]) {
      playMatch({
        config: { trumpMethod, shape: 'descending', maxHand: 3 },
        players,
        shuffleSeed: players * 7,
        onState: (g) => {
          states++;
          ok(validPublicState(g.publicState()) !== null,
            `a real public state was refused (${trumpMethod}, ${players} players, ${g.phase})`);
          for (const s of g.seats) {
            const priv = g.privateStateFor(s.id);
            privates++;
            ok(validPrivateState(priv) !== null,
              `a real private state was refused (${trumpMethod}, ${players} players, ${g.phase})`);
          }
        },
      });
    }
  }
  ok(states > 400, `checked across ${states} public states`);
  ok(privates > 2000, `and ${privates} private states`);
}

// The lobby is a state too, and the awkward one: no seats, no plan, and
// dealerSeat pointing at a seat that does not exist yet. Refusing the very
// first frame of every session would be an expensive way to be careful.
{
  const g = new GameEngine();
  ok(validPublicState(g.publicState()) !== null, 'an empty lobby is a valid public state');
  eq(g.privateStateFor('nobody'), null, 'and a stranger has no private state at all');
  g.addPlayer('p0', 'Ana', { clientId: 'c0' });
  ok(validPublicState(g.publicState()) !== null, 'a one-seat lobby is valid');
  ok(validPrivateState(g.privateStateFor('p0')) !== null, 'and the one player has a valid private state');
}

// Now the true positives, derived from the real state rather than listed.
// EVERY array-valued field of a real publicState must be checked by the guard,
// because every one of them is walked by a renderer that assumes it is an
// array. Deriving the sweep from the state means a seventh array added to
// publicState() fails this until the guard covers it too.
{
  const g = playMatchUntil({ players: 5, shuffleSeed: 3 }, (s) => s.phase === PHASES.PLAY);
  const pub = g.publicState();
  let swept = 0;
  for (const [key, value] of Object.entries(pub)) {
    if (!Array.isArray(value)) continue;
    swept++;
    for (const wrong of ['nope', 7, {}, null]) {
      eq(validPublicState({ ...pub, [key]: wrong }), null,
        `publicState.${key} must be an array — ${show(wrong)} should be refused`);
    }
  }
  ok(swept >= 6, `swept ${swept} array fields of a real public state`);

  // The seat pointers, each of which gets used as an index somewhere.
  for (const key of ['dealerSeat', 'leadSeat', 'turnSeat', 'trickIndex']) {
    for (const wrong of ['__proto__', -1, 1.5, '0', null, NaN]) {
      eq(validPublicState({ ...pub, [key]: wrong }), null,
        `publicState.${key} of ${show(wrong)} should be refused`);
    }
  }
  // But roundIndex is deliberately NOT bounded below at zero: -1 is what the
  // engine honestly reports before the first deal.
  ok(validPublicState({ ...pub, roundIndex: -1 }) !== null,
    'roundIndex of -1 is a real value and is not refused');

  eq(validPublicState({ ...pub, config: 'kachuful' }), null, 'a string config is refused');
  eq(validPublicState({ ...pub, phase: 42 }), null, 'a numeric phase is refused');
  eq(validPublicState({ ...pub, seats: new Array(MAX_PLAYERS + 1).fill({}) }), null,
    'more seats than the game allows is refused');
  ok(validPublicState({ ...pub, seats: new Array(MAX_PLAYERS).fill({ name: 'x' }) }) !== null,
    'and a full table is not');

  const priv = g.privateStateFor('p0');
  let privSwept = 0;
  for (const [key, value] of Object.entries(priv)) {
    if (!Array.isArray(value)) continue;
    privSwept++;
    eq(validPrivateState({ ...priv, [key]: 'nope' }), null,
      `privateState.${key} must be an array`);
  }
  ok(privSwept >= 1, `swept ${privSwept} array fields of a real private state`);
  eq(validPrivateState({ ...priv, seat: '__proto__' }), null, 'a prototype-key seat is refused');
  eq(validPrivateState({ ...priv, seat: MAX_PLAYERS }), null, 'a seat past the table is refused');
  eq(validPrivateState({ ...priv, hand: new Array(MAX_HAND_CEILING + 1).fill('AS') }), null,
    'a hand bigger than the deck allows is refused');
  // bidOptions is null when it is not this seat's bid, and an array when it is.
  // Both are real, so both must pass — and anything else must not.
  ok(validPrivateState({ ...priv, bidOptions: null }) !== null, 'a null bid pad is a real value');
  ok(validPrivateState({ ...priv, bidOptions: [] }) !== null, 'and so is an empty one');
  eq(validPrivateState({ ...priv, bidOptions: 3 }), null, 'but a number is not');
}

// ===========================================================================
section('Intents: the surface, and what is deliberately not on it');
// ===========================================================================

// The three lists agree with each other, and nothing is listed twice.
same(GAME_INTENTS, [...PLAYER_INTENTS, ...OWNER_INTENTS], 'GAME_INTENTS is the two lists joined');
eq(new Set(GAME_INTENTS).size, GAME_INTENTS.length, 'and holds no duplicates');
for (const list of [PLAYER_INTENTS, OWNER_INTENTS, GAME_INTENTS, SELF_GUARDED, LOCAL_ONLY]) {
  eq(Object.isFrozen(list), true, 'every intent list is frozen');
}

// THE WHOLE PUBLIC SURFACE OF THE ENGINE IS ACCOUNTED FOR. Every public method
// of GameEngine is either wire-reachable or explicitly local, in exactly one of
// the two lists. This is the assertion that makes a new engine method a
// decision rather than an accident: add one and this fails until somebody has
// said which side of the wire it lives on.
{
  const publicMethods = Object.getOwnPropertyNames(GameEngine.prototype)
    .filter((n) => n !== 'constructor' && !n.startsWith('_'));
  ok(publicMethods.length >= 20, `the engine has ${publicMethods.length} public methods to account for`);

  for (const name of publicMethods) {
    const wire = GAME_INTENTS.includes(name);
    const local = LOCAL_ONLY.includes(name);
    ok(wire !== local, `engine method '${name}' is in ${wire ? 'both' : 'neither'} list`);
  }
  for (const name of [...GAME_INTENTS, ...LOCAL_ONLY]) {
    ok(publicMethods.includes(name), `'${name}' is listed but is not an engine method`);
  }
}

// DISPATCH IS EXACTLY THE INTENT LIST. Swept over every public method name, so
// a method that became reachable by accident fails here rather than in the
// wild. `handled` is the security-relevant bit: false means the transport keeps
// looking and the engine was never touched.
{
  const names = [
    ...Object.getOwnPropertyNames(GameEngine.prototype).filter((n) => n !== 'constructor'),
    'join', 'sync', 'hello', 'ping', '__proto__', 'constructor', 'toString', '',
  ];
  for (const name of names) {
    const g = new GameEngine();
    g.addPlayer('p0', 'Ana', { clientId: 'c0' });
    const before = JSON.stringify(g.serialize());
    const out = applyGameIntent(g, 'p0', { type: name, seat: 0, bid: 0, code: 'AS', config: { hook: false } }, 0);
    eq(out.handled, GAME_INTENTS.includes(name), `'${name}' handled?`);
    if (!out.handled) {
      eq(out.result, null, `'${name}' is not handled, so there is no result`);
      eq(JSON.stringify(g.serialize()), before, `'${name}' is not handled, so nothing changed`);
    }
  }
}

// A non-string type is not a message at all — and in particular an object with
// a `type` that is itself an object must not be coerced into one.
for (const type of [undefined, null, 42, {}, [], true, Symbol('x')]) {
  const out = applyGameIntent(new GameEngine(), 'p0', { type }, 0);
  eq(out.handled, false, `a type of ${show(type)} is not dispatched`);
}

// ===========================================================================
section('Intents: the guard is the gate, and the engine is only the backstop');
// ===========================================================================
//
// WHY THIS SECTION EXISTS. Three mutations survived the checkpoint-5 run:
// validEnvelope losing its Array.isArray branch, and playCard and setConfig
// each handing the raw wire value to the engine. All three survived for the
// same reason — the engine is independently defensive, so removing the guard
// changed no observable outcome and every existing assertion still passed.
//
// That is good defence in depth and a real hole in the suite at the same time.
// Everything above tests THROUGH applyGameIntent and judges it by its result,
// which is precisely the thing a redundant guard does not change. The guard's
// own contract is that a malformed value never reaches the engine at all, and
// an assertion about a result cannot see that. So these assert the CALL.

// An array cannot carry a `type` if it came through JSON.parse, which is why
// the array assertion further up passes with or without the Array.isArray
// branch: that array has no `.type`, so the next line rejects it and the
// branch is never the reason. Anything that is not the JSON path can hand over
// an array with properties on it, so the branch is load-bearing — and this is
// the one input that needs it.
{
  const typed = [{ type: 'playCard', code: 'AS' }];
  typed.type = 'playCard';
  eq(validEnvelope(typed), null, 'an array is not a message even when it carries a type');
  eq(typeof typed.type, 'string', 'and the array really did carry a string type');
}

// A SPY ENGINE, standing in for the real one so the question becomes "was it
// called" rather than "what did it answer". Every method returns a plain
// success so that a guard which wrongly let something past is visible as a
// recorded call and not as an error from somewhere deeper.
const spyEngine = () => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); return { ok: true }; };
  return {
    calls,
    placeBid: rec('placeBid'),
    playCard: rec('playCard'),
    setConfig: rec('setConfig'),
    addBot: rec('addBot'),
    removeSeat: rec('removeSeat'),
    startMatch: rec('startMatch'),
    nextRound: rec('nextRound'),
  };
};

// playCard. The stated reason for validating here rather than leaning on the
// engine is cost: canPlay() would otherwise compare a 64 KiB string against
// every card in a hand, for a peer that has sent nothing legible. The long
// string below is that case, and the rest are the ordinary malformed ones.
{
  const junk = [
    undefined, null, 42, true, {}, [], 'A', 'AS!', 'ZZ', '2s', 'as', '',
    '__proto__', 'constructor', 'x'.repeat(65536), 'AS AS', ' AS', 'AS\n',
  ];
  for (const code of junk) {
    const e = spyEngine();
    const out = applyGameIntent(e, 'p0', { type: 'playCard', code }, 7);
    eq(out.handled, true, `playCard with ${show(code)} is still dispatched`);
    eq(out.result.ok, false, `playCard with ${show(code)} is refused`);
    eq(out.result.error, 'That is not a card.', `and refused BY THE GUARD, ${show(code)}`);
    eq(e.calls.length, 0, `and the engine is never called with ${show(code)}`);
  }
  // Not vacuous: a well-formed code does reach the engine, unchanged, with the
  // clock threaded. If this failed the sweep above would be passing because
  // nothing gets through rather than because the guard sorts them.
  const e = spyEngine();
  const out = applyGameIntent(e, 'p0', { type: 'playCard', code: 'TH' }, 7);
  eq(e.calls.length, 1, 'a real card reaches the engine');
  same(e.calls[0], { name: 'playCard', args: ['p0', 'TH', 7] }, 'with the actor, the card and the clock');
  eq(out.result.ok, true, 'and the engine\'s answer is passed back');
}

// setConfig. Same shape of hole: normalizeConfig has an allow-list, so a junk
// patch is harmless once it arrives. It should not arrive.
{
  const junk = [
    undefined, null, 42, true, 'hook', '', {}, [], [{ hook: false }],
    Object.fromEntries(Array.from({ length: MAX_PATCH_KEYS + 1 }, (_, i) => [`k${i}`, i])),
  ];
  for (const patch of junk) {
    const e = spyEngine();
    const out = applyGameIntent(e, 'p0', { type: 'setConfig', patch }, 0);
    eq(out.handled, true, `setConfig with ${show(patch)} is still dispatched`);
    eq(out.result.ok, false, `setConfig with ${show(patch)} is refused`);
    eq(out.result.error, 'That is not a setting.', `and refused BY THE GUARD, ${show(patch)}`);
    eq(e.calls.length, 0, `and the engine is never called with ${show(patch)}`);
  }
  // An empty object is refused and a one-key patch is not, so the key floor is
  // a boundary rather than a coincidence.
  const e = spyEngine();
  applyGameIntent(e, 'p0', { type: 'setConfig', patch: { hook: false } }, 0);
  eq(e.calls.length, 1, 'a one-key patch reaches the engine');
  same(e.calls[0], { name: 'setConfig', args: ['p0', { hook: false }] }, 'with no clock, because setConfig has no time in it');

  // A patch at exactly the key cap is allowed through — the cap is a cap, not
  // an off-by-one refusal of the last legal patch.
  const full = Object.fromEntries(Array.from({ length: MAX_PATCH_KEYS }, (_, i) => [`k${i}`, i]));
  const e2 = spyEngine();
  applyGameIntent(e2, 'p0', { type: 'setConfig', patch: full }, 0);
  eq(e2.calls.length, 1, 'a patch at exactly the key cap reaches the engine');

  // THE FIELD NAME ITSELF. Everything above would pass just as happily if the
  // dispatcher read some other key, because a junk sweep cannot tell "refused
  // because the value is junk" from "refused because the field was never
  // found" — which is exactly how a dead lobby shipped past 120k assertions.
  // A well-formed patch under the WRONG key must be refused, and the same
  // patch under the right one must not be.
  for (const wrong of ['config', 'settings', 'value', 'data']) {
    const e3 = spyEngine();
    const out = applyGameIntent(e3, 'p0', { type: 'setConfig', [wrong]: { hook: false } }, 0);
    eq(out.result.ok, false, `a patch sent as msg.${wrong} is refused`);
    eq(e3.calls.length, 0, `and never reaches the engine as msg.${wrong}`);
  }
}

// The same question asked of the other two guarded intents, so the property is
// "intents.js refuses malformed values itself" rather than two special cases.
{
  for (const bid of [undefined, null, -1, 1.5, '3', {}, [], NaN, Infinity]) {
    const e = spyEngine();
    const out = applyGameIntent(e, 'p0', { type: 'placeBid', bid }, 0);
    eq(out.result.error, 'That is not a bid.', `placeBid refuses ${show(bid)} itself`);
    eq(e.calls.length, 0, `and the engine never sees bid ${show(bid)}`);
  }
  for (const seat of [undefined, null, -1, 1.5, '0', {}, [], MAX_PLAYERS, '__proto__']) {
    const e = spyEngine();
    const out = applyGameIntent(e, 'p0', { type: 'removeSeat', seat }, 0);
    eq(out.result.error, 'That is not a seat.', `removeSeat refuses ${show(seat)} itself`);
    eq(e.calls.length, 0, `and the engine never sees seat ${show(seat)}`);
  }
}

// ===========================================================================
section('Intents: the owner gate is the engine\'s, and it is real');
// ===========================================================================

// SELF_GUARDED is a claim intents.js makes about state.js. Here it is
// exercised: for each name, drive a real engine to a state where the call
// SUCCEEDS for the owner, then make the same call from a seated non-owner and
// require a refusal that changes nothing.
//
// The final step — proving the owner's version succeeds — is what stops this
// passing vacuously. Without it a refusal for the wrong reason ("not in the
// lobby", "the round is not over") would read as the owner gate working.
{
  const lobby = () => {
    const g = new GameEngine();
    g.addPlayer('p0', 'Ana', { clientId: 'c0' });
    g.addPlayer('p1', 'Ben', { clientId: 'c1' });
    g.addPlayer('p2', 'Cleo', { clientId: 'c2' });
    return g;
  };

  const OWNER_CASES = {
    setConfig: {
      setup: lobby,
      msg: { type: 'setConfig', patch: { scoring: 'square' } },
      direct: (g, who) => g.setConfig(who, { scoring: 'square' }),
    },
    addBot: {
      setup: lobby,
      msg: { type: 'addBot', name: 'Robin' },
      direct: (g, who) => g.addBot(who, 'Robin'),
    },
    removeSeat: {
      setup: () => { const g = lobby(); g.addBot('p0', 'Robin'); return g; },
      msg: { type: 'removeSeat', seat: 3 },
      direct: (g, who) => g.removeSeat(who, 3),
    },
    startMatch: {
      setup: lobby,
      msg: { type: 'startMatch' },
      direct: (g, who) => g.startMatch(who, 0),
    },
    nextRound: {
      setup: () => playMatchUntil(
        { players: 3, config: { shape: 'descending', maxHand: 2 } },
        (s) => s.phase === PHASES.ROUND_OVER,
      ),
      msg: { type: 'nextRound' },
      direct: (g, who) => g.nextRound(who, 0),
    },
  };

  // Derived from the export, so a sixth owner intent fails here until it has a
  // case — the same discipline the module-load loop applies to the list.
  for (const name of SELF_GUARDED) {
    const c = OWNER_CASES[name];
    ok(!!c, `owner intent '${name}' has no test case`);
    if (!c) continue;

    // Through the dispatcher, from a seated non-owner.
    {
      const g = c.setup();
      eq(g._isOwner('p1'), false, `${name}: p1 is seated and is not the owner`);
      const before = JSON.stringify(g.serialize());
      const out = applyGameIntent(g, 'p1', c.msg, 0);
      ok(out.handled, `${name}: a non-owner's attempt is still a game intent`);
      eq(out.result.ok, false, `${name}: and it is refused`);
      eq(JSON.stringify(g.serialize()), before, `${name}: a refused owner action changed the state`);
    }

    // Directly on the engine, which is the enforcement point a future server
    // would reach past this file to use.
    {
      const g = c.setup();
      eq(c.direct(g, 'p1').ok, false, `${name}: the engine itself refuses a non-owner`);
      eq(c.direct(g, 'nobody-at-all').ok, false, `${name}: and refuses a stranger`);
    }

    // And the same call, from the owner, works — so the refusals above were
    // about ownership and not about the phase.
    {
      const g = c.setup();
      const out = applyGameIntent(g, 'p0', c.msg, 0);
      ok(out.handled && out.result.ok, `${name}: the owner's identical call succeeds`);
    }
  }
}

// A player intent is gated by SEAT and TURN, not by ownership — the owner has
// no special power over somebody else's cards.
{
  const g = playMatchUntil({ players: 4, shuffleSeed: 11 }, (s) => s.phase === PHASES.BIDDING);
  const turn = g.turnSeat;
  const other = (turn + 1) % 4;
  const before = JSON.stringify(g.serialize());
  const out = applyGameIntent(g, g.seats[other].id, { type: 'placeBid', bid: 0 }, 0);
  ok(out.handled, 'an out-of-turn bid is a game intent');
  eq(out.result.ok, false, 'and is refused');
  eq(JSON.stringify(g.serialize()), before, 'and changed nothing');
  // Including when it comes from the owner, who has no special power over
  // anybody else's cards. Steered rather than hoped for: ownership is handed
  // to a seat that is definitely not the one to bid, so this is asserted every
  // run rather than only on the seeds where it happened to line up.
  const notTurn = g.seats[other].id;
  ok(g.resumeAsOwner(notTurn).ok, 'ownership moved to a seat that is not to bid');
  eq(g.seatOf(notTurn) === g.turnSeat, false, 'and that seat really is not the one to bid');
  eq(applyGameIntent(g, notTurn, { type: 'placeBid', bid: 0 }, 0).result.ok, false,
    'the owner cannot bid for somebody else either');
  eq(applyGameIntent(g, 'a-stranger', { type: 'placeBid', bid: 0 }, 0).result.ok, false,
    'and neither can somebody with no seat');
  // Meanwhile the seat whose turn it actually is can still bid, so none of the
  // refusals above were the engine simply being stuck.
  eq(applyGameIntent(g, g.seats[turn].id, { type: 'placeBid', bid: 0 }, 0).result.ok, true,
    'while the seat whose bid it is can bid');
}

// ===========================================================================
section('Intents: the clock is threaded, not resolved');
// ===========================================================================

// `now` arrives as an argument and reaches the engine unchanged. Checked by
// comparing the phase stamp against the value passed in, at every intent that
// takes one.
{
  const g = playMatchUntil(
    { players: 3, config: { shape: 'descending', maxHand: 2 }, shuffleSeed: 5 },
    (s) => s.phase === PHASES.ROUND_OVER,
  );
  applyGameIntent(g, 'p0', { type: 'nextRound' }, 123456);
  eq(g.phaseAt, 123456, 'nextRound stamped the phase with the time it was given');
}
{
  const g = new GameEngine();
  ['Ana', 'Ben', 'Cleo'].forEach((n, i) => g.addPlayer(`p${i}`, n, { clientId: `c${i}` }));
  applyGameIntent(g, 'p0', { type: 'startMatch' }, 987654);
  eq(g.phaseAt, 987654, 'startMatch did too');
}

// The two player intents carry a clock as well, and theirs is easier to drop
// unnoticed because the effect is a moment rather than a value: the bid that
// completes the bidding stamps the start of play, and the card that completes
// a trick sets when that trick may be swept. A dispatcher that forgot to pass
// `now` on either would leave the stamp at zero — which is in the past, so the
// trick would vanish before anybody saw it and the match would still finish
// perfectly. Both are asserted here because neither shows up in a scoreboard.
{
  const g = playMatchUntil({ players: 4, shuffleSeed: 23 }, (s) => s.phase === PHASES.BIDDING);
  let t = 500000;
  while (g.phase === PHASES.BIDDING) {
    t += 1000;
    const seat = g.turnSeat;
    const opts = g.bidOptionsFor(seat).filter((o) => o.legal);
    applyGameIntent(g, g.seats[seat].id, { type: 'placeBid', bid: opts[0].bid }, t);
  }
  eq(g.phase, PHASES.PLAY, 'the last bid through the dispatcher opened play');
  eq(g.phaseAt, t, 'and stamped it with the time that bid arrived');

  while (g.plays.length < g.seats.length) {
    t += 1000;
    const seat = g.turnSeat;
    const legal = g.privateStateFor(g.seats[seat].id).hand.filter((c) => c.legal);
    applyGameIntent(g, g.seats[seat].id, { type: 'playCard', code: legal[0].code }, t);
  }
  // sweepAt is WHEN THE TRICK LANDED, and tick() applies the pause to it —
  // the first version of this asserted `t + TRICK_PAUSE_MS` and was simply
  // arithmetically wrong about the engine. The property worth pinning is not
  // the number anyway, it is that the trick stays on the table for a full
  // pause measured from the moment the last card arrived through the
  // dispatcher. A dropped `now` would leave this at 0 and sweep immediately.
  eq(g.sweepAt, t, 'the card that completed the trick was timed by its own arrival');
  eq(g.tick(t), false, 'a tick at that instant does not sweep');
  eq(g.tick(t + TRICK_PAUSE_MS - 1), false, 'nor one a millisecond short of the pause');
  eq(g.tick(t + TRICK_PAUSE_MS), true, 'and one a full pause later does');
}

// AND THE DEFAULT IS ZERO, NOT Date.now(). A caller that forgets gets a stamp
// the first tick() steps straight past, which is loud; a hidden Date.now()
// would work perfectly until something needed to be replayed. Proved the same
// way as the bucket: break the wall clock and see whether anything notices.
{
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('applyGameIntent read the wall clock'); };
    const g = new GameEngine();
    ['Ana', 'Ben', 'Cleo'].forEach((n, i) => g.addPlayer(`p${i}`, n, { clientId: `c${i}` }));
    let threw = false;
    try { applyGameIntent(g, 'p0', { type: 'startMatch' }); } catch (_) { threw = true; }
    ok(!threw, 'applyGameIntent never consults Date.now');
    eq(g.phaseAt, 0, 'and an omitted `now` defaults to 0');
  } finally {
    Date.now = realNow;
  }
}

// ===========================================================================
section('Intents: nothing arriving from a peer can throw');
// ===========================================================================

// Every hostile value in every argument slot of every intent, against a live
// mid-match engine, from an actor with no seat. Two properties at once: the
// dispatcher never raises, and nothing an unseated stranger sends moves the
// game by a single field.
{
  const base = playMatchUntil({ players: 4, shuffleSeed: 13 }, (s) => s.phase === PHASES.PLAY);
  const snapshot = JSON.stringify(base.serialize());
  let cases = 0;

  for (const type of [...GAME_INTENTS, 'nonsense', '__proto__']) {
    for (const field of ['bid', 'code', 'seat', 'config', 'name']) {
      for (const value of HOSTILE_VALUES) {
        cases++;
        let threw = false;
        try {
          applyGameIntent(base, 'stranger-with-no-seat', { type, [field]: value }, 1000);
        } catch (_) { threw = true; }
        ok(!threw, `{type:'${type}', ${field}:${show(value)}} threw`);
      }
    }
  }
  eq(JSON.stringify(base.serialize()), snapshot,
    `none of the ${cases} hostile messages changed the game`);
  ok(cases > 2000, `swept ${cases} hostile messages`);
}

// The same sweep from a SEATED player, where a well-formed message might
// legitimately succeed. The property here is the weaker but more important
// one: no throw, and a refusal is always accompanied by a reason.
{
  let cases = 0, refusals = 0;
  for (const type of GAME_INTENTS) {
    for (const value of HOSTILE_VALUES) {
      const g = playMatchUntil({ players: 4, shuffleSeed: 17 }, (s) => s.phase === PHASES.BIDDING);
      const actor = g.seats[g.turnSeat].id;
      cases++;
      let out, threw = false;
      try {
        out = applyGameIntent(g, actor, { type, bid: value, code: value, seat: value, config: value, name: value }, 1000);
      } catch (_) { threw = true; }
      ok(!threw, `a seated player's {type:'${type}', …:${show(value)}} threw`);
      if (threw) continue;
      if (out.handled && !out.result.ok) {
        refusals++;
        ok(typeof out.result.error === 'string' && out.result.error.length > 0,
          `a refusal of '${type}' with ${show(value)} came without a reason`);
      }
    }
  }
  ok(refusals > 200, `${refusals} of ${cases} hostile messages were refused, each with a reason`);
}

// ===========================================================================
section('Intents: a whole match, played entirely through the dispatcher');
// ===========================================================================

// THE INTEGRATION PROOF. Everything above tests the dispatcher's refusals; this
// tests that it is a faithful pass-through for the messages it accepts. Two
// matches are played from the same seeds — one by calling the engine directly,
// one by sending messages through applyGameIntent — and the resulting histories
// must be identical, round for round, bid for bid, point for point.
//
// A dispatcher that dropped a `now`, reordered an argument or swallowed a
// result would produce a different match here, and the diff would name the
// round it first went wrong in.
function playMatchViaIntents({ config, players, strategy = 'random', shuffleSeed = 1, pickerSeed = 1 }) {
  seed(shuffleSeed);
  pickSeed(pickerSeed);
  const g = new GameEngine();
  ['Ana', 'Ben', 'Cleo', 'Dev', 'Esha', 'Finn', 'Gita'].slice(0, players)
    .forEach((n, i) => g.addPlayer(`p${i}`, n, { clientId: `c${i}` }));

  const send = (actor, msg, now) => {
    const out = applyGameIntent(g, actor, msg, now);
    if (!out.handled) throw new Error(`'${msg.type}' was not handled`);
    if (!out.result.ok) throw new Error(`'${msg.type}' refused: ${out.result.error}`);
    return out.result;
  };

  send('p0', { type: 'setConfig', patch: config }, 0);
  send('p0', { type: 'startMatch' }, 0);

  const strat = typeof strategy === 'string' ? STRATEGIES[strategy] : strategy;
  let t = 0, guard = 0;
  while (g.phase !== PHASES.MATCH_OVER) {
    if (guard++ > 60000) throw new Error('match did not finish through the dispatcher');
    t += TRICK_PAUSE_MS + 1;
    if (g.phase === PHASES.BIDDING) {
      const seat = g.turnSeat;
      const opts = g.bidOptionsFor(seat).filter((o) => o.legal);
      send(g.seats[seat].id, { type: 'placeBid', bid: strat.bid(opts, g, seat) }, t);
    } else if (g.phase === PHASES.PLAY && g.sweepAt === null) {
      const seat = g.turnSeat;
      const priv = g.privateStateFor(g.seats[seat].id);
      const legal = priv.hand.filter((c) => c.legal);
      send(g.seats[seat].id, { type: 'playCard', code: strat.card(legal, g, seat) }, t);
    } else if (g.phase === PHASES.ROUND_OVER) {
      send('p0', { type: 'nextRound' }, t);
    } else {
      // tick() is deliberately not an intent — the host drives the clock, and
      // this driver is standing in for the host's animation frame.
      g.tick(t);
    }
  }
  return g;
}

for (const preset of PRESETS) {
  for (const players of [3, 5, 7]) {
    const tag = `${preset.id} at ${players}`;
    const opts = { config: preset.config, players, strategy: 'random', shuffleSeed: players + 40, pickerSeed: 7 };
    const direct = playMatch(opts);
    const viaWire = playMatchViaIntents(opts);

    eq(viaWire.phase, PHASES.MATCH_OVER, `${tag}: the match finished through the dispatcher`);
    same(viaWire.history, direct.history, `${tag}: identical round-by-round history`);
    same(viaWire.totals, direct.totals, `${tag}: identical final totals`);
    same(viaWire.leaders(), direct.leaders(), `${tag}: and the same winner`);
    // Not a trivially empty comparison: a real match with real rounds in it.
    ok(direct.history.length >= 3, `${tag}: over ${direct.history.length} rounds`);
  }
}

// ===========================================================================
section('The server seam, blank on purpose');
// ===========================================================================

eq(SERVER_URL, '', 'SERVER_URL is blank in v1');
eq(SERVER_HEALTH, '', 'SERVER_HEALTH is blank in v1');
eq(serverConfigured(), false, 'so serverConfigured() is false, which is the shipping answer');

// THE BRIEF'S HARD-WON NUMBER, PINNED. A cold TLS handshake measured ~4.6s
// against 0.8–1.2s warm, so a four-second budget failed the first request of
// every session and succeeded on every one after it. This assertion exists so
// that tightening the budget is a failing test with an explanation attached
// rather than a plausible-looking one-line change.
ok(SERVER_TIMEOUT_MS >= 10000, `the network budget is ${SERVER_TIMEOUT_MS}ms — never tighten below 10000`);
ok(SERVER_RETRIES >= 1, 'and nothing is declared dead without at least one retry');

// ###########################################################################
//
//  6. THE BOT
//
//  The engine sections above asked "does the rule hold". This one asks a
//  harder question — "is the player any good" — and the answer has to be a
//  property too, because a table of expected cards would pin the bot's current
//  taste rather than its correctness.
//
//  THE HEADLINE REQUIREMENT IS NOT THAT IT PLAYS WELL. It is that it
//  SOMETIMES TRIES TO LOSE. Judgement scores exactly the bid: once a seat has
//  taken what it bid, every further trick is a disaster. A bot lifted from the
//  sibling courtpiece repo — where more tricks is always better — would play
//  a technically flawless game and wreck every round it was winning. That is
//  the bug this section exists to catch, and it is asserted directly: given a
//  real position where the seat is at or over its bid and a legal card exists
//  that does not win, the bot must choose one of those.
//
//  The second requirement is that the SCORING MODE IS A PARAMETER. bot.js has
//  no table of "bid this with that hand" — it builds a distribution over trick
//  counts and asks scoring.js what each candidate bid is worth against it. So
//  the test is not "does it bid 3 here"; it is that swapping the mode under a
//  FIXED hand moves the bid in the direction the formulas imply.
//
// ###########################################################################

// ===========================================================================
section('Bot — driving a table where every seat is botted');
// ===========================================================================

/**
 * Play a whole match with every seat, owner included, driven by chooseIntent.
 *
 * Deliberately routed through applyGameIntent rather than calling the engine
 * methods directly: that is the path a real peer's move takes, so a bot that
 * produced a well-formed-looking intent the dispatcher rejects shows up here
 * as a refusal instead of silently working in the test and failing in the app.
 *
 * `watch` is called before every intent with the acting seat's public and
 * private view, which is how the play properties below get hold of thousands
 * of real mid-trick positions without scripting a single one.
 *
 * `onRound` is called at ROUND_OVER, before the round is advanced, and exists
 * because `watch` cannot see how a trick TURNED OUT. It fires while the
 * engine still holds the round's completed tricks — winners and all — which is
 * the only moment the last trick of a round is visible at all, no intent being
 * asked for after it.
 */
function playBotMatch({
  config = {}, players = 4, shuffleSeed = 1, watch = null, onRound = null,
} = {}) {
  seed(shuffleSeed);
  const g = new GameEngine();
  g.addPlayer('owner', 'Owner', { isOwner: true, clientId: 'cowner' });
  for (let i = 1; i < players; i++) g.addBot('owner');
  g.setConfig('owner', config);
  const started = g.startMatch('owner', 0);
  if (!started.ok) throw new Error(`startMatch refused: ${started.error}`);

  const refusals = [];
  let now = 0;
  let guard = 0;
  while (g.phase !== PHASES.MATCH_OVER) {
    // The brief's rule, honoured by the test as well as the engine: time is a
    // parameter. Nothing here sleeps; the clock is just a number going up.
    if (++guard > 200000) throw new Error(`bot match wedged in ${g.phase}`);
    now += 100;
    if (g.tick(now)) continue;
    // nextRound is owner-gated and the owner seat is a human record, so an
    // all-bot table needs its rounds advanced from outside. bot.js declines to
    // do this on purpose — see the note on createBotDriver.
    if (g.phase === PHASES.ROUND_OVER) {
      if (onRound) onRound(g.publicState(), g);
      g.nextRound('owner', now);
      continue;
    }

    const seat = g.seats[g.turnSeat];
    const pub = g.publicState();
    const priv = g.privateStateFor(seat.id);
    const intent = chooseIntent(pub, priv);
    if (!intent) continue;
    if (watch) watch(pub, priv, intent, g);
    const { result } = applyGameIntent(g, seat.id, intent, now);
    if (!result.ok) refusals.push(`${g.phase}/${intent.type}: ${result.error}`);
  }
  return { g, refusals };
}

// The three presets end to end, which is the coverage strategy the brief sets
// out: four independent axes are 54 combinations and testing all of them is
// explicitly not the plan. Each axis is already swept in isolation in section
// 3; here the job is whole matches under each named way people actually play.
/** One hand off a fresh shuffle. deal() returns { hands, turnUpCard, stock }
 *  and holds the turn-up back deliberately; the bid properties below only ever
 *  want a single hand, so the unwrapping lives here once. */
function oneHand(players, handSize) {
  return deal(shuffle(buildDeck()), { players, handSize, dealerSeat: 0 }).hands[0];
}

const BOT_CONFIGS = [
  ['kachuful/rotation/downup', { scoring: 'kachuful', trumpMethod: 'rotation', shape: 'downup', hook: true, maxHand: 5 }],
  ['standard/turnup/descending', { scoring: 'standard', trumpMethod: 'turnup', shape: 'descending', hook: true, maxHand: 5 }],
  ['square/rotation-nt/ascending', { scoring: 'square', trumpMethod: 'rotation-nt', shape: 'ascending', hook: false, maxHand: 5 }],
];

// THE DEFINITION OF DONE FOR THIS CHECKPOINT, stated as one loop: thousands
// of complete matches, every scoring mode, every legal player count, zero
// illegal plays and zero illegal bids.
//
// "Zero illegal" is not checked by re-deriving legality here — that would just
// be bot.js's own reasoning written twice, and a shared mistake would pass
// both times. It is checked by ASKING THE ENGINE: every move goes through
// applyGameIntent, and a refusal is a failure. The engine is the authority on
// legality in the app for exactly the same reason.
{
  let matches = 0; let rounds = 0; let plays = 0;
  const refusals = [];
  const scoreMismatch = [];
  for (const [tag, config] of BOT_CONFIGS) {
    for (const players of [3, 4, 5, 6, 7]) {
      for (let s = 0; s < 40; s++) {
        const { g, refusals: bad } = playBotMatch({ config, players, shuffleSeed: 7000 + s * 31 });
        matches += 1;
        for (const r of bad) refusals.push(`${tag} ${players}p seed${s}: ${r}`);
        eq(g.phase, PHASES.MATCH_OVER, `${tag} ${players}p seed${s}: match reached MATCH_OVER`);
        for (const h of g.history) {
          rounds += 1;
          plays += h.roundSize * players;
          for (let i = 0; i < h.bids.length; i++) {
            // Every score the engine wrote is the score scoring.js computes.
            // Cross-checked here rather than only in section 2 because the bot
            // is now CHOOSING bids by asking scoreRound what they are worth: if
            // the two ever disagreed, the bot would be optimising a formula the
            // game does not use, and every other number in this section would
            // still look fine.
            const want = scoreRound(config.scoring, h.bids[i], h.tricks[i], h.roundSize);
            if (want !== h.deltas[i]) scoreMismatch.push(`${tag}: ${want} vs ${h.deltas[i]}`);
          }
        }
      }
    }
  }
  same(refusals.slice(0, 5), [], `zero illegal moves across ${matches} all-bot matches`);
  same(scoreMismatch.slice(0, 5), [], 'every round scored exactly as scoring.js says');
  ok(matches >= 600, `${matches} complete matches, ${rounds} rounds, ${plays} cards played`);
  // Not a vacuous soak: assert it actually reached the long rounds and the
  // wide tables, so a config bug that quietly ended every match after one
  // round cannot pass this by playing six hundred trivial games.
  ok(rounds / matches >= 4, `averaging ${(rounds / matches).toFixed(1)} rounds per match`);
}

// ===========================================================================
section('Bot — the trick estimate is calibrated against an identity');
// ===========================================================================

// EVERY TRICK IS TAKEN BY EXACTLY ONE OF THE `players` CARDS PLAYED TO IT.
// That is not a modelling assumption, it is arithmetic, and it pins the mean:
// averaged over hands, the per-card chance of winning must be 1/players, so a
// hand's chances must sum to roundSize/players.
//
// This property is the reason the estimate is any good. The first version of
// trickChances answered "is this card the outright boss of its suit", which is
// strictly stronger than "does this card win a trick"; measured, it ran 1.8x
// HIGH in a one-card round and 0.69x LOW at six players with five cards. The
// two errors cancelled in the overall average, so a test of the overall
// average would have passed. This one is per cell, which is why it bites.
{
  const worst = { ratio: 1, tag: '' };
  for (const players of [3, 4, 5, 6, 7]) {
    for (const roundSize of [1, 2, 3, 5, 7]) {
      if (roundSize > maxHandSize(players)) continue;
      for (const trump of ['S', NO_TRUMP]) {
        seed(players * 1000 + roundSize * 10 + (trump === NO_TRUMP ? 1 : 0));
        // SAMPLE SIZE SCALED TO THE VARIANCE, not fixed. A one-card round is
        // nearly a coin flip on whether you were dealt an ace — the per-hand
        // figure is either about 1.0 or about 0.07 and almost nothing between
        // — so two hundred deals leave a standard error wide enough to fail a
        // correctly calibrated bot roughly one seed in twenty. A flaky test
        // that is right on average is worse than no test, because the first
        // thing anyone does with it is widen the band until it stops
        // complaining, and then it never catches anything again.
        const N = Math.min(1200, Math.max(200, Math.round(1200 / roundSize)));
        let sum = 0; let sumsq = 0;
        for (let i = 0; i < N; i++) {
          const chances = trickChances(oneHand(players, roundSize), {
            scoring: 'standard', roundSize, players, trump, isDealer: false, hook: false,
          });
          eq(chances.length, roundSize, `one chance per card (${players}p size ${roundSize})`);
          ok(chances.every((p) => p >= 0 && p <= 1), 'every chance is a probability');
          const t = chances.reduce((a, b) => a + b, 0);
          sum += t; sumsq += t * t;
        }
        const mean = sum / N;
        const se = Math.sqrt(Math.max(0, sumsq / N - mean * mean) / N);
        const target = roundSize / players;
        const ratio = mean / target;
        const tag = `${players}p size ${roundSize} ${trump === NO_TRUMP ? 'NT' : 'trump'}`;
        // A generous band. The claim being tested is that the estimate is in
        // the right UNITS, not that it is exact — the residual is the ruff
        // credit, which is a real shape effect the identity is blind to. The
        // standard error is reported so that a future failure can be told
        // apart from noise without re-deriving it.
        ok(ratio > 0.8 && ratio < 1.25,
          `${tag}: predicted ${mean.toFixed(3)} +/- ${se.toFixed(3)} against ${target.toFixed(3)} `
          + `(x${ratio.toFixed(2)}, n=${N})`);
        // And the band must actually be tighter than the noise, or it is not
        // testing anything. If this ever fires, raise N rather than the band.
        ok(0.2 * target > 2 * se,
          `${tag}: the +/-25% band is ${(0.2 * target / Math.max(se, 1e-12)).toFixed(1)} standard errors wide`);
        if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(worst.ratio))) { worst.ratio = ratio; worst.tag = tag; }
      }
    }
  }
  console.log(`  worst calibration cell: ${worst.tag} at x${worst.ratio.toFixed(2)}`);
}

// A strictly better hand cannot be worth fewer tricks. Monotonicity is the
// property that survives every retuning of the constants, so it is the one
// worth asserting: swap any card for the ace of its suit and the total must
// not go down.
{
  seed(4242);
  for (let i = 0; i < 300; i++) {
    const hand = oneHand(4, 5);
    const ctx = { scoring: 'standard', roundSize: 5, players: 4, trump: 'S' };
    const before = trickChances(hand, ctx).reduce((a, b) => a + b, 0);
    const j = i % hand.length;
    const ace = `A${suitOf(hand[j])}`;
    if (hand.includes(ace)) continue;
    const up = hand.slice(); up[j] = ace;
    const after = trickChances(up, ctx).reduce((a, b) => a + b, 0);
    ok(after >= before - 1e-9,
      `promoting ${hand[j]} to ${ace} cannot lower the estimate (${before.toFixed(3)} -> ${after.toFixed(3)})`);
  }
}

// ===========================================================================
section('Bot — the trick distribution');
// ===========================================================================

// trickDistribution turns per-card chances into P(exactly n tricks). Its
// properties are the ones any distribution has, and they are worth asserting
// separately because bidValue integrates against it: a distribution that did
// not sum to one would quietly rescale every expected value, and every bid
// would still look plausible.
{
  seed(99);
  for (let i = 0; i < 200; i++) {
    const n = 1 + rnd(8);
    const chances = Array.from({ length: n }, () => rnd(1001) / 1000);
    const dist = trickDistribution(chances);
    eq(dist.length, n + 1, 'a hand of n cards can take 0..n tricks');
    ok(dist.every((p) => p >= -1e-12 && p <= 1 + 1e-12), 'every entry is a probability');
    const total = dist.reduce((a, b) => a + b, 0);
    ok(Math.abs(total - 1) < 1e-9, `the distribution sums to one, got ${total}`);
    // The mean of the Poisson binomial is the sum of the chances. This is the
    // link between the two halves of the bidder, and if it broke, the estimate
    // could be perfectly calibrated and the bids still wrong.
    const mean = dist.reduce((a, p, k) => a + p * k, 0);
    const want = chances.reduce((a, b) => a + b, 0);
    ok(Math.abs(mean - want) < 1e-9, `mean ${mean.toFixed(6)} equals the sum of chances ${want.toFixed(6)}`);
  }
  // The degenerate ends, which is where an off-by-one in the dynamic program
  // shows up and nowhere else.
  same(trickDistribution([]), [1], 'no cards means certainly zero tricks');
  same(trickDistribution([1, 1, 1]), [0, 0, 0, 1], 'three certainties means certainly three');
  same(trickDistribution([0, 0]), [1, 0, 0], 'two hopeless cards means certainly none');
}

// ===========================================================================
section('Bot — the scoring mode is a parameter, not three strategies');
// ===========================================================================

// THE CENTRAL CLAIM OF bot.js. It holds no table of "bid this with that
// hand". It builds a distribution and asks scoring.js what each candidate bid
// is worth against it, so a fourth scoring mode would need no change to the
// bidder at all.
//
// That claim cannot be tested by pinning bids. It is tested by fixing
// everything except the mode and checking the bid moves the way the FORMULAS
// imply — which is a statement about scoring.js reaching bot.js, and is false
// for any hardcoded strategy that happens to agree on one hand.
{
  // bidValue is a plain expectation, so it can be checked against a hand
  // computation with no reference to what the bot would choose.
  const dist = trickDistribution([0.5, 0.5]);
  for (const mode of SCORING_MODES) {
    let want = 0;
    for (let a = 0; a < dist.length; a++) want += dist[a] * scoreRound(mode, 1, a, 2);
    ok(Math.abs(bidValue(1, dist, { scoring: mode, roundSize: 2 }) - want) < 1e-12,
      `${mode}: bidValue is the expectation of scoreRound over the distribution`);
  }

  seed(31337);
  let kachufulHigher = 0; let squareLower = 0; let compared = 0;
  const zeroRate = Object.create(null);
  for (const mode of SCORING_MODES) zeroRate[mode] = 0;

  for (let i = 0; i < 400; i++) {
    const hand = oneHand(4, 7);
    const base = { roundSize: 7, players: 4, trump: 'S', isDealer: false, hook: false };
    const bids = Object.create(null);
    for (const mode of SCORING_MODES) {
      bids[mode] = chooseBid(hand, { ...base, scoring: mode });
      ok(Number.isInteger(bids[mode]) && bids[mode] >= 0 && bids[mode] <= 7,
        `${mode}: bid ${bids[mode]} is an integer in range`);
      if (bids[mode] === 0) zeroRate[mode] += 1;
    }
    compared += 1;
    // Kachuful pays 10 x bid with no penalty for missing, so reaching for one
    // more is free upside. Square pays 10 + bid squared but PENALISES a miss,
    // so the same hand is worth bidding down. Neither is an always — a hand
    // with an obvious count agrees under every mode — so the assertion is on
    // the aggregate direction, not on any single hand.
    if (bids.kachuful > bids.square) kachufulHigher += 1;
    if (bids.square < bids.standard) squareLower += 1;
  }
  ok(kachufulHigher > compared * 0.1,
    `kachuful out-bids square on ${kachufulHigher}/${compared} hands`);
  ok(bids0Never(zeroRate) === false, 'the zero bid is reachable');
  // And kachuful's zero bid, which is the brief's own worked example: it pays
  // 5 x round size, so in a big round it beats several successful small bids
  // and the bot must find that on its own, from the formula, with no special
  // case anywhere in bot.js.
  ok(zeroRate.kachuful >= zeroRate.square,
    `kachuful bids zero at least as often as square (${zeroRate.kachuful} vs ${zeroRate.square} of ${compared})`);
  console.log(`  zero bids per 400 hands: ${SCORING_MODES.map((m) => `${m} ${zeroRate[m]}`).join(', ')}`);
}

// Helper kept next to its only use: a mode that never bid zero at all would
// make the comparison above vacuously true.
function bids0Never(rates) { return Object.values(rates).every((n) => n === 0); }

// The brief's worked example, tested as the arithmetic it is rather than as a
// preference: under kachuful in a ten-card round, a zero bid is worth 50 and a
// successful bid of four is worth 40. So a hand that is MORE likely to take
// nothing than to take four must prefer zero — and the bot is not told this,
// it derives it.
{
  eq(scoreRound('kachuful', 0, 0, 10), 50, 'kachuful zero in a ten-card round pays 5 x 10');
  eq(scoreRound('kachuful', 4, 4, 10), 40, 'and a made bid of four pays only 40');
  const dist = trickDistribution(Array.from({ length: 10 }, () => 0.12));
  const zero = bidValue(0, dist, { scoring: 'kachuful', roundSize: 10 });
  const four = bidValue(4, dist, { scoring: 'kachuful', roundSize: 10 });
  ok(zero > four, `so on a weak ten-card hand zero (${zero.toFixed(1)}) beats four (${four.toFixed(1)})`);
}

// ===========================================================================
section('Bot — the hook, from the dealer\'s chair');
// ===========================================================================

// The dealer under the hook may not bid the number that would make the bids
// add up to the round size. bot.js does not check this — it never sees the
// forbidden bid, because the only candidates it ranks are the ones the engine
// offered in bidOptions. Same discipline as card legality: the engine is the
// authority and the bot is a chooser over what the engine allows.
//
// That is a stronger design than a check, and this test is what makes it a
// claim rather than a hope: force the dealer's chair thousands of times and
// assert the engine never refuses.
{
  let dealerBids = 0; let forbiddenAvoided = 0;
  for (const scoring of SCORING_MODES) {
    for (const players of [3, 4, 5, 6]) {
      for (let s = 0; s < 12; s++) {
        playBotMatch({
          config: { scoring, trumpMethod: 'rotation', shape: 'downup', hook: true, maxHand: 5 },
          players,
          shuffleSeed: 900 + s,
          watch: (pub, priv, intent) => {
            if (intent.type !== 'placeBid' || !priv.isDealer) return;
            dealerBids += 1;
            // Cross-checked against rules.js rather than trusted from the
            // private view, so a bug that computed `forbidden` wrongly in the
            // engine could not make this test agree with it.
            const placed = pub.seats.map((s) => s.bid).filter((b) => b !== null && b !== undefined);
            const banned = forbiddenBid(placed, pub.roundSize);
            eq(priv.forbidden, banned, 'the private view agrees with rules.js about the forbidden bid');
            if (banned === null) return;
            forbiddenAvoided += 1;
            ok(intent.bid !== banned,
              `dealer under the hook avoided the forbidden ${banned} (bid ${intent.bid})`);
            // And the engine never even offered it, which is the mechanism —
            // bot.js has no hook logic of its own, it just cannot see the
            // forbidden number.
            ok(!priv.bidOptions.some((o) => o.bid === banned && o.legal),
              `and bidOptions never marked ${banned} legal`);
          },
        });
      }
    }
  }
  // Guard against the assertion above being vacuous: if the dealer were never
  // actually hooked, every one of those passes would be free.
  ok(forbiddenAvoided > 200,
    `the hook actually bound on ${forbiddenAvoided} of ${dealerBids} dealer bids`);
}

// ===========================================================================
section('Bot — appetite, the branch the whole of play hangs off');
// ===========================================================================

// Three words, and getting any of them wrong breaks the game quietly.
//   duck  the bid is already met — every further trick is a loss
//   must  every remaining trick is needed — nothing may be given away
//   want  more are needed but there is slack
{
  for (let need = -3; need <= 6; need++) {
    for (let left = 0; left <= 6; left++) {
      const a = appetite(need, left);
      ok(['duck', 'want', 'must'].includes(a), `appetite(${need},${left}) is one of the three`);
      if (need <= 0) eq(a, 'duck', `at or over bid (need ${need}) means duck`);
      else if (need >= left) eq(a, 'must', `needing ${need} of ${left} remaining means must`);
      else eq(a, 'want', `needing ${need} of ${left} remaining means want`);
    }
  }
  // The boundaries, spelled out, because these are the off-by-ones that matter.
  eq(appetite(0, 5), 'duck', 'exactly at the bid is already duck, not want');
  eq(appetite(1, 1), 'must', 'one needed with one to play is must');
  eq(appetite(2, 1), 'must', 'needing more than remain is still must, never NaN');
  eq(appetite(1, 5), 'want', 'one needed with five to play has slack');
  // A seat that has OVERSHOT ducks just as hard as one that is exactly there.
  // There is nothing to be gained back, and a bot that treated "over" as a
  // reason to give up and play normally would keep piling on the damage.
  eq(appetite(-2, 4), 'duck', 'already over the bid ducks too');
}

// ===========================================================================
section('Bot — IT MUST SOMETIMES TRY TO LOSE');
// ===========================================================================

// ###########################################################################
// #                                                                         #
// #  THE ONE PROPERTY THIS WHOLE CHECKPOINT EXISTS FOR.                     #
// #                                                                         #
// #  Judgement scores EXACTLY the bid. Once a seat has taken what it bid,   #
// #  every further trick is a disaster. The sibling repo courtpiece scores  #
// #  more-is-better, its bot always plays to win, and a bot ported from it  #
// #  would be worthless here while looking entirely competent.              #
// #                                                                         #
// #  So: over thousands of real positions drawn from real matches, whenever #
// #  the acting seat is at or over its bid AND a legal card exists that     #
// #  would not win the trick, the card it chooses must not win.             #
// #                                                                         #
// #  Note what this does NOT assert — which card. "Duck" is not "play your  #
// #  lowest": the right duck is the HIGHEST card that still loses, because  #
// #  throwing a winner away cheaply is how you get stuck winning later      #
// #  tricks you cannot avoid. Pinning the card would pin the taste. This    #
// #  pins the rule.                                                         #
// #                                                                         #
// ###########################################################################
{
  let ducked = 0; let forced = 0; let grabbed = 0; let mustSeen = 0;
  const failures = [];

  for (const [tag, config] of BOT_CONFIGS) {
    for (const players of [3, 4, 6]) {
      for (let s = 0; s < 25; s++) {
        playBotMatch({
          config,
          players,
          shuffleSeed: 5500 + s * 17,
          watch: (pub, priv, intent) => {
            if (intent.type !== 'playCard') return;
            // The engine already marked each card legal or not, and that
            // marking is the authority — recomputing it here with canPlay
            // would only prove the test and the bot share a mistake. It is
            // cross-checked against trick.js once, below, and then trusted.
            const legal = priv.hand.filter((c) => c.legal).map((c) => c.code);
            if (!legal.length) return;
            const held = priv.hand.map((c) => c.code);
            const led = ledSuitOf(pub.plays);
            for (const c of priv.hand) {
              eq(c.legal, canPlay(held, c.code, led),
                `the engine and trick.js agree that ${c.code} is${c.legal ? '' : ' not'} playable`);
            }
            const takes = (code) => wouldWin(pub.plays, priv.seat, code, pub.trump);
            const winners = legal.filter(takes);
            const losers = legal.filter((code) => !takes(code));
            const need = priv.bid - priv.tricks;
            const left = pub.roundSize - pub.trickIndex;
            const mood = appetite(need, left);
            const chosenWins = takes(intent.code);

            if (mood === 'duck') {
              if (losers.length) {
                ducked += 1;
                if (chosenWins) {
                  failures.push(`${tag} ${players}p: at ${priv.tricks}/${priv.bid} played the winning `
                    + `${intent.code} with ${losers.join(',')} available to duck with`);
                }
              } else {
                // Every legal card wins. This is the position the bot cannot
                // escape, and counting it separately is what stops a bot that
                // never ducks from hiding behind "it had no choice".
                forced += 1;
              }
            }

            if (mood === 'must' && winners.length) {
              mustSeen += 1;
              if (chosenWins) grabbed += 1;
              else {
                failures.push(`${tag} ${players}p: needing every trick (${need} of ${left}) played the `
                  + `losing ${intent.code} with ${winners.join(',')} available to win with`);
              }
            }
          },
        });
      }
    }
  }

  same(failures.slice(0, 6), [], 'no position where the bot took a trick it was trying to avoid');
  // These counters are the anti-vacuity guard, and they are the number worth
  // reading: a bot that simply never reached its bid would pass the assertion
  // above with zero observations.
  ok(ducked > 2000, `${ducked} positions where it was at or over bid and could duck — and did`);
  ok(mustSeen > 500, `${mustSeen} positions where it needed every remaining trick`);
  eq(grabbed, mustSeen, 'and it took the trick in every one of them');
  console.log(`  ducked ${ducked}, unavoidable ${forced}, must-win ${grabbed}/${mustSeen}`);
}

// ===========================================================================
section('Bot — ducking ON LEAD, which the property above cannot see');
// ===========================================================================

// THE PROPERTY ABOVE HAS A HOLE, AND A MUTATION RUN FOUND IT.
//
// wouldWin([], seat, code, trump) is TRUE for every card: on an empty trick
// whatever you lead is, for the moment, winning it. So in the test above the
// `losers` list is empty at every single lead, every ducking lead is filed
// under "unavoidable", and nothing whatever is asserted about it. Replacing
// lead()'s duck branch with its exact opposite — lead the card MOST likely to
// win — left that test perfectly green.
//
// That is the worst possible place to have a hole, because bot.js calls
// ducking on lead "the hardest thing in this game and the thing a
// more-is-better bot cannot do at all". So it needs a property of its own.
//
// It cannot be a property about WHICH card, for the same reason as above:
// the right duck is not the lowest card, and pinning it would pin the taste.
// So this is a property about the OUTCOME. A seat that is ducking leads in
// order to lose the trick; a seat that is chasing leads in order to win it.
// Those two intentions have to show up in how often the lead actually wins,
// and no amount of retuning can make them stop differing without the bot
// having stopped ducking.
{
  const byMood = {
    duck: { n: 0, won: 0 }, want: { n: 0, won: 0 }, must: { n: 0, won: 0 },
  };
  for (const [, config] of BOT_CONFIGS) {
    for (const players of [3, 4, 6]) {
      for (let s = 0; s < 25; s++) {
        // Leads recorded as they are made, resolved at the end of the round
        // when the winners are known.
        let pending = [];
        playBotMatch({
          config,
          players,
          shuffleSeed: 5500 + s * 17,
          watch: (pub, priv, intent) => {
            if (intent.type !== 'playCard' || pub.plays.length !== 0) return;
            // A forced single card says nothing about intent.
            if (priv.hand.filter((c) => c.legal).length < 2) return;
            pending.push({
              trick: pub.trickIndex,
              seat: priv.seat,
              mood: appetite(priv.bid - priv.tricks, pub.roundSize - pub.trickIndex),
            });
          },
          onRound: (pub) => {
            for (const o of pending) {
              const t = pub.tricks[o.trick];
              if (!t) continue;
              byMood[o.mood].n += 1;
              if (t.winner === o.seat) byMood[o.mood].won += 1;
            }
            pending = [];
          },
        });
      }
    }
  }

  const rate = (m) => byMood[m].won / Math.max(1, byMood[m].n);
  // Anti-vacuity first: a bot that never led while ducking would pass any
  // comparison below for free.
  ok(byMood.duck.n > 500, `${byMood.duck.n} leads made while at or over the bid`);
  ok(byMood.want.n > 500, `${byMood.want.n} leads made while still chasing tricks`);
  // The property. Stated as a ratio rather than a threshold on either rate,
  // because the rates themselves move with every change to the estimate and a
  // threshold would have to be re-tuned; the ORDERING is what the appetite
  // claim actually asserts. The factor of two is a wide margin around a gap
  // measured at 0.13 against 0.45 — more than three to one.
  ok(rate('duck') * 2 < rate('want'),
    `a ducking lead wins ${(100 * rate('duck')).toFixed(1)}% of its tricks against `
    + `${(100 * rate('want')).toFixed(1)}% for a chasing lead — less than half as often`);
  console.log(`  lead outcomes: ${['duck', 'want', 'must']
    .map((m) => `${m} ${byMood[m].won}/${byMood[m].n}`).join(', ')}`);
}

// ===========================================================================
section('Bot — No Trump is a distinct path, not trump-with-a-null');
// ===========================================================================

// The brief calls this out as its own code path in BOTH the engine and the
// bot, and section 1 already proved the engine's half. This is the bot's.
//
// In a No Trump round the highest card of the suit led always wins, and a void
// means you simply cannot win the trick. Two consequences, and they are
// OPPOSITE to the trump round, which is why collapsing the paths is not a
// small inefficiency but a wrong answer:
//   * a void is worthless, where under trumps it is a ruffing chance
//   * length is worth more, because a long suit keeps getting led back
{
  const ctx = (trump) => ({ scoring: 'standard', roundSize: 5, players: 4, trump });

  // A hand with a void and four small trumps. Under spades those spades have
  // real ruffing value; at No Trump they are just small cards.
  const shapely = ['2S', '3S', '4S', '5S', '6H'];
  const withTrump = trickChances(shapely, ctx('S')).reduce((a, b) => a + b, 0);
  const noTrump = trickChances(shapely, ctx(NO_TRUMP)).reduce((a, b) => a + b, 0);
  ok(withTrump > noTrump,
    `four small spades and a near-void are worth more with spades trump (${withTrump.toFixed(2)}) `
    + `than at No Trump (${noTrump.toFixed(2)})`);

  // And from the other end: a top card in a side suit is SAFER at No Trump,
  // because nothing can ruff it away.
  const aces = ['AH', 'KH', '7C', '8C', '9D'];
  const ntTop = trickChances(aces, ctx(NO_TRUMP))[0];
  const ruffedTop = trickChances(aces, ctx('S'))[0];
  ok(ntTop > ruffedTop,
    `the ace of hearts is safer at No Trump (${ntTop.toFixed(3)}) than with spades out (${ruffedTop.toFixed(3)})`);

  // null and NO_TRUMP must reach the same arithmetic — isTrumpSuit() is the
  // one place that decision gets made, and the bot must not keep a copy.
  same(trickChances(aces, ctx(NO_TRUMP)), trickChances(aces, ctx(null)),
    'a null trump and NO_TRUMP give the bidder identical numbers');
  // But they are NOT the same thing, and conflating them is the sibling repo's
  // bug. Restated here, next to the bot's use of it.
  eq(isTrumpSuit(NO_TRUMP), false, 'NO_TRUMP is not a suit');
  eq(isTrumpSuit(null), false, 'and neither is "not yet turned"');
  ok(NO_TRUMP !== null, 'yet the two values stay distinct, and the engine tells them apart');

  // Whole matches under rotation-nt, which puts real No Trump rounds in front
  // of the bot rather than a synthesised context.
  let ntRounds = 0;
  for (const players of [3, 4, 6]) {
    const { g, refusals } = playBotMatch({
      config: { scoring: 'square', trumpMethod: 'rotation-nt', shape: 'downup', hook: false, maxHand: 5 },
      players,
      shuffleSeed: 31 + players,
    });
    same(refusals.slice(0, 3), [], `${players}p rotation-nt: no refusals`);
    for (const h of g.history) if (!isTrumpSuit(h.trump)) ntRounds += 1;
  }
  ok(ntRounds > 0, `${ntRounds} genuine No Trump rounds played to the end`);
}

/**
 * The smallest pub/priv pair chooseCard will read.
 *
 * Everything the bot needs is in these two objects and nothing else — which is
 * what being pure buys, and is what makes a position like this constructible
 * at all without a table, a socket or a clock. The soak gives thousands of
 * positions nobody chose; this gives one position chosen very carefully, which
 * is the only way to test a claim about a SINGLE branch.
 */
function botPosition({
  hand, trump, players = 4, roundSize = 5, trickIndex = 0,
  tricksDone = [], bid = 2, taken = 0, seat = 0,
}) {
  const others = roundSize - trickIndex;
  return [{
    seats: Array.from({ length: players }, (_, i) => ({
      seat: i, handCount: i === seat ? hand.length : others, bid,
    })),
    plays: [],
    tricks: tricksDone,
    turnUpCard: null,
    trump,
    roundSize,
    trickIndex,
    config: { scoring: 'standard' },
  }, {
    seat, isTurn: true, bid, tricks: taken, bidOptions: null,
    hand: hand.map((code) => ({ code, legal: true })),
  }];
}

// THE PLAY SIDE OF NO TRUMP, WHICH THE BIDDING TESTS ABOVE DO NOT TOUCH.
//
// Another hole a mutation found: everything above tests trickChances, so
// replacing lead()'s No Trump plan with a copy of the trump plan left the
// whole suite green. The brief asks for No Trump to be "a distinct code path
// in both the engine and the bot", and a copied plan is exactly the failure
// it is warning about.
//
// The two plans are OPPOSITES, which is what makes this testable without
// pinning taste:
//   with a trump  lead low from the SHORTEST side suit, playing for a void so
//                 the trumps start taking tricks they otherwise could not
//   at No Trump   lead low from the LONGEST suit, because a void wins nothing
//                 when there is nothing to ruff with and length is what
//                 eventually makes small cards good
// Same hand, same seat, same everything but the trump — and the answers must
// come from different suits, the short one and the long one respectively.
{
  // Four hearts and a singleton club. No trumps held, so the draw-trumps
  // branch cannot fire, and nothing is remotely boss, so the cash branch
  // cannot either. That leaves exactly the branch under test.
  const shapely = ['2H', '3H', '4H', '5H', '9C'];
  const withTrump = chooseCard(...botPosition({ hand: shapely, trump: 'S' }));
  const noTrump = chooseCard(...botPosition({ hand: shapely, trump: NO_TRUMP }));

  eq(suitOf(withTrump.code), 'C',
    'with spades trump it leads its SHORTEST side suit, playing for the void');
  eq(suitOf(noTrump.code), 'H',
    'at No Trump it leads its LONGEST suit instead, because a void wins nothing there');
  ok(withTrump.code !== noTrump.code,
    `and so the same hand leads differently: ${withTrump.code} with a trump, ${noTrump.code} without`);
}

// ===========================================================================
section('Bot — what it remembers, and where the memory comes from');
// ===========================================================================

// bot.js holds NO state between calls. "What has gone" is rebuilt from
// pub.tricks at every single decision, which is why it can never drift out of
// step with the real game and why a bot covering a seat after a host reload
// knows exactly what the seat's previous occupant knew.
//
// That is a strong claim and it was completely untested: emptying `done` in
// readTable — so the bot forgets every completed trick — left the suite green.
// pub.tricks was added to the engine in this checkpoint FOR this, so if
// nothing asserts the bot reads it, the field may as well not exist.
//
// The observable consequence, stated as a rule rather than a preference: a
// king is the boss of its suit once the ace has been played, and is not
// before. So the same position, differing only in whether the ace is face up
// in a completed trick, must produce different play.
{
  const mine = ['KH', '2D', '3D', '4D'];
  // Seven players, so most of the unseen pool is in hands rather than stock —
  // which is what makes "one card still outranks me" the difference between a
  // near-certainty and a coin flip. In a four-hand round it is not.
  const after = (extra) => botPosition({
    hand: mine,
    trump: NO_TRUMP,
    players: 7,
    roundSize: 5,
    trickIndex: 1,
    tricksDone: [{
      plays: ['5H', '6H', '7H', '8H', '9H', 'TH', extra].map((code, i) => ({ seat: i, code })),
      winner: 1,
    }],
  });

  const aceGone = chooseCard(...after('AH'));
  const aceOut = chooseCard(...after('2C'));
  eq(aceGone.code, 'KH', 'with the ace already played, the king is boss and gets cashed');
  ok(aceOut.code !== 'KH',
    `with the ace still outstanding the king is not boss, and it leads ${aceOut.code} instead`);

  // The control, and the reason this test exists: hiding the completed trick
  // must produce the ace-outstanding answer. If it produced the ace-gone one,
  // the bot would be reading something other than pub.tricks — and if it
  // produced the same answer either way, this test would be vacuous.
  const blind = chooseCard(...botPosition({
    hand: mine, trump: NO_TRUMP, players: 7, roundSize: 5, trickIndex: 1, tricksDone: [],
  }));
  eq(blind.code, aceOut.code,
    'and a bot shown no history plays as though the ace were still out — which it must,'
    + ' because that is all it has been told');
}

// ===========================================================================
section('Bot — what it is entitled to know, and what it must not waste');
// ===========================================================================

// Two halves of one rule, and they pull in opposite directions.
//
// The bot must not see the turn-up before the reveal — that is the privacy
// boundary, and section 4 enforces it at the engine. But it must ALSO not
// ignore the turn-up after the reveal: a card lying face up on the table is
// not a card that might beat you, and a bot that counted it as unseen would
// be frightened of something it can see. Emptying `seen` in bidContext left
// the suite green, so only the first half was actually being tested.
{
  const pub = {
    config: { scoring: 'standard', hook: false },
    roundSize: 5, seats: [{}, {}, {}, {}], trump: 'S', turnUpCard: 'AH',
  };
  same(bidContext(pub, {}).seen, ['AH'], 'once turned, the turn-up is a card the bidder has seen');
  same(bidContext({ ...pub, turnUpCard: null }, {}).seen, [],
    'and before the reveal there is nothing to see — the engine withheld it, so this is empty');

  // And `seen` has to actually reach the arithmetic, or carrying it is theatre.
  // The king of hearts is worth more when the ace of hearts is face up, for
  // the same reason it is worth more when the ace has been played.
  const base = { scoring: 'standard', roundSize: 5, players: 4, trump: 'S' };
  const hand = ['KH', '2C', '3C', '4C', '5C'];
  const blind = trickChances(hand, base)[0];
  const knowing = trickChances(hand, { ...base, seen: ['AH'] })[0];
  ok(knowing > blind + 0.01,
    `the king of hearts is worth more with the ace face up (${knowing.toFixed(3)}) `
    + `than with it unaccounted for (${blind.toFixed(3)})`);
}

// ===========================================================================
section('Bot — the engine contract the bot leans on');
// ===========================================================================

// publicState().tricks was added for the bot in checkpoint 6, so its
// invariants are tested here rather than in section 4. The one that matters: a
// card is in `tricks` or in `plays`, NEVER BOTH. A consumer counting what has
// gone concatenates the two, and a double-count would have the bot believe a
// suit was exhausted while somebody still held it.
{
  let checked = 0;
  playBotMatch({
    config: { scoring: 'standard', trumpMethod: 'rotation', shape: 'downup', maxHand: 5 },
    players: 4,
    shuffleSeed: 77,
    watch: (pub) => {
      checked += 1;
      const settled = pub.tricks.flatMap((t) => t.plays.map((p) => p.code));
      const onTable = pub.plays.map((p) => p.code);
      same(settled.filter((c) => onTable.includes(c)), [],
        'no card is in both a completed trick and the trick in progress');
      eq(new Set(settled).size, settled.length, 'and no card appears in two completed tricks');
      eq(pub.tricks.length, pub.trickIndex, 'the completed count is exactly the trick index');
      ok(pub.tricks.every((t) => t.plays.length === pub.seats.length),
        'every completed trick holds one card per seat');
      ok(settled.length + onTable.length <= pub.roundSize * pub.seats.length,
        'and the round never accounts for more cards than it dealt');
    },
  });
  ok(checked > 100, `the contract held across ${checked} positions`);
}

// ===========================================================================
section('Bot — the driver, and the pacing the brief asks for');
// ===========================================================================

// bot.js is pure; the driver is the only part that knows about time, and even
// it takes `now` as a parameter. No setTimeout anywhere — the brief's "no
// timers in the engine" rule reaches here too, because a bot that scheduled
// its own moves could not be soaked at a million ticks a second.
{
  eq(BOT_THINK_MS, 1500, 'bots pause before moving, reusing sequence\'s pacing');
  ok(OFFLINE_GRACE_MS >= 10000,
    `a disconnected human is only covered after ${OFFLINE_GRACE_MS}ms — never tighten this; the `
    + 'brief measured a cold handshake at ~4.6s and a 19-round match outlasts a battery');
  ok(SAFE_ENOUGH > 0.5 && SAFE_ENOUGH < 1, 'the "this will hold" threshold is a probability, not a certainty');

  const g = new GameEngine();
  g.addPlayer('owner', 'Owner', { isOwner: true, clientId: 'cowner' });
  for (let i = 1; i < 4; i++) g.addBot('owner');
  g.setConfig('owner', { scoring: 'standard', trumpMethod: 'rotation', shape: 'downup', maxHand: 3 });
  g.startMatch('owner', 0);

  // THE DRIVER WILL NOT MOVE A CONNECTED HUMAN'S SEAT, which is the whole
  // point of it, so the owner has to drop before an all-seats-driven match is
  // even possible. Dropping it here is not a workaround — it is the second
  // thing the driver is for, and it makes this the test of the offline path
  // as well as the pacing one.
  g.disconnect('owner');
  eq(g.seats[0].connected, false, 'the owner has dropped, so its seat needs covering');

  // Nothing is waiting on anybody until the deal has resolved into BIDDING,
  // and the engine only advances on tick(). Walking it there first means the
  // pacing measured below starts from the moment a seat is genuinely on move.
  let t0 = 0;
  while (g.phase !== PHASES.BIDDING && t0 < 60000) { t0 += 100; g.tick(t0); }
  eq(g.phase, PHASES.BIDDING, 'the deal resolved and somebody is on move');

  const driver = createBotDriver({ thinkMs: BOT_THINK_MS, offlineMs: BOT_THINK_MS });
  // The pause is real. Called repeatedly at one instant the driver must not
  // act, or a bot would snap its card down the moment the previous one landed
  // and the table would never see what happened.
  let acted = 0;
  for (let i = 0; i < 50; i++) if (driver.tick(g, t0)) acted += 1;
  eq(acted, 0, 'called fifty times at one instant, the driver moves nobody');

  let firstAt = null;
  for (let t = t0; t <= t0 + BOT_THINK_MS + 500 && firstAt === null; t += 50) {
    if (driver.tick(g, t)) firstAt = t - t0;
  }
  ok(firstAt !== null && firstAt >= BOT_THINK_MS,
    `the first move landed ${firstAt}ms after the turn opened, not before ${BOT_THINK_MS}ms`);

  // A whole match driven only by the driver, to prove the composite key
  // advances. If two distinct decisions ever collided on one key the second
  // would never fire and this loop would wedge — which is the failure mode the
  // key exists to prevent, and it cannot be caught by inspection.
  {
    let now = t0; let moves = 0; let guard = 0;
    while (g.phase !== PHASES.MATCH_OVER) {
      if (++guard > 200000) break;
      now += 100;
      if (g.tick(now)) continue;
      // nextRound stays owner-gated even when the owner has dropped — see the
      // note on createBotDriver. Somebody outside the driver always advances
      // the scoreboard.
      if (g.phase === PHASES.ROUND_OVER) { g.nextRound('owner', now); continue; }
      if (driver.tick(g, now)) moves += 1;
    }
    eq(g.phase, PHASES.MATCH_OVER, 'the driver alone carried a match to the end');
    ok(moves > 20, `${moves} moves, each one paced rather than snapped`);
    // And paced in wall-clock terms: every one of those moves waited out the
    // think time, so the match cannot have taken less than moves x thinkMs.
    ok(now - t0 >= moves * BOT_THINK_MS,
      `${moves} moves took ${((now - t0) / 1000).toFixed(1)}s of simulated time, never snapped`);
  }

  // #########################################################################
  // #  AND THE SEAT IT MUST NEVER TOUCH.                                    #
  // #                                                                       #
  // #  A bot playing a card for somebody who is sitting right there, phone  #
  // #  in hand, is the worst bug this file could have — it is not a bad     #
  // #  move, it is the game playing itself. coverage() returns null for a   #
  // #  connected human and that is the whole safeguard, and until a         #
  // #  mutation run deleted the check and the suite stayed green, nothing   #
  // #  asserted it. Everything else here drops a seat first, so the guard   #
  // #  was never once exercised.                                            #
  // #########################################################################
  {
    const table = new GameEngine();
    table.addPlayer('a', 'A', { isOwner: true, clientId: 'ca' });
    table.addPlayer('b', 'B', { clientId: 'cb' });
    table.addPlayer('c', 'C', { clientId: 'cc' });
    table.setConfig('a', { scoring: 'standard', trumpMethod: 'rotation', shape: 'downup', maxHand: 3 });
    table.startMatch('a', 0);
    let t = 0;
    while (table.phase !== PHASES.BIDDING && t < 60000) { t += 100; table.tick(t); }
    eq(table.phase, PHASES.BIDDING, 'three present humans, and one of them is on move');
    ok(table.seats.every((s) => s.connected && !s.isBot), 'every seat is a connected human');

    const patient = createBotDriver({ thinkMs: 10, offlineMs: 10 });
    // Not "long enough": absurdly long, and repeatedly, because the failure
    // being excluded is a bot that waits politely and then takes the turn.
    let moved = 0;
    for (const at of [t, t + 1000, t + 60_000, 10_000_000, 86_400_000]) {
      if (patient.tick(table, at)) moved += 1;
    }
    eq(moved, 0, 'the driver never moves a seat whose human is present, however long it waits');
    const bids = table.bids.filter((b) => b !== null).length;
    eq(bids, 0, 'and not one bid was placed on their behalf');

    // The anti-vacuity guard, and the other half of the rule: the instant that
    // same seat drops, the same driver covers it. Otherwise the assertion
    // above would pass just as well for a driver that never does anything.
    const onMove = table.seats[table.turnSeat];
    table.disconnect(onMove.id);
    const covered = createBotDriver({ thinkMs: 10, offlineMs: 10 });
    covered.tick(table, 10_000_000);
    ok(covered.tick(table, 10_000_100),
      'but the moment that seat drops, the very same driver covers it');
    eq(table.bids.filter((b) => b !== null).length, 1,
      'and the covering move is a real bid the engine accepted');
  }

  // And the other direction: stepping a phase nobody is waiting on is a no-op
  // rather than an error.
  const idle = new GameEngine();
  idle.addPlayer('solo', 'Solo', { isOwner: true, clientId: 'csolo' });
  eq(createBotDriver({}).tick(idle, 10_000_000), false, 'a lobby with nobody to move is a no-op');
  // reset() forgets a pause in progress, for a host that has just taken the
  // engine over and for whom "waiting since" means nothing.
  const d2 = createBotDriver({ thinkMs: 500 });
  const g2 = new GameEngine();
  g2.addPlayer('owner', 'Owner', { isOwner: true, clientId: 'c2' });
  for (let i = 1; i < 4; i++) g2.addBot('owner');
  g2.startMatch('owner', 0);
  d2.tick(g2, 0);
  d2.reset();
  eq(d2.tick(g2, 400), false, 'after a reset the clock starts again rather than firing early');
}

// ===========================================================================
//
//  7. THE RENDERER
//
//  ui.js is a pure function of `app`, which is the only reason any of this is
//  possible: same state in, same tree out, no clock, no network, no state of
//  its own. scripts/domshim.mjs supplies the four DOM methods util.js needs.
//
//  WHAT IS AND IS NOT TESTED HERE. Everything below is about STRUCTURE and
//  BEHAVIOUR — what is in the tree, what is reachable, what a click does.
//  Nothing below is about LAYOUT. Whether seven seats fit across 390px is a
//  question only a browser can answer and it was answered in a browser, in
//  _sketch.html, by measurement. Asserting it here against a fake DOM with no
//  box model would be inventing evidence.
//
// ===========================================================================

const uiRoot = installDOM();

// Every intent recorded rather than performed, so a click can be inspected
// instead of obeyed. A Proxy rather than a fixed object on purpose: it answers
// to an intent this harness has never heard of, so a name added to ui.js
// without being added here shows up as a recorded call rather than as a
// TypeError that looks like a renderer bug.
function spyIntents() {
  const calls = [];
  const it = new Proxy({}, { get: (_, name) => (...args) => { calls.push({ name, args }); } });
  return { calls, intents: it, names: () => calls.map((c) => c.name) };
}

function baseApp(over = {}) {
  return {
    screen: 'game', me: { name: 'Ana' }, code: 'WXYZ', pub: null, priv: null,
    isHost: true, error: null, selected: null, selectedBid: null,
    showPad: false, showLog: false, announce: '', busy: false,
    reconnecting: false, netWarning: null, ...over,
  };
}

function draw(app) {
  const { calls, intents } = spyIntents();
  render(uiRoot, app, intents);
  return { root: uiRoot, calls, intents };
}

// --- reading cards back out of a rendered tree -----------------------------
//
// The privacy assertions need to know which cards a frame actually SHOWS, and
// a frame shows them two ways: as a face (rank glyph + suit glyph, from
// cardFace) and as a word in an aria-label (cardName, for the screen reader).
// Both are scanned, because a leak through the accessible name is still a
// leak — and it is the one a person looking at the screen would never catch.
const RANK_BY_LABEL = new Map(RANKS.map((r) => [rankLabel(`${r}S`), r]));
const SUIT_BY_GLYPH = new Map(SUITS.map((s) => [suitGlyph(s), s]));
const ALL_CARD_CODES = [];
for (const r of RANKS) for (const s of SUITS) ALL_CARD_CODES.push(`${r}${s}`);
const NAME_TO_CODE = new Map(ALL_CARD_CODES.map((c) => [cardName(c), c]));

function cardsShown(node) {
  const seen = new Set();
  // 1. Faces. Structural: the two spans cardFace() builds, read by class.
  for (const face of byClass(node, 'card')) {
    const rank = face.children.find((c) => c.hasClass && c.hasClass('card-rank'));
    const suit = face.children.find((c) => c.hasClass && c.hasClass('card-suit'));
    if (!rank || !suit) continue;
    const r = RANK_BY_LABEL.get(rank.text);
    const s = SUIT_BY_GLYPH.get(suit.text);
    if (r && s) seen.add(`${r}${s}`);
  }
  // 2. Accessible names. Every aria-label in the tree, against every card
  //    name there is. Longest first so "10 of spades" is not credited to a
  //    card whose name is a suffix of it.
  const labels = walk(node).filter((n) => n.getAttribute && n.getAttribute('aria-label'))
    .map((n) => n.getAttribute('aria-label'));
  if (labels.length) {
    const hay = labels.join(' | ');
    for (const [name, code] of NAME_TO_CODE) if (hay.includes(name)) seen.add(code);
  }
  return seen;
}

/** Everything the whole table is entitled to see, as the engine's own privacy
 *  section defines it. Reused rather than restated — if that definition ever
 *  widens again, these assertions widen with it instead of going stale. */
function tableVisible(g) { return publiclyVisible(g); }

// ===========================================================================
section('UI: seatState, the visual language of the strip and the pad');
// ===========================================================================

// EVERY STATE THE SWEEP BELOW ACTUALLY OBSERVES, collected rather than typed.
// The stylesheet check further down is driven by this set: a fifth state added
// to seatState() has to be answered in css/app.css before the suite goes green
// again, and a list written out by hand here would have to be remembered.
const SEAT_STATES = new Set();

// Exhaustive over every bid and every trick count the deck permits, plus the
// two ways a bid can be absent. A four-way total function over two small
// integers is exactly the sort of thing to sweep rather than sample.
{
  let nobid = 0, under = 0, exact = 0, over = 0, other = 0, agreed = 0;
  for (const bid of [null, undefined, ...Array.from({ length: 18 }, (_, i) => i)]) {
    for (let taken = 0; taken <= 17; taken++) {
      const st = seatState(bid, taken);
      SEAT_STATES.add(st);
      if (st === 'nobid') nobid++;
      else if (st === 'under') under++;
      else if (st === 'exact') exact++;
      else if (st === 'over') over++;
      else other++;

      if (bid === null || bid === undefined) {
        ok(st === 'nobid', `no bid is 'nobid' whatever the tricks (${taken})`);
        continue;
      }
      // The definition, restated as three mutually exclusive comparisons.
      const want = taken < bid ? 'under' : (taken === bid ? 'exact' : 'over');
      ok(st === want, `bid ${bid}, took ${taken} is '${want}', got '${st}'`);

      // THE CLAIM THE COMMENT IN ui.js MAKES, under test. bot.js's appetite()
      // collapses exact and over into one answer because for choosing a card
      // they mean the same thing; the UI must keep them apart because for
      // looking at a table they are triumph and disaster. Assert the exact
      // relationship, so "deliberate duplication" stays a fact rather than a
      // note somebody wrote once.
      const duck = appetite(bid - taken, Math.max(1, 17 - taken)) === 'duck';
      if (duck === (st === 'exact' || st === 'over')) agreed++;
    }
  }
  eq(other, 0, 'seatState only ever answers one of its four states');
  ok(nobid === 36, `both spellings of "no bid" cover the whole trick range (${nobid})`);
  ok(under > 0 && exact > 0 && over > 0,
    `and all three real states occur in the sweep (${under}/${exact}/${over})`);
  eq(agreed, 18 * 18, "the bot's 'duck' is exactly the UI's 'exact' or 'over', over the whole grid");

  // Zero is a bid, not the absence of one — the distinction the whole of
  // Kachuful's scoring hangs off, and a `!bid` test would collapse it.
  eq(seatState(0, 0), 'exact', 'a made zero bid is exact, not nobid');
  eq(seatState(0, 1), 'over', 'and a broken zero bid is over, not nobid');
}

// A NIL BID READS AS 'exact' THE INSTANT IT IS MADE, MID-BIDDING, AND THAT IS
// THE DECISION RATHER THAN THE OVERSIGHT.
//
// It looks like a phase bug: the accent that elsewhere means "they have got
// there" lights up before a card exists to have got there with. It is not. A
// seat on 0 tricks against a bid of 0 is exact in bidding as much as in play,
// and the nil bidder genuinely is in the position the accent describes —
// holding what they asked for, with everything to lose.
//
// Pinned from a LIVE ENGINE rather than by calling seatState(0, 0) again,
// because the claim under test is not about the function in isolation. It is
// that the phase the engine is in does not reach the function at all, and the
// only way to show that is to put an engine in the phase and ask.
{
  const g = playMatchUntil({ config: { shape: 'descending', maxHand: 4 }, players: 5 },
    (s) => s.phase === PHASES.BIDDING && s.bids.every((b) => b === null));

  const turn = g.turnSeat;
  const nil = g.bidOptionsFor(turn).find((o) => o.legal && o.bid === 0);
  ok(nil, 'zero is a legal opening bid, so the case this pins is reachable at all');
  ok(g.placeBid(g.seats[turn].id, nil.bid, 1).ok, 'and the nil bid lands');

  const pub = g.publicState();
  eq(pub.phase, PHASES.BIDDING, 'the round is still being bid — nobody has played a card');
  eq(pub.seats.filter((s) => s.tricks > 0).length, 0, 'and no seat has taken a trick');

  // Exactly what playStrip() reads off the seat record, argument for argument.
  const me = pub.seats[turn];
  eq(seatState(me.bid, me.tricks), 'exact',
    'a nil bid reads as exact from the moment it is made, mid-bidding, by design');

  // THE SEATS THAT HAVE NOT BID YET ARE THE OTHER HALF OF THE SAME FRAME, and
  // they are what .seat.nobid is for: at this point in the round most of the
  // strip is em-dashes, and the one thing worth finding is the ▸.
  const waiting = pub.seats.filter((s) => s.bid === null);
  ok(waiting.length >= 3, `with ${waiting.length} seats still to bid in the same frame`);
  eq(waiting.filter((s) => seatState(s.bid, s.tricks) !== 'nobid').length, 0,
    'and every one of them is nobid, so both states are on screen at once');

  // The mechanism, stated directly: no phase argument exists to pass.
  eq(seatState.length, 2, 'seatState takes a bid and a trick count, and no phase');
}

// ===========================================================================
section('UI: the four seat states each paint differently — ui.js <-> app.css');
// ===========================================================================

// THE STATE NAMES COME FROM THE SWEEP ABOVE, THE PAINT COMES FROM THE
// STYLESHEET, AND NEITHER IS TYPED HERE. The bug this replaces was exactly the
// pair going out of step: seatState() grew a fourth answer and css/app.css
// carried a comment that said "three", so a seat that had not bid inherited
// the resting colour by accident. The class-coverage seam further down could
// not see it — `.nobid` did eventually get a rule, and a rule that duplicates
// its neighbour looks identical to a rule that means something.
//
// So the question asked here is not "is there a rule" but "does it SAY
// anything different from the others".
{
  // Selector + body for every flat-bodied rule. Shared with the hand-geometry
  // section below — see cssRules() at the top of this file.
  const rules = cssRules('css/app.css');
  ok(rules.length > 100, `parsed ${rules.length} rules out of app.css, so the parser found something`);

  // Declarations, normalised so that whitespace and a trailing semicolon are
  // not differences.
  const decls = (body) => body.split(';').map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean).sort().join('; ');

  // A compound selector's class tokens — `.seat.you.exact` is {seat,you,exact}.
  // Split on descendant/child combinators first so that `.seat.exact .seat-name`
  // is not read as one compound carrying all three.
  const compounds = (sel) => sel.split(',').flatMap((one) => one.trim().split(/[\s>+~]+/))
    .filter(Boolean)
    .map((c) => new Set([...c.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])));

  // What a rule paints, with the state class removed from the selector — so
  // `.seat.under .seat-score {color: var(--text)}` and `.seat.nobid
  // .seat-score {color: var(--muted)}` compare as the same target with
  // different paint, which is the comparison that matters.
  const paintFor = (state) => {
    const out = new Set();
    for (const { sel, body } of rules) {
      if (!compounds(sel).some((c) => c.has('seat') && c.has(state))) continue;
      out.add(`${sel.replace(new RegExp(`\\.${state}\\b`, 'g'), '')} => ${decls(body)}`);
    }
    return out;
  };

  const paint = new Map([...SEAT_STATES].map((s) => [s, paintFor(s)]));
  eq(paint.size, 4, `every state seatState() answers was looked up: ${[...SEAT_STATES].sort().join(', ')}`);

  // 1. EVERY STATE IS SPELLED OUT. An absent rule and a deliberate no-op rule
  //    look identical in a stylesheet, and only one of them survives a tidy-up.
  const silent = [...paint].filter(([, p]) => p.size === 0).map(([s]) => s);
  for (const s of silent) console.error(`  ✗ FAIL: seatState() answers '${s}' and app.css has no .seat.${s} rule`);
  eq(silent.length, 0, 'every seat state has a rule of its own in app.css');

  // 2. NO TWO STATES PAINT THE SAME. This is the assertion that would have
  //    caught the original: nobid and under both resolving to var(--text) is a
  //    state the stylesheet acknowledges and does not distinguish, which is a
  //    fourth state on paper and three on screen.
  const same = [];
  const names = [...paint.keys()].sort();
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = [...paint.get(names[i])].sort().join(' | ');
      const b = [...paint.get(names[j])].sort().join(' | ');
      if (a === b) same.push(`${names[i]}/${names[j]}`);
    }
  }
  for (const p of same) console.error(`  ✗ FAIL: app.css paints ${p} identically — one of the four states is invisible`);
  eq(same.length, 0, 'and no two of the four states are painted the same way');

  // 3. THE DECISION, DERIVED RATHER THAN COPIED. "nobid" recedes to whatever
  //    .seat-name already uses, so an unbid chip is uniformly quiet and the ▸
  //    is the only thing competing for the eye. Read the colour off the
  //    .seat-name rule instead of writing var(--muted) here: if the chrome
  //    palette is retuned the two move together or this fails, which is the
  //    point of stating it as a relationship.
  const colourOf = (pred) => {
    for (const { sel, body } of rules) {
      if (!pred(sel)) continue;
      const m = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
      if (m) return m[1].trim();
    }
    return null;
  };
  const nameColour = colourOf((s) => s.trim() === '.seat-name');
  const nobidColour = colourOf((s) => /\.seat\.nobid\b/.test(s));
  const underColour = colourOf((s) => /\.seat\.under\b/.test(s));
  ok(nameColour && nobidColour && underColour,
    `all three colours were found in the stylesheet (${nameColour} / ${nobidColour} / ${underColour})`);
  eq(nobidColour, nameColour,
    'a seat that has not bid is the same colour as its own name — the whole chip recedes together');
  ok(nobidColour !== underColour,
    `and a seat that HAS bid is not (${nobidColour} vs ${underColour})`);

  // 4. BID STATE AND PRESENCE USE DIFFERENT CHANNELS. .seat.gone is opacity
  //    plus a struck-through name, and it has to be able to coexist with all
  //    four of these — a player can walk away from the keyboard while sitting
  //    on a made bid, and the chip must say both things at once. That only
  //    works while the state rules stay out of the opacity channel.
  const stateBodies = [...paint.values()].flatMap((p) => [...p]).join(' ');
  ok(!/(^|[^-\w])opacity\s*:/.test(stateBodies),
    'no seat-state rule touches opacity, so .seat.gone can dim any of them');
  ok(rules.some(({ sel, body }) => /\.seat\.gone\b/.test(sel) && /opacity\s*:/.test(body)),
    'and .seat.gone is the rule that does own opacity, so the channels really are separate');

  console.log(`  seat states: ${names.map((n) => `${n}(${paint.get(n).size})`).join(' ')}`
    + ` over ${rules.length} css rules; nobid=${nobidColour}, under=${underColour}`);
}

// ===========================================================================
section('UI: a card in the hand is card-shaped at every legal hand size');
// ===========================================================================

// WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT.
//
// `.hand .card` used to be `flex: 1 1 0; min-width: 0; max-width: 58px;
// height: 78px` — width divides the row with no floor, height never moves. At
// the default ten-card round on a 375px phone that renders a card 30.4px wide
// and 78px tall. A playing card is about 0.70 wide-to-tall; that is 0.39. By
// seventeen cards, the legal ceiling for three players, the card is 13.2px
// wide and the "10" it has to print is 19.8px, so the rank hangs outside the
// face.
//
// The comment over cardFace() said the sizing had been "measured" — and it
// had, at one card and at ten. Ten was the last hand size that did not
// visibly overflow. A measurement of the case you thought of is not a
// measurement of the range, and the range here is 1..MAX_HAND_CEILING by 320
// ..640px, which is small enough to sweep in full.
//
// So this section does not ask "is the stylesheet the way I left it". It
// recomputes the layout from the values in the stylesheet and asks whether a
// card comes out card-shaped and legible, for every hand a player can be
// dealt, on every phone anyone holds. The numbers it reads are the ones the
// browser reads; the model below was checked against a real browser at 320,
// 360, 375, 390 and 1280px before it was written down, and agrees on the
// per-row count at all five.
//
// A function, where every other section here is a bare block, for one reason:
// this one has to be able to STOP. See the guard below.
(() => {
  const rules = cssRules('css/app.css');

  // --- what the stylesheet actually says ----------------------------------
  // A custom property, found by searching every rule rather than by assuming
  // it lives on `:root` — where the palette is declared is not this section's
  // business.
  const cssVarOf = (name) => {
    let found = null;
    for (const r of rules) {
      const m = r.body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
      if (m) found = m[1].trim();
    }
    return found;
  };
  // Declarations are read through a var() resolver, because a value that the
  // browser resolves and this parser does not is a value this section thinks
  // is absent. `.card { width: var(--card-w) }` is the live case: the fanned
  // bidding hand needs the card's width readable by the card's PARENT, which
  // only a custom property can do, and the moment that landed every number
  // below went null and the whole section stopped. The declaration is still
  // there and still says 44px; only the spelling changed.
  //
  // One level, no fallback syntax, and a var that resolves to another var is
  // left alone rather than chased: this is a test's CSS reader, and the day
  // the stylesheet needs more than that is the day this should fail loudly
  // instead of guessing. An unresolvable var() comes back as-is, px() rejects
  // it, and the `missing` guard names it.
  const deref = (v) => {
    if (!v) return v;
    const m = v.trim().match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (!m) return v;
    const inner = cssVarOf(m[1]);
    return inner === null || /^var\(/.test(inner) ? v : inner;
  };
  const declOf = (sel, prop) => deref(cssDecl(rules, sel, prop));
  const px = (v) => (v && /^-?[\d.]+px$/.test(v.trim()) ? parseFloat(v) : null);
  // clamp(<min>px, <n>vw, <max>px) -> the three numbers.
  const clampOf = (v) => {
    const m = v && v.match(/clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)/);
    return m ? { min: +m[1], vw: +m[2], max: +m[3] } : null;
  };

  const baseW = px(declOf('.card', 'width'));
  const baseH = px(declOf('.card', 'height'));
  const handW = clampOf(declOf('.hand .card', 'width'));
  const ratio = declOf('.hand .card', 'aspect-ratio');
  const handGap = declOf('.hand', 'gap');
  const rowGap = handGap && px((handGap.match(/^\s*(\S+)/) || [])[1]);
  const colGap = clampOf(handGap);
  const dockPad = declOf('.hand-dock', 'padding');
  const dockPadX = dockPad && parseFloat((dockPad.match(/^\s*[\d.]+px\s+([\d.]+)px/) || [])[1]);
  const maxw = px(cssVarOf('--maxw'));
  const rankPx = px(declOf('.card-rank', 'font-size'));
  const liftM = (declOf('.card-btn.sel .card', 'transform') || '').match(/translateY\(\s*-?([\d.]+)px/);
  const lift = liftM ? +liftM[1] : null;

  // Everything above is read, not typed, so the first assertion has to be that
  // the reading worked. A parser that silently returns null turns every
  // property below into a comparison between two nulls.
  const read = { baseW, baseH, handW, ratio, rowGap, colGap, dockPadX, maxw, rankPx, lift };
  const missing = Object.entries(read).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  eq(missing.length, 0, `every value this section reasons about was found in app.css${
    missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  // AND THEN STOP, which is what the function wrapper is for. Reporting the
  // missing value is not enough on its own: everything below does arithmetic
  // on these, `null.min` throws, and a throw here does not fail this section —
  // it takes the process down and every section after it with it. Two of the
  // #29 mutation rows came back CRASH rather than naming the assertion they
  // tripped, which is how this was noticed. A suite that cannot say WHICH
  // check caught something has stopped being a suite and become a smoke test.
  if (missing.length) return;

  // --- 1. the hand's ratio is the card's ratio, not a second opinion -------
  //
  // aspect-ratio duplicates .card's width and height, which is the one place
  // in the stylesheet where the same fact is written twice. Two copies of one
  // invariant agree until they do not, so they are compared here rather than
  // trusted.
  const arM = (ratio || '').match(/^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
  ok(arM, `the hand's aspect-ratio is a plain w/h ratio (got ${JSON.stringify(ratio)})`);
  if (arM) {
    eq(`${arM[1]}/${arM[2]}`, `${baseW}/${baseH}`,
      'and it is the SAME ratio as the base .card — retuning one moves the other or this fails');
  }
  const CARD_RATIO = baseW / baseH;

  // --- 2. the mechanism: the row wraps, and nothing divides it ------------
  //
  // A floor only floors anything if the row is allowed to wrap when it is
  // reached. Two ways this silently reverts: flex-wrap goes away, or the
  // wrapper goes back to `flex: 1 1 0` and resumes dividing the row — at
  // which point the floor is a min-width on an item that is being told to
  // shrink, and the strip is back.
  eq((declOf('.hand', 'flex-wrap') || '').trim(), 'wrap',
    'the hand wraps, which is what makes a floor mean anything');
  eq((declOf('.card-btn', 'flex') || '').trim(), 'none',
    'and the tappable wrapper shrink-wraps its card instead of dividing the row');
  eq(declOf('.hand .card', 'flex'), null,
    'the face itself sets no flex — its width is the clamp, full stop');
  eq((declOf('.hand .card', 'height') || '').trim(), 'auto',
    'and its height follows the ratio rather than being pinned, which was the original bug');

  // --- 3. a lifted card has somewhere to go -------------------------------
  //
  // .card-btn.sel raises the selected card. On one row that came out of the
  // dock's padding; on a wrapped row it comes out of the row above, and the
  // row-gap is the only thing between them.
  ok(rowGap >= lift,
    `the hand's row-gap (${rowGap}px) clears the lift .card-btn.sel applies (${lift}px)`);

  // --- 4. the geometry model ----------------------------------------------
  //
  // Straight out of the stylesheet: the shell is capped at --maxw however wide
  // the window is, the dock pads it, vw units still refer to the WINDOW, and
  // the cards are laid out at a fixed width with a fixed gap.
  const avail = (W) => Math.min(W, maxw) - 2 * dockPadX;
  const gapAt = (W) => Math.min(Math.max(colGap.min, (colGap.vw / 100) * W), colGap.max);
  const cardAt = (W) => Math.min(Math.max(handW.min, (handW.vw / 100) * W), handW.max);
  const fitsOneRow = (n, w, W) => n * w + (n - 1) * gapAt(W) <= avail(W);
  const perRow = (W) => Math.max(1, Math.floor((avail(W) + gapAt(W)) / (cardAt(W) + gapAt(W))));
  const rowsFor = (n, W) => Math.ceil(n / perRow(W));

  // --- 5. THE FLOOR IS DERIVED, NOT PREFERRED -----------------------------
  //
  // 38px is not a round number and must not be rounded. Seven cards is the
  // default hand at a seven-player table — the most crowded game — and 320px
  // is the narrowest phone. The floor is the largest value at which that hand
  // still fits on ONE row there. One pixel more and that table wraps, the dock
  // grows a row it has no height for, and on a 320x568 screen the cards go off
  // the bottom of the screen. (Measured: at a 40px floor the dock's bottom
  // edge lands at 632px on a 568px screen.)
  //
  // Both directions are asserted. Too big fails the first, too small fails
  // the second, so the constant is pinned from above and below by the
  // requirement rather than by taste.
  const NARROWEST = 320;
  const CROWDED_HAND = defaultMaxHand(MAX_PLAYERS);
  eq(CROWDED_HAND, 7, 'the crowded-table hand size came from rules.js, not from this file');
  ok(fitsOneRow(CROWDED_HAND, handW.min, NARROWEST),
    `${CROWDED_HAND} cards at the ${handW.min}px floor fit one row on a ${NARROWEST}px phone `
    + `(${(CROWDED_HAND * handW.min + (CROWDED_HAND - 1) * gapAt(NARROWEST)).toFixed(1)}px `
    + `of ${avail(NARROWEST)}px)`);
  ok(!fitsOneRow(CROWDED_HAND, handW.min + 1, NARROWEST),
    `and the floor is the LARGEST that does — at ${handW.min + 1}px that table would wrap`);

  // --- 6. the cap, against the card it sits next to -----------------------
  //
  // A one-card round must render one normal card, not one stretched across the
  // dock and not one shrunk below the cards on the table. Both bounds are the
  // base .card's own width, so this says "a hand card is in the same family as
  // a trick card" rather than naming a number.
  ok(handW.max >= baseW,
    `a lone card (${handW.max}px) is at least as big as a card on the table (${baseW}px)`);
  ok(handW.min <= baseW,
    `and a card in the biggest hand (${handW.min}px) is never bigger than one on the table`);
  ok(handW.max < 2 * baseW,
    `and it is not stretched either — ${handW.max}px is under twice ${baseW}px`);

  // --- 7. the sweep: every legal hand, every phone ------------------------
  //
  // The widths are the ones people actually hold, plus --maxw and a desktop
  // window past it to prove the shell cap is what governs there rather than
  // the viewport. The hand sizes are the whole legal range, which is the part
  // the original measurement skipped.
  //
  // "The rank fits" needs the width of "10" in the mono face, which node
  // cannot measure. 0.6em per glyph is an upper bound for the monospace
  // stacks in --mono (a real browser measured 0.55em for this one, so the
  // bound is conservative in the safe direction), and 2px comes off for the
  // 1px borders the face draws inside its own box.
  const MONO_ADVANCE_EM = 0.6;
  const WIDEST_RANK_CHARS = Math.max(...RANKS.map((r) => rankLabel(`${r}S`).length));
  eq(WIDEST_RANK_CHARS, 2, 'the widest rank label is two characters wide — that is the ten');
  const rankNeeds = WIDEST_RANK_CHARS * MONO_ADVANCE_EM * rankPx + 2;

  // Three rows is the dock's budget. Measured on a real 320x568 screen: at
  // three rows the dock is 285px of a 568px viewport and every default hand
  // still fits above it. A fourth row does not fit on any phone in this list.
  const ROW_BUDGET = 3;

  const WIDTHS = [320, 360, 375, 390, 414, 430, maxw, 1280];
  const strips = [];
  const overflows = [];
  const tooTall = [];
  let swept = 0;

  for (const W of WIDTHS) {
    const w = cardAt(W);
    const h = w / CARD_RATIO;
    for (let n = 1; n <= MAX_HAND_CEILING; n++) {
      swept++;
      // A card is card-shaped. With aspect-ratio doing the work this holds by
      // construction, which is the point: the old rule could not have passed
      // it at any hand size past five.
      if (Math.abs(w / h - CARD_RATIO) > 1e-9) strips.push(`${W}px x${n}: ${(w / h).toFixed(2)}`);
      // The rank fits inside the face it belongs to.
      if (w - 2 < rankNeeds) overflows.push(`${W}px x${n}: ${w.toFixed(1)}px face, needs ${rankNeeds.toFixed(1)}px`);
      // And the hand fits in the dock's height budget.
      const r = rowsFor(n, W);
      if (r > ROW_BUDGET) tooTall.push(`${W}px x${n}: ${r} rows`);
    }
  }

  for (const s of strips.slice(0, 5)) console.error(`  ✗ FAIL: card is not card-shaped at ${s}`);
  for (const s of overflows.slice(0, 5)) console.error(`  ✗ FAIL: the rank does not fit at ${s}`);
  for (const s of tooTall.slice(0, 5)) console.error(`  ✗ FAIL: the hand needs too many rows at ${s}`);
  eq(strips.length, 0, `every hand card keeps the card ratio ${CARD_RATIO.toFixed(3)}, over ${swept} cases`);
  eq(overflows.length, 0,
    `and the widest rank fits inside every one of them (needs ${rankNeeds.toFixed(1)}px, floor is ${handW.min}px)`);
  eq(tooTall.length, 0, `and no legal hand needs more than ${ROW_BUDGET} rows on any of these widths`);

  // The old rule, run through the same model, to prove the sweep bites. If
  // this ever stops failing, the sweep has stopped measuring anything.
  const OLD = { w: (W) => Math.min(58, (avail(W) - (10 - 1) * gapAt(W)) / 10), h: 78 };
  const oldRatio = OLD.w(375) / OLD.h;
  ok(oldRatio < 0.5,
    `the rule this replaced produced ${oldRatio.toFixed(2)} at ten cards on a 375px phone, `
    + `against ${CARD_RATIO.toFixed(2)} for a real card — the sweep above would have caught it`);

  console.log(`  hand geometry: floor ${handW.min}px / cap ${handW.max}px, ratio ${CARD_RATIO.toFixed(3)}, `
    + `${swept} (width x hand size) cases, ${WIDTHS.length} widths, up to ${MAX_HAND_CEILING} cards; `
    + `per-row at 320/375/${maxw}px = ${perRow(320)}/${perRow(375)}/${perRow(maxw)}`);

  // --- 8. the fanned hand, which is a SECOND geometry --------------------
  //
  // Everything above is the play screen's hand: every card is a tap target, so
  // every card gets its own space and the row wraps. During bidding nothing is
  // tappable, so .hand.fan overlaps the cards into one row at any size — and
  // an overlapped card is only as good as the sliver of it left showing.
  //
  // Which makes this a different invariant with a different failure mode. Up
  // there the question is "is the card card-shaped"; here the card is always
  // 44x62 and the question is "can you still READ it". The two cannot share a
  // sweep, and the reason to check the second at all is that the first one
  // passes whatever the fan does.
  // The left of a four-value padding shorthand. Unitless zero is spelled `0`
  // and not `0px`, so a pattern that demands the unit on every side reads the
  // whole declaration as absent — which is a test failing over CSS style
  // rather than over layout.
  const fanPad = (declOf('.hand.fan .card', 'padding') || '').trim().split(/\s+/);
  const fanPadL = fanPad.length === 4 && /^(0|[\d.]+px)$/.test(fanPad[3])
    ? parseFloat(fanPad[3]) : null;
  // clamp(<min>px, <n>cqw, <max>px) — the slot's width, not the window's, so
  // this is a different clamp shape from clampOf above and needs its own read.
  const fanRank = (declOf('.hand.fan .card-rank', 'font-size') || '')
    .match(/clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)cqw\s*,\s*([\d.]+)px\s*\)/);
  const fanCap = deref((declOf('.hand.fan .card-btn', 'max-width') || '').trim());
  const fanLast = deref(((declOf('.hand.fan .card-btn:last-child', 'flex') || '')
    .match(/0\s+0\s+(\S+)/) || [])[1]);

  const fanRead = { fanPadL, fanRank, fanCap, fanLast };
  const fanMissing = Object.entries(fanRead).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  eq(fanMissing.length, 0, `the fan's geometry was found in app.css${
    fanMissing.length ? ` — missing: ${fanMissing.join(', ')}` : ''}`);
  if (fanMissing.length) return;

  const padL = +fanPadL;
  const rankFloor = +fanRank[1];
  const rankCap = +fanRank[3];

  // The mechanism. Without nowrap the fan is just the wrapping hand with no
  // gap, and the whole saving disappears silently — the cards would still be
  // readable, so nothing below would catch it.
  eq((declOf('.hand.fan', 'flex-wrap') || '').trim(), 'nowrap',
    'the fanned hand does not wrap — one row is what it is for');
  eq((declOf('.hand.fan', 'gap') || '').trim(), '0',
    'and the cards touch, because a gap between overlapping cards is a contradiction');
  // The cap is what makes them OVERLAP rather than spread out. Asserted
  // against the base card rather than against 44, so retuning the card moves
  // the cap with it.
  eq(px(fanCap), baseW,
    `a fanned slot is capped at one card width (${baseW}px), so a small hand packs instead of fanning`);
  eq(px(fanLast), baseW, 'and the last card gets a whole slot — nothing paints over it');

  // THE PROPERTY. The visible sliver of a card is the slot width, and the slot
  // width is what is left of the row once the last card has taken a whole one:
  //
  //     sliver(n, W) = (avail(W) - baseW) / (n - 1)
  //
  // Into that sliver goes the card's left padding and then the widest rank.
  // Note what is NOT in that sum on the play-screen side: up there the rank is
  // checked against the whole face, because the whole face is visible. Here it
  // is checked against the sliver AND offset by the padding, which is the
  // distinction the first attempt got wrong — 11px passed a check against the
  // sliver alone and clipped the ten by 1.36px in a real browser.
  const sliver = (n, W) => (n <= 1 ? baseW : (avail(W) - baseW) / (n - 1));
  // The rank shrinks with the slot but never below the floor, so the floor is
  // what binds on the narrow end — exactly where the sliver is thinnest.
  //
  // Parameterised by the floor, and BOTH the sweep and the "largest that
  // clears" pin below go through it. That is not tidiness: with the pin
  // written out in longhand, deleting the padding term from this function
  // changed no verdict — the sweep got more permissive and the pin was a
  // separate copy of the arithmetic that still had the term. A mutation run
  // caught it. One definition of "what has to fit" means weakening it breaks
  // the pin instead of quietly widening the sweep.
  const needsWith = (floor, n, W) => padL + WIDEST_RANK_CHARS * MONO_ADVANCE_EM
    * Math.min(Math.max(floor, (fanRank[2] / 100) * sliver(n, W)), rankCap);
  const fanNeeds = (n, W) => needsWith(rankFloor, n, W);

  const clipped = [];
  let fanSwept = 0;
  let tightest = { slack: Infinity };
  for (const W of WIDTHS) {
    for (let n = 1; n <= MAX_HAND_CEILING; n++) {
      fanSwept++;
      const slack = sliver(n, W) - fanNeeds(n, W);
      if (slack < tightest.slack) tightest = { slack, n, W };
      if (slack < 0) {
        clipped.push(`${W}px x${n}: ${sliver(n, W).toFixed(2)}px sliver, needs ${fanNeeds(n, W).toFixed(2)}px`);
      }
    }
  }
  for (const s of clipped.slice(0, 5)) console.error(`  ✗ FAIL: the fan hides the rank at ${s}`);
  eq(clipped.length, 0,
    `every fanned card shows its rank, over ${fanSwept} cases — tightest is `
    + `${tightest.slack.toFixed(2)}px at ${tightest.W}px x${tightest.n}`);

  // And the floor is the LARGEST that clears, pinned from both sides like the
  // 38px one above. A floor with room to spare is a floor someone will round
  // up to 11 or 12 "to make it readable", which is precisely what happened and
  // what shipped a clipped ten. One pixel more and the worst case fails.
  const worstSliver = sliver(MAX_HAND_CEILING, NARROWEST);
  eq(worstSliver, Math.min(...Array.from({ length: MAX_HAND_CEILING },
    (_, i) => sliver(i + 1, NARROWEST))),
  `the thinnest sliver in the game is the fullest hand on the narrowest phone `
    + `(${worstSliver.toFixed(2)}px), not some hand size in the middle`);
  ok(needsWith(rankFloor, MAX_HAND_CEILING, NARROWEST) <= worstSliver,
    `the ${rankFloor}px rank floor plus ${padL}px of padding fits that sliver `
    + `(needs ${needsWith(rankFloor, MAX_HAND_CEILING, NARROWEST).toFixed(2)}px)`);
  ok(needsWith(rankFloor + 1, MAX_HAND_CEILING, NARROWEST) > worstSliver,
    `and it is the largest that does — at ${rankFloor + 1}px the ten would be clipped`);

  console.log(`  fan geometry: slot capped at ${baseW}px, rank ${rankFloor}-${rankCap}px over `
    + `${fanRank[2]}cqw, ${padL}px padding; ${fanSwept} cases, thinnest sliver `
    + `${worstSliver.toFixed(2)}px at ${NARROWEST}px x${MAX_HAND_CEILING}`);
})();

// ===========================================================================
section('UI: the play shell can shrink, so the hand stays on the screen');
// ===========================================================================
//
// The play shell is `height: 100dvh` and does not scroll. Inside it the strip
// and the hand dock are `flex: none` and pinned to the two edges, and one
// middle band is expected to absorb everything else. If that band cannot
// actually shrink, it does not overflow tidily — it pushes the dock past the
// bottom of the screen, and the cards you are being asked to play are gone.
//
// `flex: 1 1 auto` LOOKS like it says "shrink me" and does not: a flex item's
// automatic minimum size is its content size, so the band stops shrinking at
// its content however large the shrink factor. It needs min-height: 0 as
// well, and that is three characters that read like a redundant no-op next to
// the `1 1 auto` — precisely the kind of thing a tidy-up deletes.
//
// THIS WAS BROKEN ON EVERY PHASE FOR NINE CHECKPOINTS and no assertion asked.
// Not a regression from the wrapping hand either: measured in a browser, the
// pre-existing one-row geometry pushed the dock to 619-750px on a 568px
// screen. The suite could tell you a card was card-shaped and not that it was
// off the bottom of the phone.
//
// The bands are DERIVED FROM A RENDER, not listed. A list of three selectors
// is right until someone adds a fourth phase, and the fourth phase is exactly
// when nobody remembers this file. So: render each phase, ask the play shell
// what its children are, and hold every child that is allowed to grow to the
// same three rules.
{
  const rules = cssRules('css/app.css');

  // Which rules apply to a node, given that everything in this stylesheet
  // targets elements by class. A selector matches if it is a chain of classes
  // the node has; among matches, more classes wins, and ties go to whichever
  // was declared later. That is the cascade for class-only selectors, which
  // is all this file uses in the shell.
  //
  // Grouped selectors are split, because the rule under test is written as
  // one `.bid-wrap, .trick-area, .interstitial {` — a reader that compares
  // whole selector strings finds nothing and reports the band as unstyled.
  const declFor = (classes, prop) => {
    let best = null;
    rules.forEach((r, order) => {
      if (r.at) return; // conditional: not what the layout IS, see cssDecl
      for (const part of r.sel.split(',')) {
        const sel = part.trim();
        if (!/^(\.[\w-]+)+$/.test(sel)) continue;
        const want = sel.split('.').filter(Boolean);
        if (!want.every((c) => classes.includes(c))) continue;
        for (const d of r.body.split(';')) {
          const m = d.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
          if (!m || m[1] !== prop) continue;
          const rank = want.length;
          if (!best || rank > best.rank || (rank === best.rank && order >= best.order)) {
            best = { value: m[2], rank, order, sel };
          }
        }
      }
    });
    return best;
  };

  // An engine stopped in each phase the play shell has a face for. Built from
  // PHASES rather than from three string literals, so a new phase arrives here
  // as a missing case rather than as silence.
  const shells = new Map();
  const seen = new Set();
  const unreached = [];
  for (const phase of Object.values(PHASES)) {
    // Not every phase is on the path of a played match: LOBBY is behind the
    // start, and TRUMP_REVEAL only happens under the methods that flip a
    // card. playMatchUntil THROWS when its predicate never holds, so a miss
    // has to be caught rather than tested for — and it is recorded, because
    // "this phase was never checked" is a thing the reader needs told. Two
    // configs, since the second may enter a phase the first cannot.
    let g = null;
    for (const config of UI_CONFIGS) {
      try {
        g = playMatchUntil({ config, players: 4 }, (e) => e.phase === phase);
        break;
      } catch (_) { /* this config never gets there; try the next */ }
    }
    if (!g) { unreached.push(phase); continue; }
    const me = g.seats[g.turnSeat >= 0 ? g.turnSeat : 0].id;
    const r = draw(baseApp({ screen: 'game', pub: g.publicState(), priv: g.privateStateFor(me) }));
    const shell = walk(r.root).find((n) => n.classList && n.hasClass && n.hasClass('shell-play'));
    if (!shell) continue;
    seen.add(phase);
    for (const child of shell.children || []) {
      if (!child.classList || !child.classList.length) continue;
      shells.set(child.classList.join('.'), child.classList);
    }
  }
  ok(seen.size >= 3, `the play shell was rendered in ${seen.size} phases: ${[...seen].join(', ')}`);
  ok(shells.size >= 3, `and offered ${shells.size} distinct children to check`);

  // Now the property, over whatever that render turned up.
  const growers = [];
  const cannotShrink = [];
  const cannotScroll = [];
  const unsafeCentre = [];
  for (const [key, classes] of shells) {
    const flex = declFor(classes, 'flex');
    if (!flex || !/^1\s+1\s+auto$/.test(flex.value.trim())) continue;
    growers.push(key);

    const minH = declFor(classes, 'min-height');
    if (!minH || !/^0(px)?$/.test(minH.value.trim())) {
      cannotShrink.push(`.${key} (min-height ${minH ? minH.value : 'unset'})`);
    }
    const ovf = declFor(classes, 'overflow-y') || declFor(classes, 'overflow');
    if (!ovf || !/^(auto|scroll)$/.test(ovf.value.trim())) {
      cannotScroll.push(`.${key} (overflow ${ovf ? ovf.value : 'unset'})`);
    }
    // Centring is optional; centring UNSAFELY is not. A centred flex line that
    // overflows overflows in both directions, so the start edge goes out of
    // reach and scrolling cannot bring it back — the lede and the first row of
    // bid buttons simply are not there.
    const jc = declFor(classes, 'justify-content');
    if (jc && /center/.test(jc.value) && !/\bsafe\b/.test(jc.value)) {
      unsafeCentre.push(`.${key} (justify-content: ${jc.value})`);
    }
  }

  ok(growers.length >= 3,
    `${growers.length} bands in the play shell are allowed to grow: ${growers.join(', ')}`);
  for (const s of cannotShrink) console.error(`  ✗ FAIL: ${s} can grow but not shrink`);
  for (const s of cannotScroll) console.error(`  ✗ FAIL: ${s} can be clipped with no way to scroll`);
  for (const s of unsafeCentre) console.error(`  ✗ FAIL: ${s} centres unsafely`);
  eq(cannotShrink.length, 0,
    'every band that may grow may also shrink — min-height: 0, or the dock goes off the screen');
  eq(cannotScroll.length, 0,
    'and whatever a shrunk band cuts off can still be scrolled to');
  eq(unsafeCentre.length, 0,
    'and no band centres so hard that its first line becomes unreachable');

  // The strip and the dock must NOT be in that set: they are the fixed edges,
  // and the day one of them starts flexing the whole argument above changes.
  for (const fixed of ['play-strip', 'hand-dock']) {
    const f = declFor([fixed], 'flex');
    eq(f && f.value.trim(), 'none', `.${fixed} is pinned, not flexible — it is one of the two edges`);
  }

  console.log(`  play shell: ${seen.size} phases rendered, ${shells.size} children, `
    + `${growers.length} growable (${growers.join(', ')})`
    + (unreached.length ? `; not reached: ${unreached.join(', ')}` : ''));
}

// ===========================================================================
section('UI: it renders every phase, from every seat, without throwing');
// ===========================================================================

// The screens with no engine behind them, including a screen name nothing
// should ever set — a bad `screen` must land on home, not on a blank page.
{
  let drawn = 0;
  ok(SCREENS.includes('replaced'),
    'the screen list came from ui.js itself, so a new screen cannot be left undrawn');
  for (const screen of SCREENS) {
    for (const name of ['', '  ', 'Ana']) {
      for (const isHost of [true, false]) {
        const r = draw(baseApp({
          screen, me: { name }, isHost, code: 'WXYZ',
          error: screen === 'error' ? 'The room is full.' : null,
        }));
        drawn++;
        ok(r.root.children.length >= 1, `screen '${screen}' renders something`);
        ok(walk(r.root).length > 3, `screen '${screen}' renders more than an empty shell`);
        eq(r.calls.length, 0, `screen '${screen}' fires no intent just by being drawn`);
      }
    }
  }
  // Derived, not typed. This read `42` and went red the moment a screen was
  // added — a failure that says nothing about the UI and costs a reader ten
  // minutes working out which of the three nested loops moved.
  eq(drawn, SCREENS.length * 3 * 2, `${drawn} stateless frames drawn, over ${SCREENS.length} screens`);

  // With no pub, the game screen has to fall back rather than throw — this is
  // the window between "joined" and "first state arrived", and it is real.
  const r = draw(baseApp({ screen: 'game', pub: null, priv: null }));
  ok(byClass(r.root, 'spinner').length > 0, 'a game screen with no state yet shows the connecting spinner');
}

{
  // --- the screen a superseded tab lands on --------------------------------
  //
  // Two terminal screens now, and they are terminal for different reasons.
  // 'hostleft' has nothing to reconnect TO. 'replaced' has somewhere very
  // much alive to reconnect to, and must not.
  // Draw a screen, press everything on it, and report what it was able to
  // ask for. `force` so that a disabled control still reports its intent —
  // the question here is what the screen OFFERS, not what it permits today.
  const canDo = (screen) => {
    const { calls, intents } = spyIntents();
    render(uiRoot, baseApp({ screen, isHost: false, pub: null, priv: null }), intents);
    const controls = interactive(uiRoot);
    for (const node of controls) node.click({}, { force: true });
    return { names: [...new Set(calls.map((c) => c.name))].sort(), controls: controls.length };
  };

  const replaced = canDo('replaced');
  const hostleft = canDo('hostleft');
  ok(replaced.controls > 0, `${replaced.controls} controls on the screen, so this is not an empty sweep`);

  // SIBLING OF hostleft, ASSERTED AS ONE. Both are terminal; they should end
  // in the same place. Stated as a comparison rather than as a list, because
  // a list would have to be edited on the day the rules button moves and a
  // comparison would not.
  same(replaced.names, hostleft.names,
    'it offers exactly what the other terminal screen offers, and nothing more');
  ok(replaced.names.includes('goHome'), 'including a way out');

  // AND NOTHING THAT DIALS. Derived: whatever the two screens that can get
  // onto the network offer and a terminal screen does not. A "RECONNECT" or
  // "TRY AGAIN" button here would take the seat off the tab that currently
  // holds it and hand this one the same screen — the loop the whole change
  // is about, with a finger on it. It is exactly the button a future reader
  // would think was missing, so the ban is a test and not a comment.
  const onward = [...new Set([...canDo('home').names, ...canDo('join').names])]
    .filter((n) => !hostleft.names.includes(n));
  ok(onward.length >= 2, `${onward.length} intents belong to the screens that start connections: ${onward.join(', ')}`);
  same(onward.filter((n) => replaced.names.includes(n)), [],
    'and the replaced screen offers none of them — there is no way to fight for the seat from here');

  render(uiRoot, baseApp({ screen: 'replaced', isHost: false, pub: null, priv: null }), spyIntents().intents);
  const said = walk(uiRoot)
    .map((n) => (typeof n.text === 'string' ? n.text : ''))
    .join(' ')
    .toLowerCase();

  // NAMES THE CAUSE, NOT THE SYMPTOM. "Disconnected" is true and useless:
  // somebody who has not realised they have two tabs open cannot act on it.
  ok(/another tab/.test(said), 'the screen says another tab, which is the thing the player can act on');
  ok(!/error|failed|sorry/.test(said), 'and does not dress a mundane thing up as a fault');
  ok(byClass(uiRoot, 'spinner').length === 0, 'with no spinner suggesting something is still in progress');
}

// A whole match under each of the three scoring modes and each trump method,
// rendered at every intermediate state from three points of view: the owner,
// a plain player, and a stranger with no seat at all.
const UI_VIEWS = ['p0', 'p2', 'nobody'];
let uiFrames = 0;
const uiPhasesSeen = new Map();

function sweepMatch(config, players, visit) {
  playMatch({
    config, players, strategy: 'random', shuffleSeed: 11,
    onState: (g) => {
      const pub = g.publicState();
      uiPhasesSeen.set(pub.phase, (uiPhasesSeen.get(pub.phase) || 0) + 1);
      for (const id of UI_VIEWS) {
        const priv = g.privateStateFor(id);
        uiFrames++;
        visit(g, pub, priv, id);
      }
    },
  });
}

// UI_CONFIGS was declared here, beside the UI sweeps that were its only
// caller. It moved up next to playMatch() when the engine's "the public view
// cannot move the engine" section wanted the same three configs — a const is
// not hoisted, so using it above its declaration is a TDZ crash rather than
// an undefined.

// THE LOBBY IS NOT REACHABLE FROM sweepMatch, and it has to be built by hand.
// playMatch() starts the match in its first statement, so every frame that
// sweep produces is mid-match — and the lobby is where setConfig, addBot,
// removeSeat, startMatch, applyPreset and the per-seat kick button all live,
// several of them nowhere else. Any section that only calls sweepMatch is
// silently not testing that screen. Two separate assertions have already been
// caught believing otherwise.
//
// Player counts from 1 to MAX_PLAYERS, because the lobby changes SHAPE across
// that range: the bot button disappears at a full table, the config card
// cannot size the ladder below MIN_PLAYERS, and the start button is blocked
// until three are seated.
const LOBBY_NAMES = ['Ana', 'Ben', 'Cleo', 'Dev', 'Esha', 'Finn', 'Gita'];

function sweepLobby(visit) {
  for (const players of [1, 2, 3, 5, MAX_PLAYERS]) {
    const g = new GameEngine();
    seatTable(g, LOBBY_NAMES.slice(0, players));
    for (const cfg of [{}, ...UI_CONFIGS]) {
      g.setConfig('p0', cfg);
      const pub = g.publicState();
      for (const id of ['p0', 'p1', 'nobody']) {
        const priv = g.privateStateFor(id);
        uiFrames++;
        visit(g, pub, priv, id);
      }
    }
  }
}

// ===========================================================================
section('UI: render() is pure, and it clears');
// ===========================================================================

{
  // Lesson 1 from the family: render() wipes root, which is why #announce is a
  // sibling of #app and not a child. Render the same state twice and the tree
  // must be identical, not doubled.
  const g = playMatchUntil({ config: UI_CONFIGS[0], players: 4 },
    (e) => e.phase === PHASES.PLAY && e.plays.length > 0);
  const pub = g.publicState();
  const priv = g.privateStateFor('p0');

  const app = baseApp({ pub, priv });
  const a = draw(app); const first = dump(a.root); const nFirst = walk(a.root).length;
  const b = draw(app); const second = dump(b.root); const nSecond = walk(b.root).length;
  eq(nSecond, nFirst, 'rendering twice leaves the same number of nodes, not twice as many');
  ok(first === second, 'and an identical tree — render is a pure function of app');

  // A root with junk already in it is emptied, not appended to.
  uiRoot.appendChild(el('div', { class: 'stale' }, 'left over from last frame'));
  const c = draw(app);
  eq(byClass(c.root, 'stale').length, 0, 'whatever was in root before is gone');
  eq(walk(c.root).length, nFirst, 'and the frame is the same size as ever');

  // clear() on a node with nothing in it is not an error.
  const empty = el('div', {});
  clear(empty);
  eq(empty.children.length, 0, 'clearing an empty node is a no-op, not a throw');

  // The live region is carried as an ATTRIBUTE, never as a rebuilt live node —
  // a region recreated every frame never fires, which is the whole reason for
  // the sibling arrangement.
  const region = walk(c.root).filter((n) => n.hasAttribute && n.hasAttribute('data-announce'));
  ok(region.length >= 1, 'the frame carries its announcement as data, for main.js to copy across');
  for (const n of region) {
    eq(n.getAttribute('aria-live'), null,
      'and never declares itself a live region — the persistent one outside #app is');
  }
}

// ===========================================================================
section('UI: the privacy boundary, as it reaches the screen');
// ===========================================================================

// THE ASSERTION THIS WHOLE CHECKPOINT IS FOR. The engine's own privacy section
// proves publicState() carries no hidden card. This proves the RENDERER adds
// none back — that no frame ever draws a card that its viewer is not entitled
// to, whether as a face or as an accessible name.
//
// It is not a restatement of the engine's test. A renderer handed a clean
// state can still leak: by drawing from priv when showing somebody else's row,
// by echoing a card into a label, by rendering the turn-up a beat early. The
// engine's test cannot see any of that, because none of it is in the state.
{
  let leaks = 0, frames = 0, ownHandDrawn = 0, strangerCards = 0;
  let sawUnrevealedTurnUp = 0, turnUpLeaks = 0;

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 5, (g, pub, priv, id) => {
      for (const showPad of [false, true]) {
        const r = draw(baseApp({
          pub, priv, isHost: id === 'p0', showPad, showLog: showPad,
          selected: priv && priv.hand[0] ? priv.hand[0].code : null,
        }));
        frames++;

        const shown = cardsShown(r.root);
        const allowed = new Set(tableVisible(g));
        if (priv) for (const c of priv.hand) allowed.add(c.code);

        for (const code of shown) {
          if (!allowed.has(code)) {
            if (leaks === 0) {
              console.error(`  ✗ LEAK: ${code} drawn to ${id} in phase ${pub.phase}`);
            }
            leaks++;
          }
        }

        // Non-vacuity, from both ends. A scan that finds nothing proves
        // nothing, so: the viewer's own hand must actually be on screen when
        // they have one, and a seatless stranger must never see a hand.
        if (priv && priv.hand.length
          && (pub.phase === PHASES.BIDDING || pub.phase === PHASES.PLAY)) {
          if (priv.hand.every((c) => shown.has(c.code))) ownHandDrawn++;
        }
        if (!priv) {
          for (const c of shown) if (!tableVisible(g).has(c)) strangerCards++;
        }

        // The turn-up, specifically. Before the engine sets turnUpShown the
        // card is not in pub at all, so this is really asserting that the
        // renderer does not invent one — but it is the exact moment the brief
        // singles out and it gets its own counter.
        if (g.turnUpCard && !g.turnUpShown) {
          sawUnrevealedTurnUp++;
          if (shown.has(g.turnUpCard)) turnUpLeaks++;
        }
      }
    });
  }

  eq(leaks, 0, `no frame ever draws a card its viewer may not see (${frames} frames)`);
  eq(strangerCards, 0, 'a viewer with no seat sees only what the whole table sees');
  eq(turnUpLeaks, 0, 'the turn-up is never drawn before the reveal moment');
  ok(sawUnrevealedTurnUp > 0,
    `and the unrevealed turn-up was actually on the board to leak (${sawUnrevealedTurnUp} frames)`);
  ok(ownHandDrawn > 0, `while a player's own hand IS drawn, in full (${ownHandDrawn} frames)`);
  for (const p of Object.values(PHASES)) {
    if (p === PHASES.LOBBY) continue;   // playMatch starts past it; covered above
    ok((uiPhasesSeen.get(p) || 0) > 0, `phase '${p}' was rendered at least once`);
  }
}

// ===========================================================================
section('UI: isHost is not isOwner, and the screen must not confuse them');
// ===========================================================================

// The standing constraint, as a reachability property rather than a reading of
// the source. Render as a NON-owner who nonetheless holds the engine —
// app.isHost true, priv.isOwner false, which is exactly what happens when the
// owner's seat passes on — then click every single thing on screen and assert
// no owner-only intent comes out.
//
// applyPreset and newMatch are in the forbidden set alongside the wire-level
// OWNER_INTENTS because main.js expands them into setConfig and startMatch.
// The wire never sees those two names, so guards.js cannot be the thing that
// stops them; this is.
const UI_OWNER_ONLY = new Set([...OWNER_INTENTS, 'applyPreset', 'newMatch']);
{
  let clicks = 0, escapes = 0, ownerClicks = 0;
  let gatedByDisabled = 0, ungated = 0;
  const reachedAsOwner = new Set();

  const clickEverything = (app) => {
    const { calls, intents } = spyIntents();
    render(uiRoot, app, intents);
    // Snapshot the node list BEFORE clicking. Nothing here re-renders — the
    // UI is pure and main.js owns the loop — but taking the list first makes
    // that independent of whether it stays true.
    const targets = interactive(uiRoot);
    for (const node of targets) { node.click(); clicks++; }
    return calls;
  };

  // The same question asked STRUCTURALLY rather than through dispatch. For a
  // non-owner, force every handler to fire and see which ones would have
  // produced an owner intent; every single one of those must be carrying
  // `disabled`, because `disabled` is the only reason the click above did not
  // land. Without this the section would be resting entirely on the shim
  // agreeing with a browser about disabled buttons, which is a fact about the
  // shim and not about ui.js.
  //
  // `disabled` and not `aria-disabled` is right here, unlike the greyed cards
  // and forbidden bids: those stay reachable because a keyboard player needs
  // to hear WHY, and the why is about the game. A setting you do not own has
  // no why worth hearing — it is simply not yours — and leaving it focusable
  // would put five dead controls in every guest's tab order.
  const checkGating = (app) => {
    const { calls, intents } = spyIntents();
    render(uiRoot, app, intents);
    for (const node of interactive(uiRoot)) {
      const before = calls.length;
      node.click({}, { force: true });
      const fired = calls.slice(before).map((c) => c.name);
      if (!fired.some((n) => UI_OWNER_ONLY.has(n))) continue;
      if (node.disabled) gatedByDisabled++;
      else {
        if (ungated === 0) {
          console.error(`  ✗ UNGATED: <${node.tag}> fires ${fired.join(',')} with nothing stopping it`);
        }
        ungated++;
      }
    }
  };

  // THE LOBBY FIRST. The first run of this section proved why the hard way:
  // five of the six owner controls reported unreachable, because they live on
  // the one screen sweepMatch never renders. The assertion was right and the
  // sweep was incomplete — which is the entire purpose of a non-vacuity check.
  sweepLobby((lg, pub, priv) => {
    if (!priv) return;
    const guest = baseApp({ pub, priv: { ...priv, isOwner: false }, isHost: true });
    for (const c of clickEverything(guest)) {
      if (UI_OWNER_ONLY.has(c.name)) {
        if (escapes === 0) console.error(`  ✗ ESCAPE: non-owner reached ${c.name} in the lobby`);
        escapes++;
      }
    }
    checkGating(guest);
    for (const c of clickEverything(baseApp({
      pub, priv: { ...priv, isOwner: true }, isHost: true,
    }))) {
      ownerClicks++;
      if (UI_OWNER_ONLY.has(c.name)) reachedAsOwner.add(c.name);
    }
  });

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 4, (g, pub, priv, id) => {
      if (!priv) return;
      for (const showPad of [false, true]) {
        // A host who is not the owner. The dangerous combination.
        const notOwner = { ...priv, isOwner: false };
        const guest = baseApp({ pub, priv: notOwner, isHost: true, showPad, showLog: showPad });
        for (const c of clickEverything(guest)) {
          if (UI_OWNER_ONLY.has(c.name)) {
            if (escapes === 0) console.error(`  ✗ ESCAPE: non-owner reached ${c.name} in ${pub.phase}`);
            escapes++;
          }
        }
        checkGating(guest);
        // And the converse, so this is not passing because nothing is
        // clickable: as the owner, those controls ARE there.
        const asOwner = { ...priv, isOwner: true };
        for (const c of clickEverything(baseApp({
          pub, priv: asOwner, isHost: true, showPad, showLog: showPad,
        }))) {
          ownerClicks++;
          if (UI_OWNER_ONLY.has(c.name)) reachedAsOwner.add(c.name);
        }
      }
    });
  }

  eq(escapes, 0, `a host who is not the owner reaches no owner control (${clicks} clicks)`);
  ok(ownerClicks > 0, 'and the sweep really was clicking things');
  ok(ungated === 0,
    `and every owner handler on a non-owner's screen is hard-disabled, not merely ignored `
    + `(${gatedByDisabled} disabled, ${ungated} live)`);
  ok(gatedByDisabled > 0,
    'with the disabled-gated controls actually present to check');
  // Every owner control must have been reachable SOMEWHERE in the sweep,
  // otherwise "no escapes" is just a report that the buttons do not exist.
  for (const name of UI_OWNER_ONLY) {
    ok(reachedAsOwner.has(name), `the owner can reach '${name}' somewhere in a match`);
  }

  // The one thing that is legitimately keyed to the device rather than the
  // player: the room code. Nobody but the host is listening on it, so showing
  // it to a guest would be telling them to dial themselves.
  const g = playMatchUntil({ config: UI_CONFIGS[0], players: 4 }, () => true);
  const lobby = new GameEngine();
  seatTable(lobby, ['Ana', 'Ben', 'Cleo']);
  const lpub = lobby.publicState();
  const host = draw(baseApp({ pub: lpub, priv: lobby.privateStateFor('p0'), isHost: true }));
  ok(byClass(host.root, 'panel-code').length === 1, 'the host sees the room code');
  const guest = draw(baseApp({ pub: lpub, priv: lobby.privateStateFor('p1'), isHost: false }));
  eq(byClass(guest.root, 'panel-code').length, 0, 'a guest never does');
  // isOwner must not be what decides it, in either direction.
  const ownerNotHost = draw(baseApp({
    pub: lpub, priv: { ...lobby.privateStateFor('p0'), isOwner: true }, isHost: false,
  }));
  eq(byClass(ownerNotHost.root, 'panel-code').length, 0,
    'and an owner who is not the host does not see it either — it is the device, not the player');
  ok(g.phase !== undefined, 'the engine used above really did run');
}

// ===========================================================================
section('UI: the grey is a convenience, and it is also honest');
// ===========================================================================

// Two claims, and they are different. The HOST is the enforcement point — that
// is tested in the engine sections. What is tested here is that the client
// never asks for something it has been told is illegal: no tap on a greyed
// card produces a playCard, no tap on a forbidden bid produces a placeBid.
//
// An illegal tap is not silent, though. It calls explain(), because a grey
// control that does nothing when pressed is indistinguishable from a broken
// one, and the whole content of a grey card is WHY.
{
  let illegalPlays = 0, illegalSelects = 0, illegalBids = 0, illegalBidSelects = 0;
  let explains = 0, legalSelects = 0, legalBidSelects = 0;
  let greyCards = 0, greyBids = 0, hardDisabled = 0;

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 4, (g, pub, priv) => {
      if (!priv) return;
      const legalCards = new Set(priv.hand.filter((c) => c.legal).map((c) => c.code));
      const legalBidSet = new Set((priv.bidOptions || []).filter((o) => o.legal).map((o) => o.bid));

      const { calls, intents } = spyIntents();
      render(uiRoot, baseApp({ pub, priv, selected: null }), intents);

      // Every card and bid button is pressed, legal or not.
      for (const node of interactive(uiRoot)) {
        const isCard = node.hasClass('card-btn');
        const isBid = node.hasClass('bid-btn');
        if (!isCard && !isBid) continue;
        if (node.getAttribute('aria-disabled') === 'true') {
          if (isCard) greyCards++; else greyBids++;
          // aria-disabled, NOT disabled. A hard-disabled button leaves the tab
          // order, so a keyboard player cannot reach the card to hear why it
          // is grey. This is the assertion that keeps it reachable.
          if (node.hasAttribute('disabled')) hardDisabled++;
        }
        node.click();
      }

      for (const c of calls) {
        if (c.name === 'explain') explains++;
        if (c.name === 'playCard' && !legalCards.has(c.args[0])) illegalPlays++;
        if (c.name === 'selectCard' && c.args[0] !== null) {
          if (legalCards.has(c.args[0])) legalSelects++;
          else if (pub.phase === PHASES.PLAY) illegalSelects++;
        }
        if (c.name === 'placeBid' && !legalBidSet.has(c.args[0])) illegalBids++;
        if (c.name === 'selectBid') {
          if (legalBidSet.has(c.args[0])) legalBidSelects++; else illegalBidSelects++;
        }
      }
    });
  }

  // THE SECOND TAP, which the sweep above cannot reach. Playing a card takes
  // two presses — select, then confirm — and everything above only ever
  // presses the first. So nothing above renders a frame in which app.selected
  // already holds an ILLEGAL card, and nothing above therefore presses Play
  // while one is selected. A mutation that deleted `card.legal` from the
  // confirm button's enable condition survived the first run of this whole
  // table for exactly that reason.
  //
  // It is a state that happens. Selection lives in app, not in the engine, and
  // it outlives the frame that made it: a card selected a moment ago can be
  // illegal by the time the host's next state lands. The host would refuse the
  // play — that is tested in the engine sections — but a confirm button that
  // is live and always fails is still a bug, and it is this file's bug.
  {
    let offered = 0, refused = 0, enabledOnLegal = 0, mute = 0, explained = 0;
    for (const config of UI_CONFIGS) {
      sweepMatch(config, 4, (g, pub, priv) => {
        if (!priv || pub.phase !== PHASES.PLAY || !priv.isTurn) return;
        for (const c of priv.hand) {
          const { calls, intents } = spyIntents();
          render(uiRoot, baseApp({ pub, priv, selected: c.code }), intents);
          const confirm = byClass(uiRoot, 'action-row')
            .flatMap((row) => byClass(row, 'btn-primary'))[0];
          if (!confirm) continue;
          confirm.click();
          const asked = calls.some((x) => x.name === 'playCard');
          if (c.legal) { if (asked) enabledOnLegal++; } else {
            refused++;
            if (asked) offered++;
            // Dead is not enough — it has to be legible. The reason the host
            // would have refused with is the same string the greyed card
            // carries, and it belongs on whichever control stopped working.
            const row = byClass(uiRoot, 'action-row')[0];
            const saysWhy = row && (row.text.includes(c.reason)
              || (confirm.getAttribute('aria-label') || '').includes(c.reason));
            if (saysWhy) explained++; else mute++;
          }
        }
      });
    }
    eq(offered, 0, 'with an illegal card selected, the confirm button will not play it');
    ok(refused > 0, `and an illegal card really was selected and confirmed (${refused} times)`);
    ok(enabledOnLegal > 0, `while a legal one goes through on the second tap (${enabledOnLegal})`);
    eq(mute, 0, 'and a dead confirm button always says why it is dead');
    ok(explained > 0, `naming the reason the host would have given (${explained} times)`);
  }

  eq(illegalPlays, 0, 'no tap on a greyed card ever asks the host to play it');
  eq(illegalSelects, 0, 'and it is not even selected, during play');
  eq(illegalBids, 0, 'no tap on a forbidden bid ever asks the host to place it');
  eq(illegalBidSelects, 0, 'and a forbidden bid is never selected');
  eq(hardDisabled, 0, 'nothing greyed is hard-disabled — all of it stays keyboard-reachable');
  ok(greyCards > 0, `there really were greyed cards to tap (${greyCards})`);
  ok(greyBids > 0, `and forbidden bids, from the hook (${greyBids})`);
  ok(explains > 0, `and every one of them explained itself instead (${explains})`);
  ok(legalSelects > 0 && legalBidSelects > 0,
    `while legal ones went through (${legalSelects} cards, ${legalBidSelects} bids)`);
}

// ===========================================================================
section('UI: the score pad, shape and content');
// ===========================================================================

// The brief's first hard UI problem, and the one with a real arithmetic
// contract: one row per PLANNED round — not per round played — and one column
// per seat plus the rail. Swept over every player count and every shape,
// because the row count is exactly where a ladder that goes down and back up
// is easy to get wrong.
{
  let pads = 0, badRows = 0, badCells = 0, badFractions = 0, badDeltas = 0, hyphens = 0;
  let futureRows = 0, doneRows = 0;

  for (const shape of ROUND_SHAPES) {
    for (const players of [3, 4, 5, 7]) {
      const config = { scoring: 'square', trumpMethod: 'rotation', shape, maxHand: 3, hook: false };
      playMatch({
        config, players, strategy: 'timid', shuffleSeed: 5,
        onState: (g) => {
          if (g.phase !== PHASES.ROUND_OVER && g.phase !== PHASES.MATCH_OVER) return;
          const pub = g.publicState();
          const r = draw(baseApp({ pub, priv: g.privateStateFor('p0'), showPad: true }));
          pads++;

          const tables = byTag(r.root, 'table');
          const body = byTag(tables[0], 'tbody')[0];
          const rows = byTag(body, 'tr');
          if (rows.length !== pub.plan.length) badRows++;

          const headCells = byTag(byTag(tables[0], 'thead')[0], 'th');
          if (headCells.length !== pub.seats.length + 1) badCells++;

          rows.forEach((row, ri) => {
            const cells = byTag(row, 'td');
            if (cells.length !== pub.seats.length) badCells++;
            const done = pub.history[ri];
            if (done) doneRows++; else futureRows++;
            cells.forEach((cell, si) => {
              if (!done) return;
              // THE SETTLED DECISION, UNDER TEST: taken over bid, that order.
              // "1/3" means one of three taken. Reversed it reads as a made
              // bid every time somebody misses, which is the exact opposite
              // of the information.
              const want = `${done.tricks[si]}/${done.bids[si]}`;
              const frac = byClass(cell, 'cell-bid')[0];
              if (!frac || frac.text !== want) badFractions++;
              const pts = byClass(cell, 'cell-pts')[0];
              if (!pts || pts.text !== fmtDelta(done.deltas[si])) badDeltas++;
            });
          });

          // U+2212, never U+002D. Square scoring is the mode that actually
          // goes negative, which is why this sweep uses it: a hyphen wedged
          // against a digit anywhere in the tree is the bug.
          for (const n of walk(r.root)) {
            if (n.nodeType === 3 && /-\d/.test(n.data)) hyphens++;
          }
        },
      });
    }
  }

  ok(pads > 0, `${pads} score pads rendered`);
  eq(badRows, 0, 'every pad has exactly one row per PLANNED round, on every shape');
  eq(badCells, 0, 'and one column per seat, plus the rail');
  eq(badFractions, 0, 'every settled cell reads taken/bid, in that order');
  eq(badDeltas, 0, 'and its points match history exactly, sign and all');
  eq(hyphens, 0, 'no negative number is ever drawn with a hyphen-minus');
  ok(doneRows > 0 && futureRows > 0,
    `with both played and unplayed rows in the sweep (${doneRows}/${futureRows})`);

  // The formatters, swept rather than sampled, since the pad leans on them.
  for (let n = -400; n <= 400; n++) {
    ok(!fmtScore(n).includes('-'), `score(${n}) uses no hyphen`);
    ok(!fmtDelta(n).includes('-'), `delta(${n}) uses no hyphen`);
    eq(Number(fmtScore(n).replace('−', '-')), n, `score(${n}) still reads back as ${n}`);
    eq(Number(fmtDelta(n).replace('−', '-').replace('+', '')), n, `delta(${n}) reads back as ${n}`);
  }
  eq(fmtDelta(0), '+0', 'a made zero bid shows +0, which is not the same as nothing happening');
  eq(fmtScore(0), '0', 'but a total of zero is just zero');

  // plural() likewise, and ZERO is the case worth writing down: "0 cards" and
  // "1 card" are the two ends of the rule, and English pluralises zero. It is
  // reachable — a bid of nothing, a round with no tricks left — and it is the
  // exact value an `n <= 1` typo gets wrong while every other number stays
  // right.
  eq(plural(0, 'card'), '0 cards', 'zero pluralises, like every number that is not one');
  eq(plural(1, 'card'), '1 card', 'one does not');
  for (let n = 2; n <= 60; n++) {
    eq(plural(n, 'trick'), `${n} tricks`, `plural(${n}) pluralises`);
  }
}

// ===========================================================================
section('UI: the strip, which is on screen at all times');
// ===========================================================================

{
  let chips = 0, badPlay = 0, badBidding = 0, slashInBidding = 0, missingLabel = 0;
  let ordering = 0, checkedOrder = 0;

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 5, (g, pub, priv, id) => {
      if (id !== 'p0') return;
      const r = draw(baseApp({ pub, priv }));
      const strip = byClass(r.root, 'play-strip')[0];
      if (!strip) return;

      const seats = byClass(strip, 'seat');
      seats.forEach((node, i) => {
        chips++;
        const s = pub.seats[i];
        const figure = byClass(node, 'seat-score')[0];
        if (pub.phase === PHASES.BIDDING) {
          // During bidding there is nothing taken yet to make a fraction from,
          // and "0/3" before a card is played reads as already failing.
          const want = s.bid === null ? '—' : String(s.bid);
          if (!figure || figure.text !== want) badBidding++;
          if (figure && figure.text.includes('/')) slashInBidding++;
        } else {
          const want = `${s.tricks || 0}/${s.bid === null ? '—' : s.bid}`;
          if (!figure || figure.text !== want) badPlay++;
        }
        // One sentence per chip. Four nodes read aloud as "Ana", "1", "slash",
        // "3" convey nothing, so the whole chip carries its own label.
        const label = node.getAttribute('aria-label');
        if (!label || !label.includes(s.name)) missingLabel++;
      });

      // The settled layout decision, as document order: totals sit BELOW the
      // trick, not pinned above it. Order in the tree is the only part of that
      // a fake DOM can see; the pinning is CSS and belongs to checkpoint 9.
      if (pub.phase === PHASES.PLAY) {
        const flat = walk(r.root);
        const trick = flat.findIndex((n) => n.hasClass && n.hasClass('trick-area'));
        const totals = flat.findIndex((n) => n.hasClass && n.hasClass('totals'));
        const dock = flat.findIndex((n) => n.hasClass && n.hasClass('hand-dock'));
        if (trick >= 0 && totals >= 0 && dock >= 0) {
          checkedOrder++;
          if (!(trick < totals && totals < dock)) ordering++;
        }
      }
    });
  }

  ok(chips > 0, `${chips} seat chips inspected`);
  eq(badPlay, 0, 'outside bidding every chip reads taken/bid');
  eq(badBidding, 0, 'during bidding it reads the bid alone');
  eq(slashInBidding, 0, 'and never shows a fraction before a card is played');
  eq(missingLabel, 0, 'every chip carries its own one-sentence accessible name');
  eq(ordering, 0, `the totals sit below the trick and above the hand (${checkedOrder} play frames)`);
}

// ===========================================================================
section('UI: what is not known yet is not drawn');
// ===========================================================================

// The turn-up's quieter cousin. Under a ROTATION the next round's trump is
// arithmetic on the round number, and telling people is the entire point of
// agreeing to play a rotation. Under the TURN-UP it genuinely is not known,
// by anybody, including the host — and a screen that fills the gap with
// trumpForRound() would be stating a fact that does not exist yet.
//
// Same question twice: once in the between-rounds line, once in the score
// pad's rail, where every unplayed round has a trump column to fill.
{
  let invented = 0, told = 0, honest = 0, mute = 0;
  let padInvented = 0, padDim = 0, padTold = 0, padWrong = 0, padRight = 0;
  const SUIT_WORDS = SUITS.map((s) => suitName(s));
  const GLYPHS = SUITS.map((s) => suitGlyph(s));

  for (const trumpMethod of TRUMP_METHODS) {
    const turnUp = needsTurnUp(trumpMethod);
    playMatch({
      config: { scoring: 'kachuful', trumpMethod, shape: 'descending', maxHand: 3 },
      players: 4, strategy: 'random', shuffleSeed: 3,
      onState: (g) => {
        if (g.phase !== PHASES.ROUND_OVER) return;
        const pub = g.publicState();
        if (pub.roundIndex + 1 >= pub.roundCount) return;
        const r = draw(baseApp({ pub, priv: g.privateStateFor('p0'), showPad: true }));

        const head = byClass(r.root, 'roundover-head')[0];
        const line = head ? head.text : '';
        const namesASuit = SUIT_WORDS.some((w) => line.includes(w));
        if (turnUp) {
          if (namesASuit) invented++;
          // SILENCE IS NOT HONESTY, and this is the half the first version of
          // this assertion was missing. Deleting the turn-up branch outright
          // leaves `Next: 3 cards · ` with an empty tail, because suitName()
          // of a null trump is the empty string — no suit named, so a test
          // that only counted suit words called that a pass. What the screen
          // owes the player is a STATEMENT that the trump is not decided yet;
          // a blank where a trump goes reads as a rendering fault.
          else if (/trump/i.test(line)) honest++;
          else mute++;
        } else if (namesASuit || line.includes('no trump')) told++;

        const body = byTag(byTag(r.root, 'table')[0], 'tbody')[0];
        byTag(body, 'tr').forEach((row, ri) => {
          const meta = byClass(row, 'r-meta')[0];
          if (!meta) return;
          const done = pub.history[ri];
          if (!done) {
            // Rounds not yet played: knowable under a rotation, not under the
            // turn-up.
            const showsSuit = GLYPHS.some((gl) => meta.text.includes(gl));
            if (turnUp) { if (showsSuit) padInvented++; else padDim++; } else if (showsSuit
              || meta.text.includes('NT')) padTold++;
            return;
          }
          // A ROUND THAT HAS BEEN PLAYED KNOWS ITS OWN TRUMP, and the pad must
          // read it off that round's history rather than recompute it. The two
          // agree under a rotation — which is precisely why this needs
          // asserting: a pad wired to the rotation looks perfect for two of the
          // three methods and goes blank for the third.
          const want = done.trump === NO_TRUMP ? 'NT'
            : (isTrumpSuit(done.trump) ? suitGlyph(done.trump) : null);
          if (want === null) return;
          if (meta.text.includes(want)) padRight++; else padWrong++;
        });
      },
    });
  }

  eq(invented, 0, 'under the turn-up, the next round is never given a trump it does not have');
  eq(mute, 0, 'nor is it left blank — the screen says the trump comes after the deal');
  ok(honest > 0, `and it says so in as many words (${honest} between-round screens)`);
  ok(told > 0, `while a rotation does name the next trump, which is the point of one (${told})`);
  eq(padInvented, 0, 'and the pad invents no trump for an unplayed round under the turn-up');
  ok(padDim > 0, `leaving it blank instead (${padDim} cells)`);
  ok(padTold > 0, `while a rotation fills the whole column in advance (${padTold} cells)`);
  eq(padWrong, 0, 'every PLAYED round shows the trump it was actually played under');
  ok(padRight > 0, `on all three methods (${padRight} settled rails checked)`);
}

// ===========================================================================
section('UI: the log reads newest first');
// ===========================================================================

// The reason anybody opens it is "what just happened", never "how did this
// match begin". The engine writes the log oldest-first and caps it at 60; the
// renderer reverses it and does NOT re-cap, because a second cap would be a
// second number to keep in step with the first.
//
// THE THRESHOLD IS THE POINT. An earlier version of this stopped as soon as
// the log passed SIX lines, and a mutation that made the renderer apply its
// own `slice(-20)` sailed straight through: with seven lines on screen, a cap
// of twenty is invisible. A test for "no second cap" has to be run against a
// log longer than the cap it is looking for, so this drives the match until
// the log is within spitting distance of the engine's own limit of 60.
{
  const LOG_LINES_WANTED = 40;
  const g = playMatchUntil({ config: UI_CONFIGS[0], players: 4 },
    (e) => e.publicState().log.length >= LOG_LINES_WANTED);
  const pub = g.publicState();
  const r = draw(baseApp({ pub, priv: g.privateStateFor('p0'), showLog: true }));
  const items = byTag(byClass(r.root, 'log')[0], 'li');

  eq(items.length, pub.log.length, 'every line the engine kept is drawn, and no more');
  ok(items.length >= LOG_LINES_WANTED,
    `and there are enough of them that a renderer-side cap would show (${items.length})`);
  eq(items[0].text, pub.log[pub.log.length - 1].text, 'the newest line is at the top');
  eq(items[items.length - 1].text, pub.log[0].text, 'and the oldest is at the bottom');

  // Reversed, not sorted or re-ordered: the whole sequence, backwards.
  //
  // Compared as JSON.stringify of the two arrays rather than by joining
  // them on a separator, for the reason js/util.js builds its log key the
  // same way: these strings are engine sentences made out of player names,
  // so any separator is only safe until somebody works out which one it is.
  // A raw control byte dodges that and creates a worse problem — it makes
  // grep call this entire file binary and refuse to search it.
  const drawn = JSON.stringify(items.map((n) => n.text));
  const want = JSON.stringify(pub.log.slice().reverse().map((l) => l.text));
  ok(drawn === want, 'and the order in between is the engine\'s, exactly reversed');

  // Reversing must not mutate the state it was handed — the renderer is a
  // pure view, and Array.reverse() in place on pub.log would corrupt the
  // engine's own log through a shared reference.
  const before = JSON.stringify(pub.log.map((l) => l.text));
  draw(baseApp({ pub, priv: g.privateStateFor('p0'), showLog: true }));
  eq(JSON.stringify(pub.log.map((l) => l.text)), before,
    'and rendering the log leaves the state it was given untouched');
}

// ===========================================================================
section('UI: nothing a peer can say becomes markup');
// ===========================================================================

// util.js's el() has no `html:` escape hatch — deliberately, and unlike
// sequence's version of the same helper. Every name on this screen arrives
// over a data channel from somebody nobody authenticated, so this is the
// assertion that keeps the omission honest. A name is a TEXT NODE, exactly,
// byte for byte, however it is spelled.
{
  const NASTY = [
    '<img src=x onerror=alert(1)>',
    '</script><script>alert(1)</script>',
    '<b>bold</b>',
    '"><svg onload=alert(1)>',
    "'; DROP TABLE seats;--",
    '&lt;already escaped&gt;',
    '‮reversed',
    'A'.repeat(MAX_NAME_LEN),
  ];

  let injected = 0, foundVerbatim = 0, foreignTags = 0;
  // Only the tags ui.js is supposed to build. Anything else in the tree got
  // there by being parsed out of a string, which is the failure this guards.
  const EXPECTED_TAGS = new Set(['main', 'div', 'span', 'p', 'h2', 'ul', 'li', 'button',
    'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'b', 'label', 'br', '#text']);

  for (const raw of NASTY) {
    const g = new GameEngine();
    // Through the engine's own cleanName, because that is the only way a name
    // can arrive — but the point stands whatever cleanName leaves behind.
    g.addPlayer('p0', raw, { isOwner: true, clientId: 'c0' });
    g.addPlayer('p1', 'Ben', { clientId: 'c1' });
    g.addPlayer('p2', 'Cleo', { clientId: 'c2' });
    const pub = g.publicState();
    const stored = pub.seats[0].name;

    for (const screen of ['game', 'home']) {
      const r = draw(baseApp({
        screen, pub, priv: g.privateStateFor('p0'), me: { name: stored },
      }));
      for (const n of walk(r.root)) {
        if (n.nodeType === 1 && !EXPECTED_TAGS.has(n.tag)) foreignTags++;
        if (n.nodeType === 3 && n.data === stored) foundVerbatim++;
      }
      // The name must arrive WHOLE and INERT, and there are exactly two inert
      // places it can land: a text node, or an attribute value.
      //
      // Both count, and the second is not a loophole. The home screen puts the
      // name in the name field's `value`, which reached the tree through
      // setAttribute — a string, stored as a string, never parsed. The first
      // run of this assertion looked only at text nodes and failed all eight
      // names on the home screen for exactly that reason: the assertion was
      // wrong, not the renderer. What matters is that the name is never
      // PARSED, not which of the two inert slots it lands in.
      const inert = walk(r.root).some((n) => (n.nodeType === 3 && n.data.includes(stored))
        || (n.nodeType === 1 && Object.values(n.attrs).some((v) => String(v).includes(stored))));
      if (stored && !inert) injected++;
    }
  }

  eq(foreignTags, 0, 'no string a peer controls ever becomes an element');
  eq(injected, 0, 'and every name survives into the tree verbatim, as text');
  ok(foundVerbatim > 0, `with the name found as a whole text node (${foundVerbatim} times)`);

  // The helper itself, from the other side: el() must not take an html option
  // even if somebody passes one. It becomes a plain attribute, which is inert.
  const probe = el('div', { html: '<b>x</b>' }, '<b>y</b>');
  eq(probe.children.length, 1, 'a string child is one node');
  eq(probe.children[0].nodeType, 3, 'and it is a text node');
  eq(probe.children[0].data, '<b>y</b>', 'holding the markup as literal text');
  eq(probe.getAttribute('html'), '<b>x</b>', "and `html:` is just an attribute, not an escape hatch");
}

// ===========================================================================
section('UI: the rules are one tap away, from every screen there is');
// ===========================================================================

// THE PROPERTY, AND WHY IT IS A PROPERTY AND NOT A SPOT CHECK.
//
// Judgement is a game people learn at the table, and the moment somebody needs
// the rules is the moment they are holding cards and it is their turn — not
// the moment they are on the home screen deciding whether to play. The control
// was originally inlined in wordmark(), which renders on home, join,
// connecting, error, hostleft and the lobby, and on NONE of the screens with
// cards on them. So it was reachable exactly when it was not needed, and the
// suite had nothing to say about it because nothing had been asserted.
//
// An assertion naming the play screen would have fixed the play screen and let
// the next screen somebody adds rot in the same way. Stated over every frame
// the renderer can produce, it cannot: sweepMatch covers the match from three
// points of view under three configs, sweepLobby covers the lobby at five
// table sizes, and the engineless screens are swept by hand.
{
  let frames = 0, missing = 0, extra = 0, unnamed = 0, gated = 0, noisy = 0;
  const firstMissing = [];

  // FOUND BY OPERATING IT, NOT BY LOOKING FOR A CLASS.
  //
  // `byClass(root, 'help-btn')` would be shorter and would be testing the
  // stylesheet. What has to be true is that a control exists which OPENS THE
  // RULES when a person presses it, so every interactive node in the frame is
  // pressed and the ones that produce a toggleRules call are the answer. That
  // also means a help button rendered `disabled` fails — domshim's click()
  // models the gate and fires nothing — which is right, because a control you
  // can see and cannot press is not a way in.
  const check = (app, where) => {
    frames++;
    const r = draw(app);
    const openers = [];
    for (const n of interactive(r.root)) {
      const before = r.calls.length;
      n.click();
      const fired = r.calls.slice(before).map((c) => c.name);
      if (fired.includes('toggleRules')) openers.push({ n, fired });
    }

    // Exactly one. Two would be a duplicate left behind by a refactor — the
    // wordmark's and the strip's both rendering, say — and that is worth
    // knowing because they will drift.
    if (openers.length === 0) {
      missing++;
      if (firstMissing.length < 4) firstMissing.push(where);
      return;
    }
    if (openers.length > 1) extra++;

    const { n, fired } = openers[0];
    // One thing per press. A help button that also toggled the pad would pass
    // a "can you reach the rules" check while doing something nobody asked for.
    if (fired.length !== 1) noisy++;
    // Named, because it renders as a bare "?" and a screen reader announcing
    // "question mark, button" has told the player nothing.
    if (!n.getAttribute('aria-label')) unnamed++;
    if (n.disabled) gated++;
  };

  // The screens with no engine behind them, including a screen name nothing
  // should ever set — that falls through to home, which has one.
  for (const screen of SCREENS) {
    check(baseApp({ screen, pub: null, priv: null, error: 'The room is full.' }), `screen ${screen}`);
  }

  sweepLobby((g, pub, priv, id) => {
    check(baseApp({ screen: 'game', pub, priv }), `lobby seats=${pub.seats.length} as ${id}`);
  });

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 4, (g, pub, priv, id) => {
      check(baseApp({ screen: 'game', pub, priv }), `${config.scoring}/${pub.phase} as ${id}`);
    });
  }

  // THE PAIRED POSITIVE. A bug in the sweep that produced no frames at all
  // would leave every counter below at zero and the section would read as a
  // clean pass. Silence is not honesty.
  ok(frames > 400, `${frames} frames drawn across every screen, phase, config and point of view`);
  eq(missing, 0, `and every one of them offers a way into the rules${
    firstMissing.length ? ` (missing: ${firstMissing.join('; ')})` : ''}`);
  eq(extra, 0, 'and exactly one way, never two that can drift apart');
  eq(noisy, 0, 'and pressing it does one thing');
  eq(unnamed, 0, 'and it carries an accessible name, because it renders as a bare "?"');
  eq(gated, 0, 'and it is never disabled — the rules are not a privilege');

  // Every phase the engine has actually appeared above, so "every screen" is a
  // claim about the real phase list rather than about the ones I remembered.
  // uiPhasesSeen is filled by sweepMatch itself.
  for (const phase of [PHASES.ROUND_DEAL, PHASES.TRUMP_REVEAL, PHASES.BIDDING,
    PHASES.PLAY, PHASES.ROUND_OVER, PHASES.MATCH_OVER]) {
    ok((uiPhasesSeen.get(phase) || 0) > 0, `and the sweep really did reach ${phase}`);
  }
}

// ===========================================================================
section('UI: everything reachable has a name, and every overlay a way out');
// ===========================================================================

{
  let controls = 0, nameless = 0, unspeakable = 0, sheets = 0, sheetsWithoutClose = 0;
  const firstUnspeakable = [];

  // A CONTROL LABELLED WITH A SYMBOL IS NOT LABELLED. "✕" announces as
  // "multiplication x, button" or, on some voices, as nothing at all — and the
  // glyph-only buttons are exactly the ones whose meaning is least guessable
  // from context: a kick button and a sheet close look identical to a screen
  // reader and do very different things. So the bar is not "has any text", it
  // is "has a name with a letter or a digit in it".
  //
  // The one deliberate exemption is a CARD, whose visible text is a rank and a
  // suit glyph — "7♠" already contains a digit, and every card button carries
  // a full aria-label besides.
  const speakable = (s) => /[\p{L}\p{N}]/u.test(s);

  const inspect = (app) => {
    const r = draw(app);
    for (const node of interactive(r.root)) {
      controls++;
      const label = node.getAttribute('aria-label');
      const text = node.text.trim();
      // Either a label or visible text. A button with neither is a button a
      // screen reader announces as "button".
      if (!label && !text) { nameless++; continue; }
      if (!speakable(label || text)) {
        if (firstUnspeakable.length < 3) firstUnspeakable.push(`<${node.tag}> "${label || text}"`);
        unspeakable++;
      }
    }
    // A modal with no close is a trap, and both of these cover the game.
    for (const sheet of byClass(r.root, 'sheet')) {
      sheets++;
      if (byClass(sheet, 'sheet-close').length === 0) sheetsWithoutClose++;
    }
  };

  // The lobby is in here because the kick button is in the lobby and nowhere
  // else, and it is the single most glyph-shaped control in the app.
  sweepLobby((g, pub, priv, id) => {
    inspect(baseApp({ pub, priv, isHost: id === 'p0' }));
    if (priv) inspect(baseApp({ pub, priv: { ...priv, isOwner: true }, isHost: true }));
  });

  for (const config of UI_CONFIGS) {
    sweepMatch(config, 5, (g, pub, priv, id) => {
      for (const showPad of [false, true]) {
        for (const showLog of [false, true]) {
          inspect(baseApp({ pub, priv, isHost: id === 'p0', showPad, showLog }));
        }
      }
    });
  }

  ok(controls > 0, `${controls} interactive nodes inspected`);
  eq(nameless, 0, 'every control has either an accessible label or visible text');
  if (unspeakable) console.error(`  ✗ glyph-only: ${firstUnspeakable.join(', ')}`);
  eq(unspeakable, 0, 'and that name is something a voice can read, not a bare symbol');
  ok(sheets > 0, `${sheets} overlays rendered`);
  eq(sheetsWithoutClose, 0, 'and every one of them has a close button');
}

// ===========================================================================
section('UI: every drawer has a way IN, not just a way out');
// ===========================================================================

// THE BUG THIS EXISTS FOR, AND WHY THE SECTION ABOVE DID NOT CATCH IT.
//
// toggleLog() had exactly one caller in the entire codebase: the ✕ inside the
// drawer it closes. main.js initialises showLog:false and nothing ever set it
// true, so sixty lines of engine history sat behind a door with the handle on
// the inside. The section above asks "does every overlay have a close?" and
// got a clean pass, because the close was the only thing that was ever there.
// A way out is not a way in, and the two have to be asserted separately.
//
// FOUND BY PRESSING, NOT BY LOOKING FOR A CLASS. byClass(root, 'strip-btn')
// would pass on a button that renders and does nothing. What has to be true
// is that a person pressing something OPENS the drawer, so every interactive
// node is pressed and the ones that fire the toggle are the answer.
//
// SCOPED BY WHAT THE FRAME RENDERS, NOT BY A LIST OF PHASE NAMES. Both
// openers live in the play strip, so the honest scope is "frames that have a
// play strip in them" — read out of the tree. A hardcoded phase list would
// need editing the day a screen gains or loses the strip, and would go stale
// silently, which is the whole failure mode this file keeps running into.
{
  const DRAWERS = [
    { name: 'the log', flag: 'showLog', toggle: 'toggleLog' },
    { name: 'the score pad', flag: 'showPad', toggle: 'togglePad' },
  ];

  // Press everything; return the controls that fired `toggle`, along with
  // whatever else they fired in the same press.
  const controlsFor = (app, toggle) => {
    const r = draw(app);
    const hits = [];
    for (const n of interactive(r.root)) {
      const before = r.calls.length;
      n.click();
      const fired = r.calls.slice(before).map((c) => c.name);
      if (fired.includes(toggle)) hits.push({ n, fired });
    }
    return hits;
  };

  const zero = () => Object.fromEntries(DRAWERS.map((d) => [d.toggle, 0]));
  const noWayIn = zero(), noWayOut = zero(), openers = zero();
  const unnamed = zero(), noisy = zero(), gated = zero(), reachable = zero();
  let stripFrames = 0, plainFrames = 0;
  const firstStuck = [];

  const check = (over, where) => {
    const shut = baseApp({ ...over, showLog: false, showPad: false });
    const hasStrip = byClass(draw(shut).root, 'play-strip').length > 0;
    if (hasStrip) stripFrames++; else plainFrames++;

    for (const d of DRAWERS) {
      const inward = controlsFor(shut, d.toggle);
      if (inward.length) reachable[d.toggle]++;
      if (!hasStrip) continue;

      if (inward.length === 0) {
        noWayIn[d.toggle]++;
        if (firstStuck.length < 4) firstStuck.push(`${d.name}, shut, at ${where}`);
        continue;
      }

      // MORE THAN ONE WAY IN IS ALLOWED, and the first draft of this section
      // asserted otherwise and failed 405 times. The pad has two openers on
      // purpose: the PAD button in the strip, always there, and the "full ▾"
      // link under the running totals, which is where you already are when
      // you want it. That is a good affordance, not a refactor leftover — so
      // the count is REPORTED rather than capped, and every opener is checked
      // rather than just the first, which is the thing a cap was standing in
      // for. (Contrast the help button one section up, where two really would
      // be wrong: it had drifted between the wordmark and the strip.)
      openers[d.toggle] += inward.length;
      for (const { n, fired } of inward) {
        if (fired.length !== 1) noisy[d.toggle]++;
        if (!n.getAttribute('aria-label') && !n.text.trim()) unnamed[d.toggle]++;
        if (n.disabled) gated[d.toggle]++;
      }

      // And out again, BEHAVIOURALLY. The structural check above finds a
      // `.sheet-close` node; this one presses whatever is there and requires
      // that the toggle actually fires. A close button wired to the wrong
      // intent passes the first check and traps the player.
      const open = baseApp({ ...over, showLog: false, showPad: false, [d.flag]: true });
      if (controlsFor(open, d.toggle).length === 0) {
        noWayOut[d.toggle]++;
        if (firstStuck.length < 8) firstStuck.push(`${d.name}, open, at ${where}`);
      }
    }
  };

  // The engineless screens and the lobby, which is where plainFrames comes
  // from: neither drawer is offered there and neither should be, so these
  // frames are what stops the scoping above from being the assertion.
  // Everything except 'game', which is the one screen here that needs an
  // engine behind it and gets swept separately below. 'nonsense' stays in:
  // it falls through to home, which offers no drawer either.
  for (const screen of SCREENS.filter((s) => s !== 'game')) {
    check({ screen, pub: null, priv: null }, `screen ${screen}`);
  }
  sweepLobby((g, pub, priv, id) => {
    check({ screen: 'game', pub, priv, isHost: id === 'p0' }, `lobby as ${id}`);
  });
  for (const config of UI_CONFIGS) {
    sweepMatch(config, 4, (g, pub, priv, id) => {
      check({ screen: 'game', pub, priv, isHost: id === 'p0' },
        `${config.scoring}/${pub.phase} as ${id}`);
    });
  }

  // THE PAIRED POSITIVES. Every count below is a "zero bad", and a sweep that
  // produced no strip frames at all would report all of them as clean.
  ok(stripFrames > 200, `${stripFrames} frames render the play strip`);
  ok(plainFrames > 0, `and ${plainFrames} do not, so the scope is a real filter`);
  for (const d of DRAWERS) {
    ok(reachable[d.toggle] > 0,
      `${d.name} can be opened from somewhere at all (${reachable[d.toggle]} frames)`);
    eq(noWayIn[d.toggle], 0, `and from every frame with a strip in it${
      firstStuck.length ? ` (stuck: ${firstStuck.join('; ')})` : ''}`);
    ok(openers[d.toggle] >= stripFrames,
      `${openers[d.toggle]} openers across ${stripFrames} strip frames — ${d.name}`);
    eq(noWayOut[d.toggle], 0, `and closed again by pressing something — ${d.name}`);
    eq(noisy[d.toggle], 0, `and every opener does one thing — ${d.name}`);
    eq(unnamed[d.toggle], 0, `and every one of them carries a name — ${d.name}`);
    eq(gated[d.toggle], 0, `and none is ever disabled — ${d.name} is not a privilege`);
  }

  // The drawers must be DIFFERENT controls. A single button wired to both
  // toggles would satisfy every count above while making the pad and the log
  // impossible to open independently.
  const anyStrip = (() => {
    let found = null;
    sweepMatch(UI_CONFIGS[0], 4, (g, pub, priv) => {
      if (!found && pub.phase === PHASES.PLAY) found = { pub, priv };
    });
    return found;
  })();
  ok(!!anyStrip, 'a play frame was captured for the cross-check');
  const shut = baseApp({ screen: 'game', ...anyStrip });
  const logBtn = controlsFor(shut, 'toggleLog')[0];
  const padBtn = controlsFor(shut, 'togglePad')[0];
  ok(logBtn && padBtn, 'both openers are present on it');
  // Compared by their accessible names, because the two presses above ran
  // against two separately-rendered trees and the node objects cannot be ===.
  ok(logBtn.n.getAttribute('aria-label') !== padBtn.n.getAttribute('aria-label'),
    'and they are two different controls, not one button wired to both');
}

console.log(`\n(the renderer sweep drew ${uiFrames} frames)`);

// ===========================================================================
section('The live region: everything the engine says gets said');
// ===========================================================================

// WHAT WAS WRONG. app.announce had exactly one assignment in all of main.js,
// inside copyCode(). A player using a screen reader heard "room code copied"
// and then nothing for the rest of the match — no bid, no card, no trick, no
// score. The log had all of it and was rendered into a drawer that, as the
// section above records, could not be opened either.
//
// announcementFor() is the decision, and it is in js/util.js rather than
// main.js precisely so it can be swept out here: main.js reaches for the DOM
// and localStorage at module scope and cannot be imported headless.
{
  // The impl's private notion of a line's identity, written out again on
  // purpose. This section is ABOUT that key — whether it is unique enough to
  // tell "nothing happened" from "it happened again" — so deriving it from
  // the thing under test would assert nothing.
  const triple = (l) => JSON.stringify([l.round, l.kind, l.text]);

  // --- the shape, at the edges ---------------------------------------------
  for (const empty of [null, undefined, [], 'nonsense', 42, {}]) {
    same(announcementFor(null, empty), { cursor: null, text: '' },
      `an absent log says nothing (${show(empty)})`);
    same(announcementFor('some-cursor', empty), { cursor: null, text: '' },
      `and forgets the cursor with it (${show(empty)})`);
  }
  // Junk entries are dropped rather than announced as "undefined".
  same(announcementFor(null, [{ round: 1, kind: 'bid' }, null, 7]),
    { cursor: null, text: '' }, 'an entry with no text is not a line');

  // --- the first call, and the one after it --------------------------------
  const three = [
    { round: 1, kind: 'join', text: 'Ana joined' },
    { round: 1, kind: 'join', text: 'Ben joined' },
    { round: 1, kind: 'round', text: 'Round 1, 3 cards' },
  ];
  const first = announcementFor(null, three);
  eq(first.text, 'Round 1, 3 cards', 'the FIRST call reads one line, not the whole log');
  eq(first.cursor, triple(three[2]), 'and parks on the newest line');

  const again = announcementFor(first.cursor, three);
  eq(again.text, '', 'the same log a second time is not news');
  eq(again.cursor, first.cursor, 'and the cursor does not move');

  const grown = [...three,
    { round: 1, kind: 'bid', text: 'Ana bids 2' },
    { round: 1, kind: 'bid', text: 'Ben bids 0' }];
  const next = announcementFor(first.cursor, grown);
  eq(next.text, 'Ana bids 2. Ben bids 0',
    'two lines in one push are both said, in order, with a full stop between');

  // --- falling off the back of the cap -------------------------------------
  // The engine caps the log at 60. A tab that was backgrounded through a whole
  // round comes back to a window that no longer contains the line it was on,
  // and the right answer is the newest line — not a sixty-line recap.
  const far = Array.from({ length: 60 }, (_, i) => (
    { round: 9, kind: 'play', text: `line ${i}` }));
  const behind = announcementFor(triple({ round: 1, kind: 'bid', text: 'long gone' }), far);
  eq(behind.text, 'line 59', 'a cursor that has scrolled off the cap gets the newest line only');
  eq(behind.cursor, triple(far[59]), 'and catches up');

  // --- a sentence that legitimately recurs ---------------------------------
  // "Ana bids 2" in round 1 and again in round 4 are different events, and the
  // round number in the key is what keeps them apart. Without it the second
  // one would be found by lastIndexOf and everything after it swallowed.
  const recur = [
    { round: 1, kind: 'bid', text: 'Ana bids 2' },
    { round: 4, kind: 'trick', text: 'Ana takes it' },
    { round: 4, kind: 'bid', text: 'Ana bids 2' },
  ];
  const r1 = announcementFor(triple(recur[0]), recur);
  eq(r1.text, 'Ana takes it. Ana bids 2',
    'the same sentence in a later round is said again, not skipped');

  // --- THE SAME KEY TWICE IN ONE ROUND, which is why it is lastIndexOf -----
  //
  // The case above does not actually test the choice: its two "Ana bids 2"
  // lines are in different rounds, so they have different keys and indexOf
  // and lastIndexOf return the same answer. Swapping one for the other left
  // the whole suite green — a mutation run is how that showed.
  //
  // A genuinely repeated (round, kind, text) needs the same event twice
  // inside one round, and the engine has one: drop, come back, drop again.
  // disconnect() says "<name> disconnected" every time, with the same kind
  // and the same round index, so the key repeats exactly.
  //
  // Standing on the SECOND one, the only news is what came after it. Rewind
  // to the first instead and the player hears the reconnect and the drop
  // read out all over again, which is worse than silence — it is a live
  // region confidently describing something that is not happening.
  const twice = [
    { round: 2, kind: 'leave', text: 'Ana disconnected' },
    { round: 2, kind: 'join', text: 'Ana reconnected' },
    { round: 2, kind: 'leave', text: 'Ana disconnected' },
    { round: 2, kind: 'trick', text: 'Ben takes it' },
  ];
  const dup = announcementFor(triple(twice[2]), twice);
  eq(dup.text, 'Ben takes it',
    'a cursor on a repeated key resumes from the LAST occurrence, not the first');
  eq(dup.cursor, triple(twice[3]), 'and moves on to the newest line');

  // ...and that the engine really can write that pair, rather than it being a
  // shape invented here to make a point. A test that guards against an
  // impossible input is a test nobody should keep.
  {
    const g = new GameEngine();
    seatTable(g, ['Ana', 'Ben', 'Cleo']);
    g.startMatch('p0', 0);
    const before = g.publicState().log.length;
    g.disconnect('p0');
    g.addPlayer('p0', 'Ana', { clientId: 'c0' });
    g.disconnect('p0');
    const fresh = g.publicState().log.slice(before).map(triple);
    ok(new Set(fresh).size < fresh.length,
      'the engine does write a repeated (round, kind, text) when a player drops twice in a round');
  }

  // --- swept over real matches ---------------------------------------------
  //
  // THE PROPERTY: replayed over every state the app is actually handed, every
  // line the engine writes is announced exactly once and in the order it was
  // written — except for the ones already in the log at the first frame,
  // which are deliberately skipped.
  //
  // "Which lines are new" is computed here by a DIFFERENT mechanism from the
  // one under test: a set of everything ever seen, against announcementFor's
  // cursor and lastIndexOf inside a sixty-line window. Two ways of answering
  // the same question, which is the only reason comparing them means anything.
  let states = 0, saidCalls = 0, mismatched = 0, adjacentDupes = 0, capMisses = 0;
  let linesSeen = 0, linesSaid = 0, skippedAtStart = 0;
  const firstMismatch = [];

  for (const config of UI_CONFIGS) {
    for (const players of [3, 5]) {
      let cursor = null, started = false;
      const seen = new Set();
      playMatch({
        config, players, strategy: 'random', shuffleSeed: 31 + players,
        onState: (g) => {
          states++;
          const log = g.publicState().log;

          // The assumption announcementFor() rests on, checked rather than
          // believed: no two adjacent entries share a key. If they ever did,
          // the second would read as "nothing happened" and go unsaid.
          for (let i = 1; i < log.length; i++) {
            if (triple(log[i]) === triple(log[i - 1])) adjacentDupes++;
          }

          const fresh = log.filter((l) => !seen.has(triple(l)));
          for (const l of fresh) seen.add(triple(l));
          linesSeen += fresh.length;

          const news = announcementFor(cursor, log);
          cursor = news.cursor;

          if (!started) {
            // The deliberate skip. Only the tail is said on the first frame.
            started = true;
            skippedAtStart += Math.max(0, fresh.length - 1);
            if (fresh.length) linesSaid += 1;
            if (news.text) saidCalls++;
            return;
          }
          if (fresh.length > 60) { capMisses++; return; }

          const expected = fresh.map((l) => l.text).join('. ');
          if (news.text !== expected) {
            mismatched++;
            if (firstMismatch.length < 3) {
              firstMismatch.push(`said ${JSON.stringify(news.text)} for ${JSON.stringify(expected)}`);
            }
          }
          linesSaid += fresh.length;
          if (news.text) saidCalls++;
        },
      });
    }
  }

  // THE PAIRED POSITIVES. Every "zero bad" above is satisfied by a sweep that
  // did nothing, so each one is bolted to a "many good".
  ok(states > 300, `${states} states replayed through the live region`);
  ok(linesSeen > 250, `and the engine wrote ${linesSeen} log lines across them`);
  ok(saidCalls > 150, `of which ${saidCalls} frames had something to announce`);
  eq(linesSaid + skippedAtStart, linesSeen,
    `and every line is accounted for — ${linesSaid} said, ${skippedAtStart} skipped as backlog`);
  eq(mismatched, 0, `and each announcement is exactly the new lines${
    firstMismatch.length ? ` (${firstMismatch.join('; ')})` : ''}`);
  eq(adjacentDupes, 0, 'no two adjacent log entries share a key, so none can be swallowed');
  eq(capMisses, 0, 'and no push ever carried more lines than the cap can hold');
  // The backlog skip is a real behaviour, not a branch that never runs.
  ok(skippedAtStart > 0, `${skippedAtStart} lines were already in the log at the first frame`);
}

// ===========================================================================
section('Room codes: four characters that survive being read aloud');
// ===========================================================================

// THE ALPHABET IS DERIVED HERE, NOT COPIED. Writing
// 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' out a second time would be a second copy
// of the one constant this whole section is about, and the two would agree
// right up until somebody edited one of them. normalizeCode() keeps exactly
// the characters in the alphabet and drops everything else, so asking it about
// every ASCII character in turn IS the alphabet, read out of the source of
// truth.
const CODE_CHARS = [];
for (let c = 0; c < 128; c++) {
  const n = normalizeCode(String.fromCharCode(c));
  if (n.length === 1 && !CODE_CHARS.includes(n)) CODE_CHARS.push(n);
}

{
  eq(CODE_CHARS.length, 32, 'the code alphabet is 32 characters');

  // THE DECISIVE LINE OF THE SECTION. generateRoomCode() does `random32 % n`
  // with no rejection loop, which is only unbiased when n divides 2^32. Drop
  // one more ambiguous letter to make it 31 and this fires immediately —
  // whereas the distribution check below would need millions of draws to
  // notice that some codes had become 3% likelier than others.
  eq(2 ** 32 % CODE_CHARS.length, 0,
    'and 2^32 divides by it exactly, so random32 % n carries no modulo bias');

  for (const ch of 'O0I1') {
    ok(!CODE_CHARS.includes(ch), `${ch} is absent — it is a look-alike and gets misheard`);
  }
  // The other half of that: a look-alike is DROPPED, never guessed at. A code
  // typed wrong by one character must fail to find a table, not find a
  // different one.
  eq(normalizeCode('O0I1'), '', 'the four look-alikes normalise to nothing at all');
  eq(normalizeCode('QROTX'), 'QRTX', 'and a stray O inside a code is removed, not read as a zero');
}

{
  const N = 20000;
  const expectedPerCell = N / CODE_CHARS.length;
  const seen = new Set();
  const byPos = [];
  for (let p = 0; p < CODE_LENGTH; p++) byPos.push(new Map());
  let badLength = 0, badChar = 0, notStable = 0;

  seed(20250922);
  for (let i = 0; i < N; i++) {
    const code = generateRoomCode();
    if (code.length !== CODE_LENGTH) badLength++;
    for (let p = 0; p < code.length; p++) {
      const ch = code[p];
      if (!CODE_CHARS.includes(ch)) badChar++;
      byPos[p].set(ch, (byPos[p].get(ch) || 0) + 1);
    }
    // A generated code that does not survive its own normaliser would mean a
    // host listening on one address and printing another.
    if (normalizeCode(code) !== code) notStable++;
    seen.add(code);
  }

  eq(badLength, 0, `all ${N} generated codes are exactly ${CODE_LENGTH} characters`);
  eq(badChar, 0, 'and every character of every one of them is in the alphabet');
  eq(notStable, 0, 'and every generated code normalises to itself');

  // Empirical backstop to the arithmetic above. Not a substitute for it — a
  // bias small enough to matter is invisible at this sample size — but it does
  // catch the gross failures: a position that never varies, a character that
  // can never be drawn.
  let thinnest = Infinity, fattest = 0, positionsShort = 0;
  for (const counts of byPos) {
    if (counts.size !== CODE_CHARS.length) positionsShort++;
    for (const n of counts.values()) {
      if (n < thinnest) thinnest = n;
      if (n > fattest) fattest = n;
    }
  }
  eq(positionsShort, 0, 'every one of the four positions draws all 32 characters');
  ok(thinnest > expectedPerCell * 0.6 && fattest < expectedPerCell * 1.6,
    `and no character dominates a position (expected ${expectedPerCell}, saw ${thinnest}–${fattest})`);
  ok(seen.size > N * 0.97,
    `${seen.size} distinct codes out of ${N} draws — collisions are birthday-rate, not clustering`);
}

// Everything a code field can be handed: pasted, fat-fingered, or not a string
// at all. Reused by the peer-id section below, because "what is a code" and
// "what is an address" have to agree about every one of these.
const CODE_FUZZ = [
  '', 'A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEFGH',
  'qrtx', 'QR-TX', 'qr tx', 'q r t x', '  QRTX  ', 'QRTX\n', '\tQRTX',
  'O0I1', 'OIL', 'QROTX', 'Q0R1TX', '////', '____', '....', '@@@@',
  '🂡🂢🂣', 'ＱＲＴＸ', 'àéîõü', 'ЙЦУК', '<script>alert(1)</script>',
  '__proto__', 'constructor', 'prototype', 'judgement-v1-QRTX',
  'A'.repeat(100000),
  null, undefined, 0, 1, -1, NaN, Infinity, false, true,
  {}, [], [1, 2], ['Q', 'R'], () => 'QRTX', new Date(0),
];

{
  let threw = 0, notString = 0, tooLong = 0, foreignChar = 0, notIdempotent = 0, caseSensitive = 0;
  for (const raw of CODE_FUZZ) {
    let out;
    try { out = normalizeCode(raw); } catch (_) { threw++; continue; }
    if (typeof out !== 'string') { notString++; continue; }
    if (out.length > CODE_LENGTH) tooLong++;
    for (const ch of out) if (!CODE_CHARS.includes(ch)) foreignChar++;
    if (normalizeCode(out) !== out) notIdempotent++;
    // A code read aloud is typed in whatever case the typer's keyboard is in.
    if (typeof raw === 'string' && normalizeCode(raw.toLowerCase()) !== normalizeCode(raw.toUpperCase())) {
      caseSensitive++;
    }
  }
  eq(threw, 0, `normalizeCode survives all ${CODE_FUZZ.length} hostile inputs without throwing`);
  eq(notString, 0, 'and always hands back a string');
  eq(tooLong, 0, `never longer than ${CODE_LENGTH}`);
  eq(foreignChar, 0, 'never containing a character outside the alphabet');
  eq(notIdempotent, 0, 'and normalising twice changes nothing');
  eq(caseSensitive, 0, 'case is irrelevant, so a code read aloud can be typed either way');

  // The paste cases spelled out, because these are the ones a person actually
  // hits and a regression in any of them is a table nobody can join.
  eq(normalizeCode('QR-TX'), 'QRTX', 'a hyphen inside a pasted code is stripped');
  eq(normalizeCode('qr tx'), 'QRTX', 'so is a space, and lowercase is lifted');
  eq(normalizeCode('  QRTX  '), 'QRTX', 'so is surrounding whitespace');
  eq(normalizeCode('A'.repeat(100000)), 'AAAA', 'and a long string stops at the fourth character');
}

// ===========================================================================
section('Peer ids: the address, and a namespace nobody can climb out of');
// ===========================================================================

{
  seed(31);
  let roundTripBad = 0;
  for (let i = 0; i < 2000; i++) {
    const code = generateRoomCode();
    const id = peerIdForCode(code);
    if (id !== PEER_PREFIX + code) roundTripBad++;
    if (codeFromPeerId(id) !== code) roundTripBad++;
  }
  eq(roundTripBad, 0, 'a generated code becomes an address and comes back unchanged');

  let shapeBad = 0, dialledJunk = 0;
  for (const raw of CODE_FUZZ) {
    const want = normalizeCode(raw);
    const id = peerIdForCode(raw);
    if (want.length === CODE_LENGTH) {
      if (id !== PEER_PREFIX + want) shapeBad++;
      if (codeFromPeerId(id) !== want) shapeBad++;
    } else if (id !== null) {
      // The failure this prevents: every joiner who typed something unusable
      // dials the bare prefix, which is the SAME address for all of them, and
      // two people fat-fingering the field at once end up in a room together.
      dialledJunk++;
    }
  }
  eq(shapeBad, 0, 'anything that normalises to a full code resolves to its address');
  eq(dialledJunk, 0, 'and anything that does not resolves to null rather than to a shared address');

  // Namespacing. The public broker is shared with every other PeerJS app on the
  // internet, and specifically with `courtpiece`, which mints four characters
  // from the same alphabet with the same function.
  eq(codeFromPeerId('QRTX'), null, 'a bare four-character id is not one of ours');
  eq(codeFromPeerId('courtpiece-v1-QRTX'), null, 'and neither is the sibling game at the same code');
  eq(codeFromPeerId('sequence-v1-QRTX'), null, 'nor the other sibling');
  eq(codeFromPeerId(''), null, 'nor the empty string');
  eq(codeFromPeerId(null), null, 'nor a non-string');
  ok(PEER_PREFIX.includes('judgement'), 'the prefix names this game');
  ok(/-v\d+-$/.test(PEER_PREFIX),
    'and carries a protocol version, so an incompatible build fails to find a table rather than joining one');
}

{
  // The bot id shape is read out of the engine rather than typed here, for the
  // same reason the alphabet was: net.js guards against a collision with it at
  // module load, and a hand-typed 'bot:' in the test would keep passing after
  // state.js renamed them.
  const botLab = new GameEngine();
  botLab.addPlayer('p0', 'Ana', { clientId: 'c0', isOwner: true });
  botLab.addBot('p0');
  const BOT_ID = botLab.seats[1].id;
  ok(BOT_ID.startsWith('bot:'), `the engine mints bot ids like ${BOT_ID}`);

  // A joiner picks its own peer id: `new Peer('whatever')`. The host learns it
  // as conn.peer. Every one of these is a name a hostile peer would choose.
  const HOSTILE_CONN_IDS = [
    HOST_ID, HOST_ID.toUpperCase(), BOT_ID, 'bot:0', 'bot:6',
    CONN_ID_PREFIX, CONN_ID_PREFIX + HOST_ID, CONN_ID_PREFIX + BOT_ID,
    '', ' ', '0', 'null', 'undefined', 'NaN',
    '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
    'anon-1', 'judgement-v1-QRTX', 'peer:peer:host',
    'x'.repeat(64), 'x'.repeat(200), 'hôst', 'h​ost',
  ];

  let escaped = 0, becameHost = 0, becameBot = 0, lostConnId = 0;
  for (const raw of HOSTILE_CONN_IDS) {
    const pid = playerIdForConn(raw);
    if (!pid.startsWith(CONN_ID_PREFIX)) escaped++;
    if (pid === HOST_ID) becameHost++;
    if (pid.startsWith('bot:')) becameBot++;
    // The prefix has to be removable again, or sendTo() cannot find the
    // connection it is supposed to answer.
    if (connIdForPlayer(pid) !== raw) lostConnId++;
  }
  eq(escaped, 0, `all ${HOSTILE_CONN_IDS.length} chosen peer ids land inside the peer namespace`);
  eq(becameHost, 0, 'none of them becomes the host');
  eq(becameBot, 0, 'none of them becomes a bot');
  eq(lostConnId, 0, 'and every one of them can be turned back into its connection');

  // The other direction: the two local id kinds are not addressable, and a
  // caller reads that null as "there is nothing to send to", which is right for
  // both of them.
  eq(connIdForPlayer(HOST_ID), null, 'the host itself is not a connection');
  eq(connIdForPlayer(BOT_ID), null, 'and neither is a bot');
  for (const junk of [null, undefined, 0, 42, {}, [], NaN, true]) {
    eq(connIdForPlayer(junk), null, `connIdForPlayer(${JSON.stringify(junk)}) is null, not a crash`);
  }

  // net.js asserts this at module load, in the browser, on first paint. Here it
  // is as a test too, because a throw during an import is a blank page and the
  // point is to find out at build time instead.
  ok(validPlayerId(HOST_ID) !== null, 'HOST_ID is something guards.js would accept');
  ok(!HOST_ID.startsWith(CONN_ID_PREFIX) && !BOT_ID.startsWith(CONN_ID_PREFIX),
    'and neither local id sits inside the namespace the transport hands out');
}

// ===========================================================================
section('The wire: three frame types, each written and read by one pair');
// ===========================================================================

{
  // JOIN. The asymmetry between the two fields is the thing being asserted: a
  // bad name refuses the frame, a bad clientId is dropped and the join goes on.
  const GOOD_NAMES = ['Ana', 'Ben', '  Cleo  ', 'Dev the Third', '🂡', 'x'.repeat(256)];
  const GOOD_IDS = ['abcdefgh', 'a'.repeat(64), '0123456789abcdef0123456789abcdef', 'A-b_c-d_1'];
  let joinBad = 0;
  for (const name of GOOD_NAMES) {
    for (const cid of GOOD_IDS) {
      const read = readJoinFrame(joinFrame(name, cid));
      if (!read || read.name !== name || read.clientId !== cid) joinBad++;
    }
  }
  eq(joinBad, 0, `a hello round-trips for all ${GOOD_NAMES.length * GOOD_IDS.length} name/ticket pairs`);

  for (const bad of ['', null, undefined, 42, {}, [], 'x'.repeat(257)]) {
    eq(readJoinFrame(joinFrame(bad, 'abcdefgh')), null,
      `a hello with no usable name is refused (${JSON.stringify(bad)?.slice(0, 20)})`);
  }
  for (const bad of ['', null, undefined, 42, 'short', 'x'.repeat(65), 'has space', 'has.dot', {}]) {
    const read = readJoinFrame(joinFrame('Ana', bad));
    ok(read !== null && read.name === 'Ana' && read.clientId === null,
      `a hello with an unusable ticket still seats the player, ticketless (${JSON.stringify(bad)?.slice(0, 20)})`);
  }

  // Not a hello at all.
  for (const notJoin of [null, undefined, '', 'join', 0, [], [WIRE.JOIN],
    { type: WIRE.STATE }, { type: WIRE.REJECTED }, { type: 'placeBid' }, { name: 'Ana' }]) {
    eq(readJoinFrame(notJoin), null, `readJoinFrame refuses ${JSON.stringify(notJoin)}`);
  }
}

{
  // stateFrameFor is where "never send a player another player's cards" is
  // actually written down, so the assertion is on THE CALL and not on the
  // result. A version that asked privateFor() for the wrong id but happened to
  // be handed a plausible answer would pass a result-shaped check.
  const asked = [];
  const frame = stateFrameFor('conn-42', { phase: 'lobby' }, (id) => { asked.push(id); return { seat: 3 }; });
  same(asked, [playerIdForConn('conn-42')],
    'pushState asks privateFor() for the prefixed id of the connection it is about to send to');
  eq(asked.length, 1, 'exactly once per frame');
  eq(frame.type, WIRE.STATE, 'and the frame is a state frame');
  same(frame.priv, { seat: 3 }, 'carrying the answer it was given');

  // undefined is not null on the wire. JSON.stringify DROPS an undefined value,
  // so without the `|| null` the key vanishes from the frame entirely and "you
  // have no hand" arrives as "the hand key is missing".
  const seatless = JSON.parse(JSON.stringify(stateFrameFor('conn-9', { phase: 'lobby' }, () => undefined)));
  ok('priv' in seatless, 'a seatless device gets a priv key that survives serialisation');
  eq(seatless.priv, null, 'and its value is an explicit null');
}

{
  // readStateFrame has to accept every frame the host legitimately produces —
  // and SILENCE IS NOT HONESTY here, so the accept count is asserted as well as
  // the reject count. A reader that refused everything would pass a
  // "nothing malformed got through" check on its own.
  let offered = 0, accepted = 0, refused = 0, privSeen = 0;
  for (const config of UI_CONFIGS) {
    sweepMatch(config, 5, (g, pub, priv, id) => {
      offered++;
      const wire = JSON.parse(JSON.stringify(stateFrameFor(
        connIdForPlayer(playerIdForConn(id)), pub, () => priv)));
      const read = readStateFrame(wire);
      if (!read) { refused++; return; }
      accepted++;
      if (read.priv) privSeen++;
      // The seatless view in UI_VIEWS is the null case, and it must come back
      // as null rather than as a refusal.
      if (priv === null && read.priv !== null) refused++;
    });
  }
  ok(offered > 500, `${offered} real host frames were put through the client's reader`);
  eq(accepted, offered, 'and every single one of them was accepted');
  eq(refused, 0, 'with nothing refused and no seatless view mistaken for a malformed one');
  ok(privSeen > offered / 3, `${privSeen} of them carried a private half`);

  const REAL_PUB = { phase: 'lobby', seats: [], plays: [], log: [], plan: [], history: [],
    leaders: [], tricks: [], config: {}, dealerSeat: 0, leadSeat: 0, turnSeat: 0, trickIndex: 0 };
  ok(readStateFrame({ type: WIRE.STATE, pub: REAL_PUB, priv: null }) !== null,
    'the first frame of a session — an empty lobby, nobody seated — is accepted');

  // The malformed ones. Each is a thrown TypeError inside render(), and since
  // render() opens with clear(root) that is a blank page with no way back.
  const BAD_STATE_FRAMES = [
    null, undefined, '', 0, [], { type: WIRE.STATE },
    { type: WIRE.JOIN, pub: REAL_PUB },
    { type: WIRE.STATE, pub: null },
    { type: WIRE.STATE, pub: 'lobby' },
    { type: WIRE.STATE, pub: [] },
    { type: WIRE.STATE, pub: { ...REAL_PUB, seats: 7 } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, seats: new Array(9999).fill({}) } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, plays: null } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, log: 'none' } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, config: null } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, turnSeat: '__proto__' } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, turnSeat: -1 } },
    { type: WIRE.STATE, pub: { ...REAL_PUB, phase: 'x'.repeat(500) } },
    { type: WIRE.STATE, pub: REAL_PUB, priv: 'mine' },
    { type: WIRE.STATE, pub: REAL_PUB, priv: { hand: 'AS' } },
    { type: WIRE.STATE, pub: REAL_PUB, priv: { hand: [], seat: -1, bidOptions: null } },
    { type: WIRE.STATE, pub: REAL_PUB, priv: { hand: [], seat: 0, bidOptions: 3 } },
  ];
  let leaked = 0;
  for (const bad of BAD_STATE_FRAMES) {
    let out;
    try { out = readStateFrame(bad); } catch (_) { leaked++; continue; }
    if (out !== null) leaked++;
  }
  eq(leaked, 0, `all ${BAD_STATE_FRAMES.length} malformed state frames are refused, none throws`);
}

{
  // REJECTED. One sentence for a human, capped, and never empty.
  eq(rejectFrame('Enter a name first.').message, 'Enter a name first.', 'a refusal carries its reason');
  eq(rejectFrame('x'.repeat(5000)).message.length, MAX_REJECT_LEN,
    `and a hostile one is cut to ${MAX_REJECT_LEN} characters before it reaches the banner`);
  eq(readRejectFrame(rejectFrame('x'.repeat(5000))).length, MAX_REJECT_LEN,
    'the reader caps it too, so a frame built elsewhere cannot get past it');

  // An error banner with nothing in it is worse than a vague one: it says
  // something went wrong and then refuses to say what.
  const EMPTYISH = [undefined, null, '', '   ', '\n\t', 42, {}, [], true];
  let blank = 0;
  for (const junk of EMPTYISH) {
    const out = readRejectFrame({ type: WIRE.REJECTED, message: junk });
    if (typeof out !== 'string' || out.trim() === '') blank++;
    const viaBuilder = readRejectFrame(rejectFrame(junk));
    if (typeof viaBuilder !== 'string' || viaBuilder.trim() === '') blank++;
  }
  eq(blank, 0, 'a refusal with no usable message still reads as a sentence, never as an empty banner');

  for (const notReject of [null, undefined, '', 'rejected', 0, [],
    { type: WIRE.STATE }, { type: WIRE.JOIN }, { message: 'no type' }]) {
    eq(readRejectFrame(notReject), null, `readRejectFrame refuses ${JSON.stringify(notReject)}`);
  }

  // The whole protocol, and every type in it has to be a different string or
  // a reader would answer the wrong question.
  //
  // COUNTED AGAINST ITSELF, not against a number typed here. This assertion
  // used to read `3`, and the fourth type landing turned a real property —
  // "they are all distinct" — into a failing arithmetic check that says
  // nothing about distinctness at all. The count is printed so the growth is
  // still visible in the output; it is just not the thing being asserted.
  eq(new Set(Object.values(WIRE)).size, Object.keys(WIRE).length,
    `all ${Object.keys(WIRE).length} wire types are distinct strings`);
  ok(Object.isFrozen(WIRE), 'and the vocabulary is frozen');
  for (const t of Object.values(WIRE)) {
    ok(!GAME_INTENTS.includes(t), `'${t}' is not also a game intent — the two vocabularies do not overlap`);
  }
}

{
  // REPLACED. Last words to a connection whose seat has just gone to another
  // connection holding the same ticket. Carries nothing; the fact IS the frame.
  ok(isReplacedFrame(replacedFrame()), 'the replaced pair round-trips');
  eq(Object.keys(replacedFrame()).length, 1,
    'and the frame is a type and nothing else — no field to be suspicious of');

  // IT MUST NOT ANSWER TO ANY OTHER FRAME, and the three it shares a wire with
  // are the ones that matter: a state frame read as "you have been replaced"
  // is a player thrown off a table they are sitting at.
  const NOT_REPLACED = [
    null, undefined, '', 0, false, [], {}, 'replaced',
    { type: WIRE.STATE }, { type: WIRE.JOIN }, { type: WIRE.REJECTED },
    { type: 'playCard' }, { type: 'placeBid' },
    { replaced: true }, { type: null }, { type: ['replaced'] },
  ];
  let wrongly = 0;
  for (const junk of NOT_REPLACED) {
    let out;
    try { out = isReplacedFrame(junk); } catch (_) { wrongly++; continue; }
    if (out !== false) wrongly++;
  }
  eq(wrongly, 0, `none of the ${NOT_REPLACED.length} non-replaced values is read as one, and none throws`);

  // WHAT IS DELIBERATELY NOT IN THAT LIST: an object with an INHERITED type,
  // Object.create({ type: WIRE.REPLACED }). `msg.type` finds it and the
  // predicate says yes. That was in the list for one draft as a tightening
  // worth making, and it is not one: decodePeerFrame() hands on JSON.parse
  // output, whose prototype is Object.prototype and never carries a `type`,
  // so nothing that reaches any reader in this file can have one. Adding the
  // check HERE and not to the other three would also make this the only
  // reader with its own idea of what an object is. Recorded rather than
  // deleted, because the next person to think of it deserves the answer.
  ok(isReplacedFrame(Object.create({ type: WIRE.REPLACED })) === true,
    'an inherited type reads as a frame — matching the other three readers, and unreachable from the wire');

  // AND IT SURVIVES THE WIRE. Every frame is JSON in both directions, so a
  // builder that produced something JSON cannot carry would be caught here
  // and nowhere else.
  ok(isReplacedFrame(JSON.parse(JSON.stringify(replacedFrame()))),
    'and it still reads as one after a round trip through JSON');

  // The other readers must not claim it. readRejectFrame() is the dangerous
  // one: it is the fallback in main.js's onData, and if it answered to this
  // the player would get an empty error banner instead of the screen.
  eq(readRejectFrame(replacedFrame()), null, 'the refusal reader does not claim it');
  eq(readStateFrame(replacedFrame()), null, 'nor does the state reader');
  eq(readJoinFrame(replacedFrame()), null, 'nor the hello reader');
}

// ===========================================================================
section('Storage: one prefix, one ticket, and the key that is never cleared');
// ===========================================================================

// Everything from here to the end of the storage section runs on a clock the
// test drives, because the TTL work below asks what localStorage looks like
// nine hours from now. It is restored at the end of the section — the live
// transport section installs its own.
const storeClock = installClock();

// The key names are written out here ON PURPOSE, unlike the code alphabet and
// the bot prefix. They are not internal constants that may be renamed freely:
// they are the on-disk format, shared with two sibling games on one origin, and
// changing one silently orphans every device that already has it. A test that
// derived them from the source would go green on exactly the change that
// matters.
const CLIENT_KEY = 'judgement.clientId';
const SESSION_KEY = 'judgement.session';
const ENGINE_KEY = 'judgement.engine';

{
  const storage = installStorage();

  // The whole storage surface, driven once, so the prefix assertion below sees
  // every key this app can possibly write.
  saveName('Ana');
  saveCode('QRTX');
  saveSession({ mode: 'host', code: 'QRTX', name: 'Ana' });
  saveEngineSnapshot({ v: 1, phase: 'lobby' });
  const id = clientId();

  const keys = storage.store.keys().slice().sort();
  ok(keys.length >= 5, `the app writes ${keys.length} keys: ${keys.join(', ')}`);
  // THE PREFIX IS NOT COSMETIC. sequence, courtpiece and this are sibling paths
  // on one GitHub Pages origin and therefore share one localStorage. A bare
  // 'name' key would be three games arguing over one string.
  const unprefixed = keys.filter((k) => !k.startsWith('judgement.'));
  same(unprefixed, [], 'and every one of them is prefixed judgement.');

  eq(loadName(), 'Ana', 'a name round-trips');
  eq(loadCode(), 'QRTX', 'so does the last room code');
  eq(loadSession().mode, 'host', 'so does a session');
  same(loadEngineSnapshot(), { v: 1, phase: 'lobby' }, 'so does an engine snapshot');

  // --- the ticket ---------------------------------------------------------
  ok(validClientId(id) !== null, `clientId() mints something guards.js accepts (${id.length} chars)`);
  eq(/^[0-9a-f]{32}$/.test(id), true, 'and it is 32 hex characters — 128 bits');
  eq(storage.store.raw.get(CLIENT_KEY), id, `stored under ${CLIENT_KEY}`);
  eq(clientId(), id, 'and reading it again returns the same one, not a fresh one');
  eq(clientId(), id, 'and again');

  // GENERATED ONCE AND NEVER REGENERATED is the rule that makes reclaim work,
  // so the destructive operations are each asked about it by name.
  clearSession();
  eq(clientId(), id, 'clearSession() does not touch the ticket');
  eq(storage.store.raw.has(SESSION_KEY), false, 'it does clear the session');
  eq(storage.store.raw.has(ENGINE_KEY), false, 'and the engine snapshot with it');
  eq(loadName(), 'Ana', 'and it leaves the remembered name alone, which is not room state');

  // A tampered ticket is REPLACED rather than sent. The class matches
  // validClientId() exactly, so a value that would be refused on arrival can
  // never be minted or resurrected here.
  for (const junk of ['', 'short', 'x'.repeat(65), 'has space', 'has.dot', 'has/slash', '<b>']) {
    storage.store.raw.set(CLIENT_KEY, junk);
    const fresh = clientId();
    ok(validClientId(fresh) !== null, `a stored ticket of ${JSON.stringify(junk)} is replaced with a valid one`);
    eq(storage.store.raw.get(CLIENT_KEY), fresh, 'and the replacement is written back');
  }
  // A VALID stored ticket is honoured untouched, including one minted by an
  // older build that did not look like ours.
  for (const older of ['abcdefgh', 'A-b_c-d_1', 'x'.repeat(64)]) {
    storage.store.raw.set(CLIENT_KEY, older);
    eq(clientId(), older, `an existing ticket ${JSON.stringify(older)} is kept exactly as it is`);
  }

  // Entropy. Not a proof of anything cryptographic — the suite's crypto is a
  // seeded PRNG — but it does catch a mint that has collapsed to a constant or
  // to a counter, which is the failure that would silently give two devices at
  // one table the same seat.
  seed(4242);
  const minted = new Set();
  for (let i = 0; i < 5000; i++) {
    storage.store.raw.delete(CLIENT_KEY);
    minted.add(clientId());
  }
  eq(minted.size, 5000, '5000 freshly minted tickets are 5000 different tickets');

  storage.restore();
}

{
  // A TICKET IS NEVER ON THE WIRE except in the hello that carries it to the
  // host. It must not be in publicState, in a private state, or in a state
  // frame — judgement's publicState does not publish player ids at all, and
  // this is the assertion that keeps it that way.
  const g = new GameEngine();
  const TICKETS = ['ticket-aaaa-0001', 'ticket-bbbb-0002', 'ticket-cccc-0003', 'ticket-dddd-0004'];
  ['Ana', 'Ben', 'Cleo', 'Dev'].forEach((n, i) => {
    g.addPlayer(playerIdForConn(`conn-${i}`), n, { clientId: TICKETS[i] });
  });
  g.setConfig(playerIdForConn('conn-0'), { maxHand: 3 });
  g.startMatch(playerIdForConn('conn-0'), 0);

  let leaks = 0;
  for (let i = 0; i < 4; i++) {
    const frame = JSON.stringify(stateFrameFor(`conn-${i}`, g.publicState(), (id) => g.privateStateFor(id)));
    for (const t of TICKETS) if (frame.includes(t)) leaks++;
    // The player id is a routing key and is allowed on the wire; the ticket is
    // not. Checked separately so a failure says which of the two went out.
    if (frame.includes('conn-')) leaks++;
  }
  eq(leaks, 0, 'no seat ticket and no player id appears in any state frame');
  // The snapshot is the opposite case and the contrast is the point: it holds
  // every hand and every ticket, and is written to the host's own disk only.
  ok(JSON.stringify(g.serialize()).includes(TICKETS[0]),
    'the host\'s own engine snapshot does hold them — which is why it never goes on the wire');
}

{
  const storage = installStorage();

  // --- the snapshot is the whole game -------------------------------------
  // A host reloading in round fourteen must not end nineteen rounds of scoring
  // for six people, so the round trip is asserted against the FULL serialise,
  // hands and stock and log included, not against a spot check of the phase.
  const live = playMatchUntil({ config: UI_CONFIGS[0], players: 5 },
    (e) => e.phase === PHASES.PLAY && e.roundIndex >= 1 && e.plays.length > 0);
  const before = live.serialize();
  saveEngineSnapshot(before);

  const rebuilt = new GameEngine();
  const r = rebuilt.restore(loadEngineSnapshot());
  ok(r.ok !== false, 'a stored snapshot restores');

  // `connected` is the ONE field that legitimately differs, and the difference
  // is the point of the whole checkpoint: a restored host holds no
  // connections, so every human comes back marked gone and has to reclaim.
  // Six green dots over a table of nobody would stop the owner realising they
  // need to re-share the code. Asserted explicitly, then excluded from the
  // deep comparison so that it is the only thing excluded.
  eq(rebuilt.seats.filter((s) => !s.isBot && s.connected).length, 0,
    'every human seat comes back marked disconnected, waiting to be reclaimed');
  eq(rebuilt.seats.length, live.seats.length, 'with no seat lost or renumbered');
  const noConnFlag = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'connected' ? undefined : v)));
  same(noConnFlag(rebuilt.serialize()), noConnFlag(before),
    'and in every other respect the rebuilt engine serialises back to the identical object');
  same(noConnFlag(rebuilt.publicState()), noConnFlag(live.publicState()),
    'the public state it publishes is identical too');
  for (let s = 0; s < live.seats.length; s++) {
    same(rebuilt.privateStateFor(live.seats[s].id), live.privateStateFor(live.seats[s].id),
      `and seat ${s} gets back exactly the hand, bid and running total it had`);
  }

  // --- the TTL, found rather than bracketed --------------------------------
  // Bisected instead of poked at 7h59 and 8h01, because a bracket proves only
  // that the boundary is somewhere in an hour-wide gap. This reports the
  // number, so a TTL that drifted to seven hours fails with the value in the
  // message rather than with "expected true".
  const ageSurvives = (ageMs, key, load) => {
    storage.store.raw.set(key, JSON.stringify(
      key === SESSION_KEY ? { mode: 'host', ts: Date.now() - ageMs } : { snap: { v: 1 }, ts: Date.now() - ageMs },
    ));
    return load() !== null;
  };
  const boundaryOf = (key, load) => {
    let lo = 0, hi = 48 * 60 * 60 * 1000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (ageSurvives(mid, key, load)) lo = mid; else hi = mid;
    }
    return lo;
  };
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;
  eq(boundaryOf(SESSION_KEY, loadSession), EIGHT_HOURS, 'a session lasts exactly eight hours');
  eq(boundaryOf(ENGINE_KEY, loadEngineSnapshot), EIGHT_HOURS,
    'and the snapshot expires on the same clock — the two are one thing, and a snapshot that '
    + 'outlived its session would rehydrate a table with nothing to reconnect to');

  // The side effect matters as much as the verdict: an expired session takes
  // the snapshot with it, so the pair cannot get out of step.
  storage.store.raw.set(SESSION_KEY, JSON.stringify({ mode: 'host', ts: Date.now() - EIGHT_HOURS - 1 }));
  storage.store.raw.set(ENGINE_KEY, JSON.stringify({ snap: { v: 1 }, ts: Date.now() }));
  eq(loadSession(), null, 'a session past its TTL reads as absent');
  eq(storage.store.raw.has(SESSION_KEY), false, 'and is deleted rather than left to be re-read');
  eq(storage.store.raw.has(ENGINE_KEY), false, 'and takes its snapshot with it');
  eq(clientId().length > 0 && storage.store.raw.has(CLIENT_KEY), true,
    'the ticket survives the expiry, because a new day is not a new device');

  // --- corruption ----------------------------------------------------------
  // Half a write, an older format, somebody's devtools. None of these may
  // throw: this runs in the app's first ten lines and a throw there is a blank
  // page before anything has been drawn.
  const CORRUPT = ['{', '', 'null', 'undefined', '[]', '"a string"', '0',
    '{"mode":"host"}', '{"ts":"yesterday"}', '{"ts":0}', '{"snap":{"v":1}}',
    '\u0000', 'x'.repeat(100000)];
  let sessionThrew = 0, engineThrew = 0, sessionTruthy = 0, engineTruthy = 0;
  for (const raw of CORRUPT) {
    storage.store.raw.set(SESSION_KEY, raw);
    storage.store.raw.set(ENGINE_KEY, raw);
    try { if (loadSession() !== null) sessionTruthy++; } catch (_) { sessionThrew++; }
    try { if (loadEngineSnapshot() !== null) engineTruthy++; } catch (_) { engineThrew++; }
  }
  eq(sessionThrew, 0, `loadSession survives all ${CORRUPT.length} corrupt entries`);
  eq(engineThrew, 0, 'and so does loadEngineSnapshot');
  eq(sessionTruthy, 0, 'no corrupt entry is mistaken for a live session');
  eq(engineTruthy, 0, 'and none for a live snapshot');

  storage.restore();
}

{
  // A write past the quota throws in a real browser. The game must still be
  // playable — the snapshot is a nicety, the match is not.
  const storage = installStorage({ quota: 40 });
  let threw = 0;
  try {
    saveEngineSnapshot({ v: 1, hands: new Array(50).fill(['AS', 'KH']) });
    saveSession({ mode: 'host', code: 'QRTX', name: 'a'.repeat(200) });
    saveName('a'.repeat(200));
  } catch (_) { threw++; }
  eq(threw, 0, 'a write past the quota is swallowed rather than thrown into the caller');
  eq(loadEngineSnapshot(), null, 'the snapshot that did not fit reads back as absent');
  storage.restore();
}

{
  // The harsher real failure: reading the GLOBAL throws, before any method is
  // reached. Private browsing, a locked-down webview, storage denied by policy.
  // Every accessor in util.js is wrapped for this, and an unwrapped one is a
  // dead app on somebody's work phone.
  const storage = installStorage({ broken: true });
  let threw = 0;
  const survives = (label, fn, check) => {
    let out;
    try { out = fn(); } catch (_) { threw++; console.error('  ✗ threw:', label); return; }
    ok(check(out), `${label} copes with storage that throws on access`);
  };
  survives('loadName()', loadName, (v) => v === '');
  survives('loadCode()', loadCode, (v) => v === '');
  survives('loadSession()', loadSession, (v) => v === null);
  survives('loadEngineSnapshot()', loadEngineSnapshot, (v) => v === null);
  survives('saveName()', () => saveName('Ana'), () => true);
  survives('saveCode()', () => saveCode('QRTX'), () => true);
  survives('saveSession()', () => saveSession({ mode: 'host' }), () => true);
  survives('saveEngineSnapshot()', () => saveEngineSnapshot({ v: 1 }), () => true);
  survives('clearSession()', clearSession, () => true);
  eq(threw, 0, 'nothing in the storage layer throws when there is no storage');

  // A per-tab ticket is the best that can be done with nowhere to write, and it
  // has to be STABLE: an id that changed between the join frame and the retry
  // would reclaim nothing, which is the whole reason it is a module variable
  // and not a fresh call.
  const a = clientId();
  const b = clientId();
  ok(validClientId(a) !== null, 'clientId() still mints a usable ticket with no storage');
  eq(a, b, 'and hands back the same one for the life of the tab');
  storage.restore();
}

storeClock.restore();

// ===========================================================================
section('The transport: a whole table, and what each device is sent');
// ===========================================================================

// A table on the fake network, wired the way js/main.js will wire it in
// checkpoint 9: createHost + applyGameIntent + pushState IS the controller,
// and there is deliberately nothing here standing in for one. A rig that
// invented its own message loop would prove the transport works against a
// caller that will never exist.
function liveTable(clock, { code = 'QRTX', hostName = 'Ana', hostTicket = 'host-ticket-01' } = {}) {
  // A code that does not survive normalizeCode() gets an INERT host back: no
  // error thrown, no listener, and every assertion below it quietly measuring
  // nothing at all. Caught here because I reached for 'ZZ89' as a throwaway
  // room code and the alphabet — correctly — has no I and no 1 in it. That is
  // a fine property to have and a terrible way to find out you have it.
  if (peerIdForCode(code) === null) throw new Error(`liveTable: '${code}' is not a room code`);
  const engine = new GameEngine();
  engine.addPlayer(HOST_ID, hostName, { clientId: hostTicket, isOwner: true });

  const seen = {
    open: null, connects: [], joins: [], data: [], drops: [], errors: [],
    // WHEN each error arrived, not just that it did. The retry ladder's whole
    // promise is a shape in time — doubling from a second, capped at eight —
    // and a test that only counts errors agrees with a ladder that fired all
    // of them in the same millisecond, or with one that has an extra rung.
    errorAt: [],
    brokerDown: 0, brokerUp: 0, brokerLost: 0, lostAt: null, pushes: 0,
    // Asserted from inside onConnect, where the claim is that the caller can
    // already use the id it was just handed.
    usableAtConnect: [],
  };
  const clients = [];

  let host = null;
  // Counted so the tests can say "every device received one frame per push"
  // instead of guessing a number. A magic floor like `states.length > 100`
  // goes green on a broadcast that quietly skipped a device, and goes red on
  // a shorter match that was perfectly correct.
  const push = () => {
    seen.pushes++;
    host.pushState(engine.publicState(), (id) => engine.privateStateFor(id));
  };

  host = createHost(code, {
    onOpen: (c) => { seen.open = c; },
    onConnect: (pid) => {
      seen.connects.push(pid);
      // ON THE CALL, not after it. By the time a caller is told a device is
      // connected, that device must be reachable — main.js's onConnect is
      // where a rejoining player gets sent the current state, and a handler
      // that fires before the connection is in the map sends into a void and
      // reports no error at all.
      seen.usableAtConnect.push(host.playerIds().includes(pid));
    },
    onJoin: (pid, hello) => {
      seen.joins.push([pid, hello]);
      // The null case is a hello that arrived and was unusable. Telling the
      // sender is the caller's job, and a joiner dropped in silence sits on a
      // spinner until their own deadline expires.
      if (!hello) { host.sendTo(pid, rejectFrame('Enter a name first.')); return; }
      const r = engine.addPlayer(pid, hello.name, { clientId: hello.clientId });
      if (!r.ok) { host.sendTo(pid, rejectFrame(r.error)); return; }
      push();
    },
    onData: (pid, msg) => {
      seen.data.push([pid, msg.type]);
      const { handled, result } = applyGameIntent(engine, pid, msg, clock.elapsed());
      if (handled && !result.ok) host.sendTo(pid, rejectFrame(result.error));
      push();
    },
    onDisconnect: (pid) => { seen.drops.push(pid); engine.disconnect(pid); push(); },
    onError: (e) => { seen.errors.push(e); seen.errorAt.push(clock.elapsed()); },
    onBrokerDown: () => { seen.brokerDown++; },
    onBrokerUp: () => { seen.brokerUp++; },
    onBrokerLost: () => { seen.brokerLost++; seen.lostAt = clock.elapsed(); },
  });
  clock.advance(10);

  const join = (name, ticket, { dialCode = code, identity = undefined } = {}) => {
    const box = { name, ticket, states: [], rejects: [], data: [], closes: 0, errors: [], opens: 0 };
    box.net = joinHost(dialCode, {
      onOpen: () => { box.opens++; },
      onState: (pub, priv) => box.states.push({ pub, priv }),
      onData: (msg) => {
        const r = readRejectFrame(msg);
        if (r) box.rejects.push(r); else box.data.push(msg);
      },
      onClose: () => { box.closes++; },
      onError: (e) => box.errors.push(e),
    }, identity === undefined ? { name, clientId: ticket } : identity);
    box.last = () => box.states[box.states.length - 1] || null;
    box.seat = () => (box.last() && box.last().priv ? box.last().priv.seat : -1);
    // The raw DataConnection under the client, for the tests that have to send
    // something joinHost() would never send — junk, an oversized frame, a
    // second identity. Nothing a well-behaved client can reach.
    box.wire = () => broker.connectionsOf(box.net.peer)[0] || null;
    clients.push(box);
    clock.advance(10);
    return box;
  };

  const teardown = () => {
    host.destroy();
    for (const c of clients) c.net.destroy();
    clock.advance(100);
  };

  return { engine, host, seen, clients, join, push, teardown };
}

// Set by each installPeerJS() group so liveTable's box.wire() can reach the
// broker. A module-level handle rather than a parameter because every group
// has exactly one broker and threading it through four helpers would be noise.
let broker = null;

/**
 * Play a whole match with every remote player's move going over the wire.
 *
 * The host's own taps do not: they are a function call in the same tab, and
 * pretending otherwise would test a path that does not exist.
 *
 * `audit` runs after every push, while the engine still holds exactly the
 * state that was just sent.
 *
 * Returns `{ steps, bids, cards, rounds }` — the moves it actually made, so a
 * caller can check them against what the round plan says the match required
 * rather than against a number somebody typed in.
 */
function playOverTheWire(clock, table, audit = null) {
  const { engine, push } = table;
  const made = { steps: 0, bids: 0, cards: 0, rounds: 0 };
  const byPlayer = new Map();
  for (const c of table.clients) {
    const seat = c.seat();
    if (seat >= 0) byPlayer.set(engine.seats[seat].id, c);
  }

  // Every move this driver makes goes through applyGameIntent, whether it
  // arrived on a wire or not, because that is the only entry point main.js
  // will have. A driver that called engine.placeBid() directly for the host
  // and sent a frame for everyone else would be testing two different things
  // and claiming they were the same one.
  const locally = (id, msg) => {
    const { handled, result } = applyGameIntent(engine, id, msg, clock.elapsed());
    if (!handled) throw new Error(`the host's own '${msg.type}' was not a game intent`);
    if (!result.ok) throw new Error(`the host's own '${msg.type}' was refused: ${result.error}`);
    push();
  };

  let guard = 0;
  while (engine.phase !== PHASES.MATCH_OVER) {
    if (guard++ > 5000) throw new Error('the wired match never finished');
    // THE HOST TAB DRIVES THE CLOCK. Nothing over the wire does, and this line
    // is what stands in for main.js's animation frame in checkpoint 9. The
    // first draft of the smoke test left it out and every bid came back "not
    // bidding right now", which looked like a transport bug and was not.
    engine.tick(clock.elapsed());

    const waiting = engine.phase === PHASES.BIDDING
      || (engine.phase === PHASES.PLAY && engine.sweepAt === null);
    if (waiting) {
      const seat = engine.turnSeat;
      const id = engine.seats[seat].id;
      let msg;
      if (engine.phase === PHASES.BIDDING) {
        const opts = engine.bidOptionsFor(seat).filter((o) => o.legal);
        msg = { type: 'placeBid', bid: opts[rnd(opts.length)].bid };
        made.bids++;
      } else {
        const legal = engine.privateStateFor(id).hand.filter((c) => c.legal);
        msg = { type: 'playCard', code: legal[rnd(legal.length)].code };
        made.cards++;
      }
      const via = byPlayer.get(id);
      // A remote seat's move is a frame. The host's own is a function call in
      // the same tab, and dressing it up as network traffic would exercise a
      // path that does not exist in the shipped app.
      if (via) { via.net.send(msg); clock.advance(1); } else locally(id, msg);
    } else if (engine.phase === PHASES.ROUND_OVER) {
      // ROUND_OVER DOES NOT TICK PAST ITSELF. It waits for the owner to tap
      // "next round", so the scoreboard stays on screen until somebody has
      // actually read it. Leaving this branch out is what made the first
      // wired match spin: the loop ticked forever at round 0 while every
      // assertion downstream waited for a match that was never going to end.
      locally(HOST_ID, { type: 'nextRound' });
      made.rounds++;
    } else {
      push();
    }
    if (audit) audit();
    clock.advance(TRICK_PAUSE_MS + 1);
  }
  engine.tick(clock.elapsed());
  push();
  if (audit) audit();
  // Deliver that last broadcast. Everything else in the loop is followed by
  // an advance, so only the final frame would otherwise still be in flight
  // when the caller counts what each device received — an off-by-one in the
  // harness that reads exactly like a device being skipped.
  clock.advance(1);
  // `made.rounds` needs no correction: the LAST scoreboard waits for the tap
  // too, and it is that tap that returns matchOver. The owner is never shown
  // a final score they did not dismiss.
  made.steps = guard;
  return made;
}

{
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;

  const table = liveTable(clock, { code: 'QRTX' });
  eq(table.seen.open, 'QRTX', 'the host reports the normalised code it is listening on');
  ok(table.host.isOpen(), 'and the broker socket is up');

  const NAMES = ['Ben', 'Cleo', 'Dev', 'Esha', 'Finn', 'Gita'];
  for (let i = 0; i < NAMES.length; i++) table.join(NAMES[i], `ticket-${NAMES[i].toLowerCase()}-00${i}`);
  clock.advance(20);

  eq(table.engine.seats.length, 7, 'six joiners plus the host make a full seven-seat table');
  eq(table.seen.joins.length, 6, 'and the host saw six hellos');
  eq(table.seen.joins.filter(([, hello]) => hello === null).length, 0, 'all of them usable');
  eq(table.host.playerIds().length, 6, 'the host holds six connections');
  same(table.host.playerIds().slice().sort(), table.seen.connects.slice().sort(),
    'and every one of them was announced exactly once');
  same(table.seen.usableAtConnect, table.seen.connects.map(() => true),
    'and each was already reachable at the moment its arrival was announced');

  // Every id the engine ever saw came through the prefix. This is the security
  // boundary asserted against the real engine rather than against the function
  // in isolation.
  const outside = table.engine.seats.filter((s) => s.id !== HOST_ID && !s.id.startsWith(CONN_ID_PREFIX));
  same(outside, [], 'no seat but the host holds an id from outside the peer namespace');

  table.engine.setConfig(HOST_ID, { maxHand: 3, shape: 'descending', trumpMethod: 'turnup', scoring: 'kachuful' });
  const started = table.engine.startMatch(HOST_ID, clock.elapsed());
  ok(started.ok, 'the owner starts the match');
  table.push();
  clock.advance(10);

  // --- the audit -----------------------------------------------------------
  let frames = 0, leaks = 0, misrouted = 0, structural = 0;
  let undecodable = 0, unreadable = 0, extraFrames = 0, maxBytes = 0, seatlessFrames = 0;
  // What went on the wire has to be TEXT. decodePeerFrame accepts an object
  // too — a shim that handed one straight back would be indistinguishable —
  // and then `raw.length` is undefined, maxBytes never leaves zero, and the
  // size assertion below passes by measuring nothing. Found by a mutation
  // that made trySend send the object instead of the JSON, which the whole
  // audit waved through.
  let nonString = 0;
  const cursors = new Map();
  for (const [, conn] of table.host.connections) cursors.set(conn, conn.sent.length);

  const audit = () => {
    const allowed = publiclyVisible(table.engine);
    for (const [connId, conn] of table.host.connections) {
      const from = cursors.get(conn) || 0;
      // One frame per open connection per push. More would mean a caller
      // could not reason about what it had sent; fewer would mean somebody
      // missed a change.
      if (conn.sent.length - from !== 1) extraFrames++;
      cursors.set(conn, conn.sent.length);
      const raw = conn.sent[conn.sent.length - 1];
      if (raw === undefined) continue;
      frames++;
      if (typeof raw !== 'string') { nonString++; continue; }
      if (raw.length > maxBytes) maxBytes = raw.length;

      // Through the SAME front door a real client uses. A frame the host can
      // build but its own client would refuse is a bug either way.
      const msg = decodePeerFrame(raw);
      if (!msg) { undecodable++; continue; }
      const read = readStateFrame(msg);
      if (!read) { unreadable++; continue; }

      if ('hands' in read.pub || 'stock' in read.pub) structural++;
      if (!read.priv) { seatlessFrames++; continue; }

      // THE WHOLE PRIVACY MODEL IN ONE LINE: the private half in this
      // connection's frame belongs to this connection's seat. A pushState that
      // asked privateFor() for the wrong id would still produce well-formed
      // frames full of somebody else's cards.
      if (table.engine.seats[read.priv.seat].id !== playerIdForConn(connId)) misrouted++;

      const mine = new Set(table.engine.hands[read.priv.seat] || []);
      for (const code of codesIn(msg)) if (!mine.has(code) && !allowed.has(code)) leaks++;
    }
  };

  pickSeed(808);
  const before = table.clients.map((c) => c.states.length);
  const pushesBefore = table.seen.pushes;
  const made = playOverTheWire(clock, table, audit);

  eq(table.engine.phase, PHASES.MATCH_OVER,
    `the match played out over the wire in ${made.steps} steps`);
  ok(frames > 300, `${frames} state frames were audited`);
  eq(extraFrames, 0, 'each push put exactly one frame on each open connection');
  eq(undecodable, 0, 'every frame the host sent survives the guard that reads it');
  eq(unreadable, 0, 'and is a state frame the client accepts');
  eq(structural, 0, 'no frame carries a hands or stock key');
  eq(misrouted, 0, 'every private half went to the seat it belongs to and to nobody else');
  eq(leaks, 0, 'and no frame contained a card the device receiving it was not entitled to see');
  eq(seatlessFrames, 0, 'every connected device had a seat by then');
  eq(nonString, 0, 'every one of them went on the wire as text, not as a live object');
  // BOTH SIDES of the size. A ceiling on its own is satisfied by a frame of
  // nothing at all, and "nothing at all" is exactly what a broken audit
  // measures. A seven-seat public state is hundreds of bytes at the very
  // least, so the floor is as safe as the ceiling and says far more.
  ok(maxBytes > 200 && maxBytes < MAX_FRAME_BYTES / 8,
    `the largest frame was ${maxBytes} bytes, against a ${MAX_FRAME_BYTES}-byte cap`);

  // SILENCE IS NOT HONESTY. A client that received nothing would pass a
  // "badFrames is zero" check on its own, so what each device actually got is
  // asserted too — and against a DERIVED number, not a magic floor. Every
  // client was seated before startMatch, so every client should have received
  // exactly one frame per push for the whole match. A broadcast that skipped
  // one device shows up here as one short count; a match that ran shorter
  // than expected shows up in the move check below, separately, where it can
  // be read.
  const pushes = table.seen.pushes - pushesBefore;
  const during = table.clients.map((c, i) => c.states.length - before[i]);
  same(during, during.map(() => pushes),
    `every device received one frame per push, all ${pushes} of them`);

  // And the match was a real one. The round plan is the source of truth for
  // how many moves that is: every seat bids once a round and plays one card
  // per trick, so the totals are arithmetic rather than a guess. This is the
  // assertion that fails if the driver bails out after one round and leaves
  // the privacy sweep above having audited almost nothing.
  const sizes = roundSizes(table.engine.config.shape, table.engine.config.maxHand);
  const seats = table.engine.seats.length;
  eq(made.rounds, sizes.length, `the ladder was ${sizes.join('-')} and every rung was played`);
  eq(made.bids, sizes.length * seats, 'every seat bid once in every round');
  eq(made.cards, sizes.reduce((a, n) => a + n, 0) * seats, 'and played every card it was dealt');
  ok(pushes > made.bids + made.cards,
    `${pushes} pushes covered ${made.bids + made.cards} moves and the pauses between them`);

  let noisy = 0;
  for (const c of table.clients) {
    if (c.net.badFrames() !== 0) noisy++;
    if (c.rejects.length !== 0) noisy++;
  }
  eq(noisy, 0, 'and not one of them saw a malformed frame or a refusal during honest play');
  eq(table.host.refusedFrames(), 0, 'the host refused nothing during honest play');
  eq(table.seen.errors.length, 0, 'and nothing errored');
  eq(table.seen.drops.length, 0, 'and nobody dropped');

  // Scores actually happened — otherwise the privacy sweep above ran over an
  // empty game and proved nothing.
  ok(table.engine.history.length >= 3, `${table.engine.history.length} rounds were scored`);
  const lastPub = table.clients[0].last().pub;
  ok(lastPub.seats.every((s) => typeof s.total === 'number'),
    'and the final frame every device holds carries the whole scoreboard');

  table.teardown();
  eq(clock.pending(), 0, 'and tearing the table down leaves no timer behind');
  net.uninstall();
}

{
  // --- the code the host shows is the code it is listening on ---------------
  //
  // A host resuming a session out of storage, or one whose code arrived from
  // anywhere other than generateRoomCode(), hands createHost() a string that
  // normalizeCode() may well change. The address being listened on is the
  // NORMALISED one, so reporting the raw string would put a code on the
  // host's screen that nobody in the room can dial. Every other block here
  // hosts at an already-clean code, which is how this went unnoticed.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;

  const MESSY = ' qr-tx ';
  eq(normalizeCode(MESSY), 'QRTX', 'the code under test is one that normalisation changes');
  const table = liveTable(clock, { code: MESSY });
  clock.advance(20);
  eq(table.seen.open, 'QRTX', 'the host reports the cleaned code, not the one it was handed');

  // And the cleaned code is dialable, which is the half that matters to the
  // seven people typing it in.
  const ben = table.join('Ben', 'ticket-ben-001', { dialCode: 'QRTX' });
  clock.advance(20);
  eq(ben.opens, 1, 'a device dialling the code on screen reaches the table');
  eq(table.engine.seats.length, 2, 'and is seated');

  table.teardown();
  net.uninstall();
}

{
  // --- a refusal is for the sender, and for nobody else ---------------------
  //
  // "A failed bid is not news to the rest of the table" is a sentence in
  // js/net.js and it was, until this block, only a sentence. A broadcast here
  // tells six other people that somebody tried something they were not
  // allowed to — and worse, hands every device a banner about a state it is
  // not in.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ23' });

  const mal = table.join('Mal', 'ticket-mal-001');
  const pia = table.join('Pia', 'ticket-pia-002');
  const raj = table.join('Raj', 'ticket-raj-003');
  clock.advance(20);
  eq(table.engine.seats.length, 4, 'four at the table');

  // A bid in the lobby is refused by the engine, which is the most ordinary
  // refusal there is.
  mal.net.send({ type: 'placeBid', bid: 0 });
  clock.advance(20);
  eq(mal.rejects.length, 1, 'the sender is told their move was refused');
  eq(pia.rejects.length + raj.rejects.length, 0, 'and nobody else hears about it at all');
  eq(pia.data.length + raj.data.length, 0, 'not even as an unrecognised frame');

  // A hello with no usable name is the other refusal the transport produces,
  // and it is the one that decides whether a joiner sees an error or a
  // spinner. joinHost() sends whatever identity it is given, so a device with
  // an empty name field is reproduced exactly.
  const nameless = table.join('', 'ticket-nameless-004', { identity: { name: '', clientId: 'ticket-nameless-004' } });
  clock.advance(20);
  eq(table.seen.joins.filter(([, hello]) => hello === null).length, 1,
    'an unusable hello reaches the caller as a hello that could not be read');
  eq(nameless.rejects.length, 1, 'so the joiner can be told, rather than left on a spinner');
  eq(nameless.rejects[0], 'Enter a name first.', 'in words, not in silence');
  eq(table.engine.seats.length, 4, 'and nobody was seated on it');
  eq(mal.rejects.length + pia.rejects.length + raj.rejects.length, 1,
    'while the table saw nothing of that either');

  table.teardown();
  net.uninstall();
}

{
  // --- what a CLIENT accepts off the wire -----------------------------------
  //
  // readStateFrame is swept hard in the wire section, but in isolation. This
  // is the same guard reached the only way it is reached in anger: a frame
  // arriving on a real joinHost() connection. The host end is driven raw,
  // because a host built from this source would never send any of it — and
  // that is the point, since a four-character code on a public broker can
  // resolve to something that is not this game at all.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ33' });
  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);

  const hostEnd = table.host.connections.get(ben.net.peer.id);
  ok(!!hostEnd, 'the host end of the connection is reachable for this test');
  const sendRaw = (text) => { hostEnd.send(text); clock.advance(10); };

  const base = { states: ben.states.length, bad: ben.net.badFrames(), data: ben.data.length };

  sendRaw('{{{ not json');
  eq(ben.net.badFrames(), base.bad + 1, 'junk from the host is counted, not parsed');
  eq(ben.states.length, base.states, 'and never reaches the renderer');
  eq(ben.data.length, base.data, 'nor the caller as a message');

  // A well-formed frame that is a STATE frame and is nonetheless nonsense.
  // This is the one that matters: render() walks pub without checking, and
  // since render() opens with clear(root) a thrown TypeError is a blank page
  // with no way back.
  sendRaw(JSON.stringify({ type: WIRE.STATE, pub: { seats: 7 }, priv: null }));
  eq(ben.net.badFrames(), base.bad + 2, 'a malformed state frame is counted too');
  eq(ben.states.length, base.states, 'and is dropped rather than handed to the renderer');
  eq(ben.data.length, base.data, 'and is not quietly re-routed to onData instead');

  // SILENCE IS NOT HONESTY. Every count above is satisfied by a client that
  // ignores everything, so the same channel then has to carry a real frame.
  table.push();
  clock.advance(10);
  eq(ben.states.length, base.states + 1, 'a real state frame on that same connection still arrives');
  eq(ben.net.badFrames(), base.bad + 2, 'without being counted as bad');
  eq(ben.data.length, base.data, 'and a state frame is NOT also delivered as a plain message');

  // And the frames that are neither: a refusal is passed through untouched,
  // which is what lets a newer host talk to an older client.
  sendRaw(JSON.stringify(rejectFrame('Not your turn.')));
  eq(ben.rejects.length, 1, 'a refusal reaches the caller');
  eq(ben.states.length, base.states + 1, 'and is not mistaken for state');
  sendRaw(JSON.stringify({ type: 'somethingNewer', v: 2 }));
  eq(ben.data.length, base.data + 1, 'and so does a frame this build has never heard of');
  eq(ben.net.badFrames(), base.bad + 2, 'an unknown type is not a malformed one');

  table.teardown();
  net.uninstall();
}

// ===========================================================================
section('The transport: the door, and what gets turned away at it');
// ===========================================================================

/**
 * A device that dials the host WITHOUT going through joinHost(): a peer id of
 * the test's choosing, a raw DataConnection, and not one byte sent unless a
 * test sends it.
 *
 * Every check createHost() makes at the door — the connection cap, the id
 * length, the handshake reaper — happens before joinHost() would have had a
 * chance to say anything at all, so none of them is reachable through the
 * real client. This is the only way in.
 *
 * Settled with `advance(0)`, which flushes every queued delivery WITHOUT
 * moving Date.now. That matters for the reaper: the budget has to be measured
 * from the moment the connection was accepted, and a dial that quietly spent
 * twenty milliseconds getting there would put the boundary twenty
 * milliseconds early and look like an off-by-nothing in the source.
 */
function rawDial(clock, code, id, opts = {}) {
  const peer = new window.Peer(id);
  let conn = null;
  peer.on('open', () => { conn = peer.connect(peerIdForCode(code), opts); });
  clock.advance(0);
  return { peer, conn, get open() { return !!(conn && conn.open); }, destroy: () => peer.destroy() };
}

{
  // --- the rate limit, at one instant and then over time -------------------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ29' });
  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);
  eq(table.engine.seats.length, 2, 'one joiner is seated');

  // Derived from the bucket itself, not copied. The day somebody widens the
  // burst allowance this test tells the truth about the new number instead of
  // failing for the wrong reason.
  const bucket = new TokenBucket();
  const CAPACITY = bucket.capacity;
  const PER_SEC = bucket.refillPerSec;
  ok(CAPACITY > 0 && PER_SEC > 0, `the bucket holds ${CAPACITY} and refills at ${PER_SEC}/s`);

  // WELL-FORMED frames, deliberately. Junk never reaches the bucket — it is
  // refused by decodePeerFrame one line earlier and costs the sender no token
  // at all — so a flood of garbage cannot test this and a flood of valid
  // messages is the thing that actually has to be survivable. 'noop' is not a
  // game intent, so applyGameIntent hands it back unhandled and the engine is
  // untouched: this measures the door, not the room.
  const noops = () => table.seen.data.filter(([, t]) => t === 'noop').length;
  const flood = (n) => { for (let i = 0; i < n; i++) ben.net.send({ type: 'noop', i }); };

  // THE HELLO IS A FRAME TOO. joinHost() sends it on open and it goes through
  // this same bucket before it reaches the JOIN branch — which is right: a
  // peer that could flood hellos for free would be a peer that could flood.
  // So one token is already spent, and the burst that still fits is one short
  // of the capacity. Written as a boundary rather than as arithmetic, so a
  // handshake that started costing two tokens fails HERE, where the reason is
  // legible, instead of as an off-by-one three assertions further down.
  eq(table.seen.joins.length, 1, 'the hello arrived and was handled');

  flood(CAPACITY - 1);
  // advance(0) flushes every queued delivery WITHOUT moving Date.now, so all
  // of them hit the bucket at one instant and none of them earns a refill.
  clock.advance(0);
  eq(noops(), CAPACITY - 1, `the hello spent one token and the other ${CAPACITY - 1} fit in a single burst`);
  eq(table.host.refusedFrames(), 0, 'with nothing refused — a burst is normal traffic');

  flood(20);
  clock.advance(0);
  eq(noops(), CAPACITY - 1, 'the very next frame at that same instant does not get through');
  eq(table.host.refusedFrames(), 20, 'nor do the nineteen behind it');
  eq(ben.closes, 0, 'twenty over the line is a burst, not an attack — nobody is cut off');

  // A second later the bucket has refilled by exactly one second's worth.
  const wasRefused = table.host.refusedFrames();
  clock.advance(1000);
  flood(PER_SEC + 5);
  clock.advance(0);
  eq(noops(), CAPACITY - 1 + PER_SEC, `a second later exactly ${PER_SEC} more get through`);
  eq(table.host.refusedFrames(), wasRefused + 5, 'and only the excess is refused');

  // SILENCE IS NOT HONESTY: a throttled connection that had been quietly
  // broken would pass every count above. So the same connection is made to
  // carry a real message afterwards — and the clock is moved BEFORE it is
  // sent, because an empty bucket is the expected state at this point and
  // sending into one would prove nothing either way.
  clock.advance(1000);
  ben.net.send({ type: 'placeBid', bid: 0 });
  clock.advance(10);
  ok(table.seen.data.some(([, t]) => t === 'placeBid'),
    'the throttled connection is still connected, and still heard');
  eq(ben.rejects.length, 1, 'and the host answered it — a bid in the lobby is refused, to the sender alone');
  eq(ben.closes, 0, 'nobody was cut off');

  table.teardown();
  net.uninstall();
}

{
  // --- junk is refused BEFORE the bucket, and that ordering is visible ------
  //
  // decodePeerFrame runs first, so a frame that is not a frame costs its
  // sender nothing but a refusal. The block above leans on that — it is why
  // the hello's single token can be accounted for at all — and until now
  // nothing asserted it in the other direction. The consequence if the two
  // lines are swapped is not academic: a few malformed frames from a flaky
  // encoder would silently eat the budget a real player needs for a burst of
  // honest moves, and the moves would be dropped in silence.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ89' });
  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);

  const bucket = new TokenBucket();
  const CAPACITY = bucket.capacity;
  const noops = () => table.seen.data.filter(([, t]) => t === 'noop').length;

  // Five seconds of quiet, so the hello's token is long since refilled and
  // the bucket is provably at capacity when the junk arrives.
  clock.advance(5000);

  const JUNK = 10;
  const wire = ben.wire();
  for (let i = 0; i < JUNK; i++) wire.send('{{{ not json');
  clock.advance(0);
  eq(table.host.refusedFrames(), JUNK, `${JUNK} malformed frames were refused`);
  eq(noops(), 0, 'and none of them reached the caller');

  // At the SAME instant, so nothing has refilled in between: a full bucket's
  // worth of honest traffic must still fit.
  for (let i = 0; i < CAPACITY; i++) ben.net.send({ type: 'noop', i });
  clock.advance(0);
  eq(noops(), CAPACITY, `a full burst of ${CAPACITY} honest frames still fits behind them`);
  eq(table.host.refusedFrames(), JUNK, 'with nothing of it refused — the junk cost no tokens');
  eq(ben.closes, 0, 'and the connection is still up');

  table.teardown();
  net.uninstall();
}

{
  // --- past the refusal cap, the connection goes -----------------------------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ39' });
  const mal = table.join('Mal', 'ticket-mal-001');
  table.join('Pia', 'ticket-pia-001');
  clock.advance(20);
  eq(table.engine.seats.length, MIN_PLAYERS, 'the flooder joins like anybody else');

  // MID-MATCH DELIBERATELY. In the lobby a dropped connection takes its seat
  // with it, and for a good reason — an empty chair nobody can vacate
  // deadlocks the start (see disconnect() in js/state.js). The claim being
  // made here is the other half of that: once there are hands and scores on
  // the table, a flood costs the flooder their connection and NOT their
  // chair. Run in the lobby this block would assert the opposite and look
  // just as green.
  table.engine.setConfig(HOST_ID, { maxHand: 2, shape: 'descending', trumpMethod: 'none', scoring: 'kachuful' });
  ok(table.engine.startMatch(HOST_ID, clock.elapsed()).ok, 'and the match is under way before any of this');
  table.push();
  clock.advance(10);

  // Junk, sent on the RAW connection, because joinHost() will only ever put
  // well-formed JSON on the wire. A test that could not send this could not
  // reach the decode failure at all.
  const wire = mal.wire();
  ok(wire !== null, 'the raw connection underneath the client is reachable');
  for (let i = 0; i <= MAX_REFUSED_FRAMES; i++) wire.send('{{{ not json');
  clock.advance(10);

  ok(table.host.refusedFrames() > MAX_REFUSED_FRAMES,
    `${table.host.refusedFrames()} frames were refused, past the ${MAX_REFUSED_FRAMES} cap`);
  eq(mal.closes, 1, 'and the connection was closed on it');
  const malId = playerIdForConn(mal.net.peer.id);
  same(table.seen.drops, [malId], 'and the disconnect was reported exactly once');
  eq(table.host.playerIds().filter((id) => id === malId).length, 0,
    'the host is no longer holding that connection');

  // THE SEAT STAYS. Losing the connection is not losing the chair — that is
  // the whole premise of reclaim, and a flood is no more a reason to empty a
  // seat than a tunnel is.
  eq(table.engine.seats.length, MIN_PLAYERS, 'every seat is still at the table');
  eq(table.engine.seats[table.engine.seatOf(malId)].connected, false,
    'with the flooder marked disconnected rather than removed');
  // SILENCE IS NOT HONESTY: the other player was not collateral damage.
  eq(table.engine.seats.filter((s) => s.connected).length, MIN_PLAYERS - 1,
    'and everybody else still connected');

  table.teardown();
  net.uninstall();
}

{
  // --- the connection cap ----------------------------------------------------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ49' });

  // Far more than a seven-seat table can ever seat, on purpose. The cap is not
  // about seats: it is about a phone being asked to hold open thirty-three
  // WebRTC connections by somebody who has no intention of playing.
  const dials = [];
  for (let i = 0; i < MAX_HOST_CONNS + 4; i++) dials.push(rawDial(clock, 'ZZ49', `flood-${i}`));
  clock.advance(50);

  eq(table.host.playerIds().length, MAX_HOST_CONNS,
    `the host holds exactly ${MAX_HOST_CONNS} connections and no more`);
  eq(dials.filter((d) => d.open).length, MAX_HOST_CONNS, 'and four dialers were turned away');
  eq(table.seen.errors.length, 0, 'without the host erroring');
  ok(table.host.isOpen(), 'and without the host falling over');

  for (const d of dials) d.destroy();
  clock.advance(20);
  eq(table.host.playerIds().length, 0, 'when they all leave, the host holds none of them');

  // AND THE SLOTS COME BACK. "Holds none" does not say that: the cap counts
  // connections ACCEPTED, in a set of its own, and a set that is only ever
  // added to turns a phone that has seen thirty-two comings and goings into a
  // table nobody can join. That is not an exotic amount of churn over a
  // nineteen-round match — and the player it locks out first is the one
  // trying to reclaim their seat, since a reconnecting device arrives as a
  // brand-new connection every time.
  const second = [];
  for (let i = 0; i < MAX_HOST_CONNS; i++) second.push(rawDial(clock, 'ZZ49', `second-wave-${i}`));
  clock.advance(50);
  eq(second.filter((d) => d.open).length, MAX_HOST_CONNS,
    `a second full wave of ${MAX_HOST_CONNS} is admitted after the first has gone`);
  eq(table.seen.errors.length, 0, 'still without the host erroring');

  for (const d of second) d.destroy();
  clock.advance(20);
  table.teardown();
  net.uninstall();
}

{
  // --- the handshake reaper --------------------------------------------------
  //
  // A connection that is accepted and never opens holds a slot forever. That
  // is not hypothetical: a phone that goes into a tunnel between the offer and
  // the answer leaves exactly this, and nothing below WebRTC will ever tell
  // the host about it. The thirty seconds is a BUDGET, not a timeout on
  // anything a player does — see "never set tight network timeouts" in the
  // header of js/net.js. A cold TLS handshake alone measured 4.6 seconds.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ59' });

  const live = table.join('Ana2', 'ticket-ana2-001');
  clock.advance(20);
  eq(table.host.playerIds().length, 1, 'one live connection');

  broker.neverOpen = true;
  const stuck = [];
  for (let i = 0; i < MAX_HOST_CONNS - 1; i++) stuck.push(rawDial(clock, 'ZZ59', `halfopen-${i}`));
  clock.advance(50);
  broker.neverOpen = false;

  eq(table.host.playerIds().length, 1, 'half-open connections never count as connected');
  // ...but they DO hold slots, which is the whole reason the reaper exists.
  const blocked = rawDial(clock, 'ZZ59', 'late-arrival');
  clock.advance(50);
  eq(blocked.open, false, 'and with every slot held, a real device cannot get in');

  // Find the moment the reaper fires by bisection rather than by asserting
  // either side of a number I typed. Each probe gets its OWN host — a second
  // createHost on the same broker, at a different code — because this table's
  // slots are all held and a probe dialled at it would be turned away at the
  // cap instantly, which looks exactly like being reaped at zero.
  let ghosts = 0;
  const freedBy = (ms) => {
    const side = createHost('ZZ69', {});
    clock.advance(10);
    broker.neverOpen = true;
    const d = rawDial(clock, 'ZZ69', `ghost-${++ghosts}`);
    broker.neverOpen = false;
    clock.advance(ms);
    const gone = d.conn.closed === true;
    d.destroy();
    side.destroy();
    clock.advance(10);
    return gone;
  };
  let lo = 0, hi = 120000;
  ok(!freedBy(lo), 'a connection is not reaped the instant it arrives');
  ok(freedBy(hi), 'and is long gone two minutes later');
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (freedBy(mid)) hi = mid; else lo = mid; }
  // 30000 WRITTEN OUT, not derived. HANDSHAKE_BUDGET_MS is deliberately not
  // exported, and a test that imported it would agree with any value somebody
  // put there — including the tight one the brief spends a paragraph warning
  // against. This is the number being promised, so this is where it is kept.
  eq(hi, 30000, `a half-open connection is reaped after exactly ${hi}ms`);

  // Back on the real table: run past the budget and the slots come back.
  clock.advance(60000);
  eq(table.host.playerIds().length, 1, 'the reaper never touched the live connection');
  eq(live.closes, 0, 'which is still open');
  eq(table.seen.drops.length, 0, 'and was never reported as a drop');

  const late = rawDial(clock, 'ZZ59', 'after-the-reaping');
  clock.advance(50);
  eq(late.open, true, 'and a real device can get in again');
  eq(table.host.playerIds().length, 2, 'taking one of the freed slots');

  late.destroy();

  // --- the reaper asks about THIS CONNECTION, not about this peer ----------
  //
  // Everything above dials from a fresh peer each time, so "is this
  // connection open" and "is anything from this peer open" are the same
  // question and the reaper's guard was never actually exercised. It asked
  // the second one — `connections.has(conn.peer)` — and the two come apart in
  // precisely the case this whole file is built around.
  //
  // A phone that loses signal does not close its channel politely. It comes
  // back on a SECOND connection while the first is still open and still in
  // the map; js/net.js says so itself twenty lines further down, where the
  // 'open' handler retires the previous one. So if that second connection
  // stalls in ICE, the old guard found the FIRST one still connected, decided
  // there was nothing to reap, and left a connection that never opened held
  // forever. `attached` is what the ceiling counts, so every stalled
  // reconnect cost a permanent slot — and the table that eventually could not
  // be joined was the host's own.
  //
  // Tested at the ceiling rather than by reading the flag, because the flag
  // is the mechanism and the ceiling is the harm.
  {
    // NOT 'ZZ61'. normalizeCode() drops '1' as confusable with I and L, so
    // that code normalises to three characters, peerIdForCode() returns null
    // and the host is never addressable — which presents as every dial
    // failing and looks exactly like a broken reaper. The alphabet is the
    // point of the room-code design; this is what it feels like from inside.
    const code = 'ZZ63';
    const side = createHost(code, {});
    clock.advance(10);

    const good = [];
    for (let i = 0; i < MAX_HOST_CONNS - 1; i++) good.push(rawDial(clock, code, `pair-${i}`));
    clock.advance(50);
    eq(good.filter((d) => d.open).length, MAX_HOST_CONNS - 1,
      `the side table fills to ${MAX_HOST_CONNS - 1} of ${MAX_HOST_CONNS} with ordinary connections`);

    // The last slot goes to a second connection from a peer that ALREADY has
    // an open one — the returning phone — and it stalls.
    broker.neverOpen = true;
    const ghost = good[0].peer.connect(peerIdForCode(code));
    clock.advance(50);
    broker.neverOpen = false;
    eq(ghost.open, false, 'a second connection from an already-connected peer stalls in the handshake');

    const shutOut = rawDial(clock, code, 'needs-the-last-slot');
    clock.advance(50);
    eq(shutOut.open, false, 'and while it is held, the table is full');

    clock.advance(60000);
    eq(ghost.closed, true,
      'the reaper closes it even though its peer still has another connection open');
    eq(good[0].open, true, "and leaves that peer's live connection alone");

    const admitted = rawDial(clock, code, 'after-the-reaping-2');
    clock.advance(50);
    eq(admitted.open, true, 'so the slot comes back and a real device gets in');

    admitted.destroy();
    shutOut.destroy();
    for (const d of good) d.destroy();
    clock.advance(20);
    side.destroy();
    clock.advance(10);
  }

  for (const d of stuck) d.destroy();
  clock.advance(20);
  table.teardown();
  net.uninstall();
}

{
  // --- an id that would not fit in a seat ------------------------------------
  //
  // A peer chooses its own id, so its LENGTH is its choice too. validPlayerId
  // caps at 64 characters and CONN_ID_PREFIX spends five of them, so the
  // boundary is a property of those two facts and is bisected rather than
  // written down: change either and this reports the new number.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ79' });

  const admits = (len) => {
    const d = rawDial(clock, 'ZZ79', 'x'.repeat(len));
    clock.advance(30);
    const got = d.open;
    d.destroy();
    clock.advance(10);
    return got;
  };
  let lo = 1, hi = 200;
  ok(admits(lo), 'a short peer id is admitted');
  ok(!admits(hi), 'a two-hundred-character one is not');
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (admits(mid)) lo = mid; else hi = mid; }
  eq(lo, 59, `the longest admissible peer id is ${lo} characters`);
  eq(lo + CONN_ID_PREFIX.length, validPlayerId('x'.repeat(64)).length,
    'which is exactly what is left of the player-id budget after the prefix');
  eq(validPlayerId(playerIdForConn('x'.repeat(lo))), playerIdForConn('x'.repeat(lo)),
    'the id it produces passes the guard the engine will apply to it');
  eq(validPlayerId(playerIdForConn('x'.repeat(lo + 1))), null, 'and one more does not');

  eq(table.seen.errors.length, 0, 'none of that errored the host');
  ok(table.host.isOpen(), 'and it stayed up throughout, broker socket and all');
  eq(table.host.playerIds().length, 0, 'holding none of the probes afterwards');

  table.teardown();
  net.uninstall();
}

// ===========================================================================
section('The transport: one connection, one identity, one ticket');
// ===========================================================================

{
  // --- a connection may repeat its hello, but may not change it -------------
  //
  // Not tidiness — a real denial of service. The engine reclaims by clientId,
  // so a connection that says hello twice under two tickets writes the same
  // `id` onto two seats. seatOf() is a findIndex and only ever finds the
  // first, so the second seat is marked connected, belongs to nobody, cannot
  // be played and cannot be waited out: the table hangs on its turn, forever,
  // and nobody in the room can see why.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ89' });

  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);
  eq(table.seen.joins.length, 1, 'one hello, one seat');
  eq(table.engine.seats.length, 2, 'the host and the joiner');

  // A REPEAT of the same hello is a retry and costs nothing. A client that
  // reconnects its broker socket, or that is simply unsure the first one
  // landed, must not be punished for saying so again.
  const wire = ben.wire();
  for (let i = 0; i < 5; i++) wire.send(JSON.stringify(joinFrame('Ben', 'ticket-ben-001')));
  clock.advance(20);
  eq(table.seen.joins.length, 6, 'the same hello repeated five times is heard five more times');
  eq(table.host.refusedFrames(), 0, 'and refused none of them');
  eq(table.engine.seats.length, 2, 'while still being the same one seat');
  eq(ben.closes, 0, 'and the connection is untouched');

  // A DIFFERENT ticket on the same connection is the attack.
  const before = table.seen.joins.length;
  wire.send(JSON.stringify(joinFrame('Ben', 'ticket-somebody-else')));
  clock.advance(20);
  eq(table.seen.joins.length, before, 'a second identity on one connection never reaches the caller');
  eq(table.host.refusedFrames(), 1, 'it is refused at the door');
  eq(table.engine.seats.length, 2, 'and no phantom seat is created');
  eq(table.engine.seats.filter((s) => s.id === playerIdForConn(ben.net.peer.id)).length, 1,
    'one connection still holds exactly one seat');

  // A name change WITH the same ticket is fine — that is somebody fixing a
  // typo, not somebody taking a chair.
  wire.send(JSON.stringify(joinFrame('Benjamin', 'ticket-ben-001')));
  clock.advance(20);
  eq(table.engine.seats.length, 2, 'renaming under the same ticket seats nobody new');
  eq(table.engine.seats[1].name, 'Benjamin', 'it just changes the name on the row');
  eq(table.host.refusedFrames(), 1, 'and costs no refusal');

  table.teardown();
  net.uninstall();
}

{
  // --- the two doors are separate, and neither opens onto the other ---------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ99' });
  const box = table.join('Cleo', 'ticket-cleo-001');
  clock.advance(20);

  // A JOIN is dispatched to onJoin and MUST NOT also arrive at onData. If it
  // did, applyGameIntent would see a message type it does not handle — which
  // is harmless today and stops being harmless the moment anything downstream
  // starts treating an unhandled type as worth answering.
  eq(table.seen.data.filter(([, t]) => t === WIRE.JOIN).length, 0,
    'a hello never reaches the data handler');
  eq(table.seen.joins.length, 1, 'it went to the join handler and only there');

  // And the reverse: every game intent goes to onData and none of them is
  // ever mistaken for a hello. Swept over the real export rather than a
  // sample, so a new intent is covered the day it is added.
  const joinsBefore = table.seen.joins.length;
  for (const type of GAME_INTENTS) box.net.send({ type });
  clock.advance(20);
  eq(table.seen.joins.length, joinsBefore,
    `none of the ${GAME_INTENTS.length} game intents was taken for a hello`);
  const sawAsData = GAME_INTENTS.filter((t) => table.seen.data.some(([, seen]) => seen === t));
  same(sawAsData.slice().sort(), GAME_INTENTS.slice().sort(),
    'and every one of them arrived at the data handler');

  // Malformed ones still land, because deciding they are malformed is the
  // engine's job and not the transport's — the transport's job is to not
  // invent a route for them. Each of these is refused by the engine and the
  // refusal goes to the sender alone.
  ok(box.rejects.length > 0, `${box.rejects.length} of them came back as refusals, to that device only`);
  eq(table.seen.errors.length, 0, 'and nothing errored');
  eq(box.closes, 0, 'and nobody was cut off for sending nonsense politely');

  table.teardown();
  net.uninstall();
}

// ===========================================================================
section('The transport: a phone dies in round two and comes back');
// ===========================================================================

/**
 * Deal a real table out to the middle of a match, over the wire.
 *
 * Stops when `history` first reaches `rounds`, which is the point where there
 * is something to lose: hands dealt, bids placed, and a scoreboard with more
 * than one row on it. A reclaim test run from the lobby proves nothing,
 * because a lobby seat holds nothing — no hand, no bid, no score.
 */
function playUpToRound(clock, table, rounds) {
  const { engine, push } = table;
  const byPlayer = new Map();
  for (const c of table.clients) if (c.seat() >= 0) byPlayer.set(engine.seats[c.seat()].id, c);

  let guard = 0;
  while (engine.history.length < rounds && engine.phase !== PHASES.MATCH_OVER) {
    if (guard++ > 5000) throw new Error(`never reached round ${rounds}`);
    engine.tick(clock.elapsed());
    if (engine.phase === PHASES.BIDDING || (engine.phase === PHASES.PLAY && engine.sweepAt === null)) {
      const id = engine.seats[engine.turnSeat].id;
      const msg = engine.phase === PHASES.BIDDING
        ? { type: 'placeBid', bid: engine.bidOptionsFor(engine.turnSeat).filter((o) => o.legal)[0].bid }
        : { type: 'playCard', code: engine.privateStateFor(id).hand.filter((c) => c.legal)[0].code };
      const via = byPlayer.get(id);
      if (via) { via.net.send(msg); clock.advance(1); }
      else { applyGameIntent(engine, id, msg, clock.elapsed()); push(); }
    } else if (engine.phase === PHASES.ROUND_OVER && engine.history.length < rounds) {
      applyGameIntent(engine, HOST_ID, { type: 'nextRound' }, clock.elapsed());
      push();
    } else push();
    clock.advance(TRICK_PAUSE_MS + 1);
  }
  return guard;
}

{
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });

  const TICKET = 'ticket-dev-004';
  table.join('Ben', 'ticket-ben-001');
  table.join('Cleo', 'ticket-cleo-002');
  const dev = table.join('Dev', TICKET);
  clock.advance(20);
  eq(table.engine.seats.length, 4, 'four at the table');

  table.engine.setConfig(HOST_ID, { maxHand: 3, shape: 'descending', trumpMethod: 'turnup', scoring: 'kachuful' });
  ok(table.engine.startMatch(HOST_ID, clock.elapsed()).ok, 'and a match on');
  table.push();
  clock.advance(10);
  playUpToRound(clock, table, 2);

  const devSeat = dev.seat();
  ok(devSeat >= 0, `Dev is in seat ${devSeat}`);
  ok(table.engine.history.length >= 2, `${table.engine.history.length} rounds are already on the scoreboard`);

  // Everything that must survive, captured BEFORE the phone dies, and deep
  // copied — a live reference would be mutated by the engine along with
  // everything else and would then agree with itself no matter what happened.
  const snap = JSON.parse(JSON.stringify({
    hand: table.engine.hands[devSeat],
    totals: table.engine.totals,
    history: table.engine.history,
    name: table.engine.seats[devSeat].name,
    isOwner: table.engine.seats[devSeat].isOwner,
    roundIndex: table.engine.roundIndex,
  }));
  ok(snap.history.length >= 2, 'with more than one round in it, which is the whole point');
  ok(snap.totals.some((t) => t !== 0), 'and real scores on it');

  // THE PHONE GOES INTO A TUNNEL. vanish() is the honest version: the channel
  // stops working and NEITHER end is told. close() is the polite version, and
  // the polite version is not the one that loses people.
  const deadWire = dev.wire();
  deadWire.vanish();
  clock.advance(50);
  eq(table.engine.seats.length, 4, 'a vanished phone does not vacate its chair');
  eq(table.engine.seats[devSeat].connected, true,
    'and the host does not even know yet — nothing below WebRTC will tell it');

  // The device comes back: a NEW peer, a NEW connection, the SAME ticket.
  // That is what a reload, a battery swap or a walk out of a tunnel looks
  // like, and the ticket is the only thing that carries across.
  const again = table.join('Dev', TICKET);
  clock.advance(50);

  eq(table.engine.seats.length, 4, 'no fifth seat was invented');
  eq(again.seat(), devSeat, 'the same chair came back');
  eq(table.engine.seats[devSeat].connected, true, 'marked connected again');
  eq(table.engine.seats[devSeat].id, playerIdForConn(again.net.peer.id),
    'and now answering to the new connection');
  same(table.engine.hands[devSeat], snap.hand, 'holding the same cards it went away with');

  // THE FULL SCOREBOARD, NOT JUST THE CURRENT ROUND. This is the line the
  // brief calls out by name: a 19-round match will outlast somebody's
  // battery, and coming back to a scoreboard that starts at the round you
  // reconnected in is coming back to a different game.
  const back = again.last();
  ok(back !== null, 'the returning device was sent the table');
  same(back.pub.history, snap.history,
    `every one of the ${snap.history.length} completed rounds came back, not just the current one`);
  same(back.pub.seats.map((s) => s.total), snap.totals, 'with every running total intact');
  eq(back.pub.roundIndex, snap.roundIndex, 'and the match still on the round it was on');
  eq(back.pub.seats[devSeat].name, snap.name, 'under the same name');
  eq(back.pub.seats[devSeat].isOwner, snap.isOwner, 'and the same standing in the room');
  // Sorted, for the reason spelled out at the impostor test below: the frame
  // carries the display fan, snap.hand is the dealt order, and the two agree
  // only by luck of the shuffle.
  same(back.priv.hand.map((c) => c.code), sortHand(snap.hand, table.engine.trump),
    'and the private half is that seat\'s own hand, card for card');

  // THE STALE CONNECTION IS STILL OUT THERE, and this is the part that is
  // easy to get wrong. A RECONNECTING DEVICE IS A NEW PEER: PeerJS mints a
  // fresh peer id on every page load, so the old connection is not overwritten
  // by the new one — it sits in the map under its own key, open() false,
  // belonging to a player id that no longer holds a seat.
  const oldId = playerIdForConn(dev.net.peer.id);
  const newId = playerIdForConn(again.net.peer.id);
  ok(oldId !== newId, 'the device came back under a different peer id, as a real one does');
  ok(table.host.playerIds().includes(oldId), 'so the host is still holding the connection it left on');
  eq(table.engine.seatOf(oldId), -1, 'which is now attached to no seat at all');
  eq(table.engine.seatOf(newId), devSeat, 'the seat having moved to the connection that came back');

  // That is what dropConnection() is for, and its contract is the precise
  // one: retire the old connection WITHOUT firing a disconnect. Firing one
  // would run engine.disconnect() against a player id that no longer holds a
  // seat — harmless today, and one refactor away from greying out the device
  // that just reconnected, in front of a player who could never work out why.
  const dropsBefore = table.seen.drops.length;
  table.host.dropConnection(oldId);
  clock.advance(50);
  eq(table.seen.drops.length, dropsBefore, 'retiring the stale connection reports no disconnect');
  ok(!table.host.playerIds().includes(oldId), 'and the host stops holding it');
  eq(table.engine.seats[devSeat].connected, true, 'the reclaimed seat stays connected throughout');
  eq(again.closes, 0, 'and the live connection is untouched');

  // And when the dead channel finally notices — which it does, minutes later,
  // once ICE gives up — its own close must still be a no-op.
  deadWire.close();
  clock.advance(50);
  eq(table.seen.drops.length, dropsBefore, 'its late close is a no-op as well');
  eq(table.engine.seats[devSeat].connected, true, 'the seat is still that of the device holding it');
  eq(table.engine.seats[devSeat].id, newId, 'and still answering to the right connection');

  // And the match carries on through the device that came back.
  const framesBefore = again.states.length;
  playUpToRound(clock, table, table.engine.plan.length);
  ok(table.engine.history.length > snap.history.length,
    `play continued past the reconnect, to ${table.engine.history.length} rounds scored`);
  ok(again.states.length > framesBefore,
    `${again.states.length - framesBefore} more frames reached the device that came back`);
  eq(again.net.badFrames(), 0, 'none of them malformed');

  table.teardown();
  net.uninstall();
}

// ---------------------------------------------------------------------------
// THE SECOND TAB, which is the same story with one thing changed: the old
// connection is not dead.
//
// Everything above uses vanish() — a phone in a tunnel — and that is the case
// seat reclaim was built for. But a clientId is stored in localStorage, and
// localStorage belongs to the ORIGIN, not to the tab. Open the game twice in
// one browser and the second tab dials with the first tab's ticket while the
// first tab is sitting there perfectly healthy.
//
// The host cannot tell the two apart and must not try. What it can do is say
// so on the way out, which is the whole of WIRE.REPLACED.
//
// Both halves are exercised below: the fix, and the same table with the frame
// ignored. The second run is not decoration. Without it, a test that asserts
// "two tabs settle down" passes just as happily against a transport that
// never lets a second tab connect at all.
// ---------------------------------------------------------------------------
{
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;

  // How many times a tab will re-dial before this test gives up and calls it
  // a loop. Low enough to run fast, high enough that no honest reconnect
  // sequence reaches it — the real ladder in main.js has five rungs.
  const DIAL_CAP = 12;

  /**
   * One table, with a host whose onJoin is js/main.js's onJoin: find the seat
   * this ticket already holds, rebind it, and retire whatever connection was
   * on it. Written out rather than taken from liveTable() because liveTable's
   * host does not do the retiring, and the retiring is the subject.
   */
  function tabsTable(code) {
    const engine = new GameEngine();
    engine.addPlayer(HOST_ID, 'Ana', { clientId: 'host-ticket-tabs', isOwner: true });
    const sent = { replaced: 0, drops: [] };
    let host = null;
    const push = () => host.pushState(engine.publicState(), (id) => engine.privateStateFor(id));

    host = createHost(code, {
      onConnect: (pid) => host.sendTo(pid, stateFrameFor(connIdForPlayer(pid),
        engine.publicState(), (id) => engine.privateStateFor(id))),
      onJoin: (pid, hello) => {
        if (!hello) { host.sendTo(pid, rejectFrame('Enter a name first.')); return; }
        const prior = engine.seats.find((s) => s.clientId && s.clientId === hello.clientId);
        const stale = prior && prior.id !== pid ? prior.id : null;
        const r = engine.addPlayer(pid, hello.name, { clientId: hello.clientId });
        if (!r.ok) { host.sendTo(pid, rejectFrame(r.error)); return; }
        if (stale) {
          // THE ORDER IS THE FIX. Tell it why, then retire it.
          host.sendTo(stale, replacedFrame());
          sent.replaced++;
          sent.drops.push(stale);
          host.dropConnection(stale);
        }
        push();
      },
      onData: (pid, msg) => {
        const { handled, result } = applyGameIntent(engine, pid, msg, clock.elapsed());
        if (handled && !result.ok) host.sendTo(pid, rejectFrame(result.error));
        if (handled) push();
      },
      onDisconnect: (pid) => { engine.disconnect(pid); push(); },
    });
    clock.advance(10);

    /**
     * Get off the lobby, and it is not optional.
     *
     * disconnect() SPLICES THE SEAT OUT in PHASES.LOBBY — a player who leaves
     * a lobby has left, and the chair goes with them. So every assertion
     * about a seat being reclaimed rather than re-created is vacuous until a
     * match is on: the seat the second connection gets is a brand new one
     * that happens to sit in the same index, and nothing distinguishes the
     * two. The first version of the tunnel case below ran in the lobby and
     * reported that the host never sent a farewell, which was true and was
     * about the setup rather than about the code.
     */
    const start = () => {
      engine.setConfig(HOST_ID, { maxHand: 3, shape: 'descending',
        trumpMethod: 'turnup', scoring: 'kachuful' });
      const r = engine.startMatch(HOST_ID, clock.elapsed());
      ok(r.ok, `the match is on, so a seat is worth reclaiming (${code})`);
      ok(engine.phase !== PHASES.LOBBY, 'and a disconnect no longer vacates a chair');
      push();
      clock.advance(10);
    };

    return { engine, host, sent, push, start };
  }

  /**
   * A TAB — js/main.js's client half, reduced to the three handlers that
   * decide whether to dial again.
   *
   * `honourReplaced` is the switch between the two worlds. True is what
   * main.js does now: onReplaced calls teardown(), whose netEpoch++ makes the
   * onClose a millisecond later inert. False is what it did before the frame
   * existed — the close arrives looking exactly like a dead channel, and the
   * ladder starts.
   */
  function openTab(table, code, name, ticket, { honourReplaced = true } = {}) {
    const tab = { name, ticket, dials: 0, replaced: 0, closes: 0, states: 0,
      data: [], order: [], stopped: false, capped: false, handles: [] };

    // main.js's netEpoch, and it is in here because leaving it out made this
    // helper lie. beginJoin(code, resuming) destroys the client it is
    // replacing and THEN bumps the counter, so the rung before this one
    // cannot answer for it — without that, the dying rung's own close looks
    // like a dropped connection and dials a rung of its own.
    let epoch = 0;

    const dial = () => {
      if (tab.dials >= DIAL_CAP) { tab.capped = true; return; }
      tab.dials++;
      if (tab.net) { try { tab.net.destroy(); } catch (_) {} }
      const mine = ++epoch;
      tab.net = joinHost(code, {
        onState: () => { tab.states++; },
        onReplaced: () => {
          tab.replaced++;
          tab.order.push('replaced');
          if (!honourReplaced) return;
          tab.stopped = true;   // stands in for teardown()'s netEpoch++
        },
        onData: (msg) => tab.data.push(msg),
        onClose: () => {
          // Counted before it is judged, so the assertions can say the close
          // ARRIVED and was ignored — which is a different claim from it
          // never having happened, and the weaker one is easy to pass.
          tab.closes++;
          tab.order.push('close');
          if (tab.stopped) return;      // superseded: main.js has torn down
          if (mine !== epoch) return;   // a rung we have already moved past
          dial();
        },
      }, { name, clientId: ticket });
      tab.handles.push(tab.net);
    };

    dial();
    clock.advance(20);
    // Stands in for the reconnect ladder's timer. vanish() fires no close on
    // either end, so nothing in here can notice a tunnel by itself — in the
    // app that is joinTimer's job, and a fake one is honest about the fact
    // that the noticing is not what is under test.
    tab.redial = dial;
    return tab;
  }

  const seatOfTicket = (engine, ticket) =>
    engine.seats.findIndex((s) => s.clientId === ticket);

  // --- with the frame honoured ---------------------------------------------
  {
    const t = tabsTable('ZZ29');
    const TICKET = 'ticket-one-device';

    const fillers = [openTab(t, 'ZZ29', 'Dee', 'ticket-dee'),
      openTab(t, 'ZZ29', 'Eli', 'ticket-eli')];
    const first = openTab(t, 'ZZ29', 'Bo', TICKET);
    clock.advance(30);
    t.start();

    const seat = seatOfTicket(t.engine, TICKET);
    ok(seat > 0, `the first tab is seated in seat ${seat}`);
    eq(t.engine.seats.length, 4, 'four at the table');
    ok(first.states > 0, 'and it is being sent the table');
    ok(t.engine.hands[seat].length > 0, 'holding cards, which is what makes the seat worth taking');

    // THE SECOND TAB. Same browser, same localStorage, therefore the same
    // ticket — and the first tab has not gone anywhere.
    const second = openTab(t, 'ZZ29', 'Bo', TICKET);
    clock.advance(200);

    eq(t.engine.seats.length, 4, 'no fifth chair was invented for the same device');
    eq(seatOfTicket(t.engine, TICKET), seat, 'the seat did not move along the table');
    eq(t.sent.replaced, 1, 'the host said why exactly once');

    eq(first.replaced, 1, 'the first tab was told it had been superseded');
    eq(first.closes, 1, 'and then closed');
    same(first.order, ['replaced', 'close'],
      'in that order — the reason arrives before the close it explains');
    eq(first.dials, 1, 'IT DID NOT DIAL AGAIN, which is the whole fix');
    eq(first.capped, false, 'so it never reached the cap');

    // The frame is intercepted by joinHost and must not also be handed on.
    // main.js's onData would not crash on it, but it would be one more
    // unrecognised type reaching applyGameIntent, and the handler that
    // matters would have already missed its moment.
    eq(first.data.length, 0, 'the replaced frame never reached onData');
    eq(first.net.badFrames(), 0, 'and nothing it received was malformed');

    // THE TAB THAT WON IS UNTOUCHED. Easy to lose sight of: a fix that
    // quietened the first tab by breaking the second would pass every
    // assertion above.
    eq(second.replaced, 0, 'the tab that took the seat was not told anything');
    eq(second.closes, 0, 'nor closed');
    eq(second.dials, 1, 'nor made to dial again');
    ok(second.states > 0, 'and it is the one receiving the table now');
    eq(t.engine.seats[seat].connected, true, 'the seat stayed connected throughout');

    // And the game still works through it — the point of taking the seat.
    const before = second.states;
    t.push();
    clock.advance(20);
    ok(second.states > before, 'a push after the handover reaches the surviving tab');

    // AND IT HOLDS THE SAME HAND. The seat moved between connections; the
    // cards did not move at all. A "fix" that re-seated the device would
    // satisfy everything above and deal it a new hand mid-round.
    const mine = second.states > 0 ? t.engine.privateStateFor(t.engine.seats[seat].id) : null;
    ok(mine && mine.hand.length === t.engine.hands[seat].length,
      'and it is holding the hand the seat came with, not a fresh one');

    for (const h of [...first.handles, ...second.handles,
      ...fillers.flatMap((f) => f.handles)]) h.destroy();
    t.host.destroy();
    clock.advance(50);
  }

  // --- and the same table with the frame ignored ---------------------------
  //
  // THE CONTROL, and it is the evidence. This is the code as it was: the
  // frame arrives, nothing acts on it, and the close that follows is
  // indistinguishable from a channel that died. Both tabs are behaving
  // correctly and reasonably. They will still do this until one is closed.
  {
    const t = tabsTable('ZZ49');
    const TICKET = 'ticket-one-device';

    const fillers = [openTab(t, 'ZZ49', 'Dee', 'ticket-dee'),
      openTab(t, 'ZZ49', 'Eli', 'ticket-eli')];
    const first = openTab(t, 'ZZ49', 'Bo', TICKET, { honourReplaced: false });
    clock.advance(30);
    t.start();

    const second = openTab(t, 'ZZ49', 'Bo', TICKET, { honourReplaced: false });
    clock.advance(2000);

    ok(first.dials > 1 || second.dials > 1,
      'ignoring the frame, a superseded tab dials straight back');
    ok(first.capped || second.capped,
      `and the two of them trade the seat until the ${DIAL_CAP}-dial cap stops the test — this is the bug`);
    ok(t.sent.replaced >= DIAL_CAP - 1,
      `${t.sent.replaced} handovers for one device with one seat`);

    // The loop costs a seat nothing and the table everything: the chair is
    // always occupied, so nothing on the host looks wrong at any instant.
    eq(t.engine.seats.length, 4, 'while the scoreboard shows four players, perfectly normal');

    for (const h of [...first.handles, ...second.handles,
      ...fillers.flatMap((f) => f.handles)]) h.destroy();
    t.host.destroy();
    clock.advance(50);
  }

  // --- the farewell sent to a channel that is already gone -----------------
  //
  // THIS PATH RUNS ON EVERY ORDINARY RECONNECT, which makes it the one that
  // had to be got right. A phone in a tunnel is a reclaim too, and the host
  // does not know the difference — so it addresses its last words to a
  // channel that stopped existing minutes ago. A real DataChannel throws
  // InvalidStateError on that, and this send happens INSIDE onJoin: a throw
  // here does not lose a frame, it aborts the join, skips dropConnection and
  // push(), and leaves the returning player on a spinner with their seat
  // already rebound. One dead phone would take the table down.
  //
  // trySend() in js/net.js is what stops it, and before this test nothing
  // made that line matter for this frame.
  {
    const t = tabsTable('ZZ59');
    const TICKET = 'ticket-tunnel';

    // ONE TAB, not two. A phone in a tunnel does not open a second page — the
    // page it already has re-dials, and PeerJS mints a fresh peer id for it,
    // so the host sees a new connection carrying an old ticket. Modelling it
    // as two tabs was the first version of this test and it quietly tested
    // the second-tab case again, with worse wording.
    const fillers = [openTab(t, 'ZZ59', 'Dee', 'ticket-dee'),
      openTab(t, 'ZZ59', 'Eli', 'ticket-eli')];
    const phone = openTab(t, 'ZZ59', 'Cleo', TICKET);
    clock.advance(30);
    t.start();

    const seat = seatOfTicket(t.engine, TICKET);
    ok(seat > 0, `the phone is seated in seat ${seat}`);
    eq(phone.dials, 1, 'on its first dial');
    const handBefore = t.engine.hands[seat].slice();
    ok(handBefore.length > 0, 'holding a hand it would hate to lose');

    // The tunnel. No close on either end, and in-flight data is eaten — which
    // is the one thing vanish() still does that a clean close does not.
    const wire = broker.connectionsOf(phone.net.peer)[0];
    ok(wire, 'the phone has a channel to lose');
    wire.vanish();
    clock.advance(50);
    eq(t.engine.seats[seat].connected, true, 'and nothing below WebRTC tells the host');

    // It comes back. The host now addresses its last words to a channel that
    // stopped existing, before retiring the corpse.
    let threw = null;
    try {
      phone.redial();
      clock.advance(100);
    } catch (e) { threw = e; }

    eq(threw, null, 'sending the farewell to a dead channel does not throw out of onJoin');
    eq(phone.dials, 2, 'the phone dialled once more, as the ladder does');
    eq(t.engine.seats.length, 4, 'the seat came back rather than a new one being made');
    eq(seatOfTicket(t.engine, TICKET), seat, 'the same seat');
    eq(t.engine.seats[seat].connected, true, 'connected again');
    same(t.engine.hands[seat], handBefore, 'holding the same cards it went into the tunnel with');

    // The farewell was attempted. It went nowhere, which is fine and is the
    // whole meaning of best-effort: the connection it was addressed to has
    // nobody behind it to be confused by the silence.
    eq(t.sent.replaced, 1, 'the host did try to say why, exactly once');
    eq(phone.replaced, 0, 'the tunnel ate it, as a tunnel does');

    // AND IT MUST NOT HAVE TOLD ITSELF. The farewell goes to the player id of
    // the connection being retired, and on a reconnect that id belongs to the
    // same human at the same table. Send it to the wrong one and a phone
    // coming out of a tunnel lands on "open in another tab" and stays there —
    // the reconnect case the brief singles out, broken by the fix for a
    // different one.
    eq(phone.stopped, false, 'and the device that came back was not told it had replaced itself');

    // AND THE RECONNECT STILL WORKS, which is the case this whole change must
    // not have broken.
    const before = phone.states;
    ok(before > 0, 'the returning device was sent the table — onJoin ran to the end');
    t.push();
    clock.advance(20);
    ok(phone.states > before, 'and it keeps receiving it');

    for (const h of [...phone.handles, ...fillers.flatMap((f) => f.handles)]) h.destroy();
    t.host.destroy();
    clock.advance(50);
  }

  net.uninstall();
}

{
  // --- a name is never a seat ticket ---------------------------------------
  //
  // The scoreboard is public to everybody by design, so anybody who can read
  // it can type any name on it. If a name reclaimed a seat, reading the
  // scoreboard would be enough to take somebody's hand. The absence of a
  // name-matching branch in addPlayer() is the entire defence, and this is
  // what holds it in place.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });

  table.join('Ben', 'ticket-ben-001');
  table.join('Cleo', 'ticket-cleo-002');
  const dev = table.join('Dev', 'ticket-dev-004');
  clock.advance(20);
  table.engine.setConfig(HOST_ID, { maxHand: 2, shape: 'descending', trumpMethod: 'none', scoring: 'kachuful' });
  ok(table.engine.startMatch(HOST_ID, clock.elapsed()).ok, 'a match is on');
  table.push();
  clock.advance(10);

  const devSeat = dev.seat();
  const devHand = table.engine.hands[devSeat].slice();
  const devId = table.engine.seats[devSeat].id;
  dev.wire().vanish();
  clock.advance(50);

  // Same name, same spelling, different ticket. This is the impostor.
  const fake = table.join('Dev', 'ticket-not-devs-at-all');
  clock.advance(50);

  eq(table.engine.seats.length, 4, 'the impostor is seated nowhere');
  eq(table.engine.seats[devSeat].id, devId, 'the real seat still answers to the real connection');
  same(table.engine.hands[devSeat], devHand, 'holding the hand it always held');
  eq(fake.seat(), -1, 'and the impostor was told about no seat at all');
  ok(fake.rejects.length > 0, `they were refused: "${fake.rejects[0]}"`);

  // SILENCE IS NOT HONESTY: the real ticket still works, against the same
  // table state the impostor just failed against.
  const real = table.join('Dev', 'ticket-dev-004');
  clock.advance(50);
  eq(real.seat(), devSeat, 'while the real ticket gets the chair straight back');
  // AGAINST sortHand(), NOT AGAINST THE DEALT ORDER. privateStateFor() sorts
  // the hand for display — trump pulled to the front, stable across sends so
  // cards do not jump under a thumb — while engine.hands[] keeps the order it
  // was dealt in. Comparing the two directly passes only when the shuffle
  // happens to have dealt in display order, which is a coin toss that this
  // assertion won for a long time and lost the moment an unrelated test
  // above it started a match and moved the deck along.
  same(real.last().priv.hand.map((c) => c.code), sortHand(devHand, table.engine.trump),
    'and the hand with it, in the order the fan is drawn in');

  table.teardown();
  net.uninstall();
}

{
  // --- a second connection from the same peer retires the first ------------
  //
  // PeerJS will happily let one peer open two DataConnections. Overwriting
  // the map entry would leak the first — still open, still counted against
  // the cap, never closed — so it is retired explicitly.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });
  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);
  eq(table.host.playerIds().length, 1, 'one connection');

  const first = ben.wire();
  const second = ben.net.peer.connect(peerIdForCode('QRTX'), { reliable: true });
  clock.advance(50);

  eq(table.host.playerIds().length, 1, 'a second connection from the same peer does not make two');
  eq(first.closed, true, 'the first one was closed rather than leaked');
  eq(second.open, true, 'and the second is the live one');
  eq(table.engine.seats.length, 2, 'with still exactly one seat behind it');

  table.teardown();
  net.uninstall();
}

// ===========================================================================
section('The transport: the broker falls over and the game does not');
// ===========================================================================

{
  // The signalling broker is only an introduction service. Once two devices
  // have shaken hands the DataConnection runs between them and the broker is
  // not in the path at all — so a broker outage is a banner ("nobody new can
  // join"), never an ending. Getting this wrong means a Wi-Fi blip ends a
  // nineteen-round match that was running perfectly well.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });

  table.join('Ben', 'ticket-ben-001');
  table.join('Cleo', 'ticket-cleo-002');
  clock.advance(20);
  table.engine.setConfig(HOST_ID, { maxHand: 2, shape: 'descending', trumpMethod: 'none', scoring: 'kachuful' });
  ok(table.engine.startMatch(HOST_ID, clock.elapsed()).ok, 'a match is running');
  table.push();
  clock.advance(10);

  broker.brokerDown();
  clock.advance(10);
  ok(table.seen.brokerDown >= 1, 'the host is told the broker went away');
  eq(table.host.isOpen(), false, 'and stops claiming new players could arrive');
  eq(table.seen.errors.length, 0, 'the drop itself is a notification, not an error');
  eq(table.seen.drops.length, 0, 'and nobody was disconnected');
  eq(table.host.playerIds().length, 2, 'both connections are still held');

  // THE GAME KEEPS GOING. This is the assertion the whole distinction exists
  // for, and it is made by playing, not by inspecting flags.
  const framesBefore = table.clients.map((c) => c.states.length);
  playUpToRound(clock, table, 1);
  ok(table.engine.history.length >= 1, 'a whole round was played with the broker down');
  eq(table.clients.filter((c, i) => c.states.length > framesBefore[i]).length, 2,
    'and both devices were kept up to date throughout');
  eq(table.clients.filter((c) => c.net.badFrames() > 0).length, 0, 'with nothing malformed');

  // And it comes back on its own, without the caller lifting a finger. The
  // backoff doubles from a second, so this needs real time to pass.
  const upBefore = table.seen.brokerUp;
  broker.brokerUp();
  clock.advance(30000);
  ok(table.seen.brokerUp > upBefore, 'when the broker returns, the socket is re-established');
  eq(table.host.isOpen(), true, 'the host is listening again');
  eq(table.seen.brokerLost, 0, 'and never gave up');
  eq(table.seen.errors.filter(isFatalPeerError).length, 0,
    `not one of the ${table.seen.errors.length} errors along the way was a fatal one`);

  // SILENCE IS NOT HONESTY: prove a new player can actually get in again,
  // rather than only that a flag flipped. The room code survived the blip,
  // which is the reason reconnect() reuses the same peer id.
  const late = table.join('Dev', 'ticket-dev-004');
  clock.advance(50);
  eq(late.opens, 1, 'and a new device can reach the room on the same code it always had');

  // ONE DEVICE, ONE CONNECTION, ACROSS THE BLIP. Every client's own peer lost
  // its socket too, and every client's peer fires 'open' again when that
  // socket is re-established. A client that dialled again on that second
  // 'open' would leave the host holding two channels for one player — the
  // first of which the host then closes, so the player watches their screen
  // blink through a disconnect for no reason whatsoever. The DataConnection
  // stopped needing the broker the moment the handshake finished.
  eq(table.host.playerIds().length, 3, 'the host holds one connection per device, not two');
  eq(table.clients.filter((c) => c.closes > 0).length, 0, 'nobody was disconnected by the recovery');
  same(table.clients.map((c) => c.opens), [1, 1, 1], 'and no device opened a second channel');

  // A SECOND BLIP, because the ladder has to be REARMED by a recovery rather
  // than merely spent by the first outage. A counter that is never reset
  // makes outage one survivable and outage two permanent: the host gives up
  // instantly and from then on the room code answers nobody, forever, at a
  // table that is still happily playing.
  const lostBefore = table.seen.brokerLost;
  const upBefore2 = table.seen.brokerUp;
  broker.brokerDown();
  clock.advance(10);
  ok(table.seen.brokerDown >= 2, 'the broker goes away a second time');
  broker.brokerUp();
  clock.advance(30000);
  ok(table.seen.brokerUp > upBefore2, 'and the host climbs back a second time too');
  eq(table.seen.brokerLost, lostBefore, 'without ever having given up');
  eq(table.host.isOpen(), true, 'the room is listening again');

  const later = table.join('Esha', 'ticket-esha-005');
  clock.advance(50);
  eq(later.opens, 1, 'and the door still works after two outages');

  // TWO LAYERS, TWO JOBS, and the blip changed neither. The transport let
  // both strangers in — that is what `opens` says — and the ENGINE turned
  // them away, because this match started back at the top of the block and a
  // seat is reclaimed by clientId, never handed out fresh to a new ticket
  // mid-match. So the seat count is unchanged, and both of them were TOLD
  // why rather than left connected to a table that ignores them.
  eq(table.engine.seats.length, 3, 'the four-seat table is still the three who started it');
  eq(late.rejects.length, 1, 'the stranger who arrived mid-match was told so');
  eq(later.rejects.length, 1, 'and so was the one after the second outage');
  eq(table.clients.filter((c) => c.closes > 0).length, 0,
    'while nobody who was actually playing lost their connection to either outage');

  table.teardown();
  net.uninstall();
}

{
  // --- the broker never comes back -----------------------------------------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });
  const ben = table.join('Ben', 'ticket-ben-001');
  clock.advance(20);

  const t0 = clock.elapsed();
  broker.brokerDown();
  // Long enough for the whole ladder: five tries, doubling from a second and
  // capping at eight, is a little over half a minute.
  clock.advance(120000);
  eq(table.seen.brokerLost, 1, 'after five tries the host gives up, once and not repeatedly');

  // THE SHAPE OF THE LADDER, not only its outcome. Each failed reconnect
  // surfaces exactly one error, so the gaps between those errors ARE the
  // backoff, measured rather than asserted about. A ladder with a sixth rung
  // and a ladder that fired all five in the same millisecond both satisfy
  // "brokerLost is 1", and one of those is the tight timeout the brief
  // spends a paragraph forbidding.
  //
  // The numbers are written out rather than derived, for the same reason the
  // reaper's 30000 is: BROKER_RETRIES is deliberately not exported, and a
  // test that imported it would agree with whatever somebody put there.
  same(table.seen.errorAt.map((t) => t - t0), [1000, 3000, 7000, 15000, 23000],
    'five tries, doubling from one second and capping at eight');
  ok(table.seen.lostAt - t0 >= 20000,
    `it spent ${(table.seen.lostAt - t0) / 1000}s trying before saying so, against a ~10s budget`);

  // Each failed retry DOES surface a peer error, and it should — deciding
  // what to put on screen is the caller's job, not this module's. What must
  // be true is that not one of them says to quit: isFatalPeerError is the
  // question main.js will ask about each, and the answer to every one is no.
  // A signalling failure is a banner, because the game is still running.
  ok(table.seen.errors.length > 0, `${table.seen.errors.length} retries failed and said so`);
  eq(table.seen.errors.filter(isFatalPeerError).length, 0, 'and not one of them was fatal');
  same([...new Set(table.seen.errors.map((e) => e.type))], ['network'],
    'they are all the same thing: the broker could not be reached');

  // GIVING UP IS NOT QUITTING. The existing connection is untouched, and
  // saying so requires sending something down it rather than reading a flag.
  eq(ben.closes, 0, 'the connection that was already up is still up');
  const before = ben.states.length;
  table.push();
  clock.advance(10);
  eq(ben.states.length, before + 1, 'and still carrying state to the device on the other end');

  table.teardown();
  net.uninstall();
}

{
  // --- two ways one blip can be turned into a mess -------------------------
  //
  // Both claims here are about a reconnect() call that must NOT happen, and a
  // call that does not happen leaves no trace in any counter, any flag or any
  // frame. So the assertion is on the call itself — the same reason
  // stateFrameFor is checked by watching what it asks privateFor() for.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'ZZ43' });
  table.join('Ben', 'ticket-ben-001');
  clock.advance(20);

  const peer = table.host.peer;
  let attempts = 0;
  const realReconnect = peer.reconnect.bind(peer);
  peer.reconnect = (...a) => { attempts++; return realReconnect(...a); };

  // (1) PeerJS can emit 'disconnected' more than once for a single outage.
  // Without the `timer` guard each emission arms a timer of its own, so one
  // blip becomes several ladders climbing in lockstep: multiplied traffic
  // from a phone that is already struggling, and a give-up that fires early
  // because the shared counter is being advanced several times per rung.
  broker.brokerDown();
  clock.advance(0);                        // deliver the first 'disconnected'
  eq(attempts, 0, 'nothing is retried in the same instant the socket drops');
  peer.emit('disconnected', peer.id);
  peer.emit('disconnected', peer.id);
  // Past the first rung at one second and well short of the second at three.
  clock.advance(2500);
  eq(attempts, 1, 'three notifications of one outage still make exactly one attempt');
  eq(table.seen.brokerLost, 0, 'and nothing has been given up on');

  // (2) The socket can come back WITHOUT the ladder — PeerJS reopens it on
  // some paths and clears its own disconnected flag — while a retry timer is
  // already armed. Calling reconnect() on a live peer is an error in the
  // library, and this function is the last thing that should be generating
  // errors, since it is what runs when the connection is already unwell.
  broker.healSocket(peer);
  clock.advance(0);
  eq(peer.disconnected, false, 'the socket healed on its own, with a timer still pending');
  const healedAt = attempts;
  clock.advance(60000);
  eq(attempts, healedAt, 'and the pending timer left the healthy socket alone');
  eq(table.host.isOpen(), true, 'which is still up');
  eq(table.seen.brokerLost, 0, 'and still not given up on');

  table.teardown();
  net.uninstall();
}

{
  // --- one dead channel does not stop the broadcast ------------------------
  //
  // conn.send() on a DataChannel that closed between the `open` check and the
  // send throws InvalidStateError, and it happens for real: the check and the
  // send are two statements and a phone can leave the building in between.
  // Without trySend()'s catch, the FIRST dead connection in the loop takes
  // out the push for everybody after it — so five people freeze because one
  // person went into a lift.
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;
  const table = liveTable(clock, { code: 'QRTX' });

  const boxes = ['Ben', 'Cleo', 'Dev', 'Esha'].map((n, i) => table.join(n, `ticket-${n.toLowerCase()}-00${i}`));
  clock.advance(20);
  eq(table.host.playerIds().length, 4, 'four devices connected');

  // The FIRST one in the map, deliberately — a catch that only covered the
  // last connection would pass a test that broke any other one.
  const firstConnId = [...table.host.connections.keys()][0];
  table.host.connections.get(firstConnId).breakSend = true;

  const before = boxes.map((b) => b.states.length);
  table.push();
  clock.advance(20);

  const doomed = boxes.find((b) => playerIdForConn(b.net.peer.id) === playerIdForConn(firstConnId));
  const others = boxes.filter((b) => b !== doomed);
  eq(others.length, 3, 'three of them behind the broken one in the loop');
  eq(others.filter((b) => b.states.length === before[boxes.indexOf(b)] + 1).length, 3,
    'every one of them still received the push');
  eq(doomed.states.length, before[boxes.indexOf(doomed)],
    'and the dead channel simply received nothing, which is all that can be done');
  eq(table.seen.errors.length, 0, 'the host did not error');

  // It keeps working afterwards too — a throwing send must not leave the host
  // in a state where the NEXT push is also lost.
  table.host.connections.get(firstConnId).breakSend = false;
  const mid = boxes.map((b) => b.states.length);
  table.push();
  clock.advance(20);
  eq(boxes.filter((b, i) => b.states.length === mid[i] + 1).length, 4,
    'and once the channel recovers, all four are served again');

  table.teardown();
  net.uninstall();
}

// ===========================================================================
section('The transport: what it says when it cannot work');
// ===========================================================================

// Every PeerJS error type the library documents, plus the two this module
// mints itself, plus the things that are not error objects at all. A peer
// error arrives from a third-party library over a network — assuming it has
// a `type`, or is even an object, is assuming something nobody has checked.
const ERROR_CORPUS = [
  { type: 'browser-incompatible' }, { type: 'disconnected' }, { type: 'invalid-id' },
  { type: 'invalid-key' }, { type: 'network' }, { type: 'peer-unavailable' },
  { type: 'ssl-unavailable' }, { type: 'server-error' }, { type: 'socket-error' },
  { type: 'socket-closed' }, { type: 'unavailable-id' }, { type: 'webrtc' },
  { type: 'peer-missing' }, { type: 'bad-code' },
  // Not errors, or not shaped like them.
  null, undefined, {}, [], 'network', 42, true,
  { type: null }, { type: 123 }, { type: {} }, { type: ['network'] },
  { message: 'no type at all' }, { type: '' },
  // Prototype keys, because UNRECOVERABLE is a Set and describePeerError is a
  // switch — but the day either becomes a plain object, these are what turn a
  // lookup into an inherited truthy value.
  { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' },
  { type: 'hasOwnProperty' }, { type: 'valueOf' },
  // A message that is hostile rather than absent. The default branch
  // concatenates it, and it is read aloud off somebody's phone.
  { type: 'unknown-thing', message: 'x'.repeat(5000) },
  { type: 'unknown-thing', message: null },
  { type: 'unknown-thing', message: { toString() { throw new Error('nope'); } } },
];

{
  // --- isFatalPeerError: what is worth giving up over ----------------------
  let threw = 0, nonBool = 0;
  for (const err of ERROR_CORPUS) {
    let out;
    try { out = isFatalPeerError(err); } catch (_) { threw++; continue; }
    if (typeof out !== 'boolean') nonBool++;
  }
  eq(threw, 0, `isFatalPeerError survives all ${ERROR_CORPUS.length} of them`);
  eq(nonBool, 0, 'and answers true or false every time, never a truthy value');

  // THE SET IS DERIVED, NOT COPIED. UNRECOVERABLE is deliberately not
  // exported, so the fatal set is whatever the function actually says it is —
  // which means this test cannot drift from the source, and equally cannot
  // rubber-stamp it.
  const fatal = ERROR_CORPUS.filter(isFatalPeerError).map((e) => e.type);
  ok(fatal.length > 0, `${fatal.length} error types are treated as fatal`);
  eq(fatal.length, new Set(fatal).size, 'each named once');

  // The distinction that matters, asserted as a property rather than a list:
  // a signalling failure leaves existing DataConnections running device to
  // device, so it is a banner. Only a broken identity, a code that is not a
  // code, or a browser that cannot do WebRTC at all is an ending.
  for (const t of ['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']) {
    eq(isFatalPeerError({ type: t }), false, `'${t}' is a broker problem, and the game survives it`);
  }
  for (const t of ['browser-incompatible', 'unavailable-id', 'peer-missing', 'bad-code']) {
    eq(isFatalPeerError({ type: t }), true, `'${t}' means there is no game to have`);
  }
  // peer-unavailable is the interesting one: the code was typed wrong or the
  // host closed the tab. Not fatal, because the answer is "check the code and
  // try again", and that is a screen with a button on it, not a dead end.
  eq(isFatalPeerError({ type: 'peer-unavailable' }), false,
    'a wrong room code is a thing to retype, not a thing to give up over');

  for (const t of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    eq(isFatalPeerError({ type: t }), false, `'${t}' is not inherited into the fatal set`);
  }
}

{
  // --- describePeerError: every one of these is read aloud off a phone -----
  let empty = 0, unpunctuated = 0, threw = 0, notString = 0;
  const said = new Set();
  for (const err of ERROR_CORPUS) {
    let msg;
    try { msg = describePeerError(err); } catch (_) { threw++; continue; }
    if (typeof msg !== 'string') { notString++; continue; }
    if (msg.trim() === '') empty++;
    if (!msg.endsWith('.')) unpunctuated++;
    said.add(msg);
  }
  eq(threw, 0, `describePeerError survives all ${ERROR_CORPUS.length} of them`);
  eq(notString, 0, 'and always hands back a string');
  eq(empty, 0, 'never an empty one');
  eq(unpunctuated, 0, 'always a finished sentence');
  ok(said.size > 5, `${said.size} distinct sentences, so the branches are not all one message`);

  // EVERY FATAL TYPE GETS A BESPOKE SENTENCE. A player who has hit a dead end
  // is the one who most needs to be told which dead end, and the default
  // branch says "Connection problem: unknown error." — which is exactly what
  // the brief means by a message that says nothing.
  const fatal = ERROR_CORPUS.filter(isFatalPeerError);
  let generic = 0;
  for (const err of fatal) {
    if (describePeerError(err).startsWith('Connection problem:')) {
      generic++;
      console.error('  ✗ falls through to the default:', err.type);
    }
  }
  eq(generic, 0, `all ${fatal.length} fatal types have a sentence of their own`);

  // And each of those sentences says what to DO. "Network error" says
  // nothing; every one of these names an action.
  const ACTIONS = ['check', 'reload', 'try', 'go back'];
  let actionless = 0;
  for (const err of fatal.concat([{ type: 'network' }, { type: 'peer-unavailable' }, { type: 'webrtc' }])) {
    const msg = describePeerError(err).toLowerCase();
    if (!ACTIONS.some((a) => msg.includes(a))) { actionless++; console.error('  ✗ no action:', err.type); }
  }
  eq(actionless, 0, 'and every one of them tells the player something to try');

  // The hostile-message cases go through the default branch, which
  // concatenates. A five-thousand-character "message" from a third-party
  // library must not become five thousand characters of banner.
  const huge = describePeerError({ type: 'unknown-thing', message: 'x'.repeat(5000) });
  ok(huge.endsWith('.'), 'a hostile error message still produces a finished sentence');

  // AND IT HAS TO BE SHORT. "Finished sentence" is satisfied by five thousand
  // characters with a full stop on the end, which is a page of gibberish
  // pushed under a heading on a phone — and it pushes the room code and the
  // button to retry off the bottom of the screen, so the one error the player
  // could have recovered from becomes the one they cannot. The bound is
  // derived: the cap this module applies to a refusal, plus the fixed wrapper
  // this branch puts around it. Copying a number here would agree with any
  // number somebody later put in net.js.
  const WRAPPER = 'Connection problem: .'.length;
  let tooLong = 0;
  for (const err of ERROR_CORPUS) {
    if (describePeerError(err).length > MAX_REJECT_LEN + WRAPPER) {
      tooLong++;
      console.error('  ✗ overlong banner:', err.type, describePeerError(err).length);
    }
  }
  eq(tooLong, 0, `none of the ${ERROR_CORPUS.length} banners exceeds ${MAX_REJECT_LEN + WRAPPER} characters`);

  // Cut short, not cut out. A cap that threw the detail away entirely would
  // also pass the line above, and then a library error nobody can search for
  // is all the player is left with.
  ok(huge.includes('xxxxxxxxxx'), 'and what the library actually said survives the trim');
}

{
  // --- the CDN did not load, and the code was not a code -------------------
  const net = installPeerJS();
  broker = net.broker;
  const { clock } = net;

  // The shapes of the two real handles, read off real ones rather than
  // written down. The inert handle has to satisfy both, because the caller
  // that reaches for a method on it is a click handler on the one device
  // where the transport was ALREADY broken — and a TypeError there replaces a
  // sentence the player could act on with a blank screen.
  const realHost = createHost('QRTX', {});
  const realClient = joinHost('QRTX', {});
  clock.advance(20);
  const hostKeys = Object.keys(realHost);
  const clientKeys = Object.keys(realClient);
  const union = [...new Set([...hostKeys, ...clientKeys])].sort();
  realHost.destroy();
  realClient.destroy();
  clock.advance(20);
  ok(union.length >= 10, `the two real handles have ${union.length} keys between them`);

  const checkInert = (label, make, expectType, mustHave) => {
    // ASYNCHRONOUSLY, and that is the whole reason for the setTimeout in
    // inertTransport. A synchronous callback fires before `const net = ...`
    // has finished assigning, so the handler runs against a half-assigned
    // variable — a worse bug than the one being reported, and one that only
    // happens on the devices that were already having a bad day.
    let handle = null;
    let sawWhenCalled = 'never called';
    const h = make({ onError: (e) => { sawWhenCalled = handle; if (handle) handle.reportedType = e && e.type; } });
    handle = h;
    eq(sawWhenCalled, 'never called', `${label}: nothing has fired by the time the caller holds the handle`);

    clock.advance(0);
    eq(sawWhenCalled, h, `${label}: and when the error does arrive, the handle is fully assigned`);
    eq(h.reportedType, expectType, `${label}: reporting '${expectType}'`);
    ok(describePeerError({ type: expectType }).length > 20,
      `${label}: which has a sentence a player can act on`);

    const missing = mustHave.filter((k) => !(k in h));
    same(missing, [], `${label}: the handle carries every key a working one would`);
    const wrongType = mustHave.filter((k) => k !== 'peer' && k !== 'connections' && typeof h[k] !== 'function');
    same(wrongType, [], `${label}: and every method is callable`);

    // Call all of them. Nothing throws, and nothing claims to be working.
    let broke = 0;
    for (const k of mustHave) {
      if (typeof h[k] !== 'function') continue;
      try { h[k]('peer:anything', { type: 'noop' }); } catch (_) { broke++; console.error('  ✗ threw:', label, k); }
    }
    eq(broke, 0, `${label}: and not one of them throws when called`);
    eq(h.isOpen(), false, `${label}: it does not claim to be open`);
    same(h.playerIds(), [], `${label}: or to be holding anybody`);
    eq(h.refusedFrames(), 0, `${label}: with nothing refused`);
    eq(h.badFrames(), 0, `${label}: and nothing malformed`);
  };

  // THE BLOCKED CDN. PeerJS is a UMD bundle from a <script> tag, so this is
  // not hypothetical: a first load on a captive-portal Wi-Fi, an ad blocker
  // with a broad rule, or a corporate proxy all produce exactly this.
  withoutPeerJS(() => {
    eq(peerAvailable(), false, 'with no PeerJS on the page, the module knows it');
    checkInert('no PeerJS, hosting', (hs) => createHost('QRTX', hs), 'peer-missing', union);
    checkInert('no PeerJS, joining', (hs) => joinHost('QRTX', hs), 'peer-missing', clientKeys);

    // KEY PARITY WITH BOTH REAL HANDLES, exactly as inertTransport claims.
    // That claim is a comment, and a comment is the kind of thing that stays
    // written down long after it stopped being true — so it is checked here
    // against handles read off the real functions a moment ago.
    same(Object.keys(createHost('QRTX', {})).sort(), union,
      'the inert host handle is precisely the union of both real ones');
    const inertClient = joinHost('QRTX', {});
    same(union.filter((k) => !(k in inertClient)), ['connections'],
      'and the inert client handle is that union less the one key only a host has');
    clock.advance(0);
  });
  ok(peerAvailable(), 'and knows it again when the library is there');

  // A CODE THAT IS NOT A CODE. Distinct from peer-missing on purpose: the
  // library is fine and the four characters are not, so the sentence has to
  // be about the characters.
  //
  // WHICH INPUTS THOSE ARE IS DERIVED, not asserted from memory. My first
  // draft of this list had 'x'.repeat(500) and {} in it as obviously-invalid
  // codes; they are not. normalizeCode keeps the first four usable characters
  // of whatever it is handed, so five hundred x's is the perfectly good room
  // code XXXX, and '[object Object]' is BJEC. That is the alphabet working as
  // designed — the failure was mine for assuming otherwise, and the fix is to
  // ask rather than assume.
  const CODE_INPUTS = ['', 'O0I1', '!!!!', null, undefined, 42, [], 'QR', '   ', '\n\t',
    'x'.repeat(500), {}, '  qrtx  ', 'QRTX!!'];
  const refused = CODE_INPUTS.filter((c) => peerIdForCode(c) === null);
  const accepted = CODE_INPUTS.filter((c) => peerIdForCode(c) !== null);
  ok(refused.length >= 6, `${refused.length} of those inputs are not room codes`);
  ok(accepted.length >= 3, `and ${accepted.length} of them are, after normalising`);

  for (const bad of refused) {
    const label = `bad code ${JSON.stringify(bad === undefined ? 'undefined' : bad).slice(0, 20)}`;
    checkInert(`${label}, hosting`, (hs) => createHost(bad, hs), 'bad-code', union);
    checkInert(`${label}, joining`, (hs) => joinHost(bad, hs), 'bad-code', clientKeys);
  }

  // The other half: an input that DOES normalise gets a real transport, at
  // the address of the code it normalised to. Without this the block above
  // would pass just as well against a peerIdForCode that returned null for
  // everything, and every player would be told their code was wrong.
  let realOnes = 0;
  for (const good of accepted) {
    const h = createHost(good, {});
    clock.advance(20);
    if (h.peer && codeFromPeerId(h.peer.id) === normalizeCode(good)) realOnes++;
    h.destroy();
    clock.advance(10);
  }
  eq(realOnes, accepted.length, 'each of which opens a real room, at the code it cleans up to');

  // The two failures must not be confused for one another — "reload, you need
  // the internet" and "check the four characters" send a player to two
  // different places, and only one of them is where the problem is.
  ok(describePeerError({ type: 'peer-missing' }) !== describePeerError({ type: 'bad-code' }),
    'and the two failures are never described in the same words');

  net.uninstall();
}

{
  // --- the broker configuration --------------------------------------------
  //
  // null means PeerJS's own public cloud, and that is a decision rather than
  // an omission: the brief says static only, no backend, no accounts. An
  // object here would be a server somebody has to run, and the day it went
  // down every copy of this game would stop working with no way to fix it.
  eq(BROKER_CONFIG, null, 'there is no broker of our own, on purpose');
  eq(serverConfigured(), false, 'and no backend anywhere else either');
}

// ###########################################################################
//
//  7. THE SHELL
//
//  index.html, manifest.webmanifest, the icons and sw.js. None of them are
//  modules, so none of them are reachable by any other test in this file, and
//  until this section existed NOTHING in the repository ever parsed sw.js —
//  the first execution would have been in a real browser, on a real deploy,
//  where the failure mode of a broken service worker is a site that serves a
//  stale shell to returning visitors and cannot be fixed by pushing a commit.
//
//  So sw.js is not inspected here, it is RUN: instantiated against a fake
//  ServiceWorkerGlobalScope and a fake Cache API, with its install, activate
//  and fetch handlers driven the way a browser would drive them.
//
// ###########################################################################

// REPO and readRepo are defined at the top of the file now — the UI section
// reads js/ui.js as text as well, and it runs long before this one.

section('The shell: every asset shipped, and every asset cached');

{
  // --- SHELL against the disk, in both directions ---------------------------
  //
  // The rule sw.js states is "everything in js/ and css/ and icons/". A rule
  // is only worth writing down if something checks it, and the thing that
  // would otherwise check it is somebody remembering, three weeks from now,
  // while adding a module. The failure they would cause is invisible online
  // and total offline, which is the worst place for it to hide.
  //
  // DERIVED FROM THE DISK, not from a second copy of the list. A hand-written
  // expected list here would agree with a hand-written SHELL exactly as often
  // as both were edited together, which is the thing being guarded against.

  // Executing the file rather than regexing it, via loadSwConsts() at the top
  // — shared with --write-stamp so that the writer and the checker cannot
  // disagree about what sw.js says.
  const constsOnly = loadSwConsts();
  if (constsOnly.error) {
    failed++;
    console.error('  ✗ FAIL: sw.js does not parse —', constsOnly.error.message);
  } else {
    passed++;
  }

  const SHELL = constsOnly.SHELL;
  const CACHE_NAME = constsOnly.CACHE_NAME;
  const SHELL_STAMP = constsOnly.SHELL_STAMP;

  ok(Array.isArray(SHELL) && SHELL.length > 0, 'sw.js exports a non-empty SHELL');
  ok(typeof CACHE_NAME === 'string' && /^judgement-/.test(CACHE_NAME),
    `the cache name is namespaced to this app — got ${JSON.stringify(CACHE_NAME)}`);

  // EVERY PATH RELATIVE. A leading slash resolves to the origin root, and on a
  // GitHub Pages project site the app lives at /<repo>/ — so '/js/main.js'
  // would 404 during install, addAll would reject, and the worker would never
  // activate at all. Silently: the only symptom is that offline never works.
  let absolute = 0;
  for (const p of SHELL) if (!p.startsWith('./')) { absolute++; console.error('  ✗ not relative:', p); }
  eq(absolute, 0, `all ${SHELL.length} SHELL paths are relative, so a Pages subpath survives`);

  // No duplicates. addAll tolerates them, but a duplicate means the list was
  // edited twice by two people who each thought they were adding it.
  eq(new Set(SHELL).size, SHELL.length, 'and no path is listed twice');

  // --- direction one: everything in SHELL exists ----------------------------
  let missing = 0;
  for (const p of SHELL) {
    // './' is the directory, served as index.html — there is no file of that
    // name to stat, and it is listed deliberately (see the comment in sw.js).
    if (p === './') continue;
    try { readFileSync(REPO + p.slice(2)); } catch (_) {
      missing++; console.error('  ✗ SHELL lists a file that is not there:', p);
    }
  }
  eq(missing, 0, 'every file SHELL precaches is actually in the repository');

  // --- direction two: everything on disk is in SHELL ------------------------
  //
  // This is the direction that catches the real mistake. The one above only
  // fails when a file is DELETED, which somebody notices; this one fails when
  // a file is ADDED, which is the case nobody notices.
  const listed = new Set(SHELL);
  let unlisted = 0;
  let onDisk = 0;
  for (const dir of ['js', 'css', 'icons']) {
    for (const name of readdirSync(REPO + dir)) {
      onDisk++;
      if (!listed.has(`./${dir}/${name}`)) {
        unlisted++;
        console.error(`  ✗ ${dir}/${name} is shipped but never precached`);
      }
    }
  }
  eq(unlisted, 0, `and all ${onDisk} files under js/, css/ and icons/ are in it`);
  // The pairing. "Nothing unlisted" is also true of an empty directory, and an
  // empty directory is what a broken REPO path would produce.
  ok(onDisk >= 17, `with ${onDisk} files actually found to check — the sweep is not empty`);

  // The page and the manifest are not under those three directories, so they
  // are named rather than swept. Without this, deleting './index.html' from
  // SHELL would pass everything above and break offline completely.
  for (const must of ['./', './index.html', './manifest.webmanifest']) {
    ok(listed.has(must), `SHELL precaches ${must}`);
  }

  // NOTHING CROSS-ORIGIN, EVER. This is the beacon rule stated as an
  // assertion: a precached PeerJS bundle is a stale library, and a precached
  // signalling response is a room code that connects to a conversation that
  // ended yesterday.
  let external = 0;
  for (const p of SHELL) if (/^https?:|^\/\//.test(p)) { external++; console.error('  ✗ external:', p); }
  eq(external, 0, 'and not one byte of anybody else’s origin is precached');

  // --- the stamp ------------------------------------------------------------
  //
  // THE CHECK THIS WHOLE SECTION EXISTED WITHOUT. Everything above asks
  // "does SHELL name the right files"; none of it asks "does CACHE_NAME
  // change when those files do", and that second question is the one that
  // decides whether a returning visitor ever sees a fix.
  //
  // The failure is not hypothetical and it is not rare. caches.addAll() is a
  // no-op against a cache that already exists under the name being opened, so
  // a deploy that keeps the name keeps serving the old bytes to everyone who
  // has visited before — forever, silently, with a green suite. It happened
  // here: five user-visible bugs were fixed across six files with the cache
  // name left at 'v1', and the only thing between those fixes and the people
  // they were for was somebody remembering to edit one line.
  //
  // A hand-written version number cannot be checked, because no test can know
  // whether you MEANT the bytes to change. A fingerprint of the bytes can, and
  // that is the entire reason sw.js carries a hash instead of a counter.
  //
  // NOTE WHAT MAKES THIS COMPUTABLE AT ALL: sw.js is not in SHELL. A worker
  // does not precache itself, so the file holding the hash is not among the
  // files being hashed, and there is no fixed point to solve for. If somebody
  // ever adds './sw.js' to the list, this stops being arithmetic and starts
  // being impossible — so that is asserted rather than assumed.
  ok(!SHELL.includes('./sw.js'),
    'sw.js does not precache itself — which is what makes a content stamp computable');

  // The hash itself lives in shellStampOf() at the top of this file, because
  // --write-stamp computes the same number and a second copy of the rule is a
  // second rule. See the comment there.
  //
  // Hoisted out of the block below because the writer section further down
  // compares against `computed` rather than against SHELL_STAMP. That is not a
  // style choice: comparing the writer's answer to the file's literal would
  // make the writer's assertions fail on every legitimately stale stamp, which
  // in the mutation table means every row in it — and a diagnosis column that
  // says the same thing for sixty different mutations has stopped being a
  // diagnosis. Writer-agrees-with-checker is the property; is-the-file-current
  // is already asserted once, below, and does not need saying twice.
  const { stamp: computed, hashed, unreadable } = shellStampOf(SHELL);

  {
    // The pairing. A hash of nothing is still a hash, and it would compare
    // unequal and print a confident-looking value to paste. If the files could
    // not be read, say THAT instead.
    eq(unreadable, 0, 'every file in the stamp could be read off disk');
    ok(hashed >= 20, `the stamp is computed over ${hashed} files, not over an empty sweep`);

    if (SHELL_STAMP !== computed) {
      // THE FAILURE FIXES ITSELF. This is the difference between a check that
      // enforces a rule and a check that nags about one: nobody has to work
      // out what the new stamp is, or know that line endings are normalised.
      // They run one command. "Remember to bump this" becomes "the suite bumps
      // it" — and the paste-this line stays below it for anyone who would
      // rather see the twelve characters before a script touches their file.
      console.error('  ✗ FAIL: sw.js SHELL_STAMP is stale — the shell changed and the cache name did not.');
      console.error('           Returning visitors would keep the old build. Fix it with:');
      console.error('               npm run stamp');
      console.error(`           (or paste: const SHELL_STAMP = '${computed}';`);
      console.error(`            currently '${SHELL_STAMP}', over ${hashed} files)`);
    }
    eq(SHELL_STAMP, computed, 'SHELL_STAMP is the fingerprint of the files SHELL precaches');

    // And the stamp has to actually be the cache name, or it is decoration.
    // DERIVED from SHELL_STAMP rather than written out: a literal here would
    // be a third copy of the same string to keep in step, and the prefix is
    // load-bearing on its own — the activate handler deletes by it, which is
    // what stops this worker clearing a sibling project's caches on the same
    // github.io origin.
    eq(CACHE_NAME, `judgement-shell-${SHELL_STAMP}`,
      'and the cache is named after it, with the prefix activate() deletes by');

    console.log(`  shell stamp: ${SHELL_STAMP} over ${hashed} files`);
  }

  // --- the writer that fixes a stale stamp ----------------------------------
  //
  // `npm run stamp` rewrites the line the check above enforces, which makes it
  // the one piece of tooling in the repository that can turn this section
  // green without anybody fixing anything. Its guards are therefore not a
  // convenience — they are the reason it is allowed to exist — and they are
  // driven here with inputs that could not be produced any other way without
  // damaging the working tree to test the thing that protects it.
  {
    const realSw = loadSwConsts();
    const plan = planStampWrite(realSw);

    // THE HAPPY PATH FIRST, because every refusal below is only interesting if
    // the writer would otherwise have said yes.
    eq(plan.refuse, null, 'the stamp writer accepts the repository as it stands');
    // AGAINST `computed`, NOT AGAINST THE FILE'S LITERAL. The property is that
    // the writer and the checker arrive at the same number, and that stays
    // true while the stamp is stale — which is the state the writer exists to
    // resolve and the state every mutation in the table puts the tree into.
    eq(plan.stamp, computed,
      'and the number it would write is the number the check above demands — the writer and the checker cannot disagree');
    eq(plan.was, SHELL_STAMP, 'it read the current value out of the file correctly');

    // It rewrites the declaration and NOTHING ELSE. The sharpest way to say
    // that is by length: a replacement of one twelve-character stamp with
    // another leaves the file exactly as long, and any collateral edit —
    // dropping the rest of the line, matching inside a comment, eating a
    // newline — moves it. Derived from the real file so it stays true when
    // sw.js grows.
    const rewritten = realSw.src.replace(STAMP_ANCHOR, `const SHELL_STAMP = '${'0'.repeat(12)}';`);
    eq(rewritten.length, realSw.src.length, 'writing a stamp changes the file length by nothing');
    eq((rewritten.match(new RegExp(STAMP_ANCHOR.source, 'gm')) || []).length, 1,
      'and leaves exactly one stamp declaration behind');
    ok(rewritten.includes("const SHELL_STAMP = '000000000000';"),
      'and the line it leaves is the one it meant to write');

    // IDEMPOTENT. Running it twice must not produce a different file the
    // second time, or "run it until it settles" becomes a real instruction.
    eq(planStampWrite(realSw).next, plan.next, 'planning the same write twice plans the same bytes');

    // --- and now every way it must refuse ------------------------------------
    //
    // Each of these is a state in which the writer would otherwise paste a
    // confident-looking twelve characters over the deploy blocker, and the
    // checker would then agree with it. A wrong stamp is strictly worse than a
    // stale one: stale is caught on the next run, wrong is never caught again.
    const refusals = [
      ['sw.js does not parse',
        { ...realSw, error: new Error('Unexpected token') }, /does not parse/],
      ['SHELL comes back empty',
        { ...realSw, SHELL: [] }, /no usable SHELL/],
      ['SHELL is not an array at all',
        { ...realSw, SHELL: null }, /no usable SHELL/],
      // The one that matters most. A rename that misses this list leaves paths
      // that read perfectly well and hash to nothing, and the digest of the
      // remaining files is a real number that is not the right number.
      ['a file in SHELL is not on disk',
        { ...realSw, SHELL: [...realSw.SHELL, './js/does-not-exist.js'] }, /could not be read/],
      ['the sweep is too small to be the shell',
        { ...realSw, SHELL: ['./index.html', './css/app.css'] }, /only 2 files/],
      // Two anchors means the file is not shaped the way the writer assumes,
      // and "edit the first one" is a guess. Built by duplicating the real
      // line rather than by writing a second one out, so it stays a duplicate.
      // These two match on `^found N ` rather than on the full refusal text,
      // and that is about the MUTATION HARNESS rather than about the writer.
      // scripts/_mutate-fixes.mjs decides which failure line to report by
      // stepping over anything matching /SHELL_STAMP/ — every mutation makes
      // the stamp stale, so that line is noise in sixty rows out of sixty. A
      // failure message here that quoted the token verbatim would be swept up
      // by that filter and scored as "only the stamp moved", i.e. as a
      // mutation nothing caught. The assertion still checks the real string;
      // it just does not repeat the word in its own name.
      ['sw.js carries two stamp declarations',
        { ...realSw, src: realSw.src.replace(STAMP_ANCHOR, (m) => `${m}\n${m}`) }, /^found 2 /],
      ['sw.js carries none the writer recognises',
        { ...realSw, src: realSw.src.replace(STAMP_ANCHOR, 'const SHELL_STAMP = shellStamp();') },
        /^found 0 /],
    ];

    for (const [what, broken, why] of refusals) {
      const got = planStampWrite(broken);
      ok(typeof got.refuse === 'string' && why.test(got.refuse),
        `the stamp writer refuses when ${what} — expected /${why.source}/, got ${JSON.stringify(got.refuse)}`);
      // AND THE REFUSAL IS THE WHOLE ANSWER. A reason string beside a usable
      // `next` is a writer that explains itself and then does it anyway, which
      // is the failure mode a caller reading only one field would never see.
      //
      // ok() AND NOT eq(), which is not a style preference. eq() prints the
      // value it got, and the value here would be an entire copy of sw.js:
      // unreadable on its own terms, and — because that copy contains the
      // string SHELL_STAMP — swept up by the mutation harness's noise filter,
      // which steps over stamp failures because every mutation causes one.
      // The row for this assertion came back ONLY THE STAMP, scoring a caught
      // mutation as an uncaught one, while the assertion underneath it was
      // firing exactly as intended. An assertion message is read by tooling as
      // well as by people.
      ok(got.next === null, `and produces no replacement text when ${what}`);
    }

    // Nothing above touched the disk — the point of planning separately from
    // writing — so say so rather than leaving it to be inferred.
    eq(loadSwConsts().SHELL_STAMP, SHELL_STAMP,
      'and none of that moved the stamp in the actual file');
  }

  // --- and the writer cannot be smuggled into the check ---------------------
  //
  // THE ONE WAY THE ABOVE CAN BE MADE MEANINGLESS. --write-stamp gives this
  // file permission to edit sw.js, and the assertion three lines up is the
  // thing it is allowed to edit its way out of. Those two facts are safe apart
  // and dangerous together, and the only thing keeping them apart is that
  // nobody runs the writer as part of the check.
  //
  // "Nobody does that today" is a property of the callers, not of the code —
  // the same sentence that preceded half the findings in this repository. The
  // realistic version is not malice: it is a green suite on a machine where
  // the stamp keeps going stale, somebody appends the flag to the test script
  // to stop the noise, and from then on every run repairs the deploy blocker
  // it was written to catch and reports 121,000 passes while doing it. There
  // would be no failing test, because the test would have been fixed.
  //
  // So the fence is asserted, not just described in the comment beside it.
  // Checking process.argv here would prove nothing — this line only runs on
  // the branch where the flag was absent. What has to be checked is the
  // COMMAND, which is the thing a future reader would actually edit.
  {
    const pkg = JSON.parse(readRepo('package.json'));
    const scripts = pkg.scripts || {};

    ok(typeof scripts.test === 'string' && scripts.test.includes('test-engine.mjs'),
      'package.json still runs the suite from npm test');
    ok(!/--write-stamp/.test(scripts.test || ''),
      'and npm test does NOT pass --write-stamp — the runner cannot rewrite the stamp it is checking');

    // The writer needs a way in of its own, or the pressure to put it in the
    // test script comes straight back. Derived from the flag string rather
    // than from a copy of the whole command: what matters is that some script
    // offers it and that it is not the one CI runs.
    const offering = Object.entries(scripts).filter(([, cmd]) => /--write-stamp/.test(cmd));
    eq(offering.length, 1, 'exactly one npm script offers --write-stamp');
    ok(offering.length === 1 && offering[0][0] !== 'test',
      `and it is not the test script — it is npm run ${offering.length === 1 ? offering[0][0] : '?'}`);

    // The failure message above tells the reader to run it by that name, so
    // the name is part of the contract and not a detail of package.json.
    ok(Object.prototype.hasOwnProperty.call(scripts, 'stamp'),
      'the script is called "stamp", which is what the stale-stamp failure tells you to run');
  }

  // --- where the worker lives, as stated in prose ---------------------------
  //
  // sw.js is at the repository ROOT and that is forced, not chosen: a worker's
  // default scope is the directory it is served from, so a worker at
  // ./js/sw.js could only ever control ./js/* and would never see a navigation
  // to the page. Widening scope needs a Service-Worker-Allowed response
  // header, which GitHub Pages does not let you set. So the location is a
  // constraint of the platform, and "move it in with the other modules" is a
  // tidy-up that silently turns offline support off.
  //
  // js/config.js told the next reader to look in js/ for it. That is the
  // cheapest possible bug to ship and among the more expensive to act on,
  // because the person following the instruction concludes the file is missing
  // and writes a new one. Prose is not tested by anything else in this file,
  // so the two halves are asserted TOGETHER: the location is read off the
  // disk, and then no source file is allowed to contradict it. A check that
  // only banned the string would keep passing on the day somebody actually
  // did move the worker.
  let atRoot = true;
  try { readFileSync(REPO + 'sw.js'); } catch (_) { atRoot = false; }
  let inJs = true;
  try { readFileSync(REPO + 'js/sw.js'); } catch (_) { inJs = false; }
  ok(atRoot, 'the service worker is at the repository root, where its scope covers the page');
  ok(!inJs, 'and there is no second copy under js/, which could only ever scope js/*');

  if (atRoot && !inJs) {
    // ONE FILE IS EXEMPT, AND THE EXEMPTION IS A REQUIREMENT.
    //
    // The first version of this check scanned sw.js too and failed on its own
    // header — which says "a worker at ./js/sw.js could only ever control
    // ./js/*". That is the explanation of why the file is not there, not an
    // instruction to look there, and a substring search cannot tell those
    // apart. This project has now been caught by that distinction twice; the
    // rule it keeps learning is that a checker which cries wolf gets ignored
    // on the one line that matters, so the exception is made explicit rather
    // than the check being weakened into uselessness.
    //
    // Making it an exception alone would be a hole big enough to hide the
    // original bug in, so it is inverted: sw.js is the ONE place required to
    // name the path it is not at, because it is the only place a reader will
    // think to ask why. If that explanation ever disappears, this fails.
    const swHeader = readRepo('sw.js').slice(0, 2000);
    ok(/js\/sw\.js/.test(swHeader) && /scope/.test(swHeader),
      'sw.js explains in its own header why it is not under js/ — scope, not preference');

    const PROSE = ['js/main.js', 'js/net.js', 'js/ui.js', 'js/util.js', 'js/bot.js',
      'js/intents.js', 'js/guards.js', 'js/config.js', 'js/state.js', 'js/rules.js',
      'js/scoring.js', 'js/cards.js', 'js/trick.js', 'css/app.css',
      'index.html', 'manifest.webmanifest', 'README.md'];
    const liars = [];
    let scanned = 0;
    for (const f of PROSE) {
      let src;
      try { src = readRepo(f); } catch (_) { continue; }
      scanned++;
      // Both spellings; they send the reader to the same place that is not
      // there, and './' in front changes nothing about that.
      for (const m of src.matchAll(/\.?\/?js\/sw\.js/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        liars.push(`${f}:${line} says ${m[0]}`);
      }
    }
    for (const l of liars) console.error(`  ✗ FAIL: ${l} — the worker is at the repository root`);
    eq(liars.length, 0, 'and no other file tells the next reader to look in js/ for it');
    ok(scanned >= 14, `checked ${scanned} files for it — the sweep is not empty`);
  }
}

{
  // --- driving the worker ---------------------------------------------------
  //
  // A fake Cache API, a fake origin, and — importantly — a fake origin WITH A
  // SUBPATH. Everything below runs as if deployed to
  // https://pages.test/judgement/, because that is where this is going and
  // because a root-hosted fake would pass happily on paths that 404 on Pages.

  const ORIGIN = 'https://pages.test';
  const BASE = `${ORIGIN}/judgement/`;
  const abs = (u) => new URL(u, BASE).href;

  let writesOutsideInstall = 0;
  let installing = false;

  class Res {
    constructor(tag, init = {}) { this.tag = tag; this.status = init.status ?? 200; this.type = init.type || 'basic'; }
    static error() { return new Res(null, { status: 0, type: 'error' }); }
  }

  // What the "server" has. Keyed by absolute URL. The directory URL and
  // index.html return the same bytes, exactly as a static host does.
  const SERVER = new Map();
  const publish = (path, tag) => SERVER.set(abs(path), tag);
  publish('./', 'index.html');
  publish('./index.html', 'index.html');
  publish('./manifest.webmanifest', 'manifest');
  publish('./css/app.css', 'app.css');
  for (const m of ['main', 'ui', 'net', 'bot', 'intents', 'guards', 'state', 'rules', 'scoring', 'cards', 'trick', 'util', 'config']) {
    publish(`./js/${m}.js`, `${m}.js`);
  }
  for (const i of ['icon-32', 'icon-192', 'icon-512', 'icon-maskable-512', 'apple-touch-icon']) {
    publish(`./icons/${i}.png`, `${i}.png`);
  }
  publish('./late-addition.txt', 'late'); // on the server, not in SHELL

  let offline = false;
  let networkHits = 0;

  const fakeFetch = async (req) => {
    networkHits++;
    const url = typeof req === 'string' ? abs(req) : req.url;
    if (offline) throw new TypeError('Failed to fetch');
    if (!SERVER.has(url)) return new Res(null, { status: 404 });
    return new Res(SERVER.get(url));
  };

  class FakeCache {
    constructor() { this.store = new Map(); }
    async addAll(paths) {
      // Real addAll is atomic: one rejection and NOTHING is written. Modelled,
      // because the whole argument for using it over a tolerant loop is that
      // a partial cache never exists.
      const fetched = [];
      for (const p of paths) {
        const r = await fakeFetch(abs(p));
        if (r.status !== 200) throw new TypeError(`addAll failed on ${p}`);
        fetched.push([abs(p), r]);
      }
      for (const [k, v] of fetched) this.store.set(k, v);
    }
    async put(req, res) {
      if (!installing) writesOutsideInstall++;
      this.store.set(typeof req === 'string' ? abs(req) : req.url, res);
    }
    async match(req, opts = {}) {
      let url = typeof req === 'string' ? abs(req) : req.url;
      if (this.store.has(url)) return this.store.get(url);
      if (opts.ignoreSearch) {
        const bare = url.split('?')[0];
        for (const [k, v] of this.store) if (k.split('?')[0] === bare) return v;
      }
      return undefined;
    }
    async keys() { return [...this.store.keys()]; }
  }

  const caches_ = new Map();
  const fakeCaches = {
    async open(name) {
      if (!caches_.has(name)) caches_.set(name, new FakeCache());
      return caches_.get(name);
    },
    async keys() { return [...caches_.keys()]; },
    async delete(name) { return caches_.delete(name); },
  };

  // The global scope.
  const handlers = new Map();
  let claimed = 0;
  let skipped = 0;
  const fakeSelf = {
    addEventListener(type, fn) { handlers.set(type, fn); },
    location: { origin: ORIGIN, href: BASE + 'sw.js' },
    clients: { async claim() { claimed++; } },
    // Present so that calling it is OBSERVED rather than thrown. A fake that
    // lacks the method would also "catch" a skipWaiting being added, but as a
    // TypeError — which reports the shape of the fake, not the decision.
    skipWaiting() { skipped++; },
  };

  const swSrc = readRepo('sw.js');
  // eslint-disable-next-line no-new-func
  const meta = new Function('self', 'caches', 'fetch', 'Response',
    swSrc + '\n; return { CACHE_NAME, SHELL };')(fakeSelf, fakeCaches, fakeFetch, Res);

  const CACHE_NAME = meta.CACHE_NAME;

  for (const type of ['install', 'activate', 'fetch']) {
    ok(handlers.has(type), `sw.js registers a ${type} handler`);
  }

  // A browser hands each handler an event and waits on what it is given.
  const fire = async (type, extra = {}) => {
    let waited = null, responded = null;
    const ev = {
      ...extra,
      waitUntil(p) { waited = p; },
      respondWith(p) { responded = p; },
    };
    handlers.get(type)(ev);
    if (waited) await waited;
    return responded ? await responded : null;
  };

  const req = (path, { method = 'GET', mode = 'no-cors', absolute: a = null } = {}) =>
    ({ url: a || abs(path), method, mode });

  // ---------------------------------------------------------------------
  // INSTALL
  // ---------------------------------------------------------------------
  installing = true;
  await fire('install');
  installing = false;

  const cache = await fakeCaches.open(CACHE_NAME);
  ok(caches_.has(CACHE_NAME), 'install opens the cache its version names');
  eq((await cache.keys()).length, meta.SHELL.length,
    'and precaches exactly as many entries as SHELL lists — no more, no fewer');

  // THE CACHE IS KEYED ON THE DEPLOYED URL, not on the relative string. If the
  // worker resolved './js/main.js' against anything but its own scope, this is
  // where a Pages subpath deploy would come apart.
  ok((await cache.match(abs('./js/main.js'))) !== undefined,
    'a module is cached under its subpath-resolved URL, not its relative one');
  ok((await cache.match(`${ORIGIN}/js/main.js`)) === undefined,
    'and NOT under the origin root, which is where a leading slash would have put it');

  eq(claimed, 0, 'install does not claim clients — that is activate’s job');

  // NO skipWaiting, AND THIS IS THE UNPOPULAR CHOICE. Taking over immediately
  // is what most workers do. Here a match runs for nineteen rounds and can
  // outlast a deploy, and a worker that activates underneath a live page lets
  // it load the new js/state.js having already loaded the old js/ui.js. A
  // mixed-version module graph does not throw; it misbehaves, and it
  // misbehaves in the middle of somebody's game. The cost is that an update
  // lands one visit late, which the footer's reset button pays off on demand.
  eq(skipped, 0, 'and does not skip the waiting phase — an update never lands underneath a live match');

  // ---------------------------------------------------------------------
  // ACTIVATE
  // ---------------------------------------------------------------------
  // Seed three caches it should not be confused by: an older version of this
  // app, and two belonging to other apps on the same github.io user.
  caches_.set('judgement-shell-v0', new FakeCache());
  caches_.set('sequence-shell-v4', new FakeCache());
  caches_.set('courtpiece-v2', new FakeCache());

  await fire('activate');

  ok(!caches_.has('judgement-shell-v0'), 'activate deletes the previous version of this app');
  ok(caches_.has(CACHE_NAME), 'and keeps the current one');
  // THE ONE THAT MATTERS. A sibling project deployed under the same origin —
  // which is exactly what a user.github.io account is — must not have its
  // offline support wiped by this app shipping an update.
  ok(caches_.has('sequence-shell-v4') && caches_.has('courtpiece-v2'),
    'while leaving both sibling apps on the same origin entirely alone');
  eq(claimed, 1, 'and takes over the page that was already open');

  // ---------------------------------------------------------------------
  // FETCH: what it refuses to touch
  // ---------------------------------------------------------------------
  // `null` back from fire() means respondWith was never called, which is the
  // worker handing the request to the browser untouched.

  // THE BEACON. Three different third parties, all of which must pass
  // straight through. The signalling one is the dangerous one: a cached
  // handshake response is a room code that dials a dead conversation.
  const foreign = [
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    'https://fonts.gstatic.com/s/inter/v13/x.woff2',
    'https://0.peerjs.com/peerjs/id?ts=1',
  ];
  let intercepted = 0;
  for (const u of foreign) {
    if (await fire('fetch', { request: req(null, { absolute: u }) }) !== null) {
      intercepted++; console.error('  ✗ intercepted cross-origin:', u);
    }
  }
  eq(intercepted, 0, 'not one cross-origin request is intercepted — the beacon is never touched');

  // And nothing cross-origin ended up in the cache as a side effect.
  let foreignCached = 0;
  for (const k of await cache.keys()) if (!k.startsWith(ORIGIN)) foreignCached++;
  eq(foreignCached, 0, 'and nothing on anybody else’s origin is in the cache afterwards');

  eq(await fire('fetch', { request: req('./index.html', { method: 'POST' }) }), null,
    'a POST is left to the browser — it is not cacheable and never will be');

  // ---------------------------------------------------------------------
  // FETCH: offline, which is the entire point
  // ---------------------------------------------------------------------
  offline = true;
  const before = networkHits;

  const page = await fire('fetch', { request: req('./', { mode: 'navigate' }) });
  eq(page && page.tag, 'index.html', 'offline, a navigation still gets the page');

  // A DEEP LINK, offline. Somebody's bookmark, or a path that existed in an
  // older version. There is one page in this app and every route is it.
  const deep = await fire('fetch', { request: req('./room/QRTX', { mode: 'navigate' }) });
  eq(deep && deep.tag, 'index.html', 'and so does a deep link to a path that never existed');

  const mod = await fire('fetch', { request: req('./js/state.js') });
  eq(mod && mod.tag, 'state.js', 'offline, a module comes out of the cache');

  const css = await fire('fetch', { request: req('./css/app.css') });
  eq(css && css.tag, 'app.css', 'and so does the stylesheet');

  const icon = await fire('fetch', { request: req('./icons/icon-192.png') });
  eq(icon && icon.tag, 'icon-192.png', 'and so do the icons');

  // The whole shell, not just the three sampled above. An app that serves
  // index.html and one module offline is not an app that works offline.
  let served = 0;
  for (const p of meta.SHELL) {
    const r = await fire('fetch', { request: req(p, { mode: p === './' ? 'navigate' : 'no-cors' }) });
    if (r && r.status === 200) served++;
  }
  eq(served, meta.SHELL.length,
    `all ${meta.SHELL.length} precached assets are served with the network down`);

  eq(networkHits, before, 'and none of that touched the network at all');

  // The cache-buster. ./js/main.js?v=2 must still hit ./js/main.js, or one
  // stray query string during debugging turns offline support off.
  const busted = await fire('fetch', { request: req('./js/main.js?v=2') });
  eq(busted && busted.tag, 'main.js', 'a query string does not defeat the precache');

  // Not ours and not reachable. This has to fail like a network failure,
  // because the page's own error handling is written against one.
  const gone = await fire('fetch', { request: req('./late-addition.txt') });
  ok(gone && gone.type === 'error',
    'something never precached, requested offline, fails as a network error rather than a fake 200');

  // ---------------------------------------------------------------------
  // FETCH: back online, and STILL no runtime caching
  // ---------------------------------------------------------------------
  offline = false;
  const sizeBefore = (await cache.keys()).length;

  const late = await fire('fetch', { request: req('./late-addition.txt') });
  eq(late && late.tag, 'late', 'online, something outside the shell is fetched normally');
  eq((await cache.keys()).length, sizeBefore,
    'and is NOT written to the cache — the health-probe rule, enforced by having no write path');
  eq(writesOutsideInstall, 0, 'nothing anywhere writes to the cache outside install');

  // A PRECACHED asset online still comes from the cache, not the network. That
  // is what makes the version consistent: js/ui.js and js/state.js can never
  // come from two different deploys.
  const netBefore = networkHits;
  const uiAgain = await fire('fetch', { request: req('./js/ui.js') });
  eq(uiAgain && uiAgain.tag, 'ui.js', 'online, a precached module still comes from the cache');
  eq(networkHits, netBefore, 'without a network request, so the whole shell is one version');
}

{
  // --- install is all-or-nothing --------------------------------------------
  //
  // Re-run install against a server that is missing one module — a rename that
  // did not update SHELL, a bad deploy. The install MUST reject, so the worker
  // never activates and the previous version keeps serving. The alternative is
  // a cache with a hole in it, which is an app that works online and is broken
  // offline: the single hardest bug report to act on.

  const ORIGIN = 'https://pages.test';
  const BASE = `${ORIGIN}/judgement/`;
  const abs = (u) => new URL(u, BASE).href;

  class Res { constructor(t, i = {}) { this.tag = t; this.status = i.status ?? 200; } static error() { return new Res(null, { status: 0 }); } }

  const store = new Map();
  let broken = null;
  const fakeFetch = async (r) => {
    const url = typeof r === 'string' ? abs(r) : r.url;
    return new Res('x', { status: url === abs(broken) ? 404 : 200 });
  };
  class FakeCache {
    constructor() { this.store = store; }
    async addAll(paths) {
      const got = [];
      for (const p of paths) {
        const r = await fakeFetch(abs(p));
        if (r.status !== 200) throw new TypeError(`addAll: ${p}`);
        got.push(abs(p));
      }
      for (const k of got) this.store.set(k, new Res('x'));
    }
    async keys() { return [...this.store.keys()]; }
    async match() { return undefined; }
    async put() {}
  }
  const handlers = new Map();
  const fakeSelf = {
    addEventListener(t, f) { handlers.set(t, f); },
    location: { origin: ORIGIN, href: BASE + 'sw.js' },
    clients: { async claim() {} },
  };
  const swSrc = readRepo('sw.js');
  // eslint-disable-next-line no-new-func
  const meta = new Function('self', 'caches', 'fetch', 'Response',
    swSrc + '\n; return { CACHE_NAME, SHELL };')(
    fakeSelf,
    { async open() { return new FakeCache(); }, async keys() { return []; }, async delete() {} },
    fakeFetch, Res);

  // Break each entry in turn. Every single one must be load-bearing — if any
  // module can 404 and the install still succeeds, that module is not really
  // being precached and its absence would only show up offline.
  let survived = 0;
  for (const p of meta.SHELL) {
    broken = p;
    store.clear();
    let rejected = false;
    let waited = null;
    handlers.get('install')({ waitUntil(x) { waited = x; } });
    try { await waited; } catch (_) { rejected = true; }
    if (!rejected) { survived++; console.error('  ✗ install tolerated a missing', p); }
    else if (store.size !== 0) { survived++; console.error('  ✗ install left a partial cache after', p); }
  }
  eq(survived, 0,
    `install refuses to complete with any one of the ${meta.SHELL.length} assets missing, and leaves nothing behind`);
}

// ===========================================================================
section('The rules sheet says what the code actually does');
// ===========================================================================

// THE SEAM. index.html's <dialog> is static prose with no script behind it,
// so nothing in the world keeps it in step with js/scoring.js — and it had
// already drifted. The Squared bullet said missing costs "one for each trick
// you were out by", a linear penalty, while scoreSquare() has always returned
// -(miss * miss). A player reading the sheet before bidding was being told
// that missing by three costs 3 when it costs 9, which is most of a made
// small bid and changes what the correct bid IS.
//
// EVERY NUMBER BELOW IS COMPUTED, NOT TYPED. The test asks scoreRound() what
// a hypothetical round pays and requires the sheet to say the same thing, so
// a fourth mode or a changed formula fails here rather than in somebody's
// game. The prose around each number is free to be reworded; the number is
// not free to be wrong.
{
  const html = readRepo('index.html');
  const dialog = html.slice(html.indexOf('<dialog id="rules"'), html.indexOf('</dialog>'));
  ok(dialog.length > 500, 'the rules dialog was found and has prose in it');

  // The scoring bullets, one per mode, read out of the sheet by the mode name
  // rather than by position. Two bullets say "a made four scores N" with
  // different N, so matching across the whole sheet would find whichever came
  // first and pass for the wrong reason.
  const bullets = [...dialog.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].replace(/<[^>]*>/g, ''));
  ok(bullets.length >= 6, `${bullets.length} bullets in the sheet`);
  const bulletFor = (word) => bullets.find((b) => b.includes(word)) || '';

  // SCORING_MODES is the source of truth for which modes exist, so a fourth
  // one added without a bullet fails here. The words are the sheet's own
  // spelling — 'square' is presented as "Squared" — and that mapping is the
  // only thing in this section written by hand.
  const BULLET_WORD = { kachuful: 'Kachuful', standard: 'Standard', square: 'Squared' };
  for (const mode of SCORING_MODES) {
    ok(BULLET_WORD[mode], `the sheet has a name for the '${mode}' mode`);
    ok(bulletFor(BULLET_WORD[mode]).length > 40, `and a bullet describing ${BULLET_WORD[mode]}`);
  }

  // A round size of ten, because that is the round the Kachuful bullet talks
  // about and the two modes that ignore roundSize do not care.
  const SIZE = 10;
  const CLAIMS = [
    ['kachuful', /made bid of four scores (\d+)/, scoreRound('kachuful', 4, 4, SIZE)],
    ['kachuful', /ducking a ten-card round worth (\d+)/, scoreRound('kachuful', 0, 0, SIZE)],
    ['standard', /A made four scores (\d+)/, scoreRound('standard', 4, 4, SIZE)],
    ['standard', /a made zero scores (\d+)/, scoreRound('standard', 0, 0, SIZE)],
    ['square', /a made four scores (\d+)/, scoreRound('square', 4, 4, SIZE)],
    // The penalties, stated as costs, so the sheet's positive number is the
    // negation of what the formula returns. Bid four and take three, two, one.
    ['square', /Out by one costs (\d+)/, -scoreRound('square', 4, 3, SIZE)],
    ['square', /out by two costs (\d+)/, -scoreRound('square', 4, 2, SIZE)],
    ['square', /out by three costs (\d+)/, -scoreRound('square', 4, 1, SIZE)],
  ];
  for (const [mode, re, expected] of CLAIMS) {
    const found = bulletFor(BULLET_WORD[mode]).match(re);
    ok(!!found, `the ${BULLET_WORD[mode]} bullet makes the claim ${re}`);
    if (found) {
      eq(Number(found[1]), expected,
        `and ${BULLET_WORD[mode]}'s "${found[0]}" is what scoreRound() actually pays`);
    }
  }

  // --- how the penalty is CHARACTERISED, not just what it totals ----------
  //
  // The three worked numbers above are pinned, and for a while that felt like
  // enough. It is not: deleting the words "the square of" from the sentence
  // that describes the penalty leaves 1, 4 and 9 sitting there unchanged, so
  // every numeric claim still passes while the sheet goes back to describing
  // a linear penalty — which is the exact bug this section was written for. A
  // mutation run is how that showed; the numbers alone let it through.
  //
  // The EXPONENT IS DERIVED, so this is not a wording freeze. scoreRound() is
  // asked what missing by one, two and three actually costs, and the shape is
  // read off those three points. If scoring.js ever became linear, the test
  // would stop demanding the word rather than demanding the wrong one.
  {
    const cost = (d) => -scoreRound('square', 4, 4 - d, SIZE);
    const isQuadratic = cost(1) === 1 && cost(2) === 4 && cost(3) === 9;
    const isLinear = cost(1) === 1 && cost(2) === 2 && cost(3) === 3;
    ok(isQuadratic !== isLinear, 'the Squared penalty has one shape or the other, not both');

    // Scoped to the sentence that describes the PENALTY. Searching the whole
    // bullet would be vacuous twice over: it opens with the mode name
    // "Squared", and its first clause is "ten plus your bid squared", which
    // is the reward. Neither says anything about what missing costs.
    const squareBullet = bulletFor('Squared');
    const penalty = (squareBullet.match(/missing[^.]*\./i) || [''])[0];
    ok(penalty.length > 30,
      `the Squared bullet has a sentence describing what missing costs ("${penalty.slice(0, 48)}...")`);
    // Proof the scoping did its job: the reward clause says "squared" too, so
    // if it leaked into `penalty` the check below would pass no matter what
    // the sheet claimed about missing.
    ok(!/ten plus your bid/i.test(penalty),
      'and that sentence is the penalty, not the reward clause that also says "squared"');
    eq(/\bsquare/i.test(penalty), isQuadratic,
      isQuadratic
        ? 'and calls the penalty a square, which is what scoreRound() charges'
        : 'and does NOT call it a square, because scoreRound() no longer squares it');
  }

  // --- the qualitative claims, swept rather than read ----------------------
  //
  // "Missing costs nothing", "the only mode where a score can go negative"
  // and "over and under cost the same" are sentences, not numbers, and each
  // one is a property over the whole input space. Swept here so that the
  // sheet's adjectives are as pinned as its digits.
  let kachufulMissNonZero = 0, symmetryBreaks = 0, cases = 0;
  const negatives = Object.fromEntries(SCORING_MODES.map((m) => [m, 0]));
  for (let size = 1; size <= 10; size++) {
    for (let bid = 0; bid <= size; bid++) {
      for (let actual = 0; actual <= size; actual++) {
        cases++;
        for (const mode of SCORING_MODES) {
          const pts = scoreRound(mode, bid, actual, size);
          if (pts < 0) negatives[mode]++;
        }
        if (actual !== bid && scoreRound('kachuful', bid, actual, size) !== 0) kachufulMissNonZero++;
        // Over by k and under by k, where both ends exist in this round.
        const k = Math.abs(actual - bid);
        if (k > 0 && bid - k >= 0 && bid + k <= size) {
          if (scoreRound('square', bid, bid - k, size) !== scoreRound('square', bid, bid + k, size)) {
            symmetryBreaks++;
          }
        }
      }
    }
  }
  ok(cases > 400, `${cases} (bid, taken, round size) combinations swept`);
  eq(kachufulMissNonZero, 0, 'Kachuful: "missing costs nothing" holds for every miss there is');
  ok(negatives.square > 0, `Squared goes negative in ${negatives.square} of them`);
  eq(negatives.kachuful + negatives.standard, 0,
    'and it is "the ONLY mode where a score can go negative" — the other two never do');
  eq(symmetryBreaks, 0, 'Squared: "over and under cost the same", at every distance');

  // --- the hook, which is a toggle and must not be stated as a law ---------
  // The sheet cannot know a given room's config, so the one honest thing it
  // can do is say the hook is optional and name the default. DEFAULT_CONFIG
  // is read for the default rather than trusted to still be true.
  const hookText = (dialog.match(/<p>The dealer bids last[\s\S]*?<\/p>/) || [''])[0].replace(/<[^>]*>/g, '');
  ok(/hook/i.test(hookText), 'the sheet explains the hook where it explains bidding');
  ok(/\bIf\b|\bwhen\b|switched on|turned on/i.test(hookText),
    'and states it as a setting rather than a law, because it is a lobby toggle');
  ok(new RegExp(`on by default`, 'i').test(hookText) === (DEFAULT_CONFIG.hook === true),
    `and names the real default (DEFAULT_CONFIG.hook is ${DEFAULT_CONFIG.hook})`);
}

// ===========================================================================
section('The seams: two files, one string, and nothing enforcing it');
// ===========================================================================

// EVERY BUG THE SHIP AUDIT FOUND SAT HERE, and none of the 120k assertions
// above could see any of them. They all have the same shape: two files have to
// agree on a STRING, each file is correct and tested in isolation, and no test
// crosses between them.
//
//   * js/main.js sent `{ type: 'setConfig', patch }`; js/intents.js read
//     `msg.config`. Every lobby control answered "That is not a setting."
//     The unit tests passed because they called the dispatcher with a frame
//     no producer emits — so the junk sweep was refusing for the right reason
//     by accident, and could not tell "this value is junk" from "this field
//     does not exist".
//   * js/ui.js emitted `class="code"` for the room code; css/app.css styled
//     `.panel-code .big`. The code rendered at body size.
//   * css/app.css styled `.log-play` for a log kind the engine has never
//     emitted, and had no rule for `made` or `missed`, which it emits every
//     round. Both halves came from the same guessed list.
//
// A human reading two files side by side is precisely the check that already
// failed, three times. So these are mechanical, and they are STRICT IN BOTH
// DIRECTIONS with no exemption list — an exemption list is where the next one
// would hide.

{
  const mainSrc = readRepo('js/main.js');
  const intentsSrc = readRepo('js/intents.js');

  // Comments first, always. A substring search over a commented file cannot
  // tell an explanation from the thing being explained, and this codebase has
  // been bitten by that repeatedly — intents.js's own header prose names every
  // intent and every field, and would satisfy any of these checks on its own.
  const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const main = stripJs(mainSrc);
  const intents = stripJs(intentsSrc);

  // Everything outside the outermost braces/brackets, so a nested object
  // literal contributes no keys of its own. `dispatch({ type: 'setConfig',
  // patch: { ...preset.config } })` must yield `patch`, never `maxHand`.
  const flat = (s) => {
    let d = 0, out = '';
    for (const ch of s) {
      if (ch === '{' || ch === '[') d++;
      else if (ch === '}' || ch === ']') d--;
      else if (d === 0) out += ch;
    }
    return out;
  };

  // --- what main.js actually puts on the wire ------------------------------
  const NEEDLE = 'dispatch({';
  const sentBy = new Map();
  for (let i = main.indexOf(NEEDLE); i !== -1; i = main.indexOf(NEEDLE, i + 1)) {
    // Brace-BALANCED, not /[^}]*/. The preset dispatch on main.js:752 carries
    // a nested object, and a non-greedy scan ends the frame at that object's
    // closing brace — quietly dropping every field after it and reporting a
    // frame that nothing sends. A checker that cries wolf gets ignored on the
    // one line that matters, so it is worth the extra ten lines here.
    let d = 0, end = -1;
    for (let j = i + NEEDLE.length - 1; j < main.length; j++) {
      if (main[j] === '{') d++;
      else if (main[j] === '}' && --d === 0) { end = j; break; }
    }
    if (end === -1) continue;
    const body = main.slice(i + NEEDLE.length, end);
    const type = (body.match(/type:\s*'([^']+)'/) || [])[1];
    if (!type) continue;
    if (!sentBy.has(type)) sentBy.set(type, new Set());
    // BOTH SPELLINGS: `code: x` and the `{ type, code }` shorthand carry the
    // field identically. Reading only the colon form reported four healthy
    // intents as broken.
    for (const tok of flat(body).split(',')) {
      const key = (tok.includes(':') ? tok.slice(0, tok.indexOf(':')) : tok).trim();
      if (/^\w+$/.test(key) && key !== 'type') sentBy.get(type).add(key);
    }
  }

  ok(sentBy.size >= 5, `main.js dispatches ${sentBy.size} distinct intent types`);
  for (const type of sentBy.keys()) {
    ok(GAME_INTENTS.includes(type),
      `'${type}' is dispatched by main.js and is a real game intent`);
  }

  // --- what intents.js reads back off the message --------------------------
  const caseBody = (type) => {
    const at = intents.indexOf(`case '${type}':`);
    if (at === -1) return null;
    const rest = intents.slice(at + 6);
    const next = rest.indexOf("case '");
    return next === -1 ? rest : rest.slice(0, next);
  };

  let crossed = 0, optional = 0, requiredMissing = 0, sentNeverRead = 0, noCase = 0;
  for (const [type, sent] of sentBy) {
    const body = caseBody(type);
    if (body === null) { noCase++; console.error(`  ✗ FAIL: main.js dispatches '${type}' and intents.js has no case for it`); continue; }

    const reads = new Set([...body.matchAll(/msg\.(\w+)/g)].map((m) => m[1]));
    for (const f of reads) {
      // A field the case EXPLICITLY handles the absence of is optional by
      // design, and main.js is allowed never to send it. addBot is the real
      // one: the plain "+ ADD A BOT" button sends no name, and the case says
      // so in as many words, because a bot named by nobody is still a bot.
      //
      // Everything else is REQUIRED, and a required field that no producer
      // sends is the dead lobby exactly. This is the distinction that matters,
      // and it is why the check is not simply "every read field is sent".
      const guarded = new RegExp(
        `msg\\.${f}\\s*(===|!==|==|!=)\\s*(undefined|null)`
        + `|(undefined|null)\\s*(===|!==|==|!=)\\s*msg\\.${f}`
        + `|'${f}'\\s+in\\s+msg|msg\\.${f}\\s*\\?\\?`,
      ).test(body);
      if (guarded) { optional++; continue; }
      if (sent.has(f)) { crossed++; continue; }
      requiredMissing++;
      console.error(`  ✗ FAIL: intents.js '${type}' requires msg.${f}, and main.js sends [${[...sent].join(', ') || 'nothing'}]`);
    }
    for (const f of sent) {
      if (!reads.has(f)) {
        sentNeverRead++;
        console.error(`  ✗ FAIL: main.js sends '${type}'.${f} and intents.js never reads it`);
      }
    }
  }

  eq(noCase, 0, 'every intent main.js dispatches has a case in intents.js');
  eq(requiredMissing, 0, 'every field intents.js REQUIRES is a field main.js actually sends');
  eq(sentNeverRead, 0, 'and every field main.js sends is one intents.js actually reads');
  // THE PAIRED POSITIVES. Zero mismatches out of zero fields compared is what
  // a checker that has quietly stopped parsing looks like from the outside,
  // and it is indistinguishable from a clean bill of health. Both counters
  // must be non-trivially large for the zeroes above to mean anything.
  ok(crossed >= 4, `and ${crossed} required (intent, field) pairs were matched across the seam, not zero`);
  ok(optional >= 1, `with ${optional} field(s) exempted as explicitly-optional, so that branch is exercised too`);
  console.log(`  main.js <-> intents.js: ${sentBy.size} intents, ${crossed} required fields matched, ${optional} optional`);
}

{
  // --- seam 2: every class js/ui.js emits, every selector css/app.css has ---
  //
  // Derived by RENDERING, not by regexing ui.js for `class:`. A regex over
  // source cannot see through a template hole: `class: \`chip${k === value ?
  // ' on' : ''}\`` reads as the class tokens "chip${k", "===", "value" — and a
  // checker that invents classes nobody emits is worse than no checker, because
  // its output gets skimmed. The DOM is the ground truth and it is already
  // built; this just reads classList off every node of every frame.

  const cssSrc = readRepo('css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const styled = new Set();
  for (const m of cssSrc.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) styled.add(m[1]);

  const emitted = new Set();
  let seamFrames = 0;
  const grab = (app) => {
    const r = draw(app);
    seamFrames++;
    for (const n of walk(r.root)) for (const c of (n.classList || [])) emitted.add(c);
  };

  // Overlays, banners and error states each carry classes of their own, and
  // none of them appear in a default frame.
  const FLAGS = [
    {}, { showPad: true }, { showLog: true }, { error: 'Nope.' }, { busy: true },
    { reconnecting: true }, { netWarning: 'Slow.' }, { isHost: false },
    { selected: 'AS' }, { selectedBid: 1 }, { announce: 'hi' },
  ];
  const everyWay = (over) => { for (const f of FLAGS) grab(baseApp({ ...over, ...f })); };

  for (const screen of ['home', 'join', 'connecting', 'error', 'hostleft', 'game']) {
    everyWay({ screen, pub: null, priv: null });
  }

  // The lobby, including a BOT — .tag-bot renders nowhere else, and a sweep
  // that never adds one reports the rule as dead.
  for (const players of [1, 2, 3, 5, MAX_PLAYERS]) {
    const g = new GameEngine();
    seatTable(g, LOBBY_NAMES.slice(0, players));
    if (players >= 3) g.addBot('p0', 'Robo');
    for (const cfg of [{}, ...UI_CONFIGS]) {
      g.setConfig('p0', cfg);
      const pub = g.publicState();
      for (const id of ['p0', 'p1', 'nobody']) everyWay({ screen: 'game', pub, priv: g.privateStateFor(id) });
    }
  }

  // Whole matches. The fourth config exists only to REACH NO TRUMP:
  // rotation-nt cycles S,H,D,C,NT, and every UI_CONFIG is too short a ladder
  // to get to the fifth round, so .trump.nt and .nt-mini read as dead
  // otherwise. The bid strategy alternates lowest/highest for the same kind of
  // reason — always taking the first legal bid means everybody bids zero,
  // nobody ever falls short, and .seat.under never renders once.
  const SEAM_CONFIGS = [...UI_CONFIGS,
    { scoring: 'kachuful', trumpMethod: 'rotation-nt', shape: 'descending', hook: false, maxHand: 5 }];
  const kinds = new Set();
  for (const config of SEAM_CONFIGS) {
    for (const players of [3, 5]) {
      playMatch({
        config, players, shuffleSeed: 7,
        strategy: {
          bid: (opts, g, seat) => opts[seat % 2 ? opts.length - 1 : 0].bid,
          card: (legal) => legal[0].code,
        },
        onState: (g) => {
          const pub = g.publicState();
          for (const l of pub.log) kinds.add(l.kind);
          for (const id of ['p0', 'p1', 'nobody']) everyWay({ screen: 'game', pub, priv: g.privateStateFor(id) });
        },
      });
    }
  }

  // THE LOBBY HOLDING A SEAT THAT IS AWAY, which no amount of sweeping
  // produces: seatRow() is rendered only in the lobby, and disconnect() in the
  // lobby SPLICES the seat out rather than marking it away. The one path that
  // reaches this frame is restore() — state.js falls back to PHASES.LOBBY when
  // a snapshot's phase is not recognised, and brings the seats back exactly as
  // saved, connected flag and all. An older build's snapshot lands here.
  {
    const g = new GameEngine();
    seatTable(g, LOBBY_NAMES.slice(0, 3));
    g.addBot('p0', 'Robo');
    g.startMatch('p0', 0);
    g.disconnect('p1');
    for (const l of g.publicState().log) kinds.add(l.kind);

    const back = new GameEngine();
    back.restore({ ...g.serialize(), phase: 'a phase from some other build' });
    eq(back.phase, PHASES.LOBBY, 'an unrecognised snapshot phase restores to the lobby');
    const pub = back.publicState();
    ok(pub.seats.some((s) => !s.connected && !s.isBot),
      'and a seat that was away is still away — otherwise this frame proves nothing');
    for (const id of ['p0', 'p1', 'nobody']) everyWay({ screen: 'game', pub, priv: back.privateStateFor(id) });
  }

  // Classes that never pass through the renderer: authored into index.html, or
  // put on <body> by main.js. Both are real emissions and app.css styles them.
  const htmlSrc = readRepo('index.html');
  for (const m of htmlSrc.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) emitted.add(c);
  }
  const mainFlat = readRepo('js/main.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of mainFlat.matchAll(/document\.body\.classList\.\w+\(\s*'([^']+)'/g)) emitted.add(m[1]);

  const unstyled = [...emitted].filter((c) => !styled.has(c)).sort();
  const unused = [...styled].filter((c) => !emitted.has(c)).sort();

  for (const c of unstyled) console.error(`  ✗ FAIL: class "${c}" is emitted and css/app.css has no rule for it`);
  for (const c of unused) console.error(`  ✗ FAIL: css/app.css styles ".${c}" and nothing ever emits it`);
  eq(unstyled.length, 0, 'every class that reaches the DOM has a rule in app.css');
  eq(unused.length, 0, 'and every class rule in app.css matches something that is actually rendered');

  // Paired positives again: both lists above are empty, and that is only worth
  // anything if the sets being compared are big and were really populated.
  ok(seamFrames > 5000, `across ${seamFrames} frames`);
  ok(emitted.size > 100, `with ${emitted.size} distinct classes emitted`);
  ok(styled.size > 100, `and ${styled.size} class selectors in the stylesheet`);

  // --- seam 3: the log kinds, which is where the guessed list showed -------
  //
  // Same comparison, narrowed to the family that actually drifted, because
  // ".log-play exists and matches nothing" and "made/missed render unstyled"
  // are one mistake with two symptoms and neither one looks like a bug on
  // screen. Kinds come from PLAYED MATCHES rather than from a list written
  // here — a list written here is the thing that was wrong.
  const ruleKinds = new Set([...styled].filter((c) => c.startsWith('log-')).map((c) => c.slice(4)));
  const missingRule = [...kinds].filter((k) => !ruleKinds.has(k)).sort();
  const deadRule = [...ruleKinds].filter((k) => !kinds.has(k)).sort();

  for (const k of missingRule) console.error(`  ✗ FAIL: the engine logs kind '${k}' and app.css has no .log-${k}`);
  for (const k of deadRule) console.error(`  ✗ FAIL: app.css styles .log-${k} and the engine never logs that kind`);
  eq(missingRule.length, 0, 'every log kind the engine emits has a .log-<kind> rule');
  eq(deadRule.length, 0, 'and every .log-<kind> rule matches a kind the engine emits');
  ok(kinds.size >= 9, `derived from ${kinds.size} kinds actually observed: ${[...kinds].sort().join(', ')}`);
  console.log(`  ui.js <-> app.css: ${seamFrames} frames, ${emitted.size} classes emitted, ${styled.size} styled, 0 either way`);
  console.log(`  log kinds observed: ${[...kinds].sort().join(', ')}`);

  // --- seam 4: new state arrives, and nothing tells the screen reader -------
  //
  // READ THIS FIRST, because it is the only check in the file that reasons
  // about source text where it would rather run the code. js/main.js cannot be
  // imported here: it touches document, localStorage and the transport at
  // module scope, so importing it in node throws before the first line of any
  // test. That is exactly why announcementFor() was put in util.js — so the
  // hard part could be tested for real. What is left in main.js is the WIRING,
  // three lines of it, and the wiring is what broke: the host's push() updated
  // app.pub and never announced, so a sighted player saw the table move and a
  // screen-reader player heard nothing for the whole match.
  //
  // Deleting announceFrom(pub) from push() leaves this suite green without
  // this check. A mutation run is how that showed; the pass count did not.
  //
  // The rule is: the announcement is computed BEFORE the frame that would show
  // it. So the window searched runs from each app.pub assignment to the next
  // paint() — not a fixed line count, which would be arbitrary, and not the
  // enclosing function, which needs a parser. app.pub = null is exempt and
  // counted separately: goHome() is leaving the table, and there is no news.
  {
    const sites = [...mainFlat.matchAll(/app\.pub\s*=\s*([A-Za-z_$][\w$]*|null)\b/g)];
    const live = sites.filter((m) => m[1] !== 'null');
    const silent = [];
    for (const m of live) {
      const from = m.index;
      const stop = mainFlat.indexOf('paint()', from);
      // No paint() after it at all is itself a finding, and the 400-char cap
      // keeps a missing terminator from swallowing the rest of the file and
      // finding somebody else's announce.
      const window = mainFlat.slice(from, stop === -1 ? from + 400 : stop);
      // The enclosing function's name rather than a line number: mainFlat has
      // had its block comments collapsed, so its line numbers are not the
      // file's, and a wrong line number in a failure message is worse than
      // none. The last declaration above the assignment is the one it is in.
      const decls = [...mainFlat.slice(0, from).matchAll(/(?:function|onState:|onOpen:)\s*([\w$]*)/g)];
      const where = decls.length ? (decls[decls.length - 1][1] || 'onState') : '?';
      if (!window.includes('announceFrom(')) { silent.push(`${where}(): app.pub = ${m[1]}`); continue; }
      // Announced from the value that was just stored, not from some older
      // one still in scope. Only checkable when the right-hand side is a plain
      // variable; if it ever becomes a call expression this quietly relaxes to
      // "something was announced", which is still the check that matters.
      if (!window.includes(`announceFrom(${m[1]})`)) silent.push(`${where}(): announces something other than ${m[1]}`);
    }
    for (const s of silent) console.error(`  ✗ FAIL: js/main.js ${s} — new state, no announcement`);
    eq(silent.length, 0, 'every place main.js takes new public state also feeds the live region');
    ok(live.length >= 2, `checked ${live.length} places state arrives (the host's own push, and a client's onState)`);
    ok(sites.length > live.length, 'and left the one app.pub = null alone, because leaving the table is not news');

    // announceFrom() itself still doing the two things its callers assume. The
    // check above only proves the call is written; a body that had been
    // hollowed out would satisfy it and say nothing.
    const body = (mainFlat.match(/function announceFrom\([\s\S]*?\n}/) || [''])[0];
    ok(/announcementFor\(/.test(body), 'announceFrom() asks announcementFor() what is new');
    ok(/app\.announce\s*=/.test(body), 'and puts the answer where render() will read it');
    ok(/announceCursor\s*=/.test(body), 'and advances the cursor, so the next call does not replay it');
  }

  let guardedNames = [];
  // --- seam 5: the callbacks that outlive the session that made them -------
  //
  // main.js hands net.js nine handlers as a host and eight as a client, and
  // net.js calls them whenever the network feels like it. The session those
  // closures belong to can be gone by then — the player pressed Home, the
  // reconnect ladder moved to the next rung, a reload started a new match —
  // and every one of them still holds the old `engine`, the old `host`, and
  // a reference to `app`.
  //
  // Three things went wrong here, and they look like three bugs but are one:
  //
  //   * onOpen from an abandoned join sets app.screen='game', dragging a
  //     player who is on the home screen back into a table they left.
  //   * onClose from a destroyed client calls scheduleReconnect(), which sets
  //     a NEW reconnectTimer — after teardown() cleared the old one. The tab
  //     then re-dials, on a ladder, a room nobody is in. teardown() looks
  //     like it prevents this. It does not: clearing a timer does nothing
  //     about the code that creates another one.
  //   * onJoin/onData/onDisconnect dereference `engine`, which teardown()
  //     sets to null.
  //
  // The fix is one epoch counter and a uniform `if (!live()) return;`. This
  // checks it is uniform, because a guard applied to eight of nine handlers
  // is the ninth handler's bug. Source-level for the same reason as seam 4 —
  // main.js cannot be imported headless.
  {
    // The contents of a balanced {...} starting at the first brace after
    // `needle`. Same brace-walk as seam 1 and for the same reason: these
    // literals contain nested objects and arrow bodies, and a non-greedy
    // match ends at the first inner `}`.
    const balanced = (src, needle) => {
      const at = src.indexOf(needle);
      if (at === -1) return null;
      const open = src.indexOf('{', at);
      if (open === -1) return null;
      let d = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}' && --d === 0) return src.slice(open + 1, j);
      }
      return null;
    };

    // Handler keys at the TOP level of the literal only. Depth-tracked rather
    // than regexed over the whole blob, so an `onclick:` inside a rendered
    // element or a nested options object can never be mistaken for one of the
    // transport's own handlers.
    const topHandlers = (lit) => {
      const found = [];
      let d = 0;
      for (let i = 0; i < lit.length; i++) {
        const ch = lit[i];
        if (ch === '{' || ch === '(' || ch === '[') d++;
        else if (ch === '}' || ch === ')' || ch === ']') d--;
        else if (d === 0) {
          const m = /^(on[A-Z]\w*)\s*:\s*(?:\([^)]*\)|\w+)\s*=>\s*\{/.exec(lit.slice(i));
          if (m) found.push([m[1], lit.slice(i + m[0].length, i + m[0].length + 120)]);
        }
      }
      return found;
    };

    const hostLit = balanced(mainFlat, 'host = createHost(');
    const clientLit = balanced(mainFlat, 'client = joinHost(');
    ok(hostLit !== null, 'the host handler literal was located in js/main.js');
    ok(clientLit !== null, 'and the client handler literal too');

    const unguarded = [];
    const seen = [];
    for (const [role, lit] of [['host', hostLit], ['client', clientLit]]) {
      const hs = topHandlers(lit || '');
      ok(hs.length >= 8, `${role}: found ${hs.length} transport handlers to check`);
      for (const [name, head] of hs) {
        seen.push(`${role}.${name}`);
        if (!/^\s*if\s*\(!live\(\)\)\s*return;/.test(head)) unguarded.push(`${role}.${name}`);
      }
    }
    for (const h of unguarded) {
      console.error(`  ✗ FAIL: js/main.js ${h} does not open with the epoch guard — it can run after teardown`);
    }
    eq(unguarded.length, 0, 'every transport handler refuses to act for a session that has ended');

    // BY NAME, not by count. A count tuned to today's number still passes on
    // the day somebody adds a handler and forgets the guard — which is the
    // exact failure being prevented.
    //
    // A count is also unreadable when it is wrong. The first version of this
    // check asserted `guarded >= 16` and printed a hard-coded 16 in the
    // summary line; the scanner was in fact finding 17 the whole time, and
    // there was no way to tell the two apart from the output. Naming them
    // costs two lines and makes the summary say what was actually examined.
    //
    // -----------------------------------------------------------------------
    // AND THE NAMES ARE READ OUT OF js/net.js RATHER THAN WRITTEN DOWN HERE
    // -----------------------------------------------------------------------
    // They were written down here, and they were right: nine host names and
    // nine client names, matching net.js exactly. Right by hand, though, with
    // nothing holding them there — and the paragraph above had already made
    // the argument ("net.js decides which handlers exist") before going on to
    // hard-code the names net.js decided on that afternoon.
    //
    // The hole that leaves is specific, and it is not the one the guard check
    // closes. The scanner above only inspects handlers it FINDS in main.js, so
    // a handler main.js never wires at all is invisible to it. This list is
    // what is supposed to notice the absence — and a list cannot notice a name
    // it does not contain. Add onFoo to net.js, wire it nowhere, and the suite
    // stays green over a callback firing into nothing.
    //
    // THE SOURCE OF TRUTH IS THE CALL, NOT THE DOC BLOCK. net.js sets out both
    // handler sets in prose above createHost and joinHost, and parsing that
    // would be less code than what follows. It would also just move the
    // hand-written list into the other file, where a doc comment drifts from
    // the code in precisely the way this list did. `handlers.onX(...)` cannot
    // drift, because it IS the call: if it is reachable, the handler can fire.
    const netFlat = readRepo('js/net.js')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The body of a named function. NOT balanced() above — that takes the
    // first `{` after the needle, and every function in play here is declared
    // `(handlers = {})`, so it would return the default value as the body and
    // every set would come back empty. Walk the parameter list to its closing
    // paren first, then find the brace.
    const funcBody = (src, name) => {
      const at = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
      if (at === -1) return null;
      let i = src.indexOf('(', at), d = 0;
      for (; i < src.length; i++) {
        if (src[i] === '(') d++;
        else if (src[i] === ')' && --d === 0) { i++; break; }
      }
      const open = src.indexOf('{', i);
      if (open === -1) return null;
      d = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}' && --d === 0) return src.slice(open + 1, j);
      }
      return null;
    };
    const fires = (body) => new Set([...(body || '')
      .matchAll(/handlers\.(on[A-Z]\w*)\s*\(/g)].map((m) => m[1]));

    // ONE LEVEL OF CALL GRAPH, because four of the nine are not in either
    // entry point. onBrokerUp/Down/Lost fire inside attachBrokerRecovery and
    // onError's no-transport path fires inside inertTransport; both roles call
    // both helpers, and neither helper's names appear in createHost or
    // joinHost directly. A helper can only fire what it is handed, so the ones
    // worth following are exactly those called with `handlers` as an argument
    // — which is also why this needs no recursion or import graph: the set of
    // functions that can reach a caller's handler is the set that is given it.
    const roleHandlers = (entry) => {
      const body = funcBody(netFlat, entry);
      if (body === null) throw new Error(`net.js: could not find ${entry}()`);
      const names = fires(body);
      for (const m of body.matchAll(/\b([a-z]\w*)\s*\([^)]*\bhandlers\b/g)) {
        const helper = funcBody(netFlat, m[1]);
        if (helper) for (const n of fires(helper)) names.add(n);
      }
      return [...names].sort();
    };
    const HOST_HANDLERS = roleHandlers('createHost');
    const CLIENT_HANDLERS = roleHandlers('joinHost');

    // A SCAN THAT QUIETLY FINDS NOTHING MAKES EVERY ASSERTION BELOW VACUOUS,
    // so a broken parse stops the run instead of passing it. Same reasoning as
    // SCREENS at the top of this file: a derived list is only worth more than
    // a typed one while the derivation is known to be working, and `0 of 0
    // handlers were checked` is a green suite that has tested nothing.
    if (HOST_HANDLERS.length < 8 || CLIENT_HANDLERS.length < 8) {
      throw new Error('net.js handler scan found '
        + `${HOST_HANDLERS.length} host and ${CLIENT_HANDLERS.length} client handlers`);
    }
    // onReplaced needs the guard more than most of these, not less. It is the
    // only handler whose body calls teardown() itself, so an unguarded one
    // running late would bump the epoch a second time and tear down whatever
    // session had started since. Asserted by name because the derivation
    // cannot know that one of the names it finds matters more than the others.
    ok(CLIENT_HANDLERS.includes('onReplaced'),
      'onReplaced is among the client handlers the scan found — the one that tears down from inside');

    for (const [role, names] of [['host', HOST_HANDLERS], ['client', CLIENT_HANDLERS]]) {
      for (const want of names) {
        ok(seen.includes(`${role}.${want}`),
          `${role}.${want} — js/net.js can fire it, so js/main.js wires it and the scanner checked it`);
      }
    }

    // AND THE OTHER DIRECTION. The loop above is satisfied by a main.js that
    // wires twenty handlers so long as the right nine are among them, and a
    // handler net.js never calls is dead code wearing a live name — nothing
    // distinguishes it from the real ones when read, and it will be maintained
    // as though it fires. Before the lists were derived this direction was an
    // equality on the total, which caught a spurious handler only when it was
    // not offset by a missing one.
    const offered = new Set([
      ...HOST_HANDLERS.map((n) => `host.${n}`),
      ...CLIENT_HANDLERS.map((n) => `client.${n}`),
    ]);
    const orphans = seen.filter((s) => !offered.has(s));
    for (const o of orphans) {
      console.error(`  ✗ FAIL: js/main.js wires ${o}, which js/net.js never calls`);
    }
    eq(orphans.length, 0, 'and js/main.js wires no transport handler that net.js cannot fire');
    eq(seen.length, HOST_HANDLERS.length + CLIENT_HANDLERS.length,
      `all ${HOST_HANDLERS.length + CLIENT_HANDLERS.length} transport handlers net.js offers were seen, and every one is guarded`);
    guardedNames = seen;

    // The counter those guards read has to actually move, and it has to move
    // in teardown() — a `live()` that is never falsified is decoration.
    const td = balanced(mainFlat, 'function teardown(');
    ok(td !== null && /netEpoch\s*\+\+/.test(td || ''),
      'teardown() invalidates the epoch, so every handler above goes dead at once');

    // The two timers. Neither is a transport handler, both outlive a
    // teardown, and the reconnect one is the whole reason this seam exists.
    const sr = balanced(mainFlat, 'function scheduleReconnect(');
    ok(sr !== null && /epoch\s*!==\s*netEpoch/.test(sr || ''),
      'the reconnect timer checks the epoch before it re-dials — clearTimeout is not enough on its own');

    // --- and the order of the two lines that retire a superseded tab -------
    //
    // THE ONLY PLACE THIS ORDERING IS ENFORCED. The live transport test for
    // the second tab builds its own host, because liveTable's does not retire
    // anything — so it asserts against a COPY of this handler, and a copy
    // agrees with itself forever. What follows is the part that checks the
    // copy is still describing main.js.
    //
    // Both statements are required and the order is the whole fix: a close
    // that arrives with no explanation is indistinguishable from a channel
    // that died, and the other end will redial, reclaim, and send the tab
    // that just took the seat the same close. Swap these two lines and the
    // frame is sent on a connection that is already shut — trySend() eats
    // the InvalidStateError, nothing throws, nothing is logged, and the loop
    // is back with a passing suite.
    const oj = balanced(mainFlat, 'onJoin: (playerId, hello) =>');
    ok(oj !== null, 'the host onJoin handler was found to check');
    if (oj) {
      const farewell = oj.indexOf('replacedFrame()');
      const retire = oj.indexOf('dropConnection(stale)');
      ok(farewell !== -1, 'onJoin tells a superseded connection why before it goes');
      ok(retire !== -1, 'and still retires it, so the host is not left holding two channels for one player');
      ok(farewell !== -1 && retire !== -1 && farewell < retire,
        'and it says so BEFORE closing the channel it is saying it on, which is the entire fix');
    }
    ok(/replacedFrame/.test(readRepo('js/main.js').slice(0, 4000)),
      'main.js imports the builder rather than writing the type string itself');

    // --- and the other half of it, on the receiving side -------------------
    //
    // THE SESSION RECORD IS SHARED BY EVERY TAB ON THE ORIGIN, which is the
    // same fact that causes this bug in the first place: one localStorage,
    // one ticket, two tabs. So the tab that just LOST the seat must not tidy
    // up after itself. The record it would delete was written moments ago by
    // the tab that WON, and deleting it means THAT tab cannot resume after a
    // reload. The cost of leaving it is this tab pulling the seat back over
    // once if the player reloads here, which settles immediately, because the
    // other tab then lands on this same screen in turn.
    //
    // Checked at the source, and it has to be: the live transport test above
    // runs against a model of this handler, and a model has no localStorage
    // to clobber, so no behavioural test in this suite can see the
    // difference. This is also exactly the edit a tidy-up pass would make —
    // clearSession() is right on the other three terminal screens — and
    // until this assertion the only thing standing in its way was a comment.
    const orp = balanced(mainFlat, 'onReplaced: () =>');
    ok(orp !== null, 'the client onReplaced handler was found to check');
    if (orp) {
      ok(orp.includes('teardown()'),
        'onReplaced tears the session down itself rather than letting the close that follows do it');
      ok(!orp.includes('clearSession'),
        'and does NOT clear the stored session — that record belongs to the tab that took the seat');
      ok(/app\.screen\s*=\s*'replaced'/.test(orp),
        'and lands on the screen that names the cause, rather than the generic error');
    }

    // --- and the amplifier, which lives in the same handler ----------------
    //
    // An unrecognised frame never reaches the engine, so nothing changed and
    // there is nothing to send. It used to push anyway: one junk frame in,
    // seven serialised public states out, and free to the sender because an
    // intent the dispatcher does not recognise can never be refused by the
    // engine either. A REFUSED intent still pushes, deliberately — that
    // client's view has probably drifted and the answer is the truth.
    const onData = balanced(hostLit || '', 'onData:');
    ok(onData !== null, 'the host onData body was located');
    const bail = (onData || '').indexOf('if (!handled) return;');
    const pushes = (onData || '').indexOf('push()');
    ok(bail !== -1, 'the host returns early on a frame the dispatcher did not recognise');
    ok(bail !== -1 && pushes !== -1 && bail < pushes,
      'and returns BEFORE push(), so junk cannot fan one frame out to the whole table');
  }

  console.log(`  main.js teardown discipline: ${guardedNames.join(', ')}`);
}

// ===========================================================================
section('The shell: the page, the manifest and the icons');
// ===========================================================================

{
  // --- index.html -----------------------------------------------------------
  const html = readRepo('index.html');

  // THE THREE SIBLINGS. js/main.js does getElementById on all three at module
  // scope, and js/ui.js's render() wipes everything inside #app on every
  // frame. If any of these moved inside #app, the symptom would be a screen
  // reader that goes silent after the first frame and a rules button that
  // stops working — neither of which throws, and neither of which any other
  // test in this file can see.
  for (const id of ['app', 'announce', 'rules']) {
    ok(new RegExp(`id="${id}"`).test(html), `index.html has #${id}`);
  }

  // Positional, because "present" is not the property that matters — "outside
  // #app" is. #app is written as an empty element, so everything after it in
  // the source is a sibling.
  const appAt = html.indexOf('<div id="app"></div>');
  ok(appAt > 0, '#app is empty in the markup — the renderer fills it');
  for (const marker of ['id="announce"', '<footer', '<dialog id="rules"']) {
    ok(html.indexOf(marker) > appAt,
      `${marker} comes after #app closes, so clear(root) cannot destroy it`);
  }

  // The live region must survive AND be announced. display:none and hidden
  // both remove it from the accessibility tree, which is the usual way this
  // gets quietly broken by someone tidying up.
  const announceTag = html.slice(html.indexOf('id="announce"') - 60, html.indexOf('id="announce"') + 140);
  ok(/aria-live="polite"/.test(announceTag), 'the live region is polite');
  ok(/class="sr-only"/.test(announceTag), 'and hidden with .sr-only');
  ok(!/hidden/.test(announceTag) && !/display:\s*none/.test(announceTag),
    'and NOT with hidden or display:none, either of which would silence it');

  // EVERY LOCAL PATH RELATIVE. Same reason as SHELL: a project site lives at
  // /<repo>/ and a leading slash escapes it.
  const localRefs = [...html.matchAll(/(?:href|src)="(?!https?:|data:|#)([^"]+)"/g)].map((m) => m[1]);

  // Named rather than counted. A floor like `length >= 8` is a number that has
  // to be edited every time an icon is added or removed, and it passes just as
  // happily when the stylesheet reference is the one that went missing and two
  // icons were added. These four are the ones whose absence breaks something:
  // no stylesheet is an unstyled page, no module is no game, no manifest is no
  // install prompt, and no icon is a blank tile.
  for (const must of ['./css/app.css', './js/main.js', './manifest.webmanifest']) {
    ok(localRefs.includes(must), `index.html loads ${must}`);
  }
  ok(localRefs.some((r) => r.startsWith('./icons/')), 'and references at least one icon');

  let rooted = 0;
  for (const r of localRefs) if (!r.startsWith('./')) { rooted++; console.error('  ✗ not relative:', r); }
  eq(rooted, 0, 'and every one of them is relative, so a Pages subpath survives');

  // And every one of them is a file that exists. A typo in an icon path is a
  // broken install prompt that nobody notices until somebody tries.
  let dangling = 0;
  for (const r of new Set(localRefs)) {
    try { readFileSync(REPO + r.slice(2)); } catch (_) { dangling++; console.error('  ✗ dangling:', r); }
  }
  eq(dangling, 0, 'and points at a file that is actually in the repository');

  // PeerJS: a script tag, never an import, which is what keeps "zero
  // dependencies" literally true. `defer` is load-bearing — deferred classic
  // scripts and module scripts share one queue in document order, so this is
  // what guarantees window.Peer exists before js/main.js evaluates and calls
  // peerAvailable() from resume().
  const peerTag = html.match(/<script[^>]*peerjs[^>]*><\/script>/);
  ok(peerTag, 'PeerJS arrives as a <script> tag');
  ok(peerTag && /\sdefer\b/.test(peerTag[0]), 'deferred, so it runs before the module that needs it');
  // Against the position of the TAG, not of the first mention of the string
  // './js/main.js' — which is in the comment above the PeerJS tag explaining
  // this very ordering, and which therefore made this assertion measure the
  // prose rather than the document.
  ok(peerTag && html.indexOf(peerTag[0]) < html.indexOf('<script type="module"'),
    'and earlier in the document than the module script, which is what makes defer ordered');
  ok(!/import[^\n]*peerjs/i.test(html), 'and is never imported');

  // The reset button, and the rule it must never break.
  ok(/id="reset-btn"/.test(html), 'the footer carries the clear-cache button');
  const script = html.slice(html.lastIndexOf('<script>'));
  // #####################################################################
  // THE ONE THAT WOULD BE UNRECOVERABLE. localStorage holds
  // judgement.clientId, which IS a player's claim to their seat. Clearing
  // it does not sign them out and back in; it makes them a stranger to the
  // host, so the rejoin is refused and their seat and their entire
  // scoreboard are gone for the rest of a nineteen-round match. It would
  // also drop judgement.engine, the host's only copy of the game.
  // #####################################################################
  //
  // CHECKED AGAINST THE CODE WITH THE COMMENTS STRIPPED. The first version of
  // this assertion ran against the raw file and failed — on the paragraph
  // above, which says "localStorage" four times while explaining why nothing
  // may touch it. A test that cannot tell an explanation from an instruction
  // would force the explanation to be deleted to make it pass, which is the
  // exact wrong outcome.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const executable = strip(script);
  ok(/caches/.test(executable), 'the stripper left the executable code intact');
  ok(!/localStorage|sessionStorage/.test(executable),
    'and no executable line in the page touches localStorage — clientId and the snapshot survive a reset');

  // BOTH HALVES OF THE BUTTON, ASSERTED SEPARATELY.
  //
  // This was one line reading /caches\.delete|caches\.keys/, and a mutation
  // that deleted the delete outright walked straight past it: the enumeration
  // above it still matched, so the OR was still satisfied. The button would
  // have unregistered the worker, reloaded, and left every stale byte exactly
  // where it was — the one thing it exists to prevent.
  //
  // AN ALTERNATION IS THE WEAKEST SHAPE A TEST CAN TAKE. It keeps passing
  // while either half rots, which means it stops measuring the thing it was
  // written for at the moment that thing breaks. Two assertions cost one line
  // and cannot do that.
  ok(/caches\.keys\(\)/.test(executable), 'whose handler enumerates Cache Storage');
  ok(/caches\.delete\(/.test(executable),
    'and deletes what it finds — without this the button only unregisters and reloads');
  ok(/unregister\(\)/.test(executable), 'and unregisters the service worker');

  // AGAINST THE TAG, NOT THE DOCUMENT — the same trap as the localStorage
  // check above, found the same way. This read /viewport-fit=cover/ over the
  // whole file and passed with the attribute deleted, because the HTML comment
  // four lines above the tag explains what viewport-fit=cover buys. A
  // substring search over a commented file cannot tell the explanation from
  // the thing being explained, so it has to be pointed at the tag itself.
  //
  // It matters: css/app.css pads the play dock with env(safe-area-inset-bottom),
  // and without the opt-in that function returns zero on every browser. The
  // failure is silent on a desktop and is the home indicator sitting on top of
  // the card you are trying to tap on a phone.
  const viewport = (html.match(/<meta\s+name="viewport"[^>]*>/) || [''])[0];
  ok(viewport !== '', 'the page declares a viewport');
  ok(/viewport-fit=cover/.test(viewport),
    'whose tag opts into the safe-area insets css/app.css pays for');
  ok(/width=device-width/.test(viewport), 'and scales to the device rather than a fixed page width');
  ok(/name="theme-color" content="#120711"/.test(html), 'and the browser chrome matches --bg');
}

{
  // --- manifest.webmanifest -------------------------------------------------
  let manifest = null;
  try { manifest = JSON.parse(readRepo('manifest.webmanifest')); passed++; }
  catch (e) { failed++; console.error('  ✗ FAIL: the manifest is not valid JSON —', e.message); }

  if (manifest) {
    eq(manifest.name, 'Judgement', 'the manifest names the app');
    // Relative, for the third time and the same reason. An installed PWA whose
    // start_url is '/' opens the github.io user root, not this game.
    for (const key of ['start_url', 'scope', 'id']) {
      ok(typeof manifest[key] === 'string' && manifest[key].startsWith('./'),
        `manifest ${key} is relative — got ${JSON.stringify(manifest[key])}`);
    }
    // These two are what an installed app paints before any CSS has loaded. If
    // they drift from --bg the splash flashes a different colour than the app.
    eq(manifest.background_color, '#120711', 'the splash background matches --bg');
    eq(manifest.theme_color, '#120711', 'and so does the theme colour');

    // A maskable icon is not optional on Android: without one the launcher
    // takes the "any" icon and shrink-wraps it inside a white circle.
    const purposes = manifest.icons.map((i) => i.purpose);
    ok(purposes.includes('maskable'), 'a maskable icon is declared, so Android does not letterbox it');
    ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'),
      'and a 512 "any" icon, which is the one install prompts use');

    let badIcon = 0;
    for (const i of manifest.icons) {
      if (!i.src.startsWith('./')) { badIcon++; console.error('  ✗ icon path not relative:', i.src); continue; }
      try { readFileSync(REPO + i.src.slice(2)); } catch (_) { badIcon++; console.error('  ✗ icon missing:', i.src); }
    }
    eq(badIcon, 0, `all ${manifest.icons.length} declared icons are relative and present`);
  }
}

{
  // --- the icons themselves -------------------------------------------------
  //
  // Read as bytes, because "the file exists" is also true of a zero-byte file
  // and of an HTML 404 page saved with a .png extension. The PNG header
  // carries the real dimensions, and they are checked against what the
  // manifest and index.html promise — a 512 icon that is really 192 is
  // upscaled by the launcher and looks soft on exactly the devices that show
  // it largest.

  const expected = [
    ['icons/icon-32.png', 32],
    ['icons/icon-192.png', 192],
    ['icons/icon-512.png', 512],
    ['icons/icon-maskable-512.png', 512],
    ['icons/apple-touch-icon.png', 180],
  ];

  let bad = 0;
  for (const [path, size] of expected) {
    const buf = readFileSync(REPO + path);
    // Signature, then IHDR at a fixed offset: length(4) type(4) w(4) h(4).
    const sig = buf.subarray(0, 8).toString('hex');
    if (sig !== '89504e470d0a1a0a') { bad++; console.error('  ✗ not a PNG:', path); continue; }
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w !== size || h !== size) { bad++; console.error(`  ✗ ${path} is ${w}x${h}, expected ${size}x${size}`); }
    if (buf[24] !== 8 || buf[25] !== 2) { bad++; console.error(`  ✗ ${path} is not 8-bit truecolour`); }
  }
  eq(bad, 0, `all ${expected.length} icons are real PNGs at the size they claim`);

  // OPAQUE. Colour type 2 has no alpha channel at all, which is checked above
  // — and that is the property iOS needs, because it composites the
  // apple-touch-icon over nothing and a transparent one comes out black.
  // Stated separately so the reason survives if the check above is edited.
  const apple = readFileSync(REPO + 'icons/apple-touch-icon.png');
  eq(apple[25], 2, 'and the apple-touch icon has no alpha, so iOS cannot render it on black');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
