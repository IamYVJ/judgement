// ============================================================================
//
//  js/state.js — the game engine
//
//  One object holds the whole match. The host's tab owns it, every intent is
//  applied here, and every other tab sees only what publicState() and
//  privateStateFor() choose to hand out.
//
//  THREE RULES SHAPE EVERYTHING BELOW.
//
//  1. THE ENGINE IS THE ENFORCEMENT POINT. Follow-suit legality, bid legality,
//     whose turn it is, who may start a match — all decided here, on the host,
//     against the host's own copy of the hand. The client greys out an illegal
//     card as a courtesy to the person holding the phone. It is never the
//     thing that stops the card being played. A client is never trusted about
//     what is in its hand, and js/guards.js will not even let a malformed
//     message reach these methods.
//
//  2. NOTHING MUTATES ON A REJECTED ACTION. Every action returns { ok: true }
//     or { ok: false, error }, and the failing path touches no field. Half of
//     a rejected play landing is worse than the play landing: the table can
//     see a bad move and undo it, but nobody can see a hand that quietly lost
//     a card. Every early return in this file is before the first write.
//
//  3. TIME IS A PARAMETER. There is not one timer in here. `now` arrives from
//     the caller and tick(now) is what advances a transient display phase, so
//     scripts/test-engine.mjs can play nineteen rounds in a millisecond and a
//     replay from a snapshot lands on exactly the state it left.
//
//  isHost vs isOwner — kept apart from the first line, because the brief says
//  retrofitting the split cost the sibling repo real rework:
//
//    isOwner  a PLAYER who controls the lobby: config, bots, starting, moving
//             the match on from ROUND_OVER. It lives in this file, on a seat,
//             and it survives a reconnect through clientId.
//    isHost   a TAB that happens to be running this engine. NOT IN THIS FILE.
//             js/net.js knows which tab that is. The day a server runs the
//             engine, isHost moves to the server and isOwner does not move at
//             all — which is the whole point of separating them.
//
// ============================================================================

import {
  MIN_PLAYERS, MAX_PLAYERS, NO_TRUMP,
  cleanName, normalizeConfig, DEFAULT_CONFIG,
  roundPlan, effectiveMaxHand, matchShape,
  trumpForRound, needsTurnUp,
  legalBids, bidIsLegal, illegalBidReason, forbiddenBid,
  suitOf, suitName, trumpName, cardName,
} from './rules.js';
import {
  nextSeat, seatsFrom, legalPlays, canPlay, illegalReason,
  ledSuitOf, trickWinner, winningCard,
} from './trick.js';
import { buildDeck, shuffle, deal, sortHand } from './cards.js';
import { scoreRound } from './scoring.js';

// ---------------------------------------------------------------------------
// Phases
//
// Exactly the ladder the brief draws, no more:
//
//   LOBBY -> ROUND_DEAL -> TRUMP_REVEAL* -> BIDDING -> PLAY -> ROUND_OVER
//                          (*turn-up only)              ^          |
//                                                       +----------+
//                                            (next round, until the plan ends)
//                                                                  |
//                                                            MATCH_OVER
//
// Note what is NOT here: a phase for "the trick is finished, look at it before
// I sweep it". That pause is real and the table needs it, but making it a
// phase would put a fourth state between PLAY and PLAY that every consumer —
// ui.js, bot.js, guards.js — would have to learn about and handle. It is a
// timestamp instead (`sweepAt`), the phase stays PLAY, and the only code that
// cares is tick(). See _finishTrick().
//
// Values are camelCase strings rather than the key names because they are
// compared in js/ui.js against data-attributes, and a data-phase="ROUND_DEAL"
// reads as shouting in the DOM inspector.
// ---------------------------------------------------------------------------

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  ROUND_DEAL: 'roundDeal',
  TRUMP_REVEAL: 'trumpReveal',
  BIDDING: 'bidding',
  PLAY: 'play',
  ROUND_OVER: 'roundOver',
  MATCH_OVER: 'matchOver',
});

// How long the transient phases hold. Display timings, not rules — the engine
// works the same at zero, and the tests run at zero.
//
// The reveal is the long one on purpose. Under the turn-up method that flipped
// card is the single most consequential thing anybody will see all round, and
// it decides every bid that follows; a card that appears and is gone before
// the slowest player has looked up is a card that will be argued about.
export const DEAL_PAUSE_MS = 700;
export const REVEAL_PAUSE_MS = 2200;
export const TRICK_PAUSE_MS = 1400;

// The log is a rolling window shown in the UI and pushed to every peer on
// every state send. Uncapped it grows without bound across a 19-round match —
// about 800 lines at seven players — and every one of them would be on the
// wire every time anybody played a card.
const LOG_CAP = 60;

/**
 * Seal a completed round record: copied and frozen all the way down, so that
 * nothing reachable through it is either shared with the caller or writable.
 *
 * THE ONLY PLACE A ROUND RECORD IS SEALED. Both paths come here — _endRound()
 * when a round finishes, restore() when a snapshot is adopted — and that is
 * the point rather than a convenience. Sealing used to be written twice: a
 * hand-listed `Object.freeze` per field where records are born, and this
 * generic pass where they are restored. Two implementations of one invariant
 * agree until they do not, and the way they stop agreeing is a field added in
 * one place and not the other — after which a fresh engine and a restored
 * engine hand out records with different guarantees, from the same match.
 *
 * WHY IT TAKES NO LIST OF FIELDS. The obvious version names bids, tricks,
 * deltas and totals, and the obvious version is wrong the first time a fifth
 * field is added — because fields are added where records are BUILT and not
 * where they are sealed, and a record that is frozen except for one live array
 * is the exact bug this function exists to close. A rule cannot be left out of
 * date; a list can.
 *
 * WHY IT RECURSES. Object.freeze is shallow and so was this: it reached one
 * level, which covered every field a record has ever had, because every one of
 * them is an array of numbers. "Every field it has today" is a property of the
 * records, not of this function — the same thing that was wrong about
 * restore() adopting the caller's arrays. A record that grew a nested object
 * would be sealed at the top, handed out through publicState(), and quietly
 * writable one dot further in. Going all the way down costs a few hundred
 * bytes a match and removes the question.
 *
 * Only arrays and plain objects are descended into. Anything else is passed
 * through untouched, which is conservative and also a non-case: a round record
 * is JSON by construction — it goes on the wire and into localStorage — so it
 * has no class instances and, importantly for the recursion, no cycles.
 *
 * It COPIES rather than freezing in place, because freezing an object handed
 * in by a caller mutates something that is not ours — restore() is given a
 * snapshot the caller may still be holding, and turning it read-only under
 * them is a surprise with no upside.
 */
