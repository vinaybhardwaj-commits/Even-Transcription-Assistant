"""2-6 Oct per-room-day table + validation extracts. Metadata only."""
import json, os, collections
from datetime import datetime
from .run import run, TAPES
from .classify import IST, iso

WIN = os.path.expanduser("~/eta-data/consult/encounter-windows-2to6oct.jsonl")
LOST = ("muted", "zero_all_day", "recorder_off")


def overlap(a, b, c, d):
    return max(0.0, min(b, d) - max(a, c))


def tables(feat_path, days):
    allint = run(feat_path)
    slug2room = {}
    for l in open(os.path.join(TAPES, "manifest.jsonl")):
        r = json.loads(l)
        slug2room[r["r2_key"].split("/")[1]] = r["room_id"]
    wins = [json.loads(l) for l in open(WIN)]
    rows = {}
    for room, ivs in allint.items():
        for d in days:
            rows[(room, d)] = {"min": collections.defaultdict(float), "usable": 0.0, "uncertain": 0.0, "lost": collections.defaultdict(float),
                               "consult_min": 0.0, "n": 0}
        for iv in ivs:
            if iv["ist_day"] in days:
                rows[(room, iv["ist_day"])]["min"][iv["state"]] += (iv["_b"] - iv["_a"]) / 60
    for w in wins:
        room = slug2room.get(w["room_slug"])
        if room is None or w["t_close"] is None:
            continue
        a, b = w["t_open"], w["t_close"]
        d = datetime.fromtimestamp(a, IST).strftime("%Y-%m-%d")
        if (room, d) not in rows:
            continue
        r = rows[(room, d)]
        r["n"] += 1
        r["consult_min"] += (b - a) / 60
        covered = 0.0
        for iv in allint[room]:
            o = overlap(a, b, iv["_a"], iv["_b"])
            if not o:
                continue
            covered += o
            if iv["state"] == "audio_present":
                r["usable"] += o / 60
            elif iv["state"] in ("audio_gated", "voice_isolation_gated"):
                r["uncertain"] += o / 60     # gate chatter inside: the mic may have been muted
            else:
                r["lost"][iv["state"]] += o / 60
        r["lost"]["recorder_off"] += (b - a - covered) / 60  # no chunk at all
    return allint, rows, wins, slug2room


SUMMARY_COLS = ("usable_min", "uncertain_min", "vi_gated_min", "muted_min", "zero_all_day_min", "off_min", "withheld_min")
STATE_COL = {"audio_present": "usable_min", "audio_gated": "uncertain_min", "voice_isolation_gated": "vi_gated_min", "muted": "muted_min",
             "zero_all_day": "zero_all_day_min", "recorder_off": "off_min", "withheld": "withheld_min"}


def write_day_summary(allint, rows, out):
    """One line per room-day: usable / uncertain / muted / zero_all_day / off / withheld minutes (sum 1440).
    Consult minutes (usable / uncertain / lost) are added for days covered by the encounter-window export."""
    with open(out, "w") as f:
        for room in sorted(allint):
            by = {}
            for iv in allint[room]:
                d = by.setdefault(iv["ist_day"], {c: 0.0 for c in SUMMARY_COLS})
                d[STATE_COL[iv["state"]]] += (iv["_b"] - iv["_a"]) / 60
            for day in sorted(by):
                rec = {"room_id": room, "ist_day": day, **{k: round(v, 2) for k, v in by[day].items()}}
                r = rows.get((room, day))
                if r is not None:
                    rec.update({"consult_windows": r["n"], "consult_min": round(r["consult_min"], 2),
                                "consult_usable_min": round(r["usable"], 2),
                                "consult_uncertain_min": round(r["uncertain"], 2),
                                "consult_lost_min": round(sum(r["lost"].values()), 2)})
                f.write(json.dumps(rec) + "\n")
    os.chmod(out, 0o600)
