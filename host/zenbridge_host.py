#!/usr/bin/env python3
"""zenbridge native messaging host.

Zen launches this via launcher.sh. It relays validated requests from one
same-UID client on a unix socket to the extension over stdio, logs every
action, and exits when the browser closes stdin. Nothing but frames on stdout.
"""
import datetime
import fcntl
import json
import os
import socket
import stat
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common"))
import zbcore  # noqa: E402

EXTENSION_ID = "zenbridge@jprdgza.github.io"
NO_ID = "0" * 16


def log_err(msg):
    sys.stderr.write(f"zenbridge-host: {msg}\n")
    sys.stderr.flush()


class SetupError(Exception):
    pass


def _check_owned(st, kind, mode):
    if not kind(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
        raise SetupError(f"unsafe type/owner/mode {oct(stat.S_IMODE(st.st_mode))}, expected {oct(mode)}")


def ensure_private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        _check_owned(os.lstat(path), stat.S_ISDIR, 0o700)
    except SetupError as e:
        raise SetupError(f"{path}: {e}")


def bind_unix_socket(path):
    """Create the listening AF_UNIX socket with 0700 dir / 0600 socket; fail closed.

    Returns (server socket, (dev, ino) of the socket file, lock fd to keep open)."""
    os.umask(0o077)
    if not zbcore.sun_path_ok(path):
        raise SetupError(f"socket path too long for sun_path: {path}")
    ensure_private_dir(os.path.dirname(path))
    # Held for the process lifetime: serializes probe/unlink/bind between hosts (e.g. two profiles).
    lock = os.open(os.path.join(os.path.dirname(path), "bridge.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SetupError("another zenbridge host holds the lock; is a second Zen profile running?")
        srv, ident = _bind_locked(path)
    except BaseException:
        os.close(lock)
        raise
    return srv, ident, lock


def _bind_locked(path):
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        st = None
    if st is not None:
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
            raise SetupError(f"{path} exists and is not our socket; refusing to remove it")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(path)
            raise SetupError(f"another zenbridge host is already listening on {path}")
        except (ConnectionRefusedError, FileNotFoundError):
            os.unlink(path)  # stale: ours, and nobody is listening
        finally:
            probe.close()
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    os.chmod(path, 0o600)
    st = os.lstat(path)
    try:
        _check_owned(st, stat.S_ISSOCK, 0o600)
    except SetupError as e:
        srv.close()
        os.unlink(path)
        raise SetupError(f"{path}: {e}")
    srv.listen(1)
    return srv, (st.st_dev, st.st_ino)


LOG_MAX_BYTES = 5 * 1024 * 1024  # then actions.jsonl -> actions.jsonl.1 (one old file kept)
REDACTED_ARGS = ("text", "css", "keys", "value", "data")  # typed, filled, injected or uploaded: only the length is logged


def redact(args):
    out = {}
    for k, v in args.items():
        if k in REDACTED_ARGS and isinstance(v, str):
            v = f"<{len(v)} chars>"
        elif k == "url" and isinstance(v, str):
            v = zbcore.redact_url(v)  # navigate / tab_open: tokens in URLs never reach the log
        out[k] = v
    return out


class ActionLog:
    def __init__(self, path, max_bytes=LOG_MAX_BYTES):
        ensure_private_dir(os.path.dirname(path))
        self.path, self.max_bytes = path, max_bytes
        self.fd = self._open()
        self.lock = threading.Lock()

    def _open(self):
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        return fd

    def write(self, tool, args, outcome, tab_url=None, reason=None, **extra):
        args = redact(args) if isinstance(args, dict) else {}
        if outcome == "invalid" and len(json.dumps(args)) > 4096:
            args = {"truncated": json.dumps(args)[:4096]}  # unvalidated input: bound it
        entry = {
            "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"),
            "tool": tool[:64] if isinstance(tool, str) else None,
            "tabId": args.get("tabId"),
            "url": zbcore.redact_url(tab_url) if tab_url else tab_url,
            "args": args,
            "outcome": outcome,
        }
        if reason:
            entry["reason"] = reason
        entry.update(extra)
        # ensure_ascii: control/bidi characters are escaped, never written raw to the terminal.
        line = (json.dumps(entry) + "\n").encode("ascii")
        with self.lock:
            if os.fstat(self.fd).st_size + len(line) > self.max_bytes:
                os.close(self.fd)
                os.replace(self.path, self.path + ".1")
                self.fd = self._open()
            os.write(self.fd, line)


class Host:
    def __init__(self, ext_read, ext_write, log, uid=None, peer_uid=zbcore.peer_uid):
        self.ext_read, self.ext_write = ext_read, ext_write
        self.log, self.uid, self.peer_uid = log, os.getuid() if uid is None else uid, peer_uid
        self.out_lock, self.pending_lock = threading.Lock(), threading.Lock()
        self.pending = {}  # id -> [threading.Event, response]
        self.client = None

    # -- extension side (stdio) --
    def run_extension_reader(self):
        """Read extension responses until stdin closes. Runs on the main thread."""
        while True:
            try:
                msg = zbcore.read_frame(self.ext_read)
            except zbcore.FrameError as e:
                log_err(f"bad frame from extension: {e}; exiting")
                return
            if msg is None:
                return
            mid = msg.get("id") if isinstance(msg, dict) else None
            with self.pending_lock:
                slot = self.pending.get(mid) if isinstance(mid, str) else None
            if slot is None:
                ok = msg.get("ok") if isinstance(msg, dict) else None
                self.log.write(None, None, "late_reply", reason=f"id={str(mid)[:64]} ok={ok!r}")
                continue
            slot[1] = msg
            slot[0].set()

    def call_extension(self, req):
        timeout = zbcore.timeout_for(req["tool"])
        slot = [threading.Event(), None]
        with self.pending_lock:
            if req["id"] in self.pending:
                return zbcore.error(req["id"], "INVALID", "duplicate request id")
            self.pending[req["id"]] = slot
        try:
            with self.out_lock:
                self.ext_write(zbcore.encode_frame(req))
            if not slot[0].wait(timeout):
                return zbcore.error(req["id"], "TIMEOUT", f"extension did not answer within {timeout}s")
        finally:
            with self.pending_lock:
                self.pending.pop(req["id"], None)
        resp = slot[1]
        err = zbcore.validate_response(resp, req["tool"])
        if err or resp["id"] != req["id"]:
            return zbcore.error(req["id"], "INTERNAL", f"invalid response from extension ({err or 'id mismatch'})")
        return resp

    # -- client side (unix socket) --
    def handle_request(self, req):
        err = zbcore.validate_request(req)
        if err:
            rid = req.get("id") if isinstance(req, dict) else None
            ok_id = isinstance(rid, str) and zbcore.validate(zbcore.SCHEMA["envelope"]["request"]["properties"]["id"], rid) is None
            self.log.write(req.get("tool") if isinstance(req, dict) else None,
                           req.get("args") if isinstance(req, dict) else None, "invalid", reason=err)
            return zbcore.error(rid if ok_id else NO_ID, "INVALID", err)
        resp = self.call_extension(req)
        tab_url = resp.get("tabUrl") if isinstance(resp.get("tabUrl"), str) else None
        extra = {"id": req["id"]}
        if resp["ok"]:
            res = resp["result"]
            if req["tool"] == "tab_open":
                extra["openedTabId"] = res["tabId"]
            if req["tool"] == "reload":
                extra["reloadedTabIds"] = res["reloaded"]
            if req["tool"] == "file_upload":  # where the files went, and how much (never the content)
                extra.update(origin=res["origin"], files=res["files"], bytes=res["bytes"])
            self.log.write(req["tool"], req["args"], "ok", tab_url, **extra)
        else:
            e = resp["error"]
            # A timed-out action may still have run in the browser; a late reply is logged by id.
            # PAUSED: the per-session action cap (ZB-14) tripped, or Claude is still paused after it did.
            outcome = {"TIMEOUT": "timeout", "PAUSED": "paused"}.get(e["code"], "refused")
            self.log.write(req["tool"], req["args"], outcome, tab_url, f"{e['code']}: {e['message']}", **extra)
        return resp

    def serve_client(self, conn):
        try:
            while True:
                try:
                    req = zbcore.read_frame(conn.recv)
                except zbcore.FrameError as e:
                    self.log.write(None, None, "invalid", reason=f"socket frame: {e}")
                    conn.sendall(zbcore.encode_frame(zbcore.error(NO_ID, "INVALID", str(e))))
                    return
                if req is None:
                    return
                try:
                    resp = self.handle_request(req)
                except Exception as e:  # never let one request kill the client thread
                    log_err(f"internal error: {e!r}")
                    resp = zbcore.error(NO_ID, "INTERNAL", "host error")
                conn.sendall(zbcore.encode_frame(resp))
        except OSError as e:
            log_err(f"client connection error: {e}")
        finally:
            conn.close()
            self.client = None

    def accept_loop(self, srv):
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            try:
                uid = self.peer_uid(conn)
            except OSError:
                uid = None
            if uid != self.uid:
                self.log.write(None, None, "refused", reason=f"peer uid {uid} != {self.uid}")
                conn.close()
                continue
            if self.client is not None:
                self.log.write(None, None, "refused", reason="second client rejected")
                try:
                    conn.sendall(zbcore.encode_frame(zbcore.error(NO_ID, "REFUSED", "another client is already connected")))
                finally:
                    conn.close()
                continue
            self.client = conn
            threading.Thread(target=self.serve_client, args=(conn,), daemon=True).start()


def main():
    if len(sys.argv) < 3 or sys.argv[2] != EXTENSION_ID:
        log_err("must be launched by Firefox/Zen for extension " + EXTENSION_ID)
        return 2
    ext_out = os.fdopen(os.dup(1), "wb", buffering=0)
    sys.stdout = sys.stderr  # nothing but frames may reach the real stdout

    def ext_write(data):
        ext_out.write(data)
        ext_out.flush()

    path = zbcore.socket_path()
    try:
        log = ActionLog(zbcore.log_path())
        srv, ident, _lock = bind_unix_socket(path)
    except (SetupError, OSError) as e:
        log_err(str(e))
        return 1
    host = Host(sys.stdin.buffer.read, ext_write, log)
    threading.Thread(target=host.accept_loop, args=(srv,), daemon=True).start()
    try:
        host.run_extension_reader()
    finally:
        srv.close()
        try:
            st = os.lstat(path)
            if (st.st_dev, st.st_ino) == ident:
                os.unlink(path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