function freezeRound(v) {
  if (Array.isArray(v)) return Object.freeze(v.map((x) => freezeRound(x)));
  if (!v || typeof v !== 'object') return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = freezeRound(val);
  return Object.freeze(out);
}

export class GameEngine {
  constructor() { this.reset(); }

  // -------------------------------------------------------------------------
  // The whole of the state, in one place
  //
  // Everything the engine holds is assigned here and nowhere else. A field
  // that appears for the first time halfway down a method is a field that
  // serialize() will eventually forget, and a restored match would resume
  // missing it — which shows up as a bug three rounds later.
  // -------------------------------------------------------------------------
  reset() {
    this.phase = PHASES.LOBBY;
    this.phaseAt = 0;
    this.config = normalizeConfig(DEFAULT_CONFIG);
    this.ownerId = null;

    // --- the table ---
    // One record per seat, index IS the seat number. Order is join order and
    // never changes once the match starts; the turn order is derived from the
    // index by js/trick.js, so shuffling this array would reseat the table
    // mid-match.
    this.seats = [];

    // --- the match ---
    this.plan = [];          // hand size of every round, in order
    this.roundIndex = -1;    // -1 until the first round is dealt
    this.dealerSeat = 0;
    this.totals = [];        // running score per seat; goes negative under square
    this.history = [];       // one frozen record per completed round

    // --- the round ---
    this.roundSize = 0;
    this.trump = null;       // null = NOT YET TURNED. NO_TRUMP is a different thing.
    this.turnUpCard = null;  // held out of publicState() until turnUpShown
    this.turnUpShown = false;
    this.hands = [];         // never public, never sent to anyone but its owner
    this.stock = [];         // never public either — it is the rest of the deck
    this.bids = [];          // per seat, null until that seat has bid
    this.bidOrder = [];      // seats in bidding order: dealer's left first, dealer last
    this.tricksWon = [];
    this.trickIndex = 0;
    this.plays = [];         // [{ seat, code }] in the order they hit the table
    this.leadSeat = 0;
    this.turnSeat = 0;
    this.lastTrick = null;   // { plays, winner, trickIndex } — survives the sweep
    // Every trick COMPLETED this round, in order, cleared at the deal. Public
    // information in the strictest sense — the whole table watched each of
    // these cards land — and the only reason it is stored rather than derived
    // is that once the sweep clears this.plays there is nowhere else it exists.
    //
    // js/bot.js is what forced it into being: a bot that cannot see which cards
    // have gone cannot tell a king that is now unbeatable from one that is not,
    // and telling those apart is the whole of ducking. Giving it the cards
    // everybody else saw is the alternative to giving it the cards nobody saw.
    this.tricks = [];
    this.sweepAt = null;     // when tick() should clear a finished trick

    this.log = [];
  }

  // ###########################################################################
  //
  //  SEATING
  //
  // ###########################################################################

