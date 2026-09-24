// ============================================================================
// ui.js — all rendering, and nothing else.
//
//   render(root, app, intents)
//
// A PURE VIEW. Given the same `app` it builds the same DOM, every time. It
// never touches the network, never calls the engine, never reads a clock and
// never keeps state of its own. Everything it can do to the world it does by
// calling something on `intents`.
//
// ---------------------------------------------------------------------------
// THE CONTRACT — what `app` must hold
// ---------------------------------------------------------------------------
// js/main.js does not exist yet (it lands with the transport), so this is the
// shape it will have to satisfy, written down where the consumer lives:
//
//   screen    'home' | 'join' | 'connecting' | 'error' | 'hostleft'
//             | 'replaced' | 'game'
//   me        { name }                    what this device calls itself
//   code      'ABCD' | ''                 the room code, for display and copy
//   pub       publicState() | null        from js/state.js, verbatim
//   priv      privateStateFor() | null    from js/state.js, verbatim
//   isHost    boolean                     THIS DEVICE RUNS THE ENGINE
//   error     string | null               the last refusal, already humanised
//   selected  card code | null            tapped, not yet played
//   selectedBid number | null             tapped, not yet submitted
//   showPad   boolean                     the full score pad is open
//   showLog   boolean                     the log drawer is open
//   announce  string                      copied into #announce by main.js
//   busy      boolean                     an intent is in flight
//   reconnecting / netWarning             transport noise, drawn over the top
//
// ---------------------------------------------------------------------------
// isHost IS NOT isOwner, AND THIS FILE MUST NEVER CONFUSE THEM
// ---------------------------------------------------------------------------
// `app.isHost` is a fact about the DEVICE: it holds the authoritative engine
// and answers everyone else's messages. `priv.isOwner` is a fact about the
// PLAYER: they are allowed to change the settings, add bots and start the
// match. They are usually the same person and they are not the same thing —
// the engine hands ownership on when an owner leaves (see `_say('… is now the
// host')` in js/state.js) without any device changing role.
//
// So: every owner-only control in here is gated on `priv.isOwner`, never on
// `app.isHost`. The only thing gated on isHost is the room code, because that
// is a property of the device that is listening. Getting this backwards
// produces a lobby where the person who happens to be hosting can change the
// rules out from under the owner, and it looks completely normal.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE IS NOT ALLOWED TO KNOW
// ---------------------------------------------------------------------------
// It renders `pub` and `priv` and nothing else. It never reaches for a hand it
// was not given, and it cannot: hands are not in publicState() at all, and the
// turn-up card arrives as null until the reveal moment. That is the privacy
// boundary doing its job — the UI could not leak a hidden card if it tried,
// because the data is not in the building.
//
// Legality is the same story from the other side. Greyed cards come from
// `priv.hand[].legal`, which the engine computed with the same canPlay() it
// enforces with. The grey is a CONVENIENCE. The host is the enforcement point,
// and a tap on an illegal card is refused there whatever this file drew.
// ============================================================================

import { el, clear, score as fmtScore, delta as fmtDelta, plural } from './util.js';
import {
  MIN_PLAYERS, MAX_PLAYERS, NO_TRUMP,
  isTrumpSuit, isRedCard, isRedSuit, suitOf, suitGlyph, rankLabel, cardName,
  trumpGlyph, trumpName, suitName,
  SCORING_LABELS, TRUMP_METHOD_LABELS, SHAPE_LABELS,
  axisLabel, PRESETS, presetMatching, effectiveMaxHand, maxHandSize,
  needsTurnUp, trumpForRound, MAX_NAME_LEN,
} from './rules.js';
import { PHASES } from './state.js';
// From trick.js DIRECTLY, not through state.js's re-export list, which does not
// carry ledSuitOf anyway. Same import line bot.js uses, and for the same reason:
// these two are pure functions over a plays array, they belong to the trick
// module, and routing them through the engine would suggest this file has some
// relationship with the engine that it does not have.
import { trickWinner, ledSuitOf } from './trick.js';

// ###########################################################################
//
//  ENTRY
//
// ###########################################################################

export function render(root, app, intents) {
  // Lesson 1 from the family, and the reason #announce and the footer are
  // siblings of #app in index.html rather than children: this wipes every
  // child of root on every frame. A live region only fires when text inside an
  // already-present node changes, so a region rebuilt each frame never speaks.
  clear(root);

  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'join':       node = joinScreen(app, intents); break;
    case 'connecting': node = connectingScreen(app, intents); break;
    case 'error':      node = errorScreen(app, intents); break;
    case 'hostleft':   node = hostLeftScreen(app, intents); break;
    case 'replaced':   node = replacedScreen(app, intents); break;
    case 'game':       node = gameScreen(app, intents); break;
    default:           node = homeScreen(app, intents);
  }
  root.appendChild(node);

  // Overlays last, so they sit above whatever is underneath and the game stays
  // visible behind them rather than being replaced by them.
  if (app.showPad && app.pub) root.appendChild(padOverlay(app, intents));
  if (app.showLog && app.pub) root.appendChild(logOverlay(app, intents));
  if (app.reconnecting) root.appendChild(reconnectBanner(app));
  else if (app.netWarning) root.appendChild(netBanner(app, intents));
}

// ###########################################################################
//
//  SHARED CHROME
//
// ###########################################################################

function shell(...kids) { return el('main', { class: 'shell' }, ...kids); }

// The play screen gives up the shell's top padding, because the strip is flush
// to the top edge and carries the notch inset itself. Same trick as sequence's
// shell-play, and for the same reason: two bars pinned to opposite edges of the
// viewport with the live content between them.
function playShell(...kids) { return el('main', { class: 'shell shell-play' }, ...kids); }

// THE ONLY WAY INTO THE RULES, so it is a function rather than four copies of
// the same button.
//
// It used to be inlined in wordmark() — which renders on home, join,
// connecting, error, hostleft and the lobby, and on none of the screens where
// a card is actually in front of you. The rules were therefore unreachable
// from the moment the match started, which is the first moment a new player
// needs them and the only moment they cannot go and look somewhere else.
//
// `cls` is the one thing that varies: the strip is a 10px row and cannot
// carry the 30px circle the wordmark uses. Everything else — the accessible
// name, the title, the data-focus token that survives the destructive
// re-render — is identical everywhere on purpose, because a control that
// moves and renames itself between screens is a control people stop looking
// for. Only ever one in a frame, so the shared focus token cannot collide.
function helpBtn(intents, cls = 'help-btn') {
  return el('button', {
    class: cls, 'aria-label': 'How to play', title: 'How to play',
    'data-focus': 'help', onclick: () => intents.toggleRules(),
  }, '?');
}

