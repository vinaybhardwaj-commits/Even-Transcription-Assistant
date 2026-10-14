#!/usr/bin/env python3
"""W39 A1 step 2: summarize vad_blind_check.py's output. Numbers only."""
import json, sys, collections

def main():
    rows = json.load(open(sys.argv[1]))
    by_room = collections.defaultdict(list)
    for r in rows:
        if "error" in r: continue
        by_room[r["room_id"]].append(r)
    out = {}
    for room, rr in by_room.items():
        tot_ref = sum(r["ref_speech_s"] for r in rr)
        tot_missed = sum(r["ref_speech_missed_s"] for r in rr)
        methods = collections.Counter(r["seg_method"] for r in rr)
        nonempty = [r for r in rr if r["seg_method"] == "silero-vad"]
        tot_ref_ne = sum(r["ref_speech_s"] for r in nonempty)
        tot_missed_ne = sum(r["ref_speech_missed_s"] for r in nonempty)
        out[room] = {
            "n_chunks": len(rr),
            "n_errors": sum(1 for r in rows if r.get("room_id") == room and "error" in r),
            "seg_methods": dict(methods),
            "ref_speech_s_total": round(tot_ref, 1),
            "ref_speech_missed_s_total": round(tot_missed, 1),
            "pct_ref_speech_missed_overall": round(100 * tot_missed / tot_ref, 1) if tot_ref else None,
            "silero_nonempty_chunks": len(nonempty),
            "ref_speech_s_in_nonempty_chunks": round(tot_ref_ne, 1),
            "missed_s_in_nonempty_chunks": round(tot_missed_ne, 1),
            "pct_missed_within_nonempty_chunks": round(100 * tot_missed_ne / tot_ref_ne, 1) if tot_ref_ne else None,
            "chunks_with_gt50pct_missed": sum(1 for r in nonempty if r["ref_speech_s"] > 0 and r["ref_speech_missed_s"] / r["ref_speech_s"] > 0.5),
        }
    json.dump(out, open(sys.argv[2], "w"), indent=1)
    print(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()
