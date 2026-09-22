// ============================================================================
// rules.js — The vocabulary of Judgement: cards, the table, and how big a hand
// is allowed to get.
//
// No state and no engine here. Everything is a constant or a pure function of
// its arguments, so this module is safe to import from the bot, the tests, the
// UI and a future server alike.
//
// The second half is the four config axes the host picks between, the round
// ladder they generate, and the presets. normalizeConfig() is the ALLOW-LIST
// every config crosses on its way in from the wire — nothing downstream
// re-checks a mode string, which is why nothing downstream may skip it.
//
// Imports only js/scoring.js, for the list of scoring modes. That list lives
// next to the formulas so a fourth mode cannot be offered in the lobby without
// a formula behind it. `node` can exercise every rule in here and the browser
// can load it with no build step.
// ============================================================================

import { SCORING_MODES } from './scoring.js';

/**
 * A frozen lookup table with NO PROTOTYPE.
 *
 * Every table in this file is keyed by a string that arrived over the wire. A
 * plain object literal answers `table['toString']` with an inherited function,
 * which then sails past an `if (!hit)` guard and gets used as if it were a
 * round shape or a trump sequence. A null prototype makes the miss a miss.
 */
function table(obj) { return Object.freeze(Object.assign(Object.create(null), obj)); }

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

// ORDERED SPADES, DIAMONDS, CLUBS, HEARTS — and that is not the usual bridge
// order. It is the Kachuful trump rotation, which the game is named after:
// Ka(kari, spades) Chu(chukat, diamonds) Fu(falli, clubs) L(lal, hearts). The
// rotation is generated from this array rather than written out a second time,
// so the two cannot drift apart. Anything that wants a display order should say
// so explicitly — see DISPLAY_ORDER in js/cards.js, which alternates colour.
export const SUITS = Object.freeze(['S', 'D', 'C', 'H']);

// DESCENDING, ace high. The order of this array IS the strength order — see
// rankValue() — so reversing it would silently invert every trick in the game.
export const RANKS = Object.freeze(['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']);

// A card is a two-character code: rank then suit, e.g. 'AS', 'TH', '2C'.
//
// One deck, so a code is already unique across the game and doubles as the
// card's identity — hands are plain arrays of these strings. (sequence shuffles
// two decks together and therefore needs an `id` distinct from the printed
// `code`; there is nothing to disambiguate here.) It halves the bytes on the
// wire and removes a whole class of "compared the id, meant the code" bug from
// the follow-suit check.
export function rankOf(code) { return code[0]; }
export function suitOf(code) { return code[1]; }

// Ace 14 down to deuce 2. Derived from RANKS rather than written out, so the two
// cannot drift apart.
const RANK_VALUE = table(
  RANKS.reduce((acc, rank, i) => { acc[rank] = RANKS.length + 1 - i; return acc; }, {}),
);

/** Strength of a card's rank. Only ever compared against another card of the
 *  SAME suit — across suits, whether a card wins is a question about trumps and
 *  the led suit, not about rank. See trickWinner() in js/trick.js. */
export function rankValue(code) { return RANK_VALUE[rankOf(code)] || 0; }

export function isRedSuit(suit) { return suit === 'H' || suit === 'D'; }
export function isRedCard(code) { return isRedSuit(suitOf(code)); }

