"""criterion189_23sep.py — lx's test of ruling 189 criterion 1 (VOICE-LINKAGE HIGH tier) on 23 Sep. Evidence, run as a script.

Sections, in order (all tolerances DECLARED before scoring; numbers/ids only, no text):
  1. edge alignment per (doctor, room-day), z vs a shifted-time null, confirmed doctor's rank at 3 tolerances
  2. normalised score + greedy one-to-one assignment
  3. ruling 189 criterion 1 exactly as ruled (excess >= 2, top-3 by z, not TOPPING another room in overlapping hours)
  4. stricter: drop a doctor from EVERY room they pass in at overlapping hours; keep only links stable at >= 2 of 3 tolerances
  5. PLACEBO: consult times shifted by a wrong number of hours, to count pairs that pass by chance
RESULT (23 Sep, 9 room-days, 23 doctors with >= 3 timed consults; only 3 rooms have a truth, and it is the stored voiceprint):
  criterion 1 as ruled passes 6/9/10 pairs at tolerances 180-300 / 240-360 / 300-480 s; the confirmed doctor passes in 2/1/1 of 3
  rooms. The PLACEBO passes 2-12 pairs (mostly 6-8) at the same tolerances, versus 7/11/14 real before exclusivity: about HALF
  of the pairs that pass are expected by chance. Ruling 189's exclusivity ('not topping another room') lets a doctor pass in two
  rooms at once (FxzVV... in OPD 1 and OPD 5); mutual exclusivity + stability across tolerances leaves 6 pairs and keeps the
  confirmed doctor in OPD 3 and OPD 5, not Cardiology. Criterion 1 is a SHORTLIST filter, not evidence of a link.
RULING 194 (mutual exclusivity + stability + n >= 5), section 6: stable at >= 2 of the 3 tolerances -> 6 pairs (the confirmed doctors of
  OPD 3 and OPD 5 among them); stable at ALL 3 -> 3 pairs; plus n >= 5 -> the same 3, and NONE is a stored-voiceprint-confirmed doctor
  (OPD 5's has n = 3; OPD 3's passes at only 2 of 3). So the strict reading gives a truthful, tiny, unvalidated HIGH set.
Inputs (box only, PHI-adjacent): ~/eta-data/encounter-first/{all-rooms-23sep,levels-all-23sep,labels-all-23sep}.json, pqm-23sep-metabase.csv.
"""
import csv, json, sys, statistics, collections
from datetime import datetime
sys.path.insert(0, '/home/eta/dev/eta-lab/studies/2026-09-24-encounter-first')
import segmenter as S
D = '/home/eta/eta-data/encounter-first'; DATE = '2026-09-23'
rooms = json.load(open(f'{D}/all-rooms-23sep.json')); lv = json.load(open(f'{D}/levels-all-23sep.json')); lb = json.load(open(f'{D}/labels-all-23sep.json'))
pqm = [r for r in csv.DictReader(open(f'{D}/pqm-23sep-metabase.csv')) if r['called_at'] and r['completed_at']]
ms = lambda s: int(datetime.fromisoformat(s).timestamp() * 1000)
H, name = {}, {r['room_day_id']: r['room'] for r in rooms}
for r in rooms:
    L = [(int(x['t']), float(x['peak'])) for x in lv if x['room_id'] == r['room_id']]
    B = [{**x, 'start_ms': int(x['start_ms']), 'end_ms': int(x['end_ms'])} for x in lb if x['room_day_id'] == r['room_day_id']]
    H[r['room_day_id']] = S.arm_a(L, B, DATE)
cons = collections.defaultdict(list)
for r in pqm:
    a, b = ms(r['called_at']), ms(r['completed_at'])
    if 60000 <= b - a <= 3600000: cons[r['doctor_uid']].append((a, b))
print('candidate encounters per room-day:', {name[k][:8]: len(v) for k, v in H.items()})
TOLS = ((180, 300), (240, 360), (300, 480))   # DECLARED before scoring (start s, end s); E-7 median errors were 175 / 328 s
SH = (-3, -2, 2, 3)
def edge_ok(a, b, hy, ts, te): return any(abs(s - a) <= ts * 1000 and abs(e - b) <= te * 1000 for s, e in hy)
def counts(ts, te, sh):
    t = collections.defaultdict(collections.Counter)
    for d, cs in cons.items():
        for a, b in cs:
            for rd, hy in H.items():
                if edge_ok(a + sh * 3600000, b + sh * 3600000, hy, ts, te): t[d][rd] += 1
    return t
