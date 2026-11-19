"use strict";
// Loads the real extension scripts into a vm with a fake `browser` and drives the choke point.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const EXT = path.join(__dirname, "..", "..", "extension");
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (Object.prototype.toString.call(v) === "[object Set]" ? [...v] : v)));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

// Default: restricted mode (goAnywhere false). Pass goAnywhere: true for the shipped config.
function load({ grant = true, page = {}, hasPermission = true, goAnywhere = false, alwaysOn = false, stored = undefined, hang = [],
  sessionStartedAt = Date.now() } = {}) {
  const calls = [];
  const kept = sessionStartedAt ? { sessionStartedAt } : {};  // storage.local besides settings
  const on = {};
  const ev = (name) => ({ addListener: (f) => { on[name] = f; } });
  const tabs = {
    1: { url: "http://localhost:3000/app", title: "Dev app", active: true, windowId: 1 },
    2: { url: "https://bank.example/accounts", title: "Bank (unarmed)", active: false, windowId: 1 },
    3: { url: "https://github.com/x", title: "GitHub", active: false, windowId: 1 },
  };
  const port = { posted: [], postMessage(m) { this.posted.push(m); }, onMessage: ev("message"), onDisconnect: ev("disconnect") };
  const browser = {
    browserAction: { onClicked: ev("click"), setBadgeText: async (o) => calls.push(["badge", o.tabId, o.text]),
      setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async (o) => calls.push(["title", o.tabId]) },
    storage: { local: { get: async () => ({ settings: stored, ...kept }), set: async (o) => { Object.assign(kept, o); },
      remove: async (k) => { delete kept[k]; } }, onChanged: ev("storage") },
    tabs: {
      onUpdated: ev("updated"), onRemoved: ev("removed"),
      get: async (id) => { if (!tabs[id]) throw new Error("no such tab"); return { ...tabs[id], id }; },
      update: async (id, p) => { calls.push(["update", id, p]); if (p.url) tabs[id].url = p.url; },
      create: async (p) => { calls.push(["create", p.url]); tabs[50] = { url: p.url, title: "", windowId: 1 }; return { id: 50 }; },
      remove: async (id) => { calls.push(["remove", id]); delete tabs[id]; },
      reload: async (id) => calls.push(["reload", id]),
      goBack: async (id) => { calls.push(["goBack", id]); if (tabs[id].backTo) tabs[id].url = tabs[id].backTo; },
      goForward: async (id) => { calls.push(["goForward", id]); if (tabs[id].forwardTo) tabs[id].url = tabs[id].forwardTo; },
      group: async (o) => { calls.push(["group", plain(o)]); return 7; },
      ungroup: async (id) => calls.push(["ungroup", id]),
      captureTab: async (id, o) => { if (hang.includes("capture")) return new Promise(() => {}); calls.push(["capture", id, plain(o)]); return o.format === "png" ? "data:image/png;base64,QUJD" : "data:image/jpeg;base64,QUJD"; },
    },
    windows: { get: async (id) => ({ id, state: "maximized" }),
      update: async (id, p) => { calls.push(["windows.update", id, plain(p)]); return { id, width: p.width || 1, height: p.height || 1 }; } },
    webRequest: { onBeforeRequest: ev("beforeRequest"), onCompleted: ev("completed"), onErrorOccurred: ev("netError") },
    tabGroups: { update: async (gid, p) => calls.push(["tabGroups.update", gid, plain(p)]) },
    commands: { onCommand: ev("command") },
    permissions: { onAdded: ev("permAdded"), onRemoved: ev("permRemoved"), request: (p) => { calls.push(["permissions.request", plain(p.origins)]); return Promise.resolve(grant); },
      contains: async () => hasPermission, getAll: async () => ({ origins: ["<all_urls>"] }),
      remove: async (p) => { calls.push(["permissions.remove", plain(p.origins)]); } },
    scripting: { // hang: [funcName] never resolves, like a frozen page
      insertCSS: async ({ target, css }) => { calls.push(["insertCSS", target.tabId, plain(target.frameIds), css]); },
      removeCSS: async ({ target, css }) => { calls.push(["removeCSS", target.tabId, css]); },
      executeScript: async ({ target, func, args }) => {
      if (hang.includes(func.name)) return new Promise(() => {});
      calls.push(["exec", target.tabId, func.name, plain(target.frameIds), plain(args[0])]);
      const r = func.name === "zbShow" && !(func.name in page) ? { ok: true } : page[func.name];
      return [{ result: typeof r === "function" ? r(args[0]) : r }];
    } },
    runtime: { getURL: (p) => `moz-extension://zb/${p}`, connectNative: (name) => { calls.push(["connectNative", name]); return port; } },
  };
  const timers = hang.length ? { setTimeout, clearTimeout } : { setTimeout: () => 0, clearTimeout: () => {} };
  const ctx = vm.createContext({ browser, URL, ...timers, console });
  for (const f of manifest.background.scripts) {
    let src = fs.readFileSync(path.join(EXT, f), "utf8");
    if (f === "background.js" && hang.length) src = src.replace(/15000/g, "60").replace(/ms = 8000/g, "ms = 40").replace(/, 1500\)/g, ", 20)");
    if (f === "config.js") src = src.replace(/goAnywhere: (true|false)/, `goAnywhere: ${goAnywhere}`).replace(/cursorDelayMs: \d+/, "cursorDelayMs: 0")
      .replace(/alwaysOn: (true|false)/, `alwaysOn: ${alwaysOn}`);
    vm.runInContext(src, ctx, { filename: f });
  }
  let n = 0;
  const call = async (tool, args) => plain(await ctx.handleRequest({ v: 1, id: (++n).toString(16).padStart(32, "0"), tool, args }));
  const armed = () => vm.runInContext("armed", ctx);
  const click = async (tabId, shift) => {
    on.click({ ...tabs[tabId], id: tabId }, { modifiers: shift ? ["Shift"] : [], button: 0 });
    await new Promise((r) => setImmediate(r));
  };
  return { ctx, calls, on, tabs, port, call, armed, click, kept };
}

