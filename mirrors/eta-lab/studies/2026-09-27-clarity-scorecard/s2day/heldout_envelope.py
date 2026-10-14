"""W33.4b (eta-refuter-2 cond 4): the day's wrong-time false-link envelope through the SAME decide() at the day's calibrated thresholds.
IN-SAMPLE shifts = the ones calibrate() used (-150 -90 +90 +150 min); HELD-OUT shifts = -240 -180 -120 -60 -45 +45 +60 +120 +180 +240 min (not used to tune). Per shift and pooled: the share of shifted spans that still LINK (any) / CONFIRM,
with Wilson 95% intervals. Counts only; no text. Run like cap_link: CAP_DAY=2026-09-26 python3 heldout_envelope.py   (writes ~/eta-data/cap/<day>/heldout_envelope.json, 0600)."""
import datetime as dt, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cap_link as L
INS, HELD = (-150, -90, 90, 150), (-240, -180, -120, -60, -45, 45, 60, 120, 180, 240)
cap = {}
_orig = L.calibrate
def _wrap(ctx, recs):
    cap["ctx"], cap["recs"] = ctx, recs
    return _orig(ctx, recs)
L.calibrate = _wrap
if L.DAY == "2026-09-25" and not L.TAG:
    raise SystemExit("refused: it would write heldout_envelope.json into the frozen CAP-1 bundle dir cap/2026-09-25/; set CAP_TAG for a check run")
links, th, ctrl, _ = L.main()
ctx, recs = cap["ctx"], cap["recs"]


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 1.0)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); w = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((c - w) / d, 4), round((c + w) / d, 4))


def rates(shifts):
    per, tot = {}, [0, 0, 0]
    for sh in shifts:
        n = a = c = 0
        for r in recs:
            cand = ctx.candidates(r["terms"], r["a"] + dt.timedelta(minutes=sh), r["b"] + dt.timedelta(minutes=sh))
            if not cand:
                continue
            st = L.decide(ctx, r["terms"], cand, th)[0]
            n += 1; a += st != "none"; c += st == "confirmed"
        per[str(sh)] = dict(trials=n, any=a, confirmed=c)
        tot[0] += n; tot[1] += a; tot[2] += c
    return dict(per_shift=per, pooled=dict(trials=tot[0], any=tot[1], confirmed=tot[2], any_rate=round(tot[1] / max(tot[0], 1), 4), confirmed_rate=round(tot[2] / max(tot[0], 1), 4),
                                           any_wilson95=wilson(tot[1], tot[0]), confirmed_wilson95=wilson(tot[2], tot[0])))


out = dict(day=L.DAY, thresholds=th, calibration_control=ctrl, in_sample=rates(INS), held_out=rates(HELD), limits=L.MAX_FALSE,
           observed=dict(links_any=sum(1 for l in links if l["status"] != "none"), confirmed=sum(1 for l in links if l["status"] == "confirmed"), consults=len(links)))
p = L.OUT + "heldout_envelope.json"
json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
print(json.dumps(dict(day=L.DAY, in_sample=out["in_sample"]["pooled"], held_out=out["held_out"]["pooled"], observed=out["observed"])))
