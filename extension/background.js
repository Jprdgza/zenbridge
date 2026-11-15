"use strict";
// zenbridge background page. Arming state lives ONLY in this in-memory Map
// (never persisted, so it resets when the browser restarts).
// Every host request goes through handleRequest(): the single choke point.

const armed = new Map();  // tabId -> Set of scope entries (origins, or "scheme://host:*")
const NO_ID = "0".repeat(16);
const PAGE_CODES = ["OUT_OF_SCOPE", "INVALID", "REFUSED", "INTERNAL"];

class ZbError extends Error {
  constructor(code, message, tabUrl) { super(message); this.code = code; this.tabUrl = tabUrl; }
}

// ------------------------------------------------------------ badge + arming
const TITLES = {
  "": "zenbridge: click to arm this tab for Claude",
  ON: "zenbridge: ARMED - click to disarm",
  "!!": "zenbridge: armed but OUT OF SCOPE (Claude is blocked) - click to disarm, Shift+click to add this site",
};
const ignore = () => {};
let session = false;  // a session lets Claude open its own tabs without any armed page

function setBadge(tabId, url) {
  const b = zbBadge(armed.get(tabId), url);
  // null falls back to the global badge (session indicator) for unarmed tabs
  browser.browserAction.setBadgeText({ tabId, text: b.text || null }).catch(ignore);
  browser.browserAction.setTitle({ tabId, title: b.text ? TITLES[b.text] : null }).catch(ignore);
  if (b.color) browser.browserAction.setBadgeBackgroundColor({ tabId, color: b.color }).catch(ignore);
}

// With nothing armed and no session, drop every optional host grant (incl. <all_urls>).
function releaseIfIdle() {
  if (armed.size > 0 || session) return;
  browser.permissions.getAll().then((p) => {
    if (armed.size === 0 && !session && p.origins.length) return browser.permissions.remove({ origins: p.origins });
  }).catch(ignore);
}

function setSession(on) {
  session = on;
  browser.browserAction.setBadgeText({ text: on ? "AI" : "" }).catch(ignore);
  browser.browserAction.setBadgeBackgroundColor({ color: "#d97757" }).catch(ignore);
  browser.browserAction.setTitle({ title: on ? "zenbridge: Claude is ON - click a page to hand it to Claude (Alt+Shift+K turns Claude off)"
    : "zenbridge: click to arm this tab, or click on a new tab / Alt+Shift+C to start a Claude session" }).catch(ignore);
  releaseIfIdle();
}

// Zen can't show a permission prompt on its new-tab page, so starting a session goes through
// an extension page with its own "Turn Claude on" button (start/start.html).
const START_URL = browser.runtime.getURL("start/start.html");
let startPending = false;  // a grant only starts a session if you asked for one (or in always-on mode)
function startSession(tabId) {
  startPending = true;
  (tabId === undefined ? browser.tabs.create({ url: START_URL }) : browser.tabs.update(tabId, { url: START_URL })).catch(ignore);
}
// The grant may come from the start page, the add-ons manager, or arming a tab.
browser.permissions.onAdded.addListener((p) => {
  if (!session && (ZB_CONFIG.alwaysOn || startPending) && p.origins && p.origins.includes("<all_urls>")) {
    startPending = false;
    setSession(true);
  }
});
browser.permissions.onRemoved.addListener((p) => {
  if (session && p.origins && p.origins.includes("<all_urls>")) endAll();
});

function endAll() {
  for (const tabId of [...armed.keys()]) disarm(tabId);
  setSession(false);
}

// Orange "Claude" tab group for controlled tabs; silently skipped where tab groups are unsupported.
const claudeGroups = new Map();  // windowId -> groupId
async function setGrouped(tabId, on) {
  if (!ZB_CONFIG.tabGroup || typeof browser.tabs.group !== "function") return;
  try {
    const tab = await browser.tabs.get(tabId);
    if (!on) {
      if ([...claudeGroups.values()].includes(tab.groupId)) await browser.tabs.ungroup(tabId);
      return;
    }
    if (tab.pinned) return;
    const existing = claudeGroups.get(tab.windowId);
    let gid;
    try { gid = await browser.tabs.group(existing === undefined ? { tabIds: tabId } : { tabIds: tabId, groupId: existing }); }
    catch (e) { gid = await browser.tabs.group({ tabIds: tabId }); }  // old group was closed
    claudeGroups.set(tab.windowId, gid);
    if (browser.tabGroups) await browser.tabGroups.update(gid, { title: "Claude", color: "orange" });
  } catch (e) { /* unsupported or tab gone: the badge still shows control */ }
}