  /**
   * Seat a player, or give them back the seat they already had.
   *
   * Reclaim is by clientId and BY NOTHING ELSE. It works in any phase, which
   * is the point: a 19-round match will outlast at least one person's
   * battery, and the clientId is the 128-bit value their browser generated
   * once and has never regenerated (js/util.js). It is not a secret and is
   * not treated as one — it is a seat ticket.
   *
   * A NAME IS NEVER A SEAT TICKET. Reclaiming by name would mean anybody who
   * can read the scoreboard — which is public, to everybody, by design — can
   * type a name and take that seat, and with it that player's hand. The
   * absence of a name-matching branch here is the entire defence.
   */
  addPlayer(id, name, { clientId = null, isOwner = false } = {}) {
    const clean = cleanName(name) || 'Player';

    if (clientId) {
      const seat = this.seats.findIndex((s) => s.clientId && s.clientId === clientId);
      if (seat !== -1) return this._reclaim(seat, id, clean);
    }

    // Past this point we are creating a seat, which is a lobby-only act.
    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'the match has already started' };
    }
    if (this.seats.length >= MAX_PLAYERS) {
      return { ok: false, error: `the table is full at ${MAX_PLAYERS}` };
    }

    const seat = this.seats.length;
    this.seats.push({
      id,
      clientId,
      name: this._uniqueName(clean),
      // The first person through the door owns the room. Passing isOwner is
      // how a restored match reinstates an owner who is not seat zero.
      isOwner: isOwner || seat === 0,
      isBot: false,
      connected: true,
    });
    if (this.seats[seat].isOwner) this.ownerId = id;
    this._say(`${this.seats[seat].name} joined`, 'join', seat);
    return { ok: true, seat };
  }

  _reclaim(seat, id, name) {
    const s = this.seats[seat];
    const fresh = !s.connected;
    s.id = id;
    s.connected = true;
    // A reconnecting player may have changed their name in the meantime; take
    // it, because the alternative is telling somebody their own name is wrong.
    // Not mid-match though: the scoreboard and the log already say the old one
    // in a dozen places, and renaming row four in round twelve is confusing in
    // a way that a stale name is not.
    if (this.phase === PHASES.LOBBY && name) s.name = this._uniqueName(name, seat);
    if (s.isOwner) this.ownerId = id;
    // Silent if they were never marked gone — a second hello from a tab that
    // never dropped is a duplicate message, not an event, and logging it
    // would fill the live region with "Asha reconnected" on every retry.
    if (fresh) this._say(`${s.name} reconnected`, 'join', seat);
    return { ok: true, seat, reclaimed: true };
  }

  // Two players called "Sam" at a seven-seat table is two rows of a scoreboard
  // nobody can read, and — worse — a spoken "Sam takes it" that means nothing.
  // Suffixing is friendlier than rejecting: the person who typed it second is
  // not the one who did anything wrong.
  _uniqueName(name, exceptSeat = -1) {
    const taken = new Set(this.seats.filter((_, i) => i !== exceptSeat).map((s) => s.name));
    if (!taken.has(name)) return name;
    for (let n = 2; n <= MAX_PLAYERS + 1; n++) {
      const tryName = `${name} ${n}`;
      if (!taken.has(tryName)) return tryName;
    }
    return name;
  }

  /**
   * Somebody's connection dropped. What that means depends entirely on the
   * phase, and the two answers are opposites.
   *
   * IN THE LOBBY the seat is removed outright. A lobby seat holds nothing —
   * no hand, no bid, no score — so there is nothing to lose, and keeping the
   * empty chair would block the start forever: startBlocker() refuses to deal
   * to an absent player, and nobody can vacate a chair they are no longer
   * connected to. That is a lobby that deadlocks the first time anybody
   * reloads, which is every time.
   *
   * MID-MATCH the seat stays exactly where it is, holding its hand and its
   * score. Removing it would renumber every seat above, silently reassigning
   * hands, bids and running totals to the wrong people — and the clientId
   * reclaim in addPlayer() has nothing to match against if the record is
   * gone, so removing the seat is also what makes the reconnect impossible.
   */
  disconnect(id) {
    const seat = this.seatOf(id);
    if (seat === -1) return { ok: false, error: 'not seated' };
    const who = this.seats[seat].name;

    if (this.phase === PHASES.LOBBY) {
      const wasOwner = this.seats[seat].isOwner;
      this.seats.splice(seat, 1);
      // Somebody has to own the room. Without this the lobby survives the
      // owner leaving but nothing in it can ever be changed or started again.
      if (wasOwner) this._promoteOwner();
      this._say(`${who} left`, 'leave');
      return { ok: true, removed: true };
    }

    this.seats[seat].connected = false;
    this._say(`${who} disconnected`, 'leave', seat);
    return { ok: true, seat };
  }

  // The longest-seated human. A bot cannot own a room — it would never press
  // start, and the table would wait on it forever.
  _promoteOwner() {
    this.ownerId = null;
    const heir = this.seats.findIndex((s) => !s.isBot);
    if (heir === -1) return;
    this.seats[heir].isOwner = true;
    this.ownerId = this.seats[heir].id;
  }

  addBot(actorId, name = null) {
    if (!this._isOwner(actorId)) return { ok: false, error: 'only the owner can add a bot' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'the match has already started' };
    if (this.seats.length >= MAX_PLAYERS) return { ok: false, error: `the table is full at ${MAX_PLAYERS}` };

    const seat = this.seats.length;
    this.seats.push({
      id: `bot:${seat}`,
      clientId: null,
      name: this._uniqueName(cleanName(name) || BOT_NAMES[seat % BOT_NAMES.length]),
      isOwner: false,
      isBot: true,
      // A bot is never disconnected. Nothing should ever wait on one, and a
      // "waiting for Robin" that can never clear is a hung game.
      connected: true,
    });
    this._say(`${this.seats[seat].name} (bot) joined`, 'join', seat);
    return { ok: true, seat };
  }

  /**
   * Vacate a chair in the lobby: a bot, or a human who is not here.
   *
   * The two cases are one method because they are one need — the owner is
   * looking at a table that cannot start and has to be able to fix it. The
   * absent-human case matters after restore(), which marks everybody
   * disconnected; if two of the five never come back, the owner must be able
   * to drop them and deal to three rather than stare at a dead start button.
   *
   * REFUSES TO REMOVE A CONNECTED PLAYER. That is kicking, it is a moderation
   * feature with a moderation feature's problems, and the brief does not ask
   * for it. Out of scope, flagged rather than quietly added.
   */
  removeSeat(actorId, seat) {
    if (!this._isOwner(actorId)) return { ok: false, error: 'only the owner can remove a seat' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'the match has already started' };
    const s = this.seats[seat];
    if (!s) return { ok: false, error: 'no such seat' };
    if (!s.isBot && s.connected) return { ok: false, error: `${s.name} is still here` };
    // Safe here and only here: in the lobby nothing is indexed by seat yet —
    // no hand, no bid, no score. See disconnect() for why renumbering seats
    // is never done once the cards are out.
    this.seats.splice(seat, 1);
    if (s.isOwner) this._promoteOwner();
    this._say(`${s.name} left`, 'leave');
    return { ok: true };
  }

  setConfig(actorId, patch) {
    if (!this._isOwner(actorId)) return { ok: false, error: 'only the owner can change the game' };
    // Not a fussy guard. The round ladder, the hand size and the trump
    // sequence are all read off the config at deal time, so changing it in
    // round six would hand out a different number of cards than the round the
    // scoreboard says is being played.
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'the match has already started' };
    this.config = normalizeConfig({ ...this.config, ...patch });
    return { ok: true, config: this.config };
  }

  seatOf(id) { return this.seats.findIndex((s) => s.id === id); }

  _isOwner(id) {
    const seat = this.seatOf(id);
    return seat !== -1 && this.seats[seat].isOwner;
  }

  /**
   * Hand ownership to somebody else.
   *
   * The owner's tab is also, in v1, the host's tab — but they are different
   * things (see the header), and this moves only the owner half. Called when
   * the original owner's seat has been empty long enough that the table has
   * given up on them, which on a match this long is not a rare event.
   */
  resumeAsOwner(ownerId) {
    const seat = this.seatOf(ownerId);
    if (seat === -1) return { ok: false, error: 'not seated' };
    for (const s of this.seats) s.isOwner = false;
    this.seats[seat].isOwner = true;
    this.ownerId = ownerId;
    this._say(`${this.seats[seat].name} is now the host`, 'system', seat);
    return { ok: true, seat };
  }

  // ###########################################################################
  //
  //  THE MATCH
  //
  // ###########################################################################

  /** Why the match cannot start yet, or null. Separate from startMatch() so the
   *  lobby can show the reason on a disabled button instead of a dead tap. */
  startBlocker() {
    if (this.phase !== PHASES.LOBBY) return 'the match has already started';
    const n = this.seats.length;
    if (n < MIN_PLAYERS) return `needs ${MIN_PLAYERS} players, has ${n}`;
    if (n > MAX_PLAYERS) return `too many players, ${MAX_PLAYERS} is the most`;
    if (this.seats.some((s) => !s.connected && !s.isBot)) return 'somebody is disconnected';
    return null;
  }

  startMatch(actorId, now = 0) {
    if (!this._isOwner(actorId)) return { ok: false, error: 'only the owner can start' };
    const blocker = this.startBlocker();
    if (blocker) return { ok: false, error: blocker };

    const players = this.seats.length;
    // Frozen at the moment of the start, from the seat count at the moment of
    // the start. Both matter: the ladder depends on how many people are here,
    // and nobody may join after this, so the plan cannot become wrong.
    this.plan = roundPlan(this.config, players);
    this.totals = new Array(players).fill(0);
    this.history = [];
    this.roundIndex = -1;
    // Seat zero deals the first round and it rotates clockwise from there, so
    // over a 19-round match at five seats everybody deals about four times —
    // which matters because the dealer is the seat the hook bites.
    this.dealerSeat = players - 1;

    const shape = matchShape(this.config, players);
    this._say(
      `Match on: ${shape.rounds} rounds, ${shape.tricks} tricks, about ${shape.minutes} minutes`,
      'system',
    );
    return this._beginRound(now);
  }

  // -------------------------------------------------------------------------
  // Dealing a round
  // -------------------------------------------------------------------------

  _beginRound(now) {
    // Tested before the increment, not after, so roundIndex never points past
    // the end of the plan. A MATCH_OVER screen reading "Round 20 of 19" is
    // the visible half of that; the other half is every consumer that indexes
    // this.plan[this.roundIndex] and gets undefined.
    if (this.roundIndex + 1 >= this.plan.length) return this._endMatch(now);
    this.roundIndex += 1;

    const players = this.seats.length;
    this.dealerSeat = nextSeat(this.dealerSeat, players);
    this.roundSize = this.plan[this.roundIndex];

    const turnUp = needsTurnUp(this.config.trumpMethod);
    // roundPlan() already clamped the ladder for the turn-up card, so this
    // cannot be short — but deal() throws rather than dealing a quiet six-card
    // hand in a seven-card round, and that throw is the backstop for a cap
    // computed wrongly somewhere upstream. Do not catch it.
    const { hands, turnUpCard, stock } = deal(shuffle(buildDeck()), {
      players,
      handSize: this.roundSize,
      dealerSeat: this.dealerSeat,
      turnUp,
    });

    this.hands = hands;
    this.stock = stock;
    this.turnUpCard = turnUpCard;
    this.turnUpShown = false;
    // Under the turn-up method this stays null — NOT YET TURNED — right through
    // the deal, and only becomes a suit at the reveal. Setting it now from
    // suitOf(turnUpCard) would be correct about the suit and wrong about the
    // secret, because publicState() reports the trump and would leak it before
    // anybody has seen the card flip.
    this.trump = turnUp ? null : trumpForRound(this.config.trumpMethod, this.roundIndex);

    this.bids = new Array(players).fill(null);
    this.bidOrder = seatsFrom(nextSeat(this.dealerSeat, players), players);
    this.tricksWon = new Array(players).fill(0);
    this.trickIndex = 0;
    this.plays = [];
    this.tricks = [];
    this.lastTrick = null;
    this.sweepAt = null;
    // Left of the dealer leads the first trick, and left of the dealer bids
    // first. Same seat, and the same seatsFrom() ordering as the deal itself.
    this.leadSeat = this.bidOrder[0];
    this.turnSeat = this.bidOrder[0];

    this._say(
      `Round ${this.roundIndex + 1} of ${this.plan.length}: ${this.roundSize} card${this.roundSize === 1 ? '' : 's'}, `
      + `${this._name(this.dealerSeat)} deals`,
      'round',
    );
    this._enter(PHASES.ROUND_DEAL, now);
    return { ok: true, phase: this.phase };
  }

  /**
   * Advance anything that is waiting on the clock.
   *
   * Idempotent and safe to call as often as the caller likes — every branch
   * either fires once and moves the state on, or does nothing. A requestAnimationFrame
   * loop calls it sixty times a second and a test calls it twice.
   */
  tick(now = 0) {
    let moved = false;

    if (this.phase === PHASES.ROUND_DEAL && now - this.phaseAt >= DEAL_PAUSE_MS) {
      if (needsTurnUp(this.config.trumpMethod)) this._revealTrump(now);
      else this._beginBidding(now);
      moved = true;
    } else if (this.phase === PHASES.TRUMP_REVEAL && now - this.phaseAt >= REVEAL_PAUSE_MS) {
      this._beginBidding(now);
      moved = true;
    } else if (this.sweepAt !== null && now - this.sweepAt >= TRICK_PAUSE_MS) {
      this._sweepTrick(now);
      moved = true;
    }

    return moved;
  }

  /**
   * THE REVEAL MOMENT. Everything about the turn-up method's privacy lives on
   * this one line ordering: the card becomes public and the suit becomes trump
   * in the same instant, and not one state send earlier.
   */
  _revealTrump(now) {
    this.turnUpShown = true;
    this.trump = suitOf(this.turnUpCard);
    this._say(`${cardName(this.turnUpCard)} turned up — ${trumpName(this.trump)} are trumps`, 'trump');
    this._enter(PHASES.TRUMP_REVEAL, now);
  }

  _beginBidding(now) {
    // Under a rotation the trump has been known since the deal, so the table
    // is told now rather than at deal time — at deal time nobody is looking at
    // the log, they are looking at their cards arriving.
    if (!needsTurnUp(this.config.trumpMethod)) {
      this._say(
        this.trump === NO_TRUMP ? 'No trumps this round' : `${trumpName(this.trump)} are trumps`,
        'trump',
      );
    }
    this.turnSeat = this.bidOrder[0];
    this._enter(PHASES.BIDDING, now);
  }

  // -------------------------------------------------------------------------
  // Bidding
  // -------------------------------------------------------------------------

  /**
   * Bid an exact number of tricks. Zero is a bid; there is no pass.
   *
   * The hook lives in js/rules.js and is consulted, never reimplemented — this
   * method does not know what number is forbidden and must not learn. It knows
   * who the dealer is and whether the host switched the rule on, which is
   * exactly what legalBids() demands of a caller and refuses to default.
   */
  placeBid(actorId, bid, now = 0) {
    if (this.phase !== PHASES.BIDDING) return { ok: false, error: 'not bidding right now' };
    const seat = this.seatOf(actorId);
    if (seat === -1) return { ok: false, error: 'not seated' };
    if (seat !== this.turnSeat) return { ok: false, error: `it is ${this._name(this.turnSeat)}'s bid` };

    const opts = { isDealer: seat === this.dealerSeat, hook: this.config.hook };
    const soFar = this._bidsSoFar();
    if (!bidIsLegal(bid, this.roundSize, soFar, opts)) {
      // The reason, not just the refusal. The UI has already greyed this
      // number out with the same string, so a bid that gets here came from a
      // client that ignored it — or from a client that is lying — and either
      // way the sentence is the one the screen reader would have read.
      return { ok: false, error: illegalBidReason(bid, this.roundSize, soFar, opts) };
    }

    this.bids[seat] = bid;
    this._say(`${this._name(seat)} bids ${bid}`, 'bid', seat);

    const next = this.bidOrder.find((s) => this.bids[s] === null);
    if (next === undefined) return this._beginPlay(now);
    this.turnSeat = next;
    return { ok: true, phase: this.phase };
  }

  /** The bids already in, in bidding order — which is the order forbiddenBid()
   *  sums and the only order in which "the dealer is last" is true. */
  _bidsSoFar() {
    return this.bidOrder.map((s) => this.bids[s]).filter((b) => b !== null);
  }

  /** Every bid this seat could make right now, with a reason against each one
   *  it cannot. Drives the bid pad, including the greyed-out hook number. */
  bidOptionsFor(seat) {
    if (this.phase !== PHASES.BIDDING || !this.seats[seat]) return [];
    const opts = { isDealer: seat === this.dealerSeat, hook: this.config.hook };
    const soFar = this._bidsSoFar();
    const allowed = new Set(legalBids(this.roundSize, soFar, opts));
    const out = [];
    for (let bid = 0; bid <= this.roundSize; bid++) {
      out.push({
        bid,
        legal: allowed.has(bid),
        reason: allowed.has(bid) ? null : illegalBidReason(bid, this.roundSize, soFar, opts),
      });
    }
    return out;
  }

  _beginPlay(now) {
    const total = this.bids.reduce((a, b) => a + b, 0);
    // The line that explains the whole game, said once a round. Under the hook
    // it can never read "exactly" — which is the rule made visible rather than
    // merely enforced.
    const gap = total - this.roundSize;
    this._say(
      `Bids total ${total} for ${this.roundSize} trick${this.roundSize === 1 ? '' : 's'} — `
      + (gap > 0 ? `over by ${gap}, somebody must fail`
        : gap < 0 ? `under by ${-gap}, somebody must take one they did not want`
          : 'exactly right, everybody could make it'),
      'system',
    );
    this.turnSeat = this.leadSeat;
    this._enter(PHASES.PLAY, now);
    return { ok: true, phase: this.phase };
  }

  // -------------------------------------------------------------------------
  // Trick play
  // -------------------------------------------------------------------------

  playCard(actorId, code, now = 0) {
    if (this.phase !== PHASES.PLAY) return { ok: false, error: 'not playing right now' };
    // A finished trick is still sitting on the table. Accepting a card now
    // would lead the next trick before anybody has seen who won the last one.
    if (this.sweepAt !== null) return { ok: false, error: 'the trick is still on the table' };
    const seat = this.seatOf(actorId);
    if (seat === -1) return { ok: false, error: 'not seated' };
    if (seat !== this.turnSeat) return { ok: false, error: `it is ${this._name(this.turnSeat)}'s turn` };

    // Checked against the HOST'S copy of the hand, which is the only copy that
    // counts. The client's belief about what it holds is not consulted and is
    // not sent — all that arrived was a card code.
    const hand = this.hands[seat];
    const led = ledSuitOf(this.plays);
    if (!canPlay(hand, code, led)) {
      return { ok: false, error: illegalReason(hand, code, led) };
    }

    hand.splice(hand.indexOf(code), 1);
    this.plays.push({ seat, code });

    if (this.plays.length < this.seats.length) {
      this.turnSeat = nextSeat(seat, this.seats.length);
      return { ok: true, phase: this.phase };
    }
    return this._finishTrick(now);
  }

  /**
   * Everybody has played. Decide it, credit it, and LEAVE THE CARDS WHERE THEY
   * ARE — the sweep is a separate step on a timer, because a trick that
   * vanishes the instant the last card lands is a trick nobody saw.
   */
  _finishTrick(now) {
    const winner = trickWinner(this.plays, this.trump);
    this.tricksWon[winner] += 1;
    this.lastTrick = {
      plays: this.plays.map((p) => ({ ...p })),
      winner,
      card: winningCard(this.plays, this.trump),
      trickIndex: this.trickIndex,
    };
    this._say(
      `${this._name(winner)} takes it with ${cardName(this.lastTrick.card)} `
      + `(${this.tricksWon[winner]} of ${this.bids[winner]})`,
      'trick',
      winner,
    );
    // Timed from the last card landing, not from the phase starting — the
    // phase started at the top of the round and the pause would be long over.
    this.sweepAt = now;
    return { ok: true, phase: this.phase, trickWinner: winner };
  }

  _sweepTrick(now) {
    const winner = this.lastTrick.winner;
    // Filed HERE and not in _finishTrick, so that the cards of a trick are in
    // exactly one place at every instant. Through the sweep pause they are
    // still in this.plays, on the table, where the players are looking; the
    // moment they leave the table they arrive in the record. A consumer that
    // wants every card played this round concatenates the two and can never
    // double-count, which is what js/bot.js does.
    this.tricks.push({ plays: this.plays.map((p) => ({ ...p })), winner });
    this.plays = [];
    this.sweepAt = null;
    this.trickIndex += 1;

    if (this.trickIndex >= this.roundSize) return this._endRound(now);

    // The winner leads the next one. This is the only place the lead moves
    // other than the deal, and it is why leadSeat is not just "dealer's left".
    this.leadSeat = winner;
    this.turnSeat = winner;
    this.phaseAt = now;
    return { ok: true, phase: this.phase };
  }

  // -------------------------------------------------------------------------
  // Scoring the round
  // -------------------------------------------------------------------------

  _endRound(now) {
    const deltas = this.seats.map((_, seat) =>
      scoreRound(this.config.scoring, this.bids[seat], this.tricksWon[seat], this.roundSize));
    this.totals = this.totals.map((t, seat) => t + deltas[seat]);

    // The record is complete on its own: bids, tricks, deltas AND the running
    // totals as they stood at the end of this round. A client that joins in
    // round twelve replays history and rebuilds the entire scoreboard from it,
    // without ever having seen rounds one to eleven. Storing only the deltas
    // would work too, right up until one arrived out of order.
    //
    // FROZEN TO THE ARRAYS, not just at the top. Object.freeze is shallow, and
    // a record frozen at the top with four live arrays hanging off it is the
    // shape that reads as safe and is not: publicState() hands these records
    // straight out, so `pub.history[0].totals.sort()` — one line in a
    // scoreboard, the most obvious thing in the world to write — was reaching
    // through the public view and reordering the engine's own record of a
    // round that is over. Nothing in the app does that today. The point is
    // that the next thing to try it gets a TypeError instead of a wrong
    // scoreboard three rounds later.
    //
    // Sealed here rather than copied in publicState() because the record is
    // append-only and already immutable in spirit — nothing ever edits a
    // finished round. Freezing says that once, at the only place a record is
    // born; copying would say it on every push, about 900 times a match, and
    // would swallow the mistake instead of reporting it.
    //
    // THE FIELD LIST BELOW IS THE RECORD, NOT THE SEAL. Every value goes in
    // raw — no slice, no Object.freeze — because freezeRound() does both, to
    // every field, at every depth. That is what makes this literal safe to
    // extend: a fifth field added here is sealed by the same rule as the other
    // four, and cannot be the one somebody forgot to wrap. It is also the only
    // sealing code in the file, so a restored engine cannot end up with
    // stronger or weaker records than this one.
    //
    // `this.bids`, `this.tricksWon` and `this.totals` are all live engine
    // arrays and are handed over unsliced ON PURPOSE: freezeRound copies. If
    // it ever stopped, the record would alias the arrays the next round is
    // about to overwrite, and history would rewrite itself as the match went
    // on — which is a far louder failure than a missing freeze, and that is
    // the right way round.
    this.history.push(freezeRound({
      roundIndex: this.roundIndex,
      roundSize: this.roundSize,
      trump: this.trump,
      dealerSeat: this.dealerSeat,
      bids: this.bids,
      tricks: this.tricksWon,
      deltas,
      totals: this.totals,
    }));

    for (const seat of this.bidOrder) {
      const made = this.bids[seat] === this.tricksWon[seat];
      this._say(
        `${this._name(seat)} bid ${this.bids[seat]}, took ${this.tricksWon[seat]} — `
        + `${made ? 'made it' : 'missed'}, ${deltas[seat] >= 0 ? '+' : ''}${deltas[seat]}`,
        made ? 'made' : 'missed',
        seat,
      );
    }

    this._enter(PHASES.ROUND_OVER, now);
    return { ok: true, phase: this.phase };
  }

  /**
   * Leave the round-over scoreboard and deal the next round.
   *
   * Owner-driven rather than on a timer, and deliberately: ROUND_OVER is a
   * real phase, not a modal. Six people need to read bids against actuals and
   * find themselves in a column of running totals that may have just gone
   * negative, and no timeout is right for all six. The cost is that the owner
   * taps once a round — which is also the thing that stops the match running
   * away from somebody who looked up.
   */
  nextRound(actorId, now = 0) {
    if (this.phase !== PHASES.ROUND_OVER) return { ok: false, error: 'the round is not over' };
    if (!this._isOwner(actorId)) return { ok: false, error: 'only the owner can move on' };
    return this._beginRound(now);
  }

  _endMatch(now) {
    const best = Math.max(...this.totals);
    const winners = this.totals
      .map((t, seat) => (t === best ? seat : -1))
      .filter((seat) => seat !== -1);
    // A draw is a real outcome, not an edge case to break arbitrarily. Two
    // players on 140 both won; picking the lower seat number would be a rule
    // nobody agreed to.
    this._say(
      winners.length === 1
        ? `${this._name(winners[0])} wins on ${best}`
        : `Drawn on ${best}: ${winners.map((s) => this._name(s)).join(', ')}`,
      'system',
    );
    this._enter(PHASES.MATCH_OVER, now);
    return { ok: true, phase: this.phase, winners };
  }

  /** Who is winning, or who won. Ties return every seat on the top score, so
   *  the scoreboard's leader marker can show two of them. */
  leaders() {
    if (!this.totals.length) return [];
    const best = Math.max(...this.totals);
    return this.totals.map((t, seat) => (t === best ? seat : -1)).filter((s) => s !== -1);
  }

  // ###########################################################################
  //
  //  VIEWS — the privacy boundary
  //
  //  publicState() is sent to everybody, including a peer nobody has verified.
  //  privateStateFor() is sent to exactly one player. If a field is in the
  //  wrong one of these two functions, the game is broken and will look fine.
  //
  // ###########################################################################

  /**
   * What every peer may see.
   *
   * THREE THINGS ARE MISSING FROM THIS OBJECT AND ALL THREE ARE DELIBERATE:
   *
   *   hands       obviously. Only handCount goes out.
   *   stock       the undealt remainder. Under the turn-up method at three
   *               players that is most of a deck, and knowing it is knowing
   *               everything nobody was dealt.
   *   turnUpCard  until turnUpShown. Sent as null before the reveal, which is
   *               indistinguishable from a round with no turn-up at all — the
   *               absence is not even shaped like a secret.
   *
   * A bid in progress is not here either, because it does not exist: a bid is
   * written to this.bids only once it is submitted and legal, so there is no
   * half-made bid anywhere in the engine for this function to leak.
   *
   * ---------------------------------------------------------------------
   * NOTHING REACHABLE FROM HERE CAN MOVE THE ENGINE, and it is worth being
   * precise about how, because "every array is copied" is what this comment
   * used to say and it was only two thirds true.
   * ---------------------------------------------------------------------
   *
   * Three different mechanisms, one guarantee:
   *
   *   COPIED    seats, plan, plays, tricks, lastTrick, leaders. Rebuilt on
   *             every call, so a consumer that sorts one is sorting its own.
   *             plan is numbers, so slice() really is deep for it; plays and
   *             tricks are copied two levels because a shallow slice hands
   *             out live play records.
   *
   *   FROZEN    history and log. The ARRAY is sliced here; the RECORDS and
   *             LINES inside it are frozen where they are written, in
   *             _endRound() and _say(). That split is the whole subtlety —
   *             pub.log is a copy but pub.log[0] is not, so before the
   *             freeze a consumer editing a line edited the engine's line.
   *             Frozen rather than copied because these are append-only and
   *             immutable in spirit, so it can be said once at the write
   *             site instead of ~900 times a match on the push path, and
   *             because a mutation then throws instead of quietly diverging.
   *
   *   PRIMITIVE config. A LIVE reference — pub.config === this.config — and
   *             safe only because normalizeConfig() in js/rules.js freezes
   *             it and every value in it is a primitive, which makes that
   *             shallow freeze a deep one. That is a guarantee owned by
   *             another file, so the suite asserts it there rather than
   *             trusting it here; delete the freeze in rules.js and this
   *             becomes a hole in the privacy boundary with nothing at this
   *             end to notice.
   */
  publicState() {
    return {
      phase: this.phase,
      phaseAt: this.phaseAt,
      config: this.config,
      seats: this.seats.map((s, seat) => ({
        seat,
        name: s.name,
        isOwner: s.isOwner,
        isBot: s.isBot,
        connected: s.connected,
        // The count, never the cards. It is public information in a card
        // game — everyone can see how many you are holding.
        handCount: this.hands[seat] ? this.hands[seat].length : 0,
        bid: this.bids[seat] === undefined ? null : this.bids[seat],
        tricks: this.tricksWon[seat] || 0,
        total: this.totals[seat] || 0,
      })),

      plan: this.plan.slice(),
      roundIndex: this.roundIndex,
      roundCount: this.plan.length,
      roundSize: this.roundSize,
      dealerSeat: this.dealerSeat,
      leadSeat: this.leadSeat,
      turnSeat: this.turnSeat,
      trickIndex: this.trickIndex,

      // null here means one of two things and the client cannot tell which:
      // not yet turned, or no turn-up in this game. Both render as "?".
      trump: this.trump,
      turnUpCard: this.turnUpShown ? this.turnUpCard : null,

      plays: this.plays.map((p) => ({ ...p })),
      // The round so far, swept tricks only — see the field's note in reset().
      // Copied two levels deep: a shallow slice() hands out live play records,
      // and a consumer that sorted one would reorder a trick in the engine.
      tricks: this.tricks.map((t) => ({
        plays: t.plays.map((p) => ({ ...p })),
        winner: t.winner,
      })),
      lastTrick: this.lastTrick ? {
        plays: this.lastTrick.plays.map((p) => ({ ...p })),
        winner: this.lastTrick.winner,
        card: this.lastTrick.card,
      } : null,
      sweeping: this.sweepAt !== null,

      // The full run of completed rounds, every time. It is what lets a tab
      // that joined in round twelve draw the same scoreboard as everybody
      // else, and at 19 rounds by 7 seats it is a few kilobytes.
      history: this.history.slice(),
      leaders: this.leaders(),

      startBlocker: this.startBlocker(),
      shape: this.seats.length >= MIN_PLAYERS ? matchShape(this.config, this.seats.length) : null,
      maxHand: this.seats.length >= MIN_PLAYERS ? effectiveMaxHand(this.config, this.seats.length) : null,
      log: this.log.slice(-LOG_CAP),
    };
  }

  /**
   * What one player may see that the others may not: their own hand, and the
   * bid pad if it is their bid.
   *
   * `legal` on a card is follow-suit legality against the suit currently led,
   * and it is answered even when it is not this player's turn — by then the
   * lead is already on the table and public, so computing it early leaks
   * nothing and lets the fan grey itself the moment the lead is played rather
   * than on the player's turn. `isTurn` is reported separately; the UI needs
   * both and must not conflate them.
   *
   * Returns null for someone with no seat. A spectator is out of scope for v1
   * and this is what "out of scope" looks like in the code.
   */
  privateStateFor(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return null;

    const hand = this.hands[seat] || [];
    const led = ledSuitOf(this.plays);
    // Only two phases have a turn at all. Without the phase test, turnSeat is
    // left at 0 through the lobby and the whole round-over screen, so seat
    // zero's client would light up "your turn" at moments when there is
    // nothing whatsoever to do.
    const waiting = this.phase === PHASES.BIDDING
      || (this.phase === PHASES.PLAY && this.sweepAt === null);
    const isTurn = waiting && this.turnSeat === seat;

    return {
      seat,
      isOwner: this.seats[seat].isOwner,
      isTurn,
      isDealer: seat === this.dealerSeat,
      // Sorted for display with trump pulled to the front. Sorting here rather
      // than in js/ui.js means the bot sees the same fan the person does, and
      // the order is stable across sends so cards do not jump under a thumb.
      hand: sortHand(hand, this.trump).map((code) => ({
        code,
        legal: this.phase === PHASES.PLAY && canPlay(hand, code, led),
        reason: this.phase === PHASES.PLAY ? illegalReason(hand, code, led) : 'not playing right now',
      })),
      legalCount: this.phase === PHASES.PLAY ? legalPlays(hand, led).length : 0,
      bidOptions: this.phase === PHASES.BIDDING && isTurn ? this.bidOptionsFor(seat) : null,
      // The dealer wants to know this before it is their turn, so they can
      // watch it move as the others bid. Null when the hook is off or cannot
      // bite; it is arithmetic over public bids, so it is not a secret.
      forbidden: this.config.hook && seat === this.dealerSeat && this.phase === PHASES.BIDDING
        ? forbiddenBid(this._bidsSoFar(), this.roundSize)
        : null,
      bid: this.bids[seat] === undefined ? null : this.bids[seat],
      tricks: this.tricksWon[seat] || 0,
      total: this.totals[seat] || 0,
    };
  }

  // ###########################################################################
  //
  //  PERSISTENCE
  //
  // ###########################################################################

  /**
   * The whole engine, hands and all, as plain JSON.
   *
   * THIS IS NOT A VIEW AND MUST NEVER BE SENT TO A PEER. It is the host's own
   * snapshot, for localStorage under `judgement.` — the host reloading their
   * tab in round fourteen should not end nineteen rounds of scoring for six
   * people. publicState() is the thing that goes on the wire; if these two
   * ever get called in each other's place the game is over and nobody will be
   * told.
   */
  serialize() {
    return {
      v: 1,
      phase: this.phase,
      phaseAt: this.phaseAt,
      config: this.config,
      ownerId: this.ownerId,
      seats: this.seats.map((s) => ({ ...s })),
      plan: this.plan.slice(),
      roundIndex: this.roundIndex,
      dealerSeat: this.dealerSeat,
      totals: this.totals.slice(),
      history: this.history.slice(),
      roundSize: this.roundSize,
      trump: this.trump,
      turnUpCard: this.turnUpCard,
      turnUpShown: this.turnUpShown,
      hands: this.hands.map((h) => h.slice()),
      stock: this.stock.slice(),
      bids: this.bids.slice(),
      bidOrder: this.bidOrder.slice(),
      tricksWon: this.tricksWon.slice(),
      trickIndex: this.trickIndex,
      plays: this.plays.map((p) => ({ ...p })),
      tricks: this.tricks.map((t) => ({ plays: t.plays.map((p) => ({ ...p })), winner: t.winner })),
      leadSeat: this.leadSeat,
      turnSeat: this.turnSeat,
      // COPIED, like every other object on this list. It was the one field
      // handed out live, and it did not show up as a bug because the shipped
      // caller stringifies the result immediately — JSON copies everything,
      // so the hole was invisible to the only path that uses it. The path
      // that does NOT stringify is restore(other.serialize()), which is how
      // the suite duplicates an engine, and there it handed two engines one
      // trick record.
      lastTrick: this.lastTrick ? {
        ...this.lastTrick,
        plays: this.lastTrick.plays.map((p) => ({ ...p })),
      } : null,
      sweepAt: this.sweepAt,
      log: this.log.slice(),
    };
  }

  /**
   * Rebuild from a snapshot.
   *
   * reset() first, so a field the snapshot is missing — an older build, a
   * truncated write — lands on a sane default rather than whatever the
   * previous match left in it. Every field is then taken defensively: a
   * half-written localStorage entry should give a lobby, not a throw on load
   * that leaves the app with no UI at all.
   *
   * DEFENSIVE ABOUT TWO THINGS, and for a long time only one of them. Type is
   * the obvious one and it is what every own() / Number() / ?? below reads
   * as. The second is OWNERSHIP: the snapshot is the caller's object, and an
   * engine that adopts its arrays writes into it for the rest of the match.
   * Nothing here keeps a reference to anything it was handed — see own().
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { ok: false, error: 'no snapshot' };
    this.reset();
    const s = snapshot;

    // EVERY ARRAY IS COPIED ON THE WAY IN. The type check is the part of this
    // helper you notice; the slice is the part that matters.
    //
    // What restore() is handed belongs to the CALLER. It is the object
    // js/main.js read out of localStorage, and adopting it makes the engine
    // and that object one thing — so `this.tricksWon[winner] += 1`, which
    // runs a few hundred times a match, writes into the snapshot somebody
    // else is still holding. Restore two engines from one snapshot and they
    // share a `totals`: the second match scores into the first. Nothing in
    // the app does that today, and "nothing does that today" is not a
    // property of this function, it is a property of its one caller.
    //
    // A helper rather than twelve slices at twelve call sites, for the same
    // reason freezeRound takes no field list: the next field added here will
    // be written by copying the line above it, so the line above it has to be
    // right. Named `own` because that is the guarantee — after this call the
    // array is the engine's, and no other reference reaches it.
    const own = (v) => (Array.isArray(v) ? v.slice() : []);

    this.phase = Object.values(PHASES).includes(s.phase) ? s.phase : PHASES.LOBBY;
    this.phaseAt = Number(s.phaseAt) || 0;
    this.config = normalizeConfig(s.config);
    this.ownerId = s.ownerId ?? null;
    this.seats = own(s.seats).map((seat) => ({ ...seat }));
    this.plan = own(s.plan);
    this.roundIndex = Number.isInteger(s.roundIndex) ? s.roundIndex : -1;
    this.dealerSeat = Number(s.dealerSeat) || 0;
    this.totals = own(s.totals);
    // RE-FROZEN ON THE WAY IN. A snapshot has been through JSON, and JSON has
    // no idea what a frozen object is — every record and every array inside it
    // comes back plain. Without this the immutability guarantee that _endRound
    // and _say establish would hold for a match played straight through and
    // silently lapse for one resumed from a reload, which is the worse of the
    // two halves to lose: resume is exactly when history is longest and the
    // scoreboard has the most to draw from it.
    //
    // freezeRound also copies, so this line de-aliases the records as well as
    // sealing them — the same guarantee `own` gives every other field here,
    // arrived at by a different route. Both are needed: own() copies the
    // history ARRAY, freezeRound copies the records IN it.
    this.history = own(s.history).map(freezeRound);
    this.roundSize = Number(s.roundSize) || 0;
    this.trump = s.trump ?? null;
    this.turnUpCard = s.turnUpCard ?? null;
    this.turnUpShown = s.turnUpShown === true;
    // own() TWICE, because hands is an array of arrays and the inner one is
    // the one that gets dealt into. The outer copy alone would leave seat
    // three's hand shared with the snapshot.
    this.hands = own(s.hands).map((h) => own(h));
    this.stock = own(s.stock);
    this.bids = own(s.bids);
    this.bidOrder = own(s.bidOrder);
    this.tricksWon = own(s.tricksWon);
    this.trickIndex = Number(s.trickIndex) || 0;
    this.plays = own(s.plays).map((p) => ({ ...p }));
    // Rebuilt a level deeper than it looks: the record is new, its plays array
    // is new, and so is every play in it — matching what serialize() and
    // publicState() already do for the same shape.
    this.tricks = own(s.tricks).map((t) => ({
      plays: own(t && t.plays).map((p) => ({ ...p })),
      winner: t && t.winner,
    }));
    this.leadSeat = Number(s.leadSeat) || 0;
    this.turnSeat = Number(s.turnSeat) || 0;
    // The only object-valued field a snapshot carries whole, and the one place
    // `own` cannot be the answer. Spread rather than naming plays/winner/card/
    // trickIndex, so a fifth field added in _finishTrick survives a reload
    // without anybody remembering this line. The `typeof` test is why garbage
    // in the slot lands on null instead of being adopted as a trick record.
    this.lastTrick = s.lastTrick && typeof s.lastTrick === 'object'
      ? { ...s.lastTrick, plays: own(s.lastTrick.plays).map((p) => ({ ...p })) }
      : null;
    this.sweepAt = s.sweepAt ?? null;
    this.log = own(s.log).map((l) => Object.freeze({ ...l }));

    // Everyone is assumed gone until they say otherwise. A restored host has
    // no connections yet, and showing six green dots to a table of nobody is
    // the kind of wrong that stops the owner realising they need to re-share
    // the room code. Bots are always present, so they are exempt.
    for (const seat of this.seats) if (!seat.isBot) seat.connected = false;

    return { ok: true, phase: this.phase };
  }

  // ###########################################################################
  //
  //  INTERNALS
  //
  // ###########################################################################

  _enter(phase, now) {
    this.phase = phase;
    this.phaseAt = now;
  }

  _name(seat) {
    return this.seats[seat] ? this.seats[seat].name : `seat ${seat}`;
  }

  /**
   * Append a line to the rolling log.
   *
   * These strings are the ONLY narration there is: js/ui.js pushes them
   * straight into the aria-live region, so a player using a screen reader
   * learns what trump is, who took the trick and what everybody scored from
   * exactly these sentences and nothing else. Written to be read aloud —
   * "Hearts are trumps", not "trump: H".
   *
   * FROZEN, for the same reason the history records are: publicState() slices
   * this array but hands out the entries themselves, so an entry is reachable
   * from every peer's copy of the public state. The array is a copy and the
   * entry is not, which is the distinction that makes `pub.log.at(-1).text =
   * ...` look local and be global. Nothing in the app writes to a log line —
   * ui.js reads .text and .kind — and this is what keeps it that way.
   *
   * The array itself is still mutated below, deliberately. The cap is the
   * engine's business and the frozen thing is the line, not the ledger.
   */
  _say(text, kind = 'system', seat = null) {
    this.log.push(Object.freeze({ text, kind, seat, round: this.roundIndex }));
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }
}

// Short, and distinguishable when spoken across a table — the log says
// "Robin takes it" and a screen reader reads it aloud. Ambiguous-sounding
// pairs are avoided for the same reason.
const BOT_NAMES = Object.freeze(['Robin', 'Asha', 'Kito', 'Vera', 'Milo', 'Noor', 'Dara']);

// Re-exported so the UI and the bot can import the vocabulary they need from
// the engine they are already importing, rather than reaching past it into
// three rules modules and risking a second, divergent notion of "legal".
export {
  NO_TRUMP, MIN_PLAYERS, MAX_PLAYERS,
  suitName, trumpName, cardName,
  legalPlays, canPlay, trickWinner, nextSeat, seatsFrom,
  legalBids, forbiddenBid, matchShape, roundPlan,
};
