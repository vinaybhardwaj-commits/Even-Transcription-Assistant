"""arm_e.py — ENCOUNTER-FIRST arm e: arm d with speaker turnover from ECAPA embeddings every 1.5 s (lx, 24 Sep).

The diarizer's labels (arm d's turnover source) exist only inside 15-min windows and cover ~80 of 142 windows, and a
speaker's label restarts in every window. Here every active 1.5-s window of the room-day is embedded
(embed_local.py), and the embeddings are clustered across the WHOLE day, so a voice keeps one identity all day. The
doctor's voice is constant; a new patient's voice set appearing is a turnover. The clusters are fed to the SAME
segmenter.turnovers() rule, with everything else unchanged.

DECLARED before any score:
  COS_JOIN = 0.55   a window joins the nearest cluster centroid at cosine >= 0.55, otherwise it starts a new one
  MIN_CLUSTER = 20  clusters with fewer than 20 windows (30 s of voice) are noise and are not a speaker

Run: ~/.venv-r2/bin/python arm_e.py <data_dir> <out_dir>   (needs numpy). Room labels, counts and times only.
"""
import csv, json, os, subprocess, sys
from datetime import datetime, timezone, timedelta
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S

COS_JOIN, MIN_CLUSTER = 0.55, 20
DATA, OUT = sys.argv[1], sys.argv[2]; os.makedirs(OUT, exist_ok=True)
DATE = "2026-09-23"
E7 = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-e7-fullday/../2026-09-23-e7-pqm-truth")
SCORER = f"{E7}/e7_score.py"
IST = timezone(timedelta(hours=5, minutes=30))
ms = lambda s: int(datetime.fromisoformat(s).timestamp() * 1000)
hm = lambda t: datetime.fromtimestamp(t / 1000, IST).strftime("%H:%M:%S")

rooms = json.load(open(f"{DATA}/rooms.json")); levels = json.load(open(f"{DATA}/levels.json"))
truth = list(csv.DictReader(open(f"{DATA}/truth-23sep-metabase.csv")))
room_of = {rd: json.load(open(f"{E7}/hyp-acoustic.json"))["room_days"][rd]["room"] for rd in rooms}


def cluster(E):
    """Leader clustering in time order on L2-normalised embeddings; returns labels (-1 = noise)."""
    X = E / np.maximum(np.linalg.norm(E, axis=1, keepdims=True), 1e-9)
    cents, counts, lab = [], [], np.empty(len(X), dtype=np.int64)
    for i, x in enumerate(X):
        if cents:
            sims = np.array(cents) @ x; j = int(np.argmax(sims))
            if sims[j] >= COS_JOIN:
                counts[j] += 1; c = cents[j] + (x - cents[j]) / counts[j]; cents[j] = c / np.linalg.norm(c); lab[i] = j; continue
        cents.append(x.copy()); counts.append(1); lab[i] = len(cents) - 1
    big = {j for j, n in enumerate(counts) if n >= MIN_CLUSTER}
    return np.array([l if l in big else -1 for l in lab]), len(big), len(cents)


def emb_labels(rd):
    z = np.load(f"{DATA}/emb/emb-{rd}.npz"); t, E = z["t_ms"], z["emb"]
    lab, nbig, nall = cluster(E)
    d0, d1 = S.day_bounds(DATE)
    segs = [{"start_ms": int(tt - d0), "end_ms": int(tt - d0 + 1500), "speaker_idx": int(l)} for tt, l in zip(t, lab) if l >= 0]
    print(f"CLUSTERS {room_of[rd]}: windows {len(t)} clusters {nall} speakers(>= {MIN_CLUSTER} windows) {nbig} noise {int((lab < 0).sum())}")
    return [{"window_id": f"day-{rd}", "engine": "ecapa-day", "start_ms": d0, "end_ms": d1, "segments_json": segs}]


def queue(rd): return [(ms(r["called_at"]), ms(r["completed_at"])) for r in truth if r["room"] == room_of[rd]]


hyp = {"source": "arm-e", "room_days": {}}; P02 = None
for rd, rid in rooms.items():
    lv = [(int(x["t"]), float(x["peak"])) for x in levels if x["room_id"] == rid]
    lb = emb_labels(rd)
    turns, _ = S.turnovers(lb)
    clips = S.arm_d(lv, lb, DATE, queue(rd))
    hyp["room_days"][rd] = {"room": room_of[rd], "date": DATE, "energy_gap": False,
                            "encounters": [{"id": f"e-{i}", "start_ms": s, "end_ms": e} for i, (s, e) in enumerate(clips)]}
    print(f"ARM_E {room_of[rd]}: turnover points {len(turns)}, clips {len(clips)}")
    if rd == "rd_pw5gaugg": P02 = (clips, turns)
json.dump(hyp, open(f"{OUT}/hyp-arm-e.json", "w"))
r = subprocess.run([sys.executable, SCORER, "--truth", f"{DATA}/truth-23sep-metabase.csv", "--hyp", f"{OUT}/hyp-arm-e.json",
                    "--out", f"{OUT}/score-arm-e.md"], capture_output=True, text=True)
print(r.stdout.strip().splitlines()[-1] if r.returncode == 0 else f"SCORE_FAIL {r.stderr[-200:]}")
t = open(f"{OUT}/score-arm-e.md").read()
for key in ("Splits", "Start error", "End error"):
    print("  ", next((l for l in t.splitlines() if l.startswith(f"- {key}")), "?"))
# P02 (OPD 3, 09:12:55-09:28:06): staff talk first, then the consult (V)
clips, turns = P02; c0, c1 = ms("2026-09-23T09:12:55+05:30"), ms("2026-09-23T09:28:06+05:30")
print("P02: arm-e clips", [(hm(s), hm(e)) for s, e in clips if e > c0 - 600000 and s < c1 + 600000],
      "| embedding turnovers inside", [hm(x) for x in turns if c0 <= x <= c1])