w = json.load(open('/home/eta/dev/eta-lab/studies/2026-09-23-e7-pqm-truth/voiceprint-23sep-widened.json'))['room_days']
norm = lambda n: ' '.join((n or '').lower().replace('dr.', '').replace('dr ', '').split())
dn = {r['doctor_uid']: r['doctor_name'] for r in pqm}
truth = {x['room_day_id']: next((u for u, n in dn.items() if norm(n) == norm(x.get('confirmed_doctor'))), None) for x in w if x.get('confirmed')}
for ts, te in TOLS:
    real = counts(ts, te, 0); nulls = [counts(ts, te, h) for h in SH]
    print(f"== edge tolerance start {ts}s / end {te}s")
    for rd in truth:
        rows = sorted(((round(real[d][rd] - statistics.mean(n[d][rd] for n in nulls), 2), real[d][rd], round(statistics.mean(n[d][rd] for n in nulls), 2), len(cs), d) for d, cs in cons.items() if len(cs) >= 3), reverse=True)
        tr = next((i + 1 for i, r in enumerate(rows) if r[4] == truth[rd]), None); me = next(r for r in rows if r[4] == truth[rd]); top, run = rows[0], rows[1]
        print(f"  {name[rd][:12]:12} confirmed doctor rank {tr:>2}/{len(rows)} (aligned {me[1]}/{me[3]}, null {me[2]}, excess {me[0]}) | TOP {top[4][:6]} {top[1]}/{top[3]} null {top[2]} excess {top[0]} | runner-up excess {run[0]}")

# ---- normalised score + one-to-one assignment (a doctor is in ONE room at a time); tolerances as declared above
import math
print("== NORMALISED: z = (aligned - null) / sqrt(n consults), n >= 3; greedy one-to-one doctor<->room-day over all 9 rooms")
for ts, te in TOLS:
    real = counts(ts, te, 0); nulls = [counts(ts, te, h) for h in SH]
    S_ = {}
    for d, cs in cons.items():
        if len(cs) < 3: continue
        for rd in H: S_[(d, rd)] = (real[d][rd] - statistics.mean(n[d][rd] for n in nulls)) / math.sqrt(len(cs))
    ranks = {}
    for rd in truth:
        order = sorted(((v, d) for (d, r), v in S_.items() if r == rd), reverse=True); ranks[rd] = next(i + 1 for i, (v, d) in enumerate(order) if d == truth[rd])
    used_d, used_r, pick = set(), set(), {}
    for v, d, rd in sorted(((v, d, rd) for (d, rd), v in S_.items()), reverse=True):
        if d in used_d or rd in used_r or v <= 0: continue
        used_d.add(d); used_r.add(rd); pick[rd] = (d, round(v, 2))
    ok = {name[rd][:9]: ('RIGHT' if pick.get(rd, (None,))[0] == truth[rd] else f"wrong/none (true rank {ranks[rd]})") for rd in truth}
    print(f"  tol {ts}/{te}: greedy picks on the 3 confirmed rooms: {ok} | rooms given a doctor: {len(pick)} of {len(H)}")

# ---- RULING 189 criterion 1, exactly as ruled: aligned - null >= 2, AND top-3 by z in the room-day, AND exclusivity =
#      not topping ANOTHER room-day in overlapping hours (top = rank 1 by z there with excess >= 2 too)
print("== RULING 189 criterion 1 on 23 Sep (all 9 room-days; the 3 confirmed rooms are the only known truth)")
def aligned_spans(d, rd, ts, te):
    sp = [(a, b) for a, b in cons[d] if edge_ok(a, b, H[rd], ts, te)]
    return (min(a for a, _ in sp), max(b for _, b in sp)) if sp else None
for ts, te in TOLS:
    real = counts(ts, te, 0); nulls = [counts(ts, te, h) for h in SH]; R = {}
    for d, cs in cons.items():
        if len(cs) < 3: continue
        for rd in H:
            nm = statistics.mean(n[d][rd] for n in nulls); R[(d, rd)] = (real[d][rd] - nm, (real[d][rd] - nm) / math.sqrt(len(cs)), real[d][rd], len(cs), nm)
    rank = {}
    for rd in H:
        order = sorted(((v[1], d) for (d, r), v in R.items() if r == rd), reverse=True)
        for i, (_, d) in enumerate(order): rank[(d, rd)] = i + 1
    passed = {}
    for (d, rd), (ex, z, al, n, nm) in R.items():
        if ex < 2 or rank[(d, rd)] > 3: continue
        conflict = False
        for r2 in H:
            if r2 == rd or (d, r2) not in R: continue
            if rank[(d, r2)] == 1 and R[(d, r2)][0] >= 2:
                s1, s2 = aligned_spans(d, rd, ts, te), aligned_spans(d, r2, ts, te)
                if s1 and s2 and s1[0] < s2[1] and s2[0] < s1[1]: conflict = True
        if not conflict: passed[(d, rd)] = (round(ex, 2), rank[(d, rd)], al, n)
    print(f"-- tol {ts}/{te}: {len(passed)} (doctor, room-day) pairs pass criterion 1 out of {len(R)} scored")
    for rd in H:
        ps = sorted(((v[1], d, v) for (d, r), v in passed.items() if r == rd))
        tag = ''
        if rd in truth:
            ok = truth[rd] in [d for _, d, _ in ps]; wrong = [d for _, d, _ in ps if d != truth[rd]]
            tag = f" | CONFIRMED doctor {'PASSES' if ok else 'does NOT pass'}; other passers: {len(wrong)}"
        print(f"   {name[rd][:12]:12} passers {len(ps)}: {[(d[:5], v[0], f'{v[2]}/{v[3]}') for _, d, v in ps]}{tag}")

