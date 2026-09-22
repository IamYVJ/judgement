// ============================================================================
// trick.js — Turn order, follow-suit legality, and who won the trick.
//
// ############################################################################
// #  JUDGEMENT RUNS CLOCKWISE.  nextSeat() IS +1.                            #
// #  courtpiece RUNS ANTICLOCKWISE AND ITS nextSeat() IS -1. DO NOT COPY      #
// #  A TURN-ORDER HELPER BETWEEN THE TWO REPOS WITHOUT READING THIS BOX.      #
// ############################################################################
//
// The two games are close enough that sharing code between them is tempting,
// and this is the one place where doing it silently produces a game that still
// runs, still finishes, and is wrong in every trick. So the direction is not a
// sign buried in an expression — it is a named constant, passed as an argument
// to one piece of arithmetic, with a test pinned to both values.
//
// THE GEOMETRY, once, so nothing below has to re-derive it.
//
// Picture the table from above, everyone facing the centre. Seats 0..n-1 are
// numbered CLOCKWISE — the direction you read positions off a clock face. A
// player facing inward has the clockwise direction on their LEFT. So:
//
//     next in turn order  ==  the player to your left  ==  seat + 1 (mod n)
//
// Two rules lean on that directly:
//
//   * "Bidding starts left of the dealer and goes clockwise; the dealer bids
//     last." First bidder is nextSeat(dealer), and the dealer is therefore the
//     n-th and final bid — which is what makes the hook (see js/state.js) land
//     on the dealer and nobody else.
//
//   * "Deal to the left of the dealer first, dealer last." Same helper, same
//     direction, and the same reason the dealer sees their hand last.
//
// The alternative — numbering seats in turn order so the helper is trivially
// "correct" — was rejected on purpose. It hides the handedness in the renderer,
// which is exactly where nobody would think to test it. Here there is one
// arithmetic expression, in one function, and scripts/test-engine.mjs walks a
// full table in both directions and asserts they disagree.
//
// The renderer owes the other half of this: with seats numbered clockwise and
// the local player drawn at the bottom, seat offsets 0,1,2,… from the viewer
// must be laid out CLOCKWISE on screen, so play visibly sweeps to the left and
// round the top. Unlike courtpiece there are no four fixed slots — 3 to 7 seats
// sit on an arc — but the ordering rule is the same one.
//
// Imports only rules.js, which imports nothing. Node-safe and DOM-free.
// ============================================================================

import { rankValue, suitOf, suitName, isTrumpSuit } from './rules.js';

// ---------------------------------------------------------------------------
// Turn order
// ---------------------------------------------------------------------------

/** Seat numbers ascend clockwise, so +1 is clockwise and -1 is anticlockwise. */
export const CLOCKWISE = 1;
export const ANTICLOCKWISE = -1;

/** Judgement's direction. The single place the choice is recorded. */
export const TABLE_DIRECTION = CLOCKWISE;

/**
 * One seat along, in whichever direction you ask for.
 *
 * `direction` is REQUIRED and has no default. That is the whole point of this
 * function existing separately from nextSeat(): a default would let a call
 * copied in from a repo that turns the other way keep compiling and quietly
 * take Judgement's answer instead of its own.
 */
export function stepSeat(seat, seatCount, direction) {
  if (direction !== CLOCKWISE && direction !== ANTICLOCKWISE) {
    throw new Error(`stepSeat: direction must be CLOCKWISE or ANTICLOCKWISE, got ${direction}`);
  }
  return (seat + direction + seatCount) % seatCount;
}

/** The next player to act: clockwise, i.e. to the current player's left. */
export function nextSeat(seat, seatCount) {
  return stepSeat(seat, seatCount, TABLE_DIRECTION);
}

/** The player who acted before this one — anticlockwise, to their right. */
export function prevSeat(seat, seatCount) {
  return stepSeat(seat, seatCount, -TABLE_DIRECTION);
}

/**
 * Every seat in play order, starting at `startSeat`.
 *
 * Used for three different orderings that are all the same ordering: who
 * receives each card as it is dealt, who bids in what order, and who plays to
 * a trick. Having one function rather than three loops is what makes the
 * direction testable in one place.
 */
export function seatsFrom(startSeat, seatCount) {
  const order = [];
  let s = startSeat;
  for (let i = 0; i < seatCount; i++) { order.push(s); s = nextSeat(s, seatCount); }
  return order;
}

// ---------------------------------------------------------------------------
// Follow-suit legality
// ---------------------------------------------------------------------------

