"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const EXT = path.join(__dirname, "..", "..", "extension");
const L = require(path.join(EXT, "logic.js"));
const { zbValidateRequest } = require(path.join(EXT, "validate.js"));
const { ZB_SCHEMA } = require(path.join(EXT, "schema.js"));
const { ZB_CONFIG } = require(path.join(EXT, "config.js"));
const cases = require("./cases.json");

const req = (tool, args) => ({ v: 1, id: "0".repeat(31) + "1", tool, args });

test("validator: shared valid cases pass", () => {
  for (const [tool, list] of Object.entries(cases.valid)) for (const a of list) assert.strictEqual(zbValidateRequest(ZB_SCHEMA, req(tool, a)), null, `${tool} ${JSON.stringify(a)}`);
});

test("validator: shared invalid cases fail", () => {
  for (const [tool, list] of Object.entries(cases.invalid)) for (const a of list) assert.notStrictEqual(zbValidateRequest(ZB_SCHEMA, req(tool, a)), null, `${tool} ${JSON.stringify(a)}`);
});

test("validator: envelope", () => {
  assert.ok(zbValidateRequest(ZB_SCHEMA, { ...req("tabs_list", {}), tool: "eval" }));
  assert.ok(zbValidateRequest(ZB_SCHEMA, { ...req("tabs_list", {}), id: "a".repeat(16) + "\n" }));
  assert.ok(zbValidateRequest(ZB_SCHEMA, { ...req("tabs_list", {}), v: true }));
  assert.ok(zbValidateRequest(ZB_SCHEMA, { ...req("tabs_list", {}), __proto__x: 1 }));
  assert.ok(zbValidateRequest(ZB_SCHEMA, null));
  assert.ok(zbValidateRequest(ZB_SCHEMA, req("scroll", { tabId: 1, dy: Infinity })));
});

test("origins", () => {
  assert.strictEqual(L.zbOriginOf("http://localhost:3000/a?b"), "http://localhost:3000");
  assert.strictEqual(L.zbOriginOf("http://[::1]:8080/"), "http://[::1]:8080");
  for (const u of ["about:blank", "file:///etc/passwd", "data:text/html,x", "moz-extension://x/", "view-source:http://a/", "javascript:1", "garbage", undefined])
    assert.strictEqual(L.zbOriginOf(u), null, String(u));
  assert.ok(L.zbArmable("https://example.com/"));
  assert.ok(!L.zbArmable("https://addons.mozilla.org/en-US/firefox/"));
  assert.ok(!L.zbArmable("about:debugging"));
});

test("scope matching (port wildcard only on :* entries)", () => {
  const scope = new Set(["https://app.example.com", ...ZB_CONFIG.allowlist]);
  for (const o of ["https://app.example.com", "http://localhost", "http://localhost:3000", "http://127.0.0.1:5173", "http://[::1]:8000"])
    assert.ok(L.zbInScope(scope, o), o);
  for (const o of ["https://app.example.com:8443", "http://app.example.com", "https://evil.example.com", "http://localhost.evil.com",
                   "https://localhost:3000", "http://localhost:3000x", "http://127.0.0.10", null])
    assert.ok(!L.zbInScope(scope, o), String(o));
});

test("host patterns", () => {
  assert.strictEqual(L.zbHostPattern("http://localhost:*"), "http://localhost/*");
  assert.strictEqual(L.zbHostPattern("http://[::1]:*"), "http://[::1]/*");
  assert.strictEqual(L.zbHostPattern("https://a.example.com:8443"), "https://a.example.com/*");
});

test("glob", () => {
  const m = L.zbGlobMatch;
  assert.ok(m("http://localhost:*/app*", "http://localhost:3000/app/x"));
  assert.ok(!m("http://localhost:*/app*", "https://localhost:3000/app"));
  assert.ok(m("*", "anything") && m("*", ""));
  assert.ok(m("exact", "exact") && !m("exact", "exactly"));
  assert.ok(!m("http://a.b/", "http://aXb/"));        // "." is literal
  assert.ok(!m("http://a/(x)+", "http://a/xx"));      // regex chars are literal
  assert.ok(m("http://a/(x)+?[1]", "http://a/(x)+?[1]"));
  assert.ok(!m("a*a", "a") && m("a*a", "aa") && m("*b*c*", "xbyc") && !m("*c*b*", "xbyc"));
});

