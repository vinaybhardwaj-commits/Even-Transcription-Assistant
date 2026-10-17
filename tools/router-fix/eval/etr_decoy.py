#!/usr/bin/env python3
"""ETR decoy gate (lid-debug #4501): for every clinical1 dialogue's native/Whisper-side Indic text (as
already produced by the S1 M6 re-run, or any router output with segments), try anchoring EVERY value
1-1000 that is NOT one of that dialogue's own truth values. False anchors must be ~0 before any ETR
result is trusted. Pre-registered ceiling: 0 false anchors (report the count; do not proceed past a
nonzero count without a declared, reviewed fix).
usage: etr_decoy.py RESULTS_DIR SUITE_DIR [--limit N]   (RESULTS_DIR = e.g. out-m6/new, or s1-results/new)
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
import router_server as rs  # noqa: E402

RESULTS, SUITE = sys.argv[1], sys.argv[2]
LIMIT = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None


import re as _re


def true_values(truth):
    """Every value GENUINELY spoken anywhere in the dialogue's own scripted text, not just the values
    tagged as clinical_items -- a dialogue can mention other numbers too (e.g. "it has been 10 days"
    as symptom duration, separate from a 14-day follow-up): finding THAT is a correct anchor, not a
    false one. A true false anchor is a value with NO basis anywhere in what was actually said."""
    vals = set()
    for it in truth.get("clinical_items", []):
        if it["type"] == "drug":
            vals.add(it["dose_value"])
        elif it["type"] == "follow_up_days":
            vals.add(it["value"])
    for e in truth.get("events", []):
        if e.get("type") == "turn":
            for m in _re.finditer(r"\d+", e.get("text", "")):
                vals.add(int(m.group()))
    return vals


def native_text(result_json):
    segs = result_json.get("engines", {}).get("stt", {}).get("segments", [])
    return " ".join(s.get("text", "") for s in segs if s.get("text"))


def main():
    files = sorted(f for f in os.listdir(RESULTS) if f.endswith(".result.json"))
    if LIMIT:
        files = files[:LIMIT]
    total_checks, false_anchors = 0, []
    band_checks = {"1-10": 0, "11-99": 0, "100+": 0}
    def band(v):
        return "1-10" if v <= 10 else ("11-99" if v <= 99 else "100+")
    for f in files:
        sid = f[: -len(".result.json")]
        tp = f"{SUITE}/{sid}.truth.json"
        if not os.path.exists(tp):
            continue
        truth = json.load(open(tp))
        text = native_text(json.load(open(f"{RESULTS}/{f}")))
        if not text:
            continue
        true_vals = true_values(truth)
        for v in range(1, 1001):
            if v in true_vals:
                continue
            for kind in ("dose", "follow_up"):
                total_checks += 1
                band_checks[band(v)] += 1
                span = rs.find_value_anchor(text, v, kind=kind)
                if span is not None:
                    false_anchors.append({"stimulus": sid, "value": v, "kind": kind, "span": span})
    print(f"stimuli checked: {len(files)}, decoy checks: {total_checks}, false anchors: {len(false_anchors)}")
    band_false = {b: 0 for b in band_checks}
    for fa in false_anchors:
        band_false[band(fa["value"])] += 1
    for b in ("1-10", "11-99", "100+"):
        print(f"  band {b}: {band_false[b]}/{band_checks[b]} false anchors")
    for fa in false_anchors[:50]:
        print(" ", fa)
    return len(false_anchors)


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
