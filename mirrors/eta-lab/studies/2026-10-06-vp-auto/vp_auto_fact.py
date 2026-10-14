#!/usr/bin/env python3
"""vp-auto-03 step 1: facts about the voicecheck-07oct decoy k=3 (non-mint own-windows group of Manoj C). CPU. Run with the eta-diarize venv:
  ~/services/eta-diarize/venv/bin/python3 vp_auto_fact.py   -> prints facts, writes ~/eta-data/vp-auto/fact_decoy_k3.json (0600)."""
import collections, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vp_auto_listen as vl, vp_auto as va, vp_fast_mint as vm
import manoj_diarize as md
E = vm.E; U = "eQvR4aMZIRv9l2UHpL8b"

def main():
    key = json.load(open(f"{E}/consult/voicecheck-07oct/KEY-DO-NOT-SHIP.json"))["key"]["manoj-c"]
    k3 = key["3"]; assert k3["kind"] == "decoy" and k3["decoy_source"].startswith("non_mint_group"), k3
    R = json.load(open(f"{E}/vp-auto/routes_test.json"))["doctors"]; W = va.load_windows(f"{E}/vp-auto")
    pr = vm.nrm(np.array(R[U]["print"], dtype=np.float32)); mk = vm.nrm(np.array(R["Tbvyk1V5ijpcD194ZOWi"]["print"], dtype=np.float32))
    ws = [w for w in W.values() if w["uid"] == U]
    rest = [dict(clip_id=w["cid"], date=w["day"], room=w["room"], speaker_raw=c["spk"], total_speech_sec=c["sec"], n_segments_scored=1, embedding=c["raw"]) for w in ws for c in w["clusters"]
            if c["emb"] is not None and c["sec"] >= 8.0 and float(np.dot(c["emb"], pr)) < va.COS]
    grp = None
    for gr in vm.groups_at(rest):
        wins = {m["clip_id"] for m in gr["members"]}
        if gr["n_sessions"] == 2 and k3["window"] in wins and float(np.dot(gr["centroid"], pr)) < 0.45: grp = gr
    assert grp is not None
    wins = sorted({m["clip_id"] for m in grp["members"]})
    # cos of the group centroid to every print
    prints = {"manoj_c_print": pr}; prints.update({f"run:{R[u]['name']}": np.array(R[u]["print"], dtype=np.float32) for u in R if u != U and R[u].get("print")})
    prov = json.load(open(f"{E}/consult/prints-provisional-06oct.json"))["prints"]; prints.update({f"provisional:{p['display_name']}": np.array(p["centroid_192_l2"], dtype=np.float32) for p in prov})
    prodp = json.load(open(f"{E}/consult/prod-prints.json")); prints.update({f"production:{x['name']}": vm.b64(x["centroid_b64_float32_le"].replace("\\n", "")) for x in prodp})
    cg = {k: round(float(np.dot(grp["centroid"], vm.nrm(v))), 3) for k, v in prints.items()}
    # the decoy CLIP itself
    w3 = W[k3["window"]]; wav, sr = md.load_audio(f"{w3['dir']}/audio/{w3['cid']}.m4a"); ce = vm.nrm(md.embedding_for_window(wav, sr, k3["start"], k3["end"]))
    cc = {k: round(float(np.dot(ce, vm.nrm(v))), 3) for k, v in prints.items()}
    # F0 of the group and of the mint
    byw = collections.defaultdict(set)
    for m in grp["members"]: byw[m["clip_id"]].add(m["speaker_raw"])
    f0g, vsg = vl.median_f0_sub([(W[c], s) for c, s in byw.items()])
    mint_items = [(w, {c["spk"] for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], pr)) >= va.COS}) for w in ws]
    f0m, vsm = vl.median_f0_sub([(w, s) for w, s in mint_items if s])
    # temporal relation in each window of the group
    rel = []
    for cid in wins:
        w = W[cid]; gs = byw[cid]; ms = {c["spk"] for c in w["clusters"] if c["emb"] is not None and float(np.dot(c["emb"], pr)) >= va.COS}
        tg = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] in gs]; tm = [(t["start_s"], t["end_s"]) for t in w["turns"] if t["speaker_raw"] in ms]
        ov = sum(max(0.0, min(a1, b1) - max(a0, b0)) for a0, a1 in tg for b0, b1 in tm)
        ev = sorted([(a, "G") for a, _ in tg] + [(a, "M") for a, _ in tm]); sw = sum(1 for i in range(1, len(ev)) if ev[i][1] != ev[i - 1][1])
        cl_g = [c for c in w["clusters"] if c["spk"] in gs]; cl_m = [c for c in w["clusters"] if c["spk"] in ms]
        rel.append(dict(window=cid[:8], day=w["day"], group_speech_s=round(sum(c["sec"] for c in cl_g), 1), mint_speech_s=round(sum(c["sec"] for c in cl_m), 1), group_clusters=len(cl_g), mint_clusters=len(cl_m),
                        overlap_s=round(ov, 1), overlap_share_of_group=round(ov / max(1e-9, sum(b - a for a, b in tg)), 3), alternations=sw, window_span_s=round(max([b for _, b in tg + tm] or [0]) - min([a for a, _ in tg + tm] or [0]), 0)))
    out = dict(decoy_window=k3["window"][:8], clip=[k3["start"], k3["end"]], group_windows=[c[:8] for c in wins], group_n_clusters=len(grp["members"]),
               group_centroid_cos_to_prints=cg, decoy_clip_embedding_cos_to_prints=cc, f0_group_hz=None if f0g is None else round(f0g, 1), f0_group_voiced_s=round(vsg, 1),
               f0_mint_hz=None if f0m is None else round(f0m, 1), f0_mint_voiced_s=round(vsm, 1), temporal=rel, purity_vs_group_centroid=k3["purity"])
    fd = os.open(f"{E}/vp-auto/fact_decoy_k3.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(out, fh, indent=1)
    print(json.dumps(out, indent=1))

if __name__ == "__main__": main()
