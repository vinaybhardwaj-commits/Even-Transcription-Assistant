#!/usr/bin/env python3
"""vp-fast step 1 (ORDERS-roomsub vp-fast-01): diarize + ECAPA-embed every closed consult window with real tape coverage for the listed OPD doctors.
Pipeline = the existing box pipeline unchanged: manoj_diarize.local_diarize (pyannote/speaker-diarization-3.1, cuda via DIAR_DEVICE) + embedding_for_cluster
(speechbrain/spkrec-ecapa-voxceleb, 192-d) through extract_embeddings.process_one; clip = opus 32k m4a cut from the tape mirror, clip-relative time = t - t_open
(silence-padded where the tape has gaps). Blind room-days (union f07171dc, start day and end-minus-1 s day) are skipped.
Box-only output (dir 0700, files 0600): ~/eta-data/vp-fast/{audio,emb}/<consult_uid>.*. Run under the GPU lock, daytime only (stop new work by 22:30 IST):
  flock /home/eta/gpu.lock env DIAR_DEVICE=cuda ~/services/eta-diarize/venv/bin/python3 vp_fast_extract.py --export <jsonl>
Resumable (skips windows whose emb file exists). LIMIT=<n> env for a smoke run."""
import argparse, collections, datetime as dt, hashlib, importlib.util, json, os, subprocess, sys, tempfile, time
E = os.path.expanduser("~/eta-data"); OUT = os.environ.get("VP_OUT", f"{E}/vp-fast"); TAPES = f"{E}/tapes"   # VP_OUT: output dir (vp-auto test set uses ~/eta-data/vp-auto)
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
SLUG2ROOM = {"opd-1-xqj7": "room_yh3etjpf", "opd-4-ortho-778q": "room_ux92qpws", "opd-7-y74w": "room_qyzghzaf", "opd-5-dr-salanki-wxmp": "room_4ggnkg5x",
             "cardiology-opd-gh4a": "room_bh6jtq4t", "opd-6-webcam-only-am8n": "room_pnyc9u49", "opd-3-kjpf": "room_87frpus9"}
UIDS = ["YV4NMGVRlMHSAtJJfvqH", "F092iDIAfwXKtLCqP8HS", "FxzVVvnPjgPOD6JeamKd", "z04sk8cEsTuXxVWY4iHL", "8ih9F6QLntcLDCZhXDeq", "0q9pSZHR24ysquO6V4Xg", "bKr81BFLZSuiMa7MvhaA", "mGXTEDg9o9WNR9gpZ4sY"]
if os.environ.get("UIDS"): UIDS = [u for u in os.environ["UIDS"].split(",") if u]   # vp-auto test set: Manoj C, Manoj Kumar S, Shankar Kurpad, Shilpa Nadig, Animesh, Prashanth
MIN_DUR, MIN_COV = 60.0, 0.5
STOP_BY = dt.time(22, 30)

