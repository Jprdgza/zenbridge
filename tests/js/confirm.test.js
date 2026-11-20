"use strict";
// ZB-14: the Allow window answers yes only to a real pointer click on an enabled Allow, never to Enter or
// Space, and keyboard focus stays on "Don't allow". Runs the real pages/confirm.js against a small fake page.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "pages", "confirm.js"), "utf8");
const ID = "a".repeat(32);

async function open(details) {
  const els = {};
  let focused = null;
  const el = (id) => els[id] || (els[id] = {
    id, hidden: false, disabled: id === "allow", textContent: "", tabIndex: id === "allow" ? -1 : 0, children: [], on: {},
    addEventListener(t, f) { (this.on[t] = this.on[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; },
    focus() { const was = focused; focused = this; if (was !== this) for (const f of this.on.focus || []) f({}); },
  });
  const timers = [];
  const answers = [];
  let closed = false;
  const docOn = {};
  const ctx = vm.createContext({
    location: { hash: `#${ID}` },
    document: { getElementById: el, createElement: (t) => ({ tagName: t, textContent: "", className: "", children: [], appendChild(c) { this.children.push(c); } }),
      addEventListener: (t, f) => { docOn[t] = f; } },
    window: { close: () => { closed = true; } },
    setTimeout: (f) => { timers.push(f); return timers.length; },
    browser: { runtime: { getBackgroundPage: async () => ({
      zbConfirmDetails: (id) => (id === ID ? JSON.stringify(details) : null),
      zbConfirmAnswer: (id, allow) => answers.push([id, allow]),
    }) } },
  });
  vm.runInContext(SRC, ctx);
  await new Promise((r) => setImmediate(r));
  const click = (id, ev) => { for (const f of el(id).on.click || []) f({ isTrusted: true, detail: 0, pointerType: "", ...ev }); };
  return { el, answers, timers, click, focused: () => focused, closed: () => closed, key: (k) => docOn.keydown({ key: k }) };
}
const upload = { kind: "upload", origin: "https://site.example", files: [{ name: "report.pdf", folder: "~/Downloads/work", bytes: 2048 }] };

test("ZB-14: focus starts on Don't allow, and Allow can't take keyboard focus", async () => {
  const w = await open(upload);
  assert.strictEqual(w.focused().id, "deny");
  w.timers.forEach((f) => f());
  assert.strictEqual(w.el("allow").disabled, false);
  assert.strictEqual(w.el("allow").tabIndex, -1);
  w.el("allow").focus();
  assert.strictEqual(w.focused().id, "deny", "focus is sent back");
});

test("ZB-14: Enter or Space on Allow (a click with no pointer) does not say yes", async () => {
  const w = await open(upload);
  w.timers.forEach((f) => f());
  w.click("allow", { detail: 0, pointerType: "" });   // keyboard activation
  w.click("allow", { detail: 0 });                    // older engines: no pointerType at all
  assert.deepStrictEqual(w.answers, []);
  assert.strictEqual(w.closed(), false);
});

test("ZB-14: a script's click or a click before Allow wakes up does not say yes; a real pointer click does", async () => {
  const w = await open(upload);
  w.click("allow", { detail: 1, pointerType: "mouse" });  // still disabled (first second)
  w.timers.forEach((f) => f());
  w.click("allow", { isTrusted: false, detail: 1, pointerType: "mouse" });
  assert.deepStrictEqual(w.answers, []);
  w.click("allow", { detail: 1, pointerType: "mouse" });
  assert.deepStrictEqual(w.answers, [[ID, true]]);
  const t = await open(upload);
  t.timers.forEach((f) => f());
  t.click("allow", { detail: 0, pointerType: "touch" });  // touch/pen taps report a pointerType
  assert.deepStrictEqual(t.answers, [[ID, true]]);
});

test("ZB-14: Escape and Don't allow say no", async () => {
  const w = await open(upload);
  w.key("Escape");
  assert.deepStrictEqual(w.answers, [[ID, false]]);
  const d = await open(upload);
  d.click("deny", {});
  assert.deepStrictEqual(d.answers, [[ID, false]]);
});

test("ZB-14: the upload prompt shows each file's folder, not just its name", async () => {
  const w = await open(upload);
  const list = w.el("body").children.find((c) => c.tagName === "ul");
  assert.strictEqual(list.children[0].textContent, "~/Downloads/work/report.pdf (2 KB)");
  const old = await open({ ...upload, files: [{ name: "a.txt", bytes: 3 }] });
  assert.match(old.el("body").children.find((c) => c.tagName === "ul").children[0].textContent, /^\(unknown folder\)\/a\.txt/);
});
