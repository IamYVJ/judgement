// ============================================================================
// intents.js — The one place a message from a device turns into a call on the
// engine.
//
// WHY ONE DISPATCHER, AND WHY ON DAY ONE
//   Two things will eventually be authoritative: the host tab today, and a
//   server later (js/config.js already carries the seams). If each wrote its
//   own switch statement they would drift — one would grow an owner check the
//   other never got, or accept a field the other ignores — and the bug would
//   surface as two devices disagreeing about who took a trick, three rounds
//   after the message that caused it.
//
//   In `sequence` this file was retrofitted, and the rework was the expensive
//   kind: by then every call site had its own answer, so the refactor was not
//   "add a dispatcher" but "find all of them". The brief is explicit that this
//   one exists from the start. It costs nothing while there is one transport.
//
//   It also means the answer to "what can a client ask this host to do?" is a
//   list you can read at the top of a file, rather than something you
//   reconstruct by grepping net.js.
//
// WHAT THIS IS NOT
//   Not a transport. Nothing here knows about PeerJS, sockets, broadcasts, or
//   who else is in the room. It takes an actor id and a plain object and
//   returns a plain object.
//
//   Not the whole protocol. Joining, leaving, room queries, state sync and
//   heartbeats stay with the transport, because they are about the CONNECTION
//   rather than the game — the engine has no opinion about them and a server
//   would answer them completely differently. This file handles only the
//   messages that change the game.
//
//   Not rule enforcement, and not the owner check either. Every case below
//   calls straight through to a method that checks the phase, the seat, the
//   turn, the card and — for the five setup calls — the owner, all for itself.
//   What this file adds is the conversion of wire values into arguments the
//   engine can be handed safely, and a written-down, load-time-checked record
//   of which calls are owner-only.
//
// THE CLOCK IS A PARAMETER
//   The engine never reads a clock — a standing rule of this codebase, and
//   what lets the harness play thousands of complete matches in a few seconds
//   and replay any failure exactly. So `now` is threaded through here rather
//   than resolved here, and it DEFAULTS TO 0 RATHER THAN Date.now(): a caller
//   that forgets gets a phase stamped at zero, which the very first tick()
//   steps past and which any test notices immediately. A hidden Date.now()
//   would instead work perfectly until the day something needed replaying.
// ============================================================================

import {
  validBid, validCardCode, validConfigPatch, validName, validSeat,
} from './guards.js';

/**
 * Anything a seated player may send about their own turn.
 *
 * Both are checked BY SEAT inside the engine — sending someone else's move is
 * refused there and not here, because only the engine knows whose turn it is,
 * and because the answer changes between the moment a message is framed and
 * the moment it arrives.
 */
export const PLAYER_INTENTS = Object.freeze(['placeBid', 'playCard']);

/**
 * Anything only the room's owner may send.
 *
 * `ownerId` is who holds the controls. It has NOTHING to do with which tab is
 * running the engine — that is `isHost`, it lives in js/net.js, and the two
 * are kept apart deliberately and from the start (see the header of
 * js/state.js). In v1 the same tab happens to be both. Gating on isHost here
 * would work perfectly right up until the day it did not.
 */
export const OWNER_INTENTS = Object.freeze([
  'setConfig', 'addBot', 'removeSeat', 'startMatch', 'nextRound',
]);

export const GAME_INTENTS = Object.freeze([...PLAYER_INTENTS, ...OWNER_INTENTS]);

// ---------------------------------------------------------------------------
// Where the owner check happens: the engine, every time, and only there.
//
// THIS IS A DELIBERATE DEPARTURE FROM courtpiece, which splits its owner
// intents into ones the engine checks and ones intents.js checks. That split
// is right there and wrong here, and the difference is in the engine's
// signatures. Court Piece's lobby methods take no actor at all — `addBot(seat)`
// — because the app itself seats bots during startMatch() with no player
// behind the call, so something outside has to do the checking. Every method
// named below takes `actorId` as its first argument and runs `_isOwner()` on
// it. Adding a second check here would mean two places to get it wrong, and
// the one that must be right is the engine's, because a future server calls
// the engine directly and never passes through this file at all.
//
// So SELF_GUARDED is a CLAIM ABOUT THE ENGINE, and the two mechanisms below
// keep it honest:
//
//   1. The loop runs at module load and requires OWNER_INTENTS and
//      SELF_GUARDED to be the same set. Adding a sixth owner intent without
//      saying where it is gated throws on import rather than shipping as a
//      hole — including in the browser, on the first page load, loudly.
//
//   2. The harness sweeps SELF_GUARDED and, for each name, drives the real
//      engine into a state where that call would succeed and then makes it
//      from a non-owner seat, asserting the refusal. The list is not trusted;
//      it is exercised. That is what makes this stronger than the declaration
//      it replaces, and it is checked against the export rather than against a
//      copy of the list, so a new intent is swept the moment it is added.
// ---------------------------------------------------------------------------
export const SELF_GUARDED = Object.freeze([
  'setConfig', 'addBot', 'removeSeat', 'startMatch', 'nextRound',
]);