def f16(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()[:16]
def dstr(t): return dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")

def chunks_by_room():
    by = collections.defaultdict(list)
    for l in open(f"{TAPES}/manifest.jsonl"):
        if l.strip():
            x = json.loads(l); s = dt.datetime.fromisoformat(x["started_at"].replace("Z", "+00:00")).timestamp()
            by[x["room_id"]].append((s, s + x["duration_ms"] / 1000, f"{TAPES}/{x['path']}"))
    for v in by.values(): v.sort()
    return by

def plan(by, room, a, b):
    """-> ordered pieces: ('sil', dur) or ('seg', path, offset_s, dur); coverage fraction. Clip-relative time = t - a."""
    pieces, cov, cur = [], 0.0, a
    for s, e, p in by.get(room, []):
        lo, hi = max(a, s), min(b, e)
        if hi <= lo: continue
        if lo - cur > 0.05: pieces.append(("sil", lo - cur))
        pieces.append(("seg", p, lo - s, hi - lo)); cov += hi - lo; cur = hi
    if b - cur > 0.05: pieces.append(("sil", b - cur))
    return pieces, cov / (b - a)

def cut(pieces, out):
    tmp = tempfile.mkdtemp(prefix="vpf_", dir=OUT); paths = []
    try:
        for i, pc in enumerate(pieces):
            w = f"{tmp}/p{i:03d}.wav"
            if pc[0] == "sil": cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", f"{pc[1]:.3f}", w]
            else: cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{pc[2]:.3f}", "-t", f"{pc[3]:.3f}", "-i", pc[1], "-ac", "1", "-ar", "48000", w]
            subprocess.run(cmd, check=True, capture_output=True); paths.append(w)
        lst = f"{tmp}/c.txt"; open(lst, "w").write("".join(f"file '{p}'\n" for p in paths))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "mp4", out + ".tmp"], check=True, capture_output=True)
        os.replace(out + ".tmp", out)
    finally:
        for f in os.listdir(tmp): os.remove(f"{tmp}/{f}")
        os.rmdir(tmp)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--export", required=True); ap.add_argument("--list-only", action="store_true"); a = ap.parse_args()
    for d in (OUT, f"{OUT}/audio", f"{OUT}/emb"): os.makedirs(d, mode=0o700, exist_ok=True)
    sys.path.insert(0, f"{E}/drtpqma"); import heldout as ho; union, usha = ho.load_union()
    by = chunks_by_room(); W = [json.loads(l) for l in open(a.export) if l.strip()]
    sel, skipped = [], collections.Counter()
    for u in UIDS:
        for r in sorted((r for r in W if r["consulting_doctor_uid"] == u), key=lambda r: r["t_open"]):
            room = SLUG2ROOM[r["room_slug"]]
            if not r["t_close"]: skipped["unclosed"] += 1; continue
            if r["t_close"] - r["t_open"] < MIN_DUR: skipped["short"] += 1; continue
            if any(ho.is_held_out(union, d, room) for d in {dstr(r["t_open"]), dstr(r["t_close"] - 1)}): skipped["blind"] += 1; continue
            pieces, cov = plan(by, room, r["t_open"], r["t_close"])
            if cov < MIN_COV: skipped["no_tape"] += 1; continue
            sel.append((r, room, pieces, cov))
    # ADDENDUM 1: fewest windows first, Srinivas Reddy LAST and capped at his 25 most recent windows; Prashanth has no tape (0 windows) and is skipped
    SRINIVAS = "YV4NMGVRlMHSAtJJfvqH"; cnt = collections.Counter(x[0]["consulting_doctor_uid"] for x in sel)
    sri = sorted([x for x in sel if x[0]["consulting_doctor_uid"] == SRINIVAS], key=lambda x: x[0]["t_open"])[-25:]
    rest = [x for x in sel if x[0]["consulting_doctor_uid"] != SRINIVAS]
    rank = {u: i for i, u in enumerate(sorted({x[0]["consulting_doctor_uid"] for x in rest}, key=lambda u: (cnt[u], u)))}
    sel = sorted(rest, key=lambda x: (rank[x[0]["consulting_doctor_uid"]], x[0]["t_open"])) + sri
    left = collections.Counter(x[0]["consulting_doctor_uid"] for x in sel)
    print(f"export {os.path.basename(a.export)} sha16 {f16(a.export)} union {usha} manifest sha16 {f16(f'{TAPES}/manifest.jsonl')}: {len(sel)} windows, skipped {dict(skipped)}", flush=True)
    json.dump(dict(export16=f16(a.export), union16=usha, windows=[dict(consult_uid=r["consult_uid"], uid=r["consulting_doctor_uid"], room=room, quality=r["quality"], day=dstr(r["t_open"]), t_open=r["t_open"], t_close=r["t_close"], coverage=round(cov, 3)) for r, room, _, cov in sel], skipped=dict(skipped)),
              open(f"{OUT}/windows_selected.json", "w"), indent=1); os.chmod(f"{OUT}/windows_selected.json", 0o600)
    if a.list_only: return
    os.environ.setdefault("DIAR_DEVICE", "cuda"); os.environ.setdefault("OMP_NUM_THREADS", "2")
    sys.path.insert(0, f"{E}/manoj-package-work"); sys.path.insert(0, f"{E}/centroid-mint")
    import manoj_diarize as md, extract_embeddings as ee
    if os.environ.get("GUARD") == "1":      # retry mode: a segment the ECAPA front end cannot embed (tiny input) is skipped instead of failing the whole window
        _ew = md.embedding_for_window
        def _safe(*a, **k):
            try: return _ew(*a, **k)
            except RuntimeError: return None
        md.embedding_for_window = _safe
    REC = {}; orig = ee.local_diarize
    def rec(path): segs = orig(path); REC[path] = segs; return segs
    ee.local_diarize = rec
    lim = int(os.environ.get("LIMIT", "0")); n = done = fail = 0; t0 = time.time()
    for r, room, pieces, cov in sel:
        if lim and n >= lim: break
        if dt.datetime.now(IST).time() >= STOP_BY: print("STOP_BY 22:30 reached, no new work", flush=True); break
        cid = r["consult_uid"]; ep = f"{OUT}/emb/{cid}.json"; clip = f"{OUT}/audio/{cid}.m4a"; n += 1
        u_ = r["consulting_doctor_uid"]; left[u_] -= 0
        if os.path.exists(ep):
            done += 1; left[u_] -= 1
            if left[u_] == 0: print(f"DOCTOR_DONE {u_} {r['consulting_doctor_name']} (already extracted) {time.strftime('%H:%M')}", flush=True)
            continue
        try:
            cut(pieces, clip); REC.pop(clip, None)
            res = ee.process_one(clip, cid); sg = REC.pop(clip)
            res.update(consult_uid=cid, uid=r["consulting_doctor_uid"], room_id=room, quality=r["quality"], day=dstr(r["t_open"]), t_open=r["t_open"], t_close=r["t_close"], coverage=round(cov, 3),
                       engine_id=getattr(md, "_diarize_engine_id", None), embed_model="speechbrain/spkrec-ecapa-voxceleb", dim=192,
                       turns=[{"speaker_raw": x["speaker"], "start_s": x["start"], "end_s": x["end"]} for x in sg])
            fd = os.open(ep + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as fh: json.dump(res, fh)
            os.replace(ep + ".tmp", ep); done += 1
        except Exception as e:
            fail += 1; print(f"FAIL {cid}: {type(e).__name__}: {str(e)[:150]}", flush=True)
        left[u_] -= 1
        if left[u_] == 0: print(f"DOCTOR_DONE {u_} {r['consulting_doctor_name']} windows_with_embeddings={sum(1 for x in sel if x[0]['consulting_doctor_uid'] == u_ and os.path.exists(f'{OUT}/emb/' + x[0]['consult_uid'] + '.json'))} of {sum(1 for x in sel if x[0]['consulting_doctor_uid'] == u_)} {time.strftime('%H:%M')}", flush=True)
        if n % 10 == 0: print(f"{n}/{len(sel)} done={done} fail={fail} {time.time() - t0:.0f}s", flush=True)
    print(f"EXTRACT_DONE n={n} done={done} fail={fail} {time.time() - t0:.0f}s", flush=True)

if __name__ == "__main__": main()
