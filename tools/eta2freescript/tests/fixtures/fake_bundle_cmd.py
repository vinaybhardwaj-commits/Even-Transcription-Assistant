"""Stand-in for `python -m kit.reb.consult_bundle --uid U --out FILE`. Copies fixtures/bundle/<uid>.json to <out>.

usage: fake_bundle_cmd.py UID OUT. Synthetic data only. uid "synth-fail" exits 3 with a stderr line; "synth-slow" never answers.
"""
import os
import shutil
import sys
import time
from pathlib import Path

uid, out = sys.argv[1], sys.argv[2]
if uid == "synth-fail":
    print("SYNTH_STDOUT_NOT_LOGGED")
    print("boom " * 200, file=sys.stderr)
    sys.exit(3)
if uid == "synth-slow":
    time.sleep(60)
src = Path(__file__).parent / "bundle" / f"{uid}.json"
if not src.exists():
    print("refused: no consult scope", file=sys.stderr)
    sys.exit(2)
shutil.copyfile(src, out)
if os.environ.get("FAKE_BUNDLE_STDERR"):
    print("noise on success", file=sys.stderr)
print('{"layers_found": 1}')
