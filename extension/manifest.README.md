# manifest.json permissions, justified

JSON has no comments, so this file documents every permission.
`tests/test_static.py` fails if this list and `manifest.json` drift apart.

## permissions

| Permission | Why |
|---|---|
| `nativeMessaging` | `runtime.connectNative("zenbridge")` to the local host. This is the only channel to Claude. |
| `scripting` | `scripting.executeScript({func})` injects the fixed functions in `actions.js` into armed tabs. It is never called with a code string. `scripting.insertCSS` / `removeCSS` back the `inject_css` tool (top frame only, CSS that loads resources is refused). |
| `tabGroups` | Names and colors the orange "Claude" tab group that holds the tabs Claude controls (`tabGroups.update`). Grouping itself (`tabs.group`) needs no permission. |
| `activeTab` | Exposes `tab.url` in the toolbar click handler, so the origin can be passed to `permissions.request` synchronously. The grant is scoped to the user's gesture. |

## optional_permissions (requested only when you click the toolbar button to arm)

| Permission | Why |
|---|---|
| `http://*/*` | Envelope for the per-origin patterns in the arm request (the clicked origin plus the allowlist, e.g. `http://localhost/*`). |
| `https://*/*` | Same, for https origins. |
| `<all_urls>` | `tabs.captureTab` requires it (MDN). It is requested in the same prompt as each arm, so in practice an arm grants all-sites host access. Arming, not this permission, decides what Claude can touch. |

**Lifetime:** with `alwaysOn` (the default), `<all_urls>` is kept once you turn Claude on, so it survives restarts; Alt+Shift+K revokes it. Otherwise, and whenever Claude is off with nothing armed, the extension calls `permissions.remove` on every optional origin.

## Deliberately absent

`tabs`, `storage`, `cookies`, `webRequest`, `webNavigation`, `history`,
`downloads`, `clipboardRead`, `clipboardWrite`, `menus`, `management`,
`content_scripts`, `web_accessible_resources`.

## Other keys

- `content_security_policy`: `script-src 'self'; object-src 'none'`, which rules out `eval` and remote scripts.
- `commands.disarm-all`: Alt+Shift+K disarms every tab and turns Claude off.
- `commands.start-session`: Alt+Shift+C opens the start page to turn Claude on.
- `data_collection_permissions.required: ["none"]`: AMO requires this declaration for new extensions. The extension collects nothing.
