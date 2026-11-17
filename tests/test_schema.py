import json
import os
import unittest

from helpers import ROOT, rid
import zbcore

VALID = {
    "tabs_list": [{}],
    "tab_switch": [{"tabId": 1}],
    "tab_open": [{"url": "http://localhost:3000/"}],
    "tab_close": [{"tabId": 0}],
    "navigate": [{"tabId": 4, "url": "https://example.com/a?b=c"}, {"tabId": 4, "history": "back"}],
    "reload": [{"urlPattern": "http://localhost:*/*"}, {"urlPattern": "*", "bypassCache": True}],
    "screenshot": [{"tabId": 2}, {"tabId": 2, "fullPage": True}, {"tabId": 2, "region": {"x": 0, "y": 5, "width": 100, "height": 50}}],
    "read_page": [{"tabId": 1}, {"tabId": 1, "maxChars": 50000}],
    "inject_css": [{"tabId": 1, "css": "body{color:red}"}, {"tabId": 1, "clear": True}],
    "click": [{"tabId": 1, "selector": "#go"}, {"tabId": 1, "x": 10, "y": 20.5}, {"tabId": 1, "ref": "ref_12"},
              {"tabId": 1, "ref": "ref_1", "button": "right", "clickCount": 2, "modifiers": ["ctrl", "shift"]}],
    "type": [{"tabId": 1, "text": "hi"}, {"tabId": 1, "text": "", "key": "Enter", "selector": "input", "clear": True},
             {"tabId": 1, "text": "x", "ref": "ref_3"}],
    "scroll": [{"tabId": 1, "dy": 300}, {"tabId": 1, "dx": -5, "dy": 5}, {"tabId": 1, "selector": "footer"}, {"tabId": 1},
               {"tabId": 1, "dy": 1, "selector": "a"}, {"tabId": 1, "ref": "ref_9"}, {"tabId": 1, "x": 5, "y": 5, "dy": 100}],
    "read_tree": [{"tabId": 1}, {"tabId": 1, "filter": "interactive", "depth": 5, "ref": "ref_2", "maxChars": 100000}],
    "find": [{"tabId": 1, "query": "search box"}],
    "hover": [{"tabId": 1, "ref": "ref_4"}, {"tabId": 1, "x": 1, "y": 2}],
    "drag": [{"tabId": 1, "from": {"ref": "ref_1"}, "to": {"x": 3, "y": 4}}],
    "key": [{"tabId": 1, "keys": "cmd+a Backspace"}, {"tabId": 1, "keys": "Enter", "repeat": 3, "ref": "ref_5"}, {"tabId": 1, "keys": "shift++"}],
    "form_input": [{"tabId": 1, "ref": "ref_1", "value": "CA"}, {"tabId": 1, "selector": "#c", "checked": False},
                   {"tabId": 1, "ref": "ref_1", "value": ""}],
    "wait_for": [{"tabId": 1}, {"tabId": 1, "selector": ".done", "seconds": 10}, {"tabId": 1, "text": "Saved", "gone": True}],
    "resize_window": [{"tabId": 1, "width": 800, "height": 600}],
    "console_messages": [{"tabId": 1}, {"tabId": 1, "filter": "err", "onlyErrors": True, "clear": True, "limit": 500}],
    "network_requests": [{"tabId": 1}, {"tabId": 1, "urlPattern": "/api/", "clear": True, "limit": 1}],
    "file_upload": [{"tabId": 1, "ref": "ref_1", "uploads": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}],
    "upload_chunk": [{"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a.png", "mimeType": "image/png", "data": "QUJD"}],
}
INVALID = {
    "tabs_list": [{"x": 1}],
    "tab_switch": [{}, {"tabId": "1"}, {"tabId": True}, {"tabId": -1}, {"tabId": 1.5}],
    "tab_open": [{"url": "javascript:alert(1)"}, {"url": "file:///etc/passwd"}, {"url": "http://a b"},
                 {"url": "http://x/" + "a" * 2048}, {"url": "http://localhost/\n"}],
    "tab_close": [{"tabId": None}],
    "navigate": [{"tabId": 1}, {"tabId": 1, "url": "data:text/html,hi"}, {"tabId": 1, "history": "up"},
                 {"tabId": 1, "history": "back", "url": "https://a.b/"}],
    "reload": [{}, {"urlPattern": ""}, {"urlPattern": "a" * 501}, {"urlPattern": "*", "bypassCache": "yes"}],
    "screenshot": [{"tabId": 1, "fullPage": 1}, {"tabId": 1, "format": "png"},
                   {"tabId": 1, "fullPage": True, "region": {"x": 0, "y": 0, "width": 1, "height": 1}},
                   {"tabId": 1, "region": {"x": 0, "y": 0, "width": 2000, "height": 1}}, {"tabId": 1, "region": {"x": 0, "y": 0}}],
    "read_page": [{}, {"tabId": 1, "maxChars": 999}, {"tabId": 1, "maxChars": 50001}, {"tabId": 1, "selector": "a"}],
    "inject_css": [{"tabId": 1}, {"tabId": 1, "css": ""}, {"tabId": 1, "clear": False}, {"tabId": 1, "clear": 1},
                   {"tabId": 1, "css": "a{}", "clear": True}, {"tabId": 1, "css": "x" * 50001}, {"css": "a{}"}],
    "click": [{"tabId": 1}, {"tabId": 1, "selector": "a", "x": 1, "y": 2}, {"tabId": 1, "x": 1},
              {"tabId": 1, "selector": "a" * 1001}, {"tabId": 1, "selector": ""}, {"tabId": 1, "selector": "a", "x": 3},
              {"tabId": 1, "ref": "1"}, {"tabId": 1, "ref": "ref_1", "selector": "a"}, {"tabId": 1, "ref": "ref_1", "button": "back"},
              {"tabId": 1, "ref": "ref_1", "clickCount": 4}, {"tabId": 1, "ref": "ref_1", "modifiers": ["hyper"]}],
    "type": [{"tabId": 1}, {"tabId": 1, "text": "a" * 10001}, {"tabId": 1, "text": "a", "key": "F5"},
             {"tabId": 1, "text": "a", "key": "enter"}, {"tabId": 1, "text": "a", "code": "x"},
             {"tabId": 1, "text": "a", "ref": "ref_1", "selector": "a"}],
    "scroll": [{"tabId": 1, "selector": "a", "ref": "ref_1"}, {"tabId": 1, "x": 1}, {"tabId": 1, "dy": "1"}],
    "read_tree": [{}, {"tabId": 1, "filter": "visible"}, {"tabId": 1, "depth": 0}, {"tabId": 1, "maxChars": 100001}],
    "find": [{"tabId": 1}, {"tabId": 1, "query": ""}, {"tabId": 1, "query": "a" * 201}],
    "hover": [{"tabId": 1}, {"tabId": 1, "ref": "ref_1", "x": 1, "y": 1}],
    "drag": [{"tabId": 1, "from": {"ref": "ref_1"}}, {"tabId": 1, "from": {}, "to": {"ref": "ref_2"}},
             {"tabId": 1, "from": {"x": 1}, "to": {"ref": "ref_2"}}, {"tabId": 1, "from": {"ref": "ref_1", "z": 1}, "to": {"ref": "ref_2"}}],
    "key": [{"tabId": 1}, {"tabId": 1, "keys": ""}, {"tabId": 1, "keys": "a  b"}, {"tabId": 1, "keys": " a"}, {"tabId": 1, "keys": "\u00e9"},
            {"tabId": 1, "keys": "a", "repeat": 101}, {"tabId": 1, "keys": "a" * 201}],
    "form_input": [{"tabId": 1, "ref": "ref_1"}, {"tabId": 1, "value": "x"}, {"tabId": 1, "ref": "ref_1", "value": "x", "checked": True},
                   {"tabId": 1, "ref": "ref_1", "checked": "yes"}, {"tabId": 1, "ref": "ref_1", "selector": "a", "value": "x"}],
    "wait_for": [{"tabId": 1, "seconds": 11}, {"tabId": 1, "selector": "a", "text": "b"}, {"tabId": 1, "text": ""}],
    "resize_window": [{"tabId": 1, "width": 800}, {"tabId": 1, "width": 100, "height": 600}, {"tabId": 1, "width": 800.5, "height": 600}],
    "console_messages": [{}, {"tabId": 1, "limit": 0}, {"tabId": 1, "filter": "a" * 201}],
    "network_requests": [{}, {"tabId": 1, "urlPattern": ""}, {"tabId": 1, "limit": 501}],
    "file_upload": [{"tabId": 1, "ref": "ref_1"}, {"tabId": 1, "ref": "ref_1", "uploads": []}, {"tabId": 1, "ref": "ref_1", "uploads": ["x"]},
                    {"tabId": 1, "uploads": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}, {"tabId": 1, "ref": "ref_1", "paths": ["/tmp/a"]},
                    {"tabId": 1, "ref": "ref_1", "uploads": ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] * 11}],
    "upload_chunk": [{"uploadId": "x", "index": 0, "total": 1, "name": "a", "mimeType": "a/b", "data": "QUJD"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 100, "total": 1, "name": "a", "mimeType": "a/b", "data": "QUJD"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a/b", "mimeType": "a/b", "data": "QUJD"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a\n", "mimeType": "a/b", "data": "QUJD"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a", "mimeType": "text", "data": "QUJD"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a", "mimeType": "a/b", "data": "!!!!"},
                     {"uploadId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "index": 0, "total": 1, "name": "a", "mimeType": "a/b", "data": "A" * 600004}],
}


def req(tool, args, **over):
    return {"v": 1, "id": rid(), "tool": tool, "args": args, **over}


class SchemaTest(unittest.TestCase):
    def test_every_tool_has_cases(self):
        self.assertEqual(set(VALID), set(zbcore.TOOLS))
        self.assertEqual(set(INVALID), set(zbcore.TOOLS))
        self.assertEqual(sorted(zbcore.SCHEMA["envelope"]["request"]["properties"]["tool"]["enum"]), sorted(zbcore.TOOLS))

    def test_valid(self):
        for tool, cases in VALID.items():
            for args in cases:
                with self.subTest(tool=tool, args=args):
                    self.assertIsNone(zbcore.validate_request(req(tool, args)))

    def test_invalid(self):
        for tool, cases in INVALID.items():
            for args in cases:
                with self.subTest(tool=tool, args=str(args)[:80]):
                    self.assertIsNotNone(zbcore.validate_request(req(tool, args)))

    def test_envelope(self):
        bad = [None, [], "x", {"v": 1, "id": rid(), "tool": "eval", "args": {}},
               req("tabs_list", {}, v=2), req("tabs_list", {}, v=True), req("tabs_list", {}, id="xyz"),
               req("tabs_list", {}, id="A" * 32), req("tabs_list", {}, id="a" * 65), req("tabs_list", {}, extra=1),
               {"v": 1, "id": rid(), "tool": "tabs_list"}, req("tabs_list", [])]
        for m in bad:
            with self.subTest(m=str(m)[:60]):
                self.assertIsNotNone(zbcore.validate_request(m))

    def test_responses(self):
        ok = {"v": 1, "id": rid(), "ok": True, "result": {"tabId": 3}, "tabUrl": "http://localhost/"}
        self.assertIsNone(zbcore.validate_response(ok, "tab_switch"))
        self.assertIsNotNone(zbcore.validate_response({**ok, "result": {"tabId": 3, "x": 1}}, "tab_switch"))
        self.assertIsNotNone(zbcore.validate_response({**ok, "secret": 1}, "tab_switch"))
        err = {"v": 1, "id": rid(), "ok": False, "error": {"code": "NOT_ARMED", "message": "no"}}
        self.assertIsNone(zbcore.validate_response(err, "click"))
        self.assertIsNotNone(zbcore.validate_response({**err, "error": {"code": "PWNED", "message": "x"}}, "click"))
        self.assertIsNotNone(zbcore.validate_response({**err, "result": {}}, "click"))
        self.assertIsNotNone(zbcore.validate_response("nope", "click"))
        big = {"v": 1, "id": rid(), "ok": True, "result": {"tabs": [{"tabId": 1, "title": "t" * 201, "url": "u",
                                                                       "active": True, "inScope": True}]}}
        self.assertIsNotNone(zbcore.validate_response(big, "tabs_list"))

    def test_limits_match_schema(self):
        lim = zbcore.LIMITS
        self.assertEqual(lim["maxFrameBytes"], 16 * 1024 * 1024)
        self.assertEqual(zbcore.TOOLS["type"]["args"]["properties"]["text"]["maxLength"], lim["maxText"])
        self.assertEqual(zbcore.TOOLS["click"]["args"]["properties"]["selector"]["maxLength"], lim["maxSelector"])
        self.assertEqual(zbcore.TOOLS["reload"]["args"]["properties"]["urlPattern"]["maxLength"], lim["maxUrlPattern"])

    def test_cases_shared_with_js(self):
        """The JS validator test (tests/js) runs the same cases; keep them in one file."""
        path = os.path.join(ROOT, "tests", "js", "cases.json")
        with open(path) as f:
            data = json.load(f)
        self.assertEqual(data["valid"], VALID)
        self.assertEqual(data["invalid"], INVALID)

    def test_length_in_utf16_units_like_js(self):
        self.assertIsNotNone(zbcore.validate_request(req("type", {"tabId": 1, "text": "\U0001F600" * 5001})))
        self.assertIsNone(zbcore.validate_request(req("type", {"tabId": 1, "text": "\U0001F600" * 5000})))
        for u in ("http://localhost/\ufeff", "http://localhost/\x1c", "http://localhost/\u00e9"):
            self.assertIsNotNone(zbcore.validate_request(req("navigate", {"tabId": 1, "url": u})), repr(u))

    def test_non_finite_numbers(self):
        for v in (float("inf"), float("nan")):
            self.assertIsNotNone(zbcore.validate_request(req("scroll", {"tabId": 1, "dy": v})))


if __name__ == "__main__":
    unittest.main()
