#!/usr/bin/env python3
"""Score rate20 per tools/readability-rate/RATE20-PREREG.md (lab-viewer draft, owner surg-page).
Usage: python3 score_rate.py --key <seed2 key.json> --ratings <export dir> [--primary vinay]
                               [--allow-partial]
Seed drift is ALWAYS refused: sha256 of seed_docs.json beside --key must equal the pinned
SEED_SHA (override only for tests with --seed-sha).
Export: one <rater>.json per rater = {"<excerpt_id>": {answers}} (rate_seed.py export shape);
also accepts arrays/objects of schema-1 {rater,t} docs.
Report: per question per value k/n with Clopper-Pearson 95% per rater (n = completed excerpts,
never assumed); best-answer headline; descriptive splits by key indic flag; mode=audio|text is
recognised metadata (413d), scored separately and never as an answer; agreement on complete
pairs (raw % + Cohen kappa). Counts only: notes/ts stripped at load, never printed."""
import json, math, os, sys

BEST = {"readable": "yes", "useful": "yes", "wrong_lang": "no", "garbled": "none", "en_ok": "yes"}
VALUES = {"readable": ["yes", "partly", "no"], "useful": ["yes", "little", "no"],
          "wrong_lang": ["no", "some", "most"], "garbled": ["none", "some", "much"],
          "en_ok": ["yes", "partly", "no"]}
QS = list(BEST)
SEED_SHA = "3e83659314aa17796a5be7a3b363ccaef4ed1263f41d2f24d49cb305f62cab5d"

def _betacf(a, b, x):
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c, d = 1.0, 1.0 - qab * x / qap
    if abs(d) < 1e-300: d = 1e-300
    d = 1.0 / d
    h = d
    for m in range(1, 300):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300: d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300: c = 1e-300
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-300: d = 1e-300
        c = 1.0 + aa / c
        if abs(c) < 1e-300: c = 1e-300
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < 1e-13: break
    return h

def _betai(a, b, x):
    if x <= 0.0: return 0.0
    if x >= 1.0: return 1.0
    lb = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1.0 - x)
    if x < (a + 1.0) / (a + b + 2.0):
        return math.exp(lb) * _betacf(a, b, x) / a
    return 1.0 - math.exp(lb) * _betacf(b, a, 1.0 - x) / b

def _binv(p, a, b):
    s, e = 0.0, 1.0
    for _ in range(100):
        m = (s + e) / 2.0
        if _betai(a, b, m) < p: s = m
        else: e = m
    return (s + e) / 2.0

def clopper_pearson(k, n, alpha=0.05):
    lo = 0.0 if k == 0 else _binv(alpha / 2.0, k, n - k + 1.0)
    hi = 1.0 if k == n else _binv(1.0 - alpha / 2.0, k + 1.0, n - k)
    return (lo, hi)

def load_export(path):
    """Returns {rater: {excerpt_id: answers}} from either export shape."""
    raters = {}
    files = [os.path.join(path, f) for f in sorted(os.listdir(path)) if f.endswith(".json")] \
        if os.path.isdir(path) else [path]
    for fp in files:
        try:
            data = json.load(open(fp))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise SystemExit(f"REFUSED: {os.path.basename(fp)} is not readable JSON")
        base = os.path.basename(fp)[:-5]
        if isinstance(data, dict) and "rater" in data and "t" in data:
            add(raters, data["rater"], data["t"], base)
        elif isinstance(data, list):
            for d in data:
                if isinstance(d, dict) and "rater" in d and "t" in d:
                    add(raters, d["rater"], d["t"], base)
                else:
                    raise SystemExit(f"REFUSED: {base}: array element is not a schema-1 doc")
        elif isinstance(data, dict) and all(isinstance(v, dict) for v in data.values()):
            if data and all(("rater" in v and "t" in v) for v in data.values()):
                for k, v in data.items():
                    add(raters, v["rater"], v["t"], base)
                    if str(v["rater"]) != k:
                        raise SystemExit(f"REFUSED: {base}: doc rater does not match its key {k}")
            else:
                add(raters, base, data, base)
        elif data == {}:
            continue
        else:
            raise SystemExit(f"REFUSED: {base}: unknown export shape")
    return raters

def add(raters, r, t, src):
    r = str(r)
    if r in raters:
        raise SystemExit(f"REFUSED: rater {r} appears twice")
    if not isinstance(t, dict):
        raise SystemExit(f"REFUSED: {src}: t is not an object")
    raters[r] = t

