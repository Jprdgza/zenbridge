"""ZB-13: the release workflow holds the AMO signing keys, so nothing it runs may move under it."""
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, ".github", "workflows")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


@unittest.skipUnless(os.path.isdir(WF), "no GitHub workflows in this checkout")
class Workflows(unittest.TestCase):
    def files(self):
        return [os.path.join(WF, f) for f in sorted(os.listdir(WF)) if f.endswith((".yml", ".yaml"))]

    def test_every_action_is_pinned_to_a_full_commit_sha_with_its_version(self):
        seen = 0
        for f in self.files():
            for n, line in enumerate(read(f).splitlines(), 1):
                m = re.search(r"\buses:\s*(\S+)(.*)$", line)
                if not m:
                    continue
                ref, rest = m.group(1), m.group(2)
                if ref.startswith("./"):
                    continue  # this repository's own workflow
                seen += 1
                self.assertRegex(ref, r"^[\w.-]+/[\w.-]+(/[\w./-]+)?@[0-9a-f]{40}$", f"{os.path.basename(f)}:{n} {ref}")
                self.assertRegex(rest, r"#\s*v\d+\.\d+\.\d+\s*$", f"{os.path.basename(f)}:{n} needs a '# vX.Y.Z' comment")
        self.assertGreater(seen, 5)

    def test_checkouts_do_not_keep_the_token(self):
        for f in self.files():
            text = read(f)
            for m in re.finditer(r"uses: actions/checkout@\S+.*\n((?:\s+.*\n){0,3})", text):
                self.assertIn("persist-credentials: false", m.group(1), os.path.basename(f))

    def test_no_floating_tools(self):
        for f in self.files():
            text = read(f)
            self.assertNotRegex(text, r"npx\s+(--yes|-y)\b", os.path.basename(f))
            self.assertNotRegex(text, r"web-ext@", os.path.basename(f))
            self.assertNotRegex(text, r"npm (i|install)\b", os.path.basename(f))
            if "web-ext" in text:
                self.assertIn("npm ci --ignore-scripts", text, os.path.basename(f))

    def test_web_ext_is_pinned_exactly_in_package_json_and_the_lockfile(self):
        pkg = json.loads(read(os.path.join(ROOT, "package.json")))
        want = pkg["devDependencies"]["web-ext"]
        self.assertRegex(want, r"^\d+\.\d+\.\d+$", "an exact version, no ^ or ~")
        self.assertEqual(pkg.get("dependencies", {}), {}, "the extension has no runtime npm dependencies")
        lock = json.loads(read(os.path.join(ROOT, "package-lock.json")))
        entry = lock["packages"]["node_modules/web-ext"]
        self.assertEqual(entry["version"], want)
        self.assertTrue(entry["integrity"].startswith("sha512-"))
        self.assertEqual(lock["packages"][""]["devDependencies"]["web-ext"], want)

    def test_dependabot_watches_the_actions_and_npm(self):
        text = read(os.path.join(ROOT, ".github", "dependabot.yml"))
        self.assertIn("package-ecosystem: github-actions", text)
        self.assertIn("package-ecosystem: npm", text)

    def test_release_keeps_its_guards(self):
        text = read(os.path.join(WF, "release.yml"))
        self.assertIn('tags: ["v*"]', text)
        self.assertRegex(text, r"(?m)^permissions:\n  contents: read")
        self.assertIn("name: release", text)
        self.assertIn("--verify-tag", text)


if __name__ == "__main__":
    unittest.main()
