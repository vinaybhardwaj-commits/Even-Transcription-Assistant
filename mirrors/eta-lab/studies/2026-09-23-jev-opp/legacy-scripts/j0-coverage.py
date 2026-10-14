import os, re, sys, json
# Connection string is read from the RTF at run time. It is never printed and never
# placed on a command line; it reaches psycopg through the environment of this process only.
rtf = "/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf"
raw = open(rtf, "r", errors="ignore").read()
m = re.search(r"postgres(?:ql)?://[^\s\\\"'}]+", raw)
if not m:
    print("FATAL: no connection string found"); sys.exit(2)
dsn = m.group(0).rstrip("\\")
try:
    import psycopg
    conn = psycopg.connect(dsn)
except ImportError:
    import psycopg2 as psycopg
    conn = psycopg.connect(dsn)
cur = conn.cursor()
def q(label, sql):
    try:
        cur.execute(sql)
        rows = cur.fetchall()
        print(f"--- {label} ---")
        for r in rows[:25]:
            print("   ", r)
        if len(rows) > 25: print(f"    ... {len(rows)} rows total")
    except Exception as e:
        print(f"--- {label} --- ERROR {type(e).__name__}: {str(e)[:200]}")
        conn.rollback()

q("jev tables present", """
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name LIKE 'jev%' ORDER BY 1""")
q("jev_window_text: room-days with J0 output", """
  SELECT room_day_id, count(*) AS windows, count(*) FILTER (WHERE source='english') AS eng
  FROM jev_window_text GROUP BY 1 ORDER BY 2 DESC LIMIT 25""")
q("jev_window_text totals", "SELECT count(*) rows, count(DISTINCT room_day_id) room_days FROM jev_window_text")
q("jev_window_signal rows", "SELECT count(*) FROM jev_window_signal")
q("jev_role_signal rows", "SELECT count(*) FROM jev_role_signal")
q("room-days with diarize windows state=ok", """
  SELECT room_day_id, count(*) AS ok_windows
  FROM room_diarize_window WHERE state='ok' GROUP BY 1 ORDER BY 2 DESC LIMIT 25""")
q("voice_print_generation (0108) present", """
  SELECT column_name FROM information_schema.columns
  WHERE table_name='voice_print_generation' ORDER BY ordinal_position LIMIT 15""")
q("route_outcome column live?", """
  SELECT column_name FROM information_schema.columns
  WHERE table_name='stt_run' AND column_name IN ('route_outcome','metrics_json') ORDER BY 1""")
cur.close(); conn.close()