def main():
    a = sys.argv
    arg = lambda f: a[a.index(f) + 1] if f in a else None
    kp = arg("--key")
    if not kp:
        raise SystemExit("REFUSED: --key required")
    key = json.load(open(kp))
    import hashlib
    sd = os.path.join(os.path.dirname(os.path.abspath(kp)), "seed_docs.json")
    if not os.path.exists(sd):
        raise SystemExit("REFUSED: no seed_docs.json beside the key file (seed cannot be verified)")
    want = arg("--seed-sha") or SEED_SHA
    got = hashlib.sha256(open(sd, "rb").read()).hexdigest()
    if got != want:
        raise SystemExit(f"REFUSED: seed drift: seed_docs.json sha256 {got[:16]}... != pinned {want[:16]}...")
    rp = arg("--ratings")
    if not rp:
        raise SystemExit("REFUSED: --ratings required")
    raters = load_export(rp)
    if not raters:
        raise SystemExit("REFUSED: zero raters in the export")
    if len(raters) != 2 and "--allow-partial" not in a:
        raise SystemExit(f"REFUSED: {len(raters)} raters (pre-reg: 2; use --allow-partial for an interim look)")
    refused, modes = {}, {}
    complete = {}
    for r, t in raters.items():
        refused[r], complete[r], modes[r] = [], {}, {}
        for eid, ans in t.items():
            if eid not in key:
                raise SystemExit("REFUSED: rated excerpt id is not in the pinned seed (run not scored)")
            why = None
            if not isinstance(ans, dict):
                why = "answers not an object"
            else:
                allowed = set(QS) | {"note", "ts", "mode"}
                extras = [k for k in ans if k not in allowed]
                if extras:
                    why = "unknown key"
                elif "mode" in ans and ans["mode"] not in (None, "audio", "text"):
                    why = "bad mode"
            if why is None:
                req = [q for q in QS if q != "en_ok"] + (["en_ok"] if key[eid].get("has_en") else [])
                for q in req:
                    v = ans.get(q)
                    if not isinstance(ans, dict) or q not in ans:
                        why = f"missing {q}"
                        break
                    if v not in VALUES[q]:
                        why = f"bad {q}"
                        break
                if why is None and isinstance(ans, dict) and "en_ok" in ans and not key[eid].get("has_en"):
                    why = "en_ok without English"
            if why:
                refused[r].append(why)
            else:
                complete[r][eid] = {q: ans[q] for q in QS if q in ans}
                if ans.get("mode"):
                    modes[r][eid] = ans["mode"]
    prim = arg("--primary") or ("vinay" if "vinay" in raters else None)
    if prim is None:
        raise SystemExit("REFUSED: no vinay in the export; pass --primary explicitly (pre-reg names V primary)")
    if prim not in raters:
        raise SystemExit("REFUSED: --primary is not in the export")
    print(f"seed: {len(key)} excerpts; key groups: indic {sum(1 for k in key.values() if k.get('indic'))}, "
          f"has_en {sum(1 for k in key.values() if k.get('has_en'))}")
    for r in sorted(complete):
        n = len(complete[r])
        print(f"\n=== {r}{' (PRIMARY)' if r == prim else ''}: {n}/{len(key)} complete, "
              f"{len(refused[r])} refused rows" +
              (f" ({', '.join(sorted(set(refused[r])))})" if refused[r] else "") + " ===")
        for q in QS:
            ans = [c[q] for c in complete[r].values() if q in c]
            nq = len(ans)
            if not nq:
                print(f"  {q}: -")
                continue
            cells = []
            for v in VALUES[q]:
                k = sum(1 for x in ans if x == v)
                lo, hi = clopper_pearson(k, nq)
                mark = "*" if v == BEST[q] else " "
                cells.append(f"{mark}{v} {k}/{nq} [{lo:.2f},{hi:.2f}]")
            print(f"  {q} (n={nq}): " + "  ".join(cells))
        for gname, sel in (("mostly-Indic", lambda e: key[e].get("indic")),
                           ("not mostly-Indic", lambda e: not key[e].get("indic"))):
            ids = {e for e in complete[r] if sel(e)}
            if not ids:
                continue
            print(f"  split {gname} (n={len(ids)}, descriptive): " + "  ".join(
                f"{q} {sum(1 for e in ids if complete[r][e].get(q) == BEST[q])}/{len([e for e in ids if q in complete[r][e]])}"
                for q in QS if any(q in complete[r][e] for e in ids)))
        for mname in ("audio", "text"):
            ids = {e for e in complete[r] if modes.get(r, {}).get(e) == mname}
            if not ids:
                continue
            print(f"  mode {mname} (n={len(ids)}, reported separately per 413d): " + "  ".join(
                f"{q} {sum(1 for e in ids if complete[r][e].get(q) == BEST[q])}/{len([e for e in ids if q in complete[r][e]])}"
                for q in QS if any(q in complete[r][e] for e in ids)))
    print("\n* marks the best answer")
    both = sorted(k for k in complete if len(complete) >= 2)
    if len(complete) == 2:
        p, s2 = prim, [r for r in sorted(complete) if r != prim][0]
        print(f"\n=== agreement {p} vs {s2} (excerpts both completed) ===")
        for q in QS:
            pairs = [(complete[p][e][q], complete[s2][e][q]) for e in complete[p]
                     if e in complete[s2] and q in complete[p][e] and q in complete[s2][e]]
            if not pairs:
                print(f"  {q}: -")
                continue
            raw = sum(1 for x, y in pairs if x == y)
            cb = [(x == BEST[q], y == BEST[q]) for x, y in pairs]
            print(f"  {q}: n={len(pairs)} raw {100.0 * raw / len(pairs):.0f}% "
                  f"kappa(best/not) {_kappa(cb):.2f} kappa(nominal) {_kappa(pairs):.2f}")
    else:
        print("\nagreement: n/a (fewer than 2 raters so far)")

def _kappa(pairs):
    labs = sorted({x for p in pairs for x in p})
    n = len(pairs)
    if n == 0 or len(labs) < 2:
        return float("nan")
    po = sum(1 for x, y in pairs if x == y) / n
    pe = sum((sum(1 for x, _ in pairs if x == l) / n) * (sum(1 for _, y in pairs if y == l) / n) for l in labs)
    return (po - pe) / (1.0 - pe) if pe < 1.0 else float("nan")

main()
