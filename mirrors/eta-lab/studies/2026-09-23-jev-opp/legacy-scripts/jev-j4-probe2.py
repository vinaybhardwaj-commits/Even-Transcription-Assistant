import os, re, sys
rtf = "/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf"
raw = open(rtf, "r", errors="ignore").read()
m = re.search(r"postgres(?:ql)?://[^\s\\\"'}]+", raw)
dsn = m.group(0).rstrip("\\")
try:
    import psycopg
    conn = psycopg.connect(dsn)
except ImportError:
    import psycopg2 as psycopg
    conn = psycopg.connect(dsn)
cur = conn.cursor()
rd1 = "rd_qjhvj9n9"
def q(label, sql, params=None):
    try:
        cur.execute(sql, params or ())
        rows = cur.fetchall()
        print(f"--- {label} ---")
        for r in rows[:60]:
            print("   ", r)
    except Exception as e:
        print(f"--- {label} --- ERROR {type(e).__name__}: {str(e)[:200]}")
        conn.rollback()
q("join room_turn_speaker x cue stt_turn, count + char-length buckets (NO TEXT)", """
  SELECT count(*) AS joined_rows,
         count(*) FILTER (WHERE char_length(coalesce(c.payload->>'text','')) = 0) AS zero_len,
         count(*) FILTER (WHERE char_length(coalesce(c.payload->>'text','')) BETWEEN 1 AND 39) AS under_floor,
         count(*) FILTER (WHERE char_length(coalesce(c.payload->>'text','')) >= 40) AS at_or_over_floor
  FROM room_turn_speaker t
  JOIN cue c ON c.source_ref = t.source_ref AND c.type = 'stt_turn' AND c.room_day_id = t.room_day_id
  WHERE t.room_day_id = %s
""", (rd1,))
q("room_turn_speaker distinct window_id count for rd1", "SELECT count(DISTINCT window_id) FROM room_turn_speaker WHERE room_day_id=%s", (rd1,))
q("room_turn_speaker source_ref sample count vs cue source_ref count (rd1)", """
  SELECT (SELECT count(*) FROM room_turn_speaker WHERE room_day_id=%s) AS rts_rows,
         (SELECT count(*) FROM cue WHERE room_day_id=%s AND type='stt_turn') AS cue_rows,
         (SELECT count(*) FROM room_turn_speaker t WHERE t.room_day_id=%s
            AND EXISTS (SELECT 1 FROM cue c WHERE c.source_ref=t.source_ref AND c.type='stt_turn' AND c.room_day_id=t.room_day_id)) AS matched
""", (rd1, rd1, rd1))
cur.close(); conn.close()
