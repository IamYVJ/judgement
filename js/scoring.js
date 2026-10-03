// ============================================================================
// scoring.js — The four scoring formulas, and nothing else.
//
// PURE. One function per mode, no state, no config object, no engine. Every
// round is scored through the same three facts: what a player bid, what they
// actually took, and how big the round was.
//
// WHY FOUR FORMULAS AND NOT ONE. They are not four ways of counting the same
// game. Each one changes what a good bid IS, and that is the whole reason the
// host gets to choose:
//
//   kachuful   10 x bid, nothing for a miss. MISSING IS FREE — bidding four
//              and taking three costs exactly what bidding three and taking
//              two does — so the optimistic bid is the correct one and the
//              table plays loose.
//   standard   10 + bid, nothing for a miss. The curve is almost flat: 10 to
//              20 across a whole ten-card round. Ambition buys you almost
//              nothing, accuracy buys you everything, so the right bid is
//              simply the likely one.
//   square     10 + bid squared, and a miss COSTS you. A round can take points
//              away, so the cautious bid is sometimes the highest-scoring bid
//              on the table.
//   puresquare bid squared and NOTHING ELSE, with the same cost for a miss.
//              The flat ten is what made being right worth something under
//              `square`; without it a made one scores a single point, and the
//              prize for a bid is exactly the size of the penalty for missing
//              it by that much. A made zero cannot be zero squared, so it pays
//              by the size of the round, as it does in kachuful.
//
// THE BOT MUST NOT RE-STATE ANY OF THAT AS A TABLE OF ITS OWN. It can ask what
// a bid is worth by scoring the hypothetical — scoreRound(mode, b, b, size) is
// the reward for making b, scoreRound(mode, b, actual, size) the cost of
// missing it — which keeps one source of truth. That sentence used to end "and
// means a fourth mode would need no bot change at all", as a prediction. The
// fourth mode is the last one in the list above, and it needed none. See
// chooseBid() in js/bot.js.
//
// Imports nothing, from anywhere.
// ============================================================================

/**
 * The modes, in the order the lobby offers them.
 *
 * Kachuful leads because it is the game this repo is named for. These strings
 * go on the wire inside the host's config, so they are checked against this
 * list by normalizeConfig() in js/rules.js before they ever reach scoreRound()
 * — which is why scoreRound() is entitled to throw on anything else.
 */
export const SCORING_MODES = Object.freeze(['kachuful', 'standard', 'square', 'puresquare']);

// ---------------------------------------------------------------------------
// The formulas
//
// All four take the SAME three arguments even though two of them ignore
// `roundSize`. A uniform signature is what lets the dispatcher below be a table
// lookup rather than a switch, and it meant that adding a second mode which
// does care about the round size changed nothing at any call site.
// ---------------------------------------------------------------------------

/**
 * Kachuful: ten times your bid, or nothing.
 *
 * THE ZERO BID IS THE WHOLE MODE. Ten times zero is zero, so under the plain
 * formula a made zero-bid would be worth precisely nothing and no one would
 * ever make one — which would delete the most interesting decision in the
 * game, because choosing to take no tricks at all with a bad hand is a real
 * and difficult thing to pull off.
 *
 * So a made zero pays five times the round size, and paying by ROUND SIZE
 * rather than a flat number is the point: ducking every trick in a ten-card
 * round is far harder than in a one-card round, and the reward scales with the
 * difficulty. That gives the zero bid a character no other bid has — worth
 * less than anything in a small round, and worth more than any bid below half
 * the round size in a big one. In a ten-card round a made zero scores 50,
 * which beats a made bid of four and ties a made bid of five.
 *
 * A missed bid scores nothing, including a missed zero. There is no penalty in
 * this mode at all, which is what makes it the loose one.
 */
export function scoreKachuful(bid, actual, roundSize) {
  if (actual !== bid) return 0;
  return bid === 0 ? 5 * roundSize : 10 * bid;
}