test("glob is linear time (no ReDoS)", () => {
  const t = Date.now();
  assert.ok(!L.zbGlobMatch("*a".repeat(240) + "*b", "a".repeat(2048)));
  assert.ok(Date.now() - t < 500);
});

test("arm state machine", () => {
  const scope = new Set(["http://localhost:3000"]);
  assert.strictEqual(L.zbArmDecision(undefined, "http://localhost:3000"), "arm");
  assert.strictEqual(L.zbArmDecision(undefined, null), "refuse");
  assert.strictEqual(L.zbArmDecision(scope, "http://localhost:3000"), "disarm");
  assert.strictEqual(L.zbArmDecision(scope, "https://github.com"), "disarm");  // plain click never widens
  assert.strictEqual(L.zbArmDecision(scope, "https://github.com", true), "widen");
  assert.strictEqual(L.zbArmDecision(scope, "http://localhost:3000", true), "disarm");
  assert.strictEqual(L.zbArmDecision(undefined, "http://localhost:3000", true), "arm");
  assert.strictEqual(L.zbArmDecision(scope, null), "disarm");
  assert.deepStrictEqual(L.zbBadge(undefined, "http://x/"), { text: "", color: null });
  assert.strictEqual(L.zbBadge(scope, "http://localhost:3000/a").text, "ON");
  assert.strictEqual(L.zbBadge(scope, "https://github.com/").text, "!!");
  assert.strictEqual(L.zbBadge(scope, undefined).text, "!!");  // unreadable URL
});

test("sensitive fields", () => {
  assert.ok(L.zbIsSensitiveField("INPUT", "password", ""));
  assert.ok(L.zbIsSensitiveField("input", "PASSWORD", null));
  assert.ok(L.zbIsSensitiveField("input", "text", "cc-number"));
  assert.ok(L.zbIsSensitiveField("input", "text", "billing cc-exp"));
  assert.ok(L.zbIsSensitiveField("div", "", "CC-CSC"));
  assert.ok(!L.zbIsSensitiveField("input", "text", "username"));
  assert.ok(!L.zbIsSensitiveField("textarea", "password", ""));  // type only meaningful on <input>
  assert.ok(!L.zbIsSensitiveField("input", "email", "email"));
  for (const ac of ["current-password", "new-password", "one-time-code", "section-x new-password"])
    assert.ok(L.zbIsSensitiveField("input", "text", ac), ac);
  for (const n of ["password ", " user_pwd", "otp-code ", "cvv ", "card-number "])
    assert.ok(L.zbIsSensitiveField("input", "text", "", n), n);  // toggled-visible password etc.
  assert.ok(!L.zbIsSensitiveField("input", "text", "", "search q"));
  // ZB-6: API keys, secrets, tokens and SSNs (ssn only as its own word: not "classname")
  for (const n of ["api_key ", "apikey ", " stripe-api-key", "client_secret ", "access_token ", "ssn ", " user-ssn", "social_security "])
    assert.ok(L.zbIsSensitiveField("input", "text", "", n), n);
  for (const n of ["classname ", "lessons ", "session_name "]) assert.ok(!L.zbIsSensitiveField("input", "text", "", n), n);
});

test("the injected copies of the sensitive-name rule match logic.js", () => {
  const rule = String(L.zbIsSensitiveField).match(/ZB_SENSITIVE_NAME/) && fs.readFileSync(path.join(EXT, "logic.js"), "utf8")
    .match(/const ZB_SENSITIVE_NAME = \/(.+)\/i;/)[1];
  const actions = fs.readFileSync(path.join(EXT, "actions.js"), "utf8");
  assert.strictEqual(actions.split(`/${rule}/i.test(`).length - 1, 2);
});