function wordmark(intents) {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }),
    el('span', { class: 'wordmark-text' }, 'JUDGEMENT'),
    helpBtn(intents),
  );
}

// Carries the text as an ATTRIBUTE rather than speaking it. See render():
// the real live region is the persistent #announce node outside #app, and
// main.js copies this across once the frame is in the document.
function liveRegion(text) {
  return el('div', { class: 'sr-only', 'data-announce': text || '' });
}

function errorNote(app) {
  if (!app.error) return null;
  // role=alert rather than the live region, because a refusal is about
  // something the player just did and should interrupt. The live region is for
  // the running commentary of other people's moves.
  return el('p', { class: 'error-note', role: 'alert' }, app.error);
}

function reconnectBanner(app) {
  return el('div', { class: 'reconnect-banner', role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'spinner spinner-sm' }),
    el('span', {}, 'Lost the host — reconnecting…'),
  );
}

// The host's link to the signalling broker is in trouble; the links to the
// people already at the table are direct and unaffected. So this is a notice,
// not an interruption, and it is dismissible.
function netBanner(app, intents) {
  return el('div', { class: 'reconnect-banner net-banner', role: 'status', 'aria-live': 'polite' },
    el('span', {}, app.netWarning),
    el('button', { class: 'banner-close', 'aria-label': 'Dismiss', onclick: intents.dismissNetWarning }, '✕'),
  );
}

function backRow(label, onclick) {
  return el('div', { class: 'btn-row' },
    el('button', { class: 'btn btn-secondary', onclick }, label));
}

// ###########################################################################
//
//  HOME, JOIN, AND THE DEAD ENDS
//
// ###########################################################################

function nameField(app, intents) {
  return el('input', {
    class: 'field', type: 'text', maxlength: String(MAX_NAME_LEN),
    placeholder: 'Your name', value: app.me.name || '',
    'aria-label': 'Your name', 'data-focus': 'name',
    oninput: (e) => intents.setName(e.target.value),
  });
}

function homeScreen(app, intents) {
  const named = !!(app.me.name || '').trim();
  return shell(
    wordmark(intents),
    el('p', { class: 'tagline' }, 'Bid exactly. Take exactly. Anything else is nothing.'),
    el('div', { class: 'panel' },
      nameField(app, intents),
      el('div', { class: 'btn-row' },
        // Disabled rather than hidden, with the reason underneath: a button
        // that appears when you finish typing is a button people do not know
        // is coming.
        el('button', {
          class: 'btn btn-primary', disabled: !named,
          onclick: () => intents.host(),
        }, 'HOST A GAME'),
        el('button', {
          class: 'btn btn-secondary', disabled: !named,
          onclick: () => intents.goJoin(),
        }, 'JOIN A GAME'),
      ),
      !named && el('p', { class: 'hint' }, 'Put a name in first — the table needs something to call you.'),
    ),
    errorNote(app),
    liveRegion(app.announce),
  );
}

function joinScreen(app, intents) {
  return shell(
    wordmark(intents),
    el('div', { class: 'panel' },
      el('h2', {}, 'Join a game'),
      el('input', {
        class: 'field field-code', type: 'text', inputmode: 'latin',
        autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
        maxlength: '4', placeholder: 'CODE', value: app.code || '',
        'aria-label': 'Room code', 'data-focus': 'code',
        oninput: (e) => intents.setCode(e.target.value),
      }),
      el('p', { class: 'hint' }, 'Four characters, from whoever is hosting.'),
      el('div', { class: 'btn-row' },
        el('button', {
          class: 'btn btn-primary', disabled: (app.code || '').length !== 4,
          onclick: () => intents.join(app.code),
        }, 'JOIN'),
        el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'BACK'),
      ),
    ),
    errorNote(app),
    liveRegion(app.announce),
  );
}

function connectingScreen(app, intents) {
  return shell(
    wordmark(intents),
    el('div', { class: 'panel panel-centre' },
      el('span', { class: 'spinner' }),
      el('h2', {}, 'Connecting…'),
      // Always an exit. A host listed on the broker but unreachable over
      // WebRTC produces no error at all — it simply never connects — so
      // without this the only way out is a page reload.
      el('p', { class: 'hint' }, `Looking for room ${app.code}. This can take a few seconds.`),
      backRow('✕ CANCEL', intents.cancelJoin),
    ),
    liveRegion(app.announce),
  );
}

function errorScreen(app, intents) {
  return shell(
    wordmark(intents),
    el('div', { class: 'panel' },
      el('h2', {}, 'That did not work'),
      el('p', {}, app.error || 'Something went wrong.'),
      backRow('‹ BACK HOME', intents.goHome),
    ),
    liveRegion(app.announce),
  );
}

function hostLeftScreen(app, intents) {
  return shell(
    wordmark(intents),
    el('div', { class: 'panel' },
      el('h2', {}, 'Host left'),
      // Peer-to-peer means the engine lived on their device and went with it.
      // There is nothing to rejoin, and saying so is kinder than a retry
      // button that can never succeed.
      el('p', {}, 'The game ran on the host’s phone, so it has gone with them. Thanks for playing.'),
      backRow('‹ BACK HOME', intents.goHome),
    ),
    liveRegion(app.announce),
  );
}

/**
 * The seat went to another tab on this same device.
 *
 * SIBLING OF hostLeftScreen, NOT A VARIANT OF IT, and for the same reason it
 * exists at all: both are terminal, and the thing that makes them terminal is
 * that there is nothing useful to press. A "RECONNECT" button here would be a
 * button whose entire effect is to take the seat off the tab that currently
 * has it and hand this one the same screen — the loop the whole fix is about,
 * with a finger on it. So there is one action and it goes home.
 *
 * The wording names the cause rather than the symptom. "Disconnected" is true
 * and useless; somebody who does not know they have two tabs open cannot act
 * on it, and somebody who does will close one.
 */
function replacedScreen(app, intents) {
  return shell(
    wordmark(intents),
    el('div', { class: 'panel' },
      el('h2', {}, 'Open in another tab'),
      el('p', {}, 'This table is open in a newer tab on this device, and your seat went with it. You can close this one.'),
      backRow('‹ BACK HOME', intents.goHome),
    ),
    liveRegion(app.announce),
  );
}

// ###########################################################################
//
//  THE GAME — one dispatch on phase
//
// ###########################################################################

function gameScreen(app, intents) {
  const { pub } = app;
  if (!pub) return connectingScreen(app, intents);

  switch (pub.phase) {
    case PHASES.LOBBY:        return lobbyScreen(app, intents);
    case PHASES.ROUND_DEAL:   return dealScreen(app, intents);
    case PHASES.TRUMP_REVEAL: return revealScreen(app, intents);
    case PHASES.BIDDING:      return biddingScreen(app, intents);
    case PHASES.PLAY:         return playScreen(app, intents);
    case PHASES.ROUND_OVER:   return roundOverScreen(app, intents);
    case PHASES.MATCH_OVER:   return matchOverScreen(app, intents);
    default:                  return lobbyScreen(app, intents);
  }
}

