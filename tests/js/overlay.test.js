"use strict";
// R-017: a page must not be able to hide or cover the activity overlay. Runs the real zbShow (actions.js)
// against a small fake DOM that models what a page can do: remove the host, restyle it, add attributes,
// put its own element in the top layer, fade the root, or fight every repair.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "actions.js"), "utf8");
const O = "http://localhost:3000";

function fakePage() {
  const observers = new Set();
  const doc = { topLayer: [], shadows: [] };
  const mutated = (target, type) => {
    for (const ob of observers) {
      if (ob.targets.some(([t, opts]) => t === target && opts[type])) ob.queue();
    }
  };
  class Style {
    constructor(owner) { this.owner = owner; this.m = new Map(); }
    setProperty(k, v, prio = "") { this.m.set(k, { v: String(v), prio }); if (this.owner.inDom) mutated(this.owner, "attributes"); }
    getPropertyValue(k) { const e = this.m.get(k); return e ? e.v : ""; }
    getPropertyPriority(k) { const e = this.m.get(k); return e ? e.prio : ""; }
  }
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attrs = new Map(); this.inDom = true; this.style = new Style(this); this.open = false; }
    get attributes() { return [...this.attrs.keys()].map((name) => ({ name })); }
    setAttribute(n, v) { this.attrs.set(n, String(v)); mutated(this, "attributes"); }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    removeAttribute(n) { if (n === "style") this.style = new Style(this); this.attrs.delete(n); mutated(this, "attributes"); }
    get id() { return this.getAttribute("id") || ""; }
    set id(v) { this.setAttribute("id", v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; mutated(this, "childList"); return c; }
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      c.parentNode = null;
      if (c.open) c.hidePopover();
      mutated(this, "childList");
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === html; }
    attachShadow(opts) { const r = new El("#shadow"); r.host = this; this.shadowMode = opts.mode; doc.shadows.push(r); return r; }
    get shadowRoot() { return null; }  // closed
    matches(sel) { return sel === ":popover-open" && this.open; }
    showPopover() {
      if (this.getAttribute("popover") === null || !this.isConnected || this.open) throw new Error("InvalidStateError");
      this.open = true; doc.topLayer.push(this);
    }
    hidePopover() { if (!this.open) throw new Error("InvalidStateError"); this.open = false; doc.topLayer = doc.topLayer.filter((x) => x !== this); }
    checkVisibility() {
      if (!this.isConnected) return false;
      for (let n = this; n; n = n.parentNode) {
        const st = n.style;
        if (st.getPropertyValue("display") === "none" || st.getPropertyValue("visibility") === "hidden" || st.getPropertyValue("opacity") === "0") return false;
      }
      return true;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }; }
    animate() { return {}; }
    set textContent(v) { this.text = v; }
  }
  const html = new El("HTML");
  html.clientWidth = 800; html.clientHeight = 600;
  const body = new El("BODY");
  html.appendChild(body);
  // Hit testing: the last thing in the top layer wins; our host takes hits only while its glow layer does.
  const hitsOn = (el) => {
    if (el.style.getPropertyValue("pointer-events") === "none" && !el.shadowMode) return false;
    if (el.shadowMode) { const r = doc.shadows.find((s) => s.host === el); return r.children.some((c) => c.style.getPropertyValue("pointer-events") === "auto"); }
    return true;
  };
  const document = {
    documentElement: html, body, activeElement: body,
    createElement: (t) => new El(t.toUpperCase()), createElementNS: (ns, t) => new El(t),
    getElementById: (id) => [...html.children].find((c) => c.id === id) || null,
    querySelector: () => null,
    elementFromPoint: () => { if (doc.pinned) return doc.pinned; for (const el of [...doc.topLayer].reverse()) if (hitsOn(el)) return el; return body; },
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; this.pending = false; observers.add(this); }
    observe(t, opts) { this.targets.push([t, opts]); }
    disconnect() { this.targets = []; this.pending = false; }
    queue() { if (this.pending) return; this.pending = true; queueMicrotask(() => { if (this.pending) { this.pending = false; this.cb([]); } }); }
  }
  const ctx = vm.createContext({ location: { origin: O }, document, MutationObserver, innerWidth: 800, innerHeight: 600,
    setTimeout: () => 0, clearTimeout: () => {}, Date, queueMicrotask });
  ctx.window = ctx;
  vm.runInContext(SRC, ctx);
  const host = () => html.children.find((c) => c.id === "zenbridge-overlay");
  return { ctx, doc, document, html, body, El, MutationObserver, host, show: (a = { kind: "glow" }) => ctx.zbShow(a, O) };
}
const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };

