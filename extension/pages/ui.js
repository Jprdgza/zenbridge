"use strict";
// Shared by the start and settings pages: shows whether the companion app (native host) is reachable.
// Reads the background page's zbStatus() directly; there is no message passing in this extension.
async function zbShowHostStatus(el, setupLink) {
  let s = null;
  try { s = (await browser.runtime.getBackgroundPage()).zbStatus(); } catch (e) { s = null; }
  const states = {
    connected: ["connected", "ok"],
    connecting: ["connecting...", "warn"],
    disconnected: ["disconnected (is the browser's companion app running?)", "warn"],
    missing: ["not installed", "err"],
  };
  const [text, cls] = (s && states[s.host]) || ["unknown", "warn"];
  el.textContent = text;
  el.className = `status ${cls}`;
  if (setupLink && s) { setupLink.href = s.setupUrl; setupLink.hidden = s.host === "connected"; }
  return s;
}
const zbSettingsLink = document.getElementById("settings");
if (zbSettingsLink) zbSettingsLink.addEventListener("click", (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); });