// ###########################################################################
//
//  LOBBY
//
// ###########################################################################

function lobbyScreen(app, intents) {
  const { pub, priv } = app;
  const owner = !!(priv && priv.isOwner);
  const n = pub.seats.length;
  const blocker = pub.startBlocker;

  return shell(
    wordmark(intents),
    roomCard(app, intents),
    el('div', { class: 'panel' },
      el('h2', {}, `Table · ${plural(n, 'player')}`),
      el('ul', { class: 'seat-list' }, pub.seats.map((s) => seatRow(s, app, intents, owner))),
      owner && n < MAX_PLAYERS && el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-ghost', onclick: () => intents.addBot() }, '+ ADD A BOT'),
      ),
      // Not plural() here: it pluralises the WORD, and "more" is not a count
      // noun. "2 mores to go" is what that reads as.
      n < MIN_PLAYERS && el('p', { class: 'hint' },
        `Needs ${MIN_PLAYERS} to start. ${MIN_PLAYERS - n} more to go — or fill the seats with bots.`),
    ),
    configCard(app, intents, owner),
    el('div', { class: 'panel' },
      owner
        ? el('button', {
          class: 'btn btn-primary btn-wide', disabled: !!blocker || app.busy,
          onclick: () => intents.startMatch(),
        }, blocker ? 'NOT READY' : 'START THE MATCH')
        : el('p', { class: 'hint' }, 'Waiting for the owner to start.'),
      // The engine's own sentence, not a second copy of the rule. If
      // startBlocker() gains a case, this shows it without being edited.
      blocker && owner && el('p', { class: 'hint' }, blocker),
    ),
    errorNote(app),
    liveRegion(app.announce),
  );
}

function roomCard(app, intents) {
  // Gated on isHost, and this is the ONE thing in the file that legitimately
  // is — the code identifies the device other people dial, which has nothing
  // to do with who owns the game.
  if (!app.isHost || !app.code) return null;
  return el('div', { class: 'panel panel-code' },
    el('p', { class: 'code-lede' }, 'Others join with'),
    el('p', { class: 'code' }, app.code),
    el('button', { class: 'btn btn-ghost', onclick: () => intents.copyCode() }, 'COPY'),
  );
}

function seatRow(s, app, intents, owner) {
  const me = app.priv && app.priv.seat === s.seat;
  return el('li', { class: `seat-row${me ? ' me' : ''}${s.connected ? '' : ' gone'}` },
    el('span', { class: 'seat-no' }, String(s.seat + 1)),
    el('span', { class: 'seat-row-name' }, s.name),
    s.isOwner && el('span', { class: 'tag tag-owner' }, 'OWNER'),
    s.isBot && el('span', { class: 'tag tag-bot' }, 'BOT'),
    !s.connected && !s.isBot && el('span', { class: 'tag tag-gone' }, 'AWAY'),
    // An owner may clear a seat, but not their own — leaving is a different
    // action with different consequences and it does not belong on this row.
    owner && !s.isOwner && el('button', {
      class: 'seat-kick', 'aria-label': `Remove ${s.name}`,
      onclick: () => intents.removeSeat(s.seat),
    }, '✕'),
  );
}

// --- the four axes ---------------------------------------------------------

function configCard(app, intents, owner) {
  const { pub } = app;
  const cfg = pub.config;
  const players = pub.seats.length;
  const preset = presetMatching(cfg);
  const shape = pub.shape;   // null until MIN_PLAYERS are seated

  return el('div', { class: 'panel' },
    el('h2', {}, 'The game'),

    el('div', { class: 'preset-row' }, PRESETS.map((p) => el('button', {
      class: `preset${preset === p.id ? ' on' : ''}`,
      disabled: !owner, 'aria-pressed': preset === p.id ? 'true' : 'false',
      onclick: () => intents.applyPreset(p.id),
    }, p.label))),
    el('p', { class: 'hint' }, preset
      ? PRESETS.find((p) => p.id === preset).blurb
      // Not an error state. The presets are three points in a space of 54
      // games and wandering off them is the normal way to use the toggles.
      : 'Custom — your own corner of the rules.'),

    axisPicker('Scoring', SCORING_LABELS, cfg.scoring, owner,
      (v) => intents.setConfig({ scoring: v })),
    axisPicker('Trump', TRUMP_METHOD_LABELS, cfg.trumpMethod, owner,
      (v) => intents.setConfig({ trumpMethod: v })),
    axisPicker('Shape', SHAPE_LABELS, cfg.shape, owner,
      (v) => intents.setConfig({ shape: v })),

    el('div', { class: 'axis' },
      el('label', { class: 'axis-name', for: 'hook' }, 'The hook'),
      el('button', {
        id: 'hook', class: `toggle${cfg.hook ? ' on' : ''}`, disabled: !owner,
        role: 'switch', 'aria-checked': cfg.hook ? 'true' : 'false',
        onclick: () => intents.setConfig({ hook: !cfg.hook }),
      }, cfg.hook ? 'ON' : 'OFF'),
      el('p', { class: 'hint' }, cfg.hook
        ? 'The dealer may not make the bids total the tricks. Somebody always fails.'
        : 'Anything goes. It is possible for everybody to make their bid.'),
    ),

    maxHandPicker(app, intents, owner),

    // What the choices ADD UP TO. Four dropdowns tell you nothing about
    // whether you have time for this before dinner; matchShape() does.
    shape && el('p', { class: 'shape-line' },
      `${shape.rounds} rounds · ${shape.tricks} tricks · about ${shape.minutes} minutes`),
    !shape && el('p', { class: 'hint' }, `Seat ${MIN_PLAYERS} players to see how long a match runs.`),
  );
}

function axisPicker(name, labels, value, owner, onpick) {
  const keys = Object.keys(labels);
  return el('div', { class: 'axis' },
    el('span', { class: 'axis-name' }, name),
    el('div', { class: 'axis-opts', role: 'radiogroup', 'aria-label': name },
      keys.map((k) => el('button', {
        class: `chip${k === value ? ' on' : ''}`, disabled: !owner,
        role: 'radio', 'aria-checked': k === value ? 'true' : 'false',
        onclick: () => onpick(k),
      }, labels[k].label))),
    el('p', { class: 'hint' }, labels[value] ? labels[value].blurb : ''),
  );
}

