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
let hostStatus = "connecting";  // "connected" | "missing" (companion app not installed) | "disconnected"

// Settings from the settings page; sanitized, since storage is just data.
function applySettings(raw) { Object.assign(ZB_CONFIG, zbSanitizeSettings(raw, ZB_DEFAULTS, ZB_TUNABLE)); }
const settingsReady = browser.storage.local.get("settings").then((r) => applySettings(r.settings), () => applySettings(undefined));
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
});

// Read by the start and settings pages through runtime.getBackgroundPage().
function zbStatus() {
  return { host: hostStatus, session, armedTabs: armed.size, setupUrl: ZB_SETUP_URL };
}

// The toolbar badge without a tab-specific one: "!" if the companion app is missing, "AI" when Claude is on.
function setGlobalBadge() {
  const missing = hostStatus === "missing";
  browser.browserAction.setBadgeText({ text: missing ? "!" : session ? "AI" : "" }).catch(ignore);
  browser.browserAction.setBadgeBackgroundColor({ color: missing ? ZB_COLORS.warn : ZB_COLORS.accent }).catch(ignore);
  if (browser.browserAction.setBadgeTextColor) browser.browserAction.setBadgeTextColor({ color: ZB_COLORS.crust }).catch(ignore);
  browser.browserAction.setTitle({ title: missing ? "zenbridge: the companion app is not installed - open the add-on's settings for setup"
    : session ? "zenbridge: Claude is ON - click a page to hand it to Claude (Alt+Shift+K turns Claude off)"
      : "zenbridge: click to arm this tab, or click on a new tab / Alt+Shift+C to turn Claude on" }).catch(ignore);
}

function setBadge(tabId, url) {
  const b = zbBadge(armed.get(tabId), url);
  // null falls back to the global badge (session indicator) for unarmed tabs
  browser.browserAction.setBadgeText({ tabId, text: b.text || null }).catch(ignore);
  browser.browserAction.setTitle({ tabId, title: b.text ? TITLES[b.text] : null }).catch(ignore);
  if (b.color) browser.browserAction.setBadgeBackgroundColor({ tabId, color: b.color }).catch(ignore);
  if (b.color && browser.browserAction.setBadgeTextColor) browser.browserAction.setBadgeTextColor({ tabId, color: ZB_COLORS.crust }).catch(ignore);
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
  setGlobalBadge();
  releaseIfIdle();
}

// Zen can't show a permission prompt on its new-tab page, so starting a session goes through
// an extension page with its own "Turn Claude on" button (pages/start.html).
const START_URL = browser.runtime.getURL("pages/start.html");
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

// Purple (Catppuccin-ish) "Claude" tab group for controlled tabs; silently skipped where tab groups are unsupported.
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
    if (browser.tabGroups) await browser.tabGroups.update(gid, { title: "Claude", color: "purple" });
  } catch (e) { /* unsupported or tab gone: the badge still shows control */ }
}

const injectedCss = new Map();  // tabId -> CSS strings inject_css added (gone after navigation)
const consoleTabs = new Set();  // tabs where Claude asked for console messages: re-hooked on each page load
const net = new Map();          // tabId -> { doc: page origin, list: requests } (armed tabs only, in memory)
const uploads = new Map();      // uploadId -> pieces of a file on its way to file_upload
function clearCss(tabId) {
  const list = injectedCss.get(tabId) || [];
  injectedCss.delete(tabId);
  return Promise.all(list.map((css) => browser.scripting.removeCSS({ target: { tabId, frameIds: [0] }, css }).catch(ignore)));
}

function forgetTab(tabId) {
  injectedCss.delete(tabId);
  consoleTabs.delete(tabId);
  net.delete(tabId);
}

function disarm(tabId) {
  armed.delete(tabId);
  consoleTabs.delete(tabId);
  net.delete(tabId);
  clearCss(tabId);
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

browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading") injectedCss.delete(tabId);  // navigation/reload drops inserted CSS
  if (info.status === "complete" && consoleTabs.has(tabId)) hookConsole(tabId);
  if (armed.has(tabId)) setBadge(tabId, tab.url);
});
browser.tabs.onRemoved.addListener((tabId) => { armed.delete(tabId); forgetTab(tabId); releaseIfIdle(); });

