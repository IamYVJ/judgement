// ============================================================================
// bot.js — A computer player, and the paced driver that lets it take a turn.
//
// WHY A BOT EXISTS AT ALL
//   Judgement seats three to seven. Two friends in a room cannot start, and a
//   nineteen-round match is long enough that somebody's battery will die in the
//   middle of it. Bots fill the empty chairs and cover the seat of a phone that
//   has gone dark. Playing solo against five of them works too, but that is the
//   side effect rather than the point.
//
// ############################################################################
// #  THE ONE THING THAT MAKES THIS DIFFERENT FROM EVERY OTHER TRICK-TAKING    #
// #  BOT IN THIS FAMILY OF REPOS:                                            #
// #                                                                          #
// #      IT MUST SOMETIMES TRY TO LOSE.                                      #
// #                                                                          #
// #  In Court Piece more tricks is always better, so a bot that plays to win  #
// #  every trick is merely unsubtle. Here the goal is EXACTLY the bid. Once a #
// #  bot has taken the tricks it bid, every further trick is a disaster —     #
// #  under `square` it is literally points off the board. A bot ported from   #
// #  courtpiece/js/bot.js would play a technically flawless game and lose     #
// #  every round it was winning. So the play logic below is organised around  #
// #  one question asked before any other: AM I UNDER, AT, OR OVER MY BID?     #
// #  See appetite().                                                         #
// ############################################################################
//
// THE SHAPE, AND WHY IT IS THIS SHAPE
//   chooseBid() and chooseCard() are PURE. They read the two views the engine
//   already hands out — publicState() and privateStateFor() — hold nothing
//   between calls, and return a wire message: the same message a phone would
//   have sent. The config arrives inside those views and is never assumed.
//
//   That buys four things:
//     1. No second copy of the rules. privateStateFor() has already run
//        canPlay() over every card, so `card.legal` IS the follow-suit rule,
//        and bidOptions IS the hook. This file never decides what is legal; it
//        only ranks what it was given, so it cannot produce an illegal play or
//        an illegal bid even when the ranking is wrong. The soak asserts both.
//     2. The move goes through applyGameIntent() like everybody else's, so the
//        engine validates it exactly as it validates a human's. A bug in here
//        gets an { ok:false } back and cannot corrupt a game.
//     3. It is testable without a table, a socket or a clock: hand it two plain
//        objects, get an intent back.
//     4. Difficulty is not a config axis. One solid level, deliberately — an
//        easy/normal/hard selector means a new config key, a new lobby control,
//        a new field on the wire and three times the tests, to produce two
//        settings nobody picks twice. This plays like an attentive casual
//        player: it counts what has gone, it knows when it is over its bid and
//        gets out of the way, and it bids differently under each scoring mode.
//        It does not signal, read the table's distribution, or plan a squeeze.
//
// THE BOT DOES NOT CHEAT, AND THE SHAPE IS WHAT STOPS IT
//   Bots run on the host, and the host knows every hand, the stock, and the
//   turn-up card before it is flipped. The only thing keeping them honest is
//   that these functions are handed publicState() and ONE seat's private view —
//   nothing else, ever. Do not add a third parameter. Under the turn-up method
//   publicState() withholds turnUpCard until the reveal, so a bot bidding in
//   that round is in exactly the fog a human is, and there is a test that fails
//   if the trump leaks into a decision made before the flip.
//
// NO TIMERS IN THE THINKING, AND NO THINKING IN THE TIMER
//   The pause before a bot moves is the driver's business, at the bottom of
//   this file, and it follows the same rule js/state.js does: the driver is
//   ticked by whoever owns the engine, and time arrives as a parameter.
//
// Node-safe: imports rules.js, trick.js, cards.js, scoring.js, intents.js and
// state.js, none of which touch the DOM. That is what lets the harness play
// thousands of complete matches headlessly.
// ============================================================================

import { SUITS, RANKS, rankOf, suitOf, rankValue, isTrumpSuit, legalBids } from './rules.js';
import { scoreRound } from './scoring.js';
import { seatsFrom, ledSuitOf, wouldWin } from './trick.js';
import { buildDeck } from './cards.js';
import { applyGameIntent } from './intents.js';
// Only for the phase names. state.js does not import this module, so there is
// no cycle — and taking the constants rather than writing 'play' here is what
// stops a renamed phase leaving every bot quietly asleep instead of failing.
import { PHASES } from './state.js';

// ---------------------------------------------------------------------------
// Tuning. Five numbers, and every one of them is an admission that this is an
// estimate rather than a solver. They are exported so the harness can sweep
// them and so a future adjustment is a visible diff rather than a magic edit.
// ---------------------------------------------------------------------------

/**
 * How much of a ruff survives being over-ruffed, and how much of the "my small
 * trumps will take tricks late, once the big ones are gone" story to believe.
 *
 * Both are haircuts on optimism. Without them a hand with a void and four
 * small trumps bids the moon and takes three, which under `square` is nine
 * points off the board.
 */
export const RUFF_HOLDS = 0.75;

/**
 * When a small trump finally gets to ruff, roughly half the trumps that outrank
 * it have already been played. So its "will this ruff hold" calculation is run
 * against half the outstanding higher trumps rather than all of them.
 *
 * The alternative — running it against all of them — values the two of trumps
 * at zero in every round, which is right in a one-card round and badly wrong in
 * a thirteen-card one. This one constant is the difference.
 */
export const LATE_TRUMP_DISCOUNT = 0.5;

/** How sure the bot wants to be before it calls a winning card "safe" and
 *  spends its cheapest one instead of its best. Three in four: high enough that
 *  it does not throw away contested tricks, low enough that in Judgement's
 *  huge undealt stock — where almost nothing is ever certain — it is not
 *  permanently paralysed into playing its highest card every time. */
export const SAFE_ENOUGH = 0.75;

/** Trumps in hand before leading them to draw the opposition's is worth the
 *  cards it costs. Judgement hands run from 1 to 17 cards, so this is a
 *  fraction of the round rather than courtpiece's flat four-of-thirteen. */
export const DRAW_TRUMPS_SHARE = 0.4;

/** Two expected values within this of each other are a tie, and the tie-break
 *  below decides. Floating point makes exact equality useless here: under
 *  `standard` a dozen bids can be worth the same to fifteen decimal places. */
const EPS = 1e-9;

/** Bounds on the calibration exponent in `trickChances`. Not tuning — a guard
 *  against a degenerate pool. Outside roughly [0.2, 5] the curve is so steep
 *  that the estimate has stopped meaning anything anyway. */
