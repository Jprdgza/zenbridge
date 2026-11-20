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

function zbClick(a, expectedOrigin, guard) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // ZB-11: with activity cues on, check the overlay inside this same task, right before acting and right after.
  const G = guard ? globalThis.__zbOverlay : null;
  if (guard) {
    const no = G && G.before ? G.before() : { ok: false, code: "REFUSED", message: "zenbridge's activity overlay is missing from this page, so Claude didn't act" };
    if (no) return no;
  }
  const res = (() => {
    const byRef = (r) => { const reg = globalThis.__zbRefs, w = reg && reg.map.get(r), e = w && w.deref(); return e && e.isConnected ? e : null; };
    let el, cx, cy;
    if (a.selector !== undefined || a.ref !== undefined) {
      if (a.ref !== undefined) {
        el = byRef(a.ref);
        if (!el) return { ok: false, code: "INVALID", message: "ref not found (the page changed?): call read_tree or find again" };
      } else {
        try { el = document.querySelector(a.selector); } catch (e) { return { ok: false, code: "INVALID", message: "invalid CSS selector" }; }
        if (!el) return { ok: false, code: "INVALID", message: "no element matches selector" };
      }
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    } else {
      if (a.x > window.innerWidth || a.y > window.innerHeight) return { ok: false, code: "INVALID", message: "point is outside the viewport" };
      el = document.elementFromPoint(a.x, a.y);
      if (!el) return { ok: false, code: "INVALID", message: "no element at that point" };
      cx = a.x; cy = a.y;
    }
    const button = a.button === "right" ? 2 : a.button === "middle" ? 1 : 0;
    const mods = new Set(a.modifiers || []);
    const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button, view: window,
      ctrlKey: mods.has("ctrl"), shiftKey: mods.has("shift"), altKey: mods.has("alt"), metaKey: mods.has("meta") };
    const ptr = { pointerId: 1, pointerType: "mouse", isPrimary: true };
    const down = button === 2 ? 2 : button === 1 ? 4 : 1;
    const count = a.clickCount || 1;
    for (let i = 1; i <= count; i++) {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...ptr, buttons: down, detail: i }));
      el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: down, detail: i }));
      if (i === 1 && button === 0 && typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...ptr, buttons: 0, detail: i }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0, detail: i }));
      if (button === 0) el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: i }));
      else el.dispatchEvent(new MouseEvent("auxclick", { ...base, buttons: 0, detail: i }));
      if (button === 2) el.dispatchEvent(new MouseEvent("contextmenu", { ...base, buttons: 0, detail: i }));
    }
    if (button === 0 && count >= 2) el.dispatchEvent(new MouseEvent("dblclick", { ...base, buttons: 0, detail: 2 }));
    // Double/triple click select text the way a real one would (word selection is approximated by the whole field).
    if (button === 0 && count >= 2) {
      if ((el.localName === "input" || el.localName === "textarea") && typeof el.select === "function") el.select();
      else if (count === 3) window.getSelection().selectAllChildren(el);
    }
    // Short label only (aria-label, else innerText): never form values, not a page-text reader.
    const text = String(el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();
    return { ok: true, tag: String(el.tagName).toLowerCase().slice(0, 40), text: text.slice(0, 80) };
  })();
  return guard ? G.after(res) : res;
}

function zbFieldInfo(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  const byRef = (r) => { const reg = globalThis.__zbRefs, w = reg && reg.map.get(r), e = w && w.deref(); return e && e.isConnected ? e : null; };
  let el;
  try { el = a.ref !== undefined ? byRef(a.ref) : a.selector !== undefined ? document.querySelector(a.selector) : document.activeElement; } catch (e) { el = null; }
  if (!el) return { ok: true, found: false };
  return { ok: true, found: true, tag: String(el.tagName), type: String(el.getAttribute("type") || ""),
    autocomplete: String(el.getAttribute("autocomplete") || ""),
    nameAndId: `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`.slice(0, 500) };
}