// The biggest hand of the match. Capped by the deck, not by taste: seven
// players cannot be dealt more than seven cards each, and under the turn-up
// method one card is held out, which can cost another. Both come from
// rules.js — the ceiling is never written down twice.
function maxHandPicker(app, intents, owner) {
  const { pub } = app;
  const players = pub.seats.length;
  if (players < MIN_PLAYERS) return null;

  const cap = maxHandSize(players, needsTurnUp(pub.config.trumpMethod));
  const now = effectiveMaxHand(pub.config, players);
  const auto = pub.config.maxHand === null;

  return el('div', { class: 'axis' },
    el('span', { class: 'axis-name' }, 'Biggest hand'),
    el('div', { class: 'axis-opts' },
      el('button', {
        class: `chip${auto ? ' on' : ''}`, disabled: !owner,
        'aria-pressed': auto ? 'true' : 'false',
        onclick: () => intents.setConfig({ maxHand: null }),
      }, 'Auto'),
      el('input', {
        class: 'slider', type: 'range', min: '1', max: String(cap), value: String(now),
        disabled: !owner, 'aria-label': 'Biggest hand',
        oninput: (e) => intents.setConfig({ maxHand: Number(e.target.value) }),
      }),
      el('span', { class: 'slider-val' }, String(now)),
    ),
    el('p', { class: 'hint' },
      `${plural(cap, 'card')} is the most ${plural(players, 'player')} can be dealt`
      + `${needsTurnUp(pub.config.trumpMethod) ? ', with one held out to turn up' : ''}.`),
  );
}

// ###########################################################################
//
//  THE TWO INTERSTITIALS
//
//  Both are pauses the engine is already holding (DEAL_PAUSE_MS,
//  REVEAL_PAUSE_MS) — this file only draws them. No timers here either.
//
// ###########################################################################

function dealScreen(app, intents) {
  const { pub } = app;
  return playShell(
    playStrip(app, intents),
    el('div', { class: 'interstitial' },
      el('p', { class: 'inter-big' }, `Round ${pub.roundIndex + 1}`),
      el('p', { class: 'inter-sub' }, `${plural(pub.roundSize, 'card')} each · ${nameOf(pub, pub.dealerSeat)} deals`),
      el('span', { class: 'spinner' }),
    ),
    liveRegion(app.announce),
  );
}

// The turn-up. The single most consequential thing anybody sees all round —
// it decides every bid that follows — which is why the engine holds it for
// 2.2 seconds and why it gets the whole screen here.
//
// NOTE ON THE LEAK THAT CANNOT HAPPEN: pub.turnUpCard is null until the engine
// sets turnUpShown. Before the reveal this renders the same as a round with no
// turn-up at all, because the card is genuinely not in the state object. The UI
// is not being careful — it has nothing to be careful with.
function revealScreen(app, intents) {
  const { pub } = app;
  const card = pub.turnUpCard;
  return playShell(
    playStrip(app, intents),
    el('div', { class: 'interstitial' },
      card
        ? el('div', { class: 'reveal' },
          cardFace(card, { big: true }),
          el('p', { class: 'inter-big' }, `${trumpName(pub.trump)} are trumps`),
          el('p', { class: 'inter-sub' }, 'This card sits out the round.'))
        : el('div', { class: 'reveal' },
          el('p', { class: 'inter-big' }, pub.trump === NO_TRUMP
            ? 'No trumps this round'
            : `${trumpName(pub.trump)} are trumps`),
          el('p', { class: 'inter-sub' }, pub.trump === NO_TRUMP
            ? 'Highest card of the led suit takes it. Nothing else does.'
            : 'From the rotation — known before the deal.')),
    ),
    liveRegion(app.announce),
  );
}

// ###########################################################################
//
//  THE PLAY STRIP — the one thing on screen at all times
//
//  The brief calls this the core information of the game: who bid what, and
//  how many they have actually taken. Someone sitting on 2-of-2 with tricks
//  left is the whole drama, and it has to be readable at a glance.
//
// ###########################################################################

/**
 * A seat's standing against its own bid: 'under', 'exact', 'over', or 'nobid'.
 *
 * FOUR STATES, AND js/bot.js HAS TWO. appetite() in the bot answers 'duck' for
 * both exact and over, and it is right to: for the purpose of choosing a card
 * they mean the same thing, which is stop winning tricks. For the purpose of
 * looking at a table they are triumph and disaster and must never be
 * confusable. So the duplication is deliberate and this is not a missing
 * import. ('nobid' never reaches the bot — a bot that is choosing a card has
 * already bid.)
 *
 * ---------------------------------------------------------------------------
 * A BID OF ZERO READS AS 'exact' THE MOMENT IT IS MADE, AND THAT IS INTENDED.
 * ---------------------------------------------------------------------------
 * seatState(0, 0) is 'exact', so a seat that bids nil takes the accent border
 * and tint during BIDDING, before a card has been played. That looks at first
 * like a phase bug — the glow that elsewhere means "they have got there" is
 * showing up before anyone could have got anywhere.
 *
 * It is not. A seat on 0 tricks against a bid of 0 genuinely IS exact, in
 * bidding as much as in play. The strip is telling the truth, and a nil bidder
 * IS in the position the accent describes: holding what they asked for, with
 * everything to lose. Suppressing it would mean the highlight appears later
 * for a reason the player cannot see.
 *
 * The alternative costs more than it buys. Treating bidding as a special case
 * needs a FIFTH visual state — 'nobid' cannot be borrowed for it, because that
 * means the seat has not bid at all and this seat has — plus a phase argument,
 * and this function is currently pure and phase-blind. Those are two
 * properties the exhaustive sweep in scripts/test-engine.mjs depends on: a
 * phase-dependent seatState is a seam between this file and whichever caller
 * knows the phase, which is exactly the kind of place the bugs in this repo
 * have lived.
 *
 * Exported because it is the whole visual language of the strip and the pad,
 * and a pure two-argument function is something a test can sweep exhaustively.
 */
export function seatState(bid, taken) {
  if (bid === null || bid === undefined) return 'nobid';
  const t = taken || 0;
  if (t < bid) return 'under';
  return t === bid ? 'exact' : 'over';
}

function nameOf(pub, seat) {
  const s = pub.seats[seat];
  return s ? s.name : '';
}

// Trump, as an indicator rather than a glyph in a sentence. No Trump gets a
// LETTERED BADGE and never a pip, because the entire point of the state is
// that it is not one of the four suits — the same distinction isTrumpSuit()
// makes in the engine, made visible.
function trumpTag(trump) {
  if (trump === NO_TRUMP) {
    return el('span', { class: 'trump nt', 'aria-label': 'no trump this round' },
      el('span', { class: 'badge' }, 'NT'), 'No trump');
  }
  if (!isTrumpSuit(trump)) {
    // Not yet turned. Deliberately identical to "this game has no turn-up",
    // because the client cannot tell those apart and should not pretend to.
    return el('span', { class: 'trump unknown', 'aria-label': 'trump not yet turned' },
      el('span', { class: 'badge' }, '?'), 'Trump');
  }
  return el('span', {
    class: `trump${isRedSuit(trump) ? ' red' : ''}`,
    'aria-label': `${suitName(trump)} are trumps`,
  }, el('span', { class: 'pip-suit' }, suitGlyph(trump)), suitName(trump));
}

