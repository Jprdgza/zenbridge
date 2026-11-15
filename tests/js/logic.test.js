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
});

test("tab_open allowance", () => {
  const scopes = [new Set(["https://app.example.com"])];
  assert.ok(L.zbOpenAllowed("http://localhost:4000", ZB_CONFIG.allowlist, scopes));
  assert.ok(L.zbOpenAllowed("https://app.example.com", ZB_CONFIG.allowlist, scopes));
  assert.ok(!L.zbOpenAllowed("https://attacker.example", ZB_CONFIG.allowlist, scopes));
  assert.ok(!L.zbOpenAllowed(null, ZB_CONFIG.allowlist, scopes));
});

test("config defaults", () => {
  assert.strictEqual(ZB_CONFIG.autoArmOpened, true);
  assert.strictEqual(ZB_CONFIG.goAnywhere, true);
  assert.ok(Object.isFrozen(ZB_CONFIG) && Object.isFrozen(ZB_CONFIG.allowlist));
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
  assert.deepStrictEqual([...L.zbNewScope("https://a.example", { goAnywhere: false, allowlist: ["http://localhost:*"] })], ["https://a.example", "http://localhost:*"]);
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