test("tab_open allowance", () => {
  const scopes = [new Set(["https://app.example.com"])];
  assert.ok(L.zbOpenAllowed("http://localhost:4000", ZB_CONFIG.allowlist, scopes));
  assert.ok(L.zbOpenAllowed("https://app.example.com", ZB_CONFIG.allowlist, scopes));
  assert.ok(!L.zbOpenAllowed("https://attacker.example", ZB_CONFIG.allowlist, scopes));
  assert.ok(!L.zbOpenAllowed(null, ZB_CONFIG.allowlist, scopes));
  assert.ok(!L.zbOpenAllowed("http://localhost:4000", [], scopes));  // Claude off: local only via an armed local tab
  assert.ok(L.zbOpenAllowed("http://localhost:4000", [], [new Set(["http://localhost:*"])]));
});

test("config defaults: safe for a stranger's first install", () => {
  const { ZB_DEFAULTS, ZB_TUNABLE } = require(path.join(EXT, "config.js"));
  assert.strictEqual(ZB_DEFAULTS.goAnywhere, false);  // go-anywhere is opt-in from the settings page
  assert.strictEqual(ZB_DEFAULTS.autoArmOpened, true);
  assert.strictEqual(ZB_DEFAULTS.alwaysOn, false);  // ZB-3: opt-in, and sessions expire
  assert.strictEqual(require(path.join(EXT, "config.js")).ZB_SESSION_MAX_HOURS, 8);
  assert.ok(Object.isFrozen(ZB_DEFAULTS) && Object.isFrozen(ZB_DEFAULTS.allowlist));
  assert.deepStrictEqual([...ZB_TUNABLE].sort(), Object.keys(ZB_DEFAULTS).sort());
  assert.deepStrictEqual(ZB_CONFIG.allowlist, ZB_DEFAULTS.allowlist);
});

test("zbSanitizeSettings: storage is untrusted; bad values fall back to defaults", () => {
  const { ZB_DEFAULTS, ZB_TUNABLE } = require(path.join(EXT, "config.js"));
  const s = (raw) => L.zbSanitizeSettings(raw, ZB_DEFAULTS, ZB_TUNABLE);
  const d = s(undefined);
  assert.deepStrictEqual(d, { ...ZB_DEFAULTS, allowlist: [...ZB_DEFAULTS.allowlist] });
  for (const raw of [null, 5, "x", [], { goAnywhere: "true" }, { cursorDelayMs: -1 }, { cursorDelayMs: 1.5 }, { cursorDelayMs: 5000 },
                     { allowlist: "http://localhost:*" }, { allowlist: { 0: "http://evil" } }, { hostName: "evil" }]) {
    const out = s(raw);
    assert.deepStrictEqual(out, d, JSON.stringify(raw));
    assert.ok(!("hostName" in out));
  }
  // bad entries are dropped one by one; the good ones stay
  assert.deepStrictEqual(s({ allowlist: ["javascript:alert(1)", "http://localhost:*", "http://a/b", "*", 5, "x".repeat(300)] }).allowlist,
    ["http://localhost:*"]);
  assert.strictEqual(s({ allowlist: new Array(30).fill("http://localhost:*") }).allowlist.length, 20);
  assert.deepStrictEqual(s({ allowlist: [] }).allowlist, []);
  assert.deepStrictEqual(s({ goAnywhere: true, cursorDelayMs: 0, allowlist: ["https://My.Dev:8443", "http://[::1]:*"] }),
    { ...d, goAnywhere: true, cursorDelayMs: 0, allowlist: ["https://my.dev:8443", "http://[::1]:*"] });
});

function pageContext(el, origin) {
  const ctx = vm.createContext({ location: { origin }, document: { querySelector: () => el, activeElement: el, body: {}, documentElement: {} } });
  vm.runInContext(fs.readFileSync(path.join(EXT, "actions.js"), "utf8"), ctx);
  return ctx;
}

test("injected zbType refuses password and cc fields by itself", () => {
  const field = (type, ac, name) => ({ tagName: "INPUT", type, getAttribute: (n) => (n === "autocomplete" ? ac : n === "name" ? name : null) });
  for (const el of [field("password", null), field("text", "cc-number"), field("text", "shipping cc-name"),
                    field("text", "current-password"), field("text", null, "password")]) {
    const r = pageContext(el, "http://localhost:3000").zbType({ selector: "#f", text: "secret" }, "http://localhost:3000");
    assert.strictEqual(r.code, "REFUSED");
  }
});