function playStrip(app, intents) {
  const { pub, priv } = app;
  const bidding = pub.phase === PHASES.BIDDING;

  const seats = pub.seats.map((s) => {
    const st = seatState(s.bid, s.tricks);
    const mine = priv && priv.seat === s.seat;
    const onMove = pub.turnSeat === s.seat
      && (bidding || (pub.phase === PHASES.PLAY && !pub.sweeping));

    // DURING BIDDING THE CHIP SHOWS THE BID ALONE. There is nothing taken yet
    // to make a fraction out of, and "0/3" before a card is played reads as
    // already failing.
    const figure = bidding
      ? el('span', { class: 'seat-score' }, s.bid === null ? '—' : String(s.bid))
      : el('span', { class: 'seat-score' },
        String(s.tricks || 0),
        el('span', { class: 'of' }, `/${s.bid === null ? '—' : s.bid}`));

    return el('div', {
      class: `seat ${st}${onMove ? ' onmove' : ''}${mine ? ' you' : ''}`
        + `${s.connected ? '' : ' gone'}`,
      // The whole chip in one sentence, because a screen reader reading
      // "Asha", "1", "slash", "3" across four nodes conveys nothing.
      'aria-label': ariaSeat(pub, s, st, bidding, onMove),
    },
    el('span', { class: 'seat-name' },
      s.name,
      s.seat === pub.dealerSeat && el('span', { class: 'dealer', 'aria-hidden': 'true' }, 'D')),
    figure);
  });

  return el('div', { class: 'play-strip' },
    el('div', { class: 'strip-head' },
      el('span', {}, `Round ${pub.roundIndex + 1}/${pub.roundCount}`),
      el('span', { class: 'dot', 'aria-hidden': 'true' }, '·'),
      el('span', {}, plural(pub.roundSize, 'card')),
      trumpTag(pub.trump),
      // The pad is one tap from everywhere during play, because it is the
      // thing players stare at between rounds and asking for it should never
      // mean leaving the trick.
      el('button', {
        class: 'strip-btn strip-pad-btn', 'aria-label': 'Show the score pad',
        onclick: () => intents.togglePad(),
      }, 'PAD'),
      // THE ONLY WAY TO OPEN THE LOG. logOverlay() has a ✕ that calls the same
      // toggle, and for a while that ✕ was the only caller in the codebase —
      // a drawer that could be closed and never opened, sitting behind a
      // boolean that main.js flipped to false and nothing ever flipped back.
      //
      // Here rather than in the wordmark because the log answers a question
      // you have DURING a trick ("wait, what did she bid?"), and the strip is
      // the one thing on screen at all times. It takes no auto margin — see
      // the .help-btn-sm note in css/app.css for why a third one would move
      // nothing and re-cut the gaps instead.
      el('button', {
        class: 'strip-btn', 'aria-label': 'Show what happened',
        onclick: () => intents.toggleLog(),
      }, 'LOG'),
      // Beside the pad, because these are the same kind of thing: the two
      // questions you can ask mid-trick without giving up the trick. "What is
      // everyone on?" and "what am I allowed to do?" — the second is the one a
      // first-timer has, and this is the only screen they have it on.
      helpBtn(intents, 'help-btn help-btn-sm'),
    ),
    el('div', { class: 'seats' }, seats),
  );
}

function ariaSeat(pub, s, st, bidding, onMove) {
  const dealer = s.seat === pub.dealerSeat ? ', dealer' : '';
  const turn = onMove ? ', to play' : '';
  if (bidding) {
    return s.bid === null
      ? `${s.name}${dealer}, has not bid${turn}`
      : `${s.name}${dealer}, bid ${s.bid}${turn}`;
  }
  if (s.bid === null) return `${s.name}${dealer}, no bid${turn}`;
  const tail = st === 'exact' ? ', exactly on their bid'
    : st === 'over' ? ', over their bid' : '';
  return `${s.name}${dealer}, took ${s.tricks || 0} of ${s.bid}${tail}${turn}`;
}

// ###########################################################################
//
//  THE TRICK ON THE TABLE
//
// ###########################################################################

function trickArea(app) {
  const { pub } = app;
  const plays = pub.plays || [];

  if (!plays.length) {
    return el('div', { class: 'trick-area' },
      el('p', { class: 'trick-empty' }, pub.leadSeat === (app.priv && app.priv.seat)
        ? 'The table is empty — you lead.'
        : `The table is empty — ${nameOf(pub, pub.leadSeat)} leads.`));
  }

  // Who is winning it AS IT STANDS. trickWinner() is the same function the
  // engine settles the trick with, given the partial trick — so the star can
  // never disagree with who actually takes it.
  const leading = trickWinner(plays, pub.trump);
  const led = ledSuitOf(plays);

  return el('div', { class: 'trick-area' },
    el('div', { class: 'trick' }, plays.map((p) => el('div', {
      class: `played${p.seat === leading ? ' leading' : ''}`,
    },
    cardFace(p.code),
    el('span', { class: 'who' },
      nameOf(pub, p.seat),
      p.seat === leading && el('span', { class: 'star', 'aria-hidden': 'true' }, '★'))))),
    el('p', { class: 'trick-hint' }, trickHint(pub, led, leading)),
  );
}

function trickHint(pub, led, leading) {
  const parts = [`${suitName(led)} led`];
  if (pub.trump === NO_TRUMP) parts.push('no trump, so the highest of the suit takes it');
  else if (isTrumpSuit(pub.trump) && pub.plays.some((p) => suitOf(p.code) === pub.trump
    && pub.trump !== led)) parts.push(`trumped with ${suitName(pub.trump)}`);
  parts.push(`${nameOf(pub, leading)} is winning it`);
  return parts.join(' · ');
}

// ###########################################################################
//
//  TOTALS — below the trick, and NOT pinned
//
//  Pinning a second bar would cost another 26px of a 667px phone for something
//  nobody reads mid-trick. It scrolls with the round, and the full pad is one
//  tap away in the strip above.
//
// ###########################################################################

