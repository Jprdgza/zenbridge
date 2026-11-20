"""install.sh / uninstall.sh in a throwaway HOME, with a fake `claude` command (ZB-9).

The scripts run from a copy of the repo, since install.sh may pin Python in host/launcher.sh."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from helpers import ROOT

FAKE_CLAUDE = """#!/bin/sh
echo "$@" >> "$HOME/claude.log"
case "$*" in "mcp remove --scope user zenbridge") [ -f "$HOME/user-scope" ] && rm "$HOME/user-scope" && exit 0; exit 1 ;; esac
case "$*" in "mcp add --scope user"*) touch "$HOME/user-scope" ;; esac
exit 0
"""


@unittest.skipUnless(sys.platform == "darwin" and sys.version_info >= (3, 10) and os.path.exists(os.path.join(ROOT, "install.sh")),
                     "macOS install paths, Python 3.10+")
class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="zbhome")
        self.addCleanup(shutil.rmtree, self.home, True)
        bin_dir = os.path.join(self.home, "bin")
        os.makedirs(bin_dir)
        with open(os.path.join(bin_dir, "claude"), "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(os.path.join(bin_dir, "claude"), 0o755)
        self.cfg_dir = os.path.join(self.home, "Library", "Application Support", "Claude")
        os.makedirs(self.cfg_dir)
        self.cfg = os.path.join(self.cfg_dir, "claude_desktop_config.json")
        self.root = os.path.join(self.home, "zenbridge")
        os.makedirs(self.root)
        for name in ("install.sh", "uninstall.sh"):
            shutil.copy2(os.path.join(ROOT, name), self.root)
        for name in ("host", "server", "common", "schema"):
            shutil.copytree(os.path.join(ROOT, name), os.path.join(self.root, name))
        self.server = os.path.join(os.path.realpath(self.root), "server", "zenbridge_mcp.py")
        self.env = {"HOME": self.home, "PATH": bin_dir + ":/usr/bin:/bin", "PYTHON": sys.executable}

    def run_script(self, *args):
        p = subprocess.run(["/bin/sh", os.path.join(self.root, args[0]), *args[1:]], env=self.env, cwd=self.home,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
        return p.stdout

    def desktop(self):
        with open(self.cfg) as f:
            return json.load(f)["mcpServers"]

    def claude_log(self):
        with open(os.path.join(self.home, "claude.log")) as f:
            return f.read()

    def test_default_install_removes_every_project_registrations_and_global_adds_them_back(self):
        open(os.path.join(self.home, "user-scope"), "w").close()  # registered by an older install
        server = self.server
        with open(self.cfg, "w") as f:
            json.dump({"mcpServers": {"zenbridge": {"command": "python3", "args": ["-I", server]}, "other": {"command": "x"}},
                       "theme": "dark"}, f)
        out = self.run_script("install.sh")
        self.assertIn("removed: Claude Code user-scope (every project) MCP server 'zenbridge'", out)
        self.assertIn("removed: zenbridge from Claude desktop chats", out)
        self.assertIn("mcp remove --scope user zenbridge", self.claude_log())
        self.assertFalse(os.path.exists(os.path.join(self.home, "user-scope")))
        self.assertEqual(self.desktop(), {"other": {"command": "x"}}, "other servers are left alone")
        with open(self.cfg) as f:
            self.assertEqual(json.load(f)["theme"], "dark")

        out = self.run_script("install.sh")  # nothing left to remove: says so
        self.assertIn("none: no user-scope registration", out)
        self.assertIn("none: no zenbridge entry", out)

        self.run_script("install.sh", "--global")
        self.assertTrue(os.path.exists(os.path.join(self.home, "user-scope")))
        self.assertEqual(self.desktop()["zenbridge"]["args"][-1], server)

        out = self.run_script("uninstall.sh")
        self.assertIn("removed: Claude Code user-scope (every project) MCP server 'zenbridge'", out)
        self.assertIn("removed: zenbridge from Claude desktop chats", out)
        self.assertIn("mcp remove --scope local zenbridge", self.claude_log())
        self.assertNotIn("zenbridge", self.desktop())

    def test_unknown_flag_refused(self):
        p = subprocess.run(["/bin/sh", os.path.join(self.root, "install.sh"), "--everywhere"], env=self.env, capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()
