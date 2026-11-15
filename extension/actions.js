"use strict";
// Fixed page functions injected with scripting.executeScript({func}).
// Each one is serialized on its own: it must be self-contained (no outer
// references). Each re-checks the page origin first (navigation race), and
// returns {ok:false, code, message} or {ok:true, ...}. Results are untrusted.

function zbPageMetrics(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  const de = document.documentElement;
  // Count visible frames/embeds whose content is not our origin: captureTab renders them,
  // so a scoped page could otherwise show Claude a framed logged-in third-party site.
  let foreignFrames = 0;
  const visible = (r) => r.width >= 2 && r.height >= 2 &&
    (a.fullPage || (r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth));
  const walk = (doc, depth) => {
    for (const f of doc.querySelectorAll("iframe, frame, embed, object")) {
      if (!visible(f.getBoundingClientRect())) continue;
      let origin = null;
      try { origin = f.contentWindow ? f.contentWindow.location.origin : null; } catch (e) { origin = null; }
      if (origin !== expectedOrigin || !f.contentDocument) { foreignFrames++; continue; }
      if (depth < 3) walk(f.contentDocument, depth + 1);
    }
  };
  walk(document, 0);
  return {
    ok: true, foreignFrames, scrollX: window.scrollX, scrollY: window.scrollY,
    vw: window.innerWidth, vh: window.innerHeight,
    dw: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0, window.innerWidth),
    dh: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, window.innerHeight),
  };
}

function zbClick(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  let el, cx, cy;
  if (a.selector !== undefined) {
    try { el = document.querySelector(a.selector); } catch (e) { return { ok: false, code: "INVALID", message: "invalid CSS selector" }; }
    if (!el) return { ok: false, code: "INVALID", message: "no element matches selector" };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2;
  } else {
    if (a.x > window.innerWidth || a.y > window.innerHeight) return { ok: false, code: "INVALID", message: "point is outside the viewport" };
    el = document.elementFromPoint(a.x, a.y);
    if (!el) return { ok: false, code: "INVALID", message: "no element at that point" };
    cx = a.x; cy = a.y;
  }
  const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, view: window };
  const ptr = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...ptr, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...ptr, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  // Short label only (aria-label, else innerText): never form values, not a page-text reader.
  const text = String(el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();
  return { ok: true, tag: String(el.tagName).toLowerCase().slice(0, 40), text: text.slice(0, 80) };
}

function zbFieldInfo(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  let el;
  try { el = a.selector !== undefined ? document.querySelector(a.selector) : document.activeElement; } catch (e) { el = null; }
  if (!el) return { ok: true, found: false };
  return { ok: true, found: true, tag: String(el.tagName), type: String(el.getAttribute("type") || ""),
    autocomplete: String(el.getAttribute("autocomplete") || ""),
    nameAndId: `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`.slice(0, 500) };
}

