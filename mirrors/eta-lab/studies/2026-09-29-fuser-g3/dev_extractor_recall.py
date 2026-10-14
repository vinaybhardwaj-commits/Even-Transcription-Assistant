"""DEV-only extractor symmetry check (refuter-2 #6980 N1): per-system drug / drug+dose recall vs clinical1 truth.
P = old router S1 outputs, v1 = RUN 3 kept native text (pre_v7.materialized). Never run on TEST. Reads router-fix files read-only."""
import json, glob, os, sys, collections
sys.path.insert(0, "/tmp/wt-lid-debug-g3/studies/2026-09-29-fuser-g3"); sys.path.insert(0, "/home/eta/oc/router-fix/repo")
import g3_build as G
import s1_numbers as N
CS = N.load_scorer()
RD, UN = N.make_reader(CS), N.make_unit_reader(CS)
from fuserv1 import drug_match as DM, lexicon as LX
lex = LX.load_lexicon("/home/eta/eta-data/cap2/rx_history.jsonl")
ST = "/home/eta/eta-data/diag-rig/stimuli/clinical1"
truth = {}
for f in glob.glob(ST + "/*.truth.json"):
    sid = os.path.basename(f)[:-11]; t = json.load(open(f))
    truth[sid] = [(" ".join(i["name"].lower().split()), i.get("dose_value")) for i in t["clinical_items"] if i["type"] == "drug"]
gens = set(lex) | {n for v in truth.values() for n, _ in v}          # truth names added so recall isn't capped by lexicon gaps
skels = {g: DM._english_skeleton(g) for g in gens}
def native_drug(tok):
    s = DM._indic_skeleton(tok)
    if len(s) < 3: return None
    sc = sorted(((DM._sim(s, k), g) for g, k in skels.items() if k and abs(len(k) - len(s)) <= max(1, len(k) // 5)), reverse=True)
    if sc and sc[0][0] >= 0.8 and (len(sc) == 1 or sc[0][0] - sc[1][0] >= 0.1): return sc[0][1]
    return None
def seg(t): return [{"text": t, "t0_ms": 0, "t1_ms": 1}]
P = {os.path.basename(f)[:-12]: (json.load(open(f))["engines"]["stt"].get("text") or "") for f in glob.glob("/home/eta/oc/router-fix/s1-results/old/*.result.json")}
V1 = {}
for l in open("/home/eta/oc/router-fix/eval-out/b4-dev-run-3.jsonl"):
    r = json.loads(l)
    if not r["window_id"].startswith("clin"): continue
    txt = []
    for sl in r["result"]["slices"]:
        val = sl.get("validated") or {}; m = (val.get("pre_v7") or val).get("materialized") or {}
        txt += [m[k] for k in sorted(m, key=int)]
    V1[r["window_id"]] = " ".join(txt)
FULL = G.ReferenceExtractor(gens, native_drug=native_drug, native_number=RD, native_unit=UN)
for mode, ex in (("with_native_drug", G.ReferenceExtractor(gens, native_drug=native_drug)), ("FULL (native drug+number+unit)", FULL)):
    agg = collections.defaultdict(lambda: collections.Counter())
    for sid, items in truth.items():
        lang = sid.split("_")[1]
        for sysn, src in (("P", P), ("v1", V1)):
            got = {}
            for e in ex.extract(seg(src.get(sid, ""))):
                got.setdefault(e["generic"], []).append(e)
            for n, dv in items:
                a = agg[(lang, sysn)]; a["n"] += 1
                if n in got:
                    a["drug"] += 1
                    doses = {e.get("dose_value") for e in got[n] if e.get("dose_value") is not None}
                    if dv is not None and float(dv) in doses: a["dose"] += 1
                    if dv is not None and any(d != float(dv) for d in doses): a["wrong_dose"] += 1   # refuter-2 #7015
    print("==", mode)
    for lang in sorted({k[0] for k in agg}):
        row = [lang]
        for sysn in ("P", "v1"):
            a = agg[(lang, sysn)]; row.append(f"{sysn} drug {100*a['drug']/a['n']:.0f}% dose {100*a['dose']/a['n']:.0f}% wrongdose {100*a['wrong_dose']/a['n']:.0f}%")
        print("  ", " | ".join(row))

# ACCEPTANCE (Fable #7009): extractor dose recall vs the S1 scorer's own dose hit rate, per system per language (DEV only)
print("== ACCEPTANCE: ITEM-DRIVEN renderer dose recall vs S1-scorer dose hit, per system (gap must be <= ~5 pts)")
acc = collections.defaultdict(collections.Counter)
TR = {}
for f in glob.glob(ST + "/*.truth.json"):
    TR[os.path.basename(f)[:-11]] = json.load(open(f))
for sid, t in TR.items():
    lang = sid.split("_")[1]
    drugs = [i for i in t["clinical_items"] if i["type"] == "drug"]
    for sysn, src in (("P", P), ("v1", V1)):
        text = src.get(sid, "")
        sc = CS.items_score(drugs, text, lang)
        names = [" ".join(i["name"].lower().split()) for i in drugs]
        got = {}
        for n in names:
            rr = N.make_rx_renderer(CS, other_generics=[m for m in names if m != n], policy=os.environ.get("RX_POLICY", "unit_or_first"))
            got[n] = G.flatten_rx(rr(n, seg(text)))
        a = acc[(lang, sysn)]
        a["n"] += len(drugs); a["s1_dose"] += sc["dose"][0]
        for i in drugs:
            n = " ".join(i["name"].lower().split()); dv = i.get("dose_value")
            doses = {e.get("dose_value") for e in got.get(n, []) if e.get("dose_value") is not None}
            if dv is not None and float(dv) in doses: a["ex_dose"] += 1
            if dv is not None and any(d != float(dv) for d in doses): a["ex_wrong"] += 1
worst = 0
for lang in sorted({k[0] for k in acc}):
    row = [lang]
    for sysn in ("P", "v1"):
        a = acc[(lang, sysn)]; s1 = 100 * a["s1_dose"] / a["n"]; ex = 100 * a["ex_dose"] / a["n"]; w = 100 * a["ex_wrong"] / a["n"]
        worst = max(worst, abs(ex - s1))
        row.append(f"{sysn} S1 {s1:.0f} ex {ex:.0f} gap {ex - s1:+.0f} wrong {w:.0f}")
    print("  ", " | ".join(row))
print("max |gap| =", round(worst, 1))
