#!/usr/bin/env python3
"""Speaker-count page windows (ruling 94 addendum): 30 excerpts of 60-90 s, stratified by the teacher (pyannote.ai) speaker count INSIDE the excerpt
(1,2,3,4,5,6+; 5 each), from labelled windows on room-days disjoint from the clean train/val split, V5 and every bench20 room-day.
Stages:  select   -> studies/2026-09-24-count-page/selection.json (ids, spans, counts only; Neon read-only)
         build    -> fetch each window via Scribe, cut MP3 32 kbps mono + 16k wav under ~/eta-data/speaker-count-30/ (audio never in git)
         finalize -> add nemotron_count (base Nemotron, offline 30.4 s, run on the excerpt) and write per-window JSON + index.json
Teacher count is HIDDEN from raters: the page must drop the fields listed in each JSON's hidden_fields."""
import datetime, json, os, random, subprocess, sys
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
DS = os.path.expanduser("~/dev/eta-lab/datasets"); STUDY = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-count-page")
OUT = os.path.expanduser("~/eta-data/speaker-count-30"); MIN_SPK_S = 0.5

def stage_select():
    from lib_diar_train import neon_select
    clean = json.load(open(f"{DS}/diar-train-clean-2026-09-24-13537f4e.json"))
    tr = json.load(open(f"{DS}/permanent-test-room-days.json"))
    banned_rds = set(clean["train_room_days"]) | set(clean["val_room_days"]) | set(tr["room_day_ids"])
    banned_w = set(tr["test_window_room_days"]) | {w["window_id"] for w in clean["excluded_windows_on_test_room_days"]}
    rows = neon_select("SELECT l.id AS label_id, l.window_id, l.room_day_id, l.created_at, d.room_id, d.ist_date FROM diarize_window_label l "
                       "JOIN room_day d ON d.id = l.room_day_id JOIN room_diarize_window w ON w.window_id = l.window_id "
                       "WHERE l.engine = 'pyannoteai' AND w.clip_r2_key IS NOT NULL ORDER BY l.created_at")
    latest = {r["window_id"]: r for r in rows}
    pool = [r for r in latest.values() if r["room_day_id"] not in banned_rds and r["window_id"] not in banned_w]
    print("eligible windows:", len(pool), "room-days:", len({r["room_day_id"] for r in pool}), file=sys.stderr)
    cands = defaultdict(list)                         # stratum -> [(window, start_s, len_s, count_1s, count_raw, speech_s)]
    for i in range(0, len(pool), 15):
        chunk = pool[i:i + 15]; ids = ",".join("'%s'" % r["label_id"] for r in chunk)
        segs = {r["id"]: r["segments_json"] for r in neon_select(f"SELECT id, segments_json FROM diarize_window_label WHERE id IN ({ids})")}
        for r in chunk:
            s = segs[r["label_id"]]; s = json.loads(s) if isinstance(s, str) else s
            dur = max((x["end_ms"] for x in s), default=0) / 1000
            for L in (90, 75, 60):
                for st in range(0, int(dur - L) + 1, 5):
                    per = defaultdict(float); raw = set()
                    for x in s:
                        o = min(x["end_ms"] / 1000, st + L) - max(x["start_ms"] / 1000, st)
                        if o > 0: per[x["speaker_idx"]] += o; raw.add(x["speaker_idx"])
                    n = sum(1 for v in per.values() if v >= MIN_SPK_S); sp = sum(per.values())
                    if n and sp >= (15 if n == 1 else 30):
                        cands[min(n, 6)].append((r, st, L, n, len(raw), round(sp, 1)))
    rng = random.Random(42); picked = []
    for k in range(1, 7):
        by = defaultdict(list)
        for c in cands[k]: by[c[0]["room_day_id"]].append(c)
        rds = sorted(by); rng.shuffle(rds); got, used_w = [], set()
        while len(got) < 5 and any(by[rd] for rd in rds):
            for rd in rds:
                if len(got) >= 5: break
                opts = [c for c in by[rd] if c[0]["window_id"] not in used_w]
                if not opts: by[rd] = []; continue
                best = max(L for _, _, L, _, _, _ in opts); opts = [c for c in opts if c[2] == best]     # prefer the longest excerpt
                c = rng.choice(opts); got.append(c); used_w.add(c[0]["window_id"]); by[rd] = [x for x in by[rd] if x[0]["window_id"] != c[0]["window_id"]]
        if len(got) < 5:        # shortfall: second/third NON-OVERLAPPING excerpt from an already-used window (different audio span)
            extra = [c for c in cands[k] if c[2] >= 60]; rng.shuffle(extra)
            for c in extra:
                if len(got) >= 5: break
                clash = any(g[0]["window_id"] == c[0]["window_id"] and not (c[1] + c[2] <= g[1] or g[1] + g[2] <= c[1]) for g in got + [p for p in picked])
                if any(g[0]["window_id"] == c[0]["window_id"] for g in got) and not clash: got.append(c)
        picked += got; print(f"stratum {k}: {len(got)} picked from {len(cands[k])} candidate spans", file=sys.stderr)
    deficit = 30 - len(picked)                       # strata that cannot fill (6+) are topped up from the next-lower stratum
    for k in (5, 4):
        pool_k = [c for c in cands[k] if c[0]["window_id"] not in {p[0]["window_id"] for p in picked}]; rng.shuffle(pool_k)
        while deficit > 0 and pool_k:
            c = pool_k.pop(); picked.append(c); deficit -= 1; pool_k = [x for x in pool_k if x[0]["window_id"] != c[0]["window_id"]]
    def ist_date(v):
        return (datetime.datetime.strptime(str(v)[:19], "%Y-%m-%dT%H:%M:%S") + datetime.timedelta(hours=5, minutes=30)).date().isoformat() if "T" in str(v) else str(v)
    sel = {"rule": "excerpt teacher count = pyannote.ai speakers with >= %.0f s inside the excerpt; strata 1..5, 6+ (5 each); labelled windows on room-days not in clean train/val, V5 or bench20 (all 15 test room-days); one excerpt per window (a strata shortfall may use a second NON-OVERLAPPING span of a used window); longest of 90/75/60 s; seed 42" % MIN_SPK_S,
           "eligible_windows": len(pool), "windows": [{"window_id": r["window_id"], "room_day_id": r["room_day_id"], "room_id": r["room_id"], "date_ist": ist_date(r["ist_date"]),
                                                       "start_s": st, "duration_s": L, "teacher_count": n, "teacher_count_raw_any_overlap": raw, "speech_s": sp, "stratum": min(n, 6)}
                                                      for r, st, L, n, raw, sp in picked]}
    os.makedirs(STUDY, exist_ok=True); json.dump(sel, open(f"{STUDY}/selection.json", "w"), indent=1)
    print("selected", len(picked), "room-days", len({p[0]['room_day_id'] for p in picked}))

