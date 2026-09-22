// ============================================================================
// sw.js — the service worker. Offline support, and nothing else.
//
// AT THE REPOSITORY ROOT, NOT IN js/, and that is forced rather than chosen. A
// worker's default scope is the directory it is served from, so a worker at
// ./js/sw.js could only ever control ./js/* — it would never see a navigation
// to the page. Widening the scope needs a `Service-Worker-Allowed` response
// header, and GitHub Pages does not let you set headers. So: root.
//
// It is also NOT a module. `type: 'module'` workers are supported now but the
// registration in index.html does not ask for one, and importing js/util.js in
// here would be a mistake anyway — see the next paragraph.
//
// ---------------------------------------------------------------------------
// THE ONE RULE THAT MATTERS: THIS WORKER NEVER WRITES TO THE CACHE
// EXCEPT DURING install.
// ---------------------------------------------------------------------------
// There is no runtime caching, no stale-while-revalidate, no "cache it if the
// fetch succeeded". The precache is written once per version and read from
// thereafter. That single decision is what makes three separate hazards
// impossible rather than merely unlikely:
//
//   1. THE BEACON. Nothing cross-origin is ever stored — not the PeerJS bundle
//      from unpkg, not the fonts, and above all not anything on the signalling
//      broker. A cached signalling response is a peer connection that dials a
//      conversation which ended yesterday, and the symptom is a room code that
//      "works" and then sits there forever. The origin check in the fetch
//      handler below refuses to even respond to those, and with no write path
//      there is nothing to disable.
//
//   2. THE HEALTH PROBE. js/config.js warns that a cached "yes" from a
//      /health endpoint strands the app in server mode while the machine is
//      off. v1 has no server, but the day SERVER_HEALTH is filled in, this
//      worker is already safe by construction and nobody has to remember.
//
//   3. THE HALF-STALE SHELL. Every byte the app runs comes from one cache
//      written by one install, so js/ui.js can never be the new version while
//      js/state.js is the old one. Mixed-version module graphs fail in ways
//      that look like logic bugs, and they are the reason the "Clear cache &
//      reload" button exists at all.
//
// ============================================================================

// ###########################################################################
//
//  VERSION
//
// ###########################################################################

// BUMP THIS WHENEVER ANY FILE IN SHELL CHANGES — not just when the list of
// files changes, but when their CONTENTS do.
//
// The reason is the install step below: caches.addAll() is a no-op against a
// cache that already exists under this name, so a redeploy that keeps the name
// keeps serving the old bytes forever. The name IS the version number; there
// is nothing else in a service worker that can carry one.
//
// The browser re-fetches this file on navigation and reinstalls when its bytes
// differ, so changing this string is also what triggers the update.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A CONTENT HASH AND NOT 'v1', 'v2', 'v3'
// ---------------------------------------------------------------------------
// It was a hand-incremented version, and it sat at v1 through a round of fixes
// to six of the files below. Nothing failed. The suite was green, the bugs
// were fixed in the repository, and every returning visitor would have kept
// the broken build indefinitely — because the only thing standing between a
// fix and the people it was for was somebody remembering to edit this line.
//
// A hand-written version number cannot be checked: no test can know whether
// you MEANT the bytes to change. A fingerprint of the bytes can. This is the
// sha256 of every path in SHELL, in sorted order, with line endings normalised
// so that a checkout on Windows and a checkout on Linux agree.
//
// scripts/test-engine.mjs recomputes it and fails if it does not match, and
// the failure prints the value to paste. So the rule is no longer "remember to
// bump this" — it is "the suite will tell you the new number". Note what is
// NOT in SHELL and therefore not in the hash: sw.js itself. A worker does not
// precache itself, which is also the only reason this can be computed at all.
const SHELL_STAMP = '1b70d19f30ae';

// The stamp is the version. Keeping the 'judgement-shell-' prefix matters —
// the activate handler below deletes caches by it, and deleting by prefix is
// what stops this worker from touching a sibling project's caches on the same
// github.io origin.
const CACHE_NAME = `judgement-shell-${SHELL_STAMP}`;

// ###########################################################################
//
//  THE SHELL
//
// ###########################################################################

