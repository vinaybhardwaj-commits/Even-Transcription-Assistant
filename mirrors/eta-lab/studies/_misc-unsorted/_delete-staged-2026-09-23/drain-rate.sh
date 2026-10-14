#!/bin/zsh
python3 - <<'PY'
import re, psycopg2
s=open("/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf",encoding='utf-8',errors='replace').read().replace('\\','')
u=[x.rstrip('.,;') for x in re.findall(r'postgres(?:ql)?://[^\s"\'<>{}]+', s) if 'pooler' not in x]
c=psycopg2.connect(u[0], connect_timeout=15); c.autocommit=True; cur=c.cursor()
cur.execute("""select column_name,data_type from information_schema.columns
               where table_name='room_diarize_window' order by ordinal_position""")
cols=cur.fetchall()
print("room_diarize_window columns:")
for n,d in cols: print("  ",n,":",d)
ts=[n for n,d in cols if 'timestamp' in d]
print("\ntimestamp cols:", ts)
for t in ts:
    try:
        cur.execute(f"select min({t}),max({t}),count(*) from room_diarize_window where {t} is not null")
        mn,mx,n=cur.fetchone(); print(f"\n{t}: n={n} min={mn} max={mx}")
        cur.execute(f"""select count(*) from room_diarize_window
                        where {t} > now() - interval '2 hours'""")
        print(f"   last 2h: {cur.fetchone()[0]}")
        cur.execute(f"""select count(*) from room_diarize_window
                        where {t} > now() - interval '30 minutes'""")
        print(f"   last 30m: {cur.fetchone()[0]}")
    except Exception as e: print(t,"ERR",str(e)[:90])
print()
cur.execute("select count(*) from room_window")
print("room_window total:", cur.fetchone()[0])
cur.close(); c.close()
PY
