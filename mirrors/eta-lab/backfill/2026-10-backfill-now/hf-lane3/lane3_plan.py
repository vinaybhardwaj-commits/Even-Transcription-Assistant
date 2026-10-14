#!/usr/bin/env python3
"""lane3_plan.py — HF-3 audio plan (runs on the BOX, read-only on the hist store): builds the window list and the exact file list for lane 3 on HF-1.
  lane3_plan.py --day 2026-09-29 [--bench 5] [--out-dir plans/]
Writes plans/windows-<day>.json (win_id, room, ist_date, start, end, audio basename, audio_sha256 from the manifest, need=[lane keys still missing in REB]), plans/files-<day>.txt (relative paths under
~/eta-data/hist/windows-reb/<day>/ of the audio to copy) and, with --bench N, plans/bench-<day>.json (+ bench-files). Blind windows (heldout.py pin f672c1ef046089dd, union f07171dc, same predicate as hf-lane1)
and BLIND-IGNORE ids are NEVER listed, so their audio is never copied. A window whose lane tracks already exist in REB gets no `need` for them. Nothing is uploaded or copied here; prints counts only."""
import argparse, glob, importlib.util, json, os, subprocess, sys
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); JOB = f"{HERE}/lane3_cpu_job.py"
HELDOUT_PY = os.path.expanduser("~/eta-data/drtpqma/heldout.py"); HELDOUT_SHA16 = "f672c1ef046089dd"; UNION_SHA8 = "f07171dc"
WREB = os.path.expanduser("~/eta-data/hist/windows-reb"); REB = os.path.expanduser("~/eta-data/reb")
IST = timezone(timedelta(hours=5, minutes=30))
def job_module():
    spec = importlib.util.spec_from_file_location("lane3_cpu_job", JOB); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
JM = job_module()
def sha256_file(p): return JM.sha256_file(p)
def load_guard(heldout_py=HELDOUT_PY):
    got = sha256_file(heldout_py)[:16]
    if got != HELDOUT_SHA16: raise SystemExit(f"REFUSED: heldout.py sha16 {got} != {HELDOUT_SHA16}")
    sys.path.insert(0, os.path.dirname(heldout_py)); import heldout
    union, uid = heldout.load_union()
    if not str(uid).startswith(UNION_SHA8): raise SystemExit(f"REFUSED: blind union id {str(uid)[:8]} != {UNION_SHA8}")
    rid = {"OPD4": "room_ux92qpws", "OPD5": "room_4ggnkg5x", "OPD7": "room_qyzghzaf"}
    if {(d, rid[r]) for d, r in (x.split() for x in union)} != set(JM.BLIND): raise SystemExit("REFUSED: the job's embedded blind list differs from heldout.py's union")
    return heldout, union
def is_blind(w, heldout, union):
    """heldout's predicate over the same day set as the job (start / end-1s IST days, ist_date, id day); unparseable => blind. ALSO the job's own predicate: either one blind => blind."""
    try:
        if JM.is_blind({"win_id": w["win_id"], "room": w["room"], "ist_date": w["ist_date"], "start": w["start"], "end": w["end"]}): return True
        st = datetime.fromisoformat(w["start"].replace("Z", "+00:00")).astimezone(IST); en = datetime.fromisoformat(w["end"].replace("Z", "+00:00")).astimezone(IST) - timedelta(seconds=1)
        return any(heldout.is_held_out(union, d, w["room"]) for d in {st.date().isoformat(), en.date().isoformat(), w["ist_date"]})
    except Exception: return True
def reb_has(reb_root, w, key):
    h = JM.LANE_HASHES[key]; return os.path.exists(f"{reb_root}/{w['ist_date']}/{w['room']}/{w['win_id']}/tracks/stt.{JM.ENGINE_OF[key]}__{JM.VERSION}__{h}.json")
