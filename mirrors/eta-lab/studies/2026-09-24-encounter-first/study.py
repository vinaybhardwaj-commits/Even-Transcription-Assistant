"""ENCOUNTER-FIRST study (orders/JOIN-SHARD-AND-ENCOUNTER-FIRST.md Part B; lx, 24 Sep).

Can a room's day tape be cut into consult-shaped clips BEFORE STT, from audio signals + the patient queue?
23 Sep, the 3 room-days with PQM truth. NO RAW AUDIO in this version (no R2 access on the box yet):
  energy  = bench_level_sample peaks (every ~2.3 s), per-room quiet floor
  speaker = turnover of the diarizer's speaker set inside 15-min windows (diarize_window_label; audio-only
            pyannote.ai / local segments; covers ~80 of 142 windows)
  queue   = PQM called_at / completed_at of the room's voice-confirmed doctor

Arms (parameters DECLARED here, before any score; a sensitivity grid is reported, never used to pick):
  a  acoustic only   energy runs -> split at speaker turnover / long quiet gaps
  b  queue only      PQM intervals, each edge snapped to the nearest energy edge within SNAP_S
  c1 fused           PQM anchors, edges moved to the energy edges near them; dropped if silent
  c2 fused + a       c1 plus acoustic segments that no queue interval explains
  d  a in queue span  arm a's segments, kept only inside [first call - SPAN_PAD, last completion + SPAN_PAD] of the
                      room's doctor: the queue gives the working span, never a per-consult time (much less circular)
CIRCULARITY: E-7 truth IS PQM. b/c1/c2 use PQM times, so their overlap scores are high by construction; only
arm a is an independent test. What b/c measure is whether PQM times, snapped to real audio edges, make good
cut points, and whether the queue matches the audio (see the diagnostics).

Usage: study.py <data_dir> <out_dir>      Numbers, ids, room labels and times only.
"""
import bisect, csv, json, os, subprocess, sys
from datetime import datetime

DATA, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SCORER = os.path.expanduser("~/dev/eta-lab/studies/2026-09-23-e7-pqm-truth/e7_score.py")
E7 = os.path.expanduser("~/dev/eta-lab/studies/2026-09-23-e7-pqm-truth")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import segmenter as S      # the ONE segmenter implementation (shared with the E-7 rescore's arm d)
from segmenter import BIN_S, K_ACTIVE, MERGE_GAP_S, SNAP_S

IST = 19800
DATE = "2026-09-23"
def ms(ts): return int(datetime.fromisoformat(ts).timestamp() * 1000)
def hm(t): return datetime.utcfromtimestamp(t / 1000 + IST).strftime("%H:%M")

rooms = json.load(open(f"{DATA}/rooms.json"))                       # room_day_id -> room_id
levels = json.load(open(f"{DATA}/levels.json"))
labels = json.load(open(f"{DATA}/labels-23sep.json"))
truth = list(csv.DictReader(open(f"{DATA}/truth-23sep-metabase.csv")))
ac_ref = json.load(open(f"{E7}/hyp-acoustic.json"))["room_days"]
room_of = {rd: ac_ref[rd]["room"] for rd in rooms}
rd_of_room = {v: k for k, v in room_of.items()}
LV = {rd: [(int(x["t"]), float(x["peak"])) for x in levels if x["room_id"] == rid] for rd, rid in rooms.items()}
LB = {rd: [r for r in labels if r["room_day_id"] == rd] for rd in rooms}

def energy_bins(rd, k=K_ACTIVE): return S.energy_bins(LV[rd], DATE, k)
def turnovers(rd): return S.turnovers(LB[rd])
def arm_a(rd, k=K_ACTIVE, merge_s=MERGE_GAP_S): return S.arm_a(LV[rd], LB[rd], DATE, k, merge_s)
def edges(rd): return S.edges(LV[rd], DATE)
nearest = S.nearest

def queue_rows(rd): return [(ms(r["called_at"]), ms(r["completed_at"])) for r in truth if rd_of_room.get(r["room"]) == rd]

def arm_b(rd):
    on, off, *_ = edges(rd); L = SNAP_S * 1000; out = []
    for a, b in queue_rows(rd):
        s = nearest(on, a, L) or a; e = nearest(off, b, L) or b
        out.append((s, e) if e > s else (a, b))
    return out

def arm_c1(rd):
    on, off, d0, active = edges(rd); L = SNAP_S * 1000; B = BIN_S * 1000; out = []
    for a, b in queue_rows(rd):
        s = min([x for x in on if a - L <= x <= a + L], default=a)          # first talk onset near the call
        e = max([x for x in off if b - L <= x <= b + L], default=b)         # last talk offset near completion
        if e <= s: s, e = a, b
        i0, i1 = (s - d0) // B, (e - d0) // B
        if i1 > i0 and sum(active[i0:i1]) / (i1 - i0) < 0.1: continue      # a queue entry the audio never saw
        out.append((s, e))
    return out

