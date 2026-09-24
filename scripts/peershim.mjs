// ============================================================================
// peershim.mjs — a fake PeerJS and a fake clock, so js/net.js can be tested.
//
// NOT A THROWAWAY. scripts/domshim.mjs is here permanently because ui.js needs
// a DOM; this is here permanently for the same reason, one layer down. Without
// it, net.js would be the second of nine checkpoints verified by opening two
// browser tabs and looking, and "I tried it and it worked" is the thing this
// project has spent eight checkpoints not doing.
//
// ---------------------------------------------------------------------------
// WHAT IT FAKES, AND WHAT IT REFUSES TO FAKE
// ---------------------------------------------------------------------------
// It fakes the PeerJS SURFACE: `new Peer(id)`, the 'open'/'connection'/
// 'error'/'disconnected' events, DataConnections with 'open'/'data'/'close'/
// 'error', and a broker that maps peer ids to peers. That is precisely the
// surface js/net.js touches, and no more.
//
// It does NOT fake WebRTC, NAT, ICE or a relay, and the distinction matters
// when reading a green suite. Everything in the header of js/net.js about
// hole-punching, symmetric NAT and silent failure is UNTESTED BY THIS FILE and
// untestable by any file — the failure mode there is that nothing happens,
// which is indistinguishable from a test that forgot to assert. What this
// proves is that the protocol, the caps, the identity rules and the privacy
// split are right. Whether two particular phones on two particular networks
// can see each other is not a property of this code.
//
// ---------------------------------------------------------------------------
// THE CLOCK IS FAKE ON PURPOSE, AND IT PATCHES Date.now TOO
// ---------------------------------------------------------------------------
// Three things in js/net.js are timers: the half-open connection reaper at
// thirty seconds, the broker reconnect ladder at 1/2/4/8/8 seconds, and the
// inert transport's one-turn delay. A test that used real time to reach the
// reaper would take thirty seconds and would therefore not be run.
//
// Date.now() is patched alongside setTimeout because guards.js's TokenBucket
// defaults its `now` argument to Date.now() — deliberately, so that net.js need
// not thread a clock through its data handler. Faking only setTimeout would
// leave the rate limiter refilling against the wall clock while everything
// around it moved in jumps, and the bucket would behave differently depending
// on how fast the machine running the suite was. Both clocks or neither.
//
// The fake epoch is a real-looking millisecond value rather than zero, because
// js/util.js's session TTL does `Date.now() - s.ts` and a zero epoch makes
// every stored timestamp look like it came from 1970.
//
// ---------------------------------------------------------------------------
// WHERE IT IS DELIBERATELY STRICTER THAN PEERJS
// ---------------------------------------------------------------------------
// Following domshim.mjs's rule: a shim that accepts more than the real thing
// turns a real bug into a passing test.
//
//   * send() on a closed connection THROWS, as a real DataChannel does with
//     InvalidStateError. That is what makes trySend()'s try/catch a tested
//     line rather than a hopeful one.
//   * A connection delivers data only to the peer it is actually paired with.
//     There is no broadcast anywhere in here, so a privacy assertion cannot
//     pass because the shim was generous.
//   * Every event is delivered on a LATER TICK, never synchronously inside the
//     call that caused it. Real PeerJS is asynchronous, and code that happens
//     to work when 'open' fires inside the constructor does not work in a
//     browser.
// ============================================================================

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

const FAKE_EPOCH = 1700000000000;   // 2023-11-14, so a TTL subtraction is sane

let clock = null;

/**
 * Replace setTimeout, clearTimeout and Date.now with a clock the test drives.
 *
 * Returns a handle; call restore() when finished. Installing twice without
 * restoring throws rather than nesting, because a nested install would restore
 * the fake and leave the suite permanently on a frozen clock, and the symptom
 * of that is a later section hanging with no message.
 */
export function installClock() {
  if (clock) throw new Error('peershim: a clock is already installed');

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;

  let now = 0;
  let seq = 0;
  const timers = new Map();

  globalThis.setTimeout = (fn, ms = 0) => {
    const id = ++seq;
    // `at` alone is not a total order — two timers due at the same instant must
    // fire in the order they were scheduled, which is what a real event loop
    // does and what the reaper-versus-open race depends on.
    timers.set(id, { at: now + Math.max(0, ms || 0), seq: id, fn });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  Date.now = () => FAKE_EPOCH + now;

  clock = {
    /** Milliseconds since the clock was installed. */
    elapsed() { return now; },

    /** How many timers are still outstanding. A leaked reaper shows up here. */
    pending() { return timers.size; },

    /**
     * Run every timer due within the next `ms`, in time order, including ones
     * scheduled by the callbacks along the way. advance(0) is "flush
     * everything already due", which is how a message gets delivered.
     */
    advance(ms = 0) {
      const target = now + Math.max(0, ms);
      let fired = 0;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at > target) continue;
          if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
        }
        if (!next) { now = target; return fired; }
        timers.delete(next.seq);
        now = next.at;
        next.fn();
        if (++fired > 100000) throw new Error('peershim: advance() is not terminating');
      }
    },

    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realNow;
      clock = null;
    },
  };
  return clock;
}

