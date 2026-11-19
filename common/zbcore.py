"""Shared, stdlib-only pieces for the zenbridge host and MCP server.

Schema loading + validation, length-prefixed framing, filesystem paths,
and the peer-UID check for unix sockets. No networking beyond AF_UNIX.
"""
import ctypes
import ctypes.util
import json
import math
import os
import re
import socket
import stat
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "schema", "tools.json"), "rb") as _f:
    SCHEMA = json.load(_f)
LIMITS = SCHEMA["limits"]
MAX_FRAME = LIMITS["maxFrameBytes"]
TOOLS = SCHEMA["tools"]


# ---------------------------------------------------------------- validation
def _type_ok(t, v):
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return (isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v))
    return False


def validate(schema, v, path="$"):
    """Return None if v matches schema, else a short error string."""
    t = schema.get("type")
    if t and not _type_ok(t, v):
        return f"{path}: expected {t}"
    if "enum" in schema and (v not in schema["enum"] or type(v) is not type(schema["enum"][0])):
        return f"{path}: not an allowed value"
    if isinstance(v, str):
        n = len(v.encode("utf-16-le", "surrogatepass")) // 2  # UTF-16 units, as in JS
        if n < schema.get("minLength", 0):
            return f"{path}: too short"
        if n > schema.get("maxLength", 1 << 62):
            return f"{path}: too long"
        # fullmatch: Python's "$" also matches before a trailing newline.
        if "pattern" in schema and not re.fullmatch(schema["pattern"], v):
            return f"{path}: bad format"
    if t in ("integer", "number"):
        if v < schema.get("minimum", -math.inf) or v > schema.get("maximum", math.inf):
            return f"{path}: out of range"
    if t == "array":
        if len(v) > schema.get("maxItems", 1 << 62):
            return f"{path}: too many items"
        if len(v) < schema.get("minItems", 0):
            return f"{path}: too few items"
        for i, item in enumerate(v):
            err = validate(schema.get("items", {}), item, f"{path}[{i}]")
            if err:
                return err
    if t == "object":
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in v:
                return f"{path}: missing {k}"
        for k, item in v.items():
            if k not in props:
                if schema.get("additionalProperties", True) is False:
                    return f"{path}: unknown field {k[:40]}"
                continue
            err = validate(props[k], item, f"{path}.{k}")
            if err:
                return err
        groups = schema.get("x-oneOfGroups")
        for g in groups if isinstance(groups, list) else [groups] if groups else []:
            touched = [grp for grp in g["groups"] if any(k in v for k in grp)]
            if len(touched) > 1 or (not touched and not g.get("optional")):
                word = "at most" if g.get("optional") else "exactly"
                return f"{path}: give {word} one of " + " | ".join("+".join(x) for x in g["groups"])
            if touched and g["complete"] and not all(k in v for k in touched[0]):
                return f"{path}: need all of " + "+".join(touched[0])
    return None


def validate_request(msg):
    err = validate(SCHEMA["envelope"]["request"], msg)
    return err or validate(TOOLS[msg["tool"]]["args"], msg["args"], "$.args")


def validate_response(msg, tool):
    if not isinstance(msg, dict):
        return "$: expected object"
    env = "responseOk" if msg.get("ok") is True else "responseErr"
    err = validate(SCHEMA["envelope"][env], msg)
    if err or env == "responseErr":
        return err
    return validate(TOOLS[tool]["result"], msg["result"], "$.result")


def error(id_, code, message, **extra):
    return {"v": 1, "id": id_, "ok": False, "error": {"code": code, "message": message[:500]}, **extra}


# ------------------------------------------------------------------- framing
class FrameError(Exception):
    pass


# Same rules as zbRedactUrl in extension/logic.js: URLs can carry credentials (OAuth codes, reset
# links, signed URLs), so they are masked before they are logged.
SECRET_PARAM = re.compile(r"token|key|secret|auth|sig|session|passw|pwd|code|credential|jwt|bearer|otp|ticket|nonce", re.I)
URL_PARTS = re.compile(r"^(https?)://([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$", re.I | re.S)