/**
 * The cards in `hand` that may legally be played, given the suit led.
 *
 * Two rules, and the second is the one people get wrong:
 *
 *   1. Follow the suit led if you hold it.
 *   2. If you do not hold it, you may play ANY card. There is no obligation to
 *      trump. A player with trumps and no card of the led suit is free to
 *      discard from a third suit instead — and in Judgement, unlike in a game
 *      where more tricks is always better, a player who has already made their
 *      bid will often WANT to.
 *
 * `ledSuit` is null when this player is leading, in which case everything is
 * legal. Nothing here consults the trump suit at all: trump changes which card
 * WINS, never which card may be played.
 *
 * Returns a NEW array — never the caller's hand, even in the everything-legal
 * case, so a caller that sorts the result cannot reorder somebody's hand.
 */
export function legalPlays(hand, ledSuit) {
  if (!ledSuit) return hand.slice();
  const following = hand.filter((code) => suitOf(code) === ledSuit);
  return following.length ? following : hand.slice();
}

/** Whether one specific card may be played. The host's enforcement point; the
 *  UI's greying-out is a convenience that mirrors it, never a substitute. */
export function canPlay(hand, code, ledSuit) {
  if (!hand.includes(code)) return false;
  if (!ledSuit) return true;
  if (suitOf(code) === ledSuit) return true;
  // Holding the led suit and playing something else is the one illegal move.
  return !hand.some((c) => suitOf(c) === ledSuit);
}

/** Why a card cannot be played, phrased for an aria-label. Null when it can.
 *  Spelled out, not the one-letter suit code: this string is read aloud, and a
 *  screen reader says "must follow dee". */
export function illegalReason(hand, code, ledSuit) {
  if (canPlay(hand, code, ledSuit)) return null;
  if (!hand.includes(code)) return 'not in your hand';
  return `cannot play, must follow ${suitName(ledSuit)}`;
}

// ---------------------------------------------------------------------------
// Resolving a trick
// ---------------------------------------------------------------------------

/** The suit that was led — the suit of the first card played, always. */
export function ledSuitOf(plays) {
  return plays && plays.length ? suitOf(plays[0].code) : null;
}

/**
 * Which seat took the trick.
 *
 * `plays` is [{ seat, code }] in the order the cards hit the table, first entry
 * being the lead. It may be shorter than the table — a part-played trick has a
 * leader too, and the UI and the bot both ask who it is.
 *
 * Highest trump wins. If nobody trumped, the highest card of the suit led wins.
 * Cards of any other suit cannot win regardless of rank, which is what makes a
 * discard a discard.
 *
 * THE NO-TRUMP PATH IS THIS FUNCTION'S SECOND HALF, not a special case bolted
 * on. `trump` is run through isTrumpSuit() rather than compared to a suit, so
 * NO_TRUMP and a not-yet-turned null both land on "nothing trumps, highest of
 * the led suit takes it" — and in a No Trump round a player who is void in the
 * led suit cannot win the trick at all, whatever they discard. That is the
 * rule, and it falls out of the code rather than being asserted by it.
 */
export function trickWinner(plays, trump) {
  if (!plays || !plays.length) return null;

  const led = ledSuitOf(plays);
  const trumpSuit = isTrumpSuit(trump) ? trump : null;
  const trumped = trumpSuit !== null && plays.some((p) => suitOf(p.code) === trumpSuit);
  // Once anyone has trumped, the led suit stops mattering entirely — a contest
  // between trumps is the only contest left.
  const suitThatWins = trumped ? trumpSuit : led;

  let best = null;
  for (const play of plays) {
    if (suitOf(play.code) !== suitThatWins) continue;
    if (!best || rankValue(play.code) > rankValue(best.code)) best = play;
  }
  return best ? best.seat : null;
}

/** The card currently beating the others, or null on an empty trick. Behind
 *  "you would need to beat the King of hearts" in the UI. */
export function winningCard(plays, trump) {
  const seat = trickWinner(plays, trump);
  if (seat === null) return null;
  const play = plays.find((p) => p.seat === seat);
  return play ? play.code : null;
}

/**
 * Would playing `code` into this part-played trick take the lead right now?
 *
 * The bot's central question in both directions — it needs to win tricks while
 * under its bid and to DUCK once it has made it, and ducking is not "play your
 * lowest card", it is "play the highest card that does not win". Answering it
 * here rather than in js/bot.js keeps one copy of the trump comparison; two
 * copies would be two chances to get the No Trump branch wrong.
 *
 * Says nothing about players still to come. A card that takes the lead fourth
 * of seven can still be beaten, and the bot treats this as the estimate it is.
 */
export function wouldWin(plays, seat, code, trump) {
  const after = (plays || []).concat([{ seat, code }]);
  return trickWinner(after, trump) === seat;
}