test("connects to the native host by name on startup", () => {
  const { calls } = load();
  assert.ok(calls.some((c) => c[0] === "connectNative" && c[1] === "zenbridge"));
});

test("nothing is visible or touchable before arming", async () => {
  const b = load();
  assert.deepStrictEqual((await b.call("tabs_list", {})).result.tabs, []);
  for (const [tool, args] of [["screenshot", { tabId: 2 }], ["click", { tabId: 2, selector: "a" }], ["tab_close", { tabId: 2 }],
                              ["navigate", { tabId: 2, url: "https://bank.example/x" }], ["tab_switch", { tabId: 999 }]]) {
    const r = await b.call(tool, args);
    assert.strictEqual(r.error.code, "NOT_ARMED", tool);
    assert.strictEqual(r.tabUrl, undefined, "never leak an unarmed tab's URL");
  }
  assert.ok(!b.calls.some((c) => ["exec", "capture", "remove", "update"].includes(c[0])));
  assert.deepStrictEqual((await b.call("reload", { urlPattern: "*" })).result.reloaded, []);
});

test("toolbar click: permissions.request is the first, synchronous call; then armed with allowlist", async () => {
  const b = load();
  const before = b.calls.length;
  b.on.click({ ...b.tabs[1], id: 1 });  // no await: request must already have happened
  assert.deepStrictEqual(b.calls[before], ["permissions.request",
    ["http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*", "<all_urls>"]]);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(b.armed().get(1)), ["http://localhost:3000", "http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]);
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[1] === 1 && c[2] === "ON"));
  const list = (await b.call("tabs_list", {})).result.tabs;
  assert.deepStrictEqual(list.map((t) => t.tabId), [1]);
});

test("denied permission leaves the tab unarmed; non-http pages are refused", async () => {
  const b = load({ grant: false });
  await b.click(1);
  assert.strictEqual(b.armed().size, 0);
  const c = load({ grant: false });
  c.tabs[4] = { url: "about:debugging", windowId: 1 };
  c.tabs[5] = { url: "https://addons.mozilla.org/x", windowId: 1 };
  await c.click(4);  // non-armable page: asks to start a session instead (denied here)
  await c.click(5);
  assert.strictEqual(c.armed().size, 0);
  assert.strictEqual((await c.call("tabs_list", {})).result.session, false);
});

test("second click disarms; Alt+Shift+K disarms all; closing a tab disarms it", async () => {
  const b = load();
  await b.click(1);
  await b.click(1);
  assert.strictEqual(b.armed().size, 0);
  await b.click(1);
  await b.click(3);
  assert.strictEqual(b.armed().size, 2);
  b.on.command("disarm-all");
  assert.strictEqual(b.armed().size, 0);
  await b.click(3);
  b.on.removed(3);
  assert.strictEqual(b.armed().size, 0);
});

test("out-of-scope armed tab: everything but tabs_list is OUT_OF_SCOPE; only Shift+click widens", async () => {
  const b = load({ page: { zbScroll: { ok: true, scrollX: 0, scrollY: 50 } } });
  await b.click(1);
  b.tabs[1].url = "https://github.com/login";
  b.on.updated(1, {}, { ...b.tabs[1], id: 1 });
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[2] === "!!"));
  const list = (await b.call("tabs_list", {})).result.tabs;
  assert.deepStrictEqual(list[0], { tabId: 1, title: "", url: "", active: true, inScope: false });  // no leak
  for (const [tool, args] of [["scroll", { tabId: 1, dy: 5 }], ["screenshot", { tabId: 1 }], ["tab_close", { tabId: 1 }]])
    assert.strictEqual((await b.call(tool, args)).error.code, "OUT_OF_SCOPE", tool);
  assert.deepStrictEqual((await b.call("reload", { urlPattern: "*" })).result.reloaded, []);
  await b.click(1, true);  // Shift+click: widen
  assert.ok(b.armed().get(1).has("https://github.com"));
  const sc = (await b.call("scroll", { tabId: 1, dy: 5 })).result;
  assert.deepStrictEqual([sc.scrollY, sc.target], [50, "page"]);  // a junk target from the page is never passed through
});

test("plain click on an out-of-scope (!!) tab disarms; never silently widens", async () => {
  const b = load();
  await b.click(1);
  b.tabs[1].url = "https://accounts.google.com/";
  await b.click(1);
  assert.strictEqual(b.armed().size, 0);
});

test("host permissions are released at startup and when nothing is armed", async () => {
  const b = load();
  await new Promise((r) => setImmediate(r));
  assert.ok(b.calls.some((c) => c[0] === "permissions.remove"));  // startup
  const n = b.calls.length;
  await b.click(1);
  await b.click(3);
  await b.click(1);
  await new Promise((r) => setImmediate(r));
  assert.ok(!b.calls.slice(n).some((c) => c[0] === "permissions.remove"), "tab 3 still armed");
  b.on.removed(3);
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(b.calls.slice(n).filter((c) => c[0] === "permissions.remove"), [["permissions.remove", ["<all_urls>"]]]);
});

