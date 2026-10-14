#!/usr/bin/env python3
"""VP-AUTO rev9 (pre-reg sha256 6a564f7f2d0ff11a5a773226d7787183467d4aab3bbc2095718fc1a655a041b7, FROZEN): mint + gates + routing.
CPU only (F0 via librosa pyin): run with the nemo venv  ~/eta-data/nemotron/venv-nemo-main/bin/python3 vp_auto.py --set dev
  --set dev    the 6 ear-confirmed doctors of 06 Oct (existing embeddings in ~/eta-data/vp-fast, the 112 selected windows)
  --set test   the test-set doctors (embeddings in ~/eta-data/vp-auto). NOT to be run until consult-lead's GO after the independent review.
Reading choices where rev9 is ambiguous (the STRICTER reading is taken and listed here; no threshold is changed):
 R1 windows = every CLOSED window of the doctor that was extracted (all qualities, as rev9 'closed windows'); clean-only numbers are reported beside it, never used for routing.
 R2 print = mean of the doctor's mint-matching clusters (cos >= 0.55 to the seed = the top meta-cluster of the doctor's own clusters at merge 0.45 average linkage, frozen
    mine_centroid_multi 463042a0), L2-normalised; matching is then re-evaluated against that print (one pass, fixed). Single centroid per doctor.
 R3 comparison set = every other print of this run + the provisional prints + all 7 production prints, EXCEPT prints of the same doctor (the doctor's provisional print, the production print with his name).
    Production prints are used although their model is UNVERIFIED (more comparators = stricter).
 R4 G-loo: windows = all the doctor's windows that have >= 1 embedded cluster; a window whose rebuilt print cannot be built (no other matching clusters) FAILS; margin = own cos - best other cos of that cluster; top-1 = margin > 0.
 R5 G-presence: present = the union of the window's mint-matching clusters has >= 15 s of speech (as P3 of vp-fast); denominator = windows with any embedded cluster.
 R6 G-distinct: a pair >= 0.60 between two doctors of this run sends both to EAR; against a provisional/production print of a doctor not in this run, only this doctor.
 R7 G-sex: no name-sex reference (uncertain / not in the frozen table) can never contradict; F0 < 2 s voiced = inconclusive. Precedence when several apply: REJECT, then WAIT, then EAR, then AUTO
    (a clear sex contradiction is checked before G-thin; REJECT is the stricter outcome).
 R8 absorption P4b (>= 2 mint-matching clusters of >= 15 s in a window) is REPORTED ONLY.
Outputs (box only, 0600): ~/eta-data/vp-auto/routes_<set>.json (gate values, routes, prints)."""
import argparse, base64, collections, csv, glob, hashlib, importlib.util, json, os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-10-06-vp-fast"))
import vp_fast_mint as vm
E = vm.E
# ---- rev9 thresholds (FROZEN) ----
COS = 0.55
THIN_WIN, THIN_DAYS, THIN_SEC = 5, 2, 60.0
DEAD_LO, DEAD_HI = 145.0, 185.0
LOO_TOP1, LOO_MARGIN = 0.90, 0.30
DISTINCT = 0.60
PRESENCE = 0.80
PRESENT_SEC = 15.0
PREREG_SHA = "6a564f7f2d0ff11a5a773226d7787183467d4aab3bbc2095718fc1a655a041b7"

# ---------------------------------------------------------------- pure gates (unit-tested at every boundary)
def gate_thin(n_windows, n_days, total_sec): return n_windows >= THIN_WIN and n_days >= THIN_DAYS and total_sec >= THIN_SEC
def f0_class(f0, voiced_s):
    """-> 'F' | 'M' | 'DEAD' | 'NONE' (no usable F0). < 145 Hz M, > 185 Hz F, 145-185 inclusive = dead zone."""
    if f0 is None or voiced_s < 2.0: return "NONE"
    return "F" if f0 > DEAD_HI else ("M" if f0 < DEAD_LO else "DEAD")
