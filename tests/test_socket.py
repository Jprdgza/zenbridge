import os
import socket
import stat
import threading
import time
import unittest

from helpers import rid, short_tmpdir
import zbcore
import zenbridge_host as zh


def mode(p):
    return stat.S_IMODE(os.lstat(p).st_mode)


class NullLog:
    def __init__(self):
        self.lines = []

    def write(self, *a, **k):
        self.lines.append((a, k))


class BindTest(unittest.TestCase):
    def setUp(self):
        self.base = short_tmpdir(self)
        self.path = os.path.join(self.base, "run", "bridge.sock")

    def bind(self):
        srv, _, lock = zh.bind_unix_socket(self.path)
        self.addCleanup(srv.close)
        self.addCleanup(os.close, lock)
        return srv

    def test_modes(self):
        self.bind()
        self.assertEqual(mode(os.path.dirname(self.path)), 0o700)
        self.assertEqual(mode(self.path), 0o600)
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.path).st_mode))

    def test_existing_dir_with_wrong_mode_fails_closed(self):
        os.makedirs(os.path.dirname(self.path))
        os.chmod(os.path.dirname(self.path), 0o755)
        with self.assertRaisesRegex(zh.SetupError, "mode"):
            zh.bind_unix_socket(self.path)

    def test_path_too_long(self):
        long = os.path.join(self.base, "d" * 120, "bridge.sock")
        with self.assertRaisesRegex(zh.SetupError, "sun_path"):
            zh.bind_unix_socket(long)

    def test_stale_socket_removed(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(self.path)
        s.close()  # leaves a dead socket file behind
        self.bind()
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.connect(self.path)
        c.close()

    def test_live_socket_not_stolen(self):
        self.bind()
        with self.assertRaisesRegex(zh.SetupError, "holds the lock"):
            zh.bind_unix_socket(self.path)

    def test_live_socket_without_lock_not_stolen(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        other = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        other.bind(self.path)
        other.listen(1)
        self.addCleanup(other.close)
        with self.assertRaisesRegex(zh.SetupError, "already listening"):
            zh.bind_unix_socket(self.path)

    def test_non_socket_file_not_removed(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        with open(self.path, "w") as f:
            f.write("keep me")
        with self.assertRaisesRegex(zh.SetupError, "not our socket"):
            zh.bind_unix_socket(self.path)
        with open(self.path) as f:
            self.assertEqual(f.read(), "keep me")

    def test_symlink_not_followed(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        target = os.path.join(self.base, "target")
        open(target, "w").close()
        os.symlink(target, self.path)
        with self.assertRaises(zh.SetupError):
            zh.bind_unix_socket(self.path)
        self.assertTrue(os.path.exists(target))


class PeerTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(short_tmpdir(self), "run", "bridge.sock")
        self.srv, _, lock = zh.bind_unix_socket(self.path)
        self.addCleanup(self.srv.close)
        self.addCleanup(os.close, lock)

    def start_host(self, **kw):
        self.log = NullLog()
        sent = []
        host = zh.Host(lambda n: b"", sent.append, self.log, **kw)
        threading.Thread(target=host.accept_loop, args=(self.srv,), daemon=True).start()
        return host

    def connect(self):
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.settimeout(5)
        c.connect(self.path)
        self.addCleanup(c.close)
        return c

    def test_real_peer_uid(self):
        a, b = socket.socketpair(socket.AF_UNIX)
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        self.assertEqual(zbcore.peer_uid(a), os.getuid())

    def test_mismatched_uid_rejected(self):
        self.start_host(peer_uid=lambda s: os.getuid() + 1)
        c = self.connect()
        self.assertEqual(c.recv(10), b"")  # closed without a reply
        time.sleep(0.05)
        self.assertIn("peer uid", self.log.lines[0][1]["reason"])

    def test_peer_uid_error_rejected(self):
        def boom(s):
            raise OSError("no creds")
        self.start_host(peer_uid=boom)
        self.assertEqual(self.connect().recv(10), b"")

    def test_second_client_rejected(self):
        host = self.start_host()
        first = self.connect()
        for _ in range(100):
            if host.client is not None:
                break
            time.sleep(0.01)
        second = self.connect()
        resp = zbcore.read_frame(second.recv)
        self.assertEqual(resp["error"]["code"], "REFUSED")
        first.sendall(zbcore.encode_frame({"v": 1, "id": rid(), "tool": "nope", "args": {}}))
        self.assertEqual(zbcore.read_frame(first.recv)["error"]["code"], "INVALID")  # first still served

    def test_client_slot_freed_after_disconnect(self):
        host = self.start_host()
        first = self.connect()
        for want_none in (False, True):  # wait until accepted, then until released
            if want_none:
                first.close()
            for _ in range(200):
                if (host.client is None) == want_none:
                    break
                time.sleep(0.01)
        c = self.connect()
        c.sendall(zbcore.encode_frame({"v": 1, "id": rid(), "tool": "x", "args": {}}))
        self.assertEqual(zbcore.read_frame(c.recv)["error"]["code"], "INVALID")

    def test_garbage_frame_closes_connection(self):
        self.start_host()
        c = self.connect()
        c.sendall(b"\xff\xff\xff\x7f")
        self.assertEqual(zbcore.read_frame(c.recv)["error"]["code"], "INVALID")
        self.assertIsNone(zbcore.read_frame(c.recv))


if __name__ == "__main__":
    unittest.main()
