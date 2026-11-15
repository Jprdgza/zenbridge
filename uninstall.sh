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
