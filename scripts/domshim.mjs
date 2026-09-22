// ============================================================================
// domshim.mjs — just enough DOM to run js/ui.js under node, plus the tools to
// interrogate what it built.
//
// WHY THIS EXISTS. Every other module in this project is testable because it
// is pure. ui.js is pure too — same `app` in, same tree out — but its output
// is a DOM tree, and node has no DOM. Without this, checkpoint 7 would be the
// one checkpoint verified by looking at it, which is not verification.
//
// WHY NOT jsdom. Because a dependency needs asking for, and because the
// surface ui.js actually touches is four methods and one property. jsdom would
// be ten megabytes to get `appendChild`.
//
// ---------------------------------------------------------------------------
// THE SHIM IS DELIBERATELY STRICT, AND THAT IS THE ENTIRE POINT
// ---------------------------------------------------------------------------
// A shim that accepts more than a browser does is worse than no shim: it turns
// a real bug into a passing test. So where the real DOM throws, this throws.
//
//   * appendChild rejects anything that is not a node. In a browser,
//     `appendChild('hello')` is a TypeError. If this quietly accepted strings,
//     the day someone drops a bare string into el()'s children — bypassing the
//     createTextNode path that makes this UI injection-proof — the suite would
//     say nothing. That is the one failure this project can least afford.
//   * setAttribute rejects non-strings, because the real one stringifies
//     silently and hides `setAttribute('disabled', false)`, which produces a
//     DISABLED button. util.js's el() is written to avoid exactly that; this
//     is the assertion that it still does.
//   * A node appended twice MOVES rather than duplicating, as the real one
//     does, so a tree built by accident twice does not look like two trees.
// ============================================================================

let uid = 0;

class Node {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.id = ++uid;
    this.attrs = Object.create(null);
    this.handlers = Object.create(null);
    this.children = [];
    this.parent = null;
    this._className = '';
  }

  get className() { return this._className; }

  /**
   * THE ONE THAT MUST THROW. This shim cannot parse HTML, and that is not a
   * limitation to route around — it is the property the injection section
   * depends on.
   *
   * If innerHTML were a plain property, adding an `html:` escape hatch to
   * util.js's el() would set a string on an object, build no elements, and
   * sail through the "no string a peer controls becomes an element" check
   * with nothing to find. The test would pass and the hole would be open.
   * Throwing means that mutation dies loudly instead.
   */
  set innerHTML(_) {
    throw new Error('innerHTML is not available: every string must go through createTextNode');
  }

  get innerHTML() {
    throw new Error('innerHTML is not available: read .text instead');
  }

  // className and setAttribute('class') are the same storage in a browser.
  // Keeping them as two fields here would let a test pass on a class the
  // browser would have overwritten.
  set className(v) {
    this._className = String(v);
    this.attrs.class = this._className;
  }

  setAttribute(k, v) {
    if (typeof v !== 'string') {
      throw new TypeError(`setAttribute(${k}, ${typeof v}) — el() must stringify first`);
    }
    if (k === 'class') this._className = v;
    this.attrs[k] = v;
  }

  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }

  addEventListener(type, fn) {
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
  }

  appendChild(child) {
    if (!child || child.nodeType === undefined) {
      throw new TypeError(`appendChild(${typeof child}) — not a node`);
    }
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error('removeChild: not a child of this node');
    this.children.splice(i, 1);
    child.parent = null;
    return child;
  }

  get firstChild() { return this.children[0] || null; }

  /** Concatenated text of the whole subtree, as textContent gives it. */
  get text() {
    return this.nodeType === 3
      ? this.data
      : this.children.map((c) => c.text).join('');
  }

  get classList() { return this._className.split(/\s+/).filter(Boolean); }
  hasClass(c) { return this.classList.includes(c); }

  get disabled() { return 'disabled' in this.attrs; }

  /**
   * Fire a handler the way a click does. No bubbling — nothing here needs it,
   * and a fake bubble would be a fake fact.
   *
   * A DISABLED ELEMENT DOES NOT FIRE, because a disabled element in a browser
   * does not fire. This shim is stricter than the DOM wherever the DOM throws,
   * but it must never be stricter about what REACHES a handler: an owner-gated
   * button that a real browser never delivers a click to would otherwise be
   * reported as a security hole, and chasing an invented hole is worse than
   * not looking. The first run of the owner-gating section did exactly that —
   * 272 phantom escapes through the five `disabled: !owner` config controls.
   *
   * `force` fires anyway, for the assertion that wants to know WHICH handlers
   * are owner-only so it can check they are all disabled. That question is
   * about the tree, not about dispatch, and it needs to see past the gate.
   */
  click(ev = {}, { force = false } = {}) {
    if (this.disabled && !force) return 0;
    for (const fn of this.handlers.click || []) fn(ev);
    return (this.handlers.click || []).length;
  }

  input(value) {
    for (const fn of this.handlers.input || []) fn({ target: { value } });
    return (this.handlers.input || []).length;
  }
}

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.tag = '#text';
    this.data = String(data);
    this.parent = null;
    this.children = [];
    this.attrs = Object.create(null);
    this.handlers = Object.create(null);
    this._className = '';
  }

  get text() { return this.data; }
  get classList() { return []; }
  hasClass() { return false; }
  getAttribute() { return null; }
  hasAttribute() { return false; }
}

/** Install the shim globally and hand back a fresh root. util.js reaches for
 *  the global `document`, which is what a browser gives it, so that is what
 *  this gives it too rather than threading a document through every call. */
export function installDOM() {
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (data) => new TextNode(data),
  };
  return new Node('div');
}

// ---------------------------------------------------------------------------
// Walking what got built
// ---------------------------------------------------------------------------

/** Every node in the subtree, root first, in document order. */
export function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}

export function findAll(node, pred) { return walk(node).filter(pred); }
export function find(node, pred) { return walk(node).find(pred) || null; }

/** Elements carrying the given class, at any depth. */
export function byClass(node, cls) {
  return findAll(node, (n) => n.nodeType === 1 && n.hasClass(cls));
}

export function byTag(node, tag) {
  return findAll(node, (n) => n.nodeType === 1 && n.tag === tag);
}

/** Anything a person can operate: buttons, inputs, or a node with a click
 *  handler bolted on. The set every accessibility assertion sweeps. */
export function interactive(node) {
  return findAll(node, (n) => n.nodeType === 1
    && (n.tag === 'button' || n.tag === 'input' || (n.handlers.click || []).length > 0));
}

/** A compact tree dump, for when an assertion fails and the shape is the
 *  question. Not used by any assertion — only by the human reading the failure. */
export function dump(node, depth = 0) {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) return `${pad}"${node.data}"`;
  const cls = node._className ? `.${node._className.split(/\s+/).join('.')}` : '';
  const kids = node.children.map((c) => dump(c, depth + 1)).join('\n');
  return `${pad}<${node.tag}${cls}>${kids ? `\n${kids}` : ''}`;
}