test("screenshot refused when cross-origin frames are visible", async () => {
  const b = load({ page: { zbPageMetrics: { ok: true, foreignFrames: 1, scrollX: 0, scrollY: 0, vw: 1, vh: 1, dw: 1, dh: 1 } } });
  await b.click(1);
  assert.strictEqual((await b.call("screenshot", { tabId: 1 })).error.code, "REFUSED");
  assert.ok(!b.calls.some((c) => c[0] === "capture"));
});

test("lost host permission (URL unreadable) => OUT_OF_SCOPE", async () => {
  const b = load();
  await b.click(1);
  delete b.tabs[1].url;
  assert.strictEqual((await b.call("click", { tabId: 1, selector: "a" })).error.code, "OUT_OF_SCOPE");
});

test("navigate stays in scope; tab_open is restricted to approved sites", async () => {
  const b = load();
  await b.click(1);
  assert.strictEqual((await b.call("navigate", { tabId: 1, url: "https://evil.example/?q=secret" })).error.code, "OUT_OF_SCOPE");
  assert.ok((await b.call("navigate", { tabId: 1, url: "http://127.0.0.1:8000/" })).ok);
  assert.strictEqual((await b.call("tab_open", { url: "https://evil.example/" })).error.code, "OUT_OF_SCOPE");
  assert.ok(!b.calls.some((c) => c[0] === "create"));
});

test("tab_open auto-arms tabs on approved sites (localhost, or a site the user armed)", async () => {
  const b = load({ page: { zbScroll: { ok: true, scrollX: 0, scrollY: 1 } } });
  await b.click(3);  // user arms github.com
  const r = await b.call("tab_open", { url: "https://github.com/settings" });
  assert.deepStrictEqual([r.result.armed, r.result.tabId], [true, 50]);
  assert.deepStrictEqual(plain(b.armed().get(50)), ["https://github.com"]);  // ZB-2: no localhost in a public tab's scope
  assert.ok((await b.call("scroll", { tabId: 50, dy: 1 })).ok);  // usable immediately
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[1] === 50 && c[2] === "ON"));
  assert.strictEqual((await b.call("navigate", { tabId: 50, url: "http://localhost:8888/" })).error.code, "OUT_OF_SCOPE");
  assert.strictEqual((await b.call("tab_open", { url: "http://localhost:5173/" })).error.code, "OUT_OF_SCOPE");
  await b.click(1);  // the user arms a localhost tab: local addresses are now in scope for it and openable
  assert.deepStrictEqual(plain(b.armed().get(1)), ["http://localhost:3000", "http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]);
  const local = await b.call("tab_open", { url: "http://localhost:5173/" });
  assert.strictEqual(local.result.armed, true);
});

test("public tab: Shift+click still widens it to a local address by hand (ZB-2)", async () => {
  const b = load();
  await b.click(3);
  b.tabs[3].url = "http://localhost:3000/app";
  assert.strictEqual((await b.call("read_page", { tabId: 3 })).error.code, "OUT_OF_SCOPE");
  await b.click(3, true);
  assert.deepStrictEqual(plain(b.armed().get(3)), ["https://github.com", "http://localhost:3000"]);
});

test("tab_open without any granted permission opens an UNARMED tab", async () => {
  const b = load({ hasPermission: false });
  await b.click(1);  // arming makes localhost openable; the grant is then missing (e.g. revoked in about:addons)
  const r = await b.call("tab_open", { url: "http://localhost:5173/" });
  assert.deepStrictEqual([r.result.armed, r.result.tabId], [false, 50]);
  assert.strictEqual((await b.call("click", { tabId: 50, selector: "a" })).error.code, "NOT_ARMED");
});

test("page actions inject only into frame 0 with fixed functions, origin-pinned", async () => {
  const b = load({ page: { zbClick: { ok: true, tag: "button", text: "x".repeat(500) } } });  // sanitized to schema size
  await b.click(1);
  const r = await b.call("click", { tabId: 1, selector: "#go" });
  assert.strictEqual(r.result.text.length, 200);
  assert.strictEqual(r.tabUrl, "http://localhost:3000/app");
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === "exec").map((c) => c.slice(0, 4)), [["exec", 1, "zbShow", [0]], ["exec", 1, "zbClick", [0]]]);
});

test("hostile page results are rejected or sanitized", async () => {
  const b = load({ page: { zbClick: { ok: false, code: "PWNED", message: "<script>" }, zbScroll: "not an object" } });
  await b.click(1);
  assert.strictEqual((await b.call("click", { tabId: 1, selector: "a" })).error.code, "INTERNAL");
  assert.strictEqual((await b.call("scroll", { tabId: 1, dy: 1 })).error.code, "INTERNAL");
});

test("type: background pre-check refuses sensitive fields before typing", async () => {
  const b = load({ page: { zbFieldInfo: { ok: true, found: true, tag: "INPUT", type: "password", autocomplete: "" },
                            zbType: { ok: true, tag: "input", typed: 3, method: "insertText" } } });
  await b.click(1);
  assert.strictEqual((await b.call("type", { tabId: 1, text: "pw!", selector: "#p" })).error.code, "REFUSED");
  assert.ok(!b.calls.some((c) => c[2] === "zbType"));
});

test("screenshot: scale 1, viewport PNG, fullPage JPEG capped at 1280x8000", async () => {
  const metrics = { ok: true, foreignFrames: 0, scrollX: 0, scrollY: 100, vw: 1000, vh: 700, dw: 1500, dh: 20000 };
  const b = load({ page: { zbPageMetrics: metrics } });
  await b.click(1);
  const v = (await b.call("screenshot", { tabId: 1 })).result;
  assert.deepStrictEqual([v.mimeType, v.width, v.height, v.truncated], ["image/png", 1000, 700, false]);
  const f = (await b.call("screenshot", { tabId: 1, fullPage: true })).result;
  assert.deepStrictEqual([f.mimeType, f.width, f.height, f.truncated], ["image/jpeg", 1280, 8000, true]);
  const caps = b.calls.filter((c) => c[0] === "capture").map((c) => c[2]);
  assert.deepStrictEqual(caps[0], { format: "png", scale: 1 });
  assert.deepStrictEqual(caps[1], { format: "jpeg", quality: 80, scale: 1, rect: { x: 0, y: 0, width: 1280, height: 8000 } });
});