function disarm(tabId) {
  armed.delete(tabId);
  setBadge(tabId, undefined);
  setGrouped(tabId, false);
  releaseIfIdle();
}

browser.browserAction.onClicked.addListener((tab, info) => {
  const origin = zbArmable(tab.url) ? zbOriginOf(tab.url) : null;
  const shift = !!(info && Array.isArray(info.modifiers) && info.modifiers.includes("Shift"));
  const decision = zbArmDecision(armed.get(tab.id), origin, shift);
  if (decision === "disarm") { disarm(tab.id); return; }
  if (decision === "refuse") {  // new tab, homepage, about: pages: start a tab-less session (always-on: never toggles off)
    if (!session) startSession(tab.id); else if (!ZB_CONFIG.alwaysOn) endAll();
    return;
  }
  const extra = decision === "arm" ? ZB_CONFIG.allowlist.map(zbHostPattern) : [];
  // permissions.request must be the first call in the click handler (user gesture).
  // <all_urls> is needed by tabs.captureTab.
  browser.permissions.request({ origins: [...new Set([zbHostPattern(origin), ...extra, "<all_urls>"])] }).then((granted) => {
    if (!granted) return;
    if (decision === "arm") { armed.set(tab.id, zbNewScope(origin, ZB_CONFIG)); setGrouped(tab.id, true); }
    else if (armed.has(tab.id)) armed.get(tab.id).add(origin);
    setBadge(tab.id, tab.url);
  });
});

browser.tabs.onUpdated.addListener((tabId, info, tab) => { if (armed.has(tabId)) setBadge(tabId, tab.url); });
browser.tabs.onRemoved.addListener((tabId) => { armed.delete(tabId); releaseIfIdle(); });
browser.commands.onCommand.addListener((name) => {
  if (name === "disarm-all") endAll();
  if (name === "start-session" && !session) startSession();
});
// Armed tabs never survive a restart. In always-on mode the session does, if you granted it before
// (Firefox keeps the grant); Alt+Shift+K revokes the grant, so Claude stays off until you click again.
if (ZB_CONFIG.alwaysOn) browser.permissions.contains({ origins: ["<all_urls>"] }).then(setSession, () => setSession(false));
else setSession(false);

// ------------------------------------------------------------- choke point
async function resolveArmedTab(tabId) {
  const scope = armed.get(tabId);
  if (!scope) throw new ZbError("NOT_ARMED", "tab is not armed (or does not exist); ask the user to arm it");
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch (e) { disarm(tabId); throw new ZbError("NOT_ARMED", "tab is not armed (or does not exist)"); }
  const origin = zbOriginOf(tab.url);
  if (!zbInScope(scope, origin)) {
    throw new ZbError("OUT_OF_SCOPE", "armed tab is on an origin outside its scope; the user can Shift+click the toolbar button to add this site", tab.url);
  }
  return { tab, scope, origin, url: tab.url };
}

async function inject(ctx, func, arg) {
  const results = await browser.scripting.executeScript({ target: { tabId: ctx.tab.id, frameIds: [0] }, func, args: [arg, ctx.origin] });
  const r = results && results[0];
  if (!r || r.error || !r.result || typeof r.result !== "object") throw new ZbError("INTERNAL", "page script failed", ctx.url);
  if (r.result.ok !== true) {
    const code = PAGE_CODES.includes(r.result.code) ? r.result.code : "INTERNAL";
    throw new ZbError(code, String(r.result.message || "page refused").slice(0, 300), ctx.url);
  }
  return r.result;
}