# ---- STRICTER exclusivity + stability: (a) a doctor who passes (excess >= 2, top-3) in TWO rooms with overlapping aligned hours is
#      dropped from BOTH; (b) a link must survive at >= 2 of the 3 declared tolerances
print("== STRICTER: mutual exclusivity (drop a doctor from every room they pass in at overlapping hours) + stable in >= 2 of 3 tolerances")
per_tol = []
for ts, te in TOLS:
    real = counts(ts, te, 0); nulls = [counts(ts, te, h) for h in SH]; R = {}
    for d, cs in cons.items():
        if len(cs) < 3: continue
        for rd in H:
            nm = statistics.mean(n[d][rd] for n in nulls); R[(d, rd)] = (real[d][rd] - nm, (real[d][rd] - nm) / math.sqrt(len(cs)))
    rank = {}
    for rd in H:
        order = sorted(((v[1], d) for (d, r), v in R.items() if r == rd), reverse=True)
        for i, (_, d) in enumerate(order): rank[(d, rd)] = i + 1
    P = {(d, rd) for (d, rd), (ex, z) in R.items() if ex >= 2 and rank[(d, rd)] <= 3}
    drop = set()
    for (d, rd) in P:
        for (d2, r2) in P:
            if d2 == d and r2 != rd:
                s1, s2 = aligned_spans(d, rd, ts, te), aligned_spans(d, r2, ts, te)
                if s1 and s2 and s1[0] < s2[1] and s2[0] < s1[1]: drop.add((d, rd)); drop.add((d, r2))
    per_tol.append(P - drop)
    print(f"  tol {ts}/{te}: pass-before-exclusivity {len(P)}, dropped as ambiguous {len(drop)}, remaining {len(P - drop)}")
stable = {p for p in set().union(*per_tol) if sum(p in s for s in per_tol) >= 2}
print(f"  STABLE (>= 2 of 3 tolerances, after mutual exclusivity): {len(stable)} pairs")
for rd in H:
    ps = sorted(d[:5] for d, r in stable if r == rd)
    tag = (f" | confirmed doctor {'IN' if truth[rd][:5] in ps else 'NOT in'} the stable set" if rd in truth and truth[rd] else '')
    print(f"   {name[rd][:12]:12} {ps}{tag}")

# ---- PLACEBO: shift every consult by a wrong number of hours, call that "real", null = the usual +-2/3 h around it. Count pairs that pass
#      criterion 1 (excess >= 2, top-3) and survive the mutual exclusivity, at each tolerance. Real run had 5/6/6 (7/11/14 before exclusivity).
print("== PLACEBO (consult times shifted by a wrong number of hours; how many pairs pass by chance?)")
for placebo in (-5, -4, 4, 5):
    row = []
    for ts, te in TOLS:
        real = counts(ts, te, placebo); nulls = [counts(ts, te, placebo + h) for h in SH]; R = {}
        for d, cs in cons.items():
            if len(cs) < 3: continue
            for rd in H:
                nm = statistics.mean(n[d][rd] for n in nulls); R[(d, rd)] = (real[d][rd] - nm, (real[d][rd] - nm) / math.sqrt(len(cs)))
        rank = {}
        for rd in H:
            order = sorted(((v[1], d) for (d, r), v in R.items() if r == rd), reverse=True)
            for i, (_, d) in enumerate(order): rank[(d, rd)] = i + 1
        P = {(d, rd) for (d, rd), (ex, z) in R.items() if ex >= 2 and rank[(d, rd)] <= 3}
        row.append(len(P))
    print(f"  placebo shift {placebo:+d} h: pairs passing criterion 1 (before exclusivity) at tol 180/300, 240/360, 300/480 = {row}")

# ---- RULING 194 readings on 23 Sep: mutual exclusivity + stability (2 of 3 vs ALL 3 declared tolerances) + n >= 5 for HIGH
print("== RULING 194 readings (mutual exclusivity applied per tolerance first)")
nn = {d: len(cs) for d, cs in cons.items()}
def show(label, pairs):
    print(f"  {label}: {len(pairs)} pairs: " + ', '.join(f"{name[rd][:9]}:{d[:5]}(n={nn[d]})" for d, rd in sorted(pairs, key=lambda x: name[x[1]])))
def count_tol(k): return {p for p in set().union(*per_tol) if sum(p in s for s in per_tol) >= k}
show('stable at >= 2 of 3 tolerances', count_tol(2)); show('stable at ALL 3 tolerances    ', count_tol(3))
show('  + n >= 5 (all 3 tolerances)  ', {p for p in count_tol(3) if nn[p[0]] >= 5}); show('  + n >= 5 (>= 2 of 3)         ', {p for p in count_tol(2) if nn[p[0]] >= 5})
kept = {p for p in count_tol(3) if nn[p[0]] >= 5}
print('  confirmed doctors among the strictest set (all 3 tol + n>=5):', [name[rd][:9] for rd in truth if truth[rd] and (truth[rd], rd) in kept] or 'none')
