"use strict";
// The window zenbridge opens to ask you before an upload, or before Claude moves between public sites and
// local addresses (ZB-7, ZB-8). Only a real (trusted) pointer click here answers yes: Enter or Space on a
// focused Allow doesn't (ZB-14), and focus starts on "Don't allow". Allow wakes up after a second, so a click
// or key press meant for another window can't say yes by accident. Closing the window says no.
const id = location.hash.slice(1);
const $ = (x) => document.getElementById(x);
let bg = null;
function reply(allow) {
  if (bg) bg.zbConfirmAnswer(id, allow);
  window.close();
}
function line(text, cls) {
  const p = document.createElement("p");
  p.textContent = text;
  if (cls) p.className = cls;
  $("body").appendChild(p);
}
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

function render(d) {
  if (!d) {
    $("title").textContent = "This question has expired";
    $("allow").hidden = true;
    $("deny").textContent = "Close";
    return;
  }
  if (d.kind === "upload") {
    $("title").textContent = "Let Claude upload files?";
    line(`To: ${d.origin}`, "site");
    const list = document.createElement("ul");
    for (const f of d.files) {
      const li = document.createElement("li");
      // The folder too (ZB-14), so a harmless-looking name from an unexpected place stands out.
      const folder = typeof f.folder === "string" && f.folder ? f.folder.replace(/\/+$/, "") : "(unknown folder)";
      li.textContent = `${folder}/${f.name} (${size(f.bytes)})`;
      list.appendChild(li);
    }
    $("body").appendChild(list);
    line("Claude chose these files. If you didn't ask for this upload, the page may be trying to get them.");
    $("allow").textContent = "Upload";
  } else {
    $("title").textContent = d.local ? "Let Claude open a local address?" : "Let Claude go to a public site?";
    line(d.origin, "site");
    if (d.local) {
      line(d.seenPublic
        ? "Claude has read public websites since it was turned on. Local addresses reach services on your computer, and a website could try to get Claude to copy what's there out to it."
        : "Local addresses reach services on your computer, and you haven't handed Claude a local tab yourself.");
    } else {
      line("Claude has worked on local addresses since it was turned on. A public site could receive what it read there.");
    }
    $("allow").textContent = "Allow";
  }
  line("Allow only if you asked Claude to do this.");
  $("deny").focus();
  setTimeout(() => { $("allow").disabled = false; $("allow").tabIndex = -1; }, 1000);
}

// A pointer click: a real mouse, pen or touch press has a click count (detail) or a pointerType. A click
// made by pressing Enter or Space has neither, and is ignored.
const pointerClick = (e) => e.isTrusted && (e.detail > 0 || (typeof e.pointerType === "string" && e.pointerType !== ""));
$("allow").addEventListener("click", (e) => { if (pointerClick(e) && !$("allow").disabled) reply(true); });
// Keys never say yes: keep keyboard focus off Allow.
$("allow").addEventListener("focus", () => $("deny").focus());
$("deny").addEventListener("click", () => reply(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") reply(false); });
browser.runtime.getBackgroundPage().then((page) => {
  bg = page;
  const raw = /^[0-9a-f]{32}$/.test(id) ? bg.zbConfirmDetails(id) : null;
  render(raw ? JSON.parse(raw) : null);
}, () => render(null));
