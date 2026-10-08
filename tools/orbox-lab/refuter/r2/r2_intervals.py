# R2: independent recomputation of O2 cells and paired-difference intervals from the builder's jsonl.
# Also picks 3 cells for rescoring with a stated seed.
import json, glob, random, statistics as st, math, os
D = os.path.dirname(os.path.abspath(__file__)) + "/builder/"
rows = [json.loads(l) for f in sorted(glob.glob(D + "results2_*.jsonl")) for l in open(f) if l.strip()]
cell = {}
for r in rows:
    for k in ("A", "B", "sel", "fracA"):
        cell.setdefault((r["run"], r["tag"], r["arm"], k), {})[r["shift"]] = r[k]
dups = len(rows) - len({(r["run"], r["tag"], r["arm"], r["shift"]) for r in rows})
print("rows", len(rows), "duplicate (file,arm,shift)", dups, "cells with 8 shifts", sum(len(v) == 8 for v in cell.values()), "/", len(cell))
files = [("run3", f"snr{s}") for s in (20, 10, 5, 0)] + [("run4", t) for t in ("spL_nzR_0", "spR_nzL_0", "both_0", "both_10_g41")]
vec = lambda run, tag, arm, k: [cell[(run, tag, arm, k)][s] for s in range(8)]
T = 2.36
def interval(d):
    m = st.mean(d); h = T * st.stdev(d) / math.sqrt(len(d)); return m, m - h, m + h
def label(lo, hi): return "REAL" if lo > 0 or hi < 0 else "NOT-SHOWN"
print("\n# cells mean±sd")
for run, tag in files:
    print(run, tag, " | ".join(f"{arm} {k} {st.mean(vec(run,tag,arm,k)):.1f}±{st.stdev(vec(run,tag,arm,k)):.1f}" for arm in ("raw", "dfn") for k in ("A", "B", "sel")))
print("\n# paired differences")
for run, tag in files:
    for arm in ("raw", "dfn"):
        a, b, s = vec(run, tag, arm, "A"), vec(run, tag, arm, "B"), vec(run, tag, arm, "sel")
        best, bv = ("A", a) if st.mean(a) <= st.mean(b) else ("B", b)
        m, lo, hi = interval([x - y for x, y in zip(s, bv)])
        print(f"{run} {tag} {arm} sel-better({best}) {m:+.1f} [{lo:+.1f},{hi:+.1f}] {label(lo,hi)}")
for run, tag in files:
    for k in ("A", "B"):
        m, lo, hi = interval([x - y for x, y in zip(vec(run, tag, "dfn", k), vec(run, tag, "raw", k))])
        print(f"{run} {tag} DFN-raw mic{k} {m:+.1f} [{lo:+.1f},{hi:+.1f}] {label(lo,hi)}")
print("\n# shift-0 raw run3 snr5 micA:", cell[("run3", "snr5", "raw", "A")][0])
allcells = [(run, tag, arm, k) for run, tag in files for arm in ("raw", "dfn") for k in ("A", "B", "sel")]
pick = random.Random(20261007).sample(allcells, 3)
print("\n# random pick, random.Random(20261007).sample(48 cells, 3):", pick)
for c in pick: print(c, [round(x, 1) for x in vec(*c)], f"{st.mean(vec(*c)):.1f}±{st.stdev(vec(*c)):.1f}")
print("\n# extra: DFN selector - raw selector (builder claimed 'every file higher' from means only)")
for run, tag in files:
    m, lo, hi = interval([x - y for x, y in zip(vec(run, tag, "dfn", "sel"), vec(run, tag, "raw", "sel"))])
    print(f"{run} {tag} DFNsel-rawsel {m:+.1f} [{lo:+.1f},{hi:+.1f}] {label(lo,hi)}")
