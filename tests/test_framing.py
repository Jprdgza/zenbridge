import io
import struct
import unittest

from helpers import rid  # noqa: F401  (sets sys.path)
import zbcore


class FramingTest(unittest.TestCase):
    def test_round_trip(self):
        msg = {"v": 1, "id": rid(), "tool": "tabs_list", "args": {}, "u": "héllo ✓"}
        buf = io.BytesIO(zbcore.encode_frame(msg) + zbcore.encode_frame({"a": 2}))
        self.assertEqual(zbcore.read_frame(buf.read), msg)
        self.assertEqual(zbcore.read_frame(buf.read), {"a": 2})
        self.assertIsNone(zbcore.read_frame(buf.read))

    def test_native_endian_length(self):
        frame = zbcore.encode_frame({})
        self.assertEqual(struct.unpack("=I", frame[:4])[0], 2)

    def test_oversize_rejected_on_read(self):
        buf = io.BytesIO(struct.pack("=I", zbcore.MAX_FRAME + 1) + b"x" * 10)
        with self.assertRaisesRegex(zbcore.FrameError, "too large"):
            zbcore.read_frame(buf.read)

    def test_oversize_rejected_on_write(self):
        with self.assertRaises(zbcore.FrameError):
            zbcore.encode_frame({"x": "a" * zbcore.MAX_FRAME})

    def test_malformed_json(self):
        for body in (b"{not json", b"\xff\xfe\x00", b""):
            with self.subTest(body=body), self.assertRaisesRegex(zbcore.FrameError, "malformed"):
                zbcore.read_frame(io.BytesIO(struct.pack("=I", len(body)) + body).read)

    def test_deep_nesting_is_malformed_not_crash(self):
        body = b"[" * 200000
        with self.assertRaisesRegex(zbcore.FrameError, "malformed"):
            zbcore.read_frame(io.BytesIO(struct.pack("=I", len(body)) + body).read)

    def test_lone_surrogate_round_trips_as_ascii(self):
        frame = zbcore.encode_frame({"t": "\ud800\u202e"})
        self.assertTrue(frame[4:].isascii())
        self.assertEqual(zbcore.read_frame(io.BytesIO(frame).read), {"t": "\ud800\u202e"})

    def test_truncated_header_and_body(self):
        with self.assertRaisesRegex(zbcore.FrameError, "truncated"):
            zbcore.read_frame(io.BytesIO(b"\x05\x00").read)
        with self.assertRaisesRegex(zbcore.FrameError, "truncated"):
            zbcore.read_frame(io.BytesIO(struct.pack("=I", 10) + b"{}").read)

    def test_chunked_reader(self):
        data = zbcore.encode_frame({"k": "v" * 100})
        src = io.BytesIO(data)
        self.assertEqual(zbcore.read_frame(lambda n: src.read(min(n, 3))), {"k": "v" * 100})


if __name__ == "__main__":
    unittest.main()
