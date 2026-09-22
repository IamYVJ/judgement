// ============================================================================
// main.js — the controller, and the only impure file in the app.
//
// Every other module was kept clean of something on purpose, and all of that
// something ends up here:
//
//   js/state.js   has no clock.      This file calls tick().
//   js/ui.js      has no state.      This file owns `app` and hands it over.
//   js/net.js     has no game rules. This file routes frames to the engine.
//   js/bot.js     has no timer.      This file pumps the driver.
//
// So this is where the interesting failures live, and it is written defensively
// on the assumption that it is the file most likely to be wrong.
//
// ---------------------------------------------------------------------------
// TWO MODES, ONE VIEW MODEL
// ---------------------------------------------------------------------------
// A device is either the HOST — it holds the only GameEngine that exists and
// answers everybody — or a CLIENT, which holds no engine at all and draws
// whatever the host last sent it. `app.pub` / `app.priv` mean exactly the same
// thing in both cases, which is what lets js/ui.js be written without knowing
// or caring which mode it is running in.
//
// The asymmetry is entirely in how an intent travels:
//
//   HOST:    intent -> applyGameIntent(engine, HOST_ID, …) -> push to everyone
//   CLIENT:  intent -> net.send(...) -> ... -> host does the above -> onState
//
// A client NEVER applies its own move optimistically. It sends and waits. That
// costs a round trip of latency on every tap and buys the thing the brief is
// most insistent about: there is exactly one opinion about what is legal, it
// lives on the host, and no screen can ever disagree with it.
//
// ---------------------------------------------------------------------------
// isHost IS NOT isOwner
// ---------------------------------------------------------------------------
// Kept apart here the same way js/ui.js and js/intents.js keep them apart.
// `app.isHost` says this tab runs the engine. `priv.isOwner` says this player
// holds the controls. This file gates NOTHING on isHost except which code path
// an intent takes; every permission question is the engine's, asked by passing
// an actor id and letting _isOwner() answer.
// ============================================================================

import { render } from './ui.js';
import { GameEngine, PHASES } from './state.js';
import { applyGameIntent } from './intents.js';
import { createBotDriver } from './bot.js';
import { PRESETS } from './rules.js';
import {
  createHost, joinHost, HOST_ID, WIRE,
  rejectFrame, readRejectFrame, peerAvailable, describePeerError, isFatalPeerError,
} from './net.js';
import {
  clientId, loadName, saveName, loadCode, saveCode,
  normalizeCode, generateRoomCode, copyText, announcementFor,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

// ###########################################################################
//
//  THE VIEW MODEL
//
// ###########################################################################

// Exactly the shape js/ui.js documents in its header. Kept as one flat mutable
// object rather than anything cleverer because the renderer is a pure function
// of it: there is no diffing, no subscription and nothing to keep in sync, so
// the only rule is "change it, then paint()".
const app = {
  screen: 'home',
  me: { name: loadName() },
  code: loadCode(),
  pub: null,
  priv: null,
  isHost: false,
  error: null,
  selected: null,
  selectedBid: null,
  showPad: false,
  showLog: false,
  announce: '',
  busy: false,
  reconnecting: false,
  netWarning: null,
};

const MY_CLIENT_ID = clientId();

// ###########################################################################
//
//  PAINTING
//
// ###########################################################################

const root = document.getElementById('app');
const announcer = document.getElementById('announce');
const rulesDialog = document.getElementById('rules');

let paintQueued = false;

/**
 * Ask for a repaint. Coalesced, because a single inbound state frame can
 * trigger several mutations of `app` in a row and each one would otherwise
 * rebuild the entire document.
 */
function paint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; draw(); });
}

/**
 * THE FOCUS PROBLEM, which is the whole reason this function is not one line.
 *
 * render() opens with clear(root) and rebuilds every node. That is fine for
 * cards and scores and catastrophic for a text input: the <input> the player
 * is typing into is destroyed and replaced between keystrokes, so focus lands
 * on <body>, the soft keyboard on a phone closes, and the caret jumps to the
 * end of the field every time. Typing a four-character room code becomes
 * impossible.
 *
 * js/ui.js anticipated this and tags every focusable-and-stateful control with
 * `data-focus`. So the fix is to note which one had focus and where the caret
 * was, let the renderer do its destructive thing, and put both back.
 *
 * Restoring the SELECTION and not merely the focus matters: without it the
 * caret snaps to the end, which is invisible when appending and maddening when
 * correcting a character in the middle.
 */
