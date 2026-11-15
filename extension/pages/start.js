"use strict";
// Extension page opened from the toolbar button on pages where Zen cannot show a permission prompt
// (new tab, homepage). The click here is the user gesture; background.js sees the grant via permissions.onAdded.
const status = document.getElementById("status");
zbShowHostStatus(document.getElementById("host"));
document.getElementById("on").addEventListener("click", () => {
  browser.permissions.request({ origins: ["<all_urls>"] }).then((ok) => {
    status.textContent = ok ? "Claude is on. You can close this tab." : "Not turned on.";
  }, (e) => { status.textContent = `Could not ask for permission: ${e.message}`; });
});
