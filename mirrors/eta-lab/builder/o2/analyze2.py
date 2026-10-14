# O2 analysis of results2_*.jsonl. Prints markdown tables. Paired difference = same shift on both arms; interval = mean +- 2.36*sd/sqrt(8).
import json, glob, numpy as np
R = [json.loads(l) for f in sorted(glob.glob("results2_*.jsonl")) for l in open(f)]
FILES = [("run3", f"snr{s}") for s in (20, 10, 5, 0)] + [("run4", t) for t in ("spL_nzR_0", "spR_nzL_0", "both_0", "both_10_g41")]
def v(run, tag, arm, key):
    d = {r["shift"]: r[key] for r in R if (r["run"], r["tag"], r["arm"]) == (run, tag, arm)}; assert len(d) == 8, (run, tag, arm, key, len(d)); return np.array([d[s] for s in range(8)])
def ms(x): return f"{x.mean():.1f}±{x.std(ddof=1):.1f}"
print("## cells: mean±sd over 8 shifts (WER %)")
print("file | raw A | raw B | raw sel | DFN A | DFN B | DFN sel | raw A range")
for run, tag in FILES:
    c = [ms(v(run, tag, a, k)) for a in ("raw", "dfn") for k in ("A", "B", "sel")]; rA = v(run, tag, "raw", "A")
    print(f"{run} {tag} | " + " | ".join(c) + f" | {rA.min():.1f}-{rA.max():.1f}")
def row(name, d):
    m, s = d.mean(), d.std(ddof=1); h = 2.36 * s / np.sqrt(8); lo, hi = m - h, m + h
    return f"{name} | {m:+.1f} | [{lo:+.1f}, {hi:+.1f}] | {'REAL' if lo > 0 or hi < 0 else 'NOT-SHOWN'}"
print("\n## paired differences (arm1 - arm2; negative = arm1 better)")
print("comparison | mean | 95% interval | verdict")
for run, tag in FILES:
    for arm in ("raw", "dfn"):
        A, B = v(run, tag, arm, "A"), v(run, tag, arm, "B"); best = "A" if A.mean() <= B.mean() else "B"
        print(row(f"{run} {tag} {arm}: sel - better mic ({best})", v(run, tag, arm, "sel") - (A if best == "A" else B)))
for run, tag in FILES:
    for k in ("A", "B"):
        print(row(f"{run} {tag}: DFN - raw, mic{k}", v(run, tag, "dfn", k) - v(run, tag, "raw", k)))
print("\n## fracA (mean over shifts)")
for run, tag in FILES: print(f"{run} {tag}: raw {v(run, tag, 'raw', 'fracA').mean():.2f} dfn {v(run, tag, 'dfn', 'fracA').mean():.2f}")
