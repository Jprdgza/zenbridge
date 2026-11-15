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
    "navigate": [{"tabId": 4, "url": "https://example.com/a?b=c"}],
    "reload": [{"urlPattern": "http://localhost:*/*"}, {"urlPattern": "*", "bypassCache": True}],
    "screenshot": [{"tabId": 2}, {"tabId": 2, "fullPage": True}],
    "read_page": [{"tabId": 1}, {"tabId": 1, "maxChars": 50000}],
    "inject_css": [{"tabId": 1, "css": "body{color:red}"}, {"tabId": 1, "clear": True}],
    "click": [{"tabId": 1, "selector": "#go"}, {"tabId": 1, "x": 10, "y": 20.5}],
    "type": [{"tabId": 1, "text": "hi"}, {"tabId": 1, "text": "", "key": "Enter", "selector": "input", "clear": True}],
    "scroll": [{"tabId": 1, "dy": 300}, {"tabId": 1, "dx": -5, "dy": 5}, {"tabId": 1, "selector": "footer"}],
}
INVALID = {
    "tabs_list": [{"x": 1}],
    "tab_switch": [{}, {"tabId": "1"}, {"tabId": True}, {"tabId": -1}, {"tabId": 1.5}],
    "tab_open": [{"url": "javascript:alert(1)"}, {"url": "file:///etc/passwd"}, {"url": "http://a b"},
                 {"url": "http://x/" + "a" * 2048}, {"url": "http://localhost/\n"}],
    "tab_close": [{"tabId": None}],
    "navigate": [{"tabId": 1}, {"tabId": 1, "url": "data:text/html,hi"}],
    "reload": [{}, {"urlPattern": ""}, {"urlPattern": "a" * 501}, {"urlPattern": "*", "bypassCache": "yes"}],
    "screenshot": [{"tabId": 1, "fullPage": 1}, {"tabId": 1, "format": "png"}],
    "read_page": [{}, {"tabId": 1, "maxChars": 999}, {"tabId": 1, "maxChars": 50001}, {"tabId": 1, "selector": "a"}],
    "inject_css": [{"tabId": 1}, {"tabId": 1, "css": ""}, {"tabId": 1, "clear": False}, {"tabId": 1, "clear": 1},
                   {"tabId": 1, "css": "a{}", "clear": True}, {"tabId": 1, "css": "x" * 50001}, {"css": "a{}"}],
    "click": [{"tabId": 1}, {"tabId": 1, "selector": "a", "x": 1, "y": 2}, {"tabId": 1, "x": 1},
              {"tabId": 1, "selector": "a" * 1001}, {"tabId": 1, "selector": ""}, {"tabId": 1, "selector": "a", "x": 3}],
    "type": [{"tabId": 1}, {"tabId": 1, "text": "a" * 10001}, {"tabId": 1, "text": "a", "key": "F5"},
             {"tabId": 1, "text": "a", "key": "enter"}, {"tabId": 1, "text": "a", "code": "x"}],
    "scroll": [{"tabId": 1}, {"tabId": 1, "dy": 1, "selector": "a"}],
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