const MIN_GAMMA = 1 / 32;
const MAX_GAMMA = 32;
/** Bisection steps. The bracket spans ten octaves and each step halves it, so
 *  twenty lands the exponent inside one part in a hundred thousand — absurdly
 *  finer than an estimate built on approximations deserves, and cheap enough
 *  to run at every bid of a soak that plays tens of thousands of them. */
const CALIBRATION_STEPS = 20;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Accepts plain codes AND the `{ code, legal }` objects privateStateFor()
 *  hands out, because both callers exist and the failure mode of getting it
 *  wrong is a silent hand of undefineds rather than a throw. */
function codesOf(hand) {
  if (!Array.isArray(hand)) return [];
  return hand
    .map((c) => (typeof c === 'string' ? c : (c && c.code)))
    .filter((c) => typeof c === 'string' && c.length === 2);
}

function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }

/** The cards this seat cannot see: the whole deck, less its own hand, less
 *  everything already face up.
 *
 *  IN JUDGEMENT THIS IS MOSTLY STOCK. A five-card round at four players deals
 *  twenty of fifty-two, so thirty-two cards are unknown and only fifteen of
 *  them are in anybody's hand. Every probability below turns on that ratio —
 *  it is why a king is a near-certain trick in a short round and a coin flip in
 *  a long one, and why a bot that assumed a full deck would bid like a Bridge
 *  player and be wrong all night. */
function unknownCards(mine, seen) {
  const gone = new Set([...mine, ...seen]);
  return FULL_DECK.filter((code) => !gone.has(code));
}

/** Built once. buildDeck() returns a fresh array by design — a caller that
 *  shuffles must not disturb anybody else's deck — but this one is only ever
 *  read, and it is read at every bid and every card of every hand. */
const FULL_DECK = Object.freeze(buildDeck());

function countBySuit(codes) {
  const out = Object.create(null);
  for (const suit of SUITS) out[suit] = 0;
  for (const code of codes) if (out[suitOf(code)] !== undefined) out[suitOf(code)] += 1;
  return out;
}

/** Suit -> the cards held in it, strongest first. */
function groupBySuit(codes) {
  const out = Object.create(null);
  for (const suit of SUITS) out[suit] = [];
  for (const code of codes) if (out[suitOf(code)]) out[suitOf(code)].push(code);
  for (const suit of SUITS) out[suit].sort((a, b) => rankValue(b) - rankValue(a));
  return out;
}

/** Rank character -> its position in RANKS. RANKS is DESCENDING, so the ace is
 *  position 0 and a lower position means a stronger card. */
const RANK_POS = Object.freeze(
  RANKS.reduce((acc, r, i) => { acc[r] = i; return acc; }, Object.create(null)),
);

/** Suit -> a table of how many unseen cards outrank each rank position.
 *
 *  Built in ONE pass over the pool and then turned into a running total, so the
 *  question below is a single array lookup. That matters because calibration
 *  asks it of all fifty-two cards rather than just the ones in hand: the scan
 *  this replaces was O(pool) per card, which is ~2500 comparisons per bid. */
function higherIndex(unknown) {
  const out = Object.create(null);
  for (const suit of SUITS) out[suit] = new Array(RANKS.length).fill(0);
  for (const code of unknown) {
    const row = out[suitOf(code)];
    if (row) row[RANK_POS[rankOf(code)]] += 1;
  }
  for (const suit of SUITS) {
    const row = out[suit];
    let above = 0;
    // Walking downward in rank, `above` is everything already passed — which is
    // exactly everything stronger than the position being written.
    for (let i = 0; i < row.length; i++) { const here = row[i]; row[i] = above; above += here; }
  }
  return out;
}

/** How many unseen cards outrank this one in its own suit. The single most
 *  load-bearing quantity in the file. */
function higherOut(code, idx) {
  return idx[suitOf(code)][RANK_POS[rankOf(code)]];
}

/** Deterministic argmin/argmax over codes. Ties break on rank and then on the
 *  code string, so two identical positions always produce the same card — which
 *  is what makes a soak of thousands of matches reproducible and a failure
 *  worth re-running. */
function pick(codes, score, want) {
  let best = null;
  let bestScore = 0;
  for (const code of codes) {
    const s = score(code);
    if (best === null
      || (want === 'max' ? s > bestScore + EPS : s < bestScore - EPS)
      || (Math.abs(s - bestScore) <= EPS && code < best)) {
      best = code; bestScore = s;
    }
  }
  return best;
}

const highest = (codes) => pick(codes, rankValue, 'max');
const lowest = (codes) => pick(codes, rankValue, 'min');

// ===========================================================================
//
//  BIDDING
//
//  THE BIDDING STRATEGY IS NOT IN THIS FILE. That is the whole design.
//
//  A hardcoded table of "bid this with that hand" would have to be written
//  three times — once per scoring mode — and the brief is explicit that it
//  must not be. So the bot does the only thing that keeps one source of truth:
//  it estimates a PROBABILITY DISTRIBUTION over how many tricks the hand will
//  take, then asks js/scoring.js what each candidate bid is worth against that
//  distribution, and takes the best one.
//
//      EV(b) = SUM over a of  P(take a tricks) x scoreRound(mode, b, a, size)
//
//  Every behaviour the brief asks for falls out of that single line, because
//  it falls out of the formulas themselves:
//
//    kachuful  10 x bid, missing is free. The penalty term is identically
//              zero, so EV(b) = P(b) x 10b and the 10b factor drags the bid
//              ABOVE the likeliest count — optimism, for free, without a rule
//              saying so. And the zero bid pays 5 x roundSize, so on a bad
//              hand in a big round EV(0) walks away from everything: in a
//              ten-card round a made zero is 50, which beats a made four and
//              ties a made five. The bot finds that on its own, from the
//              formula, and there is no 5 and no 10 anywhere in this file.
//    standard  10 + bid. The whole spread of ambition across a ten-card round
//              is 10 against a base of 10, so EV is dominated by P(b) and the
//              answer collapses to the most likely count. Flat curve in, flat
//              play out.
//    square    10 + bid^2, and a miss COSTS -(actual - bid)^2. That penalty is
//              a variance term, and minimising it pulls the bid towards the
//              middle of the distribution and away from its tail.
//              Conservative and accurate, because the arithmetic is.
//
//  A FOURTH SCORING MODE WOULD NEED NO CHANGE HERE AT ALL. That is the test of
//  whether this was done properly, and scripts/test-engine.mjs runs it: each
//  mode's behaviour is asserted from its formula, never from a constant here.
//
// ===========================================================================