def gate_sex(f0, voiced_s, name_sex, name_uncertain):
    """-> dict(status=PASS|INCONCLUSIVE|CONTRADICT, f0_class, dead_zone). A missing/uncertain name sex can never contradict."""
    c = f0_class(f0, voiced_s); known = name_sex in ("F", "M") and not name_uncertain
    if c in ("F", "M") and known and c != name_sex: st = "CONTRADICT"
    elif c in ("DEAD", "NONE"): st = "INCONCLUSIVE"
    elif not known: st = "INCONCLUSIVE"
    else: st = "PASS"
    return dict(status=st, f0_class=c, dead_zone=(c == "DEAD"), name_known=known)
def gate_loo(rows):
    """rows: [(top1: bool, margin: float)] one per window. Pass: top-1 in >= 90% of windows AND median margin >= 0.30."""
    if not rows: return False
    top1 = sum(1 for t, _ in rows if t) / len(rows); med = float(np.median([m for _, m in rows]))
    return top1 >= LOO_TOP1 - 1e-12 and med >= LOO_MARGIN - 1e-12
def gate_distinct(max_cos): return max_cos < DISTINCT
def gate_presence(n_present, n_with_speech): return n_with_speech > 0 and n_present / n_with_speech >= PRESENCE - 1e-12
def route(thin, sex, loo, distinct, presence, name_uncertain):
    """rev9 routing with precedence REJECT > WAIT > EAR > AUTO. sex = the dict of gate_sex."""
    if sex["status"] == "CONTRADICT": return "REJECT", "G-sex contradicts"
    if not thin: return "WAIT", "G-thin fails"
    fails = [n for n, ok in (("G-loo", loo), ("G-distinct", distinct), ("G-presence", presence)) if not ok]
    if fails: return "EAR", " and ".join(fails) + " fail"
    if sex["dead_zone"] and name_uncertain: return "EAR", "F0 in the dead zone and the name sex is uncertain"
    return "AUTO", "all gates pass"

# ---------------------------------------------------------------- data
def load_windows(out_dir, selected_json=True):
    W = {}; sel = None
    if selected_json and os.path.exists(f"{out_dir}/windows_selected.json"): sel = {x["consult_uid"] for x in json.load(open(f"{out_dir}/windows_selected.json"))["windows"]}
    for f in glob.glob(f"{out_dir}/emb/*.json"):
        if sel is not None and os.path.basename(f)[:-5] not in sel: continue
        d = json.load(open(f)); cl = []
        for c in d["clusters"]:
            e = None if c.get("embedding_b64") is None else vm.nrm(vm.b64(c["embedding_b64"])); raw = None if e is None else vm.b64(c["embedding_b64"])
            cl.append(dict(spk=c["speaker_raw"], sec=c["total_speech_sec"], emb=e, raw=raw))
        W[d["consult_uid"]] = dict(cid=d["consult_uid"], uid=d["uid"], room=d["room_id"], quality=d["quality"], day=d["day"], t_open=d["t_open"], clusters=cl, turns=d["turns"], dir=out_dir)
    return W

def audio_from_dirs(cache={}):
    def audio16(cid, dir_hint=None):
        import subprocess
        for d in (dir_hint, f"{E}/vp-fast", f"{E}/vp-auto"):
            if d and os.path.exists(f"{d}/audio/{cid}.m4a"):
                if cid not in cache:
                    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", f"{d}/audio/{cid}.m4a", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True)
                    if len(cache) > 6: cache.pop(next(iter(cache)))
                    cache[cid] = np.frombuffer(p.stdout, dtype=np.float32)
                return cache[cid]
        raise FileNotFoundError(cid)
    return audio16

def seed_and_print(windows):
    """R2: seed = top meta-cluster centroid (frozen mine_centroid_multi); print = normalised mean of the clusters matching the seed (cos >= 0.55)."""
    pool = [dict(clip_id=w["cid"], date=w["day"], room=w["room"], speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"]) for w in windows for c in w["clusters"] if c["emb"] is not None]
    if len(pool) < 1: return None
    if len(pool) == 1: return vm.nrm(pool[0]["embedding"])
    a = vm.mc.analyze(pool, vm.mc.cluster_pool(pool, 0.45)); seed = vm.nrm(a["top"][0]["centroid"])
    m0 = [c["raw"] for w in windows for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], seed)) >= COS]
    return vm.nrm(np.stack(m0).mean(axis=0)) if m0 else seed

