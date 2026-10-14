#!/usr/bin/env python3
"""W39 A3: build the actual versioned baseline JSON from ROOM-PROFILES, per the schema documented
in ACOUSTICS-USE-2026-09-27.md A3.1. Numbers only."""
import json, hashlib, datetime, os

SRC = os.path.expanduser("~/eta-data/acoustics/ROOM-PROFILES-2026-09-27.md")
SRC_JSON = os.path.expanduser("~/eta-data/acoustics/room-profiles-2026-09-27.json")
OUT = os.path.expanduser("~/eta-data/acoustics/baselines/room-acoustic-baseline-v1.json")

RID = {"OPD 1": "room_yh3etjpf", "OPD 3": "room_87frpus9", "OPD 4": "room_ux92qpws",
      "OPD 5": "room_4ggnkg5x", "OPD 6": "room_pnyc9u49", "OPD 7": "room_qyzghzaf",
      "Third Floor": "room_d74hhmc4", "Cardiology": "room_bh6jtq4t",
      "Room 4-1 (after cards, before 5)": "room_ymch4bxu", "ORB3": "room_jwyrr4dc"}

def main():
    d = json.load(open(SRC_JSON))
    src_sha = hashlib.sha256(open(SRC, "rb").read()).hexdigest()
    rooms = {}
    for p in d["profiles"]:
        rid = RID.get(p["room"])
        if not rid: continue
        entry = {
            "room_label": p["room"], "mic": p["mic"],
            "noise_dbfs_median": p.get("noise_median_dbfs"),
            "noise_dbfs_p10": p.get("noise_floor_p10_dbfs"),
            "clipping_pct": p.get("clip_pct_ge_0.999"),
            "exact_zero_share": round((p.get("exact_zero_sample_pct") or 0) / 100, 6),
            "rt60_s_blind": (p.get("rt60_blind") or {}).get("median_s"),
            "rt60_n_decays": (p.get("rt60_blind") or {}).get("n_decays"),
            "snr_db_vad_free": (p.get("snr_vad_free_db") or {}).get("median"),
            "basis": {"chunks": p.get("chunks"), "hours": p.get("hours"), "days": p.get("days")},
        }
        # rooms with two mics (OPD 3, Cardiology in source data) get a list; else a single dict
        rooms.setdefault(rid, []).append(entry)
    rooms_out = {k: (v[0] if len(v) == 1 else v) for k, v in rooms.items()}
    out = {
        "schema": "room-acoustic-baseline", "version": 1,
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "source_report": "ACOUSTICS/ROOM-PROFILES-2026-09-27.md", "source_report_sha256": src_sha,
        "note": "Per acoustics/W39 A3.1. Field mapping to score_selftest_room.py's own output fields "
                "and the drift-band rules are in ACOUSTICS-USE-2026-09-27.md. A room with two mics in "
                "the source window (OPD 3, Cardiology) carries a LIST of entries, oldest-mic first; "
                "diar-lab picks the entry matching the room's CURRENT room_install.input_device_name.",
        "rooms": rooms_out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    os.chmod(os.path.dirname(OUT), 0o750)
    json.dump(out, open(OUT, "w"), indent=1)
    os.chmod(OUT, 0o640)
    print("wrote", OUT, len(rooms_out), "rooms")

if __name__ == "__main__":
    main()