test("overlay: a closed shadow root in the top layer, with !important inline styles", () => {
  const p = fakePage();
  assert.deepStrictEqual({ ...p.show() }, { ok: true, visible: true, why: "" });
  const h = p.host();
  assert.strictEqual(h.shadowMode, "closed");
  assert.strictEqual(h.shadowRoot, null);
  assert.strictEqual(h.getAttribute("popover"), "manual");
  assert.ok(h.open && p.doc.topLayer.at(-1) === h);
  for (const k of ["display", "visibility", "opacity", "z-index", "pointer-events", "transform", "filter", "clip-path"]) {
    assert.strictEqual(h.style.getPropertyPriority(k), "important", k);
  }
  const glow = p.doc.shadows[0].children[0];
  assert.strictEqual(glow.style.getPropertyValue("pointer-events"), "none", "takes hits only during the check");
});

test("overlay: removed by the page, it is put back", async () => {
  const p = fakePage();
  p.show();
  p.host().remove();
  assert.strictEqual(p.host(), undefined);
  await settle();
  assert.ok(p.host() && p.host().open, "back in the page and in the top layer");
  assert.strictEqual(p.show().visible, true);
});

test("overlay: restyled or given attributes by the page, it is restored", async () => {
  const p = fakePage();
  p.show();
  const h = p.host();
  h.style.setProperty("display", "none", "important");
  await settle();
  assert.strictEqual(h.style.getPropertyValue("display"), "block");
  h.setAttribute("hidden", "");
  h.setAttribute("class", "gone");
  h.setAttribute("popover", "auto");
  await settle();
  assert.deepStrictEqual(h.attributes.map((a) => a.name).sort(), ["id", "popover"]);  // (the fake keeps style apart)
  assert.strictEqual(h.getAttribute("popover"), "manual");
  h.style.setProperty("opacity", "0");
  assert.strictEqual(p.show().visible, true, "every action re-applies the styles too");
});

test("overlay: a page element opened above it in the top layer is put below again before each action", () => {
  const p = fakePage();
  p.show();
  const cover = new p.El("DIALOG");
  p.body.appendChild(cover);
  cover.setAttribute("popover", "manual");
  cover.showPopover();
  assert.strictEqual(p.doc.topLayer.at(-1), cover);
  assert.strictEqual(p.show().visible, true);
  assert.strictEqual(p.doc.topLayer.at(-1), p.host(), "re-shown on top");
});

test("overlay: if it still isn't on top or isn't rendered, it reports not visible (the action is then refused)", () => {
  const covered = fakePage();
  covered.show();
  covered.doc.pinned = new covered.El("DIV");  // something the overlay can't get above (e.g. fullscreen)
  assert.strictEqual(covered.show().visible, false);

  const faded = fakePage();
  faded.show();
  faded.html.style.setProperty("opacity", "0");  // the page fades its whole root
  assert.strictEqual(faded.show().visible, false);

  const noPopover = fakePage();
  noPopover.El.prototype.showPopover = function () { throw new Error("not supported"); };
  assert.strictEqual(noPopover.show().visible, false, "no top layer, no actions");
});

test("overlay: under a modal dialog (where hit testing can't see it) it relies on being re-shown on top", () => {
  const p = fakePage();
  p.show();
  p.doc.pinned = new p.El("DIALOG");  // hit tests land on the dialog: everything outside it is inert
  p.document.querySelector = (sel) => (sel === ":modal" ? p.doc.pinned : null);
  assert.strictEqual(p.show().visible, true);
  assert.strictEqual(p.doc.topLayer.at(-1), p.host());
});

test("overlay: a page that keeps undoing it is marked tampered and refused from then on", async () => {
  const p = fakePage();
  p.show();
  const h = p.host();
  const fighter = new p.MutationObserver(() => { if (h.style.getPropertyValue("display") !== "none") h.style.setProperty("display", "none"); });
  fighter.observe(h, { attributes: true });
  h.style.setProperty("display", "none");
  await settle();
  assert.strictEqual(p.show().visible, false);
  fighter.disconnect();
  assert.strictEqual(p.show().visible, false, "stays refused on this page");
});

test("overlay: hidden only for screenshots, and only by zenbridge", () => {
  const p = fakePage();
  p.show();
  assert.deepStrictEqual({ ...p.show({ hide: true }) }, { ok: true, visible: false });
  assert.strictEqual(p.host().style.getPropertyValue("display"), "none");
  assert.ok(!p.host().open);
  assert.strictEqual(p.show().visible, true);
});

test("overlay: refuses a page whose origin changed", () => {
  const p = fakePage();
  assert.strictEqual(p.ctx.zbShow({ kind: "glow" }, "https://other.example").code, "OUT_OF_SCOPE");
});