def matching(w, pr): return [c for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], pr)) >= COS]

def analyze_doctor(windows, pr, others, name_sex, name_uncertain, f0_fn):
    """windows: the doctor's windows (dicts as load_windows); pr: his print; others: {label: unit vector} comparison set (same doctor already removed);
    f0_fn(windows_with_speaker_sets) -> (median_hz, voiced_s). Returns gate values and route."""
    ws = [w for w in windows if any(c["emb"] is not None for c in w["clusters"])]
    mw = [(w, matching(w, pr)) for w in ws]; with_match = [(w, m) for w, m in mw if m]
    n_days = len({w["day"] for w, _ in with_match}); total_sec = sum(c["sec"] for _, m in with_match for c in m)
    thin = gate_thin(len(with_match), n_days, total_sec)
    # G-loo (R4)
    rows = []
    for w in ws:
        rest = [c["raw"] for x in ws if x is not w for c in matching(x, pr)]
        if not rest: rows.append((False, -1.0)); continue
        own = vm.nrm(np.stack(rest).mean(axis=0)); cl = [c for c in w["clusters"] if c["emb"] is not None]
        best = max(cl, key=lambda c: float(np.dot(c["emb"], own)))
        mo = float(np.dot(best["emb"], own)); oth = max((float(np.dot(best["emb"], p)) for p in others.values()), default=-1.0)
        rows.append((mo - oth > 0, mo - oth))
    loo = gate_loo(rows)
    # G-distinct (R6)
    cs = {lab: float(np.dot(pr, p)) for lab, p in others.items()}; max_cos = max(cs.values(), default=-1.0); top_other = max(cs, key=cs.get) if cs else None
    distinct = gate_distinct(max_cos)
    # G-presence (R5)
    present = sum(1 for w, m in mw if sum(c["sec"] for c in m) >= PRESENT_SEC); presence = gate_presence(present, len(ws))
    # G-sex
    f0, vs = f0_fn([(w, {c["spk"] for c in m}) for w, m in with_match]); sex = gate_sex(f0, vs, name_sex, name_uncertain)
    rt, why = route(thin, sex, loo, distinct, presence, name_uncertain)
    absorb = sum(1 for w, m in mw if sum(1 for c in m if c["sec"] >= PRESENT_SEC) >= 2)
    return dict(route=rt, why=why, gates=dict(
        G_thin=dict(ok=thin, windows_with_match=len(with_match), days=n_days, seconds=round(total_sec, 1)),
        G_sex=dict(ok=sex["status"] != "CONTRADICT", status=sex["status"], f0_median_hz=None if f0 is None else round(f0, 1), voiced_s=round(vs, 1), f0_class=sex["f0_class"], name_sex=name_sex, name_uncertain=name_uncertain),
        G_loo=dict(ok=loo, windows=len(rows), top1_share=round(sum(1 for t, _ in rows if t) / max(1, len(rows)), 3), median_margin=round(float(np.median([m for _, m in rows])), 3) if rows else None),
        G_distinct=dict(ok=distinct, max_cos=round(max_cos, 3), closest=top_other),
        G_presence=dict(ok=presence, present=present, windows_with_speech=len(ws), share=round(present / max(1, len(ws)), 3))),
        reported_only=dict(P4b_absorption_share=round(absorb / max(1, len(ws)), 3), windows_total=len(windows), qualities=dict(collections.Counter(w["quality"] for w in windows))))