function draw() {
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.focus : null;
  const selStart = focusKey && 'selectionStart' in active ? active.selectionStart : null;
  const selEnd = focusKey && 'selectionEnd' in active ? active.selectionEnd : null;

  render(root, app, intents);

  // Tell the document whether a board is on screen, so css/app.css can hide the
  // footer under it. Derived by ASKING THE DOM what was just drawn rather than
  // by testing app.screen and app.pub.phase here: that phase list lives in
  // js/ui.js's gameScreen() switch, and a copy of it in this file is a copy
  // that goes stale the first time a phase is added. `.shell-play` is the class
  // the renderer itself puts on exactly the screens with a pinned strip and
  // dock, so it cannot disagree with itself.
  document.body.classList.toggle('in-play', !!root.querySelector('.shell-play'));

  if (focusKey) {
    const next = root.querySelector(`[data-focus="${focusKey}"]`);
    if (next) {
      next.focus();
      // Guarded: setSelectionRange throws on input types that do not support
      // it, and a a stray throw in here would stop the announce copy below.
      if (selStart !== null && 'setSelectionRange' in next) {
        try { next.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }
  }

  speak();
}

/**
 * Copy the frame's announcement into the PERSISTENT live region.
 *
 * #announce is a sibling of #app in index.html and is never rebuilt, because a
 * live region only fires when text inside an already-present node changes. A
 * region recreated each frame is new every time and therefore silent every
 * time — that is lesson one from the sibling projects and the reason for the
 * whole data-announce indirection.
 *
 * Only written when the text actually CHANGES, or a screen reader re-reads the
 * same sentence on every unrelated repaint.
 */
function speak() {
  if (!announcer) return;
  const carrier = root.querySelector('[data-announce]');
  const text = carrier ? carrier.getAttribute('data-announce') : '';
  if (text && text !== announcer.textContent) announcer.textContent = text;
}

// How far through pub.log the live region has got. Opaque; announcementFor()
// in js/util.js owns its shape. One cursor rather than one per role, because a
// tab is a host or a client and never both — and it is reset in goHome() with
// the rest of the view model, so leaving one table and joining another starts
// the log again instead of replaying the last table's final trick.
let announceCursor = null;

/**
 * Say whatever the engine has said since the last frame.
 *
 * CALLED FROM BOTH SIDES OF THE WIRE, and that is the point. The host reads
 * the state it just built; a client reads the state it was just sent; both go
 * through the same function with the same log, so the two never drift into
 * announcing different games. The alternative — announcing from the intent
 * that caused the change — would be silent for every move somebody else made,
 * which is most of them.
 *
 * Only ASSIGNS when there is news. An empty result leaves app.announce alone
 * on purpose: copyCode() writes its confirmation straight into the region and
 * a repaint half a second later must not wipe it.
 */
function announceFrom(pub) {
  const news = announcementFor(announceCursor, pub && pub.log);
  announceCursor = news.cursor;
  if (news.text) app.announce = news.text;
}

// ###########################################################################
//
//  MODE STATE
//
// ###########################################################################

let engine = null;     // host only — the one authoritative game
let host = null;       // host only — the transport handle
let client = null;     // client only — the transport handle
let bots = null;       // host only — the bot/absent-seat driver
let clockTimer = null; // host only — see startClock

/**
 * WHICH SESSION THE CALLBACKS BELOW BELONG TO.
 *
 * Bumped by teardown() and by each of beginHost()/beginJoin(). Every transport
 * callback captures the value current when it was registered and returns
 * immediately if it no longer matches — so a callback from a session the user
 * has left cannot touch `app`, cannot dereference a nulled `engine`, and above
 * all cannot start anything new.
 *
 * This exists because destroy() is not a guarantee. The two failures it stops
 * are both real and neither is hypothetical:
 *
 *   1. A JOIN IN FLIGHT WHEN THE USER GOES HOME. goHome() tears down and shows
 *      the home screen; the handshake it abandoned then completes, onOpen runs,
 *      and `app.screen = 'game'` drags the player back into a table they left.
 *      onError does the same thing to the error screen.
 *
 *   2. THE RECONNECT LADDER RESTARTING ITSELF AFTER TEARDOWN. This is the
 *      nastier one, because teardown() looks like it handles it: it clears
 *      reconnectTimer. But clearing a timer does not stop a dead client's
 *      onClose from calling scheduleReconnect() a moment later and setting a
 *      BRAND NEW one. The tab then quietly re-dials, on a ladder, a room the
 *      user closed — and nothing on screen says so.
 *
 * A counter rather than a flag per handle, because the question being asked is
 * "is this still the current session", and with two roles, a reconnect ladder
 * and a resume path there is more than one way to have moved on.
 */
let netEpoch = 0;

// ###########################################################################
//
//  THE HOST CLOCK
//
// ###########################################################################

const TICK_MS = 100;

/**
 * setInterval, DELIBERATELY NOT requestAnimationFrame.
 *
 * The engine's pauses (deal 700ms, reveal 2200ms, trick sweep 1400ms) only
 * advance when somebody calls tick(), and on this device that somebody is this
 * timer. rAF is the obvious choice and it is the wrong one: browsers stop
 * firing it entirely in a backgrounded tab, so the host glancing at a message
 * would freeze the game for all seven people until they looked back. A
 * background tab throttles setInterval to roughly once a second rather than
 * stopping it, so the table keeps moving — the pauses just get lumpy, which is
 * a far better failure than a dead table.
 *
 * 100ms because every deadline in the engine is measured in hundreds of
 * milliseconds; anything finer is work nobody can see.
 *
 * This is not a violation of "no timers in the engine". The engine still takes
 * time as a parameter and owns no clock; this file owns the clock and passes
 * the reading in, which is exactly the arrangement js/bot.js's header assumes.
 */
function startClock() {
  if (clockTimer !== null) return;
  clockTimer = setInterval(() => {
    if (!engine) return;
    const now = Date.now();
    // Both are asked every tick and their answers are OR-ed, because a bot's
    // move can complete a trick, which arms a sweep the very next tick.
    const moved = engine.tick(now);
    const acted = bots ? bots.tick(engine, now) : false;
    if (moved || acted) push();
  }, TICK_MS);
}

function stopClock() {
  if (clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; }
}

// ###########################################################################
//
//  HOST
//
// ###########################################################################

/**
 * Send the table to every device, and refresh our own view of it.
 *
 * The host is a player too, so it takes the same two values it sends everybody
 * else — the public state, plus its own private slice and nobody else's. It
 * reads them from the engine directly rather than off the wire, because there
 * is no wire between a tab and itself, but it reads exactly the same two
 * things. That symmetry is what stops the host's screen from being able to
 * show something no client could see.
 */
function push() {
  if (!engine || !host) return;
  const pub = engine.publicState();
  host.pushState(pub, (playerId) => engine.privateStateFor(playerId));
  app.pub = pub;
  app.priv = engine.privateStateFor(HOST_ID);
  announceFrom(pub);
  snapshotSoon();
  paint();
}

/**
 * Persist the engine, at most once every few seconds.
 *
 * serialize() walks every seat, every hand and the whole history, and push()
 * can fire several times a second during a trick. Writing that to localStorage
 * synchronously on each one would jank the host's animation on the exact
 * device that everybody else's game depends on staying responsive.
 *
 * The trailing edge matters more than the leading one — what must survive a
 * reload is the LATEST state — so this schedules a write rather than doing one
 * and blocking the next.
 */
const SNAPSHOT_MS = 3000;
let snapshotTimer = null;
function snapshotSoon() {
  if (snapshotTimer !== null) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    if (engine) saveEngineSnapshot(engine.serialize());
  }, SNAPSHOT_MS);
}