test("injected functions refuse when the page origin changed", () => {
  const ctx = pageContext(null, "https://evil.example");
  for (const f of ["zbPageMetrics", "zbClick", "zbFieldInfo", "zbType", "zbScroll"])
    assert.strictEqual(ctx[f]({ selector: "a", text: "" }, "http://localhost:3000").code, "OUT_OF_SCOPE", f);
});

test("zbPageMetrics counts visible cross-origin frames and embeds", () => {
  const O = "http://localhost:3000";
  const rect = (w) => ({ width: w, height: w, top: 0, left: 0, bottom: w, right: w });
  const emptyDoc = { querySelectorAll: () => [] };
  const frame = (w, origin, doc) => ({ getBoundingClientRect: () => rect(w), contentDocument: doc,
    contentWindow: { get location() { if (!origin) throw new Error("SecurityError"); return { origin }; } } });
  const run = (frames) => {
    const ctx = vm.createContext({ location: { origin: O }, innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0,
      document: { documentElement: { scrollWidth: 800, scrollHeight: 600 }, body: null, querySelectorAll: () => frames } });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.join(EXT, "actions.js"), "utf8"), ctx);
    return ctx.zbPageMetrics({ fullPage: false }, O).foreignFrames;
  };
  assert.strictEqual(run([]), 0);
  assert.strictEqual(run([frame(300, O, emptyDoc)]), 0);           // same-origin frame
  assert.strictEqual(run([frame(300, null, null)]), 1);            // cross-origin (access throws)
  assert.strictEqual(run([frame(300, "https://bank.example", null)]), 1);
  assert.strictEqual(run([frame(1, null, null)]), 0);              // invisible 1px tracker ignored
  assert.strictEqual(run([frame(300, O, { querySelectorAll: () => [frame(100, null, null)] })]), 1);  // nested
});

test("go-anywhere scope", () => {
  assert.ok(L.zbInScope(new Set(["*"]), "https://anything.example"));
  assert.ok(!L.zbInScope(new Set(["*"]), null));  // unreadable / non-http pages never match
  assert.deepStrictEqual([...L.zbNewScope("https://a.example", { goAnywhere: true, allowlist: ["http://localhost:*"] })], ["*"]);
  // ZB-2: a public tab gets only its own origin; a local tab gets the local allowlist
  assert.deepStrictEqual([...L.zbNewScope("https://a.example", { goAnywhere: false, allowlist: ["http://localhost:*"] })], ["https://a.example"]);
  assert.deepStrictEqual([...L.zbNewScope("http://localhost:3000", { goAnywhere: false, allowlist: ["http://localhost:*", "http://127.0.0.1:*"] })],
    ["http://localhost:3000", "http://localhost:*", "http://127.0.0.1:*"]);
  assert.ok(!L.zbOpenAllowed("https://addons.mozilla.org", ["*"], []));
  assert.ok(L.zbOpenAllowed("https://www.wikipedia.org", ["*"], []));
});

test("injected zbReadText: visible text, http links only, origin-pinned", () => {
  const O = "https://a.example";
  const ctx = vm.createContext({ location: { origin: O }, document: { title: "T", body: { innerText: "a  \n\n\n\nb" },
    querySelectorAll: () => [{ innerText: "Go", href: "https://b.example/" }, { innerText: "x", href: "javascript:1" }] } });
  vm.runInContext(fs.readFileSync(path.join(EXT, "actions.js"), "utf8"), ctx);
  const r = ctx.zbReadText({ maxChars: 1000 }, O);
  assert.strictEqual(r.text, "a\n\nb");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.links)), [{ text: "Go", href: "https://b.example/" }]);
  assert.strictEqual(ctx.zbReadText({ maxChars: 1000 }, "https://evil.example").code, "OUT_OF_SCOPE");
});

test("go-anywhere scope still excludes the add-on store", () => {
  assert.ok(L.zbInScope(new Set(["*"]), "https://example.com"));
  assert.ok(!L.zbInScope(new Set(["*"]), "https://addons.mozilla.org"));
  assert.ok(!L.zbInScope(new Set(["*"]), null));
});

