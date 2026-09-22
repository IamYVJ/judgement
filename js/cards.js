// ============================================================================
// cards.js — The deck, the shuffle, and how a Judgement hand is dealt out.
//
// THE HAND SIZE IS DIFFERENT EVERY ROUND. That is the whole structure of the
// game — a ladder from ten cards down to one, or up, or down and back up — so
// nothing here may assume a fixed hand, a fixed player count, or that the deal
// consumes the deck. Most rounds leave a large stock face down and untouched,
// and that is normal rather than a leftover.
//
// Every function here is pure except shuffle(), which reads the platform CSPRNG
// through the same crypto.getRandomValues indirection sequence uses, so the
// headless harness can swap in a seeded stream and reproduce a failing deal.
//
// Imports only rules.js and trick.js, neither of which touches the DOM.
// ============================================================================

import { SUITS, RANKS, DECK_SIZE, suitOf, rankValue, maxHandSize } from './rules.js';
import { nextSeat, seatsFrom } from './trick.js';

/** A fresh, ordered 52-card deck. One deck, so a code is unique and is also the
 *  card's identity — see the note on codes in rules.js. */
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

/** Fisher-Yates, returning a new array. */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Read at call time, not captured at module load, so a test can replace
// globalThis.crypto before constructing anything and still be obeyed.
function randomBelow(n) {
  try {
    const source = typeof crypto !== 'undefined' ? crypto : globalThis.crypto;
    if (source && source.getRandomValues) {
      const buf = new Uint32Array(1);
      source.getRandomValues(buf);
      return buf[0] % n;
    }
  } catch (_) { /* fall through */ }
  return Math.floor(Math.random() * n);
}

/** One empty hand per seat. */
export function emptyHands(players) {
  return Array.from({ length: players }, () => []);
}

/**
 * Deal a round.
 *
 * ONE CARD AT A TIME, ROUND THE TABLE, CLOCKWISE, starting to the dealer's
 * left and ending on the dealer. Against a shuffled deck that is statistically
 * identical to handing each player a block, and it is written the slow way for
 * two reasons: it is how the game is actually dealt, and against an UNSHUFFLED
 * deck the two produce different hands — so scripts/test-engine.mjs can deal a
 * known deck and read the turn direction straight out of the result. That is a
 * second, independent pin on the clockwise rule, in the place a copied helper
 * from courtpiece would do its damage.
 *
 * `turnUp` is the trump method that flips the next card off the stock once
 * everyone has their hand. The flipped card comes off the TOP OF WHAT REMAINS,
 * not out of anybody's hand, and it is returned separately rather than mixed
 * into the result — js/state.js must be able to hold it back from the public
 * state until the reveal, and a caller that has to remember to filter it is a
 * caller that will eventually forget.
 *
 * Throws if the deck is short rather than dealing a quiet short hand. A player
 * holding six cards in a seven-card round would not surface until the last
 * trick of the round, by which time the bids are long since in.
 */
export function deal(deck, { players, handSize, dealerSeat, turnUp = false }) {
  const needed = players * handSize + (turnUp ? 1 : 0);
  if (deck.length < needed) {
    throw new Error(
      `deal: ${players} players x ${handSize} cards${turnUp ? ' + turn-up' : ''} needs ${needed}, `
      + `deck has ${deck.length}. Cap the round at ${maxHandSize(players, turnUp)}.`,
    );
  }

  const stock = deck.slice();
  const hands = emptyHands(players);
  const order = seatsFrom(nextSeat(dealerSeat, players), players);

  for (let i = 0; i < handSize; i++) {
    for (const seat of order) hands[seat].push(stock.shift());
  }

  return { hands, turnUpCard: turnUp ? stock.shift() : null, stock };
}

// ---------------------------------------------------------------------------
// Sorting a hand for display
// ---------------------------------------------------------------------------

// Black, red, black, red. Adjacent suits differ in colour, which is what stops
// a fan of ten cards reading as one undifferentiated block on a phone.
//
// DELIBERATELY NOT `SUITS`, even though the Kachuful rotation happens to
// alternate colour too. That coincidence is not a rule, and pointing the fan at
// the trump rotation would mean reordering everybody's hand the day somebody
// changed the rotation.
const DISPLAY_ORDER = Object.freeze(['S', 'H', 'C', 'D']);

/**
 * Group by suit, ranks descending within a suit.
 *
 * The trump suit is pulled to the front, because the one question you ask of
 * your own hand most often is "how many trumps have I left" — and in Judgement
 * that question is really "can I still make my bid", which is the only question
 * there is. In a No Trump round `trumpSuit` is the NO_TRUMP sentinel, which is
 * not in DISPLAY_ORDER, so the fan falls back to plain colour alternation. That
 * is the right answer rather than a fallback: there is no suit to promote.
 *
 * Pulling trump to the front can break the colour alternation. That is the
 * lesser cost: a misread suit is recoverable, a miscounted trump is not.
 */
export function sortHand(hand, trumpSuit = null) {
  const order = trumpSuit && DISPLAY_ORDER.includes(trumpSuit)
    ? [trumpSuit, ...DISPLAY_ORDER.filter((s) => s !== trumpSuit)]
    : DISPLAY_ORDER;
  return hand.slice().sort((a, b) => {
    const suitDiff = order.indexOf(suitOf(a)) - order.indexOf(suitOf(b));
    if (suitDiff !== 0) return suitDiff;
    return rankValue(b) - rankValue(a);
  });
}

/** How many of each suit a hand holds. The bot's whole bid estimate, and its
 *  void tracking, are both counting exercises over this. */
export function suitCounts(hand) {
  const counts = { S: 0, H: 0, D: 0, C: 0 };
  for (const code of hand) counts[suitOf(code)] += 1;
  return counts;
}

// A deck that is not 52 cards would break every hand-size cap in rules.js, and
// the symptom — a round that throws only at seven players — would surface a
// long way from the cause. Cheap to check once at module load, and it runs in
// the browser and in `node` alike.
if (SUITS.length * RANKS.length !== DECK_SIZE) {
  throw new Error('SUITS x RANKS must equal DECK_SIZE');
}
