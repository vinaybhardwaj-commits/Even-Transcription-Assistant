#!/usr/bin/env python3
"""W52-B: write the hf-fleet embedding job spec for the OPD4/OPD7 room-days dtree84 doesn't cover
yet (room_day_inventory.py's gap.json). lx does not run this job -- GPU/embedding jobs are
hf-fleet's lane per the W52 facts role list -- this script only produces the spec they need.
Fable 12:52 ruling (reverses 12:15): Fable is back online, so GPU = hf-fleet via HF Jobs L4, NOT
box T4 -- HF uploads are cleared for this batch now that Fable can coordinate them directly.
Usage: python3 room_day_inventory.py && python3 embed_job_spec.py <out.json>
"""
import json
import sys

ROOMS = {"room_ux92qpws": "OPD 4", "room_qyzghzaf": "OPD 7"}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "w52-embed-job-spec.json"
    gap = json.load(open("gap.json"))
    spec = {
        "job": "w52-manoj-embed-gap",
        "owner_ask": "lx (W52-B voice scan) -> hf-fleet",
        "model": "speechbrain/spkrec-ecapa-voxceleb",
        "dim": 192,
        "method": "Same pipeline as ~/eta-data/voice-linkage/dtree84 (VAD speech segments -> 1.5s "
                  "embedding windows -> per-turn 192-d ECAPA vectors), so outputs merge into the "
                  "same corpus voice_scan.py already reads. Reuse dtree84's own VAD config for "
                  "consistency with the already-scored room-days rather than picking a new one.",
        "output_convention": "turns-rd_<room_day_id>.json + emb-rd_<room_day_id>.json + "
                              "emb-rd_<room_day_id>.npz (idx[], emb[N,192]) -- same shape as the "
                              "existing dtree84 files, so voice_scan.py needs no changes to read them.",
        "budget_note": "Fable 12:52: GPU = hf-fleet via HF Jobs L4, box T4 is NOT for this job. "
                        "Fable is online and coordinating uploads directly -- size against the "
                        "original $40 W52 GPU cap (shared with diar-lab's diarization).",
        "constraints": ["HF Jobs L4 (Fable 12:52 ruling); box T4 explicitly excluded for this job",
                         "no Mini load 08:15-20:30",
                         "PHI allowed on box/R2/HF private bucket per W52 facts, nowhere else"],
        "room_days": [
            {"date": r["date"], "room_id": r["room_id"], "room": ROOMS[r["room_id"]],
             "n_chunks": r["n_chunks"], "tape_hours": r["tape_h"], "chunks": r["chunks"]}
            for r in gap
        ],
    }
    total_h = sum(r["tape_h"] for r in gap)
    json.dump(spec, open(out, "w"), indent=1)
    print(f"EMBED_JOB_SPEC room_days={len(gap)} tape_hours={round(total_h, 1)} -> {out}")


if __name__ == "__main__":
    main()
