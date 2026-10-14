import re, sys
rtf = "/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf"
raw = open(rtf, "r", errors="ignore").read()
m = re.search(r"postgres(?:ql)?://[^\s\\\"'}]+", raw)
if not m:
    print("FATAL: no connection string"); sys.exit(2)
dsn = m.group(0).rstrip("\\")
try:
    import psycopg
except ImportError:
    import psycopg2 as psycopg
conn = psycopg.connect(dsn)
cur = conn.cursor()

def q(label, sql):
    try:
        cur.execute(sql)
        rows = cur.fetchall()
        print("--- %s ---" % label)
        for r in rows[:40]:
            print("   ", r)
        if len(rows) > 40:
            print("    ... %d rows total" % len(rows))
    except Exception as e:
        print("--- %s --- ERROR %s: %s" % (label, type(e).__name__, str(e)[:250]))
        conn.rollback()

q("clip presence by state", """
  SELECT state, count(*) AS windows,
         count(*) FILTER (WHERE clip_r2_key IS NOT NULL) AS has_clip
  FROM bench_window GROUP BY 1 ORDER BY 2 DESC""")

q("THE REAL BACKLOG: state=closed, no run yet (clip extracted at drain time)", """
  SELECT count(*) AS windows,
         round(sum(end_ms - start_ms)/3600000.0,1) AS audio_hours
  FROM bench_window bw
  WHERE bw.state = 'closed'
    AND NOT EXISTS (SELECT 1 FROM transcription_run tr
                    WHERE tr.subject_type='bench_window' AND tr.subject_id = bw.id)""")

q("backlog by room-day (top 20)", """
  SELECT bw.room_day_id, count(*) AS undrained
  FROM bench_window bw
  WHERE bw.state='closed'
    AND NOT EXISTS (SELECT 1 FROM transcription_run tr
                    WHERE tr.subject_type='bench_window' AND tr.subject_id = bw.id)
  GROUP BY 1 ORDER BY 2 DESC LIMIT 20""")

q("do the closed windows have session audio upstream?", """
  SELECT count(DISTINCT bw.session_id) AS sessions_in_backlog
  FROM bench_window bw WHERE bw.state='closed'""")

q("silent windows: were they adjudicated or just never run?", """
  SELECT count(*) AS silent,
         count(*) FILTER (WHERE clip_r2_key IS NOT NULL) AS has_clip
  FROM bench_window WHERE state='silent'""")

cur.close(); conn.close()
