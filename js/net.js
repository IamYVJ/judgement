// ============================================================================
// net.js — The peer-to-peer transport. WebRTC via PeerJS, host-authoritative.
//
// SHAPE: A STAR, NEVER A MESH.
//   The host creates a Peer whose id is derived from the four-character room
//   code, so a joiner can reconstruct the host's address from the code alone
//   and no lookup service is needed. Every joiner opens exactly one
//   DataConnection to the host; joiners never talk to each other. The host runs
//   the only GameEngine that exists, validates everything, and sends each
//   device the public state plus only that device's own hand.
//
//   Judgement seats three to seven, so that is one host and up to six spokes.
//   A mesh would be twenty-one channels to keep alive on somebody's phone for a
//   nineteen-round match, and would need a consensus rule for who dealt. A star
//   needs neither, at the price of the host being a single point of failure —
//   which is what the engine snapshot in js/util.js is for.
//
// ----------------------------------------------------------------------------
// SIGNALLING, AND WHY A CACHED PWA STILL NEEDS THE INTERNET.
//   PeerJS needs a "broker" (a signalling server) ONCE, to carry the WebRTC
//   handshake. After that, game traffic goes device to device. The default
//   broker is PeerJS's free public cloud, so the initial handshake needs the
//   internet to be reachable even though the app shell itself loads from cache.
//
//   The consequence worth stating plainly: a room code is an address on a
//   PUBLIC broker, not a LAN-local one. peerIdForCode() is derivable by
//   anybody, and there are only 32^4 ≈ 1M codes. Everything in js/guards.js,
//   and the clientId rule in js/state.js, exists because of that sentence.
//
//   FOR FULLY-OFFLINE LAN PLAY: run a PeerServer on the LAN,
//       npx peer --port 9000 --key peerjs --path /judgement
//   and point BROKER_CONFIG at it:
//       export const BROKER_CONFIG = {
//         host: '192.168.1.50', port: 9000, path: '/judgement',
//         key: 'peerjs', secure: false,
//       };
//   Every device at the table must use the same broker config to find the
//   others.
//
// ----------------------------------------------------------------------------
// ZERO DEPENDENCIES AND A PEERJS TRANSPORT ARE NOT IN CONFLICT.
//   PeerJS arrives as a UMD bundle from a CDN <script> tag in index.html and is
//   read off `window.Peer`. It is never imported, so package.json still has no
//   `dependencies` key, there is no build step, and nothing third-party is
//   vendored into this repo. The cost is that the one thing in this app which
//   can be missing while everything else works is the transport — hence
//   peerAvailable() below, and the inert transport that reports it as a normal
//   error instead of throwing out of a click handler.
//
// ----------------------------------------------------------------------------
// NAT TRAVERSAL — WHAT ACTUALLY HAPPENS.
//   newPeer() passes no `config`, so PeerJS's DEFAULT iceServers apply: Google
//   STUN plus two public TURN relays run by peerjs.com, with credentials baked
//   into the library and shared with every PeerJS app on the internet.
//
//   So this is not LAN-only and never was. STUN hole-punching connects two
//   ordinary home routers on different ISPs, and when it fails WebRTC relays
//   through peerjs.com. Keeping the default is deliberate — six people in six
//   different houses is a normal way to play this game — with three
//   consequences the rest of the code has to be honest about:
//
//     1. A table is reachable from anywhere by anyone holding the code. That is
//        why a seat mid-deal belongs to a clientId and not to a display name
//        (js/state.js addPlayer), and why this host applies the same bounds to
//        a peer that a server would (js/guards.js).
//     2. Cross-network ICE shows each player's public IP to the others. There
//        is no way around that in a peer-to-peer game; a server transport is
//        the answer for anyone who minds, and js/config.js holds the seam.
//     3. A relayed game depends on somebody else's infrastructure staying up.
//        The DataChannel is DTLS-encrypted end to end, so a relay forwards
//        ciphertext it cannot read — availability is the exposure here, not
//        confidentiality.
//
//   To make this LAN-only, pass `config: { iceServers: [] }` in newPeer(): with
//   no STUN and no relay, only host candidates are gathered.
//
//   Connections still fail silently. Symmetric NAT with the relay blocked,
//   "client isolation" guest Wi-Fi, and some corporate networks all produce the
//   same thing: the broker cheerfully says the host exists, and then the data
//   channel never comes up and nobody errors. That silence is why a joinHost()
//   caller needs a deadline of its own — see the note on joinHost().
//
// ----------------------------------------------------------------------------
// SEAT RECLAIM: WHICH HALF OF IT IS HERE.
//   The brief makes seat reclaim a headline of this checkpoint, and it is worth
//   being exact about the split, because most of the mechanism is not in this
//   file.
//
//   js/state.js owns the RULE: addPlayer() matches on clientId and on nothing
//   else, in any phase, and hands back the seat with its hand, its bid and its
//   running total intact. A name is never a seat ticket.
//
//   This file owns the three transport facts that make the rule reachable:
//
//     1. THE ADDRESS SURVIVES. The host's peer id is derived from the room
//        code, so a host that reloads, or blips off Wi-Fi, comes back at the
//        same address. Reconnecting is therefore just joining again, and
//        nothing has to be renegotiated or re-shared.
//     2. THE TICKET TRAVELS. joinHost() sends the JOIN frame itself, exactly
//        once per connection, carrying the clientId. A caller cannot forget to.
//     3. ONE CONNECTION IS ONE IDENTITY. A connection that has already
//        announced a clientId may repeat it, and may not change it — see the
//        note in the host's data handler for what the alternative allows.
//
//   What this file must NOT do is decide anything about seats. It does not
//   import js/state.js, has no idea how many seats exist, and never refuses a
//   connection because "the table is full": a disconnected player coming back
//   mid-match arrives on a brand-new connection to a table that is, by
//   definition, already full. Turning them away at the door would make reclaim
//   impossible at exactly the table where it matters.
//
// ----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT HERE.
//   * No discovery / open-table list. PeerJS's listAllPeers() only answers on a
//     broker configured with allow_discovery, which the public cloud is not, so
//     it would be a feature that works on nobody's phone. Typing four
//     characters is the join flow.
//   * No game rules of any kind. Every frame this file admits still goes
//     through js/intents.js and then the engine, which checks the phase, the
//     turn, the seat, the card and the owner for itself. Deleting this file's
//     validation would not make one illegal move legal — see the header of
//     js/guards.js, which says the same thing from the other side.
//   * No WebSocket transport to a server. js/config.js holds blank SERVER_URL
//     and SERVER_HEALTH and js/intents.js is already the shared dispatcher both
//     transports would call — that is the seam, and it is the part worth having
//     in advance. A socket client that has never been run against a server is
//     not a seam, it is untested code that looks tested.
//   * No turn timers and no heartbeat. Turn timers are out of scope for v1 by
//     the brief. A heartbeat would only tell us what 'close' already tells us,
//     a few seconds sooner, at the price of traffic on every phone in the room
//     for the whole match.
// ============================================================================

