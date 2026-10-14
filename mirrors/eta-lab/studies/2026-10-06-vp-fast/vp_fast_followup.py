#!/usr/bin/env python3
"""vp-fast-02: (1) provisional prints for the 6 doctors confirmed by V's ear, (2) leave-one-window-out self-check margins, (3) Nayar vs production prints / Animesh windows,
(4) what the absorption gate P4b measured for the 5 doctors it blocked. CPU only; nemo venv. Outputs (0600): ~/eta-data/consult/prints-provisional-06oct.json, ~/eta-data/vp-fast/followup.json.
NO write to Neon voice_print or any production table."""
import collections, csv, glob, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vp_fast_mint as vm
E = vm.E; OUT = vm.OUT; COS = vm.COS
EVID = "V-ear-2026-10-06T18:08 IST; manifest sha16 afc6d7f649a71eb0 (strict) / 1a9ef70887b5e946 (tier-2)"
CONFIRMED = ["F092iDIAfwXKtLCqP8HS", "0q9pSZHR24ysquO6V4Xg", "bKr81BFLZSuiMa7MvhaA", "FxzVVvnPjgPOD6JeamKd", "YV4NMGVRlMHSAtJJfvqH", "8ih9F6QLntcLDCZhXDeq"]
ANIMESH = "mGXTEDg9o9WNR9gpZ4sY"