test("zbCssProblem: plain styling passes, anything that could fetch or hide a fetch is refused", () => {
  for (const ok of ["body{color:red}", "p::before{content:'hi'}", "h1{font:16px/1.2 serif}", ".ad{display:none!important}",
                    "@media (max-width:600px){nav{display:none}}", "a{background-image:linear-gradient(red,blue)}"]) {
    assert.strictEqual(L.zbCssProblem(ok), null, ok);
  }
  for (const bad of ["a{background:url(x)}", "a{background:URL( x )}", "@import 'x';", "@IMPORT url(x);", "p{x:u\\72l(x)}",
                     "a{b:image-set('a' 1x)}", "a{b:-webkit-image-set('a' 1x)}", "a{b:image('x.png')}", "a{b:cross-fade(x)}",
                     "a{b:-moz-element(#x)}", "@font-face{font-family:f;src(x)}", "a{cursor:url\n(x)}", ""]) {
    assert.notStrictEqual(L.zbCssProblem(bad), null, bad);
  }
});

test("zbRedactUrl / zbSecretValue: tokens masked, slugs and ids kept (ZB-5)", () => {
  for (const [url, want] of JSON.parse(fs.readFileSync(path.join(__dirname, "..", "url_cases.json"), "utf8"))) {
    assert.strictEqual(L.zbRedactUrl(url), want, url);
  }
  assert.strictEqual(L.zbRedactUrl("https://u:p@a.example/"), "https://a.example/");
  assert.strictEqual(L.zbRedactUrl("javascript:alert(1)"), "");
  for (const v of ["eyJhbGciOi", "0123456789abcdef0123", "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5"]) assert.ok(L.zbSecretValue(v), v);
  for (const v of ["my-blog-post-about-things-2024", "created_at", "20241118", "getting-started", "", null]) assert.ok(!L.zbSecretValue(v), String(v));
});

test("zbIsLocal: the allowlist plus names that always mean this computer (ZB-8)", () => {
  const allow = ZB_CONFIG.allowlist;
  for (const o of ["http://localhost:5173", "http://127.0.0.1:8000", "http://[::1]:3000", "https://localhost", "http://app.localhost:3000",
    "http://127.1.2.3", "http://0.0.0.0:8080"]) assert.ok(L.zbIsLocal(o, allow), o);
  for (const o of ["https://github.com", "http://localhost.evil.example", "http://127.0.0.1.evil.example", null])
    assert.ok(!L.zbIsLocal(o, allow), String(o));
  assert.ok(L.zbIsLocal("http://203.0.113.5:8000", [...allow, "http://203.0.113.5:*"]), "anything you add to the allowlist");
});

test("ZB-12: zbIsLocalAddress knows every loopback, private, link-local and shared range, in v4 and v6", () => {
  const local = ["127.0.0.1", "127.255.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
    "100.127.255.255", "169.254.169.254", "0.0.0.0", "0.1.2.3", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "[::1]", "::", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "[::ffff:7f00:1]", "::ffff:192.168.0.1", "::ffff:a9fe:a9fe",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.1.2.3", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "febf::1",
    "fec0::1", "ff02::1", "FD00::1"];
  const pub = ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "192.167.1.1",
    "11.0.0.1", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "fbff::1", "fec0", "",
    null, "256.1.1.1", "1.2.3", "::1::2", "1:2:3:4:5:6:7:8:9", "localhost", "g::1"];
  for (const a of local) assert.strictEqual(L.zbIsLocalAddress(a), true, a);
  for (const a of pub) assert.strictEqual(L.zbIsLocalAddress(a), false, String(a));
});

