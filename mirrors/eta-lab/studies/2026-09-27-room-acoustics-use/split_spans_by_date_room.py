#!/usr/bin/env python3
"""W49 (Fable 13:22): split missed_speech_spans.json (flat, all chunks) into lab-viewer's
expected layout: ~/eta-data/acoustics/<IST date>/<room_id>.json, one file per room-day, each
holding that room-day's chunks with reference/production/missed spans. Numbers + timestamps only.
"""
import json, os, sys, datetime, collections

def ist_date(iso_utc):
    t = datetime.datetime.fromisoformat(iso_utc.replace("Z", "+00:00"))
    t_ist = t + datetime.timedelta(hours=5, minutes=30)
    return t_ist.date().isoformat()

def main():
    src = json.load(open(sys.argv[1]))
    out_root = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/eta-data/acoustics")
    by_key = collections.defaultdict(list)
    for w in src["windows"]:
        d = ist_date(w["started_at"])
        by_key[(d, w["room_id"])].append(w)
    written = []
    for (d, room), chunks in by_key.items():
        dirp = os.path.join(out_root, d)
        os.makedirs(dirp, exist_ok=True)
        os.chmod(dirp, 0o750)
        path = os.path.join(dirp, f"{room}.json")
        chunks.sort(key=lambda w: w["started_at"])
        payload = {
            "schema": "acoustics-missed-speech-v1", "room_id": room, "ist_date": d,
            "generated": src.get("generated"),
            "reference_source": chunks[0]["reference_source"] if chunks else None,
            "production_source": chunks[0]["production_source"] if chunks else None,
            "note": src.get("note"),
            "chunks": [{k: v for k, v in c.items() if k not in ("room_id",)} for c in chunks],
        }
        json.dump(payload, open(path, "w"), indent=1)
        os.chmod(path, 0o640)
        written.append(path)
        print(path, len(chunks), "chunks")
    print("TOTAL files:", len(written))

if __name__ == "__main__":
    main()
