"""Static guards: scan the source tree for forbidden APIs and drift."""
import json
import os
import re
import sys
import unittest

from helpers import ROOT

sys.path.insert(0, ROOT)
import gen_schema  # noqa: E402

EXT = os.path.join(ROOT, "extension")
PY_SOURCES = ["common/zbcore.py", "host/zenbridge_host.py", "server/zenbridge_mcp.py", "gen_schema.py"]
JS_SOURCES = ["background.js", "actions.js", "logic.js", "validate.js", "config.js"]
EXT_ID = "zenbridge@jprdgza.github.io"


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


def code_only(src):
    """Drop full-line comments so documentation can mention forbidden names."""
    return "\n".join(line for line in src.splitlines() if not line.lstrip().startswith(("#", "//")))


class NetworkGuards(unittest.TestCase):
    FORBIDDEN_PY = [r"AF_INET", r"\bhttp\.server\b", r"\bsocketserver\b", r"\burllib\b", r"\bhttp\.client\b",
                    r"\bimport requests\b", r"\basyncio\b", r"start_server", r"SOCK_DGRAM", r"\bsubprocess\b",
                    r"\beval\(", r"\bexec\(", r"\bpickle\b"]

    def test_python_forbidden(self):
        for rel in PY_SOURCES:
            src = code_only(read(rel))
            for pat in self.FORBIDDEN_PY:
                self.assertIsNone(re.search(pat, src), f"{rel}: {pat}")

    def test_listen_only_in_host_and_unix(self):
        for rel in PY_SOURCES:
            n = len(re.findall(r"\.listen\(", read(rel)))
            self.assertEqual(n, 1 if rel == "host/zenbridge_host.py" else 0, rel)
        sockets = re.findall(r"socket\.socket\(([^)]*)\)", "".join(read(r) for r in PY_SOURCES))
        self.assertTrue(sockets)
        self.assertTrue(all(s.startswith("socket.AF_UNIX, socket.SOCK_STREAM") for s in sockets), sockets)

    FORBIDDEN_JS = [r"\beval\(", r"new Function", r"\bfetch\(", r"XMLHttpRequest", r"WebSocket", r"\.innerHTML\s*=",
                    r"outerHTML\s*=", r"insertAdjacentHTML", r"document\.write", r"runtime\.onMessage",
                    r"runtime\.sendMessage", r"onMessageExternal", r"setTimeout\(\s*[\"'`]", r"setInterval\(",
                    r"tabs\.executeScript", r"contentScripts", r"\bstorage\.", r"cookies", r"\bimportScripts\b",
                    r"EventSource", r"sendBeacon", r"RTCPeerConnection"]

    def test_extension_forbidden(self):
        for rel in JS_SOURCES:
            src = code_only(read(f"extension/{rel}"))
            for pat in self.FORBIDDEN_JS:
                self.assertIsNone(re.search(pat, src), f"{rel}: {pat}")

    def test_single_choke_point(self):
        bg = read("extension/background.js")
        for rel in JS_SOURCES:
            if rel != "background.js":
                self.assertNotRegex(code_only(read(f"extension/{rel}")), r"\bbrowser\.", rel)
        calls = [m.start() for m in re.finditer(r"browser\.scripting\.executeScript\(", bg)]
        self.assertEqual(len(calls), 1)
        inject = bg.index("async function inject(")
        self.assertTrue(inject < calls[0] < bg.index("\n}\n", inject))
        line = bg[calls[0]:bg.index("\n", calls[0])]
        self.assertIn("func", line)
        self.assertIn("frameIds: [0]", line)
        self.assertNotRegex(line, r"\bcode\s*:|\bfile\s*:|files\s*:")
        self.assertEqual(len(re.findall(r"captureTab\(", bg)), 1)
        # CSS goes in only through inject_css, top frame only, always after the scope check.
        self.assertEqual(len(re.findall(r"scripting\.insertCSS\(", bg)), 1)
        ins = bg.index("scripting.insertCSS(")
        self.assertTrue(bg.index("async inject_css(") < bg.index("zbCssProblem(a.css)", bg.index("async inject_css(")) < ins)
        self.assertIn("frameIds: [0]", bg[ins:bg.index("\n", ins)])
        self.assertGreater(bg.index("captureTab("), bg.index("async screenshot("))
        self.assertIn("handleRequest(msg)", bg[bg.index("function connect("):])