for (const type of OWNER_INTENTS) {
  if (!SELF_GUARDED.includes(type)) {
    throw new Error(`intents.js: owner intent '${type}' does not say where it is gated`);
  }
}
for (const type of SELF_GUARDED) {
  if (!OWNER_INTENTS.includes(type)) {
    throw new Error(`intents.js: '${type}' is claimed owner-guarded but is not an owner intent`);
  }
}

/**
 * Every OTHER public method of GameEngine: the ones that exist, are callable,
 * and are deliberately not reachable from the wire.
 *
 * COMPLETE ON PURPOSE. Together with GAME_INTENTS this accounts for the whole
 * public surface of the engine, and the harness asserts exactly that against
 * GameEngine.prototype: every public method is in one list or the other, and
 * in only one. A new engine method therefore fails the suite until somebody
 * has decided which side of the wire it lives on, which is the decision that
 * is easy to not make.
 *
 * An absence is invisible, so the ones with a reason are given it:
 *
 *   reset                   Wipes the match. Exposing this would be a
 *                           one-message reset of nineteen rounds of six
 *                           people's scores, from anybody who found the room.
 *
 *   addPlayer, disconnect   Connection lifecycle. js/net.js calls them when a
 *                           data channel opens and closes. A peer does not
 *                           announce its own arrival as a game move; the
 *                           transport knows who connected, because it is the
 *                           thing they connected to.
 *
 *   tick                    The clock. Driven by the host's animation frame,
 *                           never by a message — a peer that could call tick()
 *                           could sweep a trick off the table before anybody
 *                           at it had looked up.
 *
 *   serialize, restore      Persistence, host-local, localStorage under the
 *                           `judgement.` prefix. serialize() contains every
 *                           hand in the game; see the shouting at it in
 *                           state.js. restore() would let a peer install a
 *                           match of its own choosing.
 *
 *   resumeAsOwner           THE INTERESTING ONE. It takes an id and hands that
 *                           id the room, with no check of any kind — correct
 *                           for its actual caller (the host tab, after
 *                           restore(), reinstating an owner who is not seat
 *                           zero) and a free ownership grab for anybody if it
 *                           were exposed. It cannot simply be owner-gated
 *                           instead, because the entire point of it is to run
 *                           when there is no reachable owner.
 *
 *                           There is a real gap underneath that. Mid-match,
 *                           disconnect() does not promote an heir — it must
 *                           not, the seat is holding a hand and a score — so
 *                           an owner whose battery dies leaves nobody able to
 *                           press "next round". In v1 the owner's tab IS the
 *                           host's tab, so that scenario ends the room anyway
 *                           and the gap is theoretical. It stops being
 *                           theoretical the moment host and owner come apart,
 *                           which is the thing js/config.js is a seam for.
 *                           FLAGGED, NOT FIXED: inventing a claim-the-room
 *                           rule is a design decision, not a checkpoint-5
 *                           tidy-up, and it belongs with net.js.
 *
 *   seatOf, startBlocker,   Read-only. A client does not need to ask the host
 *   bidOptionsFor,          any of these, because the answers are already in
 *   leaders, publicState,   the state it is sent on every change — and making
 *   privateStateFor         them askable would add a request path whose only
 *                           use is to be spammed.
 */
export const LOCAL_ONLY = Object.freeze([
  'reset', 'addPlayer', 'disconnect', 'seatOf', 'resumeAsOwner', 'startBlocker',
  'tick', 'bidOptionsFor', 'leaders', 'publicState', 'privateStateFor',
  'serialize', 'restore',
]);

for (const type of LOCAL_ONLY) {
  if (GAME_INTENTS.includes(type)) {
    throw new Error(`intents.js: '${type}' is both wire-reachable and local-only`);
  }
}