import {
  TokenBucket, decodePeerFrame,
  validPlayerId, validName, validClientId, validPublicState, validPrivateState,
} from './guards.js';
import { normalizeCode, CODE_LENGTH } from './util.js';

// Set to null to use PeerJS's default public cloud broker. Replace with an
// object (see the header) to self-host signalling for offline LAN play.
export const BROKER_CONFIG = null;

// ---------------------------------------------------------------------------
// Ceilings for a host that is somebody's phone.
// ---------------------------------------------------------------------------

/**
 * How many DataConnections the host will hold at once.
 *
 * A full judgement table is seven seats, so six remote players. The rest of
 * this budget is for churn that is normal rather than hostile: a reconnecting
 * player's new connection overlaps their dead one until PeerJS notices, and a
 * client's retry ladder can have two attempts in flight across a slow blip.
 * Six players at up to four connections each is twenty-four; thirty-two leaves
 * headroom without pretending to be a limit on anything.
 *
 * Note that this is four times courtpiece's sixteen and for exactly one
 * reason: that game seats four and this one seats seven. If MAX_PLAYERS in
 * js/rules.js ever moves, this moves with it — it is not a tuned number, it is
 * arithmetic.
 *
 * THIS IS NOT AN ANTI-ABUSE CONTROL and should not be mistaken for one. Anyone
 * who has the code can open connections, and a lower number only makes it
 * cheaper to fill. What it does is bound the RTCPeerConnections a phone is
 * asked to hold open at once, which is the failure that actually happens.
 */
export const MAX_HOST_CONNS = 32;

/**
 * How many refused frames a connection may send before it is closed.
 *
 * A refused frame is dropped in SILENCE. Replying "too fast" to a flood answers
 * every packet of it, which is the amplification the bucket exists to prevent.
 * Persistent refusal is not a slow client though, it is a script, so the
 * connection eventually goes rather than being throttled forever.
 */
export const MAX_REFUSED_FRAMES = 120;

/**
 * How long a connection may sit half-open before the host forgets it.
 *
 * Read the standing rule first: this project does not set tight network
 * timeouts, and this is not one. It never interrupts a connection that has
 * opened, and it never shortens a handshake — an honest ICE negotiation over a
 * TURN relay on a bad phone network finishes in a few seconds, so thirty is an
 * order of magnitude of slack.
 *
 * It exists because the ceiling above counts connections we ACCEPTED, and a
 * DataConnection that never opens does not reliably fire 'close' or 'error'.
 * Without a reaper those slots are held for the life of the tab, and the table
 * that cannot be joined is the host's own.
 */
const HANDSHAKE_BUDGET_MS = 30000;

// ---------------------------------------------------------------------------
// Room code <-> peer id
//
// Namespaced, because the public broker is shared with every other PeerJS app
// on the internet and a bare four-character id would collide with them — and
// specifically with `courtpiece`, which is the same four characters from the
// same alphabet generated by the same function.
//
// Versioned, because a future change to the wire protocol can then be made by
// bumping this: old and new clients simply fail to find each other, instead of
// connecting and disagreeing about what a message means.
// ---------------------------------------------------------------------------
export const PEER_PREFIX = 'judgement-v1-';