def arm_c2(rd):
    c1 = arm_c1(rd); extra = []
    for s, e in arm_a(rd):
        if not any(max(0, min(e, b) - max(s, a)) / min(e - s, b - a) >= 0.5 for a, b in c1): extra.append((s, e))
    return sorted(c1 + extra)

def arm_d(rd): return S.arm_d(LV[rd], LB[rd], DATE, queue_rows(rd))

# ---- scoring
TRUTH_CSV = f"{DATA}/truth-23sep-metabase.csv"
def write_hyp(name, fn):
    rds = {rd: {"room": room_of[rd], "date": "2026-09-23", "energy_gap": False,
                "encounters": [{"id": f"{name}-{i}", "start_ms": s, "end_ms": e} for i, (s, e) in enumerate(fn(rd))]}
           for rd in rooms}
    p = f"{OUT}/hyp-{name}.json"; json.dump({"source": name, "room_days": rds}, open(p, "w")); return p

def score(hyp_path, name):
    md = f"{OUT}/score-{name}.md"
    r = subprocess.run([sys.executable, SCORER, "--truth", TRUTH_CSV, "--hyp", hyp_path, "--out", md], capture_output=True, text=True)
    if r.returncode: print("SCORE_FAIL", name, r.stderr[-300:]); sys.exit(7)
    t = open(md).read(); import re
    g = lambda p: (re.search(p, t).group(1) if re.search(p, t) else "?")
    return {"hyp": g(r"- Hypotheses \([^)]+\): (\d+)"), "recall": g(r"- Recall .*?: (\d+/\d+)"), "precision": g(r"- Precision .*?: (\d+/\d+)"),
            "splits": g(r"- Splits .*?: (\d+)"), "merges": g(r"- Merges .*?: (\d+)"),
            "start": g(r"- Start error \(s\): median ([\d.]+|n/a)"), "end": g(r"- End error \(s\): median ([\d.]+|n/a)")}

def subset(path, name):
    d = json.load(open(path)); d["room_days"] = {k: v for k, v in d["room_days"].items() if k in rooms}
    p = f"{OUT}/hyp-{name}.json"; json.dump(d, open(p, "w")); return p

rows = []
rows.append(("E-shadow acoustic (stored)", score(subset(f"{E7}/hyp-acoustic.json", "e6-acoustic"), "e6-acoustic")))
rows.append(("E-6 fusion (stored)", score(subset(f"{E7}/hyp-fused.json", "e6-fused"), "e6-fused")))
for name, fn in (("a-acoustic", arm_a), ("d-acoustic-in-queue-span", arm_d), ("b-queue", arm_b), ("c1-fused", arm_c1), ("c2-fused+a", arm_c2)):
    rows.append((name, score(write_hyp(name, fn), name)))

m = lambda v: "n/a" if v in ("?", "n/a") else f"{float(v) / 60:.1f}"
print("| Arm | Hyp | Recall | Precision | Splits | Merges | Start err median (min) | End err median (min) |")
print("|---|---|---|---|---|---|---|---|")
for n, g in rows: print(f"| {n} | {g['hyp']} | {g['recall']} | {g['precision']} | {g['splits']} | {g['merges']} | {m(g['start'])} | {m(g['end'])} |")

print("\nSENSITIVITY, arm a (acoustic only): K x quiet floor, merge gap. Reported, not used to choose.")
for k in (1.3, 1.5, 2.0):
    for gsec in (30, 60, 120):
        g = score(write_hyp(f"a-k{k}-g{gsec}", lambda rd, k=k, gsec=gsec: arm_a(rd, k, gsec)), f"a-k{k}-g{gsec}")
        print(f"  K={k} gap={gsec}s: hyp {g['hyp']} recall {g['recall']} precision {g['precision']} splits {g['splits']} merges {g['merges']}")

print("\nDIAGNOSTICS (per room: queue vs audio; label coverage)")
for rd in rooms:
    d0, active, q20 = energy_bins(rd); B = BIN_S * 1000
    q = queue_rows(rd)
    fr = [sum(active[(a - d0) // B:(b - d0) // B]) / max(1, (b - a) // B) for a, b in q]
    inq = set()
    for a, b in q: inq.update(range((a - d0) // B, (b - d0) // B))
    lo, hi = min(a for a, _ in q), max(b for _, b in q)
    span = range((lo - d0) // B, (hi - d0) // B)
    out_act = sum(1 for i in span if active[i] and i not in inq) * BIN_S / 60
    _, cover = turnovers(rd)
    cov = sum(1 for a, b in q if any(s <= a and b <= e + 900000 for s, e in cover))
    print(f"  {room_of[rd]}: floor q20={q20:.4f}; {len(q)} queue consults, active share inside each: "
          f"min {min(fr):.2f} median {sorted(fr)[len(fr)//2]:.2f}; active talk OUTSIDE any queue consult between the first "
          f"call and the last completion: {out_act:.0f} min; turnover points {len(turnovers(rd)[0])}; "
          f"consults starting inside a labelled window: {cov}/{len(q)}")