test("invalid requests never reach browser APIs", async () => {
  const b = load();
  await b.click(1);
  const n = b.calls.length;
  for (const m of [null, { v: 1, id: "x", tool: "click", args: {} }, { v: 1, id: "a".repeat(32), tool: "eval", args: {} },
                   { v: 1, id: "a".repeat(32), tool: "click", args: { tabId: 1, selector: "a", x: 1, y: 1 } }]) {
    assert.strictEqual((await b.ctx.handleRequest(m)).error.code, "INVALID");
  }
  assert.strictEqual(b.calls.length, n);
});

test("host messages are answered on the port", async () => {
  const b = load();
  await b.on.message({ v: 1, id: "f".repeat(32), tool: "tabs_list", args: {} });
  assert.deepStrictEqual(plain(b.port.posted[0]), { v: 1, id: "f".repeat(32), ok: true, result: { tabs: [], session: false } });
});

test("go-anywhere: clicked tab gets scope *, can navigate and open tabs on any site", async () => {
  const b = load({ goAnywhere: true, page: { zbScroll: { ok: true, scrollX: 0, scrollY: 1 } } });
  await b.click(1);
  assert.deepStrictEqual(plain(b.armed().get(1)), ["*"]);
  assert.ok((await b.call("navigate", { tabId: 1, url: "https://news.example/today" })).ok);
  b.on.updated(1, {}, { ...b.tabs[1], id: 1 });
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[1] === 1 && c[2] === "ON"));
  const r = await b.call("tab_open", { url: "https://www.wikipedia.org/" });
  assert.deepStrictEqual([r.result.armed, r.result.tabId], [true, 50]);
  assert.ok((await b.call("scroll", { tabId: 50, dy: 1 })).ok);
  assert.strictEqual((await b.call("tab_open", { url: "https://addons.mozilla.org/x" })).error.code, "OUT_OF_SCOPE");
});

test("go-anywhere: user's other tabs stay invisible and untouchable", async () => {
  const b = load({ goAnywhere: true });
  await b.click(1);
  assert.deepStrictEqual((await b.call("tabs_list", {})).result.tabs.map((t) => t.tabId), [1]);
  assert.strictEqual((await b.call("read_page", { tabId: 2 })).error.code, "NOT_ARMED");
  assert.strictEqual((await b.call("screenshot", { tabId: 2 })).error.code, "NOT_ARMED");
});

test("go-anywhere: with nothing armed (no permission), opened tabs stay unarmed", async () => {
  const b = load({ goAnywhere: true, hasPermission: false });
  const r = await b.call("tab_open", { url: "https://www.wikipedia.org/" });
  assert.strictEqual(r.result.armed, false);
});

test("go-anywhere: screenshots allowed despite third-party frames", async () => {
  const b = load({ goAnywhere: true, page: { zbPageMetrics: { ok: true, foreignFrames: 3, scrollX: 0, scrollY: 0, vw: 10, vh: 10, dw: 10, dh: 10 } } });
  await b.click(1);
  assert.ok((await b.call("screenshot", { tabId: 1 })).ok);
});

test("read_page: returns sanitized text and http(s) links only", async () => {
  const b = load({ page: { zbReadText: { ok: true, title: "T".repeat(300), text: "hello", truncated: false,
    links: [{ text: "ok", href: "https://a.example/" }, { text: "js", href: "javascript:alert(1)" }, { text: 5, href: "x" }, null] } } });
  await b.click(1);
  const r = await b.call("read_page", { tabId: 1 });
  assert.strictEqual(r.result.title.length, 200);
  assert.strictEqual(r.result.url, "http://localhost:3000/app");
  assert.deepStrictEqual(r.result.links, [{ text: "ok", href: "https://a.example/" }]);
  assert.strictEqual((await b.call("read_page", { tabId: 1, maxChars: 10 })).error.code, "INVALID");
});

test("session from a new-tab page: no tab armed, Claude can open its own armed tabs; Alt+Shift+K ends it", async () => {
  const b = load({ goAnywhere: true });
  b.tabs[9] = { url: "about:newtab", windowId: 1 };
  await b.click(9);
  assert.ok(b.calls.some((c) => c[0] === "update" && c[1] === 9 && c[2].url === "moz-extension://zb/pages/start.html"));
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false, "not on until the start page grants");
  b.on.permAdded({ origins: ["<all_urls>"], permissions: [] });
  assert.strictEqual(b.armed().size, 0);
  assert.deepStrictEqual((await b.call("tabs_list", {})).result, { tabs: [], session: true });
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[1] === undefined && c[2] === "AI"));
  const r = await b.call("tab_open", { url: "https://www.wikipedia.org/" });
  assert.strictEqual(r.result.armed, true);
  const n = b.calls.length;
  b.on.command("disarm-all");
  await new Promise((r2) => setImmediate(r2));
  assert.deepStrictEqual((await b.call("tabs_list", {})).result, { tabs: [], session: false });
  assert.ok(b.calls.slice(n).some((c) => c[0] === "permissions.remove"));
});

