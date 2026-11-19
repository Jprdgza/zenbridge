# Changelog

Each version here is a tagged release on GitHub with a signed `.xpi`.

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
