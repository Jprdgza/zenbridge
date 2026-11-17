# addons.mozilla.org listing

Copy-paste text for the public listing.

**Name:** zenbridge

**Summary (250 chars max):**
Unofficial companion for Claude Code: let Claude read pages, click, type, fill forms and take screenshots in tabs you hand it. Needs a small companion app from GitHub. Not affiliated with Anthropic.

**Categories:** Developer Tools; Other

**Description:**

zenbridge lets a local Claude Code session use your browser: open its own tabs, read pages, click, type, fill forms, drag and drop, upload files you name, read the console and network log, restyle pages with CSS and take screenshots.

You stay in control:
- Claude only sees tabs it opened and tabs you hand it with the toolbar button. Your other tabs are invisible to it.
- Turning Claude on takes a click, and Alt+Shift+K turns it off and revokes its access.
- Going to any website is opt-in from the settings page. By default Claude stays on the sites you hand it plus localhost.
- It never reads or fills password, one-time-code or card fields, never runs arbitrary JavaScript, never reads cookies or storage, and refuses to upload hidden files or anything from folders like ~/.ssh.
- While Claude works, the tab shows a glow, a "Claude is working in this tab" label and a moving cursor, so you can see what it's doing.

Setup: this add-on needs the zenbridge companion app (Python 3.10+, macOS or Linux) and Claude Code. Install instructions: https://github.com/Jprdgza/zenbridge#install. Without it, the toolbar button shows a "!" and the settings page explains what's missing.

Data: the add-on doesn't send anything over the network itself. Page content, screenshots and URLs of the tabs you hand Claude go to the companion app on your computer and then to Claude Code, which sends them to Anthropic as part of your conversation. Actions are logged locally on your computer; typed text, form values and file contents aren't logged. Console and network logs stay in browser memory, only for tabs Claude can see, with secret-looking URL parameters redacted.

Known limits: clicks and key presses are synthetic, so CAPTCHAs and some login or payment widgets ignore them; iframes can't be clicked into.

zenbridge is an unofficial, open-source (MIT) community project. It is not made by, endorsed by or affiliated with Anthropic or the Zen Browser team.

**Support site / homepage:** https://github.com/Jprdgza/zenbridge

**License:** MIT

## Notes for reviewers

- Source is plain, unminified JS; no build step. Source code: https://github.com/Jprdgza/zenbridge
- `nativeMessaging` talks to the open-source companion app in the same repository (`host/`), which relays to a local Claude Code MCP server over a unix socket. No network ports are opened.
- Optional `<all_urls>` is requested only when the user turns Claude on or hands it a tab; `tabs.captureTab` needs it. The extension acts only in tabs the user handed over or that Claude opened.
- `storage` holds one settings object, re-validated on every read.
- `webRequest` (observe only, no blocking) records method, URL, type and status of requests in tabs Claude can see, for the `network_requests` tool. Nothing is recorded for other tabs, secret-looking URL parameters are redacted, and the log is in memory only.
- The `console_messages` tool wraps the page's `console` methods with `exportFunction` from an injected function (no content scripts); the wrappers only copy messages into the extension's isolated world and call the original method.
- Files for `file_upload` are read by the companion app (never by the extension) and sent in pieces because native messages to the extension are capped at 1 MB. The app refuses hidden files and folders and system folders like `~/Library/Keychains`.
- `extension/manifest.README.md` justifies each permission.