/**
 * Everything chooseBid() needs, read off the two views.
 *
 * Separate from chooseBid() so the harness can hand-build a context and sweep
 * one axis at a time — the same hand under three scoring modes, or with and
 * without the hook — which is impossible if the context is trapped inside.
 */
export function bidContext(pub, priv) {
  return {
    scoring: pub.config.scoring,
    roundSize: pub.roundSize,
    players: pub.seats.length,
    trump: pub.trump,
    // The turn-up, and ONLY once it has been shown. publicState() sends null
    // before the reveal, so this is empty in exactly the rounds where the bot
    // is not entitled to know — there is no branch here doing the withholding,
    // because the withholding already happened upstream.
    seen: pub.turnUpCard ? [pub.turnUpCard] : [],
    // The engine's own answer about what may be bid, exactly as card.legal is
    // the engine's own answer about what may be played.
    //
    // THIS IS HOW THE HOOK IS RESPECTED. Not by re-deriving forbiddenBid() —
    // which would be a second implementation of a rule that already has one —
    // but by never putting the forbidden number in front of the chooser. A bot
    // that is the dealer under the hook cannot bid the banned number, because
    // the banned number is not among the things it is choosing between.
    legalBids: Array.isArray(priv.bidOptions)
      ? priv.bidOptions.filter((o) => o && o.legal).map((o) => o.bid)
      : null,
    isDealer: priv.isDealer === true,
    hook: pub.config.hook === true,
  };
}

/** Fill in what a hand-built context left out, and work out the legal set.
 *  Called once at the top of each public entry point, so nothing below has to
 *  be defensive twice. */
function readBidCtx(hand, ctx) {
  const c = ctx || {};
  const codes = codesOf(hand);
  const roundSize = Number.isInteger(c.roundSize) && c.roundSize > 0 ? c.roundSize : codes.length;
  const players = Number.isInteger(c.players) && c.players > 1 ? c.players : 4;
  const seen = codesOf(c.seen || []);

  let legal = Array.isArray(c.legalBids)
    ? c.legalBids.filter((b) => Number.isInteger(b) && b >= 0 && b <= roundSize)
    // legalBids() in js/rules.js demands both booleans and refuses to default
    // them, for the reason given at its definition. Passing them explicitly is
    // that refusal being honoured rather than worked around.
    : legalBids(roundSize, c.bidsSoFar || [], {
      isDealer: c.isDealer === true, hook: c.hook === true,
    });
  // A context that somehow forbade everything would otherwise return undefined
  // and be bid as NaN. Zero is always a bid; there is no pass in this game.
  if (!legal.length) legal = [0];

  return {
    codes,
    roundSize,
    players,
    seen,
    legal,
    scoring: c.scoring,
    // NO_TRUMP and a not-yet-turned null both land on "there is no trump
    // suit", through the same helper the engine resolves a trick with. Bidding
    // under the turn-up method happens after the reveal, so the null case is
    // defence rather than a path the game actually takes.
    trump: isTrumpSuit(c.trump) ? c.trump : null,
  };
}

/**
 * The chance each card in the hand takes a trick, one number per card.
 *
 * Two hazards, and for trumps one extra chance. Every one of them is an
 * approximation and is documented as one; the evidence that they are good
 * enough is not in this comment, it is in the soak, which plays thousands of
 * matches and measures how often the resulting bids are actually made.
 */
export function trickChances(hand, ctx) {
  const c = readBidCtx(hand, ctx);
  const unknown = unknownCards(c.codes, c.seen);
  const pool = unknown.length;
  if (!pool) return c.codes.map(() => 0);

  // The one ratio the whole estimate rests on: given a card this seat cannot
  // see, how likely is it to be in somebody's HAND rather than face down in
  // the stock? In a one-card round at four players that is 3/51; in a
  // thirteen-card round at four it is 39/51.
  const q = clamp01((c.roundSize * (c.players - 1)) / pool);
  const idx = higherIndex(unknown);
  const bySuit = countBySuit(unknown);
  const ruff = c.trump ? ruffOpportunity(c, q) : 0;

  // Two lookup tables, because both quantities below have far fewer distinct
  // values than there are cards to ask about, and calibration asks about all
  // fifty-two. TOP is (1-q)^k for every k a suit could produce — at most
  // fourteen — and SURVIVES is the ruff hazard, which depends on the SUIT and
  // not on the card, so there are four of it and not fifty-two.
  const TOP = [];
  for (let k = 0; k <= RANKS.length; k++) TOP.push(Math.pow(1 - q, k));
  const SURVIVES = Object.create(null);
  for (const suit of SUITS) {
    SURVIVES[suit] = c.trump && suit !== c.trump
      ? 1 - ruffRisk(suit, c, bySuit, pool)
      : 1;
  }

  // The part of a card's strength that depends only on the CARD, never on the
  // hand it sits in. Splitting it out is what makes the calibration below
  // legitimate: it can be averaged over the whole deck precisely because it
  // would give the same answer in anybody's hand.
  const base = (code) => {
    // "Nothing that beats me in my own suit was even dealt." The pessimistic
    // reading — every higher card in play will eventually be played over me —
    // and the right one for side suits, where a five really does almost never
    // win a trick.
    const top = TOP[higherOut(code, idx)];

    // #####################################################################
    // #  THE NO TRUMP PATH. Not a special case bolted on: with no trump    #
    // #  suit there is no ruff hazard and no ruff credit, so the estimate  #
    // #  collapses to "is anything higher in my suit still out there".     #
    // #  That is exactly the game No Trump is — highest card of the suit   #
    // #  led always wins, and a void means you simply cannot win it — and  #
    // #  it is why a long weak suit is worth more in these rounds and a    #
    // #  singleton ace is worth less.                                      #
    // #####################################################################
    if (!c.trump) return top;

    // A TRUMP HAS NO RUFF HAZARD: a higher trump is already the `above` term
    // and nothing else in the deck can touch it.
    if (suitOf(code) === c.trump) return top;

    return top * SURVIVES[suitOf(code)];
  };

  // =========================================================================
  //  CALIBRATION. The single most important correction in the file.
  //  (Read the note on calibrate() below for the mechanism.)
  //
  //  `top` answers "is this card the outright boss of its suit", which is
  //  STRICTLY STRONGER than "does this card win a trick" — a king wins plenty
  //  of tricks the ace never turns up for — and it says nothing at all about
  //  whether the card's suit ever gets led. Uncorrected, that error does not
  //  merely scale: measured against real play it ran 1.8x HIGH in a one-card
  //  round and 0.69x LOW at six players with five cards, because the shorter
  //  the round the less of the deck is live and the closer every `top` gets to
  //  one. Those two errors happen to cancel in the aggregate, which is exactly
  //  why they survived the first soak.
  //
  //  The fix needs no tuning constant, because the game supplies the answer.
  //  Every trick is taken by exactly one of the `players` cards played to it.
  //  So across the cards actually in play, the mean chance of winning is
  //  EXACTLY 1/players — an identity, not an estimate. And since a deal is
  //  uniform, the whole deck is a fair sample of the cards in play, so the
  //  deck average of `base` is an unbiased estimate of the quantity that must
  //  equal 1/players. One division turns the shape of the estimate — which is
  //  sound, aces beat twos — into the right magnitude.
  // =========================================================================
  //
  // Deliberately NOT normalised against this hand: a good hand has to be
  // allowed to come out above average, which is the entire point of looking at
  // it. The curve is fitted to the DECK and then applied to the hand.
  const deck = c.codes.concat(unknown);
  const gamma = calibrate(deck.map(base), 1 / c.players);

  return c.codes.map((code) => {
    const b = clamp01(Math.pow(base(code), gamma));
    if (c.trump && suitOf(code) === c.trump) {
      // The second way a trump can win, that no other card has: taking a trick
      // in a suit it does not hold. Added on top of the calibrated figure and
      // out of the headroom left above it, not scaled again — it is a claim
      // about THIS hand's shape, and the calibration above is deliberately
      // blind to shape.
      const holdsLate = Math.pow(1 - q, higherOut(code, idx) * LATE_TRUMP_DISCOUNT);
      return clamp01(b + (1 - b) * ruff * holdsLate);
    }
    return b;
  });
}

