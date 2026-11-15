import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "common"))
sys.path.insert(0, os.path.join(ROOT, "host"))
sys.path.insert(0, os.path.join(ROOT, "server"))
PY = sys.executable
EXT_ID = "zenbridge@jprdgza.github.io"


def short_tmpdir(testcase):
    """Short path under /tmp so socket paths fit in sun_path."""
    d = tempfile.mkdtemp(prefix="zb", dir="/tmp")
    testcase.addCleanup(shutil.rmtree, d, True)
    return d


def rid(n=1):
    return f"{n:032x}"
