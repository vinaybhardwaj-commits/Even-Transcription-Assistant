#!/usr/bin/env python3
"""vj-link stage 0 (box, read-only Neon): turns + diarizer windows for every room-day of the pilot dates.
Writes ~/eta-data/voice-linkage/pilot/turns-<room_day_id>.json (0600; transcript text = PHI, never in git) and rooms.json (ids and names only).
Prints counts only. Turn time: cue.payload start_ms/end_ms are absolute epoch ms; source_ref = <session>|<start_ms>|<end_ms>|-.
Usage: stage.py 2026-09-19 2026-09-22 2026-09-23"""
import json, os, re, subprocess, sys
REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant")
HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
OUT = os.path.expanduser("~/eta-data/voice-linkage/pilot"); os.makedirs(OUT, exist_ok=True)
IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")


def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=900)
    if r.returncode: raise SystemExit("neon-select failed: " + r.stderr[:200])
    return json.loads(r.stdout)


def main(dates):
    rooms = []
    for d in dates:
        assert re.match(r"^\d{4}-\d{2}-\d{2}$", d)
        rooms += neon(f"SELECT rd.id room_day_id, rd.room_id, r.name room, rd.ist_date::text date FROM room_day rd JOIN room r ON r.id=rd.room_id WHERE rd.ist_date='{d}'::date")
    rooms.sort(key=lambda r: (r["date"], r["room"]))
    tot = 0
    for r in rooms:
        rd = r["room_day_id"]; assert IDRE.match(rd)
        turns = neon(f"""SELECT source_ref, (payload->>'start_ms')::bigint AS s_ms, (payload->>'end_ms')::bigint AS e_ms, payload->>'window' AS win,
                 payload->>'speaker' AS spk, payload->>'language' AS lang, payload->>'text' AS text, (payload->>'no_speech_prob')::float AS nsp
                 FROM cue WHERE type='stt_turn' AND room_day_id='{rd}' ORDER BY 2""")
        wins = neon(f"""SELECT bw.id window_id, bw.start_ms, bw.end_ms, rdw.state, rdw.clip_r2_key, rdw.segments_json
                 FROM bench_window bw LEFT JOIN room_diarize_window rdw ON rdw.window_id=bw.id WHERE bw.room_day_id='{rd}' ORDER BY bw.start_ms""")
        r["n_turns"], r["n_windows"] = len(turns), len(wins); tot += len(turns)
        p = f"{OUT}/turns-{rd}.json"
        json.dump({"room": r, "turns": turns, "windows": wins}, open(p, "w")); os.chmod(p, 0o600)
        print(r["date"], r["room"], rd, "turns", len(turns), "windows", len(wins), flush=True)
    json.dump(rooms, open(f"{OUT}/rooms.json", "w"), indent=1)
    print("STAGE_DONE room_days", len(rooms), "turns", tot)


if __name__ == "__main__":
    main(sys.argv[1:])