// Visual cue in the page before an action; never blocks or fails the action itself.
async function cue(ctx, arg, pause) {
  if (!ZB_CONFIG.showActivity) return;
  try { await inject(ctx, zbShow, arg); } catch (e) { return; }
  if (pause && ZB_CONFIG.cursorDelayMs > 0) await new Promise((r) => setTimeout(r, ZB_CONFIG.cursorDelayMs));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const int = (v) => Math.max(0, Math.round(num(v)));
const withoutTab = ({ tabId, ...rest }) => rest;

const TOOLS = {
  async tabs_list() {
    const tabs = [];
    for (const [tabId, scope] of [...armed]) {
      let tab;
      try { tab = await browser.tabs.get(tabId); } catch (e) { disarm(tabId); continue; }
      const inScope = zbInScope(scope, zbOriginOf(tab.url));
      // Out-of-scope pages may carry secrets in URL/title: report only that the tab left scope.
      tabs.push({ tabId, title: inScope ? String(tab.title || "").slice(0, 200) : "",
        url: inScope ? String(tab.url || "").slice(0, 2048) : "", active: !!tab.active, inScope });
    }
    return { tabs, session };
  },
  async tab_switch(a, ctx) {
    await browser.tabs.update(ctx.tab.id, { active: true });
    await browser.windows.update(ctx.tab.windowId, { focused: true });
    return { tabId: ctx.tab.id };
  },
  async tab_open(a) {
    const origin = zbOriginOf(a.url);
    if (!zbOpenAllowed(origin, ZB_CONFIG.goAnywhere ? ["*"] : ZB_CONFIG.allowlist, armed.values())) {
      throw new ZbError("OUT_OF_SCOPE", ZB_CONFIG.goAnywhere ? "this site cannot be opened (add-on store)"
        : "tab_open is limited to the dev allowlist and origins already in an armed tab's scope");
    }
    const tab = await browser.tabs.create({ url: a.url, active: true });
    let isArmed = false;
    // origin is already user-approved (zbOpenAllowed); still require the host grant from their click.
    if (ZB_CONFIG.autoArmOpened && await browser.permissions.contains({ origins: [zbHostPattern(origin)] })) {
      armed.set(tab.id, zbNewScope(origin, ZB_CONFIG));
      setBadge(tab.id, a.url);
      setGrouped(tab.id, true);
      isArmed = true;
    }
    return { tabId: tab.id, armed: isArmed,
      note: isArmed ? "tab opened and armed: you can act on it now"
        : "tab is UNARMED (no session yet): ask the user to click the zenbridge button on a new tab or press Alt+Shift+C" };
  },
  async tab_close(a, ctx) {
    await browser.tabs.remove(ctx.tab.id);
    disarm(ctx.tab.id);
    return { tabId: ctx.tab.id };
  },
  async navigate(a, ctx) {
    if (!zbInScope(ctx.scope, zbOriginOf(a.url))) throw new ZbError("OUT_OF_SCOPE", "target origin is not in this tab's scope", ctx.url);
    await browser.tabs.update(ctx.tab.id, { url: a.url });
    return { tabId: ctx.tab.id, url: a.url };
  },
  async reload(a) {
    const reloaded = [];
    for (const [tabId, scope] of [...armed]) {
      let tab;
      try { tab = await browser.tabs.get(tabId); } catch (e) { disarm(tabId); continue; }
      if (!zbInScope(scope, zbOriginOf(tab.url)) || !zbGlobMatch(a.urlPattern, tab.url)) continue;
      await browser.tabs.reload(tabId, { bypassCache: !!a.bypassCache });
      reloaded.push(tabId);
    }
    return { reloaded };
  },
  async screenshot(a, ctx) {
    if (ctx.tab.discarded) throw new ZbError("REFUSED", "tab is discarded (unloaded); switch to it first", ctx.url);
    const m = await inject(ctx, zbPageMetrics, { fullPage: !!a.fullPage });
    // In go-anywhere mode every origin is in scope, so framed content reveals nothing out of scope.
    if (!ctx.scope.has("*") && m.foreignFrames !== 0) {
      throw new ZbError("REFUSED", "page shows cross-origin frames/embeds that a screenshot would reveal; use click/scroll instead", ctx.url);
    }
    const vw = int(m.vw), vh = int(m.vh), dw = int(m.dw), dh = int(m.dh);
    const opts = a.fullPage
      ? { format: "jpeg", quality: 80, scale: 1, rect: { x: 0, y: 0, width: Math.min(dw, 1280), height: Math.min(dh, 8000) } }
      : { format: "png", scale: 1 };  // scale is device px per CSS px: 1 => image px == CSS px
    await cue(ctx, { hide: true });  // keep the overlay out of the image
    let dataUrl;
    try { dataUrl = await browser.tabs.captureTab(ctx.tab.id, opts); } finally { await cue(ctx, { kind: "glow" }); }
    await resolveArmedTab(ctx.tab.id);  // tab may have navigated out of scope during capture
    const mime = a.fullPage ? "image/jpeg" : "image/png";
    const prefix = `data:${mime};base64,`;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new ZbError("INTERNAL", "unexpected capture format", ctx.url);
    return { mimeType: mime, data: dataUrl.slice(prefix.length),
      width: a.fullPage ? opts.rect.width : vw, height: a.fullPage ? opts.rect.height : vh,
      scrollX: num(m.scrollX), scrollY: num(m.scrollY), viewport: { width: vw, height: vh },
      document: { width: dw, height: dh }, truncated: !!a.fullPage && (dw > 1280 || dh > 8000) };
  },
  async read_page(a, ctx) {
    const r = await inject(ctx, zbReadText, { maxChars: a.maxChars || 20000 });
    const links = (Array.isArray(r.links) ? r.links : []).slice(0, 100)
      .filter((l) => l && typeof l.text === "string" && typeof l.href === "string" && zbOriginOf(l.href))
      .map((l) => ({ text: l.text.slice(0, 120), href: l.href.slice(0, 2048) }));
    return { title: String(r.title || "").slice(0, 200), url: String(ctx.url).slice(0, 2048),
      text: String(r.text || "").slice(0, a.maxChars || 20000), truncated: !!r.truncated, links };
  },
  async click(a, ctx) {
    const r = await inject(ctx, zbClick, withoutTab(a));
    return { tag: String(r.tag).slice(0, 40), text: String(r.text).slice(0, 200) };
  },
  async type(a, ctx) {
    const info = await inject(ctx, zbFieldInfo, { selector: a.selector });
    if (info.found && zbIsSensitiveField(info.tag, info.type, info.autocomplete, info.nameAndId)) {
      throw new ZbError("REFUSED", "refusing to type into a password or credit-card field", ctx.url);
    }
    const r = await inject(ctx, zbType, withoutTab(a));
    return { tag: String(r.tag).slice(0, 40), typed: Math.min(int(r.typed), 10000),
      method: ["insertText", "setter", "none"].includes(r.method) ? r.method : "none" };
  },
  async scroll(a, ctx) {
    const r = await inject(ctx, zbScroll, withoutTab(a));
    return { scrollX: num(r.scrollX), scrollY: num(r.scrollY) };
  },
};

// validate -> resolve tab -> check armed -> check scope -> perform -> validate result -> return
async function handleRequest(msg) {
  const id = msg && typeof msg.id === "string" && /^[0-9a-f]{16,64}$/.test(msg.id) ? msg.id : NO_ID;
  const fail = (code, message, tabUrl) => {
    const out = { v: 1, id, ok: false, error: { code, message: String(message).slice(0, 500) } };
    if (typeof tabUrl === "string") out.tabUrl = tabUrl.slice(0, 2048);
    return out;
  };
  const err = zbValidateRequest(ZB_SCHEMA, msg);
  if (err) return fail("INVALID", err);
  let ctx = null;
  try {
    if (Object.hasOwn(msg.args, "tabId")) ctx = await resolveArmedTab(msg.args.tabId);
    if (ctx && ["click", "type", "scroll", "read_page"].includes(msg.tool)) {
      const a = msg.args;
      await cue(ctx, msg.tool === "read_page" ? { kind: "glow" } : { kind: msg.tool, selector: a.selector, x: a.x, y: a.y }, msg.tool !== "read_page");
    }
    const result = await TOOLS[msg.tool](msg.args, ctx);
    const rerr = zbValidateResult(ZB_SCHEMA, msg.tool, result);
    if (rerr) return fail("INTERNAL", `unexpected result (${rerr})`, ctx && ctx.url);
    const out = { v: 1, id, ok: true, result };
    if (ctx) out.tabUrl = String(ctx.url).slice(0, 2048);
    return out;
  } catch (e) {
    if (e instanceof ZbError) return fail(e.code, e.message, e.tabUrl);
    return fail("INTERNAL", (e && e.message) || "error", ctx && ctx.url);
  }
}

// ---------------------------------------------------------- native messaging
let port = null;
let backoffMs = 1000;
let connectedAt = 0;

function connect() {
  connectedAt = Date.now();
  port = browser.runtime.connectNative(ZB_CONFIG.hostName);
  port.onMessage.addListener(async (msg) => {
    const p = port;
    const resp = await handleRequest(msg);
    if (p === port && p) p.postMessage(resp);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    if (Date.now() - connectedAt > 10000) backoffMs = 1000;
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  });
}

connect();