/**
 * Find the exponent that moves a set of probabilities onto a known mean.
 *
 * WHY A CURVE AND NOT A MULTIPLIER. The obvious correction is to scale every
 * chance by `target / mean`. It does not work, and the way it fails is
 * instructive: at seven players with seven cards the estimate needs pushing UP
 * by about 1.9x, but an ace already sits at 1.0, so scaling clamps it straight
 * back to 1.0 and throws away exactly the mass it was trying to add. Measured,
 * the "corrected" figure came out at 0.69x the truth — barely better than the
 * uncorrected one. A multiplier cannot calibrate a bounded quantity.
 *
 * `p ** gamma` can. It maps [0,1] onto [0,1] with both ends pinned, it is
 * strictly monotone so it never reorders two cards, and its mean falls
 * smoothly as gamma rises — which makes finding the right gamma a bisection
 * with no derivative and no failure case. Gamma below one lifts the middle
 * (a weak field where mediocre cards win more than their rank suggests);
 * above one it flattens the middle toward zero.
 *
 * This is the same move as temperature scaling a classifier: leave the
 * ordering alone, which the model gets right, and fix the confidence, which
 * it does not.
 */
function calibrate(values, target) {
  const n = values.length;
  if (!n) return 1;

  // v**g is exp(g * ln v), and the logs do not change between steps. Taking
  // them once turns the search from a few thousand pow() calls into the same
  // number of exp() calls plus fifty-two logs — this runs at every bid of
  // every seat of every round, and the soak plays tens of thousands of them.
  // Exact zeros are dropped rather than logged: they contribute nothing at any
  // exponent, and log(0) is -Infinity.
  const logs = [];
  let plain = 0;
  for (const v of values) {
    if (v <= EPS) continue;
    if (v >= 1 - EPS) { plain += 1; continue; }  // a certainty stays one, always
    logs.push(Math.log(v));
  }
  const meanAt = (g) => {
    let s = plain;
    for (const l of logs) s += Math.exp(g * l);
    return s / n;
  };

  // Nothing to do, and — more importantly — nothing that CAN be done if every
  // card is a certainty or none of them is. Both ends are fixed points of the
  // curve, so no exponent would move the mean off them.
  const at1 = meanAt(1);
  if (at1 <= EPS || at1 >= 1 - EPS) return 1;
  if (Math.abs(at1 - target) < EPS) return 1;

  let lo = MIN_GAMMA;   // the biggest mean this curve can reach
  let hi = MAX_GAMMA;   // the smallest
  if (meanAt(lo) < target) return lo;
  if (meanAt(hi) > target) return hi;
  for (let i = 0; i < CALIBRATION_STEPS; i++) {
    const mid = Math.sqrt(lo * hi); // geometric: an exponent's scale is its log
    if (meanAt(mid) > target) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/**
 * How likely a given trump in this hand is to win a trick by ruffing.
 *
 * A hand-level number rather than a per-card one, because the opportunity
 * belongs to the SHAPE of the hand — its voids — and is then shared out among
 * whichever trumps are available to take it. Five trumps and one void is one
 * ruff, not five.
 */
function ruffOpportunity(c, q) {
  const trumps = c.codes.filter((code) => suitOf(code) === c.trump).length;
  if (!trumps) return 0;

  let shortness = 0;
  for (const suit of SUITS) {
    if (suit === c.trump) continue;
    const n = c.codes.filter((code) => suitOf(code) === suit).length;
    if (n === 0) shortness += 1;        // void: can ruff from the first trick
    else if (n === 1) shortness += 0.5; // singleton: one round to get there
  }
  // A one-card hand is "void" in three suits and can ruff in none of them: a
  // hand with no side cards has no shape, and the `above` term has already
  // said everything true about its single trump. Capping the opportunity at
  // the number of side cards held is what deletes that fiction.
  shortness = Math.min(shortness, c.codes.length - trumps);
  if (shortness <= 0) return 0;

  // And a ruff needs a LATER trick to happen in. In a one-card round there is
  // no later, and this term is exactly zero.
  const room = (c.roundSize - 1) / c.roundSize;
  return clamp01((shortness / trumps) * RUFF_HOLDS * room);
}

/** The chance a card of this side suit gets trumped by somebody.
 *
 *  Per opponent: they must be void in the suit AND hold a trump. Both are
 *  estimated from the same unseen pool, so a suit this hand is long in is
 *  correctly treated as one the opposition is short in. */
function ruffRisk(suit, c, unknownBySuit, pool) {
  const k = c.roundSize;
  const pVoid = Math.pow(1 - unknownBySuit[suit] / pool, k);
  const pTrump = 1 - Math.pow(1 - unknownBySuit[c.trump] / pool, k);
  return clamp01(1 - Math.pow(1 - pVoid * pTrump, c.players - 1));
}

/**
 * Turn per-card chances into P(exactly n tricks), for n = 0..hand size.
 *
 * A Poisson binomial, by the obvious dynamic program. Treating the cards as
 * independent is not true — they compete for the same tricks — but it is the
 * assumption that turns a point estimate into a DISTRIBUTION, and a
 * distribution is the thing the scoring formulas need. An expected value of
 * 2.4 says nothing about whether to bid 2 under `square`; P(2)=0.31 against
 * P(3)=0.29 says everything.
 *
 * Exported because it has properties worth asserting on their own: the length
 * is always chances.length + 1, every entry is a probability, and the whole
 * thing sums to one.
 */
export function trickDistribution(chances) {
  let dist = [1];
  for (const raw of chances) {
    const p = clamp01(Number(raw) || 0);
    const next = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k] += dist[k] * (1 - p);
      next[k + 1] += dist[k] * p;
    }
    dist = next;
  }
  return dist;
}

