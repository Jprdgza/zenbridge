# zenbridge

Let [Claude Code](https://claude.com/claude-code) drive your real, logged-in
[Zen Browser](https://zen-browser.app) (or Firefox): open tabs, read pages,
click, type, scroll and take screenshots.

There's no network server. The extension talks to a small Python process over
Firefox native messaging, and that process talks to the MCP server over a
same-user unix socket. Everything is Python stdlib and plain JS, with no
dependencies.

```
Claude Code ──stdio──▶ server/zenbridge_mcp.py ──unix socket──▶ host/zenbridge_host.py ──native messaging──▶ extension
```

## What it can do

| Tool | |
|---|---|
| `tabs_list` | Tabs Claude can see, and whether Claude is on |
| `tab_open`, `tab_close`, `tab_switch` | Manage its own tabs |
| `navigate`, `reload` | Go somewhere / reload |
| `read_page` | Visible text plus up to 100 links (never form values) |
| `screenshot` | Viewport PNG or full-page JPEG |
| `click`, `type`, `scroll` | By CSS selector or viewport coordinates |

Claude only sees tabs it opened itself and tabs you hand to it. Everything else
in your browser is invisible to it.

What it deliberately can't do: run arbitrary JavaScript, read cookies or
storage, read form values, or type into password, one-time-code and card fields.

While Claude works in a tab you'll see an orange glow, a "Claude is working in
this tab" label, and a cursor that moves to whatever it clicks, types into or
scrolls. Its tabs are kept in an orange **Claude** tab group.

## Install

Requirements: macOS (Linux paths are included but untested), Zen or Firefox
140+, Python 3.10+, and Claude Code.

1. **Sign the extension.** Firefox only installs signed add-ons, so sign it as
   an unlisted add-on with your own [AMO API key](https://addons.mozilla.org/developers/addon/api/key/).
   The add-on ID is tied to whoever signs it first, so if you're not me, change
   `zenbridge@jprdgza.github.io` to your own ID in `extension/manifest.json`,
   `host/zenbridge_host.py`, `install.sh`, `uninstall.sh` and `tests/`.

   ```bash
   WEB_EXT_API_KEY='user:...' WEB_EXT_API_SECRET='...' npx web-ext@8 sign --channel=unlisted --source-dir extension --artifacts-dir web-ext-artifacts
   ```

   Then open `web-ext-artifacts/*.xpi` in Zen and click **Add**.

2. **Install the native host and register the MCP server.**

   ```bash
   ./install.sh
   ```

   This writes the native messaging manifest for Mozilla and Zen, pins your
   `python3` in `host/launcher.sh` (override with `PYTHON=/path/to/python3`),
   and runs `claude mcp add --scope user zenbridge ...`.

3. **Restart Zen**, then run `/mcp` in Claude Code to check that `zenbridge` is
   connected.

## Using it

- **Turn Claude on:** click the zenbridge toolbar button on a new tab (or press
  **Alt+Shift+C**), then click **Turn Claude on** and allow the prompt. The
  button gets an orange **AI** badge. Claude stays on across restarts.
- **Hand Claude one of your tabs:** click the toolbar button on that tab (red
  **ON** badge). Click again to take it back. Handed-over tabs reset when the
  browser restarts.
- **Turn everything off:** **Alt+Shift+K**. This releases every tab and revokes
  the permission, so Claude stays off until you turn it on again.

Settings live in `extension/config.js` (no settings UI): `alwaysOn`,
`goAnywhere` (off restricts Claude to localhost plus sites you hand it),
`showActivity`, `tabGroup`, `cursorDelayMs`. Bump the version in
`manifest.json` and re-sign after changing them.

## Security notes

- Nothing listens on a network port. The socket lives in a `0700` directory,
  is `0600`, and the host checks that the connecting process belongs to you.
- The extension has no content scripts and no message listeners, so web pages
  have nothing to talk to. Page actions are a fixed set of functions injected
  into allowed tabs only, and each one re-checks the page's origin before acting.
- Every message is validated against `schema/tools.json`, in Python on the host
  and server and in JS in the extension.
- Page text, titles and screenshots are wrapped in "untrusted content" markers,
  but prompt injection from web pages is still a real risk. Don't hand Claude
  tabs it doesn't need, especially logged-in ones.
- When Claude is on, any program running as your user that can reach the socket
  can drive Claude's tabs. zenbridge doesn't protect you from malware running
  as you.

## Action log

Every action is appended to `~/Library/Logs/zenbridge/actions.jsonl`, one
JSON object per line with the time, tool, tab, URL, arguments and outcome.
Screenshot data is never logged.

```bash
tail -f ~/Library/Logs/zenbridge/actions.jsonl
```

## Limitations

- Clicks and key presses are synthetic (`isTrusted=false`), so sites that
  check for that (CAPTCHAs, some payment and login widgets) will ignore them.
  Rich editors like Google Docs may not accept typed text.
- Only the top frame can be clicked or typed into, not iframes.
- In restricted mode, screenshots are refused when cross-origin iframes are
  visible.
- File pickers, native `<select>` popups and OS dialogs can't be driven.

## Development

```bash
python3 -m unittest discover -s tests
```

```bash
cd tests/js && node --test
```

`schema/tools.json` is the single source of truth. After editing it, run
`python3 gen_schema.py` to regenerate `extension/schema.js` (a test checks they
match). `extension/manifest.README.md` explains each permission.

## Uninstall

```bash
./uninstall.sh
```

Then remove the add-on in `about:addons`.

## License

MIT