// Network log for network_requests: armed tabs only, newest 500 per tab, credentials in URLs redacted.
// Each entry remembers the page that made it, so nothing from an out-of-scope page is ever shown.
function onNetwork(d, error) {
  if (!armed.has(d.tabId)) return;
  const url = zbRedactUrl(d.url);
  if (!url) return;
  const doc = d.type === "main_frame" ? zbOriginOf(d.url) : zbOriginOf(d.documentUrl || d.originUrl || "");
  let rec = net.get(d.tabId);
  if (!rec) net.set(d.tabId, rec = { doc, list: [] });
  rec.list.push({ method: String(d.method || "").slice(0, 16), url, type: String(d.type || "").slice(0, 40),
    status: Math.min(999, Math.max(0, Math.round(Number(d.statusCode) || 0))), time: Number(d.timeStamp) || 0, doc,
    ...(error ? { error: String(error).slice(0, 200) } : {}) });
  if (rec.list.length > 500) rec.list.splice(0, rec.list.length - 500);
}
if (browser.webRequest) {
  const all = { urls: ["<all_urls>"] };
  browser.webRequest.onBeforeRequest.addListener((d) => {  // a new site in the tab starts a fresh log
    if (d.type !== "main_frame" || !armed.has(d.tabId)) return;
    const doc = zbOriginOf(d.url), rec = net.get(d.tabId);
    if (!rec || rec.doc !== doc) net.set(d.tabId, { doc, list: [] });
  }, { ...all, types: ["main_frame"] });
  browser.webRequest.onCompleted.addListener((d) => onNetwork(d), all);
  browser.webRequest.onErrorOccurred.addListener((d) => onNetwork(d, d.error), all);
}
browser.commands.onCommand.addListener((name) => {
  if (name === "disarm-all") endAll();
  if (name === "start-session" && !session) startSession();
});
// Armed tabs never survive a restart. In always-on mode the session does, if you granted it before
// (Firefox keeps the grant); Alt+Shift+K revokes the grant, so Claude stays off until you click again.
settingsReady.then(() => {
  if (ZB_CONFIG.alwaysOn) return browser.permissions.contains({ origins: ["<all_urls>"] }).then(setSession, () => setSession(false));
  setSession(false);
});

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

// A busy page or a window that isn't drawing (minimized, hidden workspace) can stall the browser APIs.
// Answer with a clear error well before the host's own timeout instead of hanging.
function withTimeout(promise, ms, message, ctx) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new ZbError("TIMEOUT", message, ctx && ctx.url)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function inject(ctx, func, arg, ms = 8000) {
  const results = await withTimeout(
    browser.scripting.executeScript({ target: { tabId: ctx.tab.id, frameIds: [0] }, func, args: [arg, ctx.origin] }),
    ms, "the page did not respond in time (busy or frozen); the action may still happen", ctx);
  const r = results && results[0];
  if (!r || r.error || !r.result || typeof r.result !== "object") throw new ZbError("INTERNAL", "page script failed", ctx.url);
  if (r.result.ok !== true) {
    const code = PAGE_CODES.includes(r.result.code) ? r.result.code : "INTERNAL";
    throw new ZbError(code, String(r.result.message || "page refused").slice(0, 300), ctx.url);
  }
  return r.result;
}

function hookConsole(tabId) {
  resolveArmedTab(tabId).then((ctx) => inject(ctx, zbPage, { op: "consoleHook" }, 3000)).catch(ignore);
}