def main():
    W = vm.load_windows(); rep = json.load(open(f"{OUT}/mint_report.json"))["doctors"]
    M = np.load(f"{OUT}/mints.npz"); M2 = np.load(f"{OUT}/mints_tier2.npz"); mint = {**{u: M[u] for u in M.files}, **{u: M2[u] for u in M2.files}}
    assert all(u in mint for u in CONFIRMED)
    names = {}
    for l in open(f"{E}/consult/encounter-windows-2to6oct-1530.jsonl"): r = json.loads(l); names[r["consulting_doctor_uid"]] = r["consulting_doctor_name"]
    PP = [dict(name=x["name"], v=vm.nrm(vm.b64(x["centroid_b64_float32_le"].replace("\\n", "")))) for x in json.load(open(f"{E}/consult/prod-prints.json"))]
    prints, own_ws = {}, {}
    for u in CONFIRMED:
        d = rep[u]; room = next(r for r, l in vm.LAB.items() if l == d["room"])
        ws = [w for w in W.values() if w["uid"] == u and w["quality"] == "clean" and w["room"] == room]; own_ws[u] = ws
        m = mint[u]; match = [c for w in ws for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], m)) >= COS]
        sec = sum(c["sec"] for c in match)
        prints[u] = dict(doctor_uid=u, display_name=names[u], room=d["room"], centroid_192_l2=[round(float(x), 7) for x in m], model="speechbrain/spkrec-ecapa-voxceleb (192-d, L2-normalised)",
                         n_windows=len(ws), n_days=len({w["day"] for w in ws}), total_speech_seconds=round(sec, 1), n_mint_matching_clusters=len(match), f0_median_hz=d["gates"]["P2_f0_median_hz"],
                         status="provisional", evidence=EVID)
    out = f"{E}/consult/prints-provisional-06oct.json"; fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(note="PROVISIONAL, not written to Neon voice_print or any production table", prints=list(prints.values())), fh, indent=1)
    # ---------------------------------------------------- (2) leave-one-window-out
    res = {}
    for u in CONFIRMED:
        rows = []
        for w in own_ws[u]:
            cl = [c for c in w["clusters"] if c["emb"] is not None]
            if not cl: continue
            rest = [c["raw"] for x in own_ws[u] if x is not w for c in x["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], mint[u])) >= COS]
            own = vm.nrm(np.stack(rest).mean(axis=0)); others = {v: mint[v] for v in CONFIRMED if v != u}
            def score(c): 
                co = float(np.dot(c["emb"], own)); oth = max(float(np.dot(c["emb"], p)) for p in others.values()); return co, oth
            big = max(cl, key=lambda c: c["sec"]); a_own, a_oth = score(big)
            best = max(cl, key=lambda c: float(np.dot(c["emb"], own))); b_own, b_oth = score(best)
            rows.append(dict(a_margin=a_own - a_oth, b_margin=b_own - b_oth, a_own=a_own, b_own=b_own))
        am = [r["a_margin"] for r in rows]; bm = [r["b_margin"] for r in rows]
        res[u] = dict(name=names[u], n=len(rows), largest_cluster=dict(top1=sum(m > 0 for m in am), min_margin=round(min(am), 3), median_margin=round(float(np.median(am)), 3), median_own_cos=round(float(np.median([r["a_own"] for r in rows])), 3)),
                      best_matching_cluster=dict(top1=sum(m > 0 for m in bm), min_margin=round(min(bm), 3), median_margin=round(float(np.median(bm)), 3), median_own_cos=round(float(np.median([r["b_own"] for r in rows])), 3)))
    # ---------------------------------------------------- (3) Nayar vs production prints and Animesh windows
    nay = mint["8ih9F6QLntcLDCZhXDeq"]; vj = json.load(open(f"{E}/vj/centroids/animesh-banerjee-opd3.json")); vjv = vm.nrm(vm.b64(vj["centroid_base64"]))
    prod_animesh = next(p["v"] for p in PP if "Animesh" in p["name"])
    an = {}
    an["nayar_print_cos_to_production_prints"] = {p["name"]: round(float(np.dot(nay, p["v"])), 3) for p in PP}
    an["box_vj_animesh_print_vs"] = dict(production_animesh=round(float(np.dot(vjv, prod_animesh)), 3), nayar_print=round(float(np.dot(vjv, nay)), 3), enrolled=str(vj.get("dated")))
    aw = [w for w in W.values() if w["uid"] == ANIMESH]
    rows = []
    for w in aw:
        cl = [c for c in w["clusters"] if c["emb"] is not None]
        rows.append(dict(day=w["day"], quality=w["quality"], n_clusters=len(cl), clusters=[dict(sec=round(c["sec"], 1), cos_nayar_print=round(float(np.dot(c["emb"], nay)), 3), cos_prod_animesh=round(float(np.dot(c["emb"], prod_animesh)), 3),
                                                                                     cos_vj_animesh=round(float(np.dot(c["emb"], vjv)), 3)) for c in sorted(cl, key=lambda c: -c["sec"])[:4]]))
    an["animesh_windows"] = rows
    nw = [w for w in own_ws["8ih9F6QLntcLDCZhXDeq"] if any(c["emb"] is not None for c in w["clusters"])]
    an["nayar_windows_vs_production_animesh"] = dict(n_windows=len(nw), max_cluster_cos_median=round(float(np.median([max(float(np.dot(c["emb"], prod_animesh)) for c in w["clusters"] if c["emb"] is not None) for w in nw])), 3),
                                                      windows_with_cluster_ge_055=sum(1 for w in nw if any(c["emb"] is not None and float(np.dot(c["emb"], prod_animesh)) >= COS for c in w["clusters"])))
    an["nayar_windows_vs_vj_animesh"] = dict(median_max_cos=round(float(np.median([max(float(np.dot(c["emb"], vjv)) for c in w["clusters"] if c["emb"] is not None) for w in nw])), 3))
    # ---------------------------------------------------- (4) what P4b measured in the 5 blocked doctors
    p4b = {}
    for u in CONFIRMED:
        if u == "F092iDIAfwXKtLCqP8HS": continue
        flagged = []
        m = mint[u]
        for w in own_ws[u]:
            mm = [c for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], m)) >= COS and c["sec"] >= vm.MIN15]
            if len(mm) < 2: continue
            mm.sort(key=lambda c: -c["sec"]); a, b = mm[0], mm[1]
            ta = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] == a["spk"]]; tb = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] == b["spk"]]
            ov = sum(max(0.0, min(x1, y1) - max(x0, y0)) for x0, x1 in ta for y0, y1 in tb)
            ia = [x for pair in ta for x in pair]; ib = [x for pair in tb for x in pair]
            flagged.append(dict(cos_between=float(np.dot(a["emb"], b["emb"])), overlap_s=ov, overlap_share_of_smaller=ov / max(1e-9, min(a["sec"], b["sec"])), sec_a=a["sec"], sec_b=b["sec"], cos_a_mint=float(np.dot(a["emb"], m)), cos_b_mint=float(np.dot(b["emb"], m)),
                                n_clusters_in_window=len([c for c in w["clusters"] if c["emb"] is not None])))
        n = len(own_ws[u]); p4b[u] = dict(name=names[u], windows=n, flagged_windows=len(flagged),
            median_cos_between_the_two_clusters=round(float(np.median([f["cos_between"] for f in flagged])), 3) if flagged else None,
            min_cos_between=round(min(f["cos_between"] for f in flagged), 3) if flagged else None,
            median_overlap_share=round(float(np.median([f["overlap_share_of_smaller"] for f in flagged])), 3) if flagged else None,
            median_second_cluster_cos_to_mint=round(float(np.median([f["cos_b_mint"] for f in flagged])), 3) if flagged else None,
            median_second_cluster_seconds=round(float(np.median([f["sec_b"] for f in flagged])), 1) if flagged else None)
    fo = f"{OUT}/followup.json"; fd = os.open(fo, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(dict(lowo=res, nayar_animesh=an, p4b=p4b), fh, indent=1)
    print(json.dumps(dict(lowo=res, p4b=p4b), indent=1)); print(json.dumps(an, indent=1))
    print("prints", out, vm.f16(out), "followup", fo)

if __name__ == "__main__": main()
