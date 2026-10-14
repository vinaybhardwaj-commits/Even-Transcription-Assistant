"""ENCOUNTER-FIRST arm d inside the E-7 rescore (Fable, 24 Sep 10:20): the out-of-sample check.

Energy cuts from the level log, kept inside the room's doctor's working span from the queue. It runs the SAME
code and the SAME declared parameters that scored 14/16 recall, 17/28 precision on 23 Sep:
studies/2026-09-24-encounter-first/segmenter.py.
Usage: arm_d.py <YYYY-MM-DD> <outdir> <truth.csv>. Reads outdir/{confirmed,levels,labels}.json (the rooms stage).
Writes outdir/hyp-arm-d.json in the e7_score format. Counts only on stdout.
"""
import csv, json, os, sys
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "2026-09-24-encounter-first"))
import segmenter as S


date, out, truth_path = sys.argv[1:4]
conf = [r for r in json.load(open(f"{out}/confirmed.json"))["room_days"] if r["confirmed"]]
levels, labels = json.load(open(f"{out}/levels.json")), json.load(open(f"{out}/labels.json"))
truth = list(csv.DictReader(open(truth_path)))
ms = lambda s: int(datetime.fromisoformat(s).timestamp() * 1000)
rds = {}
for r in conf:
    rd = r["room_day_id"]
    lv = [(x["t"], x["peak"]) for x in levels if x["room_day_id"] == rd]
    lb = [x for x in labels if x["room_day_id"] == rd]
    q = [(ms(t["called_at"]), ms(t["completed_at"])) for t in truth if t["room"] == r["room"] and t["date"] == date]
    segs = S.arm_d(lv, lb, date, q)
    rds[rd] = {"room": r["room"], "date": date, "energy_gap": not lv,
               "encounters": [{"id": f"armd-{i}", "start_ms": s, "end_ms": e} for i, (s, e) in enumerate(segs)]}
    print(f"ARMD {rd} level_samples={len(lv)} label_rows={len(lb)} queue={len(q)} clips={len(segs)}")
json.dump({"source": "arm-d",
           # transcript_version: named by e7-rescore.sh --transcript (W28.2); null when unset — an
           # score card must never infer a version a run did not declare
           "transcript_version": os.environ.get("E7_TRANSCRIPT_VERSION"),
           "segmenter": "studies/2026-09-24-encounter-first/segmenter.py", "room_days": rds},
          open(f"{out}/hyp-arm-d.json", "w"))
print(f"ARMD_DONE room_days={len(rds)} clips={sum(len(v['encounters']) for v in rds.values())}")
