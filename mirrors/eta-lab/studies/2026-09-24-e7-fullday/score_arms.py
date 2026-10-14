"""Score the three arms with the 23 Sep scorer (e7_score.py, unchanged) and print one table.
Usage: score_arms.py <outdir> <truth.csv>

E-6.2 proposal 3: when <outdir>/windows.json exists (the rooms stage writes it), each consult's transcribed
coverage is computed, and every arm is ALSO scored against only the consults that are >= 50% transcribed. A
consult with no transcript is an STT gap, not an encounter-clock miss, so recall is reported both ways."""
import os, re, subprocess, sys
outdir, truth = sys.argv[1:3]
SCORER = os.path.expanduser("~/dev/eta-lab/studies/2026-09-23-e7-pqm-truth/e7_score.py")
pat = {k: re.compile(p) for k, p in {
    "hyp": r"- Hypotheses \([^)]+\): (\d+)", "recall": r"- Recall .*?: (\d+/\d+)", "precision": r"- Precision .*?: (\d+/\d+)",
    "splits": r"- Splits .*?: (\d+)", "merges": r"- Merges .*?: (\d+)",
    "start": r"- Start error \(s\): (.*)", "end": r"- End error \(s\): (.*)"}.items()}
import csv, json
from datetime import datetime

def covered_truth(truth_path, windows_path, out_path, min_cov=0.5):
    """Write the consults >= min_cov transcribed to out_path; return (kept, total, per-consult coverage)."""
    hyp = json.load(open(f"{outdir}/hyp-acoustic.json"))["room_days"]
    rd_of = {(v["room"], v["date"]): k for k, v in hyp.items()}
    W = {}
    for w in json.load(open(windows_path)):
        if w["transcribed"]: W.setdefault(w["room_day_id"], []).append((w["start_ms"], w["end_ms"]))
    rows = list(csv.DictReader(open(truth_path))); keep = []; covs = []
    for r in rows:
        a = int(datetime.fromisoformat(r["called_at"]).timestamp() * 1000); b = int(datetime.fromisoformat(r["completed_at"]).timestamp() * 1000)
        iv = sorted((max(s, a), min(e, b)) for s, e in W.get(rd_of.get((r["room"], r["date"])), []) if min(e, b) > max(s, a))
        tot, cur = 0, None
        for s, e in iv:  # union, so overlapping windows are not double-counted
            if cur and s <= cur[1]: cur = (cur[0], max(cur[1], e))
            else:
                if cur: tot += cur[1] - cur[0]
                cur = (s, e)
        if cur: tot += cur[1] - cur[0]
        cov = tot / (b - a) if b > a else 0; covs.append(cov)
        if cov >= min_cov: keep.append(r)
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else []); w.writeheader(); w.writerows(keep)
    return len(keep), len(rows), covs

def score(truth_path, suffix):
    rows = []
    arms = ["acoustic", "fused", "fused-e61"] + (["arm-d"] if os.path.exists(f"{outdir}/hyp-arm-d.json") else [])
    for arm in arms:
        hyp = f"{outdir}/hyp-{arm}.json"; md = f"{outdir}/e7-score-{arm}{suffix}.md"
        r = subprocess.run([sys.executable, SCORER, "--truth", truth_path, "--hyp", hyp, "--out", md], capture_output=True, text=True)
        if r.returncode != 0:
            print(f"STAGE_FAIL score {arm}{suffix} rc={r.returncode}"); sys.exit(7)
        t = open(md).read()
        rows.append((arm, {k: (m.group(1) if (m := p.search(t)) else "?") for k, p in pat.items()}))
    return rows

def table(rows):
    out = ["| Arm | Hyp | Recall | Precision | Splits | Merges | Start err (s) | End err (s) |", "|---|---|---|---|---|---|---|---|"]
    out += [f"| {a} | {g['hyp']} | {g['recall']} | {g['precision']} | {g['splits']} | {g['merges']} | {g['start']} | {g['end']} |" for a, g in rows]
    return out

lines = ["## All consults"] + table(score(truth, ""))
wpath = f"{outdir}/windows.json"
if os.path.exists(wpath):
    kept, total, covs = covered_truth(truth, wpath, f"{outdir}/truth-covered.csv")
    zero = sum(1 for c in covs if c == 0)
    lines += ["", f"## Consults >= 50% transcribed ({kept} of {total}; {zero} with no transcript at all)",
              "Read RECALL here; read PRECISION from the table above (an encounter matching an uncovered consult counts as unmatched here)."]
    lines += table(score(f"{outdir}/truth-covered.csv", "-covered")) if kept else ["(none: every consult is an STT gap)"]
else:
    lines += ["", "(no windows.json: transcript coverage not measured)"]
open(f"{outdir}/SUMMARY.md", "w").write("\n".join(lines) + "\n")
print("\n".join(lines)); print("SCORE_DONE")
