#!/bin/sh
# zenbridge installer. Idempotent; prints every path it touches.
# Does NOT install the browser extension itself (that needs signing; see README).
set -eu

GLOBAL=0
for arg in "$@"; do
  case "$arg" in
    --global) GLOBAL=1 ;;
    *) echo "usage: ./install.sh [--global]" >&2; exit 2 ;;
  esac
done

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

if [ "$GLOBAL" = 1 ]; then
echo "== registering MCP server for EVERY project (--global)"
echo "   Any Claude Code session (any repo, including ones you just cloned) and any Claude desktop chat"
echo "   can then use your browser while Claude is on, and so can a prompt injection in that repo or chat."
echo "   Per-project registration (the default) is safer."
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user zenbridge >/dev/null 2>&1 || true
  claude mcp add --scope user zenbridge -- "$PYTHON" -I "$SERVER"
  echo "   claude mcp add --scope user zenbridge -- $PYTHON -I $SERVER"
else
  echo "   'claude' not found on PATH; run manually:"
  echo "   claude mcp add --scope user zenbridge -- $PYTHON -I $SERVER"
fi

echo "== registering MCP server with the Claude desktop app (chats)"
case "$(uname -s)" in
  Darwin) CLAUDE_DESKTOP="$HOME/Library/Application Support/Claude" ;;
  *) CLAUDE_DESKTOP="$HOME/.config/Claude" ;;
esac
if [ -d "$CLAUDE_DESKTOP" ]; then
  "$PYTHON" -I - "$CLAUDE_DESKTOP/claude_desktop_config.json" "$PYTHON" "$SERVER" <<'PY' || echo "   left it alone (see above); add zenbridge under mcpServers yourself"
import json, os, sys
path, python, server = sys.argv[1:4]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except ValueError:
    sys.exit(f"   {path} is not valid JSON")
if not isinstance(cfg, dict) or not isinstance(cfg.get("mcpServers", {}), dict):
    sys.exit(f"   unexpected layout in {path}")
cfg.setdefault("mcpServers", {})["zenbridge"] = {"command": python, "args": ["-I", server]}
tmp = path + ".zenbridge-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print(f"   added zenbridge to {path}; quit and reopen the Claude app to load it")
PY
else
  echo "   Claude desktop app not found; skipped"
fi
else
echo "== removing every-project registrations (use --global to keep them)"
# An older install (or --global) may have registered zenbridge for every Claude Code project and for Claude
# desktop chats. The safe default is per project only, so take those away and say so (ZB-9).
if command -v claude >/dev/null 2>&1; then
  if claude mcp remove --scope user zenbridge >/dev/null 2>&1; then
    echo "   removed: Claude Code user-scope (every project) MCP server 'zenbridge'"
  else
    echo "   none: no user-scope registration"
  fi
else
  echo "   'claude' not on PATH; if you registered it for every project, run: claude mcp remove --scope user zenbridge"
fi
case "$(uname -s)" in
  Darwin) CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *) CLAUDE_CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac
if [ -f "$CLAUDE_CFG" ]; then
  "$PYTHON" -I - "$CLAUDE_CFG" <<'PY' || echo "   could not edit $CLAUDE_CFG; remove mcpServers.zenbridge yourself"
import json, os, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
servers = cfg.get("mcpServers") if isinstance(cfg, dict) else None
entry = servers.get("zenbridge") if isinstance(servers, dict) else None
if not (isinstance(entry, dict) and any(str(a).endswith("zenbridge_mcp.py") for a in entry.get("args", []))):
    print(f"   none: no zenbridge entry in {path}")
    sys.exit(0)
del servers["zenbridge"]
tmp = path + ".zenbridge-tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print(f"   removed: zenbridge from Claude desktop chats ({path}); quit and reopen the Claude app")
PY
else
  echo "   none: no Claude desktop config"
fi
echo "== MCP server: register it only in the projects that need the browser (recommended)"
  echo "   Run this inside each such project (private to you, not written into the repo):"
  echo "   claude mcp add --scope local zenbridge -- $PYTHON -I $SERVER"
  echo "   (--scope project instead writes .mcp.json, shared with everyone who clones the repo.)"
  echo "   To make it available everywhere, including Claude desktop chats: ./install.sh --global"
fi

cat <<EOF
== done
Runtime paths created on first use by the host (not now):
   socket: $HOME/Library/Application Support/zenbridge/run/bridge.sock (macOS)
   log:    $HOME/Library/Logs/zenbridge/actions.jsonl (macOS)
Next: sign and install the extension (README "Install" step 1), then restart Zen.
EOF
