"use strict";
// Browser-free logic, importable by node tests. No browser.* calls here.

const ZB_REFUSED_HOSTS = ["addons.mozilla.org", "addons.allizom.org", "addons-dev.allizom.org"];

// "https://example.com:8443" for http(s) URLs; null for anything else or garbage.
function zbOriginOf(url) {
  if (typeof url !== "string") return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin;
}

// Only http(s) pages outside the add-on store may be armed.
function zbArmable(url) {
  const origin = zbOriginOf(url);
  if (!origin) return false;
  return !ZB_REFUSED_HOSTS.includes(new URL(url).hostname);
}

// Scope entries are exact origins, or "scheme://host:*" for any port.
function zbEntryMatches(entry, origin) {
  if (entry === "*") return !ZB_REFUSED_HOSTS.includes(new URL(origin).hostname);  // go-anywhere: any http(s) origin but the add-on store
  if (entry === origin) return true;
  if (!entry.endsWith(":*")) return false;
  const base = entry.slice(0, -2);
  return origin === base || (origin.startsWith(base + ":") && /^\d+$/.test(origin.slice(base.length + 1)));
}

function zbInScope(scope, origin) {
  if (!origin || !scope) return false;
  for (const entry of scope) if (zbEntryMatches(entry, origin)) return true;
  return false;
}

// Host permission pattern for a scope entry or origin (match patterns ignore ports).
function zbHostPattern(entry) {
  const u = new URL(entry.endsWith(":*") ? entry.slice(0, -2) : entry);
  return `${u.protocol}//${u.hostname}/*`;
}

// Simple glob: "*" matches any run of characters; everything else is literal.
// Greedy segment matching, linear time (a regex here would allow catastrophic backtracking).
function zbGlobMatch(glob, s) {
  const parts = glob.split("*");
  if (parts.length === 1) return glob === s;
  const first = parts[0], last = parts[parts.length - 1];
  if (!s.startsWith(first) || s.length < first.length + last.length || !s.endsWith(last)) return false;
  let pos = first.length;
  const end = s.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = s.indexOf(parts[i], pos);
    if (at < 0 || at + parts[i].length > end) return false;
    pos = at + parts[i].length;
  }
  return true;
}

// Toolbar-click state machine. scope: Set or undefined. origin: armable origin or null.
//   unarmed + armable -> "arm"; unarmed + not armable -> "refuse";
//   armed -> "disarm", except Shift+click on an out-of-scope armed tab -> "widen".
// A plain click never grants Claude a new origin.
function zbArmDecision(scope, origin, shift) {
  if (!scope) return origin ? "arm" : "refuse";
  if (shift && origin && !zbInScope(scope, origin)) return "widen";
  return "disarm";
}

function zbBadge(scope, url) {
  if (!scope) return { text: "", color: null };
  // Catppuccin Mocha red / yellow
  return zbInScope(scope, zbOriginOf(url)) ? { text: "ON", color: "#f38ba8" } : { text: "!!", color: "#f9e2af" };
}

// Typing is refused into password, one-time-code and credit-card fields (also when a
// password field was toggled to type=text but kept its autocomplete or name).
const ZB_SENSITIVE_AC = ["current-password", "new-password", "one-time-code"];
const ZB_SENSITIVE_NAME = /pass(word|wd|code)|pwd|otp|cvc|cvv|card.?num|api.?key|secret|token|(?:^|[^a-z])ssn(?:[^a-z]|$)|social.?sec/i;
function zbIsSensitiveField(tag, type, autocomplete, nameAndId) {
  if (String(tag).toLowerCase() === "input" && String(type).toLowerCase() === "password") return true;
  const tokens = String(autocomplete || "").toLowerCase().split(/\s+/);
  if (tokens.some((t) => t.startsWith("cc-") || ZB_SENSITIVE_AC.includes(t))) return true;
  return ZB_SENSITIVE_NAME.test(String(nameAndId || ""));
}

