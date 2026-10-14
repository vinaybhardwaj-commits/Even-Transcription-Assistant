import re
rtf = "/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf"
raw = open(rtf, "r", errors="ignore").read()
dsn = re.search(r"postgres(?:ql)?://[^\s\\\"'}]+", raw).group(0).rstrip("\\")
try: import psycopg
except ImportError: import psycopg2 as psycopg
conn = psycopg.connect(dsn); cur = conn.cursor()
def q(label, sql):
    try:
        cur.execute(sql); rows=cur.fetchall()
        print("--- %s ---" % label)
        for r in rows[:20]: print("   ", r)
        if not rows: print("    (no rows)")
    except Exception as e:
        print("--- %s --- ERR %s" % (label, str(e)[:150])); conn.rollback()

q("voice_print columns", """SELECT column_name FROM information_schema.columns
   WHERE table_name='voice_print' ORDER BY ordinal_position""")
q("WHO IS ENROLLED (ids + counts only)", """
  SELECT clinician_id, count(*) AS prints, max(created_at)::date AS newest
  FROM voice_print GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 15""")
q("voice_sample per clinician", """
  SELECT clinician_id, count(*) AS samples
  FROM voice_sample GROUP BY 1 ORDER BY 2 DESC LIMIT 15""")
q("SPEAKER ID: how often has it actually fired, by room", """
  SELECT rd.room_id, r.slug, count(*) AS turns,
         count(ts.clinician_id) AS named,
         round(100.0*count(ts.clinician_id)/count(*),1) AS pct
  FROM room_turn_speaker ts
  JOIN room_day rd ON rd.id = ts.room_day_id
  JOIN room r ON r.id = rd.room_id
  GROUP BY 1,2 ORDER BY named DESC LIMIT 12""")
q("which clinicians got named", """
  SELECT clinician_id, count(*) AS turns, count(DISTINCT room_day_id) AS room_days
  FROM room_turn_speaker WHERE clinician_id IS NOT NULL
  GROUP BY 1 ORDER BY 2 DESC LIMIT 10""")
q("OPD 3 diarized days with turns", """
  SELECT rd.ist_date::text, count(*) AS turns, count(ts.clinician_id) AS named
  FROM room_turn_speaker ts JOIN room_day rd ON rd.id=ts.room_day_id
  WHERE rd.room_id='room_87frpus9' GROUP BY 1 ORDER BY 1 DESC LIMIT 10""")
cur.close(); conn.close()