function zbType(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  let el;
  try { el = a.selector !== undefined ? document.querySelector(a.selector) : document.activeElement; } catch (e) {
    return { ok: false, code: "INVALID", message: "invalid CSS selector" };
  }
  if (!el || el === document.body || el === document.documentElement) return { ok: false, code: "INVALID", message: "no target: give a selector or focus an element first" };
  const tag = String(el.tagName).toLowerCase();
  // Same rule as zbIsSensitiveField in logic.js, repeated because injected code cannot import.
  const acTokens = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
  const nameAndId = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`;
  if ((tag === "input" && String(el.type).toLowerCase() === "password") ||
      acTokens.some((t) => t.startsWith("cc-") || ["current-password", "new-password", "one-time-code"].includes(t)) ||
      /pass(word|wd|code)|pwd|otp|cvc|cvv|card.?num/i.test(nameAndId)) {
    return { ok: false, code: "REFUSED", message: "refusing to type into a password, one-time-code or credit-card field" };
  }
  const isField = tag === "input" || tag === "textarea";
  if (!isField && !el.isContentEditable) return { ok: false, code: "INVALID", message: "target is not editable" };
  const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setValue = (v) => {  // native setter + bubbling events: works with React-controlled inputs
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (a.selector !== undefined) el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (a.clear) {
    if (isField) { el.select(); if (!document.execCommand("delete") || el.value !== "") setValue(""); }
    else { window.getSelection().selectAllChildren(el); document.execCommand("delete"); }
  }
  let method = "none";
  if (a.text) {
    const snapshot = () => (isField ? el.value : el.textContent);  // compared only, never returned
    const before = snapshot();
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, a.text); } catch (e) { inserted = false; }
    if (inserted && snapshot() !== before) method = "insertText";
    else if (isField) { setValue(el.value + a.text); method = "setter"; }
    else return { ok: false, code: "INTERNAL", message: "could not insert text into this editor" };
  }
  if (a.key) {
    const opts = { key: a.key, code: a.key, bubbles: true, cancelable: true, composed: true };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", opts));
    if (go && a.key === "Backspace") document.execCommand("delete");
    if (go && a.key === "Enter" && tag === "input" && el.form) el.form.requestSubmit();
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }
  return { ok: true, tag: tag.slice(0, 40), typed: a.text.length, method };
}

function zbReadText(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // innerText: visible text only. Input/textarea current values are not part of it.
  const raw = String(document.body ? document.body.innerText : "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const links = [];
  for (const el of document.querySelectorAll("a[href]")) {
    if (links.length >= 100) break;
    const text = String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (text && /^https?:/.test(el.href)) links.push({ text: text.slice(0, 120), href: String(el.href).slice(0, 2048) });
  }
  return { ok: true, title: String(document.title), text: raw.slice(0, a.maxChars), truncated: raw.length > a.maxChars, links };
}

// Visual activity cue (Catppuccin Mocha mauve): a glow around the viewport, a "Claude is working"
// pill, a cursor that glides to the target, and a highlight box around the element being used.
// Purely visual: pointer-events none, closed shadow root, CSSOM styles only (no innerHTML).
// a = {hide:true} (before screenshots) | {kind:"glow"|"click"|"type"|"scroll", selector?, x?, y?}
function zbShow(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: true };
  const ACCENT = "#cba6f7", CRUST = "#11111b", RGB = "203,166,247";  // Catppuccin Mocha mauve / crust
  let o = globalThis.__zbOverlay;
  if (!o || !o.host.isConnected) {
    const stale = document.getElementById("zenbridge-overlay");
    if (stale) stale.remove();
    const host = document.createElement("div");
    host.id = "zenbridge-overlay";
    const root = host.attachShadow({ mode: "closed" });
    const layer = (css) => {
      const d = document.createElement("div");
      const base = { position: "fixed", "pointer-events": "none", "z-index": "2147483647", opacity: "0", transition: "opacity 250ms" };
      for (const [k, v] of Object.entries({ ...base, ...css })) d.style.setProperty(k, v);
      root.appendChild(d);
      return d;
    };
    const glow = layer({ inset: "0", "box-shadow": `inset 0 0 0 3px ${ACCENT}, inset 0 0 36px 10px rgba(${RGB},0.45)` });
    const pill = layer({ top: "12px", left: "50%", transform: "translateX(-50%)", background: ACCENT, color: CRUST,
      padding: "6px 12px", "border-radius": "999px", font: "600 12px/1.2 -apple-system, BlinkMacSystemFont, sans-serif",
      "box-shadow": "0 2px 10px rgba(0,0,0,0.3)", "white-space": "nowrap" });
    pill.textContent = "Claude is working in this tab";
    const box = layer({ border: `2px solid ${ACCENT}`, "border-radius": "6px",
      "box-shadow": `0 0 0 4px rgba(${RGB},0.25), 0 0 18px rgba(${RGB},0.7)`,
      transition: "opacity 250ms, left 150ms, top 150ms, width 150ms, height 150ms" });
    const cursor = layer({ left: `${window.innerWidth / 2}px`, top: `${window.innerHeight / 2}px`, width: "24px", height: "24px",
      transition: "opacity 250ms, left 180ms cubic-bezier(.2,.8,.2,1), top 180ms cubic-bezier(.2,.8,.2,1)",
      filter: "drop-shadow(0 1px 2px rgba(0,0,0,.45))" });
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const path = document.createElementNS(NS, "path");
    for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", "24"], ["height", "24"]]) svg.setAttribute(k, v);
    for (const [k, v] of [["d", "M3 2l7 19 2.6-7.4L20 11z"], ["fill", ACCENT], ["stroke", CRUST], ["stroke-width", "1.5"], ["stroke-linejoin", "round"]]) path.setAttribute(k, v);
    svg.appendChild(path);
    cursor.appendChild(svg);
    document.documentElement.appendChild(host);
    o = globalThis.__zbOverlay = { host, root, glow, pill, box, cursor, timer: 0 };
  }
  if (a.hide) { o.host.style.setProperty("display", "none", "important"); return { ok: true }; }
  o.host.style.setProperty("display", "block", "important");
  const show = (el, on) => el.style.setProperty("opacity", on ? "1" : "0");
  show(o.glow, true);
  show(o.pill, true);
  let el = null, x, y;
  if (a.kind === "click" || a.kind === "type" || a.kind === "scroll") {
    if (a.selector !== undefined) {
      try { el = document.querySelector(a.selector); } catch (e) { el = null; }
      if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } else if (a.kind === "click") el = document.elementFromPoint(a.x, a.y);
    else if (a.kind === "type") el = document.activeElement;
    if (el === document.body || el === document.documentElement) el = null;
    const r = el && el.getBoundingClientRect();
    if (a.kind === "click" && a.selector === undefined) { x = a.x; y = a.y; }
    else if (r) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
    else { x = window.innerWidth / 2; y = window.innerHeight / 2; }
    if (r) {
      for (const [k, v] of [["left", r.left - 4], ["top", r.top - 4], ["width", r.width + 8], ["height", r.height + 8]]) o.box.style.setProperty(k, `${v}px`);
    }
    show(o.box, !!r);
    o.cursor.style.setProperty("left", `${x - 3}px`);  // the arrow's tip is at (3, 2)
    o.cursor.style.setProperty("top", `${y - 2}px`);
    show(o.cursor, true);
    if (a.kind === "click") {
      setTimeout(() => {
        const ring = document.createElement("div");
        const css = { position: "fixed", left: `${x - 14}px`, top: `${y - 14}px`, width: "28px", height: "28px",
          border: `3px solid ${ACCENT}`, "border-radius": "50%", "pointer-events": "none", "box-sizing": "border-box" };
        for (const [k, v] of Object.entries(css)) ring.style.setProperty(k, v);
        o.root.appendChild(ring);
        ring.animate([{ transform: "scale(0.4)", opacity: 1 }, { transform: "scale(1.8)", opacity: 0 }], { duration: 400, easing: "ease-out" })
          .onfinish = () => ring.remove();
      }, 180);
    }
  }
  clearTimeout(o.timer);
  o.timer = setTimeout(() => { for (const e of [o.glow, o.pill, o.box, o.cursor]) show(e, false); }, 5000);
  return { ok: true };
}

function zbScroll(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  if (a.selector !== undefined) {
    let el;
    try { el = document.querySelector(a.selector); } catch (e) { return { ok: false, code: "INVALID", message: "invalid CSS selector" }; }
    if (!el) return { ok: false, code: "INVALID", message: "no element matches selector" };
    el.scrollIntoView({ block: "center", behavior: "instant" });
  } else {
    window.scrollBy({ left: a.dx || 0, top: a.dy || 0, behavior: "instant" });
  }
  return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY };
}

if (typeof module !== "undefined") module.exports = { zbPageMetrics, zbClick, zbFieldInfo, zbType, zbReadText, zbShow, zbScroll };