/** What one candidate bid is worth against a distribution of outcomes.
 *
 *  The only place in this file that knows scoring modes exist, and it does not
 *  know WHICH one — it asks js/scoring.js. Both halves of the brief's rule are
 *  in that single call: scoreRound(mode, b, b, size) is the reward for making
 *  it, scoreRound(mode, b, a, size) is the cost of missing it by a - b. */
export function bidValue(bid, dist, { scoring, roundSize }) {
  let ev = 0;
  for (let actual = 0; actual < dist.length; actual++) {
    if (dist[actual] <= 0) continue;
    ev += dist[actual] * scoreRound(scoring, bid, actual, roundSize);
  }
  return ev;
}

/**
 * The bid. PURE, with the config passed in.
 *
 * @param hand  card codes, or the { code } objects privateStateFor() sends
 * @param ctx   from bidContext(pub, priv), or hand-built in a test
 */
export function chooseBid(hand, ctx) {
  const c = readBidCtx(hand, ctx);
  const dist = trickDistribution(trickChances(hand, c));
  // Used only to break ties: when two bids are worth exactly the same, take
  // the one the hand actually points at rather than the lower-numbered one.
  const mean = dist.reduce((m, p, k) => m + p * k, 0);

  let best = c.legal[0];
  let bestEv = -Infinity;
  let bestGap = Infinity;
  for (const bid of c.legal) {
    const ev = bidValue(bid, dist, c);
    const gap = Math.abs(bid - mean);
    const tied = Math.abs(ev - bestEv) <= EPS;
    const better = ev > bestEv + EPS
      || (tied && gap < bestGap - EPS)
      // Third tie-break, so the answer is a function of the hand and nothing
      // else. A bot that bid differently on a re-run would make every soak
      // failure unreproducible, which is most of what a soak is for.
      || (tied && Math.abs(gap - bestGap) <= EPS && bid < best);
    if (better) { best = bid; bestEv = ev; bestGap = gap; }
  }
  return best;
}

// ===========================================================================
//
//  PLAYING A CARD
//
//  Three appetites, and the branch on them comes before everything else.
//
// ===========================================================================

/**
 * Am I under, at, or over my bid?
 *
 * THE MOST IMPORTANT FUNCTION IN THE FILE, and the one a port from a
 * more-is-better game would not have at all.
 *
 *   'duck'  at or over the bid. Every further trick is a disaster — under
 *           `square` it is literally points off the board, and under all three
 *           it throws away a round that was already won. The bot must actively
 *           get out of the way, and ducking is not "play your lowest card", it
 *           is "play the highest card that does not win": the low cards are
 *           what will duck the remaining tricks, and the high ones are the
 *           liability to be shed while shedding is free.
 *   'must'  needs every remaining trick. No economy left to practise; win, and
 *           win with whatever it takes.
 *   'want'  under the bid with slack in hand. Take tricks, but cheaply, and
 *           keep something back for the ones still to come.
 *
 * Pure arithmetic over two numbers, exported so the harness can sweep the
 * whole (need, left) grid rather than trust a handful of examples.
 */
export function appetite(need, left) {
  if (!(need > 0)) return 'duck';
  if (need >= left) return 'must';
  return 'want';
}

/**
 * Decide which card to play.
 *
 * @param pub   engine.publicState()
 * @param priv  engine.privateStateFor(botId)
 * @returns a playCard intent, or null when it is not this seat's turn.
 */
export function chooseCard(pub, priv) {
  if (!pub || !priv || !priv.isTurn || !Array.isArray(priv.hand)) return null;

  // The engine's own legality, not a second opinion. Everything below only
  // ranks this list, so the ranking can be wrong without the play being
  // illegal — which is what the soak's zero-refusals count actually proves.
  const legal = priv.hand.filter((c) => c && c.legal).map((c) => c.code);
  if (!legal.length) return null;
  if (legal.length === 1) return { type: 'playCard', code: legal[0] };

  const view = readTable(pub, priv);
  const code = view.plays.length ? follow(view, legal) : lead(view, legal);
  // Unreachable unless a ranking function returns nothing, and it exists
  // because a table waiting on a bot is a dead game.
  return { type: 'playCard', code: code || legal[0] };
}

/**
 * Everything the ranking needs, read off the two views once per turn.
 *
 * This is where the bot's memory comes from. It holds none between calls, so
 * "what has gone" and "who is void in what" are rebuilt from pub.tricks every
 * time — which is why they can never drift out of step with the real game, and
 * why a bot covering a seat mid-round after a host reload knows exactly what
 * the seat's previous occupant knew.
 */