// EVERY STATIC ASSET THE SITE SERVES. Not "every module in the import graph" —
// every asset, which is a strictly larger and much easier set to check. The
// import graph is a thing you have to trace; the contents of js/ and css/ and
// icons/ are a thing you can list. scripts/test-engine.mjs asserts this list
// against what is actually on disk in both directions, so a new module that is
// added and not listed fails the suite rather than failing offline three weeks
// later on somebody's train.
//
// All paths relative, so the worker's scope — and therefore a GitHub Pages
// project subpath — is picked up automatically.
const SHELL = [
  // The page. BOTH spellings, deliberately: a navigation to the bare directory
  // matches './' and a navigation to the file matches './index.html', and
  // although the server returns the same bytes for each, the Cache API matches
  // on the request URL and does not know that.
  './',
  './index.html',

  './manifest.webmanifest',
  './css/app.css',

  // The modules. In dependency order for readability only; addAll does not
  // care and neither does the module loader.
  './js/main.js',
  './js/ui.js',
  './js/net.js',
  './js/bot.js',
  './js/intents.js',
  './js/guards.js',
  './js/state.js',
  './js/rules.js',
  './js/scoring.js',
  './js/cards.js',
  './js/trick.js',
  './js/util.js',
  // Not reachable from main.js today — nothing imports it, by design; it is
  // the server seam js/config.js documents at length. Precached anyway,
  // because the rule this list follows is "everything in js/", and a rule with
  // an exception in it is a rule somebody gets wrong. It costs 3kB.
  './js/config.js',

  './icons/icon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// ###########################################################################
//
//  INSTALL
//
// ###########################################################################

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // addAll IS ALL-OR-NOTHING, and that is why it is used instead of a loop
    // of put()s that tolerate failures. If one module 404s — a rename that
    // missed this list, a bad deploy — the install rejects, this worker never
    // activates, and the previous version keeps serving. The alternative is a
    // cache that is missing js/state.js and an app that is broken offline and
    // fine online, which is the hardest kind of report to act on.
    await cache.addAll(SHELL);
  })());

  // NO self.skipWaiting(). A new worker waits until every tab running the old
  // one has gone.
  //
  // Taking over immediately is the popular choice and it is wrong here. A
  // match runs for nineteen rounds and can outlast a deploy; skipWaiting would
  // let a page that already loaded the old js/ui.js start fetching the new
  // js/state.js from an activation that happened underneath it. Waiting means
  // an update lands one visit late, which is a cost the "Clear cache & reload"
  // button in the footer exists to pay off on demand.
});

// ###########################################################################
//
//  ACTIVATE
//
// ###########################################################################

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache that is not this version's. Filtered by name rather
    // than deleting everything, because another app on the same origin — a
    // sibling project under the same github.io user — has its caches here too,
    // and this worker has no business touching them.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('judgement-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );

    // Take control of pages that were already open. With no skipWaiting above
    // this only ever matters for the FIRST install — the visit where the page
    // loaded before any worker existed — and it means that visit gets offline
    // support without needing a reload first.
    await self.clients.claim();
  })());
});

// ###########################################################################
//
//  FETCH
//
// ###########################################################################

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Not calling event.respondWith() at all hands the request back to the
  // browser untouched, which is the right answer for everything below and is
  // cheaper and safer than proxying it.

  // Only GET. A POST is never cacheable and the Cache API will not store one.
  if (req.method !== 'GET') return;

  // CROSS-ORIGIN GOES STRAIGHT TO THE NETWORK, ALWAYS. The PeerJS bundle, the
  // fonts, the STUN/TURN servers and every byte of signalling traffic are all
  // somebody else's origin. See the header: this is the beacon rule, and it is
  // enforced here rather than by an allowlist because an allowlist is a list
  // of the third parties you thought of.
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return; // Not a URL this worker can reason about; leave it alone.
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // A NAVIGATION ALWAYS GETS index.html. Any URL under the scope — a shared
    // link with a stale path, a bookmark to something that no longer exists —
    // resolves to the one page this app has. Cache first, because the whole
    // point is that it works on a train.
    if (req.mode === 'navigate') {
      const page = await cache.match('./index.html');
      if (page) return page;
      return fetch(req);
    }

    // ignoreSearch, so that ./js/main.js?v=2 — a cache-buster somebody appends
    // while debugging, or a query a tool adds — still matches the precached
    // ./js/main.js rather than silently falling through to the network and
    // breaking offline.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    // Not ours. Fetch it and, per the rule at the top of this file, do NOT
    // store the result.
    try {
      return await fetch(req);
    } catch (_) {
      // Offline and not precached. Response.error() reproduces what the
      // browser would have done on its own, so the page's own error handling
      // sees a normal network failure rather than a 200 with a body it cannot
      // parse — which is what returning a synthesised Response here would do.
      return Response.error();
    }
  })());
});
