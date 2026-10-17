"""Neon check (read-only): per room-day 1440 min, no overlap, row counts equal the shadow files, withheld = one interval.

    python -m ras.neon_check            # prints numbers; exit 1 on any violation
"""
import glob, json, os, sys
import psycopg

OUT = os.path.expanduser("~/eta-data/consult/audio-state")
CRED = os.path.expanduser("~/.config/eta-audio/db.url")

PER_DAY_SQL = """
WITH s AS (
  SELECT room_id, ist_day, state, ts_start, ts_end,
         lag(ts_end) OVER (PARTITION BY room_id, ist_day ORDER BY ts_start) AS prev_end
  FROM room_audio_state)
SELECT room_id, ist_day::text, count(*) AS n, sum(extract(epoch FROM ts_end - ts_start))::float8 AS secs,
       count(*) FILTER (WHERE prev_end IS NOT NULL AND prev_end <> ts_start) AS bad_joins,
       count(*) FILTER (WHERE state = 'withheld') AS n_withheld,
       min(ts_start) = (ist_day::timestamp AT TIME ZONE 'Asia/Kolkata') AS starts_ok,
       max(ts_end) = ((ist_day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS ends_ok
FROM s GROUP BY room_id, ist_day ORDER BY room_id, ist_day"""
DAY_SQL = ("SELECT room_id, ist_day::text, min_off + min_muted + min_zero_all_day + min_present + min_gated + min_withheld, "
           "min_withheld FROM room_audio_day")
BAD_STATE_SQL = ("SELECT count(*) FROM room_audio_state WHERE ts_end <= ts_start")


def shadow_counts():
    out = {}
    for fn in glob.glob(os.path.join(OUT, "room_*.jsonl")):
        room, day = os.path.basename(fn)[:-6].rsplit("_", 1)
        rs = [json.loads(l) for l in open(fn)]
        out[(room, day)] = (len(rs), sum(1 for r in rs if r["state"] == "withheld"))
    return out


def main():
    shadow = shadow_counts()
    bad = []
    with psycopg.connect(open(CRED).read().strip(), connect_timeout=20) as c, c.cursor() as cur:
        cur.execute(PER_DAY_SQL)
        per = {(r[0], r[1]): r for r in cur.fetchall()}
        cur.execute(DAY_SQL)
        day = {(r[0], r[1]): r for r in cur.fetchall()}
        cur.execute(BAD_STATE_SQL)
        nonpos = cur.fetchone()[0]
    for k, (n_shadow, w_shadow) in sorted(shadow.items()):
        r = per.get(k)
        if r is None:
            bad.append((k, "missing in room_audio_state")); continue
        _, _, n, secs, joins, nw, s_ok, e_ok = r
        if n != n_shadow: bad.append((k, f"rows {n} != shadow {n_shadow}"))
        if abs(secs - 86400) > 1e-6: bad.append((k, f"secs {secs}"))
        if joins: bad.append((k, f"{joins} non-contiguous joins (gap/overlap)"))
        if not (s_ok and e_ok): bad.append((k, "does not span the IST day"))
        if w_shadow and not (nw == 1 and n == 1): bad.append((k, "withheld day is not a single interval"))
        d = day.get(k)
        if d is None or d[2] != 1440: bad.append((k, f"room_audio_day minutes {None if d is None else d[2]}"))
    extra = set(per) - set(shadow)
    if extra: bad.append((sorted(extra)[:3], f"{len(extra)} DB room-days with no shadow file"))
    if nonpos: bad.append(("all", f"{nonpos} rows with ts_end <= ts_start"))
    withheld_days = sum(1 for v in shadow.values() if v[1])
    print(json.dumps({"shadow_room_days": len(shadow), "db_room_days": len(per), "room_audio_day_rows": len(day),
                      "db_rows": sum(r[2] for r in per.values()), "shadow_rows": sum(v[0] for v in shadow.values()),
                      "room_days_1440_min_no_overlap": sum(1 for k, r in per.items() if abs(r[3] - 86400) < 1e-6 and not r[4]),
                      "withheld_room_days": withheld_days,
                      "withheld_single_interval": sum(1 for k, v in shadow.items() if v[1] and per.get(k) and per[k][2] == 1 and per[k][5] == 1),
                      "violations": len(bad)}))
    for b in bad[:20]:
        print("VIOLATION", b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