function readTable(pub, priv) {
  const seat = priv.seat;
  const players = pub.seats.length;
  const plays = Array.isArray(pub.plays) ? pub.plays : [];
  const done = Array.isArray(pub.tricks) ? pub.tricks : [];
  const hand = codesOf(priv.hand);

  // Who is provably void in what. Playing off-suit is only legal when void, so
  // an off-suit card IS the proof — the same fact the engine uses to decide
  // legality, read backwards. This is honest information: every player at the
  // table watched it happen.
  const voids = Array.from({ length: players }, () => new Set());
  const seen = [];
  const watch = (trickPlays) => {
    const led = trickPlays.length ? suitOf(trickPlays[0].code) : null;
    for (const play of trickPlays) {
      seen.push(play.code);
      if (led && suitOf(play.code) !== led) voids[play.seat].add(led);
    }
  };
  for (const t of done) watch(Array.isArray(t.plays) ? t.plays : []);
  watch(plays);
  // The turn-up is face up on the table and belongs to nobody. Counting it as
  // unknown would have the bot fearing a card it can see.
  if (pub.turnUpCard) seen.push(pub.turnUpCard);

  const unknown = unknownCards(hand, seen);
  // How many cards are still in somebody's hand, as against face down in the
  // stock. handCount is public — everyone can see how many cards you hold.
  const inPlay = pub.seats.reduce((n, s) => n + (s.seat === seat ? 0 : (s.handCount || 0)), 0);

  const order = seatsFrom(plays.length ? plays[0].seat : seat, players);
  const position = plays.length;
  const bid = Number.isInteger(priv.bid) ? priv.bid : 0;
  const left = Math.max(1, pub.roundSize - pub.trickIndex);

  return {
    seat,
    players,
    plays,
    // rawTrump goes to trick.js, which runs it through isTrumpSuit() itself so
    // that NO_TRUMP and not-yet-turned resolve identically to the engine's own
    // answer. `trump` is the suit or null, for this file's own arithmetic.
    rawTrump: pub.trump,
    trump: isTrumpSuit(pub.trump) ? pub.trump : null,
    led: ledSuitOf(plays),
    position,
    last: position === players - 1,
    toAct: order.slice(position + 1),
    handCount: pub.seats.map((s) => s.handCount || 0),
    hand,
    unknown,
    // Same one-pass table the bidder uses. Play asks "what still beats this"
    // on every candidate card of every decision, so the O(1) lookup matters
    // more here than it does at bid time.
    higher: higherIndex(unknown),
    pool: unknown.length,
    q: unknown.length ? clamp01(inPlay / unknown.length) : 0,
    voids,
    need: bid - (priv.tricks || 0),
    left,
    appetite: appetite(bid - (priv.tricks || 0), left),
  };
}

// ---------------------------------------------------------------------------
// The one question four different decisions ask
// ---------------------------------------------------------------------------

/**
 * How likely is this card to take a trick at some point, ignoring the trick
 * currently on the table?
 *
 * Call it the card's LIABILITY when ducking and its VALUE when chasing, but it
 * is one number and one function, and having it be one function is what keeps
 * the four decisions that use it consistent with each other:
 *
 *   duck + leading    play the card with the LOWEST value  (least likely to win)
 *   duck + discarding play the card with the HIGHEST value (shed the liability)
 *   want + discarding play the card with the LOWEST value  (keep the winners)
 *   lead evaluation   is this card a near-certain winner worth cashing?
 *
 * Note what this gets right that a bare rank comparison does not. Ducking with
 * the ace of a side suit while holding the two of trumps is correct in a trump
 * round — the ace can be ruffed away and the two of trumps cannot be ruffed at
 * all — and rank alone says the opposite.
 */
function winChance(code, view) {
  const above = higherOut(code, view.higher);
  const top = Math.pow(1 - view.q, above);
  if (!view.trump || suitOf(code) === view.trump) return clamp01(top);
  return clamp01(top * (1 - tableRuffRisk(suitOf(code), view, view.toAct.length
    ? view.toAct
    : allOtherSeats(view))));
}

function allOtherSeats(view) {
  const out = [];
  for (let s = 0; s < view.players; s++) if (s !== view.seat) out.push(s);
  return out;
}

/** The chance one of these seats ruffs a card of this suit. Unlike the bidding
 *  version this one KNOWS things: a seat that has already discarded on this
 *  suit is void in it for certain, not with probability. */
function tableRuffRisk(suit, view, seats) {
  if (!view.trump || !view.pool) return 0;
  const fSuit = countOf(view.unknown, suit) / view.pool;
  const fTrump = countOf(view.unknown, view.trump) / view.pool;
  let safe = 1;
  for (const s of seats) {
    const n = view.handCount[s] || 0;
    if (!n) continue;
    const pVoid = view.voids[s].has(suit) ? 1 : Math.pow(1 - fSuit, n);
    const pTrump = view.voids[s].has(view.trump) ? 0 : 1 - Math.pow(1 - fTrump, n);
    safe *= 1 - pVoid * pTrump;
  }
  return clamp01(1 - safe);
}

function countOf(codes, suit) {
  let n = 0;
  for (const c of codes) if (suitOf(c) === suit) n += 1;
  return n;
}

/** The unseen cards that would beat this one, given what was led. Everything
 *  else in the deck is irrelevant however high it is, which is what makes a
 *  discard a discard. */
function beatersOf(code, view) {
  const led = view.led || suitOf(code);
  const mine = suitOf(code);
  const v = rankValue(code);
  return view.unknown.filter((u) => {
    const us = suitOf(u);
    if (view.trump && us === view.trump) {
      // A trump beats anything that is not a higher trump.
      return mine !== view.trump || rankValue(u) > v;
    }
    return us === led && us === mine && rankValue(u) > v;
  });
}

/**
 * The chance a card that is currently winning survives the seats still to act.
 *
 * Judgement's undealt stock makes courtpiece's binary unbeatable() useless
 * here: with thirty-two cards unseen in a five-card round, almost nothing is
 * ever certainly safe, and a bot that demanded certainty would spend its ace
 * on every trick. So this returns a probability and the caller compares it to
 * SAFE_ENOUGH.
 *
 * Follow-suit is what makes it more than a card count: a seat that still holds
 * the led suit cannot ruff, however many trumps it has.
 */
function chanceHolds(code, view) {
  if (!view.toAct.length) return 1;
  const beaters = beatersOf(code, view);
  if (!beaters.length) return 1;
  const led = view.led || suitOf(code);
  const inSuit = countOf(beaters, led);
  const offSuit = beaters.length - inSuit;

  let safe = 1;
  for (const s of view.toAct) {
    const n = view.handCount[s] || 0;
    if (!n) continue;
    const pVoid = view.voids[s].has(led)
      ? 1
      : Math.pow(1 - countOf(view.unknown, led) / view.pool, n);
    // Following: only a higher card of the led suit can take it off us.
    // Void: only a trump can, and only if we are not a higher trump already.
    const pFollow = 1 - Math.pow(1 - inSuit / view.pool, n);
    const pRuff = 1 - Math.pow(1 - offSuit / view.pool, n);
    safe *= 1 - ((1 - pVoid) * pFollow + pVoid * pRuff);
  }
  return clamp01(safe);
}

/** Would this card be taking the trick if it were played right now? Asked of
 *  trick.js rather than reimplemented, so the bot's idea of who is winning and
 *  the engine's cannot come apart — including in a No Trump round, where a
 *  seat void in the led suit is told, correctly, that nothing it holds wins. */
function takesIt(code, view) {
  return wouldWin(view.plays, view.seat, code, view.rawTrump);
}

// ---------------------------------------------------------------------------
// Leading
// ---------------------------------------------------------------------------