def apply_distinct_pairs(results, prints, run_labels):
    """R6: a pair of run doctors at >= 0.60 -> both EAR (a REJECT or WAIT stays)."""
    for i, x in enumerate(run_labels):
        for y in run_labels[i + 1:]:
            c = float(np.dot(prints[x], prints[y]))
            if c < DISTINCT: continue
            for u in (x, y):
                r = results[u]
                if r["route"] in ("AUTO", "EAR"):
                    note = f"G-distinct pair with another doctor of this run (cos {c:.3f})"
                    r["why"] = note if r["route"] == "AUTO" else r["why"] + "; " + note
                    r["route"] = "EAR"; r["gates"]["G_distinct"]["ok"] = False

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--set", choices=["dev", "test"], required=True); ap.add_argument("--export", required=True); a = ap.parse_args()
    assert hashlib.sha256(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "VP-AUTO-PREREG-rev9.md"), "rb").read()).hexdigest() == PREREG_SHA, "pre-reg sha differs: STOP"
    sx = {r["doctor_uid"]: r for r in csv.DictReader(open(f"{E}/centroid-mint/roomsub/SEXTABLE_rev7.FROZEN.csv"))}
    names = {}
    for l in open(a.export): r = json.loads(l); names[r["consulting_doctor_uid"]] = r["consulting_doctor_name"]
    if a.set == "dev":
        W = load_windows(f"{E}/vp-fast"); labels = ["F092iDIAfwXKtLCqP8HS", "0q9pSZHR24ysquO6V4Xg", "bKr81BFLZSuiMa7MvhaA", "FxzVVvnPjgPOD6JeamKd", "YV4NMGVRlMHSAtJJfvqH", "8ih9F6QLntcLDCZhXDeq"]
    else:
        W = load_windows(f"{E}/vp-auto"); labels = sorted({w["uid"] for w in W.values()})
    vm.audio16 = audio_from_dirs()
    prod = [dict(name=x["name"], v=vm.nrm(vm.b64(x["centroid_b64_float32_le"].replace("\\n", "")))) for x in json.load(open(f"{E}/consult/prod-prints.json"))]
    prov = {p["doctor_uid"]: vm.nrm(np.array(p["centroid_192_l2"], dtype=np.float32)) for p in json.load(open(f"{E}/consult/prints-provisional-06oct.json"))["prints"]}
    PRODUID = {"Ankit": "F092iDIAfwXKtLCqP8HS", "Poornima": "0q9pSZHR24ysquO6V4Xg", "Dibyendu": "bKr81BFLZSuiMa7MvhaA", "Animesh": "mGXTEDg9o9WNR9gpZ4sY", "Salanki": "MFTZnXMshE91P7fHnqgX"}
    prod_uid = lambda nm: next((u for k, u in PRODUID.items() if k.lower() in nm.lower()), None)
    docw = {u: [w for w in W.values() if w["uid"] == u] for u in labels}
    prints = {u: seed_and_print(ws) for u, ws in docw.items() if ws}
    results = {}
    for u, ws in docw.items():
        if u not in prints: results[u] = dict(route="WAIT", why="no extracted windows", gates={}); continue
        others = {f"run:{names.get(v, v)}": p for v, p in prints.items() if v != u}
        others.update({f"provisional:{names.get(v, v)}": p for v, p in prov.items() if v != u})
        others.update({f"production:{p['name']}": p["v"] for p in prod if prod_uid(p["name"]) != u})
        sxr = sx.get(u); ns = sxr["sex"] if sxr else None; unc = (sxr["uncertain"] == "Y") if sxr else True
        res = analyze_doctor(ws, prints[u], others, ns, unc, lambda items: vm.median_f0(items))
        clean = [w for w in ws if w["quality"] == "clean"]
        if clean and len(clean) != len(ws):                                        # R1: clean-only numbers beside, never used for routing
            pr_c = seed_and_print(clean); rc = analyze_doctor(clean, pr_c, others, ns, unc, lambda items: vm.median_f0(items)) if pr_c is not None else None
            res["clean_only_informational"] = None if rc is None else dict(route=rc["route"], why=rc["why"], gates=rc["gates"])
        res["name"] = names.get(u, u); res["print"] = [round(float(x), 7) for x in prints[u]]; results[u] = res
    apply_distinct_pairs(results, prints, [u for u in labels if u in prints])
    os.makedirs(f"{E}/vp-auto", mode=0o700, exist_ok=True)
    out = f"{E}/vp-auto/routes_{a.set}.json"; fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(prereg_sha256=PREREG_SHA, set=a.set, export=os.path.basename(a.export), doctors=results), fh, indent=1, default=str)
    for u, r in results.items():
        g = r["gates"]
        print(r.get("name", u), "->", r["route"], "|", r["why"], "|", {k: {kk: vv for kk, vv in v.items() if kk != "name_sex"} for k, v in g.items()}, "| reported:", r.get("reported_only"))
    print("routes", out, vm.f16(out))

if __name__ == "__main__": main()