// inject_css may restyle a page but never make it load anything: url(), @import and friends
// could leak page data to a server (attribute-selector exfiltration). Backslash escapes are
// refused so those words can't be disguised (u\72l(...)).
const ZB_CSS_FETCH = /url\s*\(|@import|image-set\s*\(|\bimage\s*\(|cross-fade\s*\(|-moz-element|\bsrc\s*\(/i;
function zbCssProblem(css) {
  if (typeof css !== "string" || css.length === 0) return "css must be a non-empty string";
  if (css.includes("\\")) return "backslash escapes are not allowed in injected CSS";
  if (ZB_CSS_FETCH.test(css)) return "injected CSS may not load resources (url(), @import, image-set(), ...)";
  return null;
}

// Settings come from browser storage, so treat them as untrusted: every key is type-checked
// against the defaults and anything odd falls back to the default value.
const ZB_ALLOW_ENTRY = /^https?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\*|:\d{1,5})?$/i;
function zbSanitizeSettings(raw, defaults, tunable) {
  const out = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const k of tunable) {
    const d = defaults[k], v = Object.hasOwn(src, k) ? src[k] : undefined;
    if (typeof d === "boolean") out[k] = typeof v === "boolean" ? v : d;
    else if (k === "cursorDelayMs") out[k] = Number.isInteger(v) && v >= 0 && v <= 1000 ? v : d;
    else if (k === "allowlist") {
      // Keep the valid entries, drop the rest (one typo shouldn't wipe the whole list).
      out[k] = Array.isArray(v)
        ? v.filter((e) => typeof e === "string" && e.length <= 200 && ZB_ALLOW_ENTRY.test(e)).slice(0, 20).map((e) => e.toLowerCase())
        : [...d];
    }
  }
  return out;
}

// Scope given to a newly armed tab. Only a tab on a local (allowlisted) address gets the rest of the
// allowlist: a public page must not be able to steer Claude into your local services (ZB-2).
// Shift+click on the badge still adds an origin to one tab by hand.
function zbNewScope(origin, config) {
  if (config.goAnywhere) return new Set(["*"]);
  return new Set(zbInScope(config.allowlist, origin) ? [origin, ...config.allowlist] : [origin]);
}

// tab_open may only target `openable` (the allowlist while Claude is on, ["*"] in go-anywhere mode, else
// nothing) or an origin some armed tab already has in scope.
function zbOpenAllowed(origin, openable, scopes) {
  if (!origin || ZB_REFUSED_HOSTS.includes(new URL(origin).hostname)) return false;
  if (zbInScope(openable, origin)) return true;
  for (const s of scopes) if (zbInScope(s, origin)) return true;
  return false;
}

// Local addresses: the allowlist, plus names that always mean this computer.
// ZB-12: is this IP address (v4 or v6, brackets optional) loopback, private, link-local, shared (CGNAT),
// unspecified or otherwise not on the public internet? IPv6 forms that carry an IPv4 address (mapped,
// compatible, NAT64) are judged by that address. Anything that doesn't parse is not an address: false.
function zbIsLocalAddress(ip) {
  let s = String(ip || "").trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const pct = s.indexOf("%");  // zone id (fe80::1%en0)
  if (pct >= 0) s = s.slice(0, pct);
  const v4 = (t) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
    if (!m) return null;
    const b = m.slice(1).map(Number);
    return b.every((x) => x <= 255) ? b : null;
  };
  const local4 = ([a, b]) => a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  const four = v4(s);
  if (four) return local4(four);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return false;
  // Expand to 8 groups of 16 bits.
  let tail = [];
  const lastColon = s.lastIndexOf(":");
  const dotted = v4(s.slice(lastColon + 1));
  if (dotted) { tail = [dotted[0] * 256 + dotted[1], dotted[2] * 256 + dotted[3]]; s = s.slice(0, lastColon + 1) + "0:0"; }
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const part = (x) => (x ? x.split(":") : []);
  const head = part(halves[0]), rest = halves.length === 2 ? part(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return false;
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 2 && fill < 1 && head.length + rest.length === 8)) return false;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return false;
  const g = groups.map((x) => parseInt(x, 16));
  if (tail.length) { g[6] = tail[0]; g[7] = tail[1]; }
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (zero(0, 8)) return true;                                     // ::
  if (zero(0, 7) && g[7] === 1) return true;                       // ::1
  if (zero(0, 5) && g[5] === 0xffff) return local4(embedded);      // ::ffff:a.b.c.d (mapped)
  if (zero(0, 6)) return local4(embedded);                         // ::a.b.c.d (compatible, deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return local4(embedded);  // 64:ff9b::/96 (NAT64)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                     // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;  // fe80::/10 link-local, fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                     // multicast
  return false;
}

// Names that only mean something on your own machine or network.
const ZB_LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".home", ".corp", ".intranet", ".private"];

// Local = in your allowlist, or a local name or address (by its text: zbIsLocalAddress for IP literals, the
// suffixes above, and single-label names like http://router/). Names that look public but point at a local
// address are caught by DNS (background.js, before tab_open and navigate) and by the address each request
// actually connected to (onHeadersReceived), which also stops DNS rebinding.
function zbIsLocal(origin, allowlist) {
  if (!origin) return false;
  if (zbInScope(allowlist, origin)) return true;
  let h;
  try { h = new URL(origin).hostname.toLowerCase(); } catch (e) { return false; }
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || ZB_LOCAL_SUFFIXES.some((x) => h.endsWith(x))) return true;
  if (h.startsWith("[") || /^[\d.]+$/.test(h)) return zbIsLocalAddress(h);
  return !h.includes(".");
}