test("Alt+Shift+C opens the start page; clicking on a new tab again ends the session", async () => {
  const b = load({ goAnywhere: true });
  b.on.command("start-session");
  await new Promise((r) => setImmediate(r));
  assert.ok(b.calls.some((c) => c[0] === "create" && c[1] === "moz-extension://zb/pages/start.html"));
  b.on.permAdded({ origins: ["<all_urls>"] });
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
  b.tabs[9] = { url: "about:home", windowId: 1 };
  await b.click(9);
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false);
});

test("always-on: a granted session resumes at startup and a new-tab click never turns it off", async () => {
  const b = load({ goAnywhere: true, alwaysOn: true });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
  assert.ok(!b.calls.some((c) => c[0] === "permissions.remove"), "grant kept");
  assert.ok(!b.calls.some((c) => c[0] === "permissions.request"), "no prompt without a click");
  b.tabs[9] = { url: "about:home", windowId: 1 };
  await b.click(9);
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
  assert.strictEqual((await b.call("tab_open", { url: "https://www.wikipedia.org/" })).result.armed, true);
  const n = b.calls.length;
  b.on.command("disarm-all");
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false);
  assert.ok(b.calls.slice(n).some((c) => c[0] === "permissions.remove"), "kill switch revokes the grant");
});

test("sessions expire: never resumed past the limit or without a start time, and end mid-use (ZB-3)", async () => {
  for (const sessionStartedAt of [Date.now() - 9 * 3600000, 0, Date.now() + 3600000]) {
    const b = load({ goAnywhere: true, alwaysOn: true, sessionStartedAt });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await b.call("tabs_list", {})).result.session, false, String(sessionStartedAt));
    assert.ok(b.calls.some((c) => c[0] === "permissions.remove"), "grant released");
  }
  const b = load({ goAnywhere: true, alwaysOn: true, sessionStartedAt: Date.now() - 8 * 3600000 + 80 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
  await b.click(1);
  await new Promise((r) => setTimeout(r, 120));
  const r = await b.call("tabs_list", {});
  assert.deepStrictEqual([r.result.session, r.result.tabs.length], [false, 0]);
  assert.strictEqual(b.kept.sessionStartedAt, undefined);
});

test("turning Claude on records when, so a restart doesn't extend the session", async () => {
  const b = load({ alwaysOn: true, hasPermission: false, sessionStartedAt: 0 });
  await new Promise((r) => setImmediate(r));
  b.on.permAdded({ origins: ["<all_urls>"] });
  assert.ok(Math.abs(b.kept.sessionStartedAt - Date.now()) < 1000);
});

test("always-on is off by default", () => {
  assert.strictEqual(require(path.join(EXT, "config.js")).ZB_DEFAULTS.alwaysOn, false);
});

test("always-on: without a prior grant, Claude stays off until you click", async () => {
  const b = load({ goAnywhere: true, alwaysOn: true, hasPermission: false });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false);
  b.tabs[9] = { url: "about:newtab", windowId: 1 };
  await b.click(9);
  assert.ok(b.calls.some((c) => c[0] === "update" && c[2].url.endsWith("pages/start.html")));
  b.on.permAdded({ origins: ["<all_urls>"] });
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
  b.on.permRemoved({ origins: ["<all_urls>"] });  // e.g. switched off in the add-ons manager
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false);
});

test("navigate refuses the add-on store even in go-anywhere mode", async () => {
  const b = load({ goAnywhere: true });
  await b.click(1);
  assert.strictEqual((await b.call("navigate", { tabId: 1, url: "https://addons.mozilla.org/en-US/firefox/" })).error.code, "OUT_OF_SCOPE");
  assert.ok(!b.calls.some((c) => c[0] === "update" && c[2].url && c[2].url.includes("addons.mozilla.org")));
});

test("without always-on, arming a tab does not start a session; the start page does", async () => {
  const b = load({ goAnywhere: true, alwaysOn: false });
  await b.click(1);
  b.on.permAdded({ origins: ["<all_urls>"] });
  assert.strictEqual((await b.call("tabs_list", {})).result.session, false);
  b.tabs[9] = { url: "about:newtab", windowId: 1 };
  await b.click(9);
  b.on.permAdded({ origins: ["<all_urls>"] });
  assert.strictEqual((await b.call("tabs_list", {})).result.session, true);
});

test("inject_css: adds CSS to the top frame, refuses anything that loads resources, clears", async () => {
  const b = load({ goAnywhere: true });
  assert.strictEqual((await b.call("inject_css", { tabId: 1, css: "body{color:red}" })).error.code, "NOT_ARMED");
  await b.click(1);
  const r = await b.call("inject_css", { tabId: 1, css: "body{color:red}" });
  assert.deepStrictEqual(r.result, { tabId: 1, active: 1 });
  assert.ok(b.calls.some((c) => c[0] === "insertCSS" && c[1] === 1 && c[2][0] === 0 && c[3] === "body{color:red}"));
  for (const css of ["a{background:url(https://evil.example/x)}", "@import 'x.css';", "p{background:u\\72l(x)}",
                     "div{background-image:image-set('a.png' 1x)}", "div{background:-moz-element(#x)}"]) {
    const bad = await b.call("inject_css", { tabId: 1, css });
    assert.strictEqual(bad.error.code, "REFUSED", css);
  }
  assert.strictEqual(b.calls.filter((c) => c[0] === "insertCSS").length, 1);
  assert.strictEqual((await b.call("inject_css", { tabId: 1, css: "p{margin:0}" })).result.active, 2);
  const cleared = await b.call("inject_css", { tabId: 1, clear: true });
  assert.deepStrictEqual(cleared.result, { tabId: 1, active: 0 });
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === "removeCSS").map((c) => c[2]), ["body{color:red}", "p{margin:0}"]);
  for (const args of [{ tabId: 1 }, { tabId: 1, css: "a{}", clear: true }, { tabId: 1, clear: false }, { tabId: 1, css: "" }]) {
    assert.strictEqual((await b.call("inject_css", args)).error.code, "INVALID", JSON.stringify(args));
  }
});