function lead(view, legal) {
  // DUCKING ON LEAD is the hardest thing in this game and the thing a
  // more-is-better bot cannot do at all. You have to play a card, everybody
  // else plays after you, and you would rather not win. So: the card least
  // likely to take the trick — which is emphatically not the lowest card,
  // because the lowest card of a suit the table is void in is a trump magnet
  // and the lowest trump wins outright once the big ones have gone.
  if (view.appetite === 'duck') {
    return pick(legal, (code) => winChance(code, view), 'min');
  }

  const bySuit = groupBySuit(legal);

  // 1. Cash a certain winner while everybody still has to follow. Longest suit
  //    first: a boss card is worth most in the suit with the most cards behind
  //    it. `chanceHolds` against every seat, because on lead they all act.
  let boss = null;
  for (const suit of SUITS) {
    const cards = bySuit[suit];
    if (!cards.length) continue;
    if (winChance(cards[0], view) < SAFE_ENOUGH) continue;
    if (!boss || cards.length > boss.length) boss = { code: cards[0], length: cards.length };
  }
  if (boss) return boss.code;

  // 2. Draw trumps — but only when we hold more than our share and only when
  //    we are still chasing tricks. Every round of it costs us a trump too, so
  //    from a short holding it is the opposition's plan rather than ours.
  if (view.trump) {
    const trumps = bySuit[view.trump];
    const out = countOf(view.unknown, view.trump) > 0;
    if (out && trumps.length >= Math.ceil(view.left * DRAW_TRUMPS_SHARE)) return trumps[0];
  }

  // 3a. TRUMP ROUND: lead low from the shortest side suit. The standard trump
  //     opening, and it is playing for a void — two rounds of a doubleton and
  //     our trumps start taking tricks they could not otherwise take. The rank
  //     term stops it throwing a singleton ace under the table.
  if (view.trump) {
    let pickLow = null;
    let cost = Infinity;
    for (const suit of SUITS) {
      if (suit === view.trump) continue;
      const cards = bySuit[suit];
      if (!cards.length) continue;
      const low = cards[cards.length - 1];
      const c = cards.length * 10 + rankValue(low);
      if (c < cost) { cost = c; pickLow = low; }
    }
    if (pickLow) return pickLow;
    // Nothing but trumps left, so they are all going to be played anyway. Lead
    // the highest: it wins now, whereas the low ones may not win later.
    return bySuit[view.trump][0] || legal[0];
  }

  // 3b. NO TRUMP ROUND, AND THIS IS A DIFFERENT PLAN, NOT THE SAME ONE WITH A
  //     BRANCH MISSING. Making a void is worthless when there is nothing to
  //     ruff with — a void in No Trump does not win you a trick, it guarantees
  //     you cannot win that one. What takes tricks instead is LENGTH: lead
  //     your longest suit and keep leading it until everyone else has run out,
  //     at which point your small cards are winners. So lead low from the
  //     LONGEST suit, which is the opposite of 3a and deliberately so.
  let plan = null;
  let best = -Infinity;
  for (const suit of SUITS) {
    const cards = bySuit[suit];
    if (!cards.length) continue;
    const score = cards.length * 10 - rankValue(cards[cards.length - 1]);
    if (score > best) { best = score; plan = cards[cards.length - 1]; }
  }
  return plan || legal[0];
}

// ---------------------------------------------------------------------------
// Following
// ---------------------------------------------------------------------------

function follow(view, legal) {
  const winners = legal.filter((code) => takesIt(code, view));
  const losers = legal.filter((code) => !takesIt(code, view));

  if (view.appetite === 'duck') {
    // The single behaviour that separates a Judgement bot from a trick-taking
    // bot. Shed the biggest liability that does not win — in a trump round
    // that is often an ace of a side suit rather than the highest card in
    // hand, because an ace that can be ruffed is worth less to keep than a
    // small trump that cannot be.
    if (losers.length) return pick(losers, (code) => winChance(code, view), 'max');

    // Every legal card takes the trick, so we are taking it. POSITION decides
    // which one, and the two answers are opposites:
    //
    //   last to play  — the trick is certainly ours, so there is no escape and
    //                   the right move is to dump the biggest future liability
    //                   while it costs nothing extra.
    //   not last      — somebody behind us may yet take it off our hands, and
    //                   the lowest card is the one most likely to let them.
    return view.last
      ? pick(winners, (code) => winChance(code, view), 'max')
      : lowest(winners);
  }

  // Cannot win it: keep the cards that will win the ones we still need, and
  // throw the least valuable thing we hold.
  if (!winners.length) return pick(legal, (code) => winChance(code, view), 'min');

  const safe = winners.filter((code) => chanceHolds(code, view) >= SAFE_ENOUGH);

  if (view.appetite === 'must') {
    // Every remaining trick is needed, so there is no economy left to
    // practise. Take the cheapest card that looks safe; failing that, the
    // BIGGEST one there is, because losing this trick loses the round anyway.
    return safe.length ? lowest(safe) : highest(winners);
  }

  // 'want': slack in hand. Contest it cheaply and keep the rest back — and
  // when nothing is safe, still contest it. Conceding a trick we could have
  // taken is the more expensive habit across a whole round.
  return safe.length ? lowest(safe) : lowest(winners);
}

// ===========================================================================
//
//  WHAT A BOT DOES WITH A TURN, WHATEVER KIND OF TURN IT IS
//
// ===========================================================================

/**
 * The one intent this seat owes the table right now, or null if it owes none.
 *
 * Two phases can be waiting on a seat — BIDDING and PLAY — and the private
 * view already says which, through bidOptions being an array rather than null,
 * so the driver does not have to branch on the phase a second time.
 */
export function chooseIntent(pub, priv) {
  if (!pub || !priv || !priv.isTurn) return null;
  if (Array.isArray(priv.bidOptions)) {
    return { type: 'placeBid', bid: chooseBid(priv.hand, bidContext(pub, priv)) };
  }
  return chooseCard(pub, priv);
}

/** How long a bot appears to think. Long enough that the table sees whose turn
 *  it was and what they played before the next card lands; short enough not to
 *  drag across seventeen tricks. The same number sequence and courtpiece use,
 *  because it is the same judgement about the same kind of table. */
export const BOT_THINK_MS = 1500;