/** Schedule for the next tick of whatever clock is installed. */
function soon(fn) { setTimeout(fn, 0); }

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

class Emitter {
  constructor() { this._handlers = Object.create(null); }

  on(event, fn) {
    (this._handlers[event] || (this._handlers[event] = [])).push(fn);
    return this;   // PeerJS's EventEmitter chains; nothing here relies on it
  }

  emit(event, ...args) {
    // Copied before iterating: a handler that calls destroy() mutates the list
    // it is being iterated over, and in a browser that would be a different
    // and more confusing crash than the one the test is looking for.
    for (const fn of (this._handlers[event] || []).slice()) fn(...args);
  }

  /** How many handlers are attached. Used by assertions about wiring, not by
   *  the shim itself. */
  listeners(event) { return (this._handlers[event] || []).length; }
}

// ---------------------------------------------------------------------------
// DataConnection
// ---------------------------------------------------------------------------

class FakeConn extends Emitter {
  /** `remoteId` is the peer id of the OTHER end, which is what PeerJS puts on
   *  conn.peer and what js/net.js turns into a player id. */
  constructor(remoteId) {
    super();
    this.peer = remoteId;
    this.open = false;
    this.closed = false;
    this.sent = [];          // everything this end put on the wire, for tests
    this.breakSend = false;  // make send() throw even while open
    // Set ONLY by vanish(), and the difference between it and `open` is the
    // difference between a channel that died and one that was closed. See the
    // note on send() below.
    this.dead = false;
    this._other = null;
  }

  _pair(other) { this._other = other; }

  _openUp() {
    if (this.closed || this.open) return;
    this.open = true;
    this.emit('open');
  }

  /**
   * STRICTER THAN IT LOOKS. A real RTCDataChannel throws InvalidStateError when
   * sent on after it closes, and js/net.js's trySend() exists for exactly that
   * — the `conn.open` check and the send are two statements, and a phone can
   * leave the building in between.
   *
   * -------------------------------------------------------------------------
   * A SEND THAT BEATS A CLOSE STILL ARRIVES, and the `dead` flag rather than
   * `open` is what makes that true.
   * -------------------------------------------------------------------------
   * This line used to re-check `other.open` at DELIVERY time, which meant a
   * close() in the same tick threw away data that had already been handed to
   * send(). That is not what a real channel does: closing an RTCDataChannel
   * runs a closing procedure that transmits what is still in the buffer, and
   * the InvalidStateError above is the spec's way of saying "too late" — it
   * is thrown on the SEND, not applied retroactively to one that succeeded.
   *
   * It was found by js/main.js sending WIRE.REPLACED immediately before
   * retiring a superseded connection. Every frame vanished, and the fix
   * looked broken while being correct. A shim that is stricter than the real
   * thing does not turn a real bug into a passing test — it does the other
   * one, which is just as expensive to chase.
   *
   * vanish() still eats in-flight data, because that is the honest model of a
   * phone in a tunnel and it is the reason these two states are now separate
   * rather than sharing `open`.
   */
  send(data) {
    if (this.breakSend) throw new Error('InvalidStateError: simulated dead channel');
    if (!this.open) throw new Error('InvalidStateError: connection is not open');
    this.sent.push(data);
    const other = this._other;
    if (!other) return;
    soon(() => { if (!other.dead) other.emit('data', data); });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    soon(() => this.emit('close'));
    const other = this._other;
    if (other && !other.closed) {
      other.closed = true;
      other.open = false;
      soon(() => other.emit('close'));
    }
  }

  /** A channel that dies without a clean close — no 'close' on either end.
   *  This is what a phone going into a tunnel looks like, and it is why the
   *  host has a reaper at all. */
  vanish() {
    this.open = false;
    this.dead = true;
    if (this._other) { this._other.open = false; this._other.dead = true; }
  }
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

class FakePeer extends Emitter {
  constructor(broker, id, opts) {
    super();
    this.broker = broker;
    this.id = id || broker.mintId();
    this.opts = opts || {};
    this.open = false;
    this.destroyed = false;
    this.disconnected = false;
    broker._register(this);
  }