test("inject_css: navigation forgets added CSS; at most 20 sheets; disarm removes them", async () => {
  const b = load({ goAnywhere: true });
  await b.click(1);
  await b.call("inject_css", { tabId: 1, css: "a{}" });
  b.on.updated(1, { status: "loading" }, { ...b.tabs[1], id: 1 });
  assert.strictEqual((await b.call("inject_css", { tabId: 1, css: "b{}" })).result.active, 1);
  for (let i = 0; i < 19; i++) await b.call("inject_css", { tabId: 1, css: `i${i}{}` });
  assert.strictEqual((await b.call("inject_css", { tabId: 1, css: "x{}" })).error.code, "REFUSED");
  const n = b.calls.length;
  await b.click(1);  // disarm
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(b.calls.slice(n).filter((c) => c[0] === "removeCSS").length, 20);
});

test("settings from storage apply (sanitized) and change live", async () => {
  const b = load({ stored: { goAnywhere: true, showActivity: false, hostName: "evil" } });
  await b.call("tabs_list", {});
  assert.strictEqual(vm.runInContext("ZB_CONFIG.goAnywhere", b.ctx), true);
  assert.strictEqual(vm.runInContext("ZB_CONFIG.hostName", b.ctx), "zenbridge");
  await b.click(1);
  await b.call("scroll", { tabId: 1, dy: 1 });
  assert.ok(!b.calls.some((c) => c[0] === "exec" && c[2] === "zbShow"), "showActivity off: no overlay");
  b.on.storage({ settings: { newValue: { goAnywhere: false } } }, "local");
  assert.strictEqual(vm.runInContext("ZB_CONFIG.goAnywhere", b.ctx), false);
  b.on.storage({ settings: { newValue: { goAnywhere: true } } }, "sync");  // other areas ignored
  assert.strictEqual(vm.runInContext("ZB_CONFIG.goAnywhere", b.ctx), false);
});

test("companion app missing: '!' badge and status; recovers when it connects", async () => {
  const b = load();
  assert.strictEqual(vm.runInContext("zbStatus().host", b.ctx), "connecting");
  b.on.disconnect({ error: { message: "No such native application zenbridge" } });
  assert.strictEqual(vm.runInContext("zbStatus().host", b.ctx), "missing");
  assert.ok(b.calls.some((c) => c[0] === "badge" && c[1] === undefined && c[2] === "!"));
  b.on.disconnect({ error: { message: "host exited" } });
  assert.strictEqual(vm.runInContext("zbStatus().host", b.ctx), "disconnected");
});

test("a frozen page or a tab that won't render fails fast with TIMEOUT instead of hanging", async () => {
  const b = load({ hang: ["zbClick", "zbShow"] });
  await b.click(1);
  const t0 = Date.now();
  const r = await b.call("click", { tabId: 1, selector: "a" });
  assert.strictEqual(r.error.code, "TIMEOUT");
  assert.match(r.error.message, /may still happen/);
  assert.ok(Date.now() - t0 < 2000);
  const c = load({ hang: ["capture"], page: { zbPageMetrics: { ok: true, foreignFrames: 0, scrollX: 0, scrollY: 0, vw: 10, vh: 10, dw: 10, dh: 10 } } });
  await c.click(1);
  const s = await c.call("screenshot", { tabId: 1 });
  assert.strictEqual(s.error.code, "TIMEOUT");
  assert.match(s.error.message, /tab_switch/);
  assert.ok(c.calls.filter((x) => x[2] === "zbShow").length === 2, "overlay restored after a failed capture");
});

test("controlled tabs go into a purple 'Claude' tab group and leave it on disarm", async () => {
  const b = load();
  await b.click(1);
  await new Promise((r) => setImmediate(r));
  assert.ok(b.calls.some((c) => c[0] === "group"));
  assert.ok(b.calls.some((c) => c[0] === "tabGroups.update" && c[2].title === "Claude" && c[2].color === "purple"));
  b.tabs[1].groupId = 7;
  await b.click(1);
  await new Promise((r) => setImmediate(r));
  assert.ok(b.calls.some((c) => c[0] === "ungroup" && c[1] === 1));
});

test("activity cue: cursor before clicks, overlay hidden during screenshot capture", async () => {
  const b = load({ page: { zbPageMetrics: { ok: true, foreignFrames: 0, scrollX: 0, scrollY: 0, vw: 10, vh: 10, dw: 10, dh: 10 } } });
  await b.click(1);
  const n = b.calls.length;
  await b.call("screenshot", { tabId: 1 });
  const seq = b.calls.slice(n).filter((c) => c[0] === "exec" || c[0] === "capture").map((c) => (c[0] === "capture" ? "capture" : c[2]));
  assert.deepStrictEqual(seq, ["zbPageMetrics", "zbShow", "capture", "zbShow"]);
});

test("a failing cue never breaks the action", async () => {
  const b = load({ page: { zbShow: { ok: false, code: "INTERNAL" }, zbScroll: { ok: true, scrollX: 0, scrollY: 9 } } });
  await b.click(1);
  assert.strictEqual((await b.call("scroll", { tabId: 1, dy: 9 })).result.scrollY, 9);
});

