"""W52-B: voice scan of OPD4+OPD7 for Dr Manoj Kumar S (doctor_uid Tbvyk1V5ijpcD194ZOWi), using the
enrolled centroid ~/eta-data/vj/centroids/manoj-kumar-s-tc-c270.json (speechbrain/spkrec-ecapa-
voxceleb, 192-d). Reuses ~/eta-data/voice-linkage/dtree84's existing per-turn ECAPA embeddings —
same model, checked before writing this — for every OPD4/OPD7 room-day dtree84 already covers; the
remaining gap room-days (room_day_inventory.py's gap.json) need a fresh hf-fleet embedding job
(embed_job_spec.py) before they can be scanned the same way.

Inputs (run room_day_inventory.py and pqm_pull.py first): covered.json, kumars-pqm.json (this dir).
Outputs (PHI-adjacent, box only, never git): ~/eta-data/manoj-package/voice/scan-<room>-<date>.json
+ walk-ins.csv, per the W52 facts file's output layout.

Usage: python3 voice_scan.py
"""
import base64
import csv
import json
import math
import os
import struct
from datetime import datetime

CENTROID_PATH = os.path.expanduser("~/eta-data/vj/centroids/manoj-kumar-s-tc-c270.json")
DT = os.path.expanduser("~/eta-data/voice-linkage/dtree84")
OUT = os.path.expanduser("~/eta-data/manoj-package")
CUTS = [0.55, 0.65, 0.70]  # descriptive cuts only (cut_counts/cut_seconds) -- NOT the attribution bar
MERGE_GAP_MS = 60_000      # walk-in block merge gap, reused from segmenter.py's own MERGE_GAP_S

# Fable's 12:20 ruling, adopting vj-refuter #5301 in full (this replaces the first cut's PAD_MS=
# 180_000 and ATTACH_FLOOR=0.65 entirely -- 0.65/0.70 are the centroid's CLIP-level holdout bars,
# not calibrated for single ~1-5s turns; vj-refuter's background-rate check found other voices
# almost never clear even 0.55 (<=0.08% of 83k turns; 0% at >=0.65), while HIS attributed turns
# commonly sit at 0.57-0.63 -- so 0.55 is the right per-turn "his voice" bar, and >=3 turns or
# >=15s of it is what actually separates signal from single-turn noise):
HIS_VOICE_COS = 0.55        # per-turn "his voice" bar (was wrongly ATTACH_FLOOR=0.65 in the first fix)
ATTRIBUTION_PAD_MS = 30_000  # the ONLY pad for attribution now; the wide +-180s pad is dropped
FOUND_MIN_TURNS = 3
FOUND_MIN_SEC = 15.0

# vj-refuter #5323: a span with 0 his-voice turns can mean EITHER "checked, absent" or "dtree84
# never embedded anything there" (this room-day's embeddings are a subset of its raw turns) -- my
# `segments` list only ever held cos>=0.55 turns, so both cases looked identical (empty). A span
# only counts as a trustworthy NOT-IN when it has >=60s of EMBEDDED audio regardless of cos (same
# X=60 bar W51's own coverage gate uses); below that it's NOT_SCANNED, not a confident absence.
NOT_SCANNED_MIN_SEC = 60.0

def load_centroid():
    d = json.load(open(CENTROID_PATH))
    raw = base64.b64decode(d["embedding_base64"])
    n = d["dim"]
    return list(struct.unpack(f"<{n}f", raw)), d

def cos(a, b):
    dot = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(x*x for x in b))
    return dot / (na * nb)

def load_pqm(path="kumars-pqm.json"):
    rows = json.load(open(path))
    out = {}
    for called, completed, token, bucket in rows:
        if not called or not completed:
            continue
        c = datetime.fromisoformat(called.replace("Z", "+00:00"))
        e = datetime.fromisoformat(completed.replace("Z", "+00:00"))
        out.setdefault(bucket, []).append({"token": token, "c_ms": int(c.timestamp()*1000), "e_ms": int(e.timestamp()*1000)})
    return out