/**
 * Standard Oh Hell: ten for making it, plus one per trick bid.
 *
 * The flattest of the three. A made zero is worth 10 and a made ten is worth
 * 20, so across a whole round the entire spread of ambition is worth half of
 * what simply being right is worth. That is deliberate in the original game:
 * it makes the bid a prediction rather than a wager.
 *
 * `roundSize` is unused and still in the signature — see the note above.
 */
export function scoreStandard(bid, actual, roundSize) {
  if (actual !== bid) return 0;
  return 10 + bid;
}

/**
 * Square: ten plus your bid squared, and the square of your error against you.
 *
 * IT GOES NEGATIVE, and it does so readily — a player who misses by three in a
 * single round is nine points down, which is most of a made small bid.
 * Running totals below zero are normal here rather than a corner case, and
 * js/ui.js's scoreboard is built for them: see the column sizing note there.
 * (It was the only mode that could, until scorePureSquare below.)
 *
 * The penalty is symmetric because the square is. Overshooting by two and
 * undershooting by two both cost four, and that symmetry is what forces the
 * ducking behaviour the whole game turns on — once you have made your bid,
 * every further trick is as expensive as a trick you failed to take.
 *
 * `roundSize` is unused and still in the signature — see the note above.
 */
export function scoreSquare(bid, actual, roundSize) {
  if (actual === bid) return 10 + bid * bid;
  const miss = actual - bid;
  return -(miss * miss);
}

/**
 * Pure square: your bid squared and nothing else, and the square of your error
 * against you.
 *
 * SQUARE WITH THE TEN TAKEN OUT, and the ten was doing more than it looks
 * like. Under `square` every made bid is worth at least ten, so simply being
 * RIGHT is most of the reward and the square is a bonus on top of it. Here the
 * square is the whole reward: a made one scores 1, a made two 4, a made five
 * 25. Small bids are worth almost nothing, and the two sides of the ledger are
 * the same curve — bid three and it is +9 for making it, and −9 for being
 * three out. Nothing cushions either.
 *
 * THE ZERO BID NEEDS A RULE OF ITS OWN, for exactly kachuful's reason. Zero
 * squared is zero, so under the plain formula the hardest bid in the game
 * would pay nothing for being made and still cost the full square for being
 * missed — a bid nobody could ever justify, in a mode where ducking matters
 * as much as it does anywhere. So a made zero pays twice the ROUND SIZE, and
 * by round size for the reason given at scoreKachuful: taking no tricks out of
 * ten is a different feat from taking none out of one. In a ten-card round
 * that is 20, which sits between a made four (16) and a made five (25).
 *
 * A MISSED zero is a miss like any other: the square of what was taken.
 *
 * The penalty is scoreSquare's, deliberately to the digit — same sign, same
 * symmetry, same ducking pressure once a bid is made. The suite compares the
 * two formulas over every miss there is rather than trusting this sentence.
 */
export function scorePureSquare(bid, actual, roundSize) {
  if (actual !== bid) {
    const miss = actual - bid;
    return -(miss * miss);
  }
  return bid === 0 ? 2 * roundSize : bid * bid;
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

// Null-prototype, so the lookup below cannot find 'toString' or 'valueOf' and
// call an inherited method as if it were a scoring formula. A plain object
// literal here returns a function for those two keys, sails past the guard, and
// scores the round as "[object Undefined]".
const FORMULAS = Object.freeze(Object.assign(Object.create(null), {
  kachuful: scoreKachuful,
  standard: scoreStandard,
  square: scoreSquare,
  puresquare: scorePureSquare,
}));

/**
 * Score one player's round.
 *
 * Throws on an unrecognised mode rather than returning zero. A silent zero
 * would score an entire match wrong while looking like a run of very bad
 * bidding, and nothing would ever surface it. The mode reaching here has
 * already been through normalizeConfig()'s allow-list in js/rules.js, so a
 * throw means a programming error and not a hostile peer.
 */
export function scoreRound(mode, bid, actual, roundSize) {
  const formula = FORMULAS[mode];
  if (!formula) throw new Error(`scoreRound: unknown scoring mode ${JSON.stringify(mode)}`);
  return formula(bid, actual, roundSize);
}
