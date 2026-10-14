#!/bin/zsh
python3 - <<'PY'
import re, psycopg2
s=open("/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf",encoding='utf-8',errors='replace').read().replace('\\','')
u=[x.rstrip('.,;') for x in re.findall(r'postgres(?:ql)?://[^\s"\'<>{}]+', s) if 'pooler' not in x]
c=psycopg2.connect(u[0], connect_timeout=15); cur=c.cursor()
print("=== is room_day.doctor_id populated? ===")
cur.execute("select count(*) total, count(doctor_id) with_doctor, count(distinct doctor_id) distinct_doctors from room_day where scratch is not true")
print("   total=%s  with_doctor_id=%s  distinct_doctors=%s" % cur.fetchone())
print()
print("=== per ist_date: room-days and how many name a doctor ===")
cur.execute("""select ist_date, count(*) , count(doctor_id)
               from room_day where scratch is not true
               group by 1 order by 1 desc limit 20""")
for d,n,wd in cur.fetchall(): print(f"   {d}  room_days={n}  with_doctor={wd}")
print()
print("=== 2026-09-19 detail (room id, doctor_id, window) ===")
cur.execute("""select rd.room_id, r.slug, rd.doctor_id, rd.started_at, rd.ended_at
               from room_day rd left join room r on r.id=rd.room_id
               where rd.ist_date='2026-09-19' and rd.scratch is not true
               order by r.slug""")
for row in cur.fetchall(): print("  ", row)
cur.close(); c.close()
PY