class ManifestGuards(unittest.TestCase):
    def setUp(self):
        self.m = json.loads(read("extension/manifest.json"))
        self.doc = read("extension/manifest.README.md")

    def test_exact_permissions(self):
        self.assertEqual(self.m["permissions"], ["nativeMessaging", "scripting", "activeTab", "tabGroups"])
        self.assertEqual(self.m["optional_permissions"], ["http://*/*", "https://*/*", "<all_urls>"])
        self.assertEqual(self.m["manifest_version"], 2)
        self.assertTrue(self.m["background"]["persistent"])
        for key in ("content_scripts", "web_accessible_resources", "externally_connectable", "host_permissions",
                    "options_ui", "sidebar_action", "page_action"):
            self.assertNotIn(key, self.m)
        self.assertNotIn("default_popup", self.m["browser_action"])
        self.assertEqual(self.m["commands"]["disarm-all"]["suggested_key"]["default"], "Alt+Shift+K")
        self.assertEqual(self.m["commands"]["start-session"]["suggested_key"]["default"], "Alt+Shift+C")

    def test_every_permission_documented(self):
        for p in self.m["permissions"] + self.m["optional_permissions"]:
            self.assertIn(f"| `{p}` |", self.doc, p)
        documented = set(re.findall(r"^\| `([^`]+)` \|", self.doc, re.M))
        self.assertEqual(documented, set(self.m["permissions"] + self.m["optional_permissions"]))

    def test_background_scripts_are_the_extension_files(self):
        scripts = self.m["background"]["scripts"]
        self.assertEqual(scripts[-1], "background.js")
        on_disk = {f for f in os.listdir(EXT) if f.endswith(".js")}
        self.assertEqual(set(scripts), on_disk)

    def test_start_page_only_requests_permission(self):
        src = code_only(read("extension/start/start.js"))
        self.assertEqual(re.findall(r"\bbrowser\.[\w.]+", src), ["browser.permissions.request"])
        for pat in NetworkGuards.FORBIDDEN_JS:
            self.assertIsNone(re.search(pat, src), pat)
        self.assertEqual(sorted(os.listdir(os.path.join(EXT, "start"))), ["start.html", "start.js"])
        self.assertNotRegex(read("extension/start/start.html"), r"<script>|on\w+=|https?://")

    def test_extension_id_consistent(self):
        self.assertEqual(self.m["browser_specific_settings"]["gecko"]["id"], EXT_ID)
        self.assertIn(f'EXTENSION_ID = "{EXT_ID}"', read("host/zenbridge_host.py"))
        for rel in ("install.sh", "uninstall.sh"):
            if os.path.exists(os.path.join(ROOT, rel)):
                self.assertIn(EXT_ID, read(rel), rel)

    def test_csp(self):
        self.assertEqual(self.m["content_security_policy"], "script-src 'self'; object-src 'none'")


class DriftGuards(unittest.TestCase):
    def test_schema_copy_identical(self):
        self.assertEqual(read("extension/schema.js"), gen_schema.render(), "run: python3 gen_schema.py")
        js = read("extension/schema.js")
        body = js[js.index("= ") + 2:js.rindex(";\nif")]
        self.assertEqual(json.loads(body), json.loads(read("schema/tools.json")))

    def test_launcher_uses_absolute_isolated_python(self):
        src = read("host/launcher.sh")
        m = re.search(r"^exec (\S+) -I ", src, re.M)
        self.assertTrue(m and m.group(1).startswith("/"), src)


if __name__ == "__main__":
    unittest.main()
