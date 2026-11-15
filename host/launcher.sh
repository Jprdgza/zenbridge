#!/bin/sh
# Zen starts native hosts with a minimal PATH, so the interpreter is absolute.
# -I: isolated mode (ignores PYTHON* env vars, user site-packages and the cwd).
exec /usr/bin/python3 -I "$(dirname "$0")/zenbridge_host.py" "$@"
