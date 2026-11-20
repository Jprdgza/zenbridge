import fcntl
import io
import json
import subprocess
import os
import stat
import unittest
from unittest import mock

from helpers import ROOT, rid, short_tmpdir
import zenbridge_host as zh


class LogTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(short_tmpdir(self), "logs", "actions.jsonl")

    def lines(self):
        with open(self.path) as f:
            return [json.loads(x) for x in f]

    def test_modes_and_flags(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(self.path)).st_mode), 0o700)
        self.assertTrue(fcntl.fcntl(log.fd, fcntl.F_GETFL) & os.O_APPEND)

    def test_existing_file_mode_tightened(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        with open(self.path, "w") as f:
            f.write('{"old": true}\n')
        os.chmod(self.path, 0o644)
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        log.write("reload", {"urlPattern": "*"}, "ok")
        self.assertEqual(self.lines()[0], {"old": True})  # append-only: old content kept
        self.assertEqual(len(self.lines()), 2)

    def test_one_line_per_action_with_fields(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        log.write("click", {"tabId": 7, "selector": "#a"}, "ok", "http://localhost:3000/")
        log.write("navigate", {"tabId": 7, "url": "https://evil.test/"}, "refused", None, "OUT_OF_SCOPE: nope")
        a, b = self.lines()
        self.assertEqual(set(a), {"ts", "tool", "tabId", "url", "args", "outcome"})
        self.assertEqual((a["tool"], a["tabId"], a["url"], a["outcome"]), ("click", 7, "http://localhost:3000/", "ok"))
        self.assertEqual((b["outcome"], b["reason"]), ("refused", "OUT_OF_SCOPE: nope"))

    def test_invalid_request_logged(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        host = zh.Host(lambda n: b"", lambda b: None, log)
        resp = host.handle_request({"v": 1, "id": rid(), "tool": "eval", "args": {"code": "1"}})
        self.assertEqual(resp["error"]["code"], "INVALID")
        (line,) = self.lines()
        self.assertEqual((line["tool"], line["outcome"]), ("eval", "invalid"))

    def test_timeout_then_late_reply_logged(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        sent = []
        host = zh.Host(lambda n: b"", sent.append, log)
        with mock.patch.dict(zh.zbcore.LIMITS, {"timeoutSeconds": 0.05}):
            resp = host.handle_request({"v": 1, "id": rid(7), "tool": "tab_close", "args": {"tabId": 3}})
        self.assertEqual(resp["error"]["code"], "TIMEOUT")
        late = zh.zbcore.encode_frame({"v": 1, "id": rid(7), "ok": True, "result": {"tabId": 3}})
        host.ext_read = io.BytesIO(late).read
        host.run_extension_reader()
        a, b = self.lines()
        self.assertEqual((a["outcome"], a["id"]), ("timeout", rid(7)))
        self.assertEqual(b["outcome"], "late_reply")
        self.assertIn(rid(7), b["reason"])

    def test_opened_tab_id_logged_and_lines_ascii_bounded(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        host = zh.Host(lambda n: b"", lambda b: None, log)
        host.call_extension = lambda req: {"v": 1, "id": req["id"], "ok": True, "result": {"tabId": 42, "armed": False, "note": "n"}}
        host.handle_request({"v": 1, "id": rid(), "tool": "tab_open", "args": {"url": "http://localhost:3000/"}})
        host.handle_request({"v": 1, "id": rid(2), "tool": "eval\u202e\x9b", "args": {"x": "y" * 100000}})
        with open(self.path, "rb") as f:
            raw = f.read()
        self.assertTrue(raw.isascii())
        a, b = self.lines()
        self.assertEqual(a["openedTabId"], 42)
        self.assertLess(len(json.dumps(b)), 6000)

    def test_upload_logs_the_receiving_origin(self):
        """ZB-7: every upload records where the files went (and how many, how big), never their content."""
        log = zh.ActionLog(self.path)
        self.addCleanup(os.close, log.fd)
        host = zh.Host(lambda n: b"", lambda b: None, log)
        host.call_extension = lambda req: {"v": 1, "id": req["id"], "ok": True, "tabUrl": "https://jobs.example/apply?token=abcdefghijklmnopqrstuvwxyz123456",
                                           "result": {"files": 1, "bytes": 2048, "target": "input", "origin": "https://jobs.example"}}
        host.handle_request({"v": 1, "id": rid(), "tool": "file_upload", "args": {"tabId": 4, "ref": "ref_1", "uploads": ["a" * 32]}})
        host.call_extension = lambda req: {"v": 1, "id": req["id"], "ok": False, "tabUrl": "https://evil.example/form",
                                           "error": {"code": "REFUSED", "message": "the user did not allow this upload"}}
        host.handle_request({"v": 1, "id": rid(2), "tool": "file_upload", "args": {"tabId": 4, "ref": "ref_1", "uploads": ["b" * 32]}})
        ok, refused = self.lines()
        self.assertEqual((ok["origin"], ok["files"], ok["bytes"]), ("https://jobs.example", 1, 2048))
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz123456", json.dumps(ok))
        self.assertEqual(refused["outcome"], "refused")
        self.assertTrue(refused["url"].startswith("https://evil.example/"))

    def test_confirm_tools_wait_longer_than_the_question(self):
        """The host must still be waiting when you answer zenbridge's 60 s question."""
        limits = zh.zbcore.LIMITS
        for tool in ("file_upload", "tab_open", "navigate"):
            self.assertGreater(zh.zbcore.timeout_for(tool), limits["confirmTimeoutSeconds"], tool)
        self.assertEqual(zh.zbcore.timeout_for("click"), limits["timeoutSeconds"])
        self.assertEqual(zh.zbcore.timeout_for("screenshot"), limits["screenshotTimeoutSeconds"])

    def test_typed_text_and_css_are_not_logged(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(lambda: os.close(log.fd))
        log.write("type", {"tabId": 1, "text": "my secret message", "key": "Enter"}, "ok")
        log.write("inject_css", {"tabId": 1, "css": "body{color:red}"}, "ok")
        log.write("type", {"tabId": 1, "text": "x" * 9000}, "invalid")
        log.write("key", {"tabId": 1, "keys": "h u n t e r 2"}, "ok")
        log.write("form_input", {"tabId": 1, "ref": "ref_1", "value": "my address"}, "ok")
        log.write("upload_chunk", {"uploadId": "a" * 32, "index": 0, "total": 1, "name": "a.txt", "mimeType": "text/plain", "data": "c2VjcmV0"}, "ok")
        with open(self.path) as f:
            raw = f.read()
        for leaked in ("secret", "color:red", "hunter", "my address", "c2VjcmV0"):
            self.assertNotIn(leaked, raw)
        a, b, c, d, e, f_ = self.lines()
        self.assertEqual(d["args"]["keys"], "<13 chars>")
        self.assertEqual(e["args"]["value"], "<10 chars>")
        self.assertEqual(f_["args"]["data"], "<8 chars>")
        self.assertEqual(a["args"], {"tabId": 1, "text": "<17 chars>", "key": "Enter"})
        self.assertEqual(b["args"]["css"], "<15 chars>")
        self.assertEqual(c["args"]["text"], "<9000 chars>")

    def test_urls_in_log_are_redacted(self):
        log = zh.ActionLog(self.path)
        self.addCleanup(lambda: os.close(log.fd))
        log.write("navigate", {"tabId": 1, "url": "https://user:pw@app.example/cb?code=OAUTHCODE&state=ok#access_token=TOK"}, "ok",
                  tab_url="https://app.example/reset?token=RESETTOKEN&page=2")
        log.write("tab_open", {"url": "https://app.example/x?Session=S3SS"}, "ok")
        with open(self.path) as f:
            raw = f.read()
        for leaked in ("OAUTHCODE", "TOK", "RESETTOKEN", "S3SS", "pw@", "user:"):
            self.assertNotIn(leaked, raw)
        a, b = self.lines()
        self.assertEqual(a["args"]["url"], "https://app.example/cb?code=REDACTED&state=ok#REDACTED")
        self.assertEqual(a["url"], "https://app.example/reset?token=REDACTED&page=2")
        self.assertEqual(b["args"]["url"], "https://app.example/x?Session=REDACTED")

    def test_redact_url_rules_match_the_extension(self):
        r = zh.zbcore.redact_url
        self.assertEqual(r("http://[::1]:8080/a?x=1&api_key=k&q=go+on#top"), "http://[::1]:8080/a?x=1&api_key=REDACTED&q=go+on#top")
        self.assertEqual(r("https://a.example/?pass%77ord=x"), "https://a.example/?pass%77ord=REDACTED")  # decoded name
        self.assertEqual(r("javascript:alert(1)"), "<non-http url>")
        self.assertEqual(len(r("https://a.example/" + "x" * 5000)), 2048)
        self.assertIsNone(r(None))

    def test_redact_url_matches_the_extension_on_shared_cases(self):
        cases = json.load(open(os.path.join(ROOT, "tests", "url_cases.json")))
        js = ("const L = require(process.argv[1]); const c = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
              "process.stdout.write(JSON.stringify(c.map(([u]) => L.zbRedactUrl(u))));")
        out = subprocess.run(["node", "-e", js, os.path.join(ROOT, "extension", "logic.js")], input=json.dumps(cases),
                             capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(out.stdout), [want for _, want in cases])           # extension (network log)
        self.assertEqual([zh.zbcore.redact_url(u) for u, _ in cases], [want for _, want in cases])  # host (action log)

    def test_log_rotates_at_the_size_cap(self):
        log = zh.ActionLog(self.path, max_bytes=2000)
        self.addCleanup(lambda: os.close(log.fd))
        for i in range(40):
            log.write("scroll", {"tabId": i, "dy": 1}, "ok")
        self.assertLessEqual(os.path.getsize(self.path), 2000)
        self.assertLessEqual(os.path.getsize(self.path + ".1"), 2000)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual(self.lines()[-1]["tabId"], 39)
        self.assertTrue(fcntl.fcntl(log.fd, fcntl.F_GETFL) & os.O_APPEND)

    def test_symlinked_log_refused(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700)
        os.symlink("/tmp/zb-not-here", self.path)
        with self.assertRaises(OSError):
            zh.ActionLog(self.path)


if __name__ == "__main__":
    unittest.main()