/**
 * Begin hosting on `code`.
 *
 * `resumed` carries a snapshot when this is a host reload rather than a fresh
 * room, which is the case the whole of js/util.js's session machinery exists
 * for: the host's device holds the only copy of the game, so a reload without
 * this ends the match for six other people.
 */
function beginHost(code, resumed = null) {
  teardown();
  // See netEpoch. teardown() has just invalidated everything older; this
  // claims the session for the handlers registered below.
  const epoch = netEpoch;
  const live = () => epoch === netEpoch;

  engine = new GameEngine();
  bots = createBotDriver();
  app.isHost = true;
  app.code = code;
  app.screen = 'game';
  app.error = null;

  if (resumed) {
    engine.restore(resumed);
    // The seat that was ours is identified by clientId, exactly as a reclaim
    // over the wire would be — a reload is a reconnect that happens to be
    // instant. Rebinding it to HOST_ID is what makes the restored engine
    // answer to this tab again.
    const seat = engine.seats.findIndex((s) => s.clientId === MY_CLIENT_ID);
    if (seat !== -1) {
      engine.seats[seat].id = HOST_ID;
      engine.seats[seat].connected = true;
      // resumeAsOwner rather than trusting the serialized ownerId, because
      // that id was the PREVIOUS session's and nothing answers to it now. This
      // is the documented caller of the method js/intents.js keeps off the
      // wire precisely because it grants the room unconditionally.
      engine.resumeAsOwner(HOST_ID);
    }
    // Every other seat's id belonged to a connection that no longer exists.
    // Marking them disconnected is honest — they are — and the scoreboard
    // shows them greyed until each device dials back in and reclaims by
    // ticket. Their hands and scores are untouched, which is the requirement.
    for (const s of engine.seats) {
      if (s.id !== HOST_ID && !s.isBot) s.connected = false;
    }
    bots.reset();
  } else {
    engine.addPlayer(HOST_ID, app.me.name, { clientId: MY_CLIENT_ID, isOwner: true });
  }

  // EVERY handler below opens with `if (!live()) return;`. See netEpoch: past
  // this point `engine`, `host` and `bots` may all have been nulled by a
  // teardown that happened while a frame was in flight, and these closures
  // still hold the old references. The guard is uniform rather than applied
  // only to the ones that dereference something, because "which of these nine
  // touches the engine" is a question that changes every time one is edited.
  host = createHost(code, {
    onOpen: (openCode) => {
      if (!live()) return;
      // The NORMALISED code, as net.js hands it back: the address actually
      // being listened on, not the string that was typed at it.
      app.code = openCode;
      saveCode(openCode);
      saveSession({ role: 'host', code: openCode, name: app.me.name });
      paint();
    },

    onConnect: (playerId) => {
      if (!live()) return;
      // Nothing is seated yet — a connection is not a player until it has said
      // hello with a ticket. But it can be SENT to, so a device that is
      // reclaiming gets the table immediately rather than after its first move.
      host.sendTo(playerId, stateFrameForPlayer(playerId));
    },

    onJoin: (playerId, hello) => {
      if (!live()) return;
      if (!hello) {
        host.sendTo(playerId, rejectFrame('Enter a name first.'));
        return;
      }

      // SEAT RECLAIM, the transport half of it. If this ticket already holds a
      // seat, the engine is about to rebind that seat to the new connection —
      // and the OLD connection may still be open and counted, because a phone
      // that lost signal does not close its channel politely. Retiring it
      // explicitly stops the host holding two channels for one player, and
      // dropConnection is the method that does it WITHOUT firing onDisconnect,
      // which would otherwise mark the seat we just handed back as gone.
      const prior = engine.seats.find((s) => s.clientId && s.clientId === hello.clientId);
      const stale = prior && prior.id !== playerId ? prior.id : null;

      const r = engine.addPlayer(playerId, hello.name, { clientId: hello.clientId });
      if (!r.ok) { host.sendTo(playerId, rejectFrame(r.error)); return; }

      if (stale) host.dropConnection(stale);
      // A seat coming back mid-pause should not inherit the absent-player
      // countdown that was running against it.
      if (bots) bots.reset();
      push();
    },

    onData: (playerId, msg) => {
      if (!live()) return;
      // EVERY inbound frame goes through here and nothing else. applyGameIntent
      // checks the type is one a peer may send at all; the engine then checks
      // the phase, the turn, the seat, the card and the owner. This function
      // adds no judgement of its own, which is the point — a second opinion
      // about legality is a second thing to get wrong.
      const { handled, result } = applyGameIntent(engine, playerId, msg, Date.now());

      // UNHANDLED MEANS THE ENGINE WAS NEVER ASKED, so there is nothing new to
      // send and this returns before push().
      //
      // It used to fall through and broadcast anyway, which turned one junk
      // frame from one peer into a full public state serialised and sent to
      // all six others — the cheapest amplification in the file, and free to
      // the sender because an unrecognised type never reaches the engine and
      // so can never be refused by it. The rate limiter in net.js bounds how
      // fast this can be done; it does not make each one cost nothing.
      //
      // A REFUSED intent is different and still pushes. The engine said no,
      // so the state did not change — but a client asking to play a card it
      // may not play is usually a client whose view has drifted, and the
      // answer to that is to send it the truth.
      if (!handled) return;
      if (!result.ok) host.sendTo(playerId, rejectFrame(result.error));
      if (result.ok && bots) bots.reset();
      push();
    },

    onDisconnect: (playerId) => {
      if (!live()) return;
      // Phase-dependent, and the engine owns which: in the lobby this removes
      // the seat, mid-match it keeps it holding its hand and its score so the
      // ticket can claim it back.
      engine.disconnect(playerId);
      push();
    },

    onError: (err) => {
      if (!live()) return;
      // A host error is almost never fatal — the broker falling over leaves
      // every existing DataConnection running device to device — so it is a
      // dismissible banner, not a screen.
      if (isFatalPeerError(err)) {
        app.error = describePeerError(err);
        app.screen = 'error';
      } else {
        app.netWarning = describePeerError(err);
      }
      paint();
    },

    onBrokerDown: () => {
      if (!live()) return;
      app.netWarning = 'Lost contact with the matchmaking server. The game continues — but nobody new can join until it is back.';
      paint();
    },
    onBrokerUp: () => { if (!live()) return; app.netWarning = null; paint(); },
    onBrokerLost: () => {
      if (!live()) return;
      app.netWarning = 'Could not reach the matchmaking server. The people already here can keep playing; new players cannot join.';
      paint();
    },
  });

  startClock();
  push();
}