def scan_room_day(rd_id, room, date, centroid, pqm_by_date, embedding_source="box"):
    import numpy as np  # only this function needs it; keeps the module importable without numpy
    turns = json.load(open(f"{DT}/turns-{rd_id}.json"))["turns"]
    npz = np.load(f"{DT}/emb-{rd_id}.npz")
    idxs, embs = npz["idx"], npz["emb"]

    segments = []
    embedded_spans = []  # EVERY embedded turn's (t0, t1), regardless of cos -- for coverage checks
    for j, ti in enumerate(idxs):
        t = turns[int(ti)]
        t0, t1 = int(t["s_ms"]), int(t["e_ms"])
        embedded_spans.append((t0, t1))
        c = cos(list(embs[j]), centroid)
        if c >= CUTS[0]:
            # "room" is redundant with this file's own top-level room but included per turn
            # (vj-refuter #5299) so a segment stays self-describing once pulled out of this file.
            segments.append({"t0": t0, "t1": t1, "cos": round(float(c), 4), "room": room})
    segments.sort(key=lambda s: s["t0"])

    cut_counts = {str(c): sum(1 for s in segments if s["cos"] >= c) for c in CUTS}
    cut_seconds = {str(c): round(sum((s["t1"]-s["t0"])/1000.0 for s in segments if s["cos"] >= c), 1) for c in CUTS}

    consults = pqm_by_date.get(date, [])
    per_consult = []
    for cst in consults:
        # Fable 12:20: attribution uses ONLY the tight +-30s pad now (the wide +-180s pad is
        # dropped entirely, not just for the room decision) -- his-voice turns = cos >= 0.55.
        w0, w1 = cst["c_ms"] - ATTRIBUTION_PAD_MS, cst["e_ms"] + ATTRIBUTION_PAD_MS
        his = [s for s in segments if s["cos"] >= HIS_VOICE_COS and s["t1"] > w0 and s["t0"] < w1]
        speech_s = sum((min(s["t1"], w1) - max(s["t0"], w0)) / 1000.0 for s in his)
        coses = [s["cos"] for s in his]
        embedded_s = sum((min(t1, w1) - max(t0, w0)) / 1000.0 for t0, t1 in embedded_spans
                          if t1 > w0 and t0 < w1)

        # FOUND/WEAK/NOT_SCANNED/None (vj-refuter #5301 F5 + #5323, Fable 12:20 ruling):
        # >=3 turns or >=15s of cos>=0.55 inside +-30s -> FOUND (room_found = this room);
        # some his-voice evidence but below that bar -> WEAK, regardless of total coverage (weak
        # evidence is still evidence); NO his-voice AND <60s of embedded audio in the window at
        # all -> NOT_SCANNED (dtree84 never checked this span, not a confident absence -- #5323
        # caught 8/14 of my earlier "no evidence" calls were actually this, not a real absence);
        # NO his-voice AND >=60s embedded -> None (a trustworthy, confident NOT-IN).
        if len(his) >= FOUND_MIN_TURNS or speech_s >= FOUND_MIN_SEC:
            room_found = room
        elif his:
            room_found = "weak"
        elif embedded_s < NOT_SCANNED_MIN_SEC:
            room_found = "not_scanned"
        else:
            room_found = None

        per_consult.append({
            "token": cst["token"], "called_ms": cst["c_ms"], "completed_ms": cst["e_ms"],
            "room_found": room_found,
            "his_speech_s": round(speech_s, 1),
            "embedded_s": round(embedded_s, 1),
            "max_cos": round(max(coses), 4) if coses else None,
            "median_cos": round(sorted(coses)[len(coses)//2], 4) if coses else None,
            "n_segments": len(his),
        })

    # walk-ins: BLOCKS of his voice (cos >= HIS_VOICE_COS, Fable 12:20) outside any PQM +-30s
    # window, merging turns <=MERGE_GAP_MS apart so a walk-in/TC is one block, not dozens of raw
    # turns; each block is then labelled the same FOUND/weak way as a PQM-anchored encounter,
    # since a single stray 0.55 turn is exactly the noise the coverage gate exists to reject.
    raw = [s for s in segments if s["cos"] >= HIS_VOICE_COS
           and not any(s["t1"] > (c["c_ms"]-ATTRIBUTION_PAD_MS) and s["t0"] < (c["e_ms"]+ATTRIBUTION_PAD_MS)
                       for c in consults)]
    walkins = []
    for s in raw:
        if walkins and s["t0"] - walkins[-1]["t1"] <= MERGE_GAP_MS:
            walkins[-1]["t1"] = max(walkins[-1]["t1"], s["t1"])
            walkins[-1]["max_cos"] = max(walkins[-1]["max_cos"], s["cos"])
            walkins[-1]["n_turns"] += 1
        else:
            walkins.append({"t0": s["t0"], "t1": s["t1"], "max_cos": s["cos"], "n_turns": 1})
    for w in walkins:
        dur_s = (w["t1"] - w["t0"]) / 1000.0
        w["confidence"] = "found" if (w["n_turns"] >= FOUND_MIN_TURNS or dur_s >= FOUND_MIN_SEC) else "weak"

    return {
        "schema": 1, "room": room, "room_day_id": rd_id, "date": date,
        "centroid": "manoj-kumar-s-tc-c270", "model": "speechbrain/spkrec-ecapa-voxceleb", "dim": 192,
        # vj-refuter #5498: hf-fleet's L4 pipeline (silero-VAD, same ECAPA model) measured a small
        # score offset vs the original box pipeline (median cos diff -0.013, max 0.057) -- recorded
        # per room-day so a reader can account for it, not silently mixed with box-embedded days.
        "embedding_source": embedding_source,
        "thresholds_reported": CUTS, "cut_counts": cut_counts, "cut_seconds": cut_seconds,
        "segments": segments, "per_consult": per_consult, "walkins": walkins,
    }

def main():
    os.makedirs(f"{OUT}/voice", exist_ok=True)
    centroid, cmeta = load_centroid()
    pqm_by_date = load_pqm()
    covered = json.load(open("covered.json"))

    all_walkins_rows = []
    summary = []
    for r in covered:
        date, room, rd_id = r["date"], r["room"], r["dtree84_rd_id"]
        embedding_source = r.get("embedding_source", "box")
        result = scan_room_day(rd_id, room, date, centroid, pqm_by_date, embedding_source)
        fn = f"{OUT}/voice/scan-{room.replace(' ', '').lower()}-{date}.json"
        json.dump(result, open(fn, "w"), indent=1)
        for w in result["walkins"]:
            all_walkins_rows.append({"date": date, "room": room, "t0_ms": w["t0"], "t1_ms": w["t1"],
                                      "dur_s": round((w["t1"]-w["t0"])/1000.0, 1), "max_cos": w["max_cos"],
                                      "n_turns": w["n_turns"], "confidence": w["confidence"]})
        summary.append((date, room, len(result["segments"]), result["cut_seconds"]["0.55"],
                         result["cut_seconds"]["0.65"], result["cut_seconds"]["0.7"],
                         len(result["per_consult"]), len(result["walkins"])))
        print(f"SCAN {date} {room} segs={len(result['segments'])} sec@0.55={result['cut_seconds']['0.55']} "
              f"sec@0.65={result['cut_seconds']['0.65']} sec@0.70={result['cut_seconds']['0.7']} "
              f"consults={len(result['per_consult'])} walkins={len(result['walkins'])}")

    with open(f"{OUT}/walk-ins.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["date", "room", "t0_ms", "t1_ms", "dur_s", "max_cos", "n_turns", "confidence"])
        w.writeheader()
        for row in sorted(all_walkins_rows, key=lambda r: (r["date"], r["room"], r["t0_ms"])):
            w.writerow(row)

    print(f"\nSCAN_DONE room_days={len(covered)} total_walkins={len(all_walkins_rows)}")
    return summary

if __name__ == "__main__":
    main()
