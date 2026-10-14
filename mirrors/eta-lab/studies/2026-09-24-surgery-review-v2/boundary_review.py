#!/usr/bin/env python3
"""boundary_review.py — ruling 86: every check=False cut is reviewed against the AUDIO before it enters the set. Per item and per edge (encounter start / end), on the assembled whole-consult audio:
  * QUIET GAP: the longest run of 1-s bins whose energy is in the lowest 20% of the item's whole span within +-45 s of the edge (a consult ends and the next starts with a pause; a cut in the
    middle of talk has none);
  * CUE: an opening cue (greeting / 'come' / 'sit' / 'tell me') in the first 90 s inside the start edge, a closing cue (thanks / see you / bye / next / take care) in the last 90 s inside the end edge
    (regex over the raw text on the box; nothing is sent anywhere);
  * DOCTOR SHARE inside vs the 90 s outside each edge is NOT used (labels are window-local).
  * DURATION: an encounter over 25 min is flagged for a manual look (Fable ruling 86).
Verdict per edge: SUPPORTED (a quiet gap of >=6 s within +-45 s of the edge, or a cue) / WEAK (neither). Prints ids, seconds and verdicts only. Run with a python that has numpy.
usage: boundary_review.py <dir:id> ..."""
import json, os, re, subprocess, sys
import numpy as np

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
OPEN = re.compile(r"\b(namaste|namaskar|hello|hi\b|good (morning|afternoon|evening)|come|sit|please sit|tell me|what happened|how are you|welcome|yes tell)\b", re.I)
CLOSE = re.compile(r"\b(thank|thanks|see you|bye|take care|next|all the best|come back|follow up|okay then|that'?s all|fine then)\b", re.I)


def envelope(mp3):
    pcm = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", mp3, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], capture_output=True).stdout, dtype=np.int16).astype(np.float32)
    n = len(pcm) // 8000
    return np.log1p(np.sqrt((pcm[:n * 8000].reshape(n, 8000) ** 2).mean(axis=1)))


def _runs(env, lo, hi, thr):
    best = (0, 1e9)
    i = lo
    while i < hi:
        if env[i] < thr:
            j = i
            while j < hi and env[j] < thr:
                j += 1
            if j - i > best[0]:
                best = (j - i, (i + j) / 2)
            i = j
        else:
            i += 1
    return best


def edge(env, texts, at, inside_first, thr):
    lo, hi = max(0, int(at) - 45), min(len(env), int(at) + 45)
    length, mid = _runs(env, lo, hi, thr)
    dist = abs(mid - at) if length else None
    cue_re = OPEN if inside_first else CLOSE
    cue = any(cue_re.search(t) for t in texts)
    supported = length >= 6 or cue  # the run is searched only within +-45 s of the edge
    return {"quiet_gap_s": length, "gap_distance_s": None if dist is None else round(dist), "cue": bool(cue), "verdict": "SUPPORTED" if supported else "WEAK"}


def review(spec):
    d, q = spec.split(":")
    st = json.load(open(f"{V3}/{d}/staging/{q}.json")); lo = st["span"]["start_ms"]
    s, e = (st["encounter"]["start_ms"] - lo) / 1000, (st["encounter"]["end_ms"] - lo) / 1000
    env = envelope(f"{V3}/{d}/audio/{q}/full.mp3")
    inside = [t for t in st["turns"] if "phase" not in t]
    thr = float(np.percentile(env, 20))  # 'quiet' = the lowest 20% of this item's own span (the noise floor differs per room)
    first = [t["orig"] for t in inside if t["start_s"] < s + 90]; last = [t["orig"] for t in inside if t["end_s"] > e - 90]
    a, b = edge(env, first, s, True, thr), edge(env, last, e, False, thr)
    mins = (e - s) / 60
    return {"id": q, "dir": d, "encounter_min": round(mins, 1), "over_25_min": mins > 25, "start": a, "end": b, "interior_longest_quiet_s": _runs(env, int(s) + 45, max(int(s) + 46, int(e) - 45), thr)[0] if e - s > 100 else None}



def selftest():
    env = np.ones(600) * 5.0; env[300:312] = 0.1  # 12 s of silence, centre 306
    thr = 2.0
    r = edge(env, [], 305, True, thr); assert r["verdict"] == "SUPPORTED" and r["quiet_gap_s"] == 12 and r["gap_distance_s"] <= 6 and not r["cue"], r
    assert edge(env, [], 420, True, thr)["verdict"] == "WEAK", "silence 114 s away, no cue"
    assert edge(env, [], 200, True, thr)["verdict"] == "WEAK", "a gap 106 s away is outside the +-45 s window"
    r = edge(env, ["please sit, doctor will see you"], 420, True, thr); assert r["verdict"] == "SUPPORTED" and r["cue"], "an opening cue is enough"
    assert edge(env, ["namaste"], 420, False, thr)["verdict"] == "WEAK", "an opening cue does not support an END edge"
    assert edge(env, ["thank you"], 420, True, thr)["verdict"] == "WEAK", "a closing cue does not support a START edge"
    assert edge(env, ["thank you"], 420, False, thr)["verdict"] == "SUPPORTED", "a closing cue supports an end edge"
    e2 = np.ones(600) * 5.0; e2[300:305] = 0.1
    assert edge(e2, [], 302, True, thr)["verdict"] == "WEAK" and edge(e2, [], 302, True, thr)["quiet_gap_s"] == 5, "a 5 s gap is too short"
    e3 = np.ones(600) * 5.0; e3[300:306] = 0.1
    assert edge(e3, [], 303, True, thr)["verdict"] == "SUPPORTED", "exactly 6 s is enough"
    e4 = np.ones(600) * 5.0; e4[346:358] = 0.1  # starts 46 s after the edge at 300: outside the window
    assert edge(e4, [], 300, True, thr)["verdict"] == "WEAK", "a gap more than 45 s from the edge does not support it"
    e5 = np.ones(600) * 5.0; e5[338:349] = 0.1  # 38-45 s after the edge: 7 s inside the window
    assert edge(e5, [], 300, True, thr)["verdict"] == "SUPPORTED", "a gap that reaches inside the +-45 s window with >= 6 s does"
    e6 = np.ones(600) * 5.0; e6[340:350] = 0.1  # only 5 s (340-345) inside the window
    assert edge(e6, [], 300, True, thr)["verdict"] == "WEAK", "5 s inside the window is too short"
    print("boundary_review selftest OK")


if __name__ == "__main__":
    if sys.argv[1] == "--selftest":
        selftest(); raise SystemExit
    for spec in sys.argv[1:]:
        print(json.dumps(review(spec)))
