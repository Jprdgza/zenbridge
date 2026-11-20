# manifest.json permissions, justified

JSON has no comments, so this file documents every permission.
`tests/test_static.py` fails if this list and `manifest.json` drift apart.

## permissions

| Permission | Why |
|---|---|
| `nativeMessaging` | `runtime.connectNative("zenbridge")` to the local companion app. This is the only channel to Claude. |
| `scripting` | `scripting.executeScript({func})` injects the fixed functions in `actions.js` into armed tabs. It is never called with a code string. `scripting.insertCSS` / `removeCSS` back the `inject_css` tool (top frame only, CSS that loads resources is refused). |
| `activeTab` | Exposes `tab.url` in the toolbar click handler, so the origin can be passed to `permissions.request` synchronously. The grant is scoped to the user's gesture. |
| `tabGroups` | Names and colors the "Claude" tab group that holds the tabs Claude controls (`tabGroups.update`). Grouping itself (`tabs.group`) needs no permission. |
| `storage` | The settings page saves one key, `settings`, in `storage.local`. The background re-validates it on every read. Nothing else is stored. |
| `webRequest` | Observation (`onBeforeRequest`, `onCompleted`, `onErrorOccurred`) for the `network_requests` tool. Only requests from tabs Claude controls are kept, in memory, newest 500 per tab, with credentials in URLs replaced by `REDACTED`. Also `onResponseStarted`, which reports the address each request connected to (ZB-12). |
| `webRequestBlocking` | ZB-12, DNS rebinding: in tabs Claude controls, `onHeadersReceived` cancels a response from a local or private address (`details.ip`) for a site whose name looks public, when reaching it as a local site needs your OK and you haven't given it. Nothing else is blocked or changed; headers are never read or modified. |
| `dns` | ZB-12: before `tab_open` and `navigate` (and other tool calls on a new site), `dns.resolve` checks where a public-looking name points. A loopback or private answer (`localtest.me`, `*.nip.io`, split-horizon names) makes it a local address, so moving there from a public site asks you first. |

## optional_permissions (requested only when you hand Claude a tab or turn it on)

| Permission | Why |
|---|---|
| `http://*/*` | Envelope for the per-origin patterns in the arm request (the clicked origin plus the allowlist, e.g. `http://localhost/*`). |
| `https://*/*` | Same, for https origins. |
| `<all_urls>` | `tabs.captureTab` requires it (MDN), and turning Claude on grants it so Claude can work in its own tabs. Arming, not this permission, decides what Claude can touch: the extension only acts in tabs you handed it or Claude opened. |

**Lifetime:** with "Stay on across restarts" (the default), `<all_urls>` is kept once you turn Claude on; Alt+Shift+K revokes it. Otherwise, and whenever Claude is off with nothing armed, the extension calls `permissions.remove` on every optional origin.

## Data collection

`data_collection_permissions.required: ["websiteContent", "browsingActivity"]`. The extension itself sends nothing over the network, but its purpose is to pass page text, screenshots and URLs of the tabs you hand Claude to the local companion app, which gives them to Claude Code, which sends them to Anthropic's API. It is declared so you see that at install time.

## Deliberately absent

`tabs`, `cookies`, `webRequest`, `webNavigation`, `history`, `downloads`,
`clipboardRead`, `clipboardWrite`, `menus`, `management`, `content_scripts`,
`web_accessible_resources`.

## Other keys

- `content_security_policy`: `script-src 'self'; object-src 'none'`, which rules out `eval` and remote scripts.
- `options_ui`: the settings page (`pages/options.html`).
- `commands.disarm-all`: Alt+Shift+K disarms every tab and turns Claude off.
- `commands.start-session`: Alt+Shift+C opens the page that turns Claude on.