function zbType(a, expectedOrigin, guard) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // ZB-11: with activity cues on, check the overlay inside this same task, right before acting and right after.
  const G = guard ? globalThis.__zbOverlay : null;
  if (guard) {
    const no = G && G.before ? G.before() : { ok: false, code: "REFUSED", message: "zenbridge's activity overlay is missing from this page, so Claude didn't act" };
    if (no) return no;
  }
  const res = (() => {
    const byRef = (r) => { const reg = globalThis.__zbRefs, w = reg && reg.map.get(r), e = w && w.deref(); return e && e.isConnected ? e : null; };
    let el;
    try { el = a.ref !== undefined ? byRef(a.ref) : a.selector !== undefined ? document.querySelector(a.selector) : document.activeElement; } catch (e) {
      return { ok: false, code: "INVALID", message: "invalid CSS selector" };
    }
    if (a.ref !== undefined && !el) return { ok: false, code: "INVALID", message: "ref not found (the page changed?): call read_tree or find again" };
    if (!el || el === document.body || el === document.documentElement) return { ok: false, code: "INVALID", message: "no target: give a selector or focus an element first" };
    const tag = String(el.tagName).toLowerCase();
    // Same rule as zbIsSensitiveField in logic.js, repeated because injected code cannot import.
    const acTokens = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    const nameAndId = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`;
    if ((tag === "input" && String(el.type).toLowerCase() === "password") ||
        acTokens.some((t) => t.startsWith("cc-") || ["current-password", "new-password", "one-time-code"].includes(t)) ||
        /pass(word|wd|code)|pwd|otp|cvc|cvv|card.?num|api.?key|secret|token|(?:^|[^a-z])ssn(?:[^a-z]|$)|social.?sec/i.test(nameAndId)) {
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
    if (a.selector !== undefined || a.ref !== undefined) el.scrollIntoView({ block: "center", behavior: "instant" });
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
  })();
  return guard ? G.after(res) : res;
}

function zbReadText(a, expectedOrigin, guard) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // ZB-11: with activity cues on, check the overlay inside this same task, right before acting and right after.
  const G = guard ? globalThis.__zbOverlay : null;
  if (guard) {
    const no = G && G.before ? G.before() : { ok: false, code: "REFUSED", message: "zenbridge's activity overlay is missing from this page, so Claude didn't act" };
    if (no) return no;
  }
  const res = (() => {
    // innerText: visible text only. Input/textarea current values are not part of it.
    const raw = String(document.body ? document.body.innerText : "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const links = [];
    for (const el of document.querySelectorAll("a[href]")) {
      if (links.length >= 100) break;
      const text = String(el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (text && /^https?:/.test(el.href)) links.push({ text: text.slice(0, 120), href: String(el.href).slice(0, 2048) });
    }
    return { ok: true, title: String(document.title), text: raw.slice(0, a.maxChars), truncated: raw.length > a.maxChars, links };
  })();
  return guard ? G.after(res) : res;
}

// Visual activity cue (Catppuccin Mocha mauve): a glow around the viewport, a "Claude is working"
// pill, a cursor that glides to the target, and a highlight box around the element being used.
// Purely visual: pointer-events none, closed shadow root, CSSOM styles only (no innerHTML).
// a = {hide:true} (before screenshots) | {kind:"glow"|"click"|"type"|"scroll", selector?, x?, y?}
// The page must not be able to hide or cover it (R-017): the host element is a manual popover in the top
// layer, re-shown on top before every action; its inline styles are !important and re-applied when the page
// touches them; it is put back when removed. Returns visible:false if it still isn't on top and showing, and
// the background then refuses the action.
// ZB-11: the page gets control again after this check, so it is not the last word. While the overlay is
// active, page popovers and modal dialogs that open (beforetoggle/toggle in the capture phase, and the
// `open` attribute of <dialog>) push it back on top and count as fights. And the same check runs again
// inside each action's own injected function, right before it acts (o.before) and right after (o.after),
// in one synchronous task, so no page code runs between the last check and the action.
function zbShow(a, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  const ACCENT = "#cba6f7", CRUST = "#11111b", RGB = "203,166,247";  // Catppuccin Mocha mauve / crust
  const HOST_CSS = [["display", "block"], ["position", "fixed"], ["inset", "0"], ["width", "100vw"], ["height", "100vh"],
    ["max-width", "none"], ["max-height", "none"], ["margin", "0"], ["padding", "0"], ["border", "0"], ["outline", "none"],
    ["background", "transparent"], ["box-shadow", "none"], ["overflow", "visible"], ["pointer-events", "none"],
    ["z-index", "2147483647"], ["opacity", "1"], ["visibility", "visible"], ["transform", "none"], ["translate", "none"],
    ["scale", "none"], ["rotate", "none"], ["filter", "none"], ["backdrop-filter", "none"], ["clip-path", "none"],
    ["mask", "none"], ["mix-blend-mode", "normal"], ["content-visibility", "visible"], ["contain", "none"],
    ["zoom", "1"], ["transition", "none"], ["animation", "none"]];
  const KEEP_ATTRS = ["id", "popover", "style"];
  let o = globalThis.__zbOverlay;
  const apply = () => {
    o.obs.disconnect();
    const de = document.documentElement;
    if (o.host.parentNode !== de) de.appendChild(o.host);
    for (const n of [...o.host.attributes].map((x) => x.name)) if (!KEEP_ATTRS.includes(n)) o.host.removeAttribute(n);
    if (o.host.id !== "zenbridge-overlay") o.host.id = "zenbridge-overlay";
    if (o.host.getAttribute("popover") !== "manual") o.host.setAttribute("popover", "manual");
    o.host.removeAttribute("style");
    for (const [k, v] of HOST_CSS) o.host.style.setProperty(k, k === "display" && o.hidden ? "none" : v, "important");
    try {
      if (o.host.matches(":popover-open")) o.host.hidePopover();
      if (!o.hidden) o.host.showPopover();  // (re)opening puts it above anything the page put in the top layer
    } catch (e) { /* not connected yet, or no popover support: the visibility check below decides */ }
    o.obs.observe(de, { childList: true });
    o.obs.observe(o.host, { attributes: true });
  };
  if (!o || o.v !== 2) {
    if (o && o.obs) { o.obs.disconnect(); if (o.watch) o.watch.disconnect(); }
    const stale = document.getElementById("zenbridge-overlay");
    if (stale) stale.remove();
    const host = document.createElement("div");
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
    o = globalThis.__zbOverlay = { v: 2, host, root, glow, pill, box, cursor, timer: 0, hidden: false, active: false,
      fights: [], tampered: false };
    // A page that keeps undoing it (more than 20 times in 2 s) is marked tampered instead of fighting forever,
    // and every later action on it is refused.
    o.fight = () => {
      const now = Date.now();
      o.fights = o.fights.filter((t) => now - t < 2000).concat(now);
      if (o.fights.length > 20) { o.tampered = true; o.obs.disconnect(); }
      return !o.tampered;
    };
    // Put it back whenever the page removes or restyles it.
    o.obs = new MutationObserver(() => { if (o.fight()) apply(); });
    // While Claude is acting, a page popover or modal dialog opening goes above it: put it back on top right
    // after (a microtask, once the page's own call has returned), and count it as a fight.
    const reshow = () => queueMicrotask(() => { if (o.active && !o.hidden && o.fight()) apply(); });
    const onToggle = (e) => {
      if (!o.active || o.hidden || e.target === o.host || (e.newState && e.newState !== "open")) return;
      reshow();
    };
    for (const t of ["beforetoggle", "toggle"]) document.addEventListener(t, onToggle, true);
    o.watch = new MutationObserver((recs) => {
      if (o.active && !o.hidden && recs.some((r) => r.target.localName === "dialog" && r.target.hasAttribute("open"))) reshow();
    });
    o.watch.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["open"] });
    // Why it isn't showing on top right now, or "" if it is: in the top layer, rendered (checkVisibility), and
    // the topmost thing at the centre and near each corner (the glow takes hits only for this synchronous check).
    // While a modal <dialog> is open everything outside it is inert, so hit testing can't see the overlay; it is
    // re-opened after any dialog, so it is above it in the top layer anyway.
    o.covered = () => {
      let why = o.tampered ? "the page keeps undoing it" : !o.host.isConnected ? "it was removed"
        : !o.host.matches(":popover-open") ? "it is not in the top layer"
          : !o.host.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) ? "it is not rendered" : "";
      let modal = null;
      try { modal = document.querySelector(":modal"); } catch (e) { modal = null; }
      if (!why && !modal) {
        const w = document.documentElement.clientWidth || window.innerWidth, h = document.documentElement.clientHeight || window.innerHeight;
        o.glow.style.setProperty("pointer-events", "auto");
        try {
          // 24 px in from the edges: macOS overlay scrollbars sit above the top layer and take hits there.
          const e = 24;
          for (const [px, py] of [[w / 2, h / 2], [w / 2, e], [e, e], [w - e, e], [e, h - e], [w - e, h - e]]) {
            const hit = document.elementFromPoint(px, py);
            if (hit !== o.host) { why = `a ${hit ? String(hit.tagName).toLowerCase().slice(0, 20) : "nothing"} element is on top of it at ${Math.round(px)},${Math.round(py)}`; break; }
          }
        } finally { o.glow.style.setProperty("pointer-events", "none"); }
      }
      return why;
    };
    const refuse = (message) => ({ ok: false, code: "REFUSED", message });
    // Called first thing inside an action's injected function. Strict: the cue put it on top moments ago, so
    // anything above it now was put there by the page during the pause. Put it back, count it, and don't act.
    o.before = () => {
      const why = o.hidden ? "it is hidden" : o.covered();
      if (!why) return null;
      if (!o.tampered && !o.hidden && o.fight()) apply();
      return refuse(`the page covered zenbridge's activity overlay just before the action (${why}), so Claude didn't act`);
    };
    // Called with the action's result, in the same task. The action itself may open a page popover or dialog
    // (a menu, say): put the overlay back on top once. If it still isn't showing, report REFUSED and refuse
    // every later action on this page.
    o.after = (res) => {
      const finish = (r) => {
        let why = o.covered();
        if (why && !o.tampered && o.fight()) { apply(); why = o.covered(); }
        if (!why) return r;
        o.tampered = true;
        return refuse(`the page covered zenbridge's activity overlay during the action (${why}); the action may have run, `
          + "and Claude won't act on this page again");
      };
      return res && typeof res.then === "function" ? res.then(finish) : finish(res);
    };
  }
  o.hidden = !!a.hide;
  o.active = !o.hidden;
  apply();
  if (a.hide) return { ok: true, visible: false };
  const show = (el, on) => el.style.setProperty("opacity", on ? "1" : "0");
  show(o.glow, true);
  show(o.pill, true);
  let el = null, x, y;
  if (["click", "hover", "type", "scroll"].includes(a.kind)) {
    const pointAt = a.x !== undefined && a.y !== undefined && a.selector === undefined && a.ref === undefined;
    if (a.ref !== undefined) {
      const reg = globalThis.__zbRefs, w = reg && reg.map.get(a.ref);
      el = w ? w.deref() : null;
      if (el && !el.isConnected) el = null;
    } else if (a.selector !== undefined) {
      try { el = document.querySelector(a.selector); } catch (e) { el = null; }
    } else if (pointAt) el = document.elementFromPoint(a.x, a.y);
    else if (a.kind === "type") el = document.activeElement;
    if (el === document.body || el === document.documentElement || el === o.host) el = null;
    if (el && !pointAt) {
      const b = el.getBoundingClientRect();
      if (b.bottom < 0 || b.top > window.innerHeight || b.right < 0 || b.left > window.innerWidth) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
    const r = el && el.getBoundingClientRect();
    if (pointAt) { x = a.x; y = a.y; }
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
  o.timer = setTimeout(() => { o.active = false; for (const e of [o.glow, o.pill, o.box, o.cursor]) show(e, false); }, 5000);
  const why = o.covered();
  return { ok: true, visible: !why, why };
}

function zbScroll(a, expectedOrigin, guard) {
  if (location.origin !== expectedOrigin) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // ZB-11: with activity cues on, check the overlay inside this same task, right before acting and right after.
  const G = guard ? globalThis.__zbOverlay : null;
  if (guard) {
    const no = G && G.before ? G.before() : { ok: false, code: "REFUSED", message: "zenbridge's activity overlay is missing from this page, so Claude didn't act" };
    if (no) return no;
  }
  const res = (() => {
    const byRef = (r) => { const reg = globalThis.__zbRefs, w = reg && reg.map.get(r), e = w && w.deref(); return e && e.isConnected ? e : null; };
    const delta = a.dx !== undefined || a.dy !== undefined;
    let el = null;
    if (a.ref !== undefined) {
      el = byRef(a.ref);
      if (!el) return { ok: false, code: "INVALID", message: "ref not found (the page changed?): call read_tree or find again" };
    } else if (a.selector !== undefined) {
      try { el = document.querySelector(a.selector); } catch (e) { return { ok: false, code: "INVALID", message: "invalid CSS selector" }; }
      if (!el) return { ok: false, code: "INVALID", message: "no element matches selector" };
    } else if (a.x !== undefined) {
      if (a.x > window.innerWidth || a.y > window.innerHeight) return { ok: false, code: "INVALID", message: "point is outside the viewport" };
      el = document.elementFromPoint(a.x, a.y);
    }
    if (!delta) {
      if (!el) return { ok: false, code: "INVALID", message: "give dx/dy, or a ref or selector to scroll into view" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY, target: "page" };
    }
    // Scroll the nearest scrollable area around the target (like a mouse wheel there), else the page.
    const scroller = (e) => {
      for (; e && e !== document.body && e !== document.documentElement; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
        const cs = getComputedStyle(e);
        const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight;
        const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth;
        if ((a.dy && canY) || (a.dx && canX)) return e;
      }
      return null;
    };
    const box = el && scroller(el);
    if (box) {
      box.scrollBy({ left: a.dx || 0, top: a.dy || 0, behavior: "instant" });
      return { ok: true, scrollX: box.scrollLeft, scrollY: box.scrollTop, target: "element" };
    }
    window.scrollBy({ left: a.dx || 0, top: a.dy || 0, behavior: "instant" });
    return { ok: true, scrollX: window.scrollX, scrollY: window.scrollY, target: "page" };
  })();
  return guard ? G.after(res) : res;
}

// The newer page actions (tree, find, hover, drag, key, form, wait, upload, console) share helpers,
// so they live in one self-contained function and dispatch on a.op. Refs are kept in the extension's
// isolated world (globalThis), never written into the page, and die with the document.
function zbPage(a, expectedOrigin, guard) {
  if (location.origin !== expectedOrigin, guard) return { ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" };
  // ZB-11: with activity cues on, check the overlay inside this same task, right before acting and right after.
  const G = guard ? globalThis.__zbOverlay : null;
  if (guard) {
    const no = G && G.before ? G.before() : { ok: false, code: "REFUSED", message: "zenbridge's activity overlay is missing from this page, so Claude didn't act" };
    if (no) return no;
  }
  const fail = (code, message) => ({ zbFail: true, code, message });
  const reg = globalThis.__zbRefs || (globalThis.__zbRefs = { map: new Map(), ids: new WeakMap(), next: 1 });
  const refOf = (el) => {
    let id = reg.ids.get(el);
    if (!id) {
      if (reg.map.size > 50000) for (const [k, w] of reg.map) if (!w.deref()) reg.map.delete(k);
      id = `ref_${reg.next++}`;
      reg.ids.set(el, id);
      reg.map.set(id, new WeakRef(el));
    }
    return id;
  };
  const byRef = (r) => { const w = reg.map.get(r), e = w && w.deref(); return e && e.isConnected ? e : null; };
  const clean = (v, n = 200) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const tagOf = (el) => String(el.localName || el.tagName || "").toLowerCase().slice(0, 40);
  const label = (el) => clean(el.getAttribute && el.getAttribute("aria-label") || el.innerText || "", 200);
  const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  const resolve = (t, scroll = true) => {
    let el;
    if (t.ref !== undefined) {
      el = byRef(t.ref);
      if (!el) throw fail("INVALID", "ref not found (the page changed?): call read_tree or find again");
    } else if (t.selector !== undefined) {
      try { el = document.querySelector(t.selector); } catch (e) { throw fail("INVALID", "invalid CSS selector"); }
      if (!el) throw fail("INVALID", "no element matches selector");
    } else if (t.x !== undefined) {
      if (t.x > window.innerWidth || t.y > window.innerHeight) throw fail("INVALID", "point is outside the viewport");
      el = document.elementFromPoint(t.x, t.y);
      if (!el) throw fail("INVALID", "no element at that point");
      return { el, x: t.x, y: t.y };
    } else return null;
    if (scroll && !inView(el.getBoundingClientRect())) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { el, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  // Same rule as zbIsSensitiveField in logic.js (injected code cannot import).
  const sensitive = (el) => {
    if (!el || !el.getAttribute) return false;
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    return (tagOf(el) === "input" && String(el.type).toLowerCase() === "password") ||
      ac.some((t) => t.startsWith("cc-") || ["current-password", "new-password", "one-time-code"].includes(t)) ||
      /pass(word|wd|code)|pwd|otp|cvc|cvv|card.?num|api.?key|secret|token|(?:^|[^a-z])ssn(?:[^a-z]|$)|social.?sec/i.test(`${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`);
  };
  const mouse = (el, type, x, y, extra = {}) => el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
    bubbles: !/enter|leave/.test(type), cancelable: true, composed: true, clientX: x, clientY: y, view: window,
    pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra }));
  const fire = (el, ...types) => { for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true })); };

  // --- roles and names, roughly as the accessibility tree computes them
  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button",
    range: "slider", search: "searchbox", number: "spinbutton", file: "button" };
  const TAG_ROLES = { button: "button", textarea: "textbox", img: "img", h1: "heading", h2: "heading", h3: "heading", h4: "heading",
    h5: "heading", h6: "heading", nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary",
    form: "form", table: "table", tr: "row", th: "columnheader", td: "cell", ul: "list", ol: "list", li: "listitem", dialog: "dialog",
    summary: "button", option: "option", article: "article", fieldset: "group", details: "group", progress: "progressbar",
    label: "label", iframe: "iframe", video: "video", audio: "audio" };
  const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider",
    "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
  const NAME_FROM_CONTENT = new Set(["link", "button", "heading", "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "cell", "columnheader", "listitem", "label", "treeitem", "switch", "checkbox", "radio"]);
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r && r.trim()) return r.trim().split(/\s+/)[0].replace(/[^a-z-]/gi, "").slice(0, 40) || null;
    const tag = el.localName;
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") { const t = String(el.type).toLowerCase(); return t === "hidden" ? null : INPUT_ROLES[t] || "textbox"; }
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    return TAG_ROLES[tag] || null;
  };
  const isInteractive = (el, role) => (role && INTERACTIVE.has(role)) || el.hasAttribute("onclick") ||
    el.getAttribute("draggable") === "true" || (el.hasAttribute("tabindex") && el.tabIndex >= 0);
  const nameOf = (el, role) => {
    let n = el.getAttribute("aria-label");
    if (!n) {
      const ids = el.getAttribute("aria-labelledby");
      if (ids) n = ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.innerText || e.textContent).join(" ");
    }
    if (!n && el.labels && el.labels.length) n = [...el.labels].map((l) => l.innerText).join(" ");
    if (!n && el.localName === "img") n = el.getAttribute("alt");
    if (!n && el.localName === "input" && ["button", "submit", "reset"].includes(el.type)) n = el.value;
    if (!n) n = el.getAttribute("placeholder") || el.getAttribute("title");
    if (!n && (NAME_FROM_CONTENT.has(role) || role === "generic")) n = el.innerText;
    return clean(n, 200);
  };
  const states = (el, role) => {
    const out = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) out.push(el.checked ? "checked" : "unchecked");
    else if (el.getAttribute("aria-checked")) out.push(el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
    const ex = el.getAttribute("aria-expanded");
    if (ex) out.push(ex === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || (el.localName === "option" && el.selected)) out.push("selected");
    if (el.required) out.push("required");
    if (document.activeElement === el) out.push("focused");
    if (role === "heading") { const lv = el.getAttribute("aria-level") || el.localName.slice(1); if (/^\d$/.test(lv)) out.push(`level ${lv}`); }
    return out;
  };
  const valueOf = (el) => {
    if (sensitive(el)) return null;
    if (el.localName === "select") { const o = el.selectedOptions && el.selectedOptions[0]; return o ? clean(o.text) : ""; }
    if (el.localName === "textarea" ||
        (el.localName === "input" && !["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(el.type))) return clean(el.value);
    return null;
  };
  const visible = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") {
      try { return el.checkVisibility({ visibilityProperty: true }); } catch (e) { return el.checkVisibility(); }
    }
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link"]);
  const childNodes = (el) => [...(el.shadowRoot ? el.shadowRoot.childNodes : []), ...el.childNodes];
  const ownText = (el) => clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "), 300);
  // Visit visible elements; file inputs are kept even when hidden (uploads target them).
  // display:contents boxes are transparent. fn returns false to skip an element's children.
  const walk = (root, fn, budget = 30000) => {
    let n = 0;
    const go = (el, depth, ctx) => {
      if (n++ > budget) return false;
      if (SKIP.has(el.localName)) return true;
      const opt = el.localName === "option" || el.localName === "optgroup";
      const fileInput = el.localName === "input" && el.type === "file";
      if (!opt && !fileInput && !visible(el) && getComputedStyle(el).display !== "contents") return true;
      const next = fn(el, depth, ctx);
      if (next === false) return true;
      for (const c of childNodes(el)) {
        if (c.nodeType === 1 && go(c, next.depth, next.ctx) === false) return false;
        if (c.nodeType === 3 && next.text) next.text(c, next.depth);
      }
      return true;
    };
    go(root, 0, {});
    return n > budget;
  };
  const run = () => {
    if (a.op === "tree") {
      const root = a.ref !== undefined ? byRef(a.ref) : document.body || document.documentElement;
      if (!root) throw fail("INVALID", "ref not found (the page changed?): call read_tree or find again");
      const lines = [];
      let size = 0, nodes = 0, truncated = false;
      const push = (depth, line) => {
        if (truncated) return;
        const s = "  ".repeat(depth) + line;
        if (size + s.length + 1 > a.maxChars) { truncated = true; return; }
        lines.push(s);
        size += s.length + 1;
      };
      const all = a.filter !== "interactive";
      const over = walk(root, (el, depth, ctx) => {
        const role = roleOf(el);
        const inter = isInteractive(el, role);
        if (el.localName === "svg") {
          const n = clean(el.getAttribute("aria-label") || (el.querySelector("title") || {}).textContent);
          if (n && all) { nodes++; push(depth, `- img ${JSON.stringify(n)} [${refOf(el)}]`); }
          return false;
        }
        const emit = all ? !!role || inter : inter;
        let d = depth, noText = ctx.noText;
        if (emit) {
          if (depth >= a.depth) { truncated = true; return false; }
          nodes++;
          const r = role || "generic";
          const name = nameOf(el, r);
          const st = states(el, r);
          const v = valueOf(el);
          let line = `- ${r}${name ? ` ${JSON.stringify(name)}` : ""} [${refOf(el)}]`;
          if (st.length) line += ` (${st.join(", ")})`;
          if (v !== null) line += ` value=${JSON.stringify(v)}`;
          if (r === "link" && /^https?:/.test(el.href)) line += ` href=${JSON.stringify(String(el.href).slice(0, 300))}`;
          if (el.localName === "input" && el.type && !["text", "checkbox", "radio", "submit", "button"].includes(el.type)) line += ` type=${el.type}`;
          if (el.localName === "select" && el.options.length > 30) line += ` options=${el.options.length}`;
          push(depth, line);
          d = depth + 1;
          if ((NAME_FROM_CONTENT.has(r) || r === "generic") && name) noText = true;
          if (el.localName === "select" && el.options.length > 30) return false;
        }
        // Text gets its element's ref when that element has no line of its own, so it can be clicked.
        const text = all && !noText ? (node, td) => {
          const t = clean(node.textContent, 300);
          if (t) { nodes++; push(td, `- text ${JSON.stringify(t)}${emit ? "" : ` [${refOf(el)}]`}`); }
        } : null;
        return { depth: d, ctx: { noText }, text };
      });
      return { ok: true, title: clean(document.title), tree: lines.join("\n"), truncated: truncated || over, nodes };
    }

    if (a.op === "find") {
      const q = a.query.toLowerCase();
      const STOP = new Set(["the", "a", "an", "of", "on", "in", "to", "for", "with", "and", "or", "that", "this", "is", "at", "by",
        "my", "me", "please", "element", "elements", "find", "where", "which"]);
      const ROLE_WORDS = { button: ["button", "btn"], link: ["link", "links"], textbox: ["field", "input", "box", "textbox", "text", "bar", "entry", "textarea"],
        searchbox: ["search", "field", "box", "bar", "input"], combobox: ["dropdown", "select", "combo", "picker", "menu"],
        listbox: ["list", "select"], checkbox: ["checkbox", "check", "tick", "toggle"], switch: ["switch", "toggle"],
        radio: ["radio", "option"], heading: ["heading", "title", "header", "headline"], img: ["image", "picture", "photo", "icon", "logo"],
        tab: ["tab"], menuitem: ["menu", "item"], option: ["option"], slider: ["slider", "range"], navigation: ["nav", "navigation", "menu"],
        dialog: ["dialog", "modal", "popup"], form: ["form"], table: ["table"], row: ["row"], cell: ["cell"] };
      const roleWord = new Set(Object.values(ROLE_WORDS).flat());
      const words = q.split(/[^\p{L}\p{N}$€£.@#-]+/u).filter((w) => w && !STOP.has(w));
      if (!words.length) throw fail("INVALID", "query has no searchable words");
      const roleOnly = words.every((w) => roleWord.has(w));
      const cands = [];
      walk(document.body || document.documentElement, (el) => {
        let role = roleOf(el);
        const own = role ? "" : ownText(el);
        if (!role && !own && !(el.localName === "input" && el.type === "file")) return { depth: 0, ctx: {} };
        role = role || "text";
        const name = role === "text" ? own : nameOf(el, role);
        const extra = [el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("name"), el.id,
          el.getAttribute("type"), el.getAttribute("alt")].filter(Boolean).join(" ");
        const hay = `${name} ${extra}`.toLowerCase();
        let score = 0, content = 0;
        for (const w of words) {
          if (hay.includes(w)) { score += 2; content++; } else if (role === w || (ROLE_WORDS[role] || []).includes(w)) score += 1;
        }
        if (!content && !(roleOnly && score > 0)) return { depth: 0, ctx: {} };
        if (q.length > 2 && hay.includes(q)) score += 3;
        if (isInteractive(el, role)) score += 0.5;
        const r = el.getBoundingClientRect();
        if (inView(r)) score += 0.25;
        score -= Math.min(name.length, 400) / 4000;  // prefer tight matches over big containers
        cands.push({ el, role, name, score, r });
        return { depth: 0, ctx: {} };
      });
      cands.sort((x, y) => y.score - x.score);
      const matches = cands.slice(0, 20).map((c) => ({ ref: refOf(c.el), role: c.role, name: c.name,
        x: Math.round(c.r.left + c.r.width / 2), y: Math.round(c.r.top + c.r.height / 2), inView: inView(c.r) }));
      return { ok: true, matches, more: cands.length > 20 };
    }

    if (a.op === "hover") {
      const t = resolve(a);
      // Like a real pointer: over/out on the target, enter/leave on every ancestor crossed.
      const chain = (e) => { const c = []; for (; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) c.push(e); return c; };
      const prev = globalThis.__zbHovered && globalThis.__zbHovered.isConnected ? globalThis.__zbHovered : null;
      const from = prev ? chain(prev) : [], to = chain(t.el);
      if (prev && prev !== t.el) {
        mouse(prev, "pointerout", t.x, t.y);
        mouse(prev, "mouseout", t.x, t.y);
        for (const e of from.filter((x) => !to.includes(x))) { mouse(e, "pointerleave", t.x, t.y); mouse(e, "mouseleave", t.x, t.y); }
      }
      if (prev !== t.el) {
        mouse(t.el, "pointerover", t.x, t.y);
        mouse(t.el, "mouseover", t.x, t.y);
        for (const e of to.filter((x) => !from.includes(x)).reverse()) { mouse(e, "pointerenter", t.x, t.y); mouse(e, "mouseenter", t.x, t.y); }
      }
      mouse(t.el, "pointermove", t.x, t.y);
      mouse(t.el, "mousemove", t.x, t.y);
      globalThis.__zbHovered = t.el;
      return { ok: true, tag: tagOf(t.el), text: label(t.el) };
    }

    if (a.op === "drag") {
      const s = resolve(a.from);
      const t = resolve(a.to, false);
      const src = s.el.closest('[draggable="true"]');
      const dt = src ? new DataTransfer() : null;
      const drag = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
      mouse(s.el, "pointerdown", s.x, s.y, { buttons: 1 });
      mouse(s.el, "mousedown", s.x, s.y, { buttons: 1 });
      if (src) drag(src, "dragstart", s.x, s.y);
      let over = null;
      const N = 10;
      for (let i = 1; i <= N; i++) {
        const x = s.x + ((t.x - s.x) * i) / N, y = s.y + ((t.y - s.y) * i) / N;
        const at = document.elementFromPoint(x, y) || t.el;
        mouse(at, "pointermove", x, y, { buttons: 1 });
        mouse(at, "mousemove", x, y, { buttons: 1 });
        if (src) {
          if (at !== over) { if (over) drag(over, "dragleave", x, y); drag(at, "dragenter", x, y); over = at; }
          drag(at, "dragover", x, y);
        }
      }
      const end = document.elementFromPoint(t.x, t.y) || t.el;
      if (src) { drag(end, "drop", t.x, t.y); drag(src, "dragend", t.x, t.y); }
      mouse(end, "pointerup", t.x, t.y, { buttons: 0 });
      mouse(end, "mouseup", t.x, t.y, { buttons: 0 });
      return { ok: true, tag: tagOf(end), text: label(end), html5: !!src };
    }

    if (a.op === "key") {
      const NAMES = { enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", backspace: "Backspace", delete: "Delete",
        del: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp",
        arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
      const MODS = { ctrl: "ctrl", control: "ctrl", cmd: "meta", command: "meta", meta: "meta", super: "meta", win: "meta", windows: "meta",
        alt: "alt", option: "alt", opt: "alt", shift: "shift" };
      const presses = a.keys.split(" ").map((tok) => {
        let key, modPart = "";
        if (tok === "+") key = "+";
        else if (tok.endsWith("++")) { key = "+"; modPart = tok.slice(0, -2); }
        else { const i = tok.lastIndexOf("+"); key = i >= 0 ? tok.slice(i + 1) : tok; modPart = i >= 0 ? tok.slice(0, i) : ""; }
        const p = { ctrl: false, meta: false, alt: false, shift: false };
        for (const m of modPart ? modPart.split("+") : []) {
          const k = MODS[m.toLowerCase()];
          if (!k) throw fail("INVALID", `unknown modifier "${m.slice(0, 20)}"`);
          p[k] = true;
        }
        if (key.length > 1) {
          const f = /^f([1-9]|1[0-2])$/i.exec(key);
          key = f ? `F${f[1]}` : NAMES[key.toLowerCase()];
          if (!key) throw fail("INVALID", `unknown key in "${tok.slice(0, 30)}"`);
        } else if (p.shift && /[a-z]/.test(key)) key = key.toUpperCase();
        p.key = key;
        p.code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === " " ? "Space" : key;
        return p;
      });
      if (a.ref !== undefined || a.selector !== undefined) {
        const t = resolve(a).el;
        if (typeof t.focus === "function") t.focus({ preventScroll: true });
      }
      const focused = () => (document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body);
      const isField = (e) => e.localName === "textarea" ||
        (e.localName === "input" && !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color"].includes(e.type));
      const editable = (e) => isField(e) || e.isContentEditable;
      const focusables = () => [...document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]')]
        .filter((e) => !e.disabled && e.tabIndex >= 0 && visible(e));
      const page = (dx, dy) => window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      let pressed = 0;
      for (let rep = 0; rep < (a.repeat || 1); rep++) {
        for (const p of presses) {
          const cur = focused();
          const init = { key: p.key, code: p.code, bubbles: true, cancelable: true, composed: true, view: window,
            ctrlKey: p.ctrl, metaKey: p.meta, altKey: p.alt, shiftKey: p.shift };
          const cmd = p.ctrl || p.meta, k = p.key;
          // Checked on every press: Tab or Enter may have moved focus into a sensitive field.
          if (k.length === 1 && !cmd && sensitive(cur)) {
            throw fail("REFUSED", `refusing to type into a password, one-time-code or credit-card field (after ${pressed} key presses)`);
          }
          if (cur.dispatchEvent(new KeyboardEvent("keydown", init))) {
            if (k.length === 1 && !cmd) {
              if (cur.dispatchEvent(new KeyboardEvent("keypress", init))) {
                if (editable(cur)) document.execCommand("insertText", false, k);
                else if (k === " ") {
                  if (/^(button|summary)$/.test(cur.localName) || ["checkbox", "radio"].includes(cur.type) || cur.getAttribute("role") === "button") cur.click();
                  else page(0, (p.shift ? -0.9 : 0.9) * window.innerHeight);
                }
              }
            } else if (cmd && k.toLowerCase() === "a") {
              if (isField(cur)) cur.select(); else window.getSelection().selectAllChildren(cur.isContentEditable ? cur : document.body);
            } else if (cmd && k.toLowerCase() === "z") document.execCommand(p.shift ? "redo" : "undo");
            else if (cmd && k.toLowerCase() === "y") document.execCommand("redo");
            else if (k === "Enter") {
              if (cur.localName === "textarea") document.execCommand("insertText", false, "\n");
              else if (cur.isContentEditable) document.execCommand("insertParagraph");
              else if (cur.localName === "input" && cur.form) { try { cur.form.requestSubmit(); } catch (e) { /* invalid submitter */ } }
              else if (/^(a|button|summary)$/.test(cur.localName) || ["button", "link"].includes(cur.getAttribute("role"))) cur.click();
            } else if (k === "Tab") {
              const list = focusables(), i = list.indexOf(cur);
              const n = i < 0 ? list[p.shift ? list.length - 1 : 0] : list[(i + (p.shift ? -1 : 1) + list.length) % list.length];
              if (n) n.focus();
            } else if (k === "Backspace") document.execCommand("delete");
            else if (k === "Delete") document.execCommand("forwardDelete");
            else if (cur.localName === "select" && (k === "ArrowUp" || k === "ArrowDown")) {
              const i = cur.selectedIndex + (k === "ArrowDown" ? 1 : -1);
              if (i >= 0 && i < cur.options.length) { cur.selectedIndex = i; fire(cur, "input", "change"); }
            } else if (isField(cur) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) {
              try {
                const len = cur.value.length, s = cur.selectionStart, e = cur.selectionEnd;
                const toStart = k === "Home" || (cmd && k === "ArrowLeft"), toEnd = k === "End" || (cmd && k === "ArrowRight");
                if (p.shift) {
                  if (toStart) cur.setSelectionRange(0, e, "backward");
                  else if (toEnd) cur.setSelectionRange(s, len);
                  else if (k === "ArrowLeft") cur.setSelectionRange(Math.max(0, s - 1), e, "backward");
                  else cur.setSelectionRange(s, Math.min(len, e + 1));
                } else {
                  const pos = toStart ? 0 : toEnd ? len : k === "ArrowLeft" ? (s === e ? Math.max(0, s - 1) : s) : (s === e ? Math.min(len, e + 1) : e);
                  cur.setSelectionRange(pos, pos);
                }
              } catch (e) { /* field type without a caret (email, number) */ }
            } else if (!editable(cur)) {
              const h = window.innerHeight;
              const moves = { ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowRight: [40, 0], ArrowLeft: [-40, 0], PageDown: [0, 0.9 * h], PageUp: [0, -0.9 * h] };
              if (moves[k]) page(...moves[k]);
              else if (k === "Home") window.scrollTo({ top: 0, behavior: "instant" });
              else if (k === "End") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
            }
          }
          cur.dispatchEvent(new KeyboardEvent("keyup", init));
          pressed++;
        }
      }
      return { ok: true, tag: tagOf(focused()), pressed };
    }

    if (a.op === "form") {
      const el = resolve(a).el;
      const tag = tagOf(el), type = String(el.type || "").toLowerCase();
      if (sensitive(el)) throw fail("REFUSED", "refusing to fill a password, one-time-code or credit-card field");
      const checkable = tag === "input" && (type === "checkbox" || type === "radio");
      let checked = a.checked;
      if (checked === undefined && checkable && /^(true|false|on|off|yes|no|checked|unchecked)$/i.test(a.value)) checked = /^(true|on|yes|checked)$/i.test(a.value);
      if (checked !== undefined) {
        if (checkable) {
          if (type === "radio" && !checked && el.checked) throw fail("INVALID", "a radio button can't be unchecked; choose another option instead");
          if (el.checked !== checked) el.click();
          return { ok: true, tag, kind: type, applied: el.checked === checked };
        }
        const role = el.getAttribute("role");
        if (["checkbox", "switch", "radio"].includes(role)) {
          if ((el.getAttribute("aria-checked") === "true") !== checked) el.click();
          return { ok: true, tag, kind: role === "radio" ? "radio" : "checkbox", applied: (el.getAttribute("aria-checked") === "true") === checked };
        }
        throw fail("INVALID", "checked only applies to checkboxes and radio buttons");
      }
      const v = a.value;
      if (tag === "select") {
        const opts = [...el.options], lv = v.trim().toLowerCase();
        const o = opts.find((x) => x.value === v) || opts.find((x) => clean(x.text).toLowerCase() === lv) ||
          (lv ? opts.find((x) => clean(x.text).toLowerCase().includes(lv)) : null);
        if (!o) throw fail("INVALID", "no option matches that value; read_tree lists the options");
        if (el.multiple) for (const x of opts) x.selected = x === o;
        else el.selectedIndex = o.index;
        fire(el, "input", "change");
        return { ok: true, tag, kind: "select", applied: o.selected };
      }
      if (tag === "input" || tag === "textarea") {
        if (type === "file") throw fail("INVALID", "use file_upload for file inputs");
        if (checkable) throw fail("INVALID", "use checked: true or false for checkboxes and radio buttons");
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        if (typeof el.focus === "function") el.focus({ preventScroll: true });
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        fire(el, "input", "change");
        return { ok: true, tag, kind: "text", applied: el.value === v };
      }
      if (el.isContentEditable) {
        el.focus();
        window.getSelection().selectAllChildren(el);
        document.execCommand(v ? "insertText" : "delete", false, v);
        return { ok: true, tag, kind: "editable", applied: clean(el.innerText, 10000) === clean(v, 10000) };
      }
      throw fail("INVALID", "not a form control: click it and pick an option, or use type");
    }

    if (a.op === "wait") {
      const t0 = Date.now(), end = t0 + a.seconds * 1000;
      const met = () => {
        let found;
        if (a.selector !== undefined) {
          let e;
          try { e = document.querySelector(a.selector); } catch (x) { throw fail("INVALID", "invalid CSS selector"); }
          found = !!e && visible(e);
        } else found = String(document.body ? document.body.innerText : "").toLowerCase().includes(a.text.toLowerCase());
        return a.gone ? !found : found;
      };
      met();  // a bad selector fails right away
      return new Promise((res) => {
        const tick = () => {
          if (location.origin !== expectedOrigin) { res({ ok: false, code: "OUT_OF_SCOPE", message: "page origin changed" }); return; }
          const m = met();
          if (m || Date.now() >= end) res({ ok: true, met: m, waited: Math.round((Date.now() - t0) / 100) / 10 });
          else setTimeout(tick, 150);
        };
        tick();
      });
    }

    if (a.op === "upload") {
      const t = resolve(a);
      const el = t.el;
      const files = a.files.map((f) => {
        const bin = atob(f.data), u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return new File([u], f.name, { type: f.mimeType });
      });
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      const bytes = files.reduce((n, f) => n + f.size, 0);
      const input = tagOf(el) === "input" && el.type === "file" ? el
        : tagOf(el) === "label" && el.control && el.control.type === "file" ? el.control
          : el.querySelector && el.querySelector('input[type="file"]');
      if (input) {
        if (input.disabled) throw fail("INVALID", "the file input is disabled");
        if (!input.multiple && files.length > 1) throw fail("INVALID", "this file input takes one file");
        input.files = dt.files;
        fire(input, "input", "change");
        return { ok: true, files: files.length, bytes, target: "input" };
      }
      // Firefox hides DataTransfer items a content script added from the page, so build the dropped
      // DataTransfer in the page's own realm there (the input path above does not have this problem).
      let drop = dt;
      const pw = window.wrappedJSObject;
      if (pw && typeof cloneInto === "function") {
        drop = new pw.DataTransfer();
        for (const f of files) {
          drop.items.add(new pw.File(cloneInto([f], window, { wrapReflectors: true }), f.name, cloneInto({ type: f.type }, window)));
        }
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: t.x, clientY: t.y, dataTransfer: drop }));
      }
      return { ok: true, files: files.length, bytes, target: "drop" };
    }

    if (a.op === "consoleHook" || a.op === "consoleRead") {
      const st = globalThis.__zbConsole || (globalThis.__zbConsole = { list: [], on: false, busy: false });
      // Firefox only: wrap the page's console methods with exportFunction; the log stays in our world.
      if (!st.on && typeof exportFunction === "function" && window.wrappedJSObject) {
        const fmt = (v) => {
          try { if (typeof XPCNativeWrapper !== "undefined") v = XPCNativeWrapper.unwrap(v); } catch (e) { /* keep v */ }
          if (v === null || (typeof v !== "object" && typeof v !== "function")) return String(v);
          try {
            if (typeof v.message === "string" && typeof v.name === "string") return `${v.name}: ${v.message}`;
            const j = JSON.stringify(v);
            return j === undefined ? String(v) : j;
          } catch (e) { try { return String(v); } catch (e2) { return "[object]"; } }
        };
        const push = (level, args) => {
          if (st.busy) return;  // a page toJSON that logs must not recurse
          st.busy = true;
          try {
            st.list.push({ level, text: [...args].map(fmt).join(" ").slice(0, 2000), time: Date.now() });
            if (st.list.length > 500) st.list.splice(0, st.list.length - 500);
          } catch (e) { /* drop it */ } finally { st.busy = false; }
        };
        const pc = window.wrappedJSObject.console;
        for (const level of ["log", "info", "warn", "error", "debug"]) {
          const orig = pc[level];
          if (typeof orig !== "function") continue;
          // Reflect.apply passes the arguments one by one: the page may not read our array (orig.apply(pc, args) threw
          // "Permission denied to access property length" inside the page on every console call).
          pc[level] = exportFunction(function (...args) { push(level, args); return Reflect.apply(orig, pc, args); }, window);
        }
        window.addEventListener("error", (e) => push("exception", [`${e.message || "error"}${e.filename ? ` (${e.filename}:${e.lineno})` : ""}`]));
        window.addEventListener("unhandledrejection", (e) => push("exception", ["Unhandled promise rejection:", e.reason]));
        st.on = true;
      }
      if (a.op === "consoleHook") return { ok: true, capturing: st.on };
      let list = st.list;
      if (a.onlyErrors) list = list.filter((m) => m.level === "error" || m.level === "exception");
      if (a.filter) { const f = a.filter.toLowerCase(); list = list.filter((m) => m.text.toLowerCase().includes(f)); }
      const messages = list.slice(-a.limit);
      if (a.clear) st.list = [];
      return { ok: true, capturing: st.on, messages };
    }
    throw fail("INVALID", "unknown page operation");
  };
  try {
    const res = run();
    return guard ? G.after(res) : res;
  } catch (e) {
    if (e && e.zbFail) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "INTERNAL", message: `page action failed (${String((e && e.name) || "error").slice(0, 40)})` };
  }
}

if (typeof module !== "undefined") module.exports = { zbPageMetrics, zbClick, zbFieldInfo, zbType, zbReadText, zbShow, zbScroll, zbPage };