/** The frame a single device should receive: everything public, plus its own
 *  private slice. Used by onConnect, where pushState's whole-table loop would
 *  be six unnecessary sends. */
function stateFrameForPlayer(playerId) {
  return {
    type: WIRE.STATE,
    pub: engine.publicState(),
    priv: engine.privateStateFor(playerId),
  };
}

// ###########################################################################
//
//  CLIENT
//
// ###########################################################################

// The brief's standing rule, and the measurement behind it: a cold TLS
// handshake to the broker was ~4.6s against 0.8–1.2s warm, so anything under
// about ten seconds declares a working connection dead. WebRTC also fails
// SILENTLY on hostile networks — the broker cheerfully says the host exists
// and then the data channel never opens and nobody errors — so a deadline is
// the only thing that will ever notice.
const JOIN_BUDGET_MS = 12000;

// Reconnect attempts after an established game drops. Deliberately patient for
// the same reason: a screen lock or a 4G handover is seconds, not milliseconds.
const RECONNECT_DELAYS_MS = [1000, 3000, 7000];

let joinTimer = null;
let reconnectAt = 0;
let reconnectTimer = null;

function clearJoinTimer() {
  if (joinTimer !== null) { clearTimeout(joinTimer); joinTimer = null; }
}

/**
 * Dial a room.
 *
 * `resuming` distinguishes the two cases the header of joinHost() says only
 * the controller can tell apart: a FIRST join that times out is an error
 * screen, while a RECONNECT that times out keeps the table on screen and tries
 * again. Same transport call, entirely different meaning.
 */