function totalsRow(app, intents) {
  const { pub } = app;
  const best = pub.seats.length ? Math.max(...pub.seats.map((s) => s.total)) : 0;
  // Sorted by score, because the question this row answers is "where am I",
  // not "who sits where" — the strip above already answers that in seat order.
  const ranked = pub.seats.slice().sort((a, b) => b.total - a.total);

  return el('div', { class: 'totals' },
    ranked.map((s) => el('span', {
      class: `t${s.total === best ? ' lead' : ''}${s.total < 0 ? ' neg' : ''}`,
      'aria-label': `${s.name}, ${s.total}`,
    },
    s.name,
    el('b', {}, fmtScore(s.total), s.total === best && el('span', { 'aria-hidden': 'true' }, ' ★')))),
    el('button', { class: 'more', onclick: () => intents.togglePad() }, 'full ▾'),
  );
}

// ###########################################################################
//
//  THE HAND
//
// ###########################################################################

/**
 * One card face. Ivory on dark felt, reused from sequence, because a rank has
 * to be legible in a small cell on a phone and a dark card is not.
 *
 * Sized by the stylesheet rather than by a width computed here: .hand in
 * css/app.css gives the face a clamped width and an aspect-ratio, and wraps
 * the row when the cards would go below the floor.
 *
 * This comment used to say the sizing was `flex: 1 1 0` with a `max-width`,
 * and that ten cards shrank to 30px "without overflowing — measured, both of
 * them". Both halves were true and the conclusion was still wrong: it had
 * measured one hand size and a legal hand goes to seventeen, where the same
 * rule gave a 13.2px card carrying a 19.8px "10". A measurement of the case
 * you thought of is not a measurement of the range. The sweep now runs every
 * legal hand size at every phone width, and it lives in the suite rather than
 * in a scratch file that can be deleted without anything noticing.
 */
function cardFace(code, { big = false, cls = '' } = {}) {
  return el('span', { class: `card${isRedCard(code) ? ' red' : ''}${big ? ' big' : ''} ${cls}` },
    el('span', { class: 'card-rank' }, rankLabel(code)),
    el('span', { class: 'card-suit' }, suitGlyph(suitOf(code))));
}

function handDock(app, intents) {
  const { pub, priv } = app;
  if (!priv) return null;

  const playing = pub.phase === PHASES.PLAY;
  const myTurn = priv.isTurn;
  const selected = app.selected;

  const cards = priv.hand.map((c) => {
    const illegal = playing && !c.legal;
    const isSel = selected === c.code;
    return el('button', {
      class: `card-btn${isSel ? ' sel' : ''}${illegal ? ' illegal' : ''}`,
      // aria-disabled, NOT disabled. A disabled button drops out of the tab
      // order, so a keyboard player could not reach the card to find out why
      // it is grey — and "why" is the whole content of an illegal card. It
      // stays focusable, announces its reason, and does nothing when pressed.
      'aria-disabled': illegal ? 'true' : 'false',
      'aria-pressed': isSel ? 'true' : 'false',
      'aria-label': ariaCard(c, pub.trump, illegal),
      onclick: () => (illegal ? intents.explain(c.reason) : intents.selectCard(c.code)),
    }, cardFace(c.code));
  });

  return el('div', { class: 'hand-dock' },
    el('p', { class: `turn-hint${myTurn ? ' mine' : ''}` }, turnHint(app)),
    el('div', { class: 'hand' }, cards),
    actionRow(app, intents),
  );
}

function ariaCard(c, trump, illegal) {
  const base = cardName(c.code);
  const isTrump = isTrumpSuit(trump) && suitOf(c.code) === trump;
  // "Queen of hearts, trump" — exactly the example the brief gives.
  const head = isTrump ? `${base}, trump` : base;
  return illegal ? `${head}, unavailable: ${c.reason}` : head;
}

function turnHint(app) {
  const { pub, priv } = app;
  if (pub.sweeping) {
    const w = pub.lastTrick ? nameOf(pub, pub.lastTrick.winner) : '';
    return `${w} takes it`;
  }
  if (priv.isTurn) {
    const n = priv.legalCount;
    const led = ledSuitOf(pub.plays);
    if (!led) return 'Your turn · you lead';
    if (n === 1) return 'Your turn · one card is legal, no choice';
    return `Your turn · follow ${suitName(led)}`;
  }
  return `Waiting for ${nameOf(pub, pub.turnSeat)}`;
}

// TWO TAPS TO PLAY A CARD, and that is on purpose. A single tap on a 30px card
// in a ten-card hand is a misplay waiting to happen, and a misplay cannot be
// taken back — the trick is gone and so is the round. Select, look, confirm.
function actionRow(app, intents) {
  const { pub, priv } = app;
  const sel = app.selected;
  const card = sel ? priv.hand.find((c) => c.code === sel) : null;
  const canPlayIt = !!card && card.legal && priv.isTurn && pub.phase === PHASES.PLAY;

  // A SELECTION CAN GO STALE, and then the button has to say why rather than
  // just dying. Selection lives in `app`, not in the engine, so it outlives
  // the frame that made it: a card picked a second ago can be illegal by the
  // time the host's next state lands. Only `card.legal` above stops that from
  // being sent — and a dead button still labelled "Play 7♠", with the card
  // still lit up as selected, is a UI that has stopped explaining itself at
  // exactly the moment it needs to.
  const stale = !!card && !card.legal && priv.isTurn && pub.phase === PHASES.PLAY;

  return el('div', { class: 'action-row' },
    sel && el('button', { class: 'btn btn-ghost', onclick: () => intents.selectCard(null) }, 'CANCEL'),
    el('button', {
      class: 'btn btn-primary', disabled: !canPlayIt || app.busy,
      onclick: () => intents.playCard(sel),
      // The reason travels on the button itself, because the button is the
      // thing that stopped working.
      'aria-label': stale ? `Cannot play ${cardName(sel)}: ${card.reason}` : null,
    }, stale
      ? `Cannot play ${rankLabel(sel)}${suitGlyph(suitOf(sel))}`
      : (sel ? `Play ${rankLabel(sel)}${suitGlyph(suitOf(sel))}` : 'Pick a card')),
    stale && el('p', { class: 'hint' }, card.reason),
  );
}

function playScreen(app, intents) {
  return playShell(
    playStrip(app, intents),
    trickArea(app),
    totalsRow(app, intents),
    errorNote(app),
    handDock(app, intents),
    liveRegion(app.announce),
  );
}

// ###########################################################################
//
//  BIDDING
//
// ###########################################################################

function biddingScreen(app, intents) {
  const { pub, priv } = app;
  return playShell(
    playStrip(app, intents),
    priv && priv.isTurn ? bidPad(app, intents) : bidWait(app),
    errorNote(app),
    biddingHand(app),
    liveRegion(app.announce),
  );
}