// Visual cue in the page before an action; never blocks or fails the action itself.
async function cue(ctx, arg, pause) {
  if (!ZB_CONFIG.showActivity) return;
  try { await inject(ctx, zbShow, arg, 1500); } catch (e) { return; }
  if (pause && ZB_CONFIG.cursorDelayMs > 0) await new Promise((r) => setTimeout(r, ZB_CONFIG.cursorDelayMs));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const int = (v) => Math.max(0, Math.round(num(v)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, num(v)));
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const REF = /^ref_[0-9]{1,7}$/;
const UPLOAD_HOLD = 15000000;  // base64 characters held at once (10 MB of files)
// tabs.update/goBack/goForward resolve before the new page commits, so the next call would still see
// the old page. Wait (up to 5 s) until the URL changes, or a same-URL load starts and finishes.
async function settled(tabId, before) {
  let tab, loading = false;
  for (let i = 0; i < 50; i++) {
    tab = await browser.tabs.get(tabId);
    if (tab.status === "loading") loading = true;
    if ((tab.url && tab.url !== before && tab.url !== "about:blank") || (loading && tab.status === "complete")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return tab;
}
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
    const before = ctx.tab.url;
    if (a.history) {
      await (a.history === "back" ? browser.tabs.goBack(ctx.tab.id) : browser.tabs.goForward(ctx.tab.id));
      const tab = await settled(ctx.tab.id, before);
      // Report where history landed, but never the URL of a page outside this tab's scope.
      const url = zbInScope(ctx.scope, zbOriginOf(tab.url)) ? str(tab.url, 2048) : "(a page outside this tab's scope)";
      return { tabId: ctx.tab.id, url };
    }
    if (!zbInScope(ctx.scope, zbOriginOf(a.url))) throw new ZbError("OUT_OF_SCOPE", "target origin is not in this tab's scope", ctx.url);
    await browser.tabs.update(ctx.tab.id, { url: a.url });
    await settled(ctx.tab.id, before);
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
    const g = a.region;
    if (g && (g.x >= vw || g.y >= vh)) throw new ZbError("INVALID", "region starts outside the viewport", ctx.url);
    const opts = a.fullPage
      ? { format: "jpeg", quality: 80, scale: 1, rect: { x: 0, y: 0, width: Math.min(dw, 1280), height: Math.min(dh, 8000) } }
      : g  // rect is in page coordinates; scale 2 zooms the region in
        ? { format: "png", scale: 2, rect: { x: num(m.scrollX) + g.x, y: num(m.scrollY) + g.y, width: Math.min(g.width, vw - g.x), height: Math.min(g.height, vh - g.y) } }
        : { format: "png", scale: 1 };  // scale is device px per CSS px: 1 => image px == CSS px
    await cue(ctx, { hide: true });  // keep the overlay out of the image
    let dataUrl;
    try {
      dataUrl = await withTimeout(browser.tabs.captureTab(ctx.tab.id, opts), 15000,
        "the tab did not render in time (is the window minimized or the tab in another workspace?); try tab_switch, then screenshot again", ctx);
    } finally { await cue(ctx, { kind: "glow" }); }
    await resolveArmedTab(ctx.tab.id);  // tab may have navigated out of scope during capture
    const mime = a.fullPage ? "image/jpeg" : "image/png";
    const prefix = `data:${mime};base64,`;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new ZbError("INTERNAL", "unexpected capture format", ctx.url);
    return { mimeType: mime, data: dataUrl.slice(prefix.length),
      width: a.fullPage ? opts.rect.width : g ? Math.round(opts.rect.width * 2) : vw,
      height: a.fullPage ? opts.rect.height : g ? Math.round(opts.rect.height * 2) : vh,
      ...(g ? { scale: 2 } : {}),
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
    const info = await inject(ctx, zbFieldInfo, { selector: a.selector, ref: a.ref });
    if (info.found && zbIsSensitiveField(info.tag, info.type, info.autocomplete, info.nameAndId)) {
      throw new ZbError("REFUSED", "refusing to type into a password or credit-card field", ctx.url);
    }
    const r = await inject(ctx, zbType, withoutTab(a));
    return { tag: String(r.tag).slice(0, 40), typed: Math.min(int(r.typed), 10000),
      method: ["insertText", "setter", "none"].includes(r.method) ? r.method : "none" };
  },
  async inject_css(a, ctx) {
    const tabId = ctx.tab.id;
    if (a.clear) { await clearCss(tabId); return { tabId, active: 0 }; }
    const problem = zbCssProblem(a.css);
    if (problem) throw new ZbError("REFUSED", problem, ctx.url);
    const list = injectedCss.get(tabId) || [];
    if (list.length >= 20) throw new ZbError("REFUSED", "20 stylesheets already added; use clear:true first", ctx.url);
    await browser.scripting.insertCSS({ target: { tabId, frameIds: [0] }, css: a.css });
    list.push(a.css);
    injectedCss.set(tabId, list);
    try { await resolveArmedTab(tabId); } catch (e) { await clearCss(tabId); throw e; }  // navigated away meanwhile
    return { tabId, active: list.length };
  },
  async scroll(a, ctx) {
    const r = await inject(ctx, zbScroll, withoutTab(a));
    return { scrollX: clamp(r.scrollX, -1000000, 100000000), scrollY: clamp(r.scrollY, -1000000, 100000000),
      target: r.target === "element" ? "element" : "page" };
  },
  async read_tree(a, ctx) {
    const max = a.maxChars || 50000;
    const r = await inject(ctx, zbPage, { op: "tree", filter: a.filter || "all", depth: a.depth || 30, ref: a.ref, maxChars: max });
    return { title: str(r.title, 200), url: str(ctx.url, 2048), tree: str(r.tree, max), truncated: !!r.truncated,
      nodes: Math.min(int(r.nodes), 1000000) };
  },
  async find(a, ctx) {
    const r = await inject(ctx, zbPage, { op: "find", query: a.query });
    const matches = (Array.isArray(r.matches) ? r.matches : []).slice(0, 20).filter((m) => m && REF.test(m.ref))
      .map((m) => ({ ref: m.ref, role: str(m.role, 40), name: str(m.name, 200), x: clamp(m.x, -1000000, 1000000),
        y: clamp(m.y, -1000000, 100000000), inView: !!m.inView }));
    return { matches, more: !!r.more };
  },
  async hover(a, ctx) {
    const r = await inject(ctx, zbPage, { op: "hover", ...withoutTab(a) });
    return { tag: str(r.tag, 40), text: str(r.text, 200) };
  },
  async drag(a, ctx) {
    const r = await inject(ctx, zbPage, { op: "drag", from: a.from, to: a.to });
    await cue(ctx, { kind: "hover", ...a.to });
    return { tag: str(r.tag, 40), text: str(r.text, 200), html5: !!r.html5 };
  },
  async key(a, ctx) {
    const r = await inject(ctx, zbPage, { op: "key", ...withoutTab(a) });
    return { tag: str(r.tag, 40), pressed: Math.min(int(r.pressed), 100000) };
  },
  async form_input(a, ctx) {
    const r = await inject(ctx, zbPage, { op: "form", ...withoutTab(a) });
    return { tag: str(r.tag, 40), kind: ["select", "checkbox", "radio", "text", "editable"].includes(r.kind) ? r.kind : "text",
      applied: !!r.applied };
  },
  async wait_for(a, ctx) {
    const seconds = a.seconds === undefined ? 3 : a.seconds;
    if (a.selector === undefined && a.text === undefined) {
      if (seconds > 0) await new Promise((r) => setTimeout(r, seconds * 1000));
      await resolveArmedTab(ctx.tab.id);
      return { met: true, waited: seconds };
    }
    const r = await inject(ctx, zbPage, { op: "wait", selector: a.selector, text: a.text, gone: !!a.gone, seconds }, seconds * 1000 + 3000);
    return { met: !!r.met, waited: clamp(r.waited, 0, 60) };
  },
  async resize_window(a, ctx) {
    const win = await browser.windows.get(ctx.tab.windowId);
    if (win && win.state && win.state !== "normal") await browser.windows.update(ctx.tab.windowId, { state: "normal" });
    const w = await browser.windows.update(ctx.tab.windowId, { width: a.width, height: a.height });
    return { width: Math.min(int(w && w.width), 100000), height: Math.min(int(w && w.height), 100000) };
  },
  async console_messages(a, ctx) {
    consoleTabs.add(ctx.tab.id);
    const r = await inject(ctx, zbPage, { op: "consoleRead", filter: a.filter || "", onlyErrors: !!a.onlyErrors, clear: !!a.clear, limit: a.limit || 100 });
    const levels = ["log", "info", "warn", "error", "debug", "exception"];
    const messages = (Array.isArray(r.messages) ? r.messages : []).slice(-500).filter((m) => m && levels.includes(m.level))
      .map((m) => ({ level: m.level, text: str(m.text, 2000), time: clamp(m.time, 0, 1e15) }));
    const capturing = !!r.capturing;
    return { messages, capturing, note: capturing
      ? "Captured since the first console_messages call for this tab, and from each later page load (load-time messages may be missed)."
      : "Console capture is not available on this page." };
  },
  async network_requests(a, ctx) {
    const rec = net.get(ctx.tab.id);
    let list = rec ? rec.list.filter((e) => zbInScope(ctx.scope, e.doc)) : [];
    if (a.urlPattern) list = list.filter((e) => e.url.includes(a.urlPattern));
    const requests = list.slice(-(a.limit || 100)).map(({ doc, ...e }) => e);
    if (a.clear && rec) rec.list = [];
    return { requests };
  },
  async upload_chunk(a) {
    if (!session && armed.size === 0) throw new ZbError("NOT_ARMED", "Claude is off: no tab is armed");
    const now = Date.now();
    for (const [id, u] of uploads) if (now - u.t > 120000) uploads.delete(id);
    let u = uploads.get(a.uploadId);
    if (!u) uploads.set(a.uploadId, u = { parts: new Array(a.total).fill(null), total: a.total, name: a.name, mimeType: a.mimeType, got: 0, t: now });
    if (u.total !== a.total || u.name !== a.name || u.mimeType !== a.mimeType || a.index >= a.total) {
      uploads.delete(a.uploadId);
      throw new ZbError("INVALID", "inconsistent upload piece");
    }
    let held = 0;
    for (const x of uploads.values()) for (const p of x.parts) held += p ? p.length : 0;
    if (held + a.data.length > UPLOAD_HOLD) { uploads.delete(a.uploadId); throw new ZbError("REFUSED", "uploads are limited to 10 MB at a time"); }
    if (u.parts[a.index] === null) u.got++;
    u.parts[a.index] = a.data;
    u.t = now;
    return { received: u.got };
  },
  async file_upload(a, ctx) {
    const files = [];
    for (const id of a.uploads) {
      const u = uploads.get(id);
      if (!u || u.got !== u.total) throw new ZbError("INVALID", "upload incomplete or expired; try again", ctx.url);
      files.push({ name: u.name, mimeType: u.mimeType, data: u.parts.join("") });
    }
    for (const id of a.uploads) uploads.delete(id);
    const { tabId, uploads: _ids, ...target } = a;
    const r = await inject(ctx, zbPage, { op: "upload", ...target, files }, 12000);
    return { files: Math.min(int(r.files), 10), bytes: Math.min(int(r.bytes), 100000000), target: r.target === "drop" ? "drop" : "input" };
  },
};

// Activity cue per tool: a cursor/highlight on the target, a glow only, or nothing.
const CUES = { click: "click", hover: "hover", drag: "hover", type: "type", key: "type", form_input: "type", file_upload: "type",
  scroll: "scroll", read_page: "glow", read_tree: "glow", find: "glow", inject_css: "glow", wait_for: "glow" };

// validate -> resolve tab -> check armed -> check scope -> perform -> validate result -> return
async function handleRequest(msg) {
  await settingsReady;
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
    const kind = ctx && CUES[msg.tool];
    if (kind) {
      const a = msg.tool === "drag" ? msg.args.from : msg.args;
      await cue(ctx, kind === "glow" ? { kind } : { kind, selector: a.selector, ref: a.ref, x: a.x, y: a.y }, kind !== "glow");
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
  const p = port;
  setTimeout(() => { if (port === p && hostStatus !== "connected") { hostStatus = "connected"; setGlobalBadge(); } }, 3000);
  port.onMessage.addListener(async (msg) => {
    const p = port;
    const resp = await handleRequest(msg);
    if (p === port && p) p.postMessage(resp);
  });
  port.onDisconnect.addListener((dp) => {
    const why = String((dp && dp.error && dp.error.message) || "");
    hostStatus = /no such native application|not found|manifest/i.test(why) ? "missing" : "disconnected";
    setGlobalBadge();
    port = null;
    if (Date.now() - connectedAt > 10000) backoffMs = 1000;
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  });
}

connect();
