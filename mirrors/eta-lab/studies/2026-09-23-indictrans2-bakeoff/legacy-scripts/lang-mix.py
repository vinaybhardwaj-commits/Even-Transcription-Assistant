import re, sys, json
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
conn = psycopg.connect(dsn); cur = conn.cursor()

def q(label, sql):
    try:
        cur.execute(sql); rows = cur.fetchall()
        print("--- %s ---" % label)
        for r in rows[:25]: print("   ", r)
    except Exception as e:
        print("--- %s --- ERROR %s: %s" % (label, type(e).__name__, str(e)[:200])); conn.rollback()

q("detected_language on bench-window runs", """
  SELECT detected_language, count(*) , round(avg(latency_ms)) AS avg_ms
  FROM transcription_run WHERE subject_type='bench_window'
  GROUP BY 1 ORDER BY 2 DESC""")

# language_timeline lives in metrics_json; each entry has lang + chars + engine
q("engine + language share across ALL route segments (from metrics_json)", """
  SELECT seg->>'engine' AS engine, seg->>'lang' AS lang,
         count(*) AS segments,
         sum((seg->>'chars')::int) AS chars,
         round(sum(((seg->>'end_s')::numeric - (seg->>'start_s')::numeric))) AS audio_s
  FROM transcription_run tr,
       LATERAL jsonb_array_elements(tr.metrics_json->'language_timeline') seg
  WHERE tr.subject_type='bench_window' AND tr.engine='route'
  GROUP BY 1,2 ORDER BY audio_s DESC NULLS LAST""")

q("share of audio that is NOT english", """
  SELECT CASE WHEN seg->>'lang' ILIKE 'en%' THEN 'english' ELSE 'indic_or_other' END AS bucket,
         count(*) AS segments,
         round(sum(((seg->>'end_s')::numeric - (seg->>'start_s')::numeric))) AS audio_s
  FROM transcription_run tr,
       LATERAL jsonb_array_elements(tr.metrics_json->'language_timeline') seg
  WHERE tr.subject_type='bench_window' AND tr.engine='route'
  GROUP BY 1 ORDER BY audio_s DESC""")

cur.close(); conn.close()