// ------------------------------------------------------------ Chrome-parity tools
const pageOps = (byOp) => ({ zbPage: (a) => (byOp[a.op] !== undefined ? (typeof byOp[a.op] === "function" ? byOp[a.op](a) : byOp[a.op]) : { ok: true }) });
const execs = (b, name = "zbPage") => b.calls.filter((c) => c[0] === "exec" && c[2] === name).map((c) => c[4]);

test("read_tree and find: page results are size-checked; bad refs dropped; glow cue only", async () => {
  const b = load({ page: pageOps({
    tree: { ok: true, title: "T".repeat(500), tree: "- button \"Go\" [ref_1]", truncated: false, nodes: 3 },
    find: { ok: true, more: true, matches: [{ ref: "ref_1", role: "button", name: "x".repeat(900), x: 1e12, y: 5, inView: 1 },
      { ref: "javascript:1", role: "link", name: "bad", x: 0, y: 0, inView: true }] } }) });
  await b.click(1);
  const t = await b.call("read_tree", { tabId: 1, filter: "interactive" });
  assert.strictEqual(t.result.title.length, 200);
  assert.deepStrictEqual(execs(b).at(-1), { op: "tree", filter: "interactive", depth: 30, maxChars: 50000 });
  const f = await b.call("find", { tabId: 1, query: "go button" });
  assert.deepStrictEqual(f.result.matches.map((m) => m.ref), ["ref_1"]);
  assert.strictEqual(f.result.matches[0].name.length, 200);
  assert.strictEqual(f.result.matches[0].x, 1000000);
  assert.deepStrictEqual(execs(b, "zbShow").at(-1), { kind: "glow" });
});

test("hover, key, form_input, drag: fixed page ops with a cursor on the target", async () => {
  const b = load({ page: pageOps({ hover: { ok: true, tag: "a", text: "Menu" }, key: { ok: true, tag: "input", pressed: 2 },
    form: { ok: true, tag: "select", kind: "evil", applied: true }, drag: { ok: true, tag: "div", text: "", html5: true } }) });
  await b.click(1);
  assert.deepStrictEqual((await b.call("hover", { tabId: 1, ref: "ref_4" })).result, { tag: "a", text: "Menu" });
  assert.deepStrictEqual(execs(b, "zbShow").at(-1), { kind: "hover", ref: "ref_4" });
  assert.strictEqual((await b.call("key", { tabId: 1, keys: "cmd+a Backspace" })).result.pressed, 2);
  assert.deepStrictEqual(execs(b).at(-1), { op: "key", keys: "cmd+a Backspace" });
  assert.strictEqual((await b.call("form_input", { tabId: 1, ref: "ref_2", value: "CA" })).result.kind, "text");  // unknown kind sanitized
  const d = await b.call("drag", { tabId: 1, from: { ref: "ref_1" }, to: { x: 5, y: 6 } });
  assert.strictEqual(d.result.html5, true);
  const shows = execs(b, "zbShow");
  assert.deepStrictEqual(shows.slice(-2), [{ kind: "hover", ref: "ref_1" }, { kind: "hover", x: 5, y: 6 }]);
});

test("new tools refuse unarmed tabs and out-of-scope pages like the rest", async () => {
  const b = load({ page: pageOps({}) });
  for (const [tool, args] of [["read_tree", {}], ["find", { query: "x" }], ["key", { keys: "a" }], ["network_requests", {}],
    ["console_messages", {}], ["resize_window", { width: 800, height: 600 }], ["wait_for", { seconds: 0 }]]) {
    assert.strictEqual((await b.call(tool, { tabId: 2, ...args })).error.code, "NOT_ARMED", tool);
  }
  assert.ok(!b.calls.some((c) => c[0] === "exec" || c[0] === "windows.update"));
});

test("navigate history, screenshot region, resize_window", async () => {
  const metrics = { ok: true, foreignFrames: 0, scrollX: 0, scrollY: 100, vw: 1000, vh: 700, dw: 1000, dh: 5000 };
  const b = load({ page: { zbPageMetrics: metrics } });
  await b.click(1);
  b.tabs[1].backTo = "http://localhost:3000/prev";
  assert.strictEqual((await b.call("navigate", { tabId: 1, history: "back" })).result.url, "http://localhost:3000/prev");
  assert.ok(b.calls.some((c) => c[0] === "goBack" && c[1] === 1));
  b.tabs[1].forwardTo = "https://bank.example/accounts?acct=123";  // history may leave scope: never report that URL
  assert.strictEqual((await b.call("navigate", { tabId: 1, history: "forward" })).result.url, "(a page outside this tab's scope)");
  b.tabs[1].url = "http://localhost:3000/app";
  const r = await b.call("screenshot", { tabId: 1, region: { x: 900, y: 10, width: 300, height: 50 } });
  assert.deepStrictEqual(b.calls.find((c) => c[0] === "capture")[2], { format: "png", scale: 2, rect: { x: 900, y: 110, width: 100, height: 50 } });
  assert.deepStrictEqual([r.result.width, r.result.height, r.result.scale], [200, 100, 2]);
  assert.strictEqual((await b.call("screenshot", { tabId: 1, region: { x: 1000, y: 0, width: 5, height: 5 } })).error.code, "INVALID");
  const w = await b.call("resize_window", { tabId: 1, width: 800, height: 600 });
  assert.deepStrictEqual(w.result, { width: 800, height: 600 });
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === "windows.update").map((c) => c[2]), [{ state: "normal" }, { width: 800, height: 600 }]);
});

