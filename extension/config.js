"use strict";
// zenbridge settings. To change: edit this file, then reload the extension
// (about:debugging, or re-sign and reinstall). There is no storage API on purpose.
const ZB_CONFIG = Object.freeze({
  // Origins added to every armed tab's scope. ":*" = any port.
  allowlist: Object.freeze(["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"]),
  // If true, tabs Claude opens with tab_open start armed. tab_open itself only allows the
  // allowlist and sites you already armed this session, and arming needs the host
  // permission granted by your own first click, so nothing new is ever approved here.
  autoArmOpened: true,
  alwaysOn: true,  // once you allow it, the session stays on across restarts until Alt+Shift+K
  // If true, every armed tab's scope is "*" (any http/https site): Claude can open, navigate
  // and act anywhere in tabs it opened or you armed. Your other tabs stay invisible.
  goAnywhere: true,
  // Orange glow, cursor and element highlight while Claude acts (hidden during screenshots).
  showActivity: true,
  cursorDelayMs: 200,  // pause so you can see the cursor reach its target before the action
  // Put tabs Claude controls in an orange "Claude" tab group (if Zen supports tab groups).
  tabGroup: true,
  // Must match the "name" in the native messaging host manifest.
  hostName: "zenbridge",
});

if (typeof module !== "undefined") module.exports = { ZB_CONFIG };
