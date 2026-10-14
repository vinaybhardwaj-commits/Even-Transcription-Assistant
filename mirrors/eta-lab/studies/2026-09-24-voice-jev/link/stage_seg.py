#!/usr/bin/env python3
"""vj-link extension (box, read-only Neon): for dates WITHOUT production transcripts, build turns-<rd>.json from the DIARIZER segments (room_diarize_window.segments_json, window-relative ms) so that the
audio-only steps (voice timing, edge alignment, cross-day voices) can run. text = "" and spk = the diarizer's window-local speaker index; no Rx or Jev is possible on these days (links there are capped at MED).
Same file shape as stage.py (room, turns, windows). Only room-days with >= 5 diarized windows; home-office / scratch rooms excluded. Counts only on stdout.
Usage: stage_seg.py 2026-09-09 ... 2026-09-15      Out: ~/eta-data/voice-linkage/pilot/turns-<rd>.json, seg-rds.json (list of room-day ids)"""
import json, os, re, subprocess, sys
REPO = os.path.expanduser("~/dev/Even-Transcription-Assistant"); HELPER = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
OUT = os.path.expanduser("~/eta-data/voice-linkage/pilot"); IDRE = re.compile(r"^[A-Za-z0-9_\-]+$")
def neon(sql):
    r = subprocess.run(["node", HELPER, sql], cwd=REPO, capture_output=True, text=True, timeout=900)
    if r.returncode: raise SystemExit("neon-select failed: " + r.stderr[:200])
    return json.loads(r.stdout)
rds = []
for d in sys.argv[1:]:
    assert re.match(r"^\d{4}-\d{2}-\d{2}$", d)
    for r in neon(f"SELECT rd.id room_day_id, rd.room_id, r.name room, rd.ist_date::text date FROM room_day rd JOIN room r ON r.id=rd.room_id WHERE rd.ist_date='{d}'::date AND r.name !~* '(home|scratch)'"):
        rd = r["room_day_id"]; assert IDRE.match(rd)
        wins = neon(f"SELECT bw.id window_id, bw.start_ms, bw.end_ms, rdw.state, rdw.clip_r2_key, rdw.segments_json FROM bench_window bw LEFT JOIN room_diarize_window rdw ON rdw.window_id=bw.id WHERE bw.room_day_id='{rd}' ORDER BY bw.start_ms")
        ok = [w for w in wins if w.get("state") == "ok" and w.get("segments_json")]
        if len(ok) < 5: continue
        turns = []
        for w in ok:
            segs = w["segments_json"]; segs = json.loads(segs) if isinstance(segs, str) else segs; w0 = int(w["start_ms"])
            for i, g in enumerate(segs):
                if g["end_ms"] - g["start_ms"] < 300: continue
                turns.append({"source_ref": f"seg|{w['window_id']}|{i}", "s_ms": str(w0 + int(g["start_ms"])), "e_ms": str(w0 + int(g["end_ms"])), "win": w["window_id"], "spk": str(g["speaker_idx"]), "lang": "", "text": "", "nsp": None})
        turns.sort(key=lambda t: int(t["s_ms"])); r["n_turns"], r["n_windows"] = len(turns), len(wins)
        p = f"{OUT}/turns-{rd}.json"; json.dump({"room": r, "turns": turns, "windows": wins}, open(p, "w")); os.chmod(p, 0o600)
        rds.append(rd); print(r["date"], r["room"], rd, "turns", len(turns), "diarized windows", len(ok), flush=True)
json.dump(rds, open(f"{OUT}/seg-rds.json", "w")); print("STAGE_SEG_DONE room_days", len(rds))
