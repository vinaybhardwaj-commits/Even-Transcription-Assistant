"""COVERAGE.md: counts only. Run: ~/.venv-forest/bin/python -I coverage_report.py [OUT]"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd
import ft8_build as fb

out = sys.argv[1] if len(sys.argv) > 1 else fb.OUT
F = pd.read_parquet(f"{out}/features_ft8.parquet")
L = pd.read_parquet(fb.LABELS, filters=[("split", "==", "D")])[["episode_id", "rx_date", "h14", "h90"]]
M = F.merge(L, on="episode_id")
vals = [c for c in F.columns if c.startswith("ft8_") and not c.startswith("ft8_has_") and not c.endswith(("_age_d", "_n_pre"))]
vals += [c for c in F.columns if c.endswith("_age_d") and c.startswith("ft8_")]
vals = list(dict.fromkeys(vals))
sets = [("D all", M), ("h14 lab", M[M.h14.notna()]), ("h14 conv=1", M[M.h14 == 1]), ("h14 conv=0", M[M.h14 == 0]),
        ("h90 lab", M[M.h90.notna()]), ("h90 conv=1", M[M.h90 == 1]), ("h90 conv=0", M[M.h90 == 0])]
o = ["# FT8 coverage (counts only; non-missing / rows)\n",
     "Sets: D = 1,233 episodes; h14 = 1,101 labelled (189 converted); h90 = 659 labelled (150 converted).",
     "A count column (n_*) is 0 for 'no prior Even record' and is never NaN; coverage of those is the has_* flag.\n",
     "## Per feature, non-missing n (and % of the set)\n",
     "| feature | " + " | ".join(f"{n} (n={len(d)})" for n, d in sets) + " |", "|---|" + "---|" * len(sets)]
for c in vals:
    o.append(f"| {c} | " + " | ".join(f"{int(d[c].notna().sum())} ({100 * d[c].notna().mean():.1f}%)" for _, d in sets) + " |")
o += ["", "## has_* flags = 1 (n and %), by set\n", "| flag | " + " | ".join(n for n, _ in sets) + " |", "|---|" + "---|" * len(sets)]
for c in [c for c in F.columns if c.startswith("ft8_has_")]:
    o.append(f"| {c} | " + " | ".join(f"{int(d[c].sum())} ({100 * d[c].mean():.1f}%)" for _, d in sets) + " |")
M["rx_month"] = pd.to_datetime(M.rx_date).dt.strftime("%Y-%m")
flags = [c for c in F.columns if c.startswith("ft8_has_")]
months = sorted(M.rx_month.unique())
o += ["", "## Coverage by Rx month (has_* = 1 / episodes in month; drift: vitals, comorbidities and ip_events start in 2026)\n",
      "| month | n | " + " | ".join(c.replace("ft8_has_", "") for c in flags) + " |", "|---|---|" + "---|" * len(flags)]
for m in months:
    d = M[M.rx_month == m]
    o.append(f"| {m} | {len(d)} | " + " | ".join(str(int(d[c].sum())) for c in flags) + " |")
p = f"{out}/COVERAGE.md"
open(p, "w").write("\n".join(o) + "\n"); os.chmod(p, 0o600)
