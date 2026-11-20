"use strict";
// Settings page. Saves under the single storage key "settings"; the background re-sanitizes on read.
const form = document.getElementById("form");
const saved = document.getElementById("saved");
const clean = (raw) => zbSanitizeSettings(raw, ZB_DEFAULTS, ZB_TUNABLE);

function render(s) {
  for (const k of ZB_TUNABLE) {
    const el = form.elements[k];
    if (el.type === "checkbox") el.checked = s[k];
    else if (k === "allowlist") el.value = s[k].join("\n");
    else el.value = String(s[k]);
  }
}

function read() {
  const raw = {};
  for (const k of ZB_TUNABLE) {
    const el = form.elements[k];
    if (el.type === "checkbox") raw[k] = el.checked;
    else if (k === "allowlist") raw[k] = el.value.split("\n").map((x) => x.trim()).filter(Boolean);
    else raw[k] = Number(el.value);
  }
  return raw;
}

// Only settings that differ from the defaults are saved, so a safer default reaches you later (ZB-9).
async function save() {
  const raw = read();
  const full = clean(raw);
  const s = zbSettingsDiff(full, ZB_DEFAULTS, ZB_TUNABLE);
  await browser.storage.local.set({ settings: s });
  render(full);
  const dropped = JSON.stringify(raw.allowlist) !== JSON.stringify(full.allowlist) || raw.cursorDelayMs !== full.cursorDelayMs;
  saved.textContent = dropped ? "Saved. Some values were invalid and were reset." : "Saved.";
}

browser.storage.local.get("settings").then((r) => render(clean(r.settings)));
form.addEventListener("change", save);
document.getElementById("reset").addEventListener("click", async () => {
  await browser.storage.local.remove("settings");
  render(clean(undefined));
  saved.textContent = "Defaults restored.";
});
zbShowHostStatus(document.getElementById("host"), document.getElementById("setup"));
