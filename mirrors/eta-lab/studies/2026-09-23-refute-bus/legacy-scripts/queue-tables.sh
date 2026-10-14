#!/bin/zsh
set -u
python3 - <<'PY'
import re, sys, subprocess
try:
    import psycopg2
except ImportError:
    print("psycopg2 absent - installing"); sys.exit(9)
p="/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf"
s=open(p,encoding='utf-8',errors='replace').read().replace('\\','')
urls=[]
for x in re.findall(r'postgres(?:ql)?://[^\s"\'<>{}]+', s):
    x=x.rstrip('.,;')
    if x not in urls: urls.append(x)
print("connection strings:", len(urls))
Q="""select table_name from information_schema.tables
where table_schema='public'
and (table_name ~* 'queue|token|room|counter|display|consult|opd|visit|doctor|clinic')
order by 1 limit 60;"""
seen=set()
for i,u in enumerate(urls,1):
    hostdb = re.sub(r'^postgres(ql)?://[^@]*@','',u).split('?')[0]
    if hostdb in seen:
        print(f"--- db {i}: {hostdb}  (duplicate, skipped)"); continue
    seen.add(hostdb)
    print(f"--- db {i}: {hostdb}")
    try:
        c=psycopg2.connect(u, connect_timeout=15); cur=c.cursor(); cur.execute(Q)
        rows=[r[0] for r in cur.fetchall()]
        print("   matching tables:", len(rows))
        for r in rows: print("   -", r)
        cur.close(); c.close()
    except Exception as e:
        print("   ERROR:", str(e)[:160])
    print()
PY