function beginJoin(code, resuming = false) {
  if (!resuming) teardown();
  else if (client) { try { client.destroy(); } catch (_) {} client = null; }

  // See netEpoch. Bumped even on the resuming path, where teardown() is
  // deliberately NOT called — the client being replaced there still has live
  // handlers, and a rung of the reconnect ladder must not be answered by the
  // rung before it.
  const epoch = ++netEpoch;
  const live = () => epoch === netEpoch;

  app.isHost = false;
  app.code = code;
  if (!resuming) {
    app.screen = 'connecting';
    app.error = null;
  }
  paint();

  // As on the host side, every handler opens with the same guard — and here
  // it is load-bearing rather than defensive. onOpen sets app.screen='game'
  // and onError sets it to 'error'; either one arriving after the player has
  // gone Home yanks them somewhere they did not ask to be, and the handshake
  // that does it was abandoned seconds earlier.
  client = joinHost(code, {
    onOpen: () => {
      if (!live()) return;
      clearJoinTimer();
      reconnectAt = 0;
      app.screen = 'game';
      app.reconnecting = false;
      app.error = null;
      saveCode(code);
      saveSession({ role: 'client', code, name: app.me.name });
      paint();
    },

    onState: (pub, priv) => {
      if (!live()) return;
      app.pub = pub;
      app.priv = priv;
      announceFrom(pub);
      // The move we were waiting on has landed, whatever it was. Clearing the
      // selection here rather than on send is what makes a REFUSED move keep
      // its card selected, so the player can see what they tried.
      app.busy = false;
      app.selected = null;
      app.selectedBid = null;
      paint();
    },

    onData: (msg) => {
      if (!live()) return;
      // The only non-state frame a host sends. readRejectFrame bounds and
      // trims it, because it is about to be rendered as text.
      if (msg.type === WIRE.REJECTED) {
        const text = readRejectFrame(msg);
        if (text) app.error = text;
        app.busy = false;
        paint();
      }
    },

    onClose: () => {
      // THE GUARD THAT MATTERS MOST IN THIS FILE. Without it, a client that
      // was destroyed by teardown() reports its own closure a moment later,
      // this runs, and scheduleReconnect() sets a fresh reconnectTimer —
      // AFTER teardown cleared the old one. The tab then re-dials a room the
      // user has left, silently, on a ladder, with the home screen showing.
      if (!live()) return;
      // The host's tab closed, or the channel died. Which of the two it is
      // cannot be known from here, so it is treated as recoverable first and
      // permanent only after the ladder is spent.
      app.busy = false;
      scheduleReconnect();
    },

    onError: (err) => {
      if (!live()) return;
      clearJoinTimer();
      if (isFatalPeerError(err)) {
        app.error = describePeerError(err);
        app.screen = 'error';
        app.reconnecting = false;
        paint();
        return;
      }
      // Non-fatal before we ever got in is still a failed join; non-fatal
      // after is a blip to retry.
      if (app.screen === 'connecting') {
        app.error = describePeerError(err);
        app.screen = 'error';
        paint();
      } else {
        app.netWarning = describePeerError(err);
        paint();
      }
    },

    onBrokerDown: () => {
      if (!live()) return;
      // Says nothing to a client that is already in a game: its DataConnection
      // stopped needing the broker the moment the handshake finished, and a
      // warning about a server the player has never heard of is noise.
      if (app.screen !== 'game') { app.netWarning = 'Reaching the matchmaking server…'; paint(); }
    },
    onBrokerUp: () => { if (!live()) return; app.netWarning = null; paint(); },
    onBrokerLost: () => {
      if (!live()) return;
      if (app.screen !== 'game') {
        app.error = 'Could not reach the matchmaking server. Check your connection and try again.';
        app.screen = 'error';
        paint();
      }
    },
  }, { name: app.me.name, clientId: MY_CLIENT_ID });

  clearJoinTimer();
  joinTimer = setTimeout(() => {
    joinTimer = null;
    // Same reason as onClose above: teardown() clears this timer, but a timer
    // that has ALREADY fired is past clearing, and its `resuming` branch
    // starts the reconnect ladder. Guarded here rather than relying on the
    // clear, because the clear is what was already being relied on.
    if (!live()) return;
    if (client && client.isOpen()) return;
    if (resuming) { scheduleReconnect(); return; }
    app.screen = 'error';
    app.error = 'Could not reach that table. Check the code, and that the host still has the game open.';
    paint();
  }, JOIN_BUDGET_MS);
}

