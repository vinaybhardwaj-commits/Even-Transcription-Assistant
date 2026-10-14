#!/usr/bin/env python3
"""vp-mint-manoj-01: mint Dr Manoj C (eQvR4aMZIRv9l2UHpL8b) the vp-auto way (vp_auto.seed_and_print: the top meta-cluster of the doctor's own clusters = seed, print = normalised mean of the clusters
matching the seed at cos >= 0.55), with the k4 mint window l5uv4acr (3 Oct, 200.72-212.23 s) EXCLUDED ENTIRELY (every cluster of that window) pending V's clarification of his 'Dr. Bhojani' comment on set-c k4.
Writes the print into ~/eta-data/consult/prints-provisional-06oct.json (the file the cutter reads; previous file kept as a dated backup, atomic replace, 0600). CPU only.
Run: ~/eta-data/nemotron/venv-nemo-main/bin/python3 vp_mint_manoj.py [--write]"""
import argparse, collections, json, os, shutil, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vp_auto as va, vp_fast_mint as vm
E = vm.E; UID = "eQvR4aMZIRv9l2UHpL8b"; EXCLUDE = "l5uv4acregaq7116p3j6rcaci4"; PF = f"{E}/consult/prints-provisional-06oct.json"
EVID_02 = "V-ear-2026-10-07T11:16 IST set-c (manifest sha16 efe64eb938ed094f; mints 5/5 yes, decoys 2/2 no); k4 comment confirmed carry-over by V 11:48 IST"      # vp-mint-manoj-02: k4 window INCLUDED
EVID = "V-ear-2026-10-07T11:16 IST set-c (voicecheck-07oct-c manifest sha16 efe64eb938ed094f; mints 5/5 yes, decoys 2/2 no); k4 window l5uv4acregaq7116p3j6rcaci4 (3 Oct 200.72-212.23) excluded pending V's clarification of his comment 'Dr. Bhojani'"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--write", action="store_true"); ap.add_argument("--include-k4", action="store_true", help="vp-mint-manoj-02: re-mint with the k4 window INCLUDED and REPLACE the existing Manoj C entry"); a = ap.parse_args()
    vm.audio16 = va.audio_from_dirs()
    W = va.load_windows(f"{E}/vp-auto"); allw = [w for w in W.values() if w["uid"] == UID]
    assert any(w["cid"] == EXCLUDE for w in allw), "k4 window not found"
    ws = allw if a.include_k4 else [w for w in allw if w["cid"] != EXCLUDE]
    pr = va.seed_and_print(ws)
    mw = [(w, va.matching(w, pr)) for w in ws]; wm = [(w, m) for w, m in mw if m]
    f0, vs = vm.median_f0([(w, {c["spk"] for c in m}) for w, m in wm])
    prov = json.load(open(PF)); ankit = next(p for p in prov["prints"] if p["doctor_uid"] == "F092iDIAfwXKtLCqP8HS"); av = vm.nrm(np.array(ankit["centroid_192_l2"], dtype=np.float32))
    prod = {x["name"]: vm.nrm(vm.b64(x["centroid_b64_float32_le"].replace("\\n", ""))) for x in json.load(open(f"{E}/consult/prod-prints.json"))}
    old = vm.nrm(np.array(json.load(open(f"{E}/vp-auto/routes_test.json"))["doctors"][UID]["print"], dtype=np.float32))
    others = {p["display_name"]: float(np.dot(pr, vm.nrm(np.array(p["centroid_192_l2"], dtype=np.float32)))) for p in prov["prints"] if p["doctor_uid"] != UID}
    cur = next((p for p in prov["prints"] if p["doctor_uid"] == UID), None); cur_v = None if cur is None else vm.nrm(np.array(cur["centroid_192_l2"], dtype=np.float32))
    facts = dict(cos_to_current_file_entry=None if cur_v is None else round(float(np.dot(pr, cur_v)), 4), windows_all=len(allw), windows_used=len(ws), n_windows=len(wm), n_days=len({w["day"] for w, _ in wm}), speech_s=round(sum(c["sec"] for _, m in wm for c in m), 1), n_matching_clusters=sum(len(m) for _, m in wm),
                 f0_median_hz=None if f0 is None else round(f0, 1), f0_voiced_s=round(vs, 1), cos_to_bhojani_provisional=round(float(np.dot(pr, av)), 3), cos_to_bhojani_production=round(float(np.dot(pr, prod["Ankit Bhojani"])), 3),
                 cos_to_previous_manoj_c_print_k4_included=round(float(np.dot(pr, old)), 3), cos_to_other_provisional={k: round(v, 3) for k, v in others.items()}, max_cos_other=round(max(others.values()), 3),
                 cos_to_production={k: round(float(np.dot(pr, v)), 3) for k, v in prod.items()})
    print(json.dumps(facts, indent=1))
    if not a.write: return
    stamp = time.strftime("%Y%m%d-%H%M%S"); bak = f"{PF}.bak-{stamp}"; shutil.copy2(PF, bak); os.chmod(bak, 0o600)
    entry = dict(doctor_uid=UID, display_name="Dr Manoj C", room="OPD5", centroid_192_l2=[round(float(x), 7) for x in pr], model="speechbrain/spkrec-ecapa-voxceleb (192-d, L2-normalised)",
                 n_windows=facts["n_windows"], n_days=facts["n_days"], total_speech_seconds=facts["speech_s"], n_mint_matching_clusters=facts["n_matching_clusters"], f0_median_hz=facts["f0_median_hz"],
                 status="confirmed_ear", evidence=EVID, minted_at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), minted_by="vp_mint_manoj.py (vp-auto procedure)")
    if a.include_k4:
        entry["evidence"] = EVID_02; entry["minted_by"] = "vp_mint_manoj.py --include-k4 (vp-auto procedure; replaces the 11:21 entry)"; prov["prints"] = [p for p in prov["prints"] if p["doctor_uid"] != UID]
    else: assert UID not in {p["doctor_uid"] for p in prov["prints"]}, "already present"
    what = "re-minted with the k4 window included" if a.include_k4 else "added"
    prov["prints"].append(entry); prov["note"] = (prov.get("note") or "") + f" | {time.strftime('%Y-%m-%d %H:%M')} Manoj C {what} (confirmed_ear); previous file kept as {os.path.basename(bak)}"
    tmp = PF + ".tmp"; fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh: json.dump(prov, fh, indent=1)
    os.replace(tmp, PF); os.chmod(PF, 0o600); print("written", PF, "backup", bak, "n prints", len(prov["prints"]))

if __name__ == "__main__": main()