/**
 * The broker address for a room code, or NULL if that is not a room code.
 *
 * Normalised through js/util.js rather than upper-cased here, so a code
 * pasted out of a chat message as "qr-tx" finds the same table as one typed as
 * "QRTX" — and so the alphabet lives in exactly one place. normalizeCode()
 * DROPS characters outside the alphabet, which means a typed O is not guessed
 * at as a zero; what comes back is shorter, and that is what the length check
 * below turns into a refusal.
 *
 * Returning null rather than a best-effort id matters. Without it, every
 * joiner who typed something unusable would dial the bare prefix — the same
 * address as every other such joiner — and the first person to fat-finger the
 * field while a second person had done the same would find themselves in a
 * conversation with a stranger.
 */
export function peerIdForCode(code) {
  const room = normalizeCode(code);
  return room.length === CODE_LENGTH ? PEER_PREFIX + room : null;
}

export function codeFromPeerId(id) {
  return typeof id === 'string' && id.startsWith(PEER_PREFIX)
    ? id.slice(PEER_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// Connection id -> player id. THIS PREFIX IS A SECURITY BOUNDARY.
//
// A joiner chooses its own peer id: `new Peer('whatever')`. The host learns it
// as conn.peer and would otherwise hand it straight to the engine as the actor
// behind every message that connection sends.
//
// That is an impersonation vector, and not a subtle one. The host's own engine
// id is HOST_ID below, and while it is hosting it is also engine.ownerId — so a
// peer that simply registered itself under that name on the broker would arrive
// as the owner. It could set the config, seat bots, remove seats, start the
// match, deal the next round, and — because seatOf() matches on id — bid and
// play out of the host's own hand. The source of this app is a static file
// anybody can read, so HOST_ID is not a secret and was never going to be.
//
// Prefixing closes the whole class of it. Every id the engine ever sees from
// this transport is 'peer:' + something, a space that neither HOST_ID nor the
// engine's own 'bot:<seat>' ids are in and that neither can be pushed into: a
// peer registering as 'peer:host' arrives as 'peer:peer:host'. The prefix is
// added HERE, by us, to a string we received — never sent by the peer, and so
// never something a peer can skip.
//
// The three assertions below run at module load, in the browser, on the first
// page load. Renaming HOST_ID to something that collides, or changing either
// prefix so that one contains the other, fails loudly rather than shipping as
// a hole.
// ---------------------------------------------------------------------------
export const CONN_ID_PREFIX = 'peer:';

/**
 * The id the engine knows this device by while it is hosting.
 *
 * NOT the clientId. The clientId is the seat ticket (js/util.js) and is passed
 * to addPlayer() as a separate argument so that it stays on this device and in
 * this device's own memory. Using it as the player id would mean the one value
 * a seat is bound to was being used as a routing key all over the app.
 *
 * A constant is enough for a host: there is exactly one of them per table.
 * Everybody else is known by their connection id, prefixed.
 */
export const HOST_ID = 'host';

// js/state.js addBot() mints `bot:<seat>`. Kept here as a string rather than
// imported, because importing the engine into the transport to check a naming
// convention would be a dependency bought for an assertion.
const BOT_ID_PREFIX = 'bot:';

if (HOST_ID.startsWith(CONN_ID_PREFIX) || BOT_ID_PREFIX.startsWith(CONN_ID_PREFIX)) {
  throw new Error('net.js: a local id is inside the peer namespace — impersonation is possible');
}
if (CONN_ID_PREFIX.startsWith(BOT_ID_PREFIX) || HOST_ID.startsWith(BOT_ID_PREFIX)) {
  throw new Error('net.js: the peer namespace overlaps the bot namespace');
}
if (validPlayerId(HOST_ID) === null) {
  throw new Error('net.js: HOST_ID would be refused by guards.js validPlayerId');
}

export function playerIdForConn(connId) {
  return CONN_ID_PREFIX + connId;
}

/** The connection behind a player id, or null if that player is not a peer —
 *  the host itself, or a bot. Callers use the null to mean "there is nothing to
 *  send to", which is exactly right for both. */
export function connIdForPlayer(playerId) {
  return typeof playerId === 'string' && playerId.startsWith(CONN_ID_PREFIX)
    ? playerId.slice(CONN_ID_PREFIX.length)
    : null;
}

// ---------------------------------------------------------------------------
// The wire vocabulary.
//
// js/intents.js handles the messages that CHANGE THE GAME and says, in its
// header, that joining, state sync and refusals stay with the transport
// because the engine has no opinion about them. These are those, and they live
// here as builder/reader pairs for one reason: a frame that is written in one
// file and read in another is two opinions about a format, and they drift. The
// pair cannot.
//
// Three types is the whole protocol on top of the intents. Anything else that
// arrives is handed to the caller's onData, where applyGameIntent() gets a
// look at it and an unrecognised type is a no-op — which is what lets a newer
// client talk to an older host without either of them crashing.
// ---------------------------------------------------------------------------
export const WIRE = Object.freeze({
  JOIN: 'join',          // client -> host, once per connection, on open
  STATE: 'state',        // host -> client, on every change
  REJECTED: 'rejected',  // host -> client, a refusal meant for the sender alone
});

/** A refusal is one sentence for a human, so it is capped at one sentence's
 *  worth. decodePeerFrame() already stops a 64 KiB frame; this stops a 60 KiB
 *  string being poured into the error banner by a host that is not the table
 *  the player meant to join. */
export const MAX_REJECT_LEN = 200;

/** The client's hello. The clientId is what gets THIS DEVICE — and only this
 *  device — its seat and its hand back mid-deal. */
export function joinFrame(name, clientId) {
  return { type: WIRE.JOIN, name, clientId };
}

/**
 * Read a hello, or null if it is not one / is unusable.
 *
 * NOTE THE ASYMMETRY between the two fields, which is deliberate:
 *
 *   A BAD NAME REFUSES THE FRAME. The engine would happily default it to
 *   "Player", but somebody who left the field blank should be told so, not
 *   silently seated under a placeholder they never chose and cannot see is a
 *   placeholder.
 *
 *   A BAD clientId IS DROPPED TO NULL AND THE JOIN PROCEEDS. It costs the
 *   sender its claim on the seat if the connection ever drops, which is the
 *   sender's problem; refusing it would mean a phone with storage switched off
 *   cannot play at all. addPlayer() takes null and simply seats them fresh.
 *
 * The character classes are guards.js's, not this file's. What lives here is
 * the shape of the frame; what a name or a clientId is allowed to contain is
 * one answer for the whole app and it is written down over there.
 */
export function readJoinFrame(msg) {
  if (!msg || msg.type !== WIRE.JOIN) return null;
  const name = validName(msg.name);
  if (name === null) return null;
  return { name, clientId: validClientId(msg.clientId) };
}

/**
 * One device's state frame. Pure, and exported for exactly one reason: it is
 * where "never send a player another player's cards" is actually written down,
 * and an invariant that important should be executable rather than reviewed.
 *
 * `priv` is null for a connection with no seat yet — a device mid-join, or one
 * whose seat has gone. privateStateFor() already returns null there; this only
 * makes sure `undefined` never goes on the wire, because JSON.stringify drops
 * an undefined value and the field would silently vanish from the frame,
 * turning "you have no hand" into "the hand key is missing", which the reader
 * below would then have to guess about.
 */
export function stateFrameFor(connId, pub, privateFor) {
  const priv = privateFor(playerIdForConn(connId));
  return { type: WIRE.STATE, pub, priv: priv || null };
}

/**
 * The other side of it: what a CLIENT will accept as a state frame.
 *
 * Easy to forget, because "the host" sounds trustworthy. It is not,
 * necessarily. A room code is four characters on a public broker, so a code
 * typed one character wrong resolves to whoever else holds that id — and
 * render() in js/ui.js does no checking at all, because on the host's own
 * device the state always exists. A `seats: 7` instead of an array is a thrown
 * TypeError inside render(), and since render() opens with clear(root) the
 * result is a blank page with no way back.
 *
 * Returns { pub, priv } or null. A null `priv` is legitimate and distinct from
 * a malformed one: a device that has connected but is not seated yet has no
 * private state, so the two cases are separated before validPrivateState() is
 * asked anything.
 */
export function readStateFrame(msg) {
  if (!msg || msg.type !== WIRE.STATE) return null;
  const pub = validPublicState(msg.pub);
  if (pub === null) return null;
  if (msg.priv === null || msg.priv === undefined) return { pub, priv: null };
  const priv = validPrivateState(msg.priv);
  if (priv === null) return null;
  return { pub, priv };
}

/** A refusal for one sender. A failed bid is not news to the rest of the
 *  table, so this is never broadcast. */
export function rejectFrame(message) {
  const text = typeof message === 'string' ? message : '';
  return { type: WIRE.REJECTED, message: text.slice(0, MAX_REJECT_LEN) };
}

/**
 * Read a refusal, or null if it is not one.
 *
 * A rejection whose message is missing or malformed still returns a SENTENCE,
 * never an empty string. An error banner with nothing in it is the worst of
 * the three possible outcomes: worse than a vague message, and worse than no
 * banner, because it tells the player something went wrong and then refuses to
 * say what. The generic wording is here rather than in the UI because it is a
 * fact about the frame — the host said no and said nothing else.
 */
export function readRejectFrame(msg) {
  if (!msg || msg.type !== WIRE.REJECTED) return null;
  const text = typeof msg.message === 'string' ? msg.message.slice(0, MAX_REJECT_LEN).trim() : '';
  return text || 'The host refused that.';
}

// ---------------------------------------------------------------------------
// Is PeerJS actually here?
//
// window.Peer comes from a CDN <script> tag in index.html, and that tag is the
// one thing in this app that can be missing while everything else works: an
// offline first load, a blocked CDN, a content blocker, a corporate proxy. The
// failure without this check is `window.Peer is not a constructor` thrown out
// of a click handler, which on a phone is a button that does nothing at all.
// ---------------------------------------------------------------------------
export function peerAvailable() {
  return typeof window !== 'undefined' && typeof window.Peer === 'function';
}

/** Shaped like PeerJS errors so they travel the caller's existing error path,
 *  with types of our own so describePeerError() can say something more useful
 *  than "unknown error". */
const PEER_MISSING = { type: 'peer-missing', message: 'PeerJS did not load.' };
const BAD_CODE = { type: 'bad-code', message: 'That is not a room code.' };

function newPeer(id) {
  const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

/**
 * A transport that does nothing, for when there is nothing to build one on.
 *
 * Reports the failure ASYNCHRONOUSLY, one turn later, so the caller has already
 * returned from createHost()/joinHost() and assigned the handle before its own
 * onError runs. A synchronous callback here would fire into a half-assigned
 * `net`, which is a much worse bug than the one being reported.
 */
function inertTransport(handlers, err, extra = {}) {
  setTimeout(() => { if (handlers.onError) handlers.onError(err); }, 0);
  return {
    peer: null,
    send() {}, sendTo() {}, broadcast() {}, pushState() {}, dropConnection() {},
    playerIds() { return []; },
    isOpen() { return false; },
    refusedFrames() { return 0; },
    badFrames() { return 0; },
    destroy() {},
    // The union of BOTH real handles, on purpose. A caller holding an inert
    // transport does not know which one it asked for — createHost() and
    // joinHost() both fail the same way — and a missing method here is a
    // TypeError thrown from a click handler on the one device where the
    // transport was already broken. The suite asserts the parity rather than
    // trusting this comment.
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Which peer errors are worth giving up over.
//
// The useful distinction is not PeerJS's own notion of fatality, it is whether
// there is still a game. Signalling failures leave existing DataConnections
// untouched, because those run directly between devices — so a host whose
// broker falls over keeps playing and only loses the ability to admit NEW
// players. That is a banner, not an ending. Only a problem with the peer
// identity itself, a code that is not a code, or a browser that cannot do
// WebRTC at all, is genuinely unrecoverable.
// ---------------------------------------------------------------------------
const UNRECOVERABLE = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'unavailable-id',
  'ssl-unavailable',
  'peer-missing',
  'bad-code',
]);

export function isFatalPeerError(err) {
  return UNRECOVERABLE.has(err && err.type);
}

// ---------------------------------------------------------------------------
// Broker socket recovery.
//
// When the socket to the signalling broker drops, PeerJS emits 'disconnected'
// and then does nothing: the event is a notification, not a recovery.
// reconnect() has to be called by hand, and until it is the peer can neither
// accept nor make new connections — permanently. So one Wi-Fi blip would
// otherwise lock the seventh player out of a game that is running perfectly
// well, and would stop a disconnected player from ever reclaiming their seat.
//
// reconnect() reuses the SAME peer id, which is what keeps the room code valid
// across the blip. Backoff doubles from a second and caps at eight, so five
// tries span roughly half a minute — comfortably past the standing "budget
// ~10s before declaring anything dead", and giving up only tells the host that
// no NEW connections can arrive.
// ---------------------------------------------------------------------------
const BROKER_RETRIES = 5;

function attachBrokerRecovery(peer, handlers = {}) {
  let tries = 0;
  let timer = null;

  const retry = () => {
    if (timer || peer.destroyed) return;
    if (tries >= BROKER_RETRIES) {
      if (handlers.onBrokerLost) handlers.onBrokerLost();
      return;
    }
    const delay = Math.min(1000 * 2 ** tries, 8000);
    tries += 1;
    timer = setTimeout(() => {
      timer = null;
      // Both checks matter: destroyed means we left the game while waiting, and
      // !disconnected means the socket came back on its own in the meantime.
      if (peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch (_) { retry(); }
    }, delay);
  };

  // Fires on the first connect AND on every successful reconnect, which is what
  // resets the ladder for the next blip.
  peer.on('open', () => {
    tries = 0;
    if (handlers.onBrokerUp) handlers.onBrokerUp();
  });

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    if (handlers.onBrokerDown) handlers.onBrokerDown();
    retry();
  });

  return { cancel() { if (timer) { clearTimeout(timer); timer = null; } } };
}

// ---------------------------------------------------------------------------
// HOST side
// ---------------------------------------------------------------------------

/**
 * Listen on the address derived from `code`.
 *
 * handlers: onOpen(code), onConnect(playerId),
 *           onJoin(playerId, { name, clientId } | null),
 *           onData(playerId, msg), onDisconnect(playerId), onError(err),
 *           onBrokerDown(), onBrokerUp(), onBrokerLost()
 *
 * EVERY ID HANDED TO A HANDLER IS ALREADY A PLAYER ID — prefixed, per the
 * security note above — so a caller cannot forget to do it. The connection id
 * is an internal detail of this module and of the `connections` map.
 *
 * onJoin and onData are split so that the caller's message handler never has
 * to know the transport's vocabulary. A JOIN frame is consumed here and never
 * reaches onData; everything else reaches onData and never reaches onJoin. The
 * `null` case of onJoin is a hello that arrived and was unusable — the caller
 * should tell the sender why, because a joiner who is dropped in silence sits
 * on a spinner until their own deadline expires.
 */
export function createHost(code, handlers = {}) {
  if (!peerAvailable()) return inertTransport(handlers, PEER_MISSING, { connections: new Map() });

  const peerId = peerIdForCode(code);
  if (peerId === null) return inertTransport(handlers, BAD_CODE, { connections: new Map() });

  const room = codeFromPeerId(peerId);
  const peer = newPeer(peerId);
  const connections = new Map();  // connId -> DataConnection, open and usable
  const attached = new Set();     // every conn accepted, open or still opening
  const recovery = attachBrokerRecovery(peer, handlers);
  let refusedTotal = 0;

  // The code handed back is the NORMALISED one, because that is the address
  // actually being listened on. A host that typed nothing and was given a code
  // by generateRoomCode() sees it unchanged; a host resuming a session from
  // storage sees whatever that stored string cleans up to, and shows the room
  // the room it is really in.
  peer.on('open', () => { if (handlers.onOpen) handlers.onOpen(room); });

  peer.on('connection', (conn) => {
    // Counted over connections ACCEPTED rather than connections that finished
    // opening, or a flood of half-open ones would never be counted at all.
    if (attached.size >= MAX_HOST_CONNS) {
      try { conn.close(); } catch (_) {}
      return;
    }

    // A peer chooses its own id, so its length is its choice too. Anything that
    // would not survive validPlayerId() is refused before it can be written
    // into a seat, a log line or a snapshot.
    if (validPlayerId(playerIdForConn(conn.peer)) === null) {
      try { conn.close(); } catch (_) {}
      return;
    }

    attached.add(conn);

    // One bucket per connection, so a flood costs the flooder its own budget
    // and nobody else's. In front of the dispatch, not behind it: every
    // accepted message fans out into a push to the whole table, so at seven
    // seats a message admitted here is multiplied by six before it leaves this
    // phone.
    const bucket = new TokenBucket();
    let refused = 0;

    // ONE CONNECTION IS ONE IDENTITY. Null until this connection has said
    // hello; after that, the clientId it said hello with.
    //
    // A connection may repeat its hello — that is a retry and costs nothing —
    // but it may not change it, and the reason is a real denial of service
    // rather than tidiness. The engine reclaims by clientId, so a connection
    // that says hello twice with two different tickets ends up as the `id` on
    // two seats; seatOf() is a findIndex and only ever finds the first, so the
    // second seat is marked connected, is nobody's, cannot be played, and
    // cannot be waited out. The table then hangs on its turn. Holding a
    // connection to the first ticket it presented costs a legitimate client
    // nothing: a device that wants a different identity opens a new
    // connection, which is what a reconnecting device does anyway.
    let joinedAs = null;
    let joined = false;

    // See HANDSHAKE_BUDGET_MS. Cleared the moment the connection opens, so a
    // live connection is never touched by it.
    let reaper = setTimeout(() => {
      reaper = null;
      // BY THIS CONNECTION, NOT BY THIS PEER — the same predicate drop() uses
      // twenty lines below, and it was `connections.has(conn.peer)` here.
      //
      // The two are only the same while a peer has one connection at a time,
      // and the case this whole file is built around is the one where it does
      // not: a phone that loses signal does not close its channel politely, so
      // it comes back on a SECOND connection while the first is still open and
      // still in the map. If that second connection then stalls in ICE, the
      // old test asked "is anything from this peer connected?", got yes, and
      // returned — leaving a connection that never opened in `attached`
      // forever. `attached` is what MAX_HOST_CONNS counts, so each stalled
      // reconnect burned a seat's worth of the ceiling permanently. Enough of
      // them and the table nobody can join is the host's own, which is the
      // exact failure HANDSHAKE_BUDGET_MS was added to prevent.
      //
      // Only the 'open' handler writes to `connections`, and it calls
      // stopReaper() first, so today this can never be true and the guard is
      // belt and braces. It is kept, and kept correct, because "the reaper
      // cannot fire on a live connection" is an invariant held by a different
      // function — and a guard that encodes the wrong invariant is worse than
      // no guard, which is what the last twenty minutes were about.
      if (connections.get(conn.peer) === conn) return;
      attached.delete(conn);
      // close(), NOT drop(). drop() fires onDisconnect, and a connection that
      // never opened was never seated — announcing its departure would mark a
      // seat away that is being played by somebody else's live channel.
      try { conn.close(); } catch (_) {}
    }, HANDSHAKE_BUDGET_MS);

    const stopReaper = () => { if (reaper) { clearTimeout(reaper); reaper = null; } };

    const refuse = () => {
      refusedTotal += 1;
      if (++refused > MAX_REFUSED_FRAMES) { try { conn.close(); } catch (_) {} }
    };

    conn.on('open', () => {
      stopReaper();
      // The same remote peer can open a second DataConnection without closing
      // the first. Overwriting the map entry would leak the old one — still
      // open, still counted, never closed — so it is retired explicitly.
      const previous = connections.get(conn.peer);
      if (previous && previous !== conn) { try { previous.close(); } catch (_) {} }
      connections.set(conn.peer, conn);
      if (handlers.onConnect) handlers.onConnect(playerIdForConn(conn.peer));
    });

    conn.on('data', (raw) => {
      const msg = decodePeerFrame(raw);
      // Junk is dropped in silence. Answering it would tell a prober that
      // somebody is listening, and cost a send for every frame they can
      // generate.
      if (!msg) { refuse(); return; }
      if (!bucket.take()) {
        // A burst is normal — the last card of a trick and the first of the
        // next arrive a heartbeat apart, and the owner dragging the max-hand
        // slider sends one message per step. A client still going after the
        // bucket is empty is not playing.
        refuse();
        return;
      }

      if (msg.type === WIRE.JOIN) {
        const hello = readJoinFrame(msg);
        // A hello with no usable name never reaches the engine, but the caller
        // is told, so the sender can be told.
        if (!hello) { if (handlers.onJoin) handlers.onJoin(playerIdForConn(conn.peer), null); return; }
        if (joined && hello.clientId !== joinedAs) { refuse(); return; }
        joined = true;
        joinedAs = hello.clientId;
        if (handlers.onJoin) handlers.onJoin(playerIdForConn(conn.peer), hello);
        return;
      }

      if (handlers.onData) handlers.onData(playerIdForConn(conn.peer), msg);
    });

    const drop = () => {
      stopReaper();
      attached.delete(conn);
      // Only if THIS connection is the one currently seated. A stale connection
      // closing after a reconnect has already taken the seat must not fire a
      // disconnect against the seat that was just handed back.
      if (connections.get(conn.peer) === conn) {
        connections.delete(conn.peer);
        if (handlers.onDisconnect) handlers.onDisconnect(playerIdForConn(conn.peer));
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => { if (handlers.onError) handlers.onError(err); });

  return {
    peer,
    connections,

    /** Player ids of everyone currently connected. NOT seats — a connection can
     *  exist before addPlayer() has run, and a seat outlives its connection for
     *  the whole of a mid-match disconnect, which is the entire point of
     *  reclaim. Anything that wants to know who is AT the table asks the
     *  engine. */
    playerIds() {
      return [...connections.keys()].map(playerIdForConn);
    },

    /** True when the broker socket is up, which is to say when a NEW player
     *  could still arrive. Existing connections are unaffected by this being
     *  false — they run device to device. */
    isOpen() { return !!peer.open; },

    /** Frames dropped across every connection, ever: junk, floods, and second
     *  identities. Not shown to anybody; it exists so the suite can prove the
     *  caps bite rather than assuming they do. */
    refusedFrames() { return refusedTotal; },

    sendTo(playerId, msg) {
      const connId = connIdForPlayer(playerId);
      if (connId === null) return;   // the host itself, or a bot: nothing to send to
      const conn = connections.get(connId);
      if (conn && conn.open) trySend(conn, msg);
    },

    broadcast(msg) {
      for (const conn of connections.values()) {
        if (conn.open) trySend(conn, msg);
      }
    },

    /**
     * Push the table to every connected device: everything public, plus exactly
     * one private slice per device — theirs.
     *
     * The whole privacy model of the game is that this loop asks privateFor()
     * for the id of the peer it is about to send to, and sends the answer to
     * nobody else. See stateFrameFor() above, which is the part of it the test
     * harness holds to account.
     *
     * `pub` is built once by the caller and serialised once per connection. At
     * seven seats in round nineteen that is six stringifies of a few kilobytes
     * on a change, which is nothing next to the WebRTC send itself; splicing a
     * pre-serialised public half into six frames would save it and would make
     * every frame in this file a string concatenation instead of an object.
     * Not worth it, and written down so the thought does not have to be had
     * twice.
     */
    pushState(pub, privateFor) {
      for (const [connId, conn] of connections) {
        if (!conn.open) continue;
        trySend(conn, stateFrameFor(connId, pub, privateFor));
      }
    },

    /** Forget and close one connection WITHOUT firing onDisconnect — it is
     *  removed from the map first, so the conn's own close handler sees that it
     *  is no longer the seated connection and short-circuits. Used when a
     *  reconnecting device takes over a seat held by a connection that has not
     *  noticed it is dead yet. */
    dropConnection(playerId) {
      const connId = connIdForPlayer(playerId);
      if (connId === null) return;
      const conn = connections.get(connId);
      connections.delete(connId);
      if (conn) { try { conn.close(); } catch (_) {} }
    },

    destroy() { recovery.cancel(); try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// CLIENT side
// ---------------------------------------------------------------------------

/**
 * Dial the host at the address derived from `code`.
 *
 * handlers: onOpen(), onState(pub, priv), onData(msg), onClose(), onError(err),
 *           onBrokerDown(), onBrokerUp(), onBrokerLost()
 *
 * `identity` is { name, clientId }. When it is given — which is every real
 * call — the JOIN frame is sent by this function, on open, before onOpen fires,
 * and exactly once per connection. That is not a convenience: it is what makes
 * "the ticket travels" a property of the transport rather than of whoever
 * remembered to write the line. Pass nothing to open a connection that says
 * nothing, which only a probe wants.
 *
 * NO TIMEOUT IN HERE, on purpose. A host that cannot be reached over WebRTC
 * produces no error at all (see the header), so somebody has to impose a
 * deadline — but what a missed deadline MEANS depends on whether there was a
 * game yet, and only the controller knows that. A first join that times out is
 * an error screen; a reconnect that times out keeps the table on screen and
 * tries again.
 */
export function joinHost(code, handlers = {}, identity = null) {
  if (!peerAvailable()) return inertTransport(handlers, PEER_MISSING);

  const hostId = peerIdForCode(code);
  if (hostId === null) return inertTransport(handlers, BAD_CODE);

  const peer = newPeer(null);
  const recovery = attachBrokerRecovery(peer, handlers);
  let conn = null;
  let bad = 0;

  peer.on('open', () => {
    // 'open' fires again after every broker reconnect. Dialling a second time
    // would leave the host holding two connections for one player, so the first
    // dial wins and a later reconnect is treated as the no-op it is for us: the
    // DataConnection runs device to device and stopped needing the broker the
    // moment the handshake finished.
    if (conn) return;
    conn = peer.connect(hostId, { reliable: true });

    conn.on('open', () => {
      if (identity) trySend(conn, joinFrame(identity.name, identity.clientId));
      if (handlers.onOpen) handlers.onOpen();
    });

    conn.on('data', (raw) => {
      // Bounded on the way in even though this is "our" host. The code was
      // typed by a human and resolves to whoever holds that id on a public
      // broker, so the thing on the other end is not necessarily the table we
      // meant to join, and a client that trusts its host is one bad code away
      // from parsing a stranger's payload.
      const msg = decodePeerFrame(raw);
      if (!msg) { bad += 1; return; }

      // State is the only frame this file understands well enough to check, and
      // it is also the only one render() walks without looking. A malformed one
      // is dropped rather than passed on, because passing it on means the
      // renderer finds out.
      if (msg.type === WIRE.STATE) {
        const frame = readStateFrame(msg);
        if (!frame) { bad += 1; return; }
        if (handlers.onState) handlers.onState(frame.pub, frame.priv);
        return;
      }

      if (handlers.onData) handlers.onData(msg);
    });

    conn.on('close', () => { if (handlers.onClose) handlers.onClose(); });
    conn.on('error', (err) => { if (handlers.onError) handlers.onError(err); });
  });

  // A peer-level error before the connection opens almost always means the room
  // code is wrong ('peer-unavailable') or the broker is unreachable.
  peer.on('error', (err) => { if (handlers.onError) handlers.onError(err); });

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },

    /** Frames from the host that were junk or the wrong shape. A table that is
     *  producing these is either not this game or not well; nothing acts on it
     *  yet, and the suite asserts against it. */
    badFrames() { return bad; },

    destroy() { recovery.cancel(); try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// Wire helper. JSON text in both directions — see the note on decodePeerFrame
// in js/guards.js for why the receiving side still has to cope with an object.
//
// The try/catch is not decoration. `conn.send` on a DataChannel that closed
// between the `conn.open` check and this line throws InvalidStateError, and
// that happens for real: the check and the send are two statements and a phone
// can leave the building between them.
// ---------------------------------------------------------------------------
function trySend(conn, msg) {
  try { conn.send(JSON.stringify(msg)); } catch (_) { /* torn down mid-send */ }
}

// ---------------------------------------------------------------------------
// The common PeerJS failures, in words a player can act on.
//
// Every one of these is read aloud off a phone by somebody who wants to be
// playing cards, so each says what to DO. "Network error" says nothing; "check
// the code, and that the host still has the tab open" is two things to try.
//
// EVERY TYPE IN `UNRECOVERABLE` HAS A CASE HERE, and that is not a coincidence
// to be maintained by hand — the harness derives the fatal set by asking
// isFatalPeerError, and fails if any member of it reaches the default branch.
// A player who has hit a dead end is the one who most needs to be told WHICH
// dead end; "Connection problem: unknown error." is the sentence that tells
// them nothing at the moment it matters most. Three of these cases exist
// because the suite caught them missing.
// ---------------------------------------------------------------------------
export function describePeerError(err) {
  switch (err && err.type) {
    case 'peer-unavailable':
      return 'No table found with that code. Check the four characters, and that the host still has the game open.';
    case 'bad-code':
      return 'That is not a room code. Check the four characters — letters and numbers, with no O, zero, I or one.';
    case 'unavailable-id':
      return 'That room code is already in use. Go back and host again for a new one.';
    case 'peer-missing':
      return 'The connection library did not load. This first load needs the internet — check your signal, then reload.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the connection server. Check your internet or Wi-Fi and try again.';
    case 'browser-incompatible':
      return 'This browser cannot do the WebRTC calls the game needs. Try Chrome, Firefox or Safari, or update the one you have.';
    case 'invalid-id':
      return 'The connection server refused that room code. Go back and host again for a new one.';
    case 'invalid-key':
      return 'The connection service turned this app away. That is a fault at our end, not yours — please try again later.';
    case 'ssl-unavailable':
      return 'The connection server could not be reached securely. Check that the address starts with https, then reload.';
    case 'webrtc':
      return 'The direct connection failed. A guest or corporate Wi-Fi network often blocks this — try mobile data.';
    default: {
      // This branch concatenates a string THIS MODULE DID NOT WRITE: it came
      // from a third-party library, over a network, in an object nobody
      // validated. Two things go wrong and both end up on a player's screen.
      //
      // A `message` that is not a string can have a getter or a toString that
      // throws — and this function is called FROM an error handler, so a
      // throw here replaces a banner the player could act on with a dead tab.
      // And a message thousands of characters long is not a banner at all.
      // Capped at MAX_REJECT_LEN for the same reason a refusal is: this is
      // one line of text under a heading, not a document.
      let detail = 'unknown error';
      try {
        const raw = err && err.message;
        if (typeof raw === 'string' && raw.trim() !== '') detail = raw.trim();
      } catch (_) { /* hostile getter — the default says enough */ }
      if (detail.length > MAX_REJECT_LEN) detail = `${detail.slice(0, MAX_REJECT_LEN - 1)}…`;
      return `Connection problem: ${detail}.`;
    }
  }
}