/**
 * Apply one game message.
 *
 * Returns `{ handled, result }`.
 *
 *   handled false  This is not a game intent at all and the transport should
 *                  keep looking — a join, a sync request, a heartbeat,
 *                  something from a newer client. `result` is null.
 *   handled true   It WAS a game intent. `result` is `{ ok: true, ... }` or
 *                  `{ ok: false, error }`, and a refusal should be shown to
 *                  the sender and to nobody else. A failed bid is not news to
 *                  the rest of the table.
 *
 * NEVER THROWS ON A MESSAGE, whatever arrives — null, a number, an array, an
 * object whose every field is hostile. Every path either validates its
 * argument or calls a method that returns a refusal instead of raising. A
 * hostile peer gets a `{ ok: false }`, not a dead host tab and six people
 * staring at a frozen scoreboard.
 *
 * It does NOT catch exceptions from the engine, and the difference matters. If
 * deal() throws because the round plan asked for more cards than the deck
 * holds, that is an invariant violation in code I wrote, not a bad message —
 * and a try/catch here would turn it into a tap that quietly did nothing while
 * the match limped on in a state nobody can reason about. state.js says "do
 * not catch it" at the throw site; this is the other half of that sentence.
 */
export function applyGameIntent(engine, actorId, msg, now = 0) {
  const type = msg && msg.type;
  if (typeof type !== 'string') return { handled: false, result: null };

  switch (type) {
    // --- A player's own turn ---------------------------------------------

    case 'placeBid': {
      // Shape only. Whether 3 is a legal bid depends on the round size, on
      // what the others have already bid, on whether this seat is the dealer
      // and on whether the hook is switched on — four things this file cannot
      // see and the engine has to hand. bidIsLegal() is the enforcement point
      // and produces the sentence the screen reader reads.
      const bid = validBid(msg.bid);
      if (bid === null) return done({ ok: false, error: 'That is not a bid.' });
      return done(engine.placeBid(actorId, bid, now));
    }

    case 'playCard': {
      // Validated rather than passed through because canPlay() would otherwise
      // compare a 60 KiB string against every card in a hand. The engine still
      // decides whether a well-formed card is a legal one, and whether this
      // player even holds it — this only decides whether it is a card.
      const code = validCardCode(msg.code);
      if (code === null) return done({ ok: false, error: 'That is not a card.' });
      return done(engine.playCard(actorId, code, now));
    }

    // --- The lobby, owner-checked inside the engine ----------------------

    case 'setConfig': {
      // `msg.patch`, and the name is load-bearing rather than incidental. The
      // lobby sends `{ type: 'setConfig', patch }`, validConfigPatch() is
      // documented as taking "a config patch as the lobby sends it", and the
      // engine method is setConfig(actorId, patch) — four places, one word.
      // This line read `msg.config` for a while and the entire lobby was dead:
      // every control returned "That is not a setting." because undefined does
      // not validate. The suite did not catch it because the tests called this
      // dispatcher with a frame no producer emits. See the main.js <-> this
      // file field-agreement section in scripts/test-engine.mjs, which now
      // crosses the seam the unit tests could not.
      const patch = validConfigPatch(msg.patch);
      if (patch === null) return done({ ok: false, error: 'That is not a setting.' });
      return done(engine.setConfig(actorId, patch));
    }

    case 'addBot': {
      // A name that fails the guard is treated exactly as an absent one, which
      // means "you pick" and is what the plain "Add bot" button sends. There
      // is nothing to get wrong: the bot gets a name from BOT_NAMES either
      // way, and refusing to seat a bot over a cosmetic field would be
      // refusing the useful half of the request because the decorative half
      // was malformed.
      const name = msg.name === undefined || msg.name === null ? null : validName(msg.name);
      return done(engine.addBot(actorId, name));
    }

    case 'removeSeat': {
      // Unlike addBot, a bad seat is REFUSED rather than defaulted. Guessing
      // which chair somebody meant to empty is worse than asking again — and
      // see validSeat() in js/guards.js for what a '__proto__' that reached
      // the engine would actually do to this room.
      const seat = validSeat(msg.seat);
      if (seat === null) return done({ ok: false, error: 'That is not a seat.' });
      return done(engine.removeSeat(actorId, seat));
    }

    // --- Match flow, owner-checked inside the engine ---------------------

    case 'startMatch': return done(engine.startMatch(actorId, now));
    case 'nextRound':  return done(engine.nextRound(actorId, now));

    default:
      return { handled: false, result: null };
  }
}

// Every engine method reachable from here already returns `{ ok, ... }`, so
// the fallback covers the one that later does not. Treating a missing return
// as success rather than failure matches what such a method would mean: it did
// the thing and had nothing to report.
function done(result) {
  return { handled: true, result: result || { ok: true } };
}
