"use strict";
// zenbridge settings. ZB_DEFAULTS are the defaults; the settings page (options/) can change the
// user-tunable ones, which are saved under the single storage key "settings" and re-checked by
// zbSanitizeSettings() (logic.js) before use. ZB_CONFIG is the live, merged copy.
const ZB_DEFAULTS = Object.freeze({
  // Origins added to every armed tab's scope. ":*" = any port.
  allowlist: Object.freeze(["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]),
  // Tabs Claude opens with tab_open start armed (only on sites already allowed; see tab_open).
  autoArmOpened: true,
  // Once you turn Claude on, it stays on across restarts until Alt+Shift+K.
  alwaysOn: true,
  // If true, every armed tab's scope is "*" (any http/https site): Claude can open, navigate
  // and act anywhere in tabs it opened or you armed. Your other tabs stay invisible.
  // Off by default: Claude then stays on the sites you hand it plus the allowlist.
  goAnywhere: false,
  // Glow, cursor and element highlight while Claude acts (hidden during screenshots).
  showActivity: true,
  cursorDelayMs: 200,  // pause so you can see the cursor reach its target before the action
  // Put tabs Claude controls in a "Claude" tab group (if the browser supports tab groups).
  tabGroup: true,
});
const ZB_TUNABLE = Object.freeze(["allowlist", "autoArmOpened", "alwaysOn", "goAnywhere", "showActivity", "cursorDelayMs", "tabGroup"]);
// Must match the "name" in the native messaging host manifest.
const ZB_HOST_NAME = "zenbridge";
const ZB_SETUP_URL = "https://github.com/Jprdgza/zenbridge#install";
// Catppuccin Mocha accents used for every visual cue (https://catppuccin.com/palette).
const ZB_COLORS = Object.freeze({ accent: "#cba6f7", on: "#f38ba8", warn: "#f9e2af", crust: "#11111b", text: "#cdd6f4" });

const ZB_CONFIG = { ...ZB_DEFAULTS, hostName: ZB_HOST_NAME };

if (typeof module !== "undefined") module.exports = { ZB_DEFAULTS, ZB_TUNABLE, ZB_CONFIG, ZB_HOST_NAME, ZB_SETUP_URL, ZB_COLORS };
