#!/usr/bin/env python3
"""W52-B: union OPD4/OPD7 tape inventory (manifest.json UNION manifest_tierC.json by r2_key, per
the order's facts) through 27 Sep, split into room-days ALREADY covered by dtree84's existing
ECAPA embeddings vs. the GAP needing a fresh hf-fleet embedding job. Reused elsewhere by
voice_scan.py (covered) and embed_job_spec.py (gap). Usage: python3 room_day_inventory.py
"""
import glob
import json
import os

ROOMS = {"room_ux92qpws": "OPD 4", "room_qyzghzaf": "OPD 7"}
HIST = os.path.expanduser("~/eta-data/hist")
DT = os.path.expanduser("~/eta-data/voice-linkage/dtree84")


def load_jobs(path):
    return json.load(open(path))["jobs"]


def tape_inventory(through_date="2026-09-28"):
    # vj-refuter #5305: extended from 2026-09-27 (the order's original wording) to include today's
    # (28 Sep) own in-progress tape too, once it's real -- their coverage-gap check already counts
    # it, and a token landing there should read NOT SCANNED, never a false NOT-IN-OPD4-7.
    """(day, room_id) -> {r2_key: chunk}, union of manifest.json (tier A) + manifest_tierC.json by r2_key."""
    by_roomday = {}
    for path, tier in ((f"{HIST}/manifest.json", "A"), (f"{HIST}/manifest_tierC.json", "C")):
        for j in load_jobs(path):
            rid = j["room_id"]
            if rid not in ROOMS or j["day"] > through_date:
                continue
            key = (j["day"], rid)
            by_roomday.setdefault(key, {"chunks": {}, "tiers": set()})
            by_roomday[key]["tiers"].add(tier)
            for c in j.get("chunks", []):
                by_roomday[key]["chunks"][c["r2_key"]] = c
    return by_roomday


def dtree84_coverage():
    """(date, room_id) -> (room_day_id, embedding_source), for every room-day with USABLE
    embeddings for voice_scan.py: turns-rd_*.json + emb-rd_*.npz. Checking turns-rd_*.json directly
    (not link-rd_*.json, the clustering/centroid file voice_scan.py never reads) -- hf-fleet's embed
    job only produces turns+emb, no link file (found while onboarding their first delivery).
    embedding_source is "hf_l4" when no link-rd_*.json exists for that room-day (hf-fleet's silero-
    VAD+L4 pipeline), else "box" (the original dtree84 pipeline) -- vj-refuter #5498 measured a
    small but real score offset between the two (median cos diff -0.013, max 0.057), so this is
    recorded as provenance on every scanned room-day, not just the ones checked so far."""
    have_link = set()
    for lf in glob.glob(f"{DT}/link-rd_*.json"):
        if "-pl" not in lf:
            have_link.add(os.path.basename(lf)[len("link-"):-len(".json")])

    have = {}
    for tf in glob.glob(f"{DT}/turns-rd_*.json"):
        if "-pl" in tf:
            continue
        rd_id = os.path.basename(tf)[len("turns-"):-len(".json")]
        if not os.path.exists(f"{DT}/emb-{rd_id}.npz"):
            continue  # turns without embeddings can't be scanned
        try:
            d = json.load(open(tf))
        except Exception:
            continue
        room = d.get("room", {})
        rid = room.get("room_id")
        if rid in ROOMS:
            source = "box" if rd_id in have_link else "hf_l4"
            have[(room.get("date"), rid)] = (rd_id, source)
    return have


def main():
    by_roomday = tape_inventory()
    have = dtree84_coverage()
    covered, gap = [], []
    for (date, rid), v in sorted(by_roomday.items()):
        total_ms = sum(c["duration_ms"] for c in v["chunks"].values())
        row = {"date": date, "room": ROOMS[rid], "room_id": rid, "n_chunks": len(v["chunks"]),
               "tape_h": round(total_ms / 3600000, 2), "tiers": sorted(v["tiers"])}
        if (date, rid) in have:
            row["dtree84_rd_id"], row["embedding_source"] = have[(date, rid)]
            covered.append(row)
        else:
            row["chunks"] = sorted(v["chunks"].values(), key=lambda c: c["started_at"])
            gap.append(row)
    json.dump(covered, open("covered.json", "w"), indent=1)
    json.dump(gap, open("gap.json", "w"), indent=1)
    print(f"ROOMDAY_INVENTORY total={len(by_roomday)} covered={len(covered)} gap={len(gap)} "
          f"gap_tape_h={round(sum(r['tape_h'] for r in gap), 1)}")


if __name__ == "__main__":
    main()