function bidWait(app) {
  const { pub } = app;
  const placed = pub.seats.filter((s) => s.bid !== null);
  const sum = placed.reduce((a, s) => a + s.bid, 0);
  return el('div', { class: 'bid-wrap' },
    el('p', { class: 'bid-lede' }, `Waiting for ${nameOf(pub, pub.turnSeat)} to bid`),
    el('p', { class: 'bid-meta' },
      `${placed.length} of ${pub.seats.length} in · ${sum} bid so far · `
      + `${plural(pub.roundSize, 'trick')} available`),
  );
}

function bidPad(app, intents) {
  const { pub, priv } = app;
  const opts = priv.bidOptions || [];
  const placed = pub.seats.filter((s) => s.bid !== null);
  const sum = placed.reduce((a, s) => a + s.bid, 0);
  const sel = app.selectedBid;

  return el('div', { class: 'bid-wrap' },
    el('p', { class: 'bid-lede' }, 'How many tricks will you take?'),
    el('p', { class: 'bid-meta' },
      `Bids so far ${sum} · ${plural(pub.roundSize, 'trick')} available`,
      priv.isDealer && el('br'),
      priv.isDealer && 'You bid last, as dealer'),

    el('div', { class: 'bid-grid', role: 'group', 'aria-label': 'Your bid' },
      opts.map((o) => el('button', {
        class: `bid-btn${o.legal ? '' : ' forbidden'}${sel === o.bid ? ' sel' : ''}`,
        // Same reasoning as the illegal card: focusable, labelled with WHY,
        // and inert on press. The brief's own example of the label to write.
        'aria-disabled': o.legal ? 'false' : 'true',
        'aria-pressed': sel === o.bid ? 'true' : 'false',
        'aria-label': o.legal ? `bid ${o.bid}` : `bid ${o.bid}, unavailable: ${o.reason}`,
        onclick: () => (o.legal ? intents.selectBid(o.bid) : intents.explain(o.reason)),
      }, String(o.bid)))),

    // The hook, spelled out at the moment it binds rather than in a rules
    // sheet nobody opens. priv.forbidden is arithmetic over public bids, so
    // the dealer can watch it move as the others bid.
    priv.forbidden !== null && priv.forbidden !== undefined && el('div', { class: 'hook-why' },
      el('span', { class: 'mark' }, String(priv.forbidden)),
      el('span', {}, `would make the bids total exactly ${pub.roundSize}. `
        + 'The hook forbids it, so somebody at this table has to fail.')),

    el('div', { class: 'action-row' },
      el('button', {
        class: 'btn btn-primary',
        disabled: sel === null || sel === undefined || app.busy,
        onclick: () => intents.placeBid(sel),
      }, sel === null || sel === undefined ? 'Pick a number' : `Bid ${sel}`),
    ),
  );
}

// During bidding the hand is for LOOKING AT. No card is selectable, because
// selecting one would do nothing and a control that does nothing is worse than
// no control. Same faces, same order, no buttons.
//
// And because nothing here is a tap target, the cards can OVERLAP — which is
// the `fan` class. On the play screen every card needs a finger-sized area of
// its own, so the row wraps and a 17-card hand costs three rows of dock; here
// only the corner of each card has to be readable, so the whole hand fans
// across one row at any size. That is 113px of dock instead of 232px, and on
// this screen the dock is competing with a bid pad that grows with the hand,
// so those 119px are the difference between seeing the pad and scrolling for
// it. The measurement is in _bidfit.html.
//
// The class is spelled out rather than left to a `:has(.card-btn.static)`
// selector in the stylesheet: the seam check in scripts/test-engine.mjs pairs
// every class this file emits against a rule in app.css, and a :has() hook is
// invisible to that pairing — it would style a screen that no test could see.
function biddingHand(app) {
  const { priv } = app;
  if (!priv) return null;
  return el('div', { class: 'hand-dock' },
    el('p', { class: 'turn-hint mine' }, 'Your hand this round'),
    el('div', { class: 'hand fan' }, priv.hand.map((c) => el('span', {
      class: 'card-btn static', 'aria-label': cardName(c.code),
    }, cardFace(c.code)))),
  );
}

// ###########################################################################
//
//  BETWEEN ROUNDS, AND THE END
//
// ###########################################################################

function roundOverScreen(app, intents) {
  const { pub, priv } = app;
  const last = pub.history[pub.history.length - 1];
  const owner = !!(priv && priv.isOwner);
  const more = pub.roundIndex + 1 < pub.roundCount;

  return shell(
    // The head is a ROW — title column on the left, help on the right — for
    // the sake of the one button. These two screens are the only ones with
    // neither a wordmark nor a play strip to hang it on, and leaving them out
    // would make the rule "the rules are always one tap away" into "the rules
    // are usually one tap away", which is not a rule anybody can rely on and
    // is not a rule the suite can state in one line.
    el('div', { class: 'roundover-head' },
      el('div', { class: 'roundover-title' },
        el('h2', {}, `Round ${last ? last.roundIndex + 1 : pub.roundIndex + 1} — scores in`),
        more && el('p', {}, nextRoundLine(pub)),
      ),
      helpBtn(intents),
    ),
    last && el('div', { class: 'panel' },
      el('ul', { class: 'result-list' }, pub.seats.map((s, i) => {
        const made = last.bids[i] === last.tricks[i];
        return el('li', { class: `result${made ? ' made' : ' missed'}` },
          el('span', { class: 'result-name' }, s.name),
          el('span', { class: 'result-say' },
            `bid ${last.bids[i]}, took ${last.tricks[i]}`),
          el('span', { class: 'result-delta' }, fmtDelta(last.deltas[i])),
          el('span', { class: 'result-total' }, fmtScore(last.totals[i])));
      })),
    ),
    scorePad(app),
    el('div', { class: 'panel' },
      owner
        ? el('button', {
          class: 'btn btn-primary btn-wide', disabled: app.busy,
          onclick: () => intents.nextRound(),
        }, more ? 'NEXT ROUND' : 'FINISH')
        : el('p', { class: 'hint' }, 'Waiting for the owner to deal the next round.'),
    ),
    errorNote(app),
    liveRegion(app.announce),
  );
}

// What is coming, when it is knowable. Under a rotation the next trump is
// arithmetic on the round number and telling people is the whole point of
// playing a known rotation. Under the turn-up it genuinely is not known yet,
// and inventing something to put here would be a lie.
function nextRoundLine(pub) {
  const next = pub.roundIndex + 1;
  const size = pub.plan[next];
  const method = pub.config.trumpMethod;
  if (needsTurnUp(method)) return `Next: ${plural(size, 'card')} · trump turned after the deal`;
  const t = trumpForRound(method, next);
  return `Next: ${plural(size, 'card')} · ${t === NO_TRUMP ? 'no trump' : suitName(t)}`;
}

