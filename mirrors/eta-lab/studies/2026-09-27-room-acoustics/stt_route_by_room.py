#!/usr/bin/env python3
"""W34.2 step 3: per-room STT route outcome counts (numbers only, no text) from Neon via the read-only kit/neon-select.mjs.
Usage: stt_route_by_room.py OUT.json   (cwd is not needed; runs node from the ETA repo checkout so @neondatabase/serverless resolves)
Columns per room: windows (latest route run per window), share detected_language=en, share non-en (excl. und/empty), share tiny (<15 chars),
share with any Indic-script char.
R3/W51: excludes every held-out room-day (heldout.py union, fail closed). Pending eta-refuter PASS: do not run (Fable #8315 item 7). These are ROUTE OUTPUT shapes, not truth: no garble label exists per room.
"""
import json, subprocess, sys, os, collections, datetime
sys.path.insert(0, os.path.expanduser("~/eta-data/drtpqma"))
import heldout  # R3/W51 (Fable #6727): import/load failure crashes = fail closed

union, union_sha = heldout.load_union()
inv = {v: k for k, v in heldout.LABEL.items()}
# Blind room-days are excluded IN THE SQL (their transcripts are never evaluated). A room_day is also dropped when the
# NEXT day is blind (a window starting late on D can end on D+1), which is conservative on purpose.
BLIND = sorted({(inv[e.split(" ", 1)[1]], d) for e in union for d in (e.split(" ", 1)[0], (datetime.date.fromisoformat(e.split(" ", 1)[0]) - datetime.timedelta(days=1)).isoformat())})
assert len(BLIND) >= 14, "blind list unexpectedly small"
BLIND_SQL = ", ".join(f"('{r}','{d}')" for r, d in BLIND)
SQL = ("select rd.room_id, rd.ist_date, count(*) n, sum((t.detected_language='en')::int) en, "
       "sum((t.detected_language is not null and t.detected_language not in ('en','und',''))::int) nonen, "
       "sum((coalesce(length(t.transcript_original),0)<15)::int) tiny, "
       "sum((t.transcript_original ~ '[ऀ-෿]')::int) indicscript "
       "from (select distinct on (subject_id) * from transcription_run where subject_type='bench_window' and engine='route' order by subject_id, created_at desc) t join bench_window w on w.id=t.subject_id join room_day rd on rd.id=w.room_day_id "
       "where t.subject_type='bench_window' and t.engine='route' and rd.ist_date >= '2026-09-19' "
       f"and (rd.room_id, rd.ist_date::text) not in ({BLIND_SQL}) group by 1,2 order by 1,2")
repo = os.path.expanduser("~/dev/Even-Transcription-Assistant")
r = subprocess.run(["node", os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"), SQL], cwd=repo, capture_output=True, text=True, check=True)
rows = json.loads(r.stdout)
by = collections.defaultdict(lambda: collections.Counter())
days = collections.defaultdict(set)
for x in rows:
    d = (datetime.datetime.fromisoformat(x["ist_date"].replace("Z", "+00:00")) + datetime.timedelta(hours=5, minutes=30)).date().isoformat()
    assert not heldout.is_held_out(union, d, x["room_id"]), f"blind room-day returned: {d} {x['room_id']}"
    for k in ("n", "en", "nonen", "tiny", "indicscript"): by[x["room_id"]][k] += int(x[k])
    days[x["room_id"]].add(d)
out = {}
for rid, c in by.items():
    n = c["n"]
    out[rid] = {"windows": n, "ist_days": sorted(days[rid]), "en_pct": round(100 * c["en"] / n, 1), "nonen_pct": round(100 * c["nonen"] / n, 1),
                "tiny_pct": round(100 * c["tiny"] / n, 1), "indic_script_pct": round(100 * c["indicscript"] / n, 1)}
json.dump({"heldout_union_sha16": union_sha, "blind_room_days_excluded_in_sql": len(BLIND), "source": "transcription_run engine=route, mode=batch, room_day ist_date >= 2026-09-19 (ist_date is a date; the driver returns it as local-midnight IST = 18:30Z the day before, hence +5:30 below)", "rooms": out}, open(sys.argv[1], "w"), indent=1)