test("ZB-12: zbIsLocal by the URL's own host: private ranges, mapped and odd spellings, local suffixes, single labels", () => {
  const local = ["http://[::ffff:127.0.0.1]:8080", "http://192.168.1.1", "http://10.0.0.5:9000", "http://172.20.1.1",
    "http://100.100.100.100", "http://169.254.169.254", "http://printer.local", "http://nas.lan", "http://box.home.arpa",
    "http://metadata.google.internal", "http://[fd00::1]", "http://[fe80::1]", "http://0x7f.1:8080", "http://2130706433:8080",
    "http://[0:0:0:0:0:0:0:1]:8080", "http://017700000001", "http://router", "http://nas:5000", "http://LOCALHOST.",
    "http://printer.local.", "http://[64:ff9b::7f00:1]"];
  const pub = ["https://example.com", "https://8.8.8.8", "http://[2606:4700::1111]", "http://local.example.com",
    "http://localtest.me:8080", "http://127.0.0.1.nip.io:8080", "http://internal.example", "http://lan.example.org"];
  for (const o of local) assert.strictEqual(L.zbIsLocal(o, []), true, o);
  for (const o of pub) assert.strictEqual(L.zbIsLocal(o, []), false, `${o} (public by name; DNS and the connected address decide)`);
});

test("zbCrossingNeedsOk: public <-> local moves need your OK (ZB-8)", () => {
  const st = (touched, handArmedLocal = false, approved = []) => ({ touched: new Set(touched), handArmedLocal, approved: new Set(approved) });
  const L1 = "http://localhost:5173", P = "https://github.com";
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st([])), true, "you never armed a local tab");
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st([], true)), false, "you armed one by hand");
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st(["local"], true)), false);
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st(["public"], true)), true, "tainted by a public page");
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st(["public"], true, [L.zbCrossingKey(L1, true)])), false, "you already allowed it");
  assert.strictEqual(L.zbCrossingNeedsOk(L1, true, st(["public"], true, [L.zbCrossingKey(L1, false)])), true, "allowed as a public site only");
  assert.strictEqual(L.zbCrossingNeedsOk(P, false, st([])), false);
  assert.strictEqual(L.zbCrossingNeedsOk(P, false, st(["public"])), false);
  assert.strictEqual(L.zbCrossingNeedsOk(P, false, st(["local"], true)), true, "the other direction");
  assert.strictEqual(L.zbCrossingNeedsOk(P, false, st(["local"], true, [L.zbCrossingKey(P, false)])), false);
});

test("zbSettingsDiff: only settings that differ from the defaults are saved (ZB-9)", () => {
  const { ZB_DEFAULTS, ZB_TUNABLE } = require(path.join(EXT, "config.js"));
  const full = L.zbSanitizeSettings({}, ZB_DEFAULTS, ZB_TUNABLE);
  assert.deepStrictEqual(L.zbSettingsDiff(full, ZB_DEFAULTS, ZB_TUNABLE), {});
  assert.deepStrictEqual(L.zbSettingsDiff({ ...full, goAnywhere: true, allowlist: ["http://localhost:*"] }, ZB_DEFAULTS, ZB_TUNABLE),
    { goAnywhere: true, allowlist: ["http://localhost:*"] });
  assert.deepStrictEqual(L.zbSettingsDiff({ alwaysOn: false, bogus: 1 }, ZB_DEFAULTS, ZB_TUNABLE), {});
});

test("zbVersionLess", () => {
  assert.ok(L.zbVersionLess("1.5.0", "1.5.2"));
  assert.ok(L.zbVersionLess("1.5.1", "1.5.2"));
  assert.ok(L.zbVersionLess("1.4.10", "1.5.0"));
  assert.ok(!L.zbVersionLess("1.5.2", "1.5.2"));
  assert.ok(!L.zbVersionLess("1.10.0", "1.5.2"));
  assert.ok(L.zbVersionLess(undefined, "1.5.2"));
  assert.ok(L.zbVersionLess("1.5", "1.5.2"));
});

test("ZB-14: zbRateCap", () => {
  let t = [];
  for (let i = 0; i < 3; i++) { const r = L.zbRateCap(t, 1000 + i, 3, 100); t = r.times; assert.strictEqual(r.over, false); }
  assert.strictEqual(L.zbRateCap(t, 1050, 3, 100).over, true);
  assert.strictEqual(L.zbRateCap(t, 1101, 3, 100).over, false, "the oldest fell out of the window");
  assert.deepStrictEqual(L.zbRateCap([5000], 1000, 3, 100).times, [1000], "times from the future (clock change) are dropped");
});
