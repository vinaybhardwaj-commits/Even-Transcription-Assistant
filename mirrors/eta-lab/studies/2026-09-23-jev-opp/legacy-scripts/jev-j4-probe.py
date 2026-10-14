import os, re, sys, json
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
ROOM_DAYS = ["rd_qjhvj9n9","rd_6nwgyrpx","rd_akp6hnb7","rd_zdhjzyf5","rd_f4hzv5sj",
             "rd_skk4yuke","rd_q299p4xb","rd_np5wt5tw","rd_jqj96amk","rd_8kshcb64"]
def q(label, sql, params=None):
    try:
        cur.execute(sql, params or ())
        rows = cur.fetchall()
        print(f"--- {label} ---")
        for r in rows[:60]:
            print("   ", r)
        if len(rows) > 60: print(f"    ... {len(rows)} rows total")
    except Exception as e:
        print(f"--- {label} --- ERROR {type(e).__name__}: {str(e)[:200]}")
        conn.rollback()
rd1 = ROOM_DAYS[0]
q("J0 jev_window_text by source (rd1)", "SELECT source, count(*) FROM jev_window_text WHERE room_day_id=%s GROUP BY 1 ORDER BY 2 DESC", (rd1,))
q("J2 jev_window_signal by prompt_version (rd1)", "SELECT prompt_version, count(*) FROM jev_window_signal WHERE room_day_id=%s GROUP BY 1 ORDER BY 2 DESC", (rd1,))
q("J3 jev_role_signal by role (rd1)", "SELECT role, count(*) FROM jev_role_signal WHERE room_day_id=%s GROUP BY 1 ORDER BY 2 DESC", (rd1,))
q("bench_window count (rd1)", "SELECT count(*) FROM bench_window WHERE room_day_id=%s", (rd1,))
q("room_diarize_window state counts (rd1)", "SELECT state, count(*) FROM room_diarize_window WHERE room_day_id=%s GROUP BY 1 ORDER BY 2 DESC", (rd1,))
q("transcription_run rows joined to bench_window for rd1 (count only)", "SELECT count(*) FROM transcription_run tr JOIN bench_window bw ON bw.id = tr.subject_id WHERE bw.room_day_id = %s", (rd1,))
q("room_turn_speaker rows for rd1 windows (count only)", "SELECT count(*) FROM room_turn_speaker WHERE room_day_id=%s", (rd1,))
q("cue stt_turn rows for rd1 (count only)", "SELECT count(*) FROM cue WHERE room_day_id=%s AND type='stt_turn'", (rd1,))
q("ALL 10 room-days: jev_window_text totals", "SELECT room_day_id, count(*) FROM jev_window_text WHERE room_day_id = ANY(%s) GROUP BY 1 ORDER BY 1", (ROOM_DAYS,))
q("ALL 10 room-days: jev_window_signal totals", "SELECT room_day_id, count(*) FROM jev_window_signal WHERE room_day_id = ANY(%s) GROUP BY 1 ORDER BY 1", (ROOM_DAYS,))
q("ALL 10 room-days: jev_role_signal totals", "SELECT room_day_id, count(*) FROM jev_role_signal WHERE room_day_id = ANY(%s) GROUP BY 1 ORDER BY 1", (ROOM_DAYS,))
cur.close(); conn.close()
