# Changelog

Each version here is a tagged release on GitHub with a signed `.xpi`.

## [1.5.3] - 2026-11-19

Fixes from the final round of the outside security review.

- **The "Claude is working" overlay is checked inside each action**, right
  before and right after it, so a page can't put something over it between the
  check and the action. Page popovers or dialogs that open while Claude acts
  are pushed back under the overlay, and a page that keeps doing it gets no more
  actions. If a page still covers it, the action is refused.
- **Local addresses are recognised by address, not just by name.** Home and
  office network addresses (192.168.x, 10.x, 172.16-31.x, 100.64/10, 169.254.x,
  fc00::/7, fe80::/10), IPv4-mapped IPv6 like `[::ffff:127.0.0.1]`, names ending
  in `.local`, `.internal`, `.lan` or `.home.arpa`, single-word names like
  `http://router/`, and public names that point at a local address (checked
  with DNS) all count as local, so Claude asks before moving there from a public
  site. A site that turns out to be served from a local address (DNS rebinding)
  is blocked in tabs Claude controls until you allow it. This adds the `dns` and
  `webRequestBlocking` permissions.
- The Allow window now takes only a mouse click on Allow, never Enter or Space,
  and starts with "Don't allow" focused. The upload prompt shows each file's
  folder (`~/Downloads/report.pdf`), not just its name.
- **Action limit:** more than 600 tool calls in 10 minutes pauses Claude (the
  badge shows **II**) until you click the toolbar button. The action log records
  it with the outcome `paused`.
- Release builds are harder to tamper with: every GitHub Action is pinned to a
  full commit, `web-ext` is pinned exactly with a lockfile, and Dependabot
  proposes updates.

## [1.5.2] - 2026-11-19

Fixes from a second outside security review.

- **Every `file_upload` asks you first**, in a small zenbridge window that shows
  the files, their sizes and the site receiving them. Only your click on Allow
  sends them; Don't allow, closing the window, Alt+Shift+K or 60 seconds without
  an answer refuses the upload. Web pages and the MCP server can't answer it.
- Files that look like keys or credentials (`*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.jks`, `*.kdbx`, `*.ovpn`, `*.tfstate`, `id_rsa`, `id_ed25519`,
  `*credential*`, `*secret*`, `service-account*.json`, ...) are always refused.
- The folder Claude Code runs in is no longer an upload folder by default; add
  it with `ZENBRIDGE_UPLOAD_DIRS` if you want it. The action log records which
  site received each upload.
- **Claude asks before moving between public websites and local addresses**
  (localhost etc.): opening or navigating to a local address after reading a
  public page, the other way round, or opening localhost when you never handed
  Claude a local tab yourself. Each site you allow is asked once until Claude is
  turned off.
- The "Claude is working" overlay can't be hidden or covered by the page. It
  sits in the browser's top layer and is put back if the page removes or
  restyles it. If it still isn't showing, Claude won't act on that page.
- Updating from 1.5.0 or 1.5.1 turns "Stay on across restarts" off once if it was
  saved as on (older versions saved every setting whenever you changed one), and
  a page explains why. The settings page now saves only what you changed.
- `install.sh` without `--global` removes an every-project registration and the
  Claude desktop chat entry left by an older install, and says so;
  `uninstall.sh` removes both, plus the registration for the folder you run it in.
- README: the security notes say plainly that any program running as you can
  use zenbridge while Claude is on.

## [1.5.1] - 2026-11-18

Security fixes from an outside review.

- **`file_upload` only takes files from the folder Claude Code runs in, `~/Downloads`
  and `~/Desktop`** (add more with `ZENBRIDGE_UPLOAD_DIRS`). Browser password, cookie
  and keychain files, `~/Library`, `/private`, `/System`, `/Library` and `/var` are
  always refused. Folders are compared by inode, so changing letter case no longer
  gets around the rules.
- A tab you hand Claude on a public site no longer has your local addresses
  (localhost etc.) in scope. Claude can open them while it's on, or from a tab you
  armed on one.
- "Stay on across restarts" is now off by default, and Claude turns itself off 8
  hours after you turned it on, restarts included.
- `install.sh` registers the MCP server per project by default (it prints the
  command); `./install.sh --global` keeps the old every-project registration.
- URLs in the action log are masked like the network log, and both now also mask
  token-shaped path segments, values and fragments.
- Fields named like API keys, secrets, tokens and SSNs are treated like password
  fields.

## [1.5.0] - 2026-11-17

Most of what Claude in Chrome can do, except running arbitrary JavaScript.

- New tools: `read_tree` (accessibility tree with `ref_N` handles), `find`, `hover`,
  `drag`, `key`, `form_input`, `wait_for`, `file_upload`, `console_messages`,
  `network_requests` and `resize_window`.
- `click`: target by `ref`; right/middle button, double/triple click, modifier keys.
- `type` and `scroll` accept a `ref`; `scroll` can scroll an element into view or
  scroll the box around it, and says which it scrolled.
- `navigate`: `history: "back"` / `"forward"`, and it now waits for the new page
  before returning, so the next action doesn't hit the old one.
- `screenshot`: `region` for a zoomed-in 2× crop.
- New permission: `webRequest` (observe only), for the network log. The log is only
  kept for tabs Claude can see, in memory, with tokens and keys in URLs redacted.
- Password, one-time-code and card fields stay off limits for reading, `form_input`
  and every key press. Uploads refuse hidden files and system folders, up to 10 MB.
- Keys, form values and uploaded data are logged only as a length.

## [1.4.0] - 2026-11-16

First public release.

- Tools: `tabs_list`, `tab_open`, `tab_close`, `tab_switch`, `navigate`, `reload`,
  `read_page`, `screenshot`, `click`, `type`, `scroll` and `inject_css`.
- Claude stays on across restarts once you turn it on (Alt+Shift+K turns it off).
- Settings page: go anywhere, auto-handover of tabs Claude opens, activity cues,
  tab group, cursor pause and local addresses.
- Activity cues (glow, label, cursor) and the "Claude" tab group, in Catppuccin colors.
- Several Claude Code sessions can share one browser; they take turns.
- Action log with typed text and CSS redacted, rotated at 5 MB.