/**
 * How long the table waits for an ABSENT human before a bot plays their card.
 *
 * Judgement has no pass, no skip and no turn timer, and a round cannot proceed
 * past a seat that will not act. A nineteen-round match will outlast somebody's
 * battery — that is stated in the brief as a certainty, not a risk — so a
 * player whose phone locks does not slow the table, they stop it permanently
 * for the other six.
 *
 * Ten seconds is this project's standing budget for deciding anything on a
 * network is dead, and the two reasons for it happen to agree here. It is long
 * enough that a 4G handover or a screen lock is invisible, and short enough
 * that the rest of the table does not sit staring at a game that has visibly
 * stopped, which is the moment people quit.
 *
 * The seat is COVERED, never converted. `isBot` stays false, the seat keeps
 * its clientId, the scoreboard keeps showing the player as offline, and the
 * instant they reconnect they take the next turn themselves.
 */
export const OFFLINE_GRACE_MS = 10000;

/** Should the driver move for this seat?
 *
 *  Two quite different situations with one answer. A bot has nobody behind it;
 *  an offline human has somebody behind it who is not there. Either way the
 *  table is waiting on a seat that cannot act for itself, and the alternative
 *  to acting is a dead game. */
function coverage(seat) {
  if (!seat) return null;
  if (seat.isBot) return 'bot';
  if (!seat.connected) return 'offline';
  return null;
}

/** Whose move the table is waiting for, across both phases that can wait on
 *  one.
 *
 *  The sweepAt test is politeness, NOT correctness, and it is worth being
 *  precise about which: during the pause after a trick lands, turnSeat still
 *  names the winner of the trick just taken. Deleting this clause and asking
 *  the engine for a card anyway was measured over 297 sweep pauses and the
 *  engine refused all 297 — host authority is what actually stops a card
 *  landing before the table has seen who won, exactly as it stops a peer
 *  doing the same thing. What the clause buys is that the driver does not
 *  spend every pause making a move it will be told off for and logging a
 *  warning about it. Keep it; just do not mistake it for the safeguard. */
function waitingOn(engine) {
  if (engine.phase === PHASES.BIDDING) return engine.seats[engine.turnSeat] || null;
  if (engine.phase === PHASES.PLAY && engine.sweepAt === null) {
    return engine.seats[engine.turnSeat] || null;
  }
  return null;
}

/**
 * A stateful ticker, one per game.
 *
 * Driven from the loop whoever owns the engine already runs for tick() —
 * js/main.js today, a server later — rather than from a timer of its own.
 * Nothing new starts ticking to add bots, and the engine stays free of clocks.
 *
 * The state it holds is only "which turn am I waiting on, and until when". It
 * is never serialised: a host reload rebuilds it from the engine's own turn,
 * so the worst a crash mid-pause costs is that a bot thinks for a second and a
 * half again.
 *
 * DELIBERATELY DOES NOT ADVANCE THE ROUND. nextRound() is owner-gated in
 * js/state.js and the owner is always a human (_promoteOwner skips bots), so
 * ROUND_OVER waits for a person to look at the scoreboard and press on. An
 * all-bot table therefore needs its rounds advanced by whoever owns the
 * engine, which is what scripts/test-engine.mjs does and what a headless
 * server would have to do too. Flagged rather than quietly automated: "the
 * scoreboard advances on its own" is a product decision, not a bot one.
 */
export function createBotDriver({ thinkMs = BOT_THINK_MS, offlineMs = OFFLINE_GRACE_MS } = {}) {
  let pending = null;

  return {
    /** @returns true if the engine changed and the caller should broadcast. */
    tick(engine, now = Date.now()) {
      const player = engine ? waitingOn(engine) : null;
      const cover = coverage(player);
      if (!cover) { pending = null; return false; }

      // The key has to change on every distinct action a seat could take, or
      // the second one is mistaken for the first and never happens. Phase,
      // then the exact position in the match: which round, how many tricks are
      // complete, how many cards are on the table, and how many bids are in.
      //
      // The bid count is REDUNDANT and is kept deliberately. player.id is
      // already in the key and no seat bids twice in one round, so dropping
      // the count changes no behaviour — that was mutated and the suite
      // stayed green, which is the correct result rather than a gap. It stays
      // because it is the one term that would still separate two bidding
      // turns if the seat identity ever stopped being unique per turn, and
      // the cost of carrying it is one array filter per tick.
      //
      // `cover` is in it too, so a human who drops mid-pause restarts the
      // clock on the longer budget instead of inheriting a bot's second and a
      // half.
      const key = [
        engine.phase, player.id, cover, engine.roundIndex, engine.trickIndex,
        engine.plays.length, engine.bids.filter((b) => b !== null).length,
      ].join(':');

      const wait = cover === 'offline' ? offlineMs : thinkMs;
      if (!pending || pending.key !== key) pending = { key, dueAt: now + wait, acted: false };
      if (pending.acted || now < pending.dueAt) return false;

      // Set before acting, not after. Whatever happens below — a refusal, a
      // throw — this step gets exactly one attempt, so a seat that cannot be
      // satisfied costs one tick rather than spinning forever.
      pending.acted = true;
      return act(engine, player, now);
    },

    /** Forget the pause in progress. For a host that has just taken over an
     *  engine, where "waiting since" means nothing. */
    reset() { pending = null; },
  };
}

function act(engine, player, now) {
  const priv = engine.privateStateFor(player.id);
  let intent = null;
  try {
    intent = chooseIntent(engine.publicState(), priv);
  } catch (err) {
    // A throw in here is a bug in the ranking, and the right response is still
    // to get the turn moving — a table stuck behind a bot is a dead game,
    // whereas a bad card is something somebody can play on from.
    console.warn('[bot] chooseIntent threw', err);
  }

  if (intent) {
    const { result } = applyGameIntent(engine, player.id, intent, now);
    if (result && result.ok) return true;
    console.warn('[bot] move refused:', result && result.error, intent);
  }

  // Last resort, and it should be unreachable: chooseCard only ever returns a
  // card the engine itself marked legal, and chooseBid only ever a bid the
  // engine itself offered. It exists because this game has no skip and no
  // pass, so the alternative to a bad move is no move at all — and no move at
  // all stops the table permanently.
  const fallback = panic(priv);
  if (!fallback) return false;
  const { result } = applyGameIntent(engine, player.id, fallback, now);
  return !!(result && result.ok);
}

function panic(priv) {
  if (!priv) return null;
  if (Array.isArray(priv.bidOptions)) {
    const option = priv.bidOptions.find((o) => o && o.legal);
    return option ? { type: 'placeBid', bid: option.bid } : null;
  }
  const card = Array.isArray(priv.hand) ? priv.hand.find((c) => c && c.legal) : null;
  return card ? { type: 'playCard', code: card.code } : null;
}
