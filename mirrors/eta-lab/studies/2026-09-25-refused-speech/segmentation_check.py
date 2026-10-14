"""segmentation_check.py: does each refused window's segment plan match the router's FIXED-WINDOW fallback (router_server.py plan_segments: 30 s spans, hop 29 s, restarted per 180 s
sub-window)? That plan is what the router uses when Silero VAD finds NO speech spans (`fixed-window-vad-empty`) or is unavailable. Counts only. python3 segmentation_check.py DRAW.json"""
import json, os, sys
from collections import Counter

H = os.path.expanduser("~/eta-data/")


def seg_fixed(s, e):
    a = s % 180.0
    k = round(a / 29.0)
    start_ok = abs(a - 29.0 * k) < 0.06 and k <= 6
    len_ok = abs((e - s) - 30.0) < 0.06 or abs(e % 180.0) < 0.06 or abs(e - 900.0) < 0.06 or abs((e - s) - (180.0 - a)) < 0.06
    return start_ok and len_ok


def classify(segs):
    f = [seg_fixed(x["start_s"], x["end_s"]) for x in segs]
    return ("all_fixed" if all(f) else ("none_fixed" if not any(f) else "mixed")), sum(f), len(f)


if __name__ == "__main__":
    d = json.load(open(sys.argv[1]))
    res = [classify(json.load(open(H + c["path"]))["segments"]) for r in sorted(d["chosen"]) for c in d["chosen"][r]]
    print("refused windows by pattern:", dict(Counter(k for k, _m, _n in res)), "| segments matching / all:", sum(m for _k, m, _n in res), "/", sum(n for _k, _m, n in res))