def stage_build():
    from lib_diar_train import fetch_clip_via_scribe
    sel = json.load(open(f"{STUDY}/selection.json")); os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700); tmp = os.path.join(OUT, ".tmp"); os.makedirs(tmp, exist_ok=True)
    for i, w in enumerate(sel["windows"], 1):
        cid = f"sc30-{i:02d}"; w["id"] = cid; full = os.path.join(tmp, w["window_id"] + ".wav")
        if not os.path.exists(f"{OUT}/{cid}.mp3"):
            fetch_clip_via_scribe(w["window_id"], full)
            common = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-ss", str(w["start_s"]), "-t", str(w["duration_s"]), "-i", full, "-ac", "1"]
            subprocess.run(common + ["-c:a", "libmp3lame", "-b:a", "32k", "-ar", "22050", f"{OUT}/{cid}.mp3"], check=True)
            subprocess.run(common + ["-ar", "16000", "-c:a", "pcm_s16le", f"{OUT}/.{cid}.16k.wav"], check=True)
            os.unlink(full)
        print(cid, "ok", file=sys.stderr, flush=True)
    json.dump(sel, open(f"{STUDY}/selection.json", "w"), indent=1)

def stage_finalize(nem_json):
    sel = json.load(open(f"{STUDY}/selection.json")); nem = json.load(open(nem_json))["windows"]; idx = []
    for w in sel["windows"]:
        cid = w["id"]; mp3 = f"{OUT}/{cid}.mp3"
        dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp3], capture_output=True, text=True).stdout)
        rec = {"id": cid, "room": w["room_id"], "date": w["date_ist"], "duration_s": round(dur, 1), "audio": f"{cid}.mp3",
               "teacher_count": w["teacher_count"], "nemotron_count": nem[cid]["n_speakers"],
               "pyannote_count": w["teacher_count"], "hidden_fields": ["teacher_count", "nemotron_count", "pyannote_count"],
               "provenance": {"window_id": w["window_id"], "start_s": w["start_s"], "stratum": w["stratum"], "teacher_count_raw_any_overlap": w["teacher_count_raw_any_overlap"]}}
        json.dump(rec, open(f"{OUT}/{cid}.json", "w"), indent=1); idx.append(rec)
    json.dump({"n": len(idx), "windows": idx}, open(f"{OUT}/index.json", "w"), indent=1)
    print("wrote", len(idx), "windows to", OUT)

def stage_publish():
    """Rater-facing set: SHUFFLED order (the internal order is by stratum, which would leak the count), OPAQUE ids and file names, only
    {id, duration_s, audio}. The key (opaque id -> sc30 id, all hidden counts) stays outside public/ for scoring."""
    import hashlib, shutil
    idx = json.load(open(f"{OUT}/index.json"))["windows"]; pub_dir = f"{OUT}/public"; os.makedirs(pub_dir, exist_ok=True)
    order = sorted(idx, key=lambda w: hashlib.sha256(("sc30-shuffle-v1" + w["id"]).encode()).hexdigest())
    pub, key = [], {}
    for w in order:
        oid = "cw" + hashlib.sha256(("sc30-opaque-v1" + w["id"]).encode()).hexdigest()[:8]
        shutil.copyfile(f"{OUT}/{w['audio']}", f"{pub_dir}/{oid}.mp3")
        pub.append({"id": oid, "duration_s": w["duration_s"], "audio": f"{oid}.mp3"}); key[oid] = {k: w[k] for k in ("id", "teacher_count", "nemotron_count", "pyannote_count", "room", "date", "provenance")}
    json.dump({"n": len(pub), "windows": pub}, open(f"{pub_dir}/windows.json", "w"), indent=1)
    json.dump(key, open(f"{OUT}/key.json", "w"), indent=1)
    print("public set:", len(pub), "windows in", pub_dir, "| key:", f"{OUT}/key.json")

if __name__ == "__main__":
    {"select": stage_select, "build": stage_build, "finalize": lambda: stage_finalize(sys.argv[2]), "publish": stage_publish}[sys.argv[1]]()
