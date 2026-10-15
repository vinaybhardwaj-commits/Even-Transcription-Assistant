#!/usr/bin/env python3
"""S1 report per PREREG-W33-S1.md: score old/new result dirs with the PASSed diag-rig scorer (eta-lab 5d87140b),
paired bootstrap, verdict, scorecard file. usage: s1_report.py OLD_RESULTS NEW_RESULTS OUT_JSON [SUITE_DIR]"""
import json, os, random, sys, collections
sys.path.insert(0, "/tmp/wt-rf-s1-m6/kit/diag-rig")
import score, wavio  # noqa: E402
OLD, NEW, OUTF = sys.argv[1:4]
SUITE = sys.argv[4] if len(sys.argv) > 4 else os.path.expanduser("~/eta-data/diag-rig/stimuli/clinical1")
man = wavio.jload(SUITE + "/suite.json")

def rows_for(rdir):
    out = {}
    for it in man["items"]:
        sid = it["stimulus_id"]
        p = f"{rdir}/{sid}.result.json"
        if not os.path.exists(p) or it["kind"] not in ("dialogue", "noisy_dialogue"):
            continue
        truth = wavio.jload(f"{SUITE}/{sid}.truth.json")
        out[sid] = score.score_stimulus(truth, wavio.jload(p), f"{SUITE}/{sid}.wav")
    return out
O, N = rows_for(OLD), rows_for(NEW)
sids = sorted(set(O) & set(N))
cond = lambda r: {"clean": "clean"}.get(r.get("variant"), "fan10" if "fan" in (r.get("variant") or "") else "babble5")

def hitcount(r):
    """(found, total) of drug+dose; ta/ml drug only (dose/follow-up diagnostic)."""
    it = r.get("items")
    if not it:
        return 0, 0
    lang = r["lang"]
    if lang in ("ta", "ml"):
        return it["drug"][0], it["drug"][1]
    return it["drug"][0] + it["dose"][0], it["drug"][1] + it["dose"][1]

def agg(rs, ids):
    f = t = 0; w = []; c = []
    for i in ids:
        a, b = hitcount(rs[i]); f += a; t += b
        tr = rs[i].get("text_roman")
        if tr:
            w.append(tr["wer"]); c.append(tr["cer"])
    m = lambda x: round(sum(x) / len(x), 4) if x else None
    return {"hit": round(100 * f / t, 2) if t else None, "wer": m(w), "cer": m(c)}

groups = collections.defaultdict(list)
for i in sids:
    r = O[i]; groups[(r["lang"], cond(r))].append(i); groups[(r["lang"], "all")].append(i); groups[("all", cond(r))].append(i); groups[("all", "all")].append(i)

def boot(ids, key, n=10000, seed=20260927):
    rnd = random.Random(seed); d = []
    for _ in range(n):
        s = [ids[rnd.randrange(len(ids))] for _ in ids]
        o, nw = agg(O, s)[key], agg(N, s)[key]
        if o is not None and nw is not None:
            d.append(nw - o)
    d.sort()
    return d[int(0.025 * len(d))], d[int(0.975 * len(d)) - 1]

rows = []
for (lang, cd), ids in sorted(groups.items()):
    row = {"lang": lang, "cond": cd, "n": len(ids), "old": agg(O, ids), "new": agg(N, ids)}
    if len(ids) >= 24 and lang == "all" and cd == "all" or len(ids) >= 24:
        lo, hi = boot(ids, "hit")
        row["hit_delta_ci95"] = [round(lo, 2), round(hi, 2)]
        row["sig"] = bool(lo > 0 or hi < 0)
        clo, chi = boot(ids, "cer")
        row["cer_delta_ci95"] = [round(clo, 4), round(chi, 4)]
    rows.append(row)
G = {(r["lang"], r["cond"]): r for r in rows}
indic = [i for i in sids if O[i]["lang"] in ("hi", "kn", "ta", "te", "ml")]
en = [i for i in sids if O[i]["lang"] == "en"]
ai, ae = agg(O, indic), agg(N, indic); ei, ee = agg(O, en), agg(N, en)
C1 = ae["hit"] >= ai["hit"] and ae["cer"] <= ai["cer"]
C2 = (ee["hit"] >= ei["hit"] - 5) and (ee["cer"] <= ei["cer"] + 0.03)
C3 = all(G[(l, "all")]["new"]["hit"] >= G[(l, "all")]["old"]["hit"] - 5 for l in {O[i]["lang"] for i in sids} if G[(l, "all")]["old"]["hit"] is not None)
lo, hi = G[("all", "all")]["hit_delta_ci95"]
clo, chi = G[("all", "all")].get("cer_delta_ci95", (None, None))
if not (C2 and C3) or hi < 0:
    st = "worse"
elif C1 and C2 and C3 and lo > 0:
    st = "win"
else:
    st = "no-win"
rep = {"schema": 1, "run_id": "s1-" + os.path.basename(os.path.dirname(OLD.rstrip("/"))), "prereg_sha256": "3e5857fc9285 (12-char prefix of PREREG-W33-S1.md)",
       "old": "router_server 400710ee (03310ca)", "new": "router-fix/lid b9085b1", "suite_id": "clinical1", "suite_sha256": man.get("suite_sha256") or "ef19d6a2b68e26ae2105cf89bbdfe537bf2008e7d8ea093b6022c37bb7966f4d",
       "rows": rows, "verdict": {"status": st, "note": f"C1 {C1} C2 {C2} C3 {C3}; overall hit CI [{lo:.1f},{hi:.1f}]"[:120]},
       "constraints": {"C1": C1, "C2": C2, "C3": C3, "indic": [ai, ae], "en": [ei, ee]},
       "overall_cer_delta_ci95": [clo, chi], "n_stimuli": len(sids)}
# M6 attribution (eta-refuter-2 #4387): stimuli where the NEW router's dominant language differs from
# OLD's AND from truth's language, i.e. a wrong-Indic-language pick, not an en/Indic gate decision.
def dom(res_dir, sid):
    d = json.load(open(f"{res_dir}/{sid}.result.json"))
    segs = [s for s in d["engines"]["stt"].get("segments", []) if s.get("text")]
    if not segs:
        return None
    c = collections.Counter()
    for s in segs:
        c[s["lang"]] += len(s["text"])
    return c.most_common(1)[0][0]
m6 = collections.defaultdict(lambda: [0, 0])
for i in sids:
    truth_lang = O[i]["lang"]
    nl = dom(NEW, i)
    if nl and nl != truth_lang and nl not in truth_lang.split("-") and O[i].get("items") and N[i].get("items"):
        ho, _ = hitcount(O[i]); hn, _ = hitcount(N[i])
        key = (truth_lang, nl)
        m6[key][0] += 1
        m6[key][1] += ho - hn
rep["m6_wrong_language_attribution"] = {f"{k[0]}->{k[1]}": {"n": v[0], "hit_loss": v[1]} for k, v in sorted(m6.items(), key=lambda x: -x[1][1]) if v[1] != 0}
os.makedirs(os.path.dirname(OUTF), exist_ok=True)
json.dump(rep, open(OUTF, "w"), indent=1); os.chmod(OUTF, 0o640)
print(json.dumps({"verdict": rep["verdict"], "constraints": rep["constraints"], "n": len(sids)}, indent=1))
for r in rows:
    if r["cond"] == "all":
        print(r["lang"], r["n"], "old", r["old"], "new", r["new"], r.get("hit_delta_ci95", ""))