function matchOverScreen(app, intents) {
  const { pub, priv } = app;
  const winners = pub.leaders;
  const best = pub.seats.length ? Math.max(...pub.seats.map((s) => s.total)) : 0;

  return shell(
    el('div', { class: 'roundover-head' },
      el('div', { class: 'roundover-title' },
        el('h2', {}, winners.length === 1
          ? `${nameOf(pub, winners[0])} wins`
          : 'Drawn'),
        el('p', {}, winners.length === 1
          ? `on ${fmtScore(best)} after ${plural(pub.roundCount, 'round')}`
          // A draw is a real result, not a tie to be broken. Picking the lower
          // seat number would be a rule nobody agreed to.
          : `${winners.map((s) => nameOf(pub, s)).join(' and ')} on ${fmtScore(best)}`),
      ),
      helpBtn(intents),
    ),
    scorePad(app),
    el('div', { class: 'panel' },
      priv && priv.isOwner
        ? el('button', { class: 'btn btn-primary btn-wide', onclick: () => intents.newMatch() }, 'PLAY AGAIN')
        : el('p', { class: 'hint' }, 'Waiting for the owner.'),
      el('button', { class: 'btn btn-secondary btn-wide', onclick: intents.goHome }, 'LEAVE'),
    ),
    liveRegion(app.announce),
  );
}

// ###########################################################################
//
//  THE SCORE PAD
//
//  The brief's first hard UI problem. Rounds down, players across, two lines
//  per cell: what they bid and took, and what it scored.
//
//  SIZING, FROM THE ENGINE RATHER THAN FROM THE BRIEF. The brief names
//  "7 players x 19 rounds" as the worst case and that combination cannot
//  happen: maxHandSize(7) is floor(52/7) = 7, so seven players top out at 13
//  rounds. The real extremes are seven COLUMNS (at 7 players) and 33 ROWS (at
//  3 players, down-and-up from 17) — and they never co-occur, which is what
//  makes this fit a phone. Seven columns measured 364.4px in _sketch.html
//  against a 390px screen, with no sideways scroll.
//
//  Four-character cells (−289 … 299) only occur at three players, where there
//  are three columns and all the room in the world.
//
// ###########################################################################

function scorePad(app) {
  const { pub, priv } = app;
  const n = pub.seats.length;
  const best = n ? Math.max(...pub.seats.map((s) => s.total)) : 0;

  const head = el('tr', {},
    el('th', { class: 'rail', scope: 'col' }, el('span', { class: 'h-name' }, 'Round')),
    pub.seats.map((s) => el('th', { scope: 'col' },
      el('span', { class: 'h-name' }, s.name),
      el('span', {
        class: `h-total${s.total === best ? ' lead' : ''}${s.total < 0 ? ' neg' : ''}`,
      }, fmtScore(s.total), s.total === best && el('span', { 'aria-hidden': 'true' }, ' ★')))),
  );

  const rows = pub.plan.map((size, r) => {
    const done = pub.history[r];
    const now = r === pub.roundIndex && pub.phase !== PHASES.MATCH_OVER;
    return el('tr', { class: now ? 'now' : '' },
      el('th', { class: 'rail', scope: 'row' },
        el('span', { class: 'r-no' }, String(r + 1)),
        el('span', { class: 'r-meta' }, String(size), padTrump(pub, r, done))),
      pub.seats.map((s, i) => padCell(pub, done, now, i)),
    );
  });

  return el('div', { class: 'board-wrap' },
    el('p', { class: 'board-lede' },
      `Score pad · ${plural(pub.roundCount, 'round')} · ${axisLabel(SCORING_LABELS, pub.config.scoring)}`),
    el('table', { class: 'pad' },
      el('thead', {}, head),
      el('tbody', {}, rows)),
  );
}

// A completed round knows its own trump. A future round knows it too under a
// rotation, and does not under the turn-up — see nextRoundLine().
function padTrump(pub, r, done) {
  const t = done ? done.trump
    : (needsTurnUp(pub.config.trumpMethod) ? null : trumpForRound(pub.config.trumpMethod, r));
  if (t === NO_TRUMP) return el('span', { class: 'nt-mini' }, ' NT');
  if (!isTrumpSuit(t)) return el('span', { class: 'dim' }, ' ·');
  return el('span', { class: isRedSuit(t) ? 'red' : '' }, ` ${trumpGlyph(t)}`);
}

function padCell(pub, done, now, i) {
  if (done) {
    const pts = done.deltas[i];
    // The SIGN carries made-versus-missed, and no tick is needed. In all three
    // modes a made bid scores strictly positive and a miss scores zero or
    // negative — 10*bid, 5*size, 10+bid, 10+bid^2 against 0 or −(error^2).
    // That is a property of js/scoring.js, it is under test there, and if it
    // ever stops being true the suite says so before this quietly breaks.
    const cls = pts > 0 ? 'made' : (pts === 0 ? 'zero' : 'neg');
    return el('td', {},
      el('span', { class: 'cell-bid' }, `${done.tricks[i]}/${done.bids[i]}`),
      el('span', { class: `cell-pts ${cls}` }, fmtDelta(pts)));
  }
  if (now) {
    const s = pub.seats[i];
    return el('td', { class: 'now' },
      el('span', { class: 'cell-bid' },
        pub.phase === PHASES.BIDDING && s.bid === null ? '–/–' : `${s.tricks || 0}/${s.bid === null ? '–' : s.bid}`),
      el('span', { class: 'cell-pts zero' }, '·'));
  }
  return el('td', {},
    el('span', { class: 'cell-bid cell-blank' }, '·'),
    el('span', { class: 'cell-pts cell-blank' }, '·'));
}

function padOverlay(app, intents) {
  return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Score pad' },
    el('div', { class: 'sheet-inner' },
      el('button', { class: 'sheet-close', 'aria-label': 'Close', onclick: () => intents.togglePad() }, '✕'),
      scorePad(app),
    ));
}

// ###########################################################################
//
//  THE LOG
//
//  The engine writes it (js/state.js `_say`) and caps it at 60 lines, so this
//  renders whatever it is given without trimming — a second cap here would be
//  a second number to keep in step.
//
// ###########################################################################

function logOverlay(app, intents) {
  const lines = app.pub.log || [];
  return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'What happened' },
    el('div', { class: 'sheet-inner' },
      el('button', { class: 'sheet-close', 'aria-label': 'Close', onclick: () => intents.toggleLog() }, '✕'),
      el('h2', {}, 'What happened'),
      el('ul', { class: 'log' },
        // Newest first. The reason to open this is almost always "what just
        // happened", not "how did the match begin".
        lines.slice().reverse().map((l) => el('li', { class: `log-${l.kind}` }, l.text))),
    ));
}
