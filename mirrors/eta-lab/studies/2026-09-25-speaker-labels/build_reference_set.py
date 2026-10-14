#!/usr/bin/env python3
"""337e (ruling 350): the REFERENCE set for scoring B = vault windows whose time is >= 90 % covered by production windows that carry a pyannote.ai label.
Builds ~/eta-data/speaker-labels/reference_set.json: per vault window {window_id, path, room_id, start, end, n_segments, prod:[{window_id, label_id, wall_start, wall_end}]} (ids and times only).
Read-only Neon via kit/neon-select.mjs; vault run files are read only for start/end/room/segment counts (no text is printed or stored)."""
import datetime as dt, glob, json, os, re, subprocess, sys
ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant"); SEL = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
HOME = os.path.expanduser("~/eta-data"); OUT = f"{HOME}/speaker-labels/reference_set.json"
def q(sql): return json.loads(subprocess.run(["node", SEL, sql], cwd=ETA, capture_output=True, text=True, check=True).stdout)
rx = re.compile(r"^clips/[^/]+/(\d{8}T\d{6})Z-(\d{8}T\d{6})Z-"); idx = re.compile(r"^bw_[a-z0-9]+_(\d{13})_")
utc = lambda s: dt.datetime.strptime(s, "%Y%m%dT%H%M%S").replace(tzinfo=dt.timezone.utc).timestamp()
rows = q("SELECT w.window_id, d.room_id, w.clip_r2_key, l.id AS label_id FROM room_diarize_window w JOIN room_day d ON d.id = w.room_day_id "
         "JOIN (SELECT DISTINCT ON (window_id) id, window_id FROM diarize_window_label WHERE engine='pyannoteai' ORDER BY window_id, created_at DESC) l ON l.window_id = w.window_id WHERE w.state='ok'")
prod = {}
for r in rows:
    m, i = rx.match(r["clip_r2_key"] or ""), idx.match(r["window_id"])
    if m: a, b = utc(m.group(1)), utc(m.group(2))
    elif i: a = int(i.group(1)) / 1000; b = a + 900
    else: continue
    prod.setdefault(r["room_id"], []).append(dict(window_id=r["window_id"], label_id=r["label_id"], wall_start=a, wall_end=b))
ref, seen = [], set()
for root in ("hist", "hist-mining"):
    for p in sorted(glob.glob(f"{HOME}/{root}/runs/*/*/*/*.json")):
        try: d = json.load(open(p))
        except Exception: continue
        wid = d.get("window_id")
        if not d.get("segments") or wid in seen: continue
        seen.add(wid)
        s, e = dt.datetime.fromisoformat(d["start"]).timestamp(), dt.datetime.fromisoformat(d["end"]).timestamp()
        ov = [(max(0, min(e, x["wall_end"]) - max(s, x["wall_start"])), x) for x in prod.get(d.get("room_id"), [])]
        cov = sum(o for o, _ in ov) / (e - s)
        if cov >= 0.90: ref.append(dict(window_id=wid, path=os.path.relpath(p, HOME), room_id=d["room_id"], start=d["start"], end=d["end"], dur_s=round(e - s, 1),
                                        n_segments=sum(1 for x in d["segments"] if not x.get("refused")), coverage=round(cov, 3), prod=[x for o, x in ov if o > 0]))
json.dump(dict(n=len(ref), windows=ref), open(OUT, "w"), indent=1); os.chmod(OUT, 0o600)
print("reference windows:", len(ref), "| production windows involved:", len({x["window_id"] for w in ref for x in w["prod"]}), "| rooms", len({w["room_id"] for w in ref}),
      "| segments", sum(w["n_segments"] for w in ref), "| audio-h %.1f" % (sum(w["dur_s"] for w in ref) / 3600), "| dates", min(w["start"][:10] for w in ref), max(w["start"][:10] for w in ref))