def _unquote(s):
    return re.sub(r"%([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), s.replace("+", " "))


def secret_value(v):
    """True for values that look like tokens: JWTs, long hex/UUIDs, long random base64 (not word slugs)."""
    if not isinstance(v, str) or len(v) < 10:
        return False
    if re.match(r"eyJ[A-Za-z0-9_-]{6,}", v):
        return True
    if len(v) < 20:
        return False
    if re.fullmatch(r"[0-9a-fA-F-]+", v) and len(v.replace("-", "")) >= 16 and re.search(r"[0-9]", v):
        return True
    if not re.fullmatch(r"[A-Za-z0-9_\-+/=.~%]+", v) or not re.search(r"[A-Za-z]", v) or not re.search(r"[0-9]", v):
        return False
    return any(len(run) >= 16 for run in re.findall(r"[A-Za-z0-9]+", v))


def redact_url(url):
    """url with credentials masked: userinfo dropped; secret-named query params and secret-looking path
    segments, query values and fragments -> REDACTED."""
    if not isinstance(url, str):
        return url
    m = URL_PARTS.match(url)
    if not m:
        return "<non-http url>"
    scheme, authority, path, query, frag = m.groups()
    host = authority.rpartition("@")[2]  # drop user:password@
    path = "/".join("REDACTED" if secret_value(_unquote(seg)) else seg for seg in path.split("/"))
    parts = []
    for p in query.split("&") if query else []:
        k, _, v = p.partition("=")
        parts.append(f"{k}=REDACTED" if SECRET_PARAM.search(_unquote(k)) or secret_value(_unquote(v)) else p)
    out = f"{scheme.lower()}://{host}{path}"
    if query is not None:
        out += "?" + "&".join(parts)
    if frag is not None:
        hidden = frag and (SECRET_PARAM.search(frag) or any(secret_value(_unquote(p)) for p in re.split(r"[&=/?]", frag)))
        out += "#" + ("REDACTED" if hidden else frag)
    return out[:2048]


def _read_exact(read, n):
    buf = b""
    while len(buf) < n:
        chunk = read(n - len(buf))
        if not chunk:
            if buf:
                raise FrameError("truncated frame")
            return None
        buf += chunk
    return buf


def read_frame(read):
    """Read one 4-byte native-endian length + UTF-8 JSON frame. None on clean EOF."""
    head = _read_exact(read, 4)
    if head is None:
        return None
    (n,) = struct.unpack("=I", head)
    if n > MAX_FRAME:
        raise FrameError("frame too large")
    body = _read_exact(read, n)
    if body is None:
        raise FrameError("truncated frame")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise FrameError("malformed JSON")


def encode_frame(obj):
    # ASCII-only JSON: lone surrogates from pages stay encodable, control chars are escaped.
    body = json.dumps(obj, separators=(",", ":")).encode("ascii")
    if len(body) > MAX_FRAME:
        raise FrameError("frame too large")
    return struct.pack("=I", len(body)) + body


# --------------------------------------------------------------------- paths
def runtime_dir():
    if os.environ.get("ZENBRIDGE_RUNTIME_DIR"):
        return os.environ["ZENBRIDGE_RUNTIME_DIR"]
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/zenbridge/run")
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if not xdg:
        raise SystemExit("zenbridge: XDG_RUNTIME_DIR is not set")
    return os.path.join(xdg, "zenbridge")


def socket_path():
    return os.path.join(runtime_dir(), "bridge.sock")


def log_path():
    if os.environ.get("ZENBRIDGE_LOG_DIR"):
        d = os.environ["ZENBRIDGE_LOG_DIR"]
    elif sys.platform == "darwin":
        d = os.path.expanduser("~/Library/Logs/zenbridge")
    else:
        d = os.path.expanduser("~/.local/state/zenbridge")
    return os.path.join(d, "actions.jsonl")


def check_owned_socket(path):
    """Client side: refuse a socket (or its dir) not owned by us with private modes."""
    for p, kind, mode in ((os.path.dirname(path), stat.S_ISDIR, 0o700), (path, stat.S_ISSOCK, 0o600)):
        st = os.lstat(p)
        if not kind(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
            raise OSError(f"{p}: unsafe owner/mode")


def sun_path_ok(path):
    limit = 104 if sys.platform == "darwin" else 108
    return len(os.fsencode(path)) < limit


# ------------------------------------------------------------------ peer UID
def peer_uid(sock):
    """UID of the process on the other end of a connected AF_UNIX socket."""
    if sys.platform == "darwin":
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        uid, gid = ctypes.c_uint32(), ctypes.c_uint32()
        if libc.getpeereid(sock.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise OSError(ctypes.get_errno(), "getpeereid failed")
        return uid.value
    creds = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    return struct.unpack("3i", creds)[1]