/**
 * Try the room again, on a widening ladder, then give up and say so.
 *
 * Giving up lands on 'hostleft' rather than 'error' because by this point
 * there WAS a game: the distinction the screen makes is "your table went away"
 * versus "we never found one", and they want different words and a different
 * button.
 */
function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  if (reconnectAt >= RECONNECT_DELAYS_MS.length) {
    app.reconnecting = false;
    app.screen = 'hostleft';
    paint();
    return;
  }
  const delay = RECONNECT_DELAYS_MS[reconnectAt++];
  app.reconnecting = true;
  paint();
  // The last link in the chain. Everything upstream is now guarded, but this
  // timer is the one that actually re-dials, and teardown() clearing it is
  // not enough for a firing that has already begun. Captured at schedule time
  // rather than read inside, so that a teardown DURING the delay is caught.
  const epoch = netEpoch;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (epoch !== netEpoch) return;
    beginJoin(app.code, true);
  }, delay);
}

// ###########################################################################
//
//  TEARDOWN
//
// ###########################################################################

function teardown() {
  // FIRST, before anything is destroyed. Everything below either cancels a
  // timer or drops a handle, and both of those can synchronously fire a
  // callback — so the epoch has to already be stale by the time they run.
  netEpoch++;
  stopClock();
  clearJoinTimer();
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (snapshotTimer !== null) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  if (host) { try { host.destroy(); } catch (_) {} host = null; }
  if (client) { try { client.destroy(); } catch (_) {} client = null; }
  engine = null;
  bots = null;
  reconnectAt = 0;
  app.reconnecting = false;
  app.netWarning = null;
}