test("network_requests: armed tabs only, credentials redacted, nothing from out-of-scope pages, fresh log per site", async () => {
  const b = load();
  await b.click(1);
  const req = (tabId, url, extra = {}) => b.on.completed({ tabId, url, method: "GET", type: "xmlhttprequest", statusCode: 200,
    timeStamp: 5, documentUrl: "http://localhost:3000/app", ...extra });
  b.on.beforeRequest({ tabId: 1, url: "http://localhost:3000/app", type: "main_frame" });
  req(1, "http://localhost:3000/api?token=abc&q=1");
  req(2, "https://bank.example/api/balance", { documentUrl: "https://bank.example/" });  // unarmed tab
  req(1, "https://evil.example/x", { documentUrl: "https://evil.example/" });            // from an out-of-scope page
  b.on.netError({ tabId: 1, url: "http://localhost:3000/down", method: "POST", type: "fetch", timeStamp: 6,
    documentUrl: "http://localhost:3000/app", error: "NS_ERROR_CONNECTION_REFUSED" });
  let r = await b.call("network_requests", { tabId: 1 });
  assert.deepStrictEqual(r.result.requests.map((x) => x.url), ["http://localhost:3000/api?token=REDACTED&q=1", "http://localhost:3000/down"]);
  assert.strictEqual(r.result.requests[1].error, "NS_ERROR_CONNECTION_REFUSED");
  assert.ok(!JSON.stringify(r).includes("bank.example"));
  r = await b.call("network_requests", { tabId: 1, urlPattern: "/down" });
  assert.strictEqual(r.result.requests.length, 1);
  b.on.beforeRequest({ tabId: 1, url: "http://127.0.0.1:8080/", type: "main_frame" });  // new site: log starts over
  assert.deepStrictEqual((await b.call("network_requests", { tabId: 1 })).result.requests, []);
  req(1, "http://127.0.0.1:8080/a", { documentUrl: "http://127.0.0.1:8080/" });
  await b.call("network_requests", { tabId: 1, clear: true });
  assert.deepStrictEqual((await b.call("network_requests", { tabId: 1 })).result.requests, []);
});

test("console_messages: capture starts on first call and is re-hooked after each page load", async () => {
  const b = load({ page: pageOps({ consoleRead: (a) => ({ ok: true, capturing: true,
    messages: [{ level: "error", text: "boom", time: 1 }, { level: "pwned", text: "x", time: 1 }] }), consoleHook: { ok: true, capturing: true } }) });
  await b.click(1);
  b.on.updated(1, { status: "complete" }, b.tabs[1]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(execs(b).filter((a) => a.op === "consoleHook").length, 0);  // not before Claude asks
  const r = await b.call("console_messages", { tabId: 1, onlyErrors: true });
  assert.deepStrictEqual(r.result.messages, [{ level: "error", text: "boom", time: 1 }]);
  assert.deepStrictEqual(execs(b).at(-1), { op: "consoleRead", filter: "", onlyErrors: true, clear: false, limit: 100 });
  b.on.updated(1, { status: "complete" }, b.tabs[1]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(execs(b).filter((a) => a.op === "consoleHook").length, 1);
});

test("file_upload: pieces are reassembled for the page; incomplete, oversized or Claude-off uploads are refused", async () => {
  const b = load({ page: pageOps({ upload: (a) => ({ ok: true, files: a.files.length, bytes: 3, target: "input" }) }) });
  const id = "a".repeat(32), chunk = (index, data, extra = {}) => b.call("upload_chunk",
    { uploadId: id, index, total: 2, name: "a.txt", mimeType: "text/plain", data, ...extra });
  assert.strictEqual((await chunk(0, "QUJD")).error.code, "NOT_ARMED");  // nothing armed, no session
  await b.click(1);
  assert.strictEqual((await chunk(0, "QUJD")).result.received, 1);
  assert.strictEqual((await b.call("file_upload", { tabId: 1, ref: "ref_1", uploads: [id] })).error.code, "INVALID");  // incomplete
  assert.strictEqual((await chunk(1, "REVG")).result.received, 2);
  const r = await b.call("file_upload", { tabId: 1, ref: "ref_1", uploads: [id] });
  assert.deepStrictEqual(r.result, { files: 1, bytes: 3, target: "input" });
  assert.deepStrictEqual(execs(b).at(-1), { op: "upload", ref: "ref_1", files: [{ name: "a.txt", mimeType: "text/plain", data: "QUJDREVG" }] });
  assert.strictEqual((await b.call("file_upload", { tabId: 1, ref: "ref_1", uploads: [id] })).error.code, "INVALID");  // used up
  assert.strictEqual((await chunk(0, "QUJD", { name: "b.txt" })).result.received, 1);
  assert.strictEqual((await chunk(1, "QUJD", { name: "c.txt" })).error.code, "INVALID");  // inconsistent pieces
  const big = "A".repeat(600000);
  const codes = [];
  for (let i = 0; i < 30; i++) {
    const r = await b.call("upload_chunk", { uploadId: "b".repeat(32), index: i, total: 40, name: "x", mimeType: "a/b", data: big });
    codes.push(r.ok ? "ok" : r.error.code);
  }
  assert.strictEqual(codes.indexOf("REFUSED"), 25);  // 25 pieces of 600k fill the 15M-character hold exactly
});

test("wait_for: polls in the page with a timeout above its own", async () => {
  const b = load({ page: pageOps({ wait: { ok: true, met: true, waited: 1.2 } }) });
  await b.click(1);
  assert.deepStrictEqual((await b.call("wait_for", { tabId: 1, text: "Saved" })).result, { met: true, waited: 1.2 });
  assert.deepStrictEqual(execs(b).at(-1), { op: "wait", text: "Saved", gone: false, seconds: 3 });
  assert.deepStrictEqual((await b.call("wait_for", { tabId: 1, seconds: 0 })).result, { met: true, waited: 0 });
});
