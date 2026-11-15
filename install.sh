#!/bin/sh
# zenbridge installer. Idempotent; prints every path it touches.
# Does NOT install the browser extension itself (that needs signing; see README).
set -eu

EXT_ID="zenbridge@jprdgza.github.io"
# Python 3.10+. Override with: PYTHON=/path/to/python3 ./install.sh
PYTHON="${PYTHON:-$(command -v python3 || true)}"
[ -n "$PYTHON" ] || { echo "python3 not found; set PYTHON=/path/to/python3" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
LAUNCHER="$ROOT/host/launcher.sh"
SERVER="$ROOT/server/zenbridge_mcp.py"

case "$(uname -s)" in
  Darwin) DIRS="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts
$HOME/Library/Application Support/Zen/NativeMessagingHosts" ;;
  Linux) DIRS="$HOME/.mozilla/native-messaging-hosts
$HOME/.zen/native-messaging-hosts" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$PYTHON" in /*) ;; *) echo "PYTHON must be an absolute path" >&2; exit 1 ;; esac

echo "== checking python: $PYTHON"
"$PYTHON" -I -c 'import sys; assert sys.version_info >= (3, 10), sys.version' \
  || { echo "need python >= 3.10 at $PYTHON (set PYTHON=/path/to/python3)" >&2; exit 1; }

# Browsers start native hosts with a minimal PATH, so pin the absolute interpreter path.
echo "== pinning $PYTHON in host/launcher.sh"
TMP="$(mktemp "$ROOT/host/.launcher.XXXXXX")"
sed "s#^exec [^ ]* -I #exec $PYTHON -I #" "$LAUNCHER" > "$TMP" && mv -f "$TMP" "$LAUNCHER"

echo "== making host executable"
chmod 755 "$LAUNCHER" "$ROOT/host/zenbridge_host.py" "$SERVER"
echo "   chmod 755 $LAUNCHER"

echo "== writing native messaging manifests"
MANIFEST=$(cat <<EOF
{
  "name": "zenbridge",
  "description": "zenbridge native messaging host",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
)
echo "$DIRS" | while IFS= read -r dir; do
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST" > "$dir/zenbridge.json"
  chmod 644 "$dir/zenbridge.json"
  echo "   wrote $dir/zenbridge.json"
done

echo "== registering MCP server with Claude Code (user scope)"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user zenbridge >/dev/null 2>&1 || true
  claude mcp add --scope user zenbridge -- "$PYTHON" -I "$SERVER"
  echo "   claude mcp add --scope user zenbridge -- $PYTHON -I $SERVER"
else
  echo "   'claude' not found on PATH; run manually:"
  echo "   claude mcp add --scope user zenbridge -- $PYTHON -I $SERVER"
fi

cat <<EOF
== done
Runtime paths created on first use by the host (not now):
   socket: $HOME/Library/Application Support/zenbridge/run/bridge.sock (macOS)
   log:    $HOME/Library/Logs/zenbridge/actions.jsonl (macOS)
Next: sign and install the extension (README "Install" step 1), then restart Zen.
EOF