// Keyed by a character out of a card code, which is to say by wire input — so
// these are null-prototype too. `suitGlyph('toString')` on a plain literal
// returns a function, and the `|| ''` fallback below never fires.
const SUIT_GLYPHS = table({ S: '♠', H: '♥', D: '♦', C: '♣' });
const SUIT_NAMES  = table({ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' });
const RANK_NAMES  = table({
  A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: '10',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
});

export function suitGlyph(suit) { return SUIT_GLYPHS[suit] || ''; }
export function suitName(suit)  { return SUIT_NAMES[suit] || ''; }

/** Display rank — 'T' is stored for the ten so every code is two characters. */
export function rankLabel(code) { return rankOf(code) === 'T' ? '10' : rankOf(code); }

/** Spoken form, for aria-labels and the live region: "Queen of hearts". */
export function cardName(code) {
  return `${RANK_NAMES[rankOf(code)] || rankOf(code)} of ${suitName(suitOf(code))}`;
}

// ---------------------------------------------------------------------------
// Trump, including the absence of it
// ---------------------------------------------------------------------------

/**
 * A round with no trump suit at all.
 *
 * A SENTINEL, NOT null, and the distinction earns its keep. Three different
 * things could be described as "no trump" and only one of them is this:
 *
 *   NO_TRUMP  — decided, and the decision is that nothing trumps. Highest card
 *               of the suit led always takes the trick, and a void means you
 *               simply cannot win it.
 *   null      — not decided YET. Under the turn-up method the flipped card has
 *               not been shown, so neither the players nor the public state
 *               know the suit. See TRUMP_REVEAL in js/state.js.
 *   a suit    — decided, and it is that suit.
 *
 * Collapsing the first two onto null is the bug this exists to prevent: a
 * trick resolved during the gap before the reveal would score as No Trump and
 * hand the trick to the wrong player, silently and only sometimes.
 *
 * One character, like a suit code, so a trump fits the same slot on the wire.
 * It is deliberately NOT a letter in SUITS, and isTrumpSuit() below is the only
 * thing allowed to decide which of the three cases a value is.
 */
export const NO_TRUMP = 'N';

/** Whether `trump` names an actual suit. False for NO_TRUMP, for null, and for
 *  anything unexpected arriving over the wire. */
export function isTrumpSuit(trump) {
  return SUITS.includes(trump);
}

/** The trump indicator's glyph. No Trump gets a slashed circle rather than a
 *  suit pip, because the whole point is that it is not one of the four. */
export function trumpGlyph(trump) {
  if (trump === NO_TRUMP) return '⊘';
  return suitGlyph(trump);
}

/** Spoken and written form: "spades", "no trump", or "not yet turned". */
export function trumpName(trump) {
  if (trump === NO_TRUMP) return 'no trump';
  if (!isTrumpSuit(trump)) return 'not yet turned';
  return suitName(trump);
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const DECK_SIZE = 52;

/**
 * Three to seven, everyone for themselves.
 *
 * Two is not a card game of this kind — with the deck split in half there is no
 * hidden information worth bidding against — and eight would cap the maximum
 * hand at six cards, which makes the bid a coin toss. Both bounds are enforced
 * at the lobby's start check rather than assumed anywhere below.
 */
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 7;

/**
 * The largest hand this many players can be dealt without running out of deck.
 *
 * `turnUp` is the trump method that flips the next card off the stock after
 * dealing. That card is spent — it never enters a hand — so the deal has 51
 * cards to work with, not 52. At six players that is the difference between a
 * legal eight-card round and a deal that throws on the last player.
 *
 * Returns the HARD CAP, which is not the default. The defaults (10 for 3-5
 * players, 8 for 6, 7 for 7) are lower on purpose: a 7-player round of 7 cards
 * is 49 of the 52 cards on the table at once, and at that point almost nothing
 * is hidden. See DEFAULT_MAX_HAND below.
 */
export function maxHandSize(players, turnUp = false) {
  const available = turnUp ? DECK_SIZE - 1 : DECK_SIZE;
  return Math.floor(available / players);
}

/**
 * The house default for the biggest round, by player count.
 *
 * Ten is the familiar Kachuful ladder and it is what three, four and five
 * players get. Six and seven cannot have ten — maxHandSize() forbids it — so
 * they get as much as leaves some of the deck unseen.
 *
 * Always clamped through maxHandSize() by the caller, because the turn-up
 * method shaves a card off and 7 x 7 = 49 fits in 52 but not in 51.
 */
export function defaultMaxHand(players) {
  if (players <= 5) return 10;
  if (players === 6) return 8;
  return 7;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const MAX_NAME_LEN = 16;

/**
 * Collapse whitespace, drop control characters, cap the length.
 *
 * A name is rendered at up to seven seats and read aloud across a table; it is
 * not a credential and never stands in for one (see clientId in js/util.js).
 *
 * Written as a codepoint filter rather than a regex because the character class
 * it would need is made of literal control bytes, and a source file containing
 * a raw NUL is a hazard to every tool that later reads it.
 */
export function cleanName(raw) {
  let out = '';
  for (const ch of String(raw == null ? '' : raw)) {
    const cp = ch.codePointAt(0);
    // C0 controls, DEL, and the C1 block. Control whitespace (tab, newline) is
    // dropped here rather than collapsed, which is fine: a name has no lines.
    if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

// ###########################################################################
//
//  THE FOUR AXES
//
//  Everything below is the host's choice of game. There are exactly four
//  axes, they are independent, and together they make 3 x 3 x 3 x 2 = 54
//  playable games. That number is asserted in scripts/test-engine.mjs, not
//  because 54 matters but because a fifth axis added quietly here is a fifth
//  axis the bot and the scoreboard were never told about.
//
//    scoring      how a round is worth points          js/scoring.js
//    trumpMethod  what is trump, and when you find out  below
//    shape        the ladder of hand sizes              below
//    hook         whether the dealer's hand is tied     below
//
//  They are independent on purpose. No combination is illegal, no pair is
//  special-cased, and the presets are three POINTS in that space rather than
//  three separate games with their own code paths.
//
// ###########################################################################

// ---------------------------------------------------------------------------
// Axis 2: what is trump
//
// (Axis 1, the scoring mode, is SCORING_MODES, imported from js/scoring.js so
// the list of modes cannot drift from the list of formulas.)
// ---------------------------------------------------------------------------

export const TRUMP_METHODS = Object.freeze(['rotation', 'turnup', 'rotation-nt']);

// Spades, diamonds, clubs, hearts — SUITS is already in that order, and is
// reused rather than re-listed so the rotation and the deck cannot disagree.
// See the note on SUITS above for why the order is what it is.
const ROTATION_NT = Object.freeze([...SUITS, NO_TRUMP]);

const TRUMP_SEQUENCES = table({
  rotation: SUITS,
  'rotation-nt': ROTATION_NT,
  // Not a sequence at all. The suit comes off the top of the stock after the
  // deal, so it cannot be known before the cards are out — see deal() in
  // js/cards.js and the TRUMP_REVEAL phase in js/state.js.
  turnup: null,
});

/** Whether this method spends a card off the stock, which costs the round one
 *  card and therefore lowers the hand-size cap. maxHandSize() wants this. */
export function needsTurnUp(trumpMethod) { return trumpMethod === 'turnup'; }

/**
 * What is trump in round `roundIndex` (zero-based), before any card is dealt.
 *
 * Returns null for the turn-up method, meaning NOT YET DECIDED rather than
 * "nothing trumps" — the two are different states and NO_TRUMP is the sentinel
 * for the other one. See the note on NO_TRUMP above; conflating them resolves
 * tricks for the wrong player during the gap before the reveal.
 *
 * The No Trump rotation is five long against the plain rotation's four, so the
 * two drift apart immediately and a match under one is nothing like a match
 * under the other. That is the point of offering both.
 */
export function trumpForRound(trumpMethod, roundIndex) {
  if (!(trumpMethod in TRUMP_SEQUENCES)) {
    throw new Error(`trumpForRound: unknown trump method ${JSON.stringify(trumpMethod)}`);
  }
  const seq = TRUMP_SEQUENCES[trumpMethod];
  if (!seq) return null;
  return seq[roundIndex % seq.length];
}

// ---------------------------------------------------------------------------
// Axis 3: the ladder of hand sizes
// ---------------------------------------------------------------------------

export const ROUND_SHAPES = Object.freeze(['descending', 'ascending', 'downup']);

// Built from one descending run so the three shapes cannot disagree about
// where the ladder starts or whether it includes the one-card round.
function ladderDown(top) {
  const out = [];
  for (let n = top; n >= 1; n--) out.push(n);
  return out;
}

const SHAPE_BUILDERS = table({
  descending: (top) => ladderDown(top),
  ascending: (top) => ladderDown(top).reverse(),
  // Down, then back up WITHOUT playing the one-card round twice — 2n-1 rounds,
  // not 2n. At five players that is the 19 rounds the lobby advertises, and
  // getting it wrong by one is a whole extra hand nobody expected.
  downup: (top) => { const d = ladderDown(top); return d.concat(d.slice(0, -1).reverse()); },
});

/**
 * Every round's hand size, in order.
 *
 * `top` is the biggest hand the table will see, already clamped for the player
 * count — call roundPlan() rather than this if you have a config and a table,
 * because that is the version that does the clamping.
 */
export function roundSizes(shape, top) {
  const build = SHAPE_BUILDERS[shape];
  if (!build) throw new Error(`roundSizes: unknown round shape ${JSON.stringify(shape)}`);
  return build(Math.max(1, Math.floor(top)));
}

// ---------------------------------------------------------------------------
// Axis 4: the hook
//
// "The dealer may not bid the number that would make the total of the bids
// equal the tricks available." The dealer bids last, so by the time it is their
// turn exactly one number is forbidden — and forbidding it guarantees that the
// table is collectively wrong, which is what stops every round being a polite
// agreement in which everybody makes their bid.
//
// THE UI MUST GREY THE NUMBER OUT AND SAY WHY. A dealer who taps four and gets
// nothing back learns nothing; a dealer who sees four greyed with "the bids
// would add up to ten" learns the rule in one round. Hence illegalBidReason()
// alongside the boolean, exactly as js/trick.js does for an illegal card.
// ---------------------------------------------------------------------------

/**
 * The number the dealer is not allowed to bid, or null if the hook cannot bite.
 *
 * Null happens whenever the others have already over- or under-bid past the
 * point where the dealer could level things: if the first three players in a
 * five-card round have bid seven between them, no legal dealer bid makes the
 * total five, so nothing is forbidden. Pure arithmetic — it does not know
 * whether the hook is switched on, and it does not care who is asking.
 */
export function forbiddenBid(bidsSoFar, roundSize) {
  let sum = 0;
  for (const bid of bidsSoFar) sum += bid;
  const forbidden = roundSize - sum;
  return forbidden >= 0 && forbidden <= roundSize ? forbidden : null;
}

/**
 * Every bid this player may make, in ascending order.
 *
 * `isDealer` and `hook` ARE REQUIRED AND HAVE NO DEFAULTS, for the same reason
 * stepSeat() demands its direction in js/trick.js: whichever way a default
 * fell it would be wrong half the time and silent both times. Defaulting the
 * hook on greys a legal bid for a table that turned it off; defaulting it off
 * quietly deletes a rule the host asked for. A caller that has not got the
 * config to hand has no business deciding what is legal.
 */
export function legalBids(roundSize, bidsSoFar, { isDealer, hook } = {}) {
  if (typeof isDealer !== 'boolean' || typeof hook !== 'boolean') {
    throw new Error('legalBids: isDealer and hook are both required booleans');
  }
  const all = [];
  for (let bid = 0; bid <= roundSize; bid++) all.push(bid);
  if (!hook || !isDealer) return all;
  const banned = forbiddenBid(bidsSoFar, roundSize);
  return banned === null ? all : all.filter((bid) => bid !== banned);
}

/** Whether one specific bid may be made. The host's enforcement point; the
 *  UI's greying-out mirrors it and is never a substitute for it. */
export function bidIsLegal(bid, roundSize, bidsSoFar, opts) {
  return legalBids(roundSize, bidsSoFar, opts).includes(bid);
}

/** Why a bid cannot be made, phrased for an aria-label. Null when it can. */
export function illegalBidReason(bid, roundSize, bidsSoFar, opts) {
  if (bidIsLegal(bid, roundSize, bidsSoFar, opts)) return null;
  if (!Number.isInteger(bid) || bid < 0 || bid > roundSize) {
    return `there are only ${roundSize} tricks in this round`;
  }
  return `would make the bids add up to ${roundSize}, and someone must be wrong`;
}

// ---------------------------------------------------------------------------
// A config: the four axes plus how big the biggest hand gets
// ---------------------------------------------------------------------------

/** Three players is the widest table, so seventeen is the largest hand any
 *  legal Judgement round can hold. Nothing may ask for more than this. */
export const MAX_HAND_CEILING = maxHandSize(MIN_PLAYERS);

export const DEFAULT_CONFIG = Object.freeze({
  scoring: 'kachuful',
  trumpMethod: 'rotation',
  shape: 'downup',
  hook: true,
  // null means "whatever suits the table" — resolved against the seat count by
  // effectiveMaxHand(), because the host picks a game before knowing how many
  // people will turn up and the cap moves with the seat count.
  maxHand: null,
});

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Clean an untrusted config into a frozen, playable one.
 *
 * THE ONLY PLACE A MODE STRING IS CHECKED. Everything downstream — scoreRound(),
 * trumpForRound(), roundSizes() — throws on a value it does not recognise, and
 * is entitled to because this ran first. js/guards.js calls this on every
 * inbound config; it is not a formality there and not a formality here.
 *
 * Unrecognised values fall back to the default rather than throwing, because a
 * host on an older build sending a config with one field this version has never
 * heard of should still get a game. A field that is actively hostile lands on
 * the same fallback and is equally harmless.
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return Object.freeze({
    scoring: pick(c.scoring, SCORING_MODES, DEFAULT_CONFIG.scoring),
    trumpMethod: pick(c.trumpMethod, TRUMP_METHODS, DEFAULT_CONFIG.trumpMethod),
    shape: pick(c.shape, ROUND_SHAPES, DEFAULT_CONFIG.shape),
    // Default ON, so anything that is not an explicit `false` leaves it on.
    // A host who wants it off says so; noise does not turn a rule off.
    hook: c.hook !== false,
    maxHand: normalizeMaxHand(c.maxHand),
  });
}

// Any NUMBER, however absurd, clamps into range — an infinite ask and an ask
// for five hundred both plainly mean "as big as you can", and answering them
// differently would be a distinction without a reason. Only a value that is
// not a number at all falls back to the table default.
function normalizeMaxHand(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.floor(Number(value));
  if (Number.isNaN(n)) return null;
  return Math.max(1, Math.min(n, MAX_HAND_CEILING));
}

/**
 * The biggest hand this table will actually see.
 *
 * Three numbers meet here and the smallest wins: what the host asked for, the
 * house default for this many players, and the hard cap the deck imposes. The
 * cap is the one that must not be skipped — seven players at seven cards is
 * forty-nine of fifty-two, which fits, and the same round under the turn-up
 * method needs fifty of fifty-one, which also fits, but only just. One card
 * more either way and deal() throws mid-match.
 */
export function effectiveMaxHand(config, players) {
  const cap = maxHandSize(players, needsTurnUp(config.trumpMethod));
  const wanted = config.maxHand === null ? defaultMaxHand(players) : config.maxHand;
  return Math.max(1, Math.min(wanted, cap));
}

/** Every round's hand size for this config at this table. The one function the
 *  engine calls; it clamps so the caller cannot forget to. */
export function roundPlan(config, players) {
  return roundSizes(config.shape, effectiveMaxHand(config, players));
}

// ---------------------------------------------------------------------------
// What the lobby has to tell you before you commit to it
// ---------------------------------------------------------------------------

// Rough, and labelled rough wherever it is shown. Derived from watching the
// thing rather than from anything principled: about two and a half seconds for
// a person to choose and play a card, about four to settle on a bid. Both
// scale with the seat count because every seat does both, every round.
const SECONDS_PER_CARD = 2.5;
const SECONDS_PER_BID = 4;

/**
 * Rounds, tricks and a time estimate, for the lobby.
 *
 * Down-and-back-up doubles the match, and the brief is explicit that the host
 * should find that out in the lobby rather than in round twelve: five players
 * on the default ladder is 19 rounds and a hundred tricks, which is not a
 * fifteen-minute game whatever anyone hoped.
 */
export function matchShape(config, players) {
  const sizes = roundPlan(config, players);
  const tricks = sizes.reduce((sum, n) => sum + n, 0);
  const seconds = tricks * players * SECONDS_PER_CARD + sizes.length * players * SECONDS_PER_BID;
  return {
    rounds: sizes.length,
    tricks,
    maxHand: sizes.length ? Math.max(...sizes) : 0,
    // To the nearest five minutes, floored at five. Any more precision than
    // that would be a lie about how well this is known.
    minutes: Math.max(5, Math.round(seconds / 300) * 5),
  };
}

// ---------------------------------------------------------------------------
// Labels
//
// Here rather than in js/ui.js because the round-over screen, the lobby and the
// live region all name the same axis, and three copies of "Down and back up"
// is three chances for them to disagree about what the host chose.
// ---------------------------------------------------------------------------

export const SCORING_LABELS = table({
  kachuful: { label: 'Kachuful', blurb: 'Ten times your bid, nothing for a miss. A made zero pays five a trick. Bid bravely.' },
  standard: { label: 'Standard', blurb: 'Ten for making it, plus one a trick. Ambition pays almost nothing — call it as you see it.' },
  square: { label: 'Square', blurb: 'Ten plus your bid squared, and the square of your error against you. The only mode that bites.' },
});

export const TRUMP_METHOD_LABELS = table({
  rotation: { label: 'KaChuFuL rotation', blurb: 'Spades, diamonds, clubs, hearts, repeating. Trump is known before the deal.' },
  turnup: { label: 'Turn up a card', blurb: 'One card flipped after the deal sets trump, and sits out the round.' },
  'rotation-nt': { label: 'Rotation with No Trump', blurb: 'The same four, then a fifth round where nothing trumps at all.' },
});

export const SHAPE_LABELS = table({
  descending: { label: 'Down to one', blurb: 'Starts at the biggest hand and shrinks a card a round.' },
  ascending: { label: 'Up from one', blurb: 'Starts at a single card and grows a card a round.' },
  downup: { label: 'Down and back up', blurb: 'Shrinks to one card, then climbs back. Twice the rounds.' },
});

/** Label for any axis value, falling back to the raw string so an unknown
 *  value renders as itself rather than as blank space. */
export function axisLabel(labels, value) {
  const hit = labels[value];
  return hit ? hit.label : String(value);
}

// ---------------------------------------------------------------------------
// Presets
//
// Three POINTS in the 54-game space, not three special modes — picking one
// sets the four toggles and nothing else happens. Changing any toggle
// afterwards leaves you on a config that matches no preset, which is what
// presetMatching() is for and what the lobby shows as "Custom". Same pattern as
// sequence's lobby.
// ---------------------------------------------------------------------------

export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'kachuful',
    label: 'Kachuful',
    blurb: 'The game this is named for. Bold bidding against a known rotation, the full ladder down and back up.',
    config: Object.freeze({ scoring: 'kachuful', trumpMethod: 'rotation', shape: 'downup', hook: true, maxHand: null }),
  }),
  Object.freeze({
    id: 'classic',
    label: 'Classic Oh Hell',
    blurb: 'The English original. A turned card for trump, one descent to a single card, and no penalty for missing.',
    config: Object.freeze({ scoring: 'standard', trumpMethod: 'turnup', shape: 'descending', hook: true, maxHand: null }),
  }),
  Object.freeze({
    id: 'cutthroat',
    label: 'Cutthroat',
    blurb: 'Squared scoring with real penalties and a No Trump round every fifth hand. Scores go negative. Play safe.',
    config: Object.freeze({ scoring: 'square', trumpMethod: 'rotation-nt', shape: 'downup', hook: true, maxHand: null }),
  }),
]);

const CONFIG_KEYS = Object.freeze(['scoring', 'trumpMethod', 'shape', 'hook', 'maxHand']);

/** The preset this config IS, or null for a custom one. */
export function presetMatching(config) {
  const hit = PRESETS.find((p) => CONFIG_KEYS.every((k) => p.config[k] === config[k]));
  return hit ? hit.id : null;
}

/** A preset's config, cleaned through the same allow-list as anything else —
 *  a preset is a starting point for the toggles, not a bypass around them. */
export function presetConfig(id) {
  const hit = PRESETS.find((p) => p.id === id);
  return normalizeConfig(hit ? hit.config : DEFAULT_CONFIG);
}
