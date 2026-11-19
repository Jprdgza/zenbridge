# zenbridge

[![Install in Zen / Firefox](https://img.shields.io/badge/Install-Zen%20%2F%20Firefox-cba6f7?style=for-the-badge&logo=firefoxbrowser&logoColor=11111b&labelColor=1e1e2e)](https://github.com/Jprdgza/zenbridge/releases/latest)
[![Latest release](https://img.shields.io/github/v/release/Jprdgza/zenbridge?style=for-the-badge&color=cba6f7&labelColor=1e1e2e)](https://github.com/Jprdgza/zenbridge/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Jprdgza/zenbridge/ci.yml?branch=main&style=for-the-badge&label=tests&labelColor=1e1e2e)](https://github.com/Jprdgza/zenbridge/actions/workflows/ci.yml)

Let [Claude Code](https://claude.com/claude-code) drive your real, logged-in
[Zen Browser](https://zen-browser.app) or Firefox: open tabs, read pages,
click, type, fill forms, drag, upload files, read the console and network log,
restyle pages and take screenshots.

> **Unofficial.** zenbridge is a community project. It is not made by, endorsed
> by or affiliated with Anthropic or the Zen Browser team.

There's no network server. The extension talks to a small Python companion app
over Firefox native messaging, and that app talks to the MCP server over a
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
| `navigate`, `reload` | Go somewhere, back or forward / reload |
| `read_page` | Visible text plus up to 100 links |
| `read_tree` | Accessibility tree with `ref_N` handles for each element |
| `find` | Find elements by description ("search box", "submit button") |
| `screenshot` | Viewport PNG, full-page JPEG, or a zoomed-in region |
| `click` | Left, right or middle; double/triple; with modifier keys |
| `hover`, `drag` | Open hover menus; drag and drop |
| `type`, `key` | Type text; press keys and shortcuts (`cmd+a Backspace`, `Enter`) |
| `form_input` | Set a select, checkbox, radio, text field or rich editor directly |
| `scroll` | The page, or the scrollable box around an element |
| `wait_for` | Wait (up to 10 s) for text or an element to appear or go away |
| `file_upload` | Attach local files to a file input or drop zone |
| `console_messages`, `network_requests` | The tab's console output and requests |
| `resize_window` | Resize the browser window |
| `inject_css` | Restyle a page (hide clutter, change layout); `clear` removes it |

Elements can be targeted by `ref` (from `read_tree` or `find`), CSS selector or
viewport coordinates.

Claude only sees tabs it opened itself and tabs you hand to it. Everything else
in your browser is invisible to it.

What it deliberately can't do: run arbitrary JavaScript, read cookies or
storage, read or fill password, one-time-code and card fields, upload files
from anywhere but the project folder, `~/Downloads` and `~/Desktop`, or
inject CSS that loads anything (`url()`, `@import`, ...), since that could leak
page data.

While Claude works in a tab you'll see a soft purple glow, a "Claude is working
in this tab" label, and a cursor that moves to whatever it clicks, types into
or scrolls (colors from [Catppuccin](https://catppuccin.com)). Its tabs are
kept in a **Claude** tab group.

## Install

Requirements:

- macOS or Linux (Linux passes the tests but is less tried; no Windows yet)
- Zen or Firefox 140+
- Python 3.10+ (the `python3` that ships with macOS is 3.9; `brew install python` works)
- Claude Code

1. **Install the add-on.** Click **Install** at the top of this page to get the
   `.xpi` from the [latest release](https://github.com/Jprdgza/zenbridge/releases/latest),
   then drag it onto `about:addons`. Zen and Firefox only install signed builds;
   the release notes say whether a build is signed.

   To build your own instead, sign it as an unlisted add-on with your own
   [AMO API key](https://addons.mozilla.org/developers/addon/api/key/). An add-on ID
   belongs to whoever signs it first, so change `zenbridge@jprdgza.github.io` in
   `extension/manifest.json`, `host/zenbridge_host.py`, `install.sh`, `uninstall.sh`
   and `tests/` first.

   ```bash
   WEB_EXT_API_KEY='user:...' WEB_EXT_API_SECRET='...' npx web-ext@8 sign --channel=unlisted --source-dir extension --artifacts-dir web-ext-artifacts
   ```

2. **Install the companion app and register the MCP server.**

   ```bash
   git clone https://github.com/Jprdgza/zenbridge.git
   ```

   ```bash
   cd zenbridge && ./install.sh
   ```

   This writes the native messaging manifest for Firefox and Zen and pins your
   `python3` in `host/launcher.sh` (override with `PYTHON=/path/to/python3`).
   It then prints the command to register the MCP server. Run it inside each
   project that should be able to use the browser:

   ```bash
   claude mcp add --scope local zenbridge -- /path/to/python3 -I /path/to/zenbridge/server/zenbridge_mcp.py
   ```

   `--scope local` is private to you and that project. (`--scope project` writes
   `.mcp.json` into the repo, so everyone who clones it gets the entry.)

   `./install.sh --global` instead registers it for every Claude Code project and
   for Claude desktop chats (quit and reopen the app afterwards). That's handier,
   but riskier: while Claude is on, any Claude session can then drive your
   logged-in browser, including one started in a repo you just cloned or a chat
   reading a hostile document, and a prompt injection there can too.

3. **Restart the browser.** The add-on's settings page shows "Companion app:
   connected" once everything is in place, and the toolbar button shows a
   yellow **!** if the app is missing. In Claude Code, `/mcp` should list
   `zenbridge` in the projects where you registered it.

## Using it

- **Turn Claude on:** click the zenbridge toolbar button on a new tab (or press
  **Alt+Shift+C**), then click **Turn Claude on** and allow the prompt. The
  button gets an **AI** badge, and Claude can open and drive its own tabs. It
  turns itself off after 8 hours.
- **Hand Claude one of your tabs:** click the toolbar button on that tab (**ON**
  badge). Click again to take it back. Handed-over tabs reset when the browser
  restarts.
- **Turn everything off:** **Alt+Shift+K**. This releases every tab and revokes
  the permission, so Claude stays off until you turn it on again.

### Settings

Open the add-on's settings (`about:addons` → zenbridge → Preferences, or the
link on the Turn Claude on page):

| Setting | Default | |
|---|---|---|
| Go anywhere | off | Let Claude visit any site in its tabs. When off, it stays on the sites you hand it. |
| Stay on across restarts | off | Keep Claude on when the browser restarts. Either way it turns itself off 8 hours after you turned it on, or with Alt+Shift+K. |
| Let Claude use tabs it opens | on | Tabs Claude opens are handed to it automatically, on allowed sites only. |
| Show activity | on | Glow, cursor and highlight while Claude works. |
| Group Claude's tabs | on | Keep Claude's tabs in a "Claude" tab group. |
| Cursor pause | 200 ms | How long the cursor rests on its target before acting. |
| Local addresses | localhost, 127.0.0.1, [::1] | Any port. A tab you hand Claude on one of these may use all of them, and Claude can open them while it's on. A tab on a public site never can, unless you Shift+click to add one, so a page there can't steer Claude into your dev servers. |

## Privacy

- The extension sends nothing over the network itself. Page text, screenshots
  and URLs of the tabs you hand Claude go to the companion app on your computer
  and from there to Claude Code, which sends them to Anthropic as part of your
  conversation. That's why the add-on declares website content and browsing
  activity at install time. `read_tree` includes the values of ordinary form
  fields so Claude can check what it filled in; password, one-time-code and
  card fields are never read.
- The console and network logs are only kept for tabs Claude can see, start
  when Claude first asks for them, and stay in browser memory. Tokens, keys and
  other secret-looking URL parameters are replaced with `REDACTED`.
- Every action is logged locally to `~/Library/Logs/zenbridge/actions.jsonl`
  (`~/.local/state/zenbridge/` on Linux): time, tool, tab, URL and outcome.
  Text Claude types, keys it presses, form values, uploaded file contents and
  CSS it injects are recorded only as a length, URLs are logged with tokens and
  passwords masked, and
  screenshots are never logged. The log rotates at 5 MB, keeping one old file.

```bash
tail -f ~/Library/Logs/zenbridge/actions.jsonl
```

## Security notes

- Nothing listens on a network port. The socket lives in a `0700` directory,
  is `0600`, and the companion app checks that the connecting process belongs
  to you.
- The extension has no content scripts and no message listeners, so web pages
  have nothing to talk to. Page actions are a fixed set of functions injected
  into allowed tabs only, and each one re-checks the page's origin before acting.
- Every message is validated against `schema/tools.json`, in Python in the
  companion app and server and in JS in the extension. Settings are re-checked
  every time they're read.
- Page text, titles and screenshots are wrapped in "untrusted content" markers,
  but prompt injection from web pages is still a real risk. Don't hand Claude
  tabs it doesn't need, especially logged-in ones.
- When Claude is on, any program running as your user that can reach the socket
  can drive Claude's tabs. zenbridge doesn't protect you from malware running
  as you.

## Limitations

- Clicks and key presses are synthetic (`isTrusted=false`), so sites that
  check for that (CAPTCHAs, some payment and login widgets) ignore them. Chrome
  extensions can work around this with a debugger API that Firefox doesn't
  offer. Rich editors like Google Docs may not accept typed text.
- Only the top frame can be clicked or typed into, not iframes.
- A tab in a minimized window or another workspace may not render for a
  screenshot; switch to it and try again.
- With go-anywhere off, screenshots are refused when cross-origin iframes are
  visible.
- The OS file picker, native `<select>` popups and OS dialogs can't be driven;
  use `file_upload` and `form_input` instead.
- Console capture starts the first time Claude asks for it, so messages logged
  while a page first loads can be missed.
- Uploads are limited to 10 files and 10 MB, from the folder Claude Code runs in,
  `~/Downloads` or `~/Desktop`. Add folders with `ZENBRIDGE_UPLOAD_DIRS`
  (`:`-separated), e.g. `claude mcp add -e ZENBRIDGE_UPLOAD_DIRS=/path/one:/path/two ...`.
  Hidden files, `~/Library`, `/private`, `/System`, `/Library`, `/var`, and browser
  password, cookie and keychain files are always refused.
- Several Claude Code sessions can share the browser, but they take turns.

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

Changes per version are in [CHANGELOG.md](CHANGELOG.md). Pushing a `v*` tag publishes a
release; see [docs/releasing.md](docs/releasing.md).

## Uninstall

```bash
./uninstall.sh
```

Then remove the add-on in `about:addons`.

## License

MIT