  connect(toId, opts) {
    return this.broker._connect(this, toId, opts);
  }

  /** PeerJS's own: drop the broker socket but keep the data channels. */
  disconnect() {
    if (this.destroyed || this.disconnected) return;
    this.disconnected = true;
    this.open = false;
    this.broker._unregister(this);
    soon(() => this.emit('disconnected', this.id));
  }

  reconnect() {
    if (this.destroyed || !this.disconnected) return;
    this.disconnected = false;
    this.broker._register(this);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.disconnected = true;
    this.broker._unregister(this);
    for (const conn of this.broker._connsOf(this)) conn.close();
    soon(() => this.emit('close'));
  }
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export class FakeBroker {
  constructor() {
    this.peers = new Map();    // peer id -> FakePeer, currently registered
    this.conns = new Map();    // FakePeer -> Set<FakeConn>, the local ends
    this.reachable = true;     // the signalling server itself
    this.neverOpen = false;    // accept connections that never finish opening
    this._minted = 0;
  }

  /** Real PeerJS ids are UUID-shaped when the caller does not pick one. The
   *  shape does not matter here; not colliding does. */
  mintId() { return `anon-${++this._minted}`; }

  _register(peer) {
    if (!this.reachable) {
      soon(() => {
        if (peer.destroyed) return;
        peer.emit('error', { type: 'network', message: 'could not reach the broker' });
        // AND THEN 'disconnected', which is the half that is easy to leave
        // out and that breaks the recovery ladder if you do. Real PeerJS
        // clears its own `_disconnected` flag the moment reconnect() is
        // called, so a reconnect attempt that then FAILS must put the flag
        // back — otherwise attachBrokerRecovery's `!peer.disconnected` guard
        // decides the socket came back on its own and stops retrying after
        // one attempt.
        peer.disconnected = true;
        peer.open = false;
        peer.emit('disconnected', peer.id);
      });
      return;
    }
    if (this.peers.has(peer.id) && this.peers.get(peer.id) !== peer) {
      soon(() => {
        if (peer.destroyed) return;
        peer.emit('error', { type: 'unavailable-id', message: `ID "${peer.id}" is taken` });
        // PeerJS tears the peer down after a fatal error rather than leaving
        // it half alive. A shim that left it usable would let a test pass
        // that a browser would fail.
        peer.destroy();
      });
      return;
    }
    this.peers.set(peer.id, peer);
    soon(() => {
      if (peer.destroyed) return;
      peer.open = true;
      peer.emit('open', peer.id);
    });
  }

  _unregister(peer) {
    if (this.peers.get(peer.id) === peer) this.peers.delete(peer.id);
  }

  _connsOf(peer) {
    return [...(this.conns.get(peer) || [])];
  }

  _track(peer, conn) {
    let set = this.conns.get(peer);
    if (!set) { set = new Set(); this.conns.set(peer, set); }
    set.add(conn);
  }

  _connect(from, toId, opts = {}) {
    const near = new FakeConn(toId);
    this._track(from, near);

    soon(() => {
      const host = this.peers.get(toId);
      if (!this.reachable || !host || !host.open) {
        // PeerJS reports an unknown id at the PEER level, not on the
        // connection — which is why js/net.js listens for peer errors on the
        // client and not only for connection errors.
        from.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${toId}` });
        return;
      }
      const far = new FakeConn(from.id);
      this._track(host, far);
      near._pair(far);
      far._pair(near);

      // The host is told about the connection BEFORE it opens, which is the
      // real order and the reason createHost() attaches its handlers inside
      // the 'connection' callback.
      host.emit('connection', far);

      if (this.neverOpen || opts.neverOpen) return;   // the half-open case
      soon(() => { far._openUp(); near._openUp(); });
    });

    return near;
  }

  // --- things a test does to the network ------------------------------------

  /** The signalling server falls over. Existing data channels are UNTOUCHED —
   *  that is the whole point of the distinction js/net.js draws between a
   *  broker failure and a fatal one, and a shim that also killed the channels
   *  would make that assertion meaningless. */
  brokerDown() {
    this.reachable = false;
    for (const peer of [...this.peers.values()]) {
      this.peers.delete(peer.id);
      peer.disconnected = true;
      peer.open = false;
      soon(() => peer.emit('disconnected', peer.id));
    }
  }

  brokerUp() { this.reachable = true; }

  /**
   * The socket comes back WITHOUT anybody having called reconnect().
   *
   * Real PeerJS does this on some paths and clears its own `_disconnected`
   * flag as it goes. It matters here because js/net.js's retry timer may
   * already be armed when it happens, and `!peer.disconnected` is the only
   * thing standing between that timer and a reconnect() call against a peer
   * that is perfectly healthy — which the library treats as an error.
   */
  healSocket(peer) {
    if (peer.destroyed) return;
    this.reachable = true;
    this.peers.set(peer.id, peer);
    peer.disconnected = false;
    peer.open = true;
    soon(() => peer.emit('open', peer.id));
  }

  /** Every live connection either end of `peer` holds. */
  connectionsOf(peer) { return this._connsOf(peer); }
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Put a working fake PeerJS on `window.Peer` and a controllable clock on the
 * globals. Returns { broker, clock, uninstall }.
 *
 * `window` is created if it does not exist, because peerAvailable() checks
 * `typeof window !== 'undefined'` first and node has no window — which is also
 * the exact code path that makes js/net.js safe to import in this suite at all.
 */
export function installPeerJS() {
  const broker = new FakeBroker();
  const clk = installClock();

  const hadWindow = typeof globalThis.window !== 'undefined';
  if (!hadWindow) globalThis.window = {};
  const previousPeer = globalThis.window.Peer;

  globalThis.window.Peer = function Peer(idOrOpts, maybeOpts) {
    return typeof idOrOpts === 'string'
      ? new FakePeer(broker, idOrOpts, maybeOpts)
      : new FakePeer(broker, null, idOrOpts);
  };

  return {
    broker,
    clock: clk,
    uninstall() {
      if (previousPeer === undefined) delete globalThis.window.Peer;
      else globalThis.window.Peer = previousPeer;
      if (!hadWindow) delete globalThis.window;
      clk.restore();
    },
  };
}

/** Run a block with no PeerJS at all, which is the blocked-CDN case. The
 *  clock stays installed, because the inert transport reports its failure on a
 *  timer and a test that cannot advance would see nothing happen. */
export function withoutPeerJS(fn) {
  const hadWindow = typeof globalThis.window !== 'undefined';
  if (!hadWindow) globalThis.window = {};
  const previous = globalThis.window.Peer;
  delete globalThis.window.Peer;
  try { return fn(); } finally {
    if (previous !== undefined) globalThis.window.Peer = previous;
    if (!hadWindow) delete globalThis.window;
  }
}

// ---------------------------------------------------------------------------
// localStorage
//
// Here rather than in domshim.mjs because js/util.js's storage half is what
// needs it and js/net.js is what reads that. Deliberately capable of being
// BROKEN, because the interesting case is not the happy path: `localStorage`
// throws on access in private browsing and in a locked-down webview, and every
// accessor in util.js is wrapped for that reason. A shim that could only
// succeed would leave all of those catch blocks unexecuted.
// ---------------------------------------------------------------------------

export function installStorage({ broken = false, quota = Infinity } = {}) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = had ? globalThis.localStorage : undefined;
  const map = new Map();

  const store = {
    getItem(k) {
      if (broken) throw new Error('SecurityError: storage is not available');
      return map.has(String(k)) ? map.get(String(k)) : null;
    },
    setItem(k, v) {
      if (broken) throw new Error('SecurityError: storage is not available');
      if (String(v).length > quota) throw new Error('QuotaExceededError');
      map.set(String(k), String(v));
    },
    removeItem(k) {
      if (broken) throw new Error('SecurityError: storage is not available');
      map.delete(String(k));
    },
    clear() { map.clear(); },
    /** The raw contents, for assertions about WHICH keys were written. */
    keys() { return [...map.keys()]; },
    raw: map,
  };

  if (broken) {
    // Accessing the global itself throws, not just its methods. That is the
    // harsher of the two real failures and the one an unwrapped `localStorage
    // .getItem(...)` dies on before it reaches a method at all.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage is not available'); },
    });
  } else {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true, value: store,
    });
  }

  return {
    store,
    restore() {
      if (had) {
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true, writable: true, value: previous,
        });
      } else {
        delete globalThis.localStorage;
      }
    },
  };
}

// NO crypto SHIM HERE ON PURPOSE. generateRoomCode() and newClientId() both
// draw from crypto.getRandomValues, and a distribution assertion needs a
// stream it can replay — but scripts/test-engine.mjs already replaces the
// global with a seeded generator for the card shuffle, before anything in this
// file runs. A second one would be two sources of determinism that can
// disagree, and the failure would look like a flaky test.