def plan(day, heldout, union, reb_root=REB, manifest_path=None, wreb=WREB):
    man = [json.loads(l) for l in open(manifest_path or f"{wreb}/manifest-{day}.jsonl")]
    ign = set()
    for f in glob.glob(f"{wreb}/BLIND-IGNORE-*.json"):
        j = json.load(open(f)); k = "ignore_list" if "ignore_list" in j else ("ids" if "ids" in j else None)
        if k: ign |= set(j[k])
    st = {"manifest": len(man), "blind_excluded": 0, "ignore_list_excluded": 0, "audio_missing_locally": 0, "all_lane3_tracks_present": 0, "planned": 0}; wins = []
    for w in man:
        if w["win_id"] in ign: st["ignore_list_excluded"] += 1; continue
        if is_blind(w, heldout, union): st["blind_excluded"] += 1; continue                 # BEFORE the audio path is looked at
        need = [k for k in JM.CONFIGS if not reb_has(reb_root, w, k)]
        if not need: st["all_lane3_tracks_present"] += 1; continue
        if not os.path.exists(w["audio"]): st["audio_missing_locally"] += 1; continue
        wins.append({"win_id": w["win_id"], "room": w["room"], "ist_date": w["ist_date"], "start": w["start"], "end": w["end"], "audio": os.path.basename(w["audio"]), "audio_sha256": w["sha256"], "need": need,
                     "_src": os.path.relpath(w["audio"], f"{wreb}/{day}"), "_cov": (w.get("cut") or {}).get("covered_fraction", 0)})
    st["planned"] = len(wins); return wins, st
def rms(path):
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-t", "300", "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True)
    x = np.frombuffer(r.stdout, dtype="int16").astype("float32") / 32768.0; return float(np.sqrt((x ** 2).mean())) if len(x) else 0.0
def pick_bench(wins, n, wreb, day, rms_fn=rms):
    """n windows with real speech energy (first 300 s RMS), covered >= 0.9, distinct rooms first; deterministic."""
    cand = [w for w in wins if w["_cov"] >= 0.9]; scored = sorted(((rms_fn(f"{wreb}/{day}/{w['_src']}"), w["win_id"], w) for w in cand), key=lambda t: (-t[0], t[1]))
    out, rooms = [], set()
    for r, _, w in scored:
        if w["room"] not in rooms and r > 0.005: out.append(w); rooms.add(w["room"])
        if len(out) == n: return out
    for r, _, w in scored:
        if w not in out and r > 0.005: out.append(w)
        if len(out) == n: break
    return out
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter); ap.add_argument("--day", required=True); ap.add_argument("--bench", type=int, default=0); ap.add_argument("--out-dir", default=f"{HERE}/plans")
    a = ap.parse_args(); heldout, union = load_guard(); wins, st = plan(a.day, heldout, union); os.makedirs(a.out_dir, exist_ok=True)
    strip = lambda ws: [{k: v for k, v in w.items() if not k.startswith("_")} for w in ws]
    def wr(p, o):
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f: f.write(o if isinstance(o, str) else json.dumps(o, indent=1))
    wr(f"{a.out_dir}/windows-{a.day}.json", strip(wins)); wr(f"{a.out_dir}/files-{a.day}.txt", "\n".join(w["_src"] for w in wins) + "\n")
    rep = {"day": a.day, **st, "files": len(wins), "audio_gb": round(sum(os.path.getsize(f"{WREB}/{a.day}/{w['_src']}") for w in wins) / 1e9, 2)}
    if a.bench:
        b = pick_bench(wins, a.bench, WREB, a.day); wr(f"{a.out_dir}/bench-{a.day}.json", strip(b)); wr(f"{a.out_dir}/bench-files-{a.day}.txt", "\n".join(w["_src"] for w in b) + "\n"); rep["bench"] = [(w["win_id"], w["room"]) for w in b]
    print(json.dumps(rep, indent=1))
if __name__ == "__main__": main()