// Moving Claude between public sites and local addresses is your decision, not the model's (ZB-8).
// state: touched = the kinds of site ("local"/"public") Claude has seen this session; handArmedLocal = you armed
// a local tab by hand; approved = origins you already allowed (zbCrossingKey). A local origin needs your OK once Claude has
// seen a public site, or if you never armed a local tab yourself; a public one, once Claude has seen a local one.
// An approval covers the origin as the kind of site it was when you allowed it: if a public name later turns
// out to point at a local address (DNS rebinding), that is a new crossing.
const zbCrossingKey = (origin, isLocal) => `${isLocal ? "local" : "public"} ${origin}`;
function zbCrossingNeedsOk(origin, isLocal, state) {
  if (state.approved.has(zbCrossingKey(origin, isLocal))) return false;
  return isLocal ? state.touched.has("public") || !state.handArmedLocal : state.touched.has("local");
}

// The settings page saves only what differs from the defaults, so a safer default (like alwaysOn turning off
// in 1.5.1) still reaches people who saved some other setting (ZB-9).
function zbSettingsDiff(s, defaults, tunable) {
  const out = {};
  for (const k of tunable) if (Object.hasOwn(s, k) && JSON.stringify(s[k]) !== JSON.stringify(defaults[k])) out[k] = s[k];
  return out;
}

// ZB-14 / R-041: a per-session cap on tool calls. times = when recent calls were made (oldest first); returns
// the times still inside the window plus this call, and whether that is more than the cap.
function zbRateCap(times, now, cap, windowMs) {
  const kept = times.filter((t) => now - t < windowMs && t <= now);
  kept.push(now);
  return { times: kept, over: kept.length > cap };
}

// "1.5.1" < "1.5.2". Missing or non-numeric parts count as 0.
function zbVersionLess(a, b) {
  const parts = (v) => String(v || "").split(".").map((x) => parseInt(x, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

// network_requests shows URLs a page loaded, and the host logs URLs: strip credentials that often ride in
// them. Masked: user:password, query params with a secret-sounding name, and any path segment, query value
// or fragment that looks like a token (ZB-5). common/zbcore.py:redact_url applies the same rules.
const ZB_SECRET_PARAM = /token|key|secret|auth|sig|session|passw|pwd|code|credential|jwt|bearer|otp|ticket|nonce/i;
function zbSecretValue(v) {
  if (typeof v !== "string" || v.length < 10) return false;
  if (/^eyJ[A-Za-z0-9_-]{6,}/.test(v)) return true;  // JWT
  if (v.length < 20) return false;
  if (/^[0-9a-f-]+$/i.test(v) && v.replace(/-/g, "").length >= 16 && /[0-9]/.test(v)) return true;  // hex, UUID
  if (!/^[A-Za-z0-9_\-+/=.~%]+$/.test(v) || !/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false;
  return (v.match(/[A-Za-z0-9]+/g) || []).some((run) => run.length >= 16);  // base64 / random; not word slugs
}
function zbDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; }
}
function zbRedactUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.username = "";
  u.password = "";
  u.pathname = u.pathname.split("/").map((seg) => (zbSecretValue(zbDecode(seg)) ? "REDACTED" : seg)).join("/");
  for (const k of [...new Set(u.searchParams.keys())]) {
    if (ZB_SECRET_PARAM.test(k) || u.searchParams.getAll(k).some(zbSecretValue)) u.searchParams.set(k, "REDACTED");
  }
  const frag = u.hash.slice(1);
  if (frag && (ZB_SECRET_PARAM.test(frag) || frag.split(/[&=/?]/).some((p) => zbSecretValue(zbDecode(p))))) u.hash = "REDACTED";
  return u.href.slice(0, 2048);
}

if (typeof module !== "undefined") {
  module.exports = { zbOriginOf, zbArmable, zbEntryMatches, zbInScope, zbHostPattern, zbGlobMatch,
    zbArmDecision, zbBadge, zbIsSensitiveField, zbOpenAllowed, zbNewScope, zbCssProblem, zbSanitizeSettings, zbRedactUrl, zbSecretValue,
    zbIsLocal, zbIsLocalAddress, zbCrossingKey, zbCrossingNeedsOk, zbSettingsDiff, zbVersionLess, zbRateCap };
}
