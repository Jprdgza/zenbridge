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
  return zbInScope(scope, zbOriginOf(url)) ? { text: "ON", color: "#d70022" } : { text: "!!", color: "#ffa436" };
}

// Typing is refused into password, one-time-code and credit-card fields (also when a
// password field was toggled to type=text but kept its autocomplete or name).
const ZB_SENSITIVE_AC = ["current-password", "new-password", "one-time-code"];
const ZB_SENSITIVE_NAME = /pass(word|wd|code)|pwd|otp|cvc|cvv|card.?num/i;
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

// Scope given to a newly armed tab.
function zbNewScope(origin, config) {
  return new Set(config.goAnywhere ? ["*"] : [origin, ...config.allowlist]);
}

// tab_open may only target the allowlist or an origin some armed tab already has in scope.
function zbOpenAllowed(origin, allowlist, scopes) {
  if (!origin || ZB_REFUSED_HOSTS.includes(new URL(origin).hostname)) return false;
  if (zbInScope(allowlist, origin)) return true;
  for (const s of scopes) if (zbInScope(s, origin)) return true;
  return false;
}

if (typeof module !== "undefined") {
  module.exports = { zbOriginOf, zbArmable, zbEntryMatches, zbInScope, zbHostPattern, zbGlobMatch,
    zbArmDecision, zbBadge, zbIsSensitiveField, zbOpenAllowed, zbNewScope, zbCssProblem };
}