// ###########################################################################
//
//  INTENTS
//
// ###########################################################################

/**
 * Route a game intent to wherever the engine happens to be.
 *
 * The two branches look asymmetric and are not: both end in the same
 * applyGameIntent call against the same engine. One of them just has a network
 * in the middle.
 */
function dispatch(msg) {
  app.error = null;
  if (app.isHost) {
    const { handled, result } = applyGameIntent(engine, HOST_ID, msg, Date.now());
    if (handled && !result.ok) app.error = result.error;
    if (handled && result.ok && bots) bots.reset();
    push();
    return;
  }
  if (!client) return;
  // `busy` greys the controls until the host answers. Without it a laggy
  // connection invites the player to tap twice, and the second tap is refused
  // as out of turn, which reads as the app being broken.
  app.busy = true;
  client.send(msg);
  paint();
}

const intents = {
  // --- navigation --------------------------------------------------------
  host() {
    if (!requirePeer()) return;
    const code = generateRoomCode();
    saveName(app.me.name);
    beginHost(code);
  },

  goJoin() { app.screen = 'join'; app.error = null; paint(); },

  join(code) {
    if (!requirePeer()) return;
    const clean = normalizeCode(code);
    if (clean.length !== 4) {
      app.error = 'A room code is four characters — letters and numbers, with no O, zero, I or one.';
      paint();
      return;
    }
    saveName(app.me.name);
    beginJoin(clean);
  },

  cancelJoin() { teardown(); app.screen = 'join'; app.error = null; paint(); },

  goHome() {
    teardown();
    clearSession();
    app.screen = 'home';
    app.pub = null;
    app.priv = null;
    app.isHost = false;
    app.error = null;
    app.selected = null;
    app.selectedBid = null;
    app.showPad = false;
    app.showLog = false;
    // Back to the start of the log, or the first frame of the next table
    // would be measured against the last table's final line — which is not
    // in it, so the cursor would not be found and the newest line would be
    // announced. Harmless by luck rather than by design, and the next change
    // to announcementFor() would not be.
    announceCursor = null;
    app.announce = '';
    paint();
  },

  // --- fields ------------------------------------------------------------
  setName(v) {
    app.me.name = v;
    saveName(v);
    paint();
  },

  setCode(v) {
    // Normalised as it is typed, so the field can only ever contain something
    // dialable and the player finds out about a look-alike character at the
    // keystroke rather than at the failure.
    app.code = normalizeCode(v);
    paint();
  },

  async copyCode() {
    const ok = await copyText(app.code);
    app.announce = ok ? `Room code ${app.code} copied` : 'Could not copy — read it out instead';
    // Straight into the live region: this is the one action in the app with no
    // visible consequence at all, so without a spoken confirmation a screen
    // reader user cannot tell whether it worked.
    if (announcer) announcer.textContent = app.announce;
    paint();
  },

  // --- lobby (owner-gated in the engine, never here) ----------------------
  setConfig(patch) { dispatch({ type: 'setConfig', patch }); },

  applyPreset(id) {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) dispatch({ type: 'setConfig', patch: { ...preset.config } });
  },

  addBot() { dispatch({ type: 'addBot' }); },
  removeSeat(seat) { dispatch({ type: 'removeSeat', seat }); },
  startMatch() { dispatch({ type: 'startMatch' }); },
  nextRound() { dispatch({ type: 'nextRound' }); },

  newMatch() {
    // Host-only by construction: reset() is not a wire intent (see the list in
    // js/intents.js — a one-message wipe of nineteen rounds of six people's
    // scores from anybody holding the code). A client's "new match" button is
    // therefore a request to leave and is drawn as one.
    if (!app.isHost || !engine) { intents.goHome(); return; }

    // The table is kept and the scores are not. Two ordering constraints make
    // this fiddlier than it reads, and both were found by walking the engine
    // rather than by running it:
    //
    //   1. HUMANS BEFORE BOTS. reset() nulls ownerId, and addBot is
    //      owner-gated — so a table whose first seat was a bot would have that
    //      addBot refused and the table would come back one seat short.
    //      Seating a human first re-establishes an owner for the rest to pass.
    //   2. ONLY PEOPLE WHO ARE STILL HERE. addPlayer marks a seat connected,
    //      so re-seating somebody who left would put a permanently-absent
    //      player at the new table — and startBlocker() refuses to start while
    //      anybody is disconnected, so the room could never begin. They are
    //      not locked out: their device is still connected at the transport
    //      layer, and its next hello reclaims a seat in the fresh lobby.
    const humans = engine.seats.filter((s) => !s.isBot && s.connected).map((s) => ({ ...s }));
    const botNames = engine.seats.filter((s) => s.isBot).map((s) => s.name);

    engine.reset();
    for (const s of humans) {
      engine.addPlayer(s.id, s.name, { clientId: s.clientId, isOwner: s.isOwner });
    }
    // Ownership may not have survived — the previous owner might be one of the
    // people who left. Whoever is now seat zero holds the room, which is
    // addPlayer's own rule, and engine.ownerId is the authority on it.
    for (const name of botNames) engine.addBot(engine.ownerId, name);

    if (bots) bots.reset();
    push();
  },

  // --- play --------------------------------------------------------------
  selectBid(bid) { app.selectedBid = bid; app.error = null; paint(); },
  placeBid(bid) { dispatch({ type: 'placeBid', bid }); },
  selectCard(code) { app.selected = code; app.error = null; paint(); },
  playCard(code) { dispatch({ type: 'playCard', code }); },

  // --- local-only view state ---------------------------------------------
  togglePad() { app.showPad = !app.showPad; paint(); },
  toggleLog() { app.showLog = !app.showLog; paint(); },

  toggleRules() {
    // The rules sheet is a NATIVE <dialog> living beside #app in index.html,
    // not a node this app renders. Two reasons. It is static prose, so
    // rebuilding it on every frame is waste; and <dialog> brings its own focus
    // trap, Escape handling and inertness for the content behind it, all of
    // which would otherwise be hand-written accessibility code that is easy to
    // get subtly wrong. See the note in index.html.
    if (!rulesDialog) return;
    if (rulesDialog.open) rulesDialog.close();
    else rulesDialog.showModal();
  },

  explain(reason) {
    // A greyed card or an unavailable bid, tapped. The engine already phrased
    // the reason; this just surfaces it rather than letting the tap do nothing.
    app.error = reason;
    paint();
  },

  dismissNetWarning() { app.netWarning = null; paint(); },
};

