#!/bin/sh
# zenbridge uninstaller. Idempotent; prints every path it touches.
#   ./uninstall.sh                   remove manifests, MCP registration, socket dir, log dir
#   ./uninstall.sh --delete-project  also delete this project directory
# The extension itself must be removed in Zen (about:addons); this script cannot do that.
set -eu

EXT_ID="zenbridge@jprdgza.github.io"
ROOT="$(cd "$(dirname "$0")" && pwd -P)"

case "$(uname -s)" in
  Darwin) DIRS="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts
$HOME/Library/Application Support/Zen/NativeMessagingHosts"
          STATE="$HOME/Library/Application Support/zenbridge"
          LOGS="$HOME/Library/Logs/zenbridge" ;;
  Linux) DIRS="$HOME/.mozilla/native-messaging-hosts
$HOME/.zen/native-messaging-hosts"
         STATE="${XDG_RUNTIME_DIR:-/nonexistent}/zenbridge"
         LOGS="$HOME/.local/state/zenbridge" ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac

remove_dir() {  # only plain directories we own, never symlinks
  if [ -L "$1" ]; then echo "   SKIP (symlink): $1"
  elif [ -d "$1" ] && [ -O "$1" ]; then rm -rf -- "$1"; echo "   removed $1"
  else echo "   absent: $1"; fi
}

echo "== native messaging manifests"
echo "$DIRS" | while IFS= read -r dir; do
  f="$dir/zenbridge.json"
  if [ -f "$f" ] && grep -q "$EXT_ID" "$f"; then rm -f -- "$f"; echo "   removed $f"
  else echo "   absent: $f"; fi
done

echo "== Claude Code MCP registration"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user zenbridge >/dev/null 2>&1 && echo "   removed user-scope MCP server 'zenbridge'" \
    || echo "   absent: user-scope MCP server 'zenbridge'"
else
  echo "   'claude' not on PATH; run: claude mcp remove --scope user zenbridge"
fi

echo "== Claude desktop app MCP registration"
case "$(uname -s)" in
  Darwin) CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *) CLAUDE_CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac
if [ -f "$CLAUDE_CFG" ] && command -v python3 >/dev/null 2>&1; then
  python3 -I - "$CLAUDE_CFG" <<'PY' || echo "   could not edit $CLAUDE_CFG; remove mcpServers.zenbridge yourself"
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
servers = cfg.get("mcpServers") if isinstance(cfg, dict) else None
entry = servers.get("zenbridge") if isinstance(servers, dict) else None
if not (isinstance(entry, dict) and any(str(a).endswith("zenbridge_mcp.py") for a in entry.get("args", []))):
    print(f"   absent: zenbridge in {path}")
    sys.exit(0)
del servers["zenbridge"]
tmp = path + ".zenbridge-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print(f"   removed zenbridge from {path}")
PY
else
  echo "   absent: $CLAUDE_CFG"
fi

echo "== socket dir and action log"
remove_dir "$STATE"
remove_dir "$LOGS"

if [ "${1:-}" = "--delete-project" ]; then
  echo "== project directory"
  cd /
  remove_dir "$ROOT"
fi

cat <<EOF
== manual steps left
   1. Zen > about:addons > zenbridge > Remove.
   2. Verify nothing is left (README "Verify nothing is left").
EOF
