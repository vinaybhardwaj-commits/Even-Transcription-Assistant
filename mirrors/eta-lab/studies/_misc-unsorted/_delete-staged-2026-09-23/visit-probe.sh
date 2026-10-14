#!/bin/zsh
python3 - <<'PY'
import re, psycopg2
s=open("/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf",encoding='utf-8',errors='replace').read().replace('\\','')
u=[x.rstrip('.,;') for x in re.findall(r'postgres(?:ql)?://[^\s"\'<>{}]+', s)]
u=[x for x in u if 'pooler' not in x and x.endswith('neondb') or ('pooler' not in x and '/neondb?' in x)]
c=psycopg2.connect(u[0], connect_timeout=15); cur=c.cursor()
def cols(t):
    cur.execute("select column_name,data_type from information_schema.columns where table_schema='public' and table_name=%s order by ordinal_position",(t,))
    return cur.fetchall()
for t in ['visit','room_clinician_attestation','room_day','room']:
    print(f"=== {t}")
    for n,d in cols(t): print(f"   {n} : {d}")
    try:
        cur.execute(f"select count(*) from {t}"); print("   rows:", cur.fetchone()[0])
    except Exception as e: print("   count err:", str(e)[:80])
    print()
print("=== visit rows on 2026-09-19 (counts only) ===")
try:
    cur.execute("""select count(*) from visit v
                   where exists (select 1 from information_schema.columns
                                 where table_name='visit' and column_name='started_at')""")
    print("   probe ok")
except Exception as e: print("  ", str(e)[:120])
cur.close(); c.close()
PY
