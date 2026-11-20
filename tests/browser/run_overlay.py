#!/usr/bin/env python3
"""Runs tests/browser/overlay.html in a throwaway headless Zen (or Firefox) profile and prints the result.

    python3 tests/browser/run_overlay.py [/path/to/zen-or-firefox]

Serves the repo on 127.0.0.1 (random port), opens the page with ?report, waits for its POST, exits 0 only if
every line passed.
"""
import http.server, os, subprocess, sys, tempfile, threading

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BROWSER = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Zen.app/Contents/MacOS/zen"
result = {}
done = threading.Event()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path == "/result":
            n = min(int(self.headers.get("Content-Length", "0")), 100000)
            result["text"] = self.rfile.read(n).decode("utf-8", "replace")
            done.set()
        self.send_response(204)
        self.end_headers()


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/tests/browser/overlay.html?report"
with tempfile.TemporaryDirectory() as prof:
    p = subprocess.Popen([BROWSER, "--headless", "--no-remote", "--profile", prof, url],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        done.wait(60)
    finally:
        p.terminate()
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            p.kill()
srv.shutdown()
text = result.get("text", "TIMEOUT (no result from the page)")
print(text)
sys.exit(0 if text.startswith("ALLPASS") else 1)