/** The one thing that can be missing while everything else works. */
function requirePeer() {
  if (peerAvailable()) return true;
  app.screen = 'error';
  app.error = 'The connection library did not load. Check your internet connection and reload the page.';
  paint();
  return false;
}

// ###########################################################################
//
//  BOOT
//
// ###########################################################################

/**
 * Pick up where this device left off, if it left off recently enough.
 *
 * loadSession() applies the eight-hour TTL, so anything it hands back is worth
 * acting on. The host branch is the one that matters: its device holds the
 * only copy of the game, and resuming it is the difference between a reload
 * and an abandoned match.
 */
function resume() {
  const session = loadSession();
  if (!session || !session.code) return false;
  if (!peerAvailable()) return false;

  if (session.name && !app.me.name) app.me.name = session.name;

  if (session.role === 'host') {
    const snap = loadEngineSnapshot();
    // A session without a snapshot rehydrates an empty lobby, which is worse
    // than the home screen: it looks like a room that people can join and
    // there is nothing in it. Only resume a host that has a game to resume.
    if (!snap) { clearSession(); return false; }
    beginHost(session.code, snap);
    return true;
  }

  if (session.role === 'client') {
    beginJoin(session.code);
    return true;
  }

  return false;
}

// A host leaving takes the game with it, so say so. `beforeunload` with a
// returnValue is the only hook browsers still honour for this, and they only
// honour it when the player has interacted with the page — which, by the time
// a match is running, they have.
window.addEventListener('beforeunload', (e) => {
  if (!app.isHost || !engine || engine.phase === PHASES.LOBBY) return;
  // Flush synchronously. The debounced write may have up to three seconds of
  // moves pending, and this is the last moment anything can be saved.
  if (snapshotTimer !== null) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  saveEngineSnapshot(engine.serialize());
  e.preventDefault();
  e.returnValue = '';
});

if (!resume()) paint();
