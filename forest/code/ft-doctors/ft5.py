"""FT5 same-specialty doctor comparison (ft-doctors lane, 19 Oct 2026). D split only; H is never read past the lock lookup.
Episodes: labels.parquet from ft-labels-base when present (LABELS env or default path), else a provisional rebuild with the FT1 rules
(ft1_timing.py / f1_recompute.py: R1/R2/R4, positive episode = (cluster, first event) credited to its earliest flagged Rx;
negative episode = earliest flagged Rx of a cluster with no positive).
H14: matured = consult >= 18 d before READ (14 d + 4 d billing lag, forest-lead ruling 19 Oct); y = event lag <= 14. H90: matured = >= 94 d; y = event lag <= 90.
Writes tables to out/ft-doctors/ (0600). Prints counts only."""
import csv, glob, json, math, os, re, sys, collections, datetime as dt
import numpy as np, pandas as pd
H = os.path.expanduser
FT = H('~/oc/forest-lead/ft'); OUT = f'{FT}/out/ft-doctors'
sys.path.insert(0, FT); import ftio
READ = dt.date(2026, 10, 19)
LABELS = os.environ.get('LABELS', f'{FT}/out/ft-labels-base/labels.parquet')
R1 = re.compile(r'LSCS|caesarean|cesarean|vaginal delivery|\bNVD\b|delivery|cerclage|evacuation|ERPC|RPOC|abortion|products of conception|MTP', re.I)
R2 = re.compile(r'dressing|injection|suture removal|I ?& ?D under LA|wart|foreign body', re.I)
R4 = re.compile(r'stent removal|removal of .*stent|DJ stent|check URS|re-?look|implant removal|second stage', re.I)
nz = lambda v: v not in ('', None, 'None', 'NULL')

# procedure class from the flagged recommendation names (case mix within specialty)
PCLS = [('obstetric', r'delivery|lscs|mtp|caesar|cesar'),
        ('anorectal', r'haemorrh|hemorrh|piles|fissur|fistul|pilonidal|sphincter|perianal|stapler|eua'),
        ('hernia', r'hernia|hernio|inguinal|umbilical|incisional'),
        ('gallbladder', r'cholecyst|gall'),
        ('varicose', r'varicos|evlt|rfa|venous|varicocel'),
        ('arthroplasty', r'total knee|tkr|total hip|thr|arthroplast|replacement'),
        ('arthroscopy', r'arthroscop|acl|menisc|shoulder|rotator|bankart'),
        ('fracture', r'fracture|orif|open reduc|nailing|plating|k-?wire'),
        ('stone_prostate', r'urs|rirs|pcnl|lithot|stone|calcul|turp|holep|prostat|cystoscop|stent'),
        ('hyster_lap_gyn', r'hysterect|tlh|\btah\b|laprosc|myomect|ovari|cystect|hysterosc|laparoscop.*(diag|gyn)|endometri|mirena|polyp'),
        ('ent', r'septo|fess|sinus|tonsil|adenoid|tympan|mastoid|turbin|myring|nasal'),
        ('cardiac', r'coronary|angio|ptca|cag|pacemaker'),
        ('endoscopy', r'endoscop|colonoscop|ogd|ercp'),
        ('minor_excision', r'hydrocel|implant removal|lipoma|sebaceous|cyst|excision|mole|wart|circumcis|frenul|tongue|ingrowing|incision|drainage|i ?& ?d|debride|swelling|biopsy|cauteri|prp|injection'),
        ('lap_other', r'laparoscop|laparotom|appendic')]
PCLS = [(k, re.compile(v, re.I)) for k, v in PCLS]
def pclass(s):
    names = ' | '.join(re.findall(r'"name":\s*"([^"]*)', s or '')) or (s or '')
    if not names.strip(): return 'none'
    for k, rx in PCLS:
        if rx.search(names): return k
    return 'other'

def load_ref():
    spec = {r['doctor_uid']: r['specialty'] for r in csv.DictReader(open(f'{FT}/doctor_specialty.tsv'), delimiter='\t')}
    names = {}
    p = H('~/oc/forest-lead/data/ft1a.tsv')
    if os.path.exists(p):
        names = {r['doctor_uid']: r['doctor_name_with_speciality'] for r in csv.DictReader(open(p), delimiter='\t')}
    return spec, names

def lock_map():
    lock = {}
    for r in csv.reader(open(H('~/eta-data/forest/split/lock-2026-10-18.tsv')), delimiter='\t'):
        if len(r) >= 2 and r[1] in ('H', 'D'): lock[r[0]] = r[1]
    return lock

def provisional():
    pk = {r['prescription_uid']: r['patient_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split-input/10.tsv')), delimiter='\t')}
    cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')), delimiter='\t')}
    rows = {}
    for f in sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv'))):
        for r in ftio.read_export(f): rows.setdefault(r['prescription_uid'], r)
    out = []
    for r in rows.values():
        d = dt.date.fromisoformat(r['consult_ist'][:10])
        if d < dt.date(2025, 12, 1): continue
        k = pk.get(r['prescription_uid'])
        if not k: continue
        ds = [r[x] for x in ('first_ot_date', 'first_bill_date') if nz(r[x])]
        ev = min(ds)[:10] if ds else None
        name = (r['first_surgery_name'] or '') + ' | ' + (r['first_bill_items'] or ''); ex = None
        if ev:
            if R1.search(name) or r['first_adm_type'] == 'Maternity': ex = 'R1'
            elif R4.search(name): ex = 'R4'
            elif R2.search(r['first_surgery_name'] or '') or (r['first_bill_date'][:10] == r['consult_ist'][:10] if nz(r['first_bill_date']) else False) and not nz(r['first_ot_date']) and (r['first_adm_date'] or '')[:10] != r['consult_ist'][:10]: ex = 'R2'
        out.append(dict(prescription_uid=r['prescription_uid'], consult_uid=r['consult_uid'], doctor_uid=r['doctor_uid'], d=d,
                        ev=ev if not ex else None, cluster_key=cl.get(k, k), proc=r['flag_proc_names']))
    pos = {}
    for o in sorted(out, key=lambda o: (o['d'], o['prescription_uid'])):
        if o['ev']: pos.setdefault((o['cluster_key'], o['ev']), o)
    poscl = {k[0] for k in pos}
    neg = {}
    for o in sorted(out, key=lambda o: (o['d'], o['prescription_uid'])):
        if o['cluster_key'] not in poscl: neg.setdefault(o['cluster_key'], o)
    eps = []
    for o in list(pos.values()) + list(neg.values()):
        lag = (dt.date.fromisoformat(o['ev']) - o['d']).days if o['ev'] else None
        eps.append(dict(o, lag=lag))
    df = pd.DataFrame(eps)
    df['src'] = 'provisional-ft1-rules'
    return df

def from_labels(p):
    df = pd.read_parquet(p)
    o = pd.DataFrame(dict(prescription_uid=df.prescription_uid, consult_uid=df.consult_uid, doctor_uid=df.doctor_id,
                          d=pd.to_datetime(df.rx_date).dt.date, cluster_key=df.cluster_key, split=df.split, lag=df.days_to_surgery,
                          h14=df.h14, h90=df.h90, anchor_excl=df.anchor_excl))
    proc = {}
    for f in sorted(glob.glob(H('~/wt/forest-funnel-join/.bc/out/f1-s5-*.tsv'))):
        for r in ftio.read_export(f): proc.setdefault(r['prescription_uid'], r['flag_proc_names'])
    o['proc'] = o.prescription_uid.map(proc)
    o['src'] = 'labels.parquet'
    return o

def wilson(k, n, z=1.96):
    if n == 0: return (float('nan'),) * 2
    p = k / n; den = 1 + z * z / n; c = (p + z * z / (2 * n)) / den; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return max(0.0, c - h), min(1.0, c + h)

def episodes():
    spec, names = load_ref(); lock = lock_map()
    df = from_labels(LABELS) if os.path.exists(LABELS) else provisional()
    if 'split' not in df: df['split'] = df['cluster_key'].map(lambda c: lock.get(c, '?'))
    nsplit = df['split'].value_counts().to_dict()
    df = df[df['split'] == 'D'].copy()          # H sealed: dropped before anything else is computed
    df['el'] = df['d'].map(lambda d: (READ - d).days)
    df['specialty'] = df['doctor_uid'].map(lambda u: spec.get(u, 'unknown'))
    df['pclass'] = df['proc'].map(pclass) if 'proc' in df else 'none'
    if 'h14' in df:   # labels.parquet: NaN = not matured
        df['m14'] = df['h14'].notna(); df['m90'] = df['h90'].notna()
    else:
        df['m14'] = df['el'] >= 18; df['m90'] = df['el'] >= 94
        df['h14'] = df['lag'].notna() & (df['lag'] <= 14); df['h90'] = df['lag'].notna() & (df['lag'] <= 90)
    df['h14'] = df['h14'].fillna(0).astype(bool); df['h90'] = df['h90'].fillna(0).astype(bool)
    df['quarter'] = df['d'].map(lambda d: f'{d.year}Q{(d.month - 1) // 3 + 1}')
    cm = H('~/oc/forest-lead/data/ft5a.tsv')
    if os.path.exists(cm):
        c = pd.read_csv(cm, sep='\t', dtype=str)
        c['age_y'] = pd.to_numeric(c['age_y'], errors='coerce')
        df = df.merge(c, on='prescription_uid', how='left')
    sv = H('~/oc/forest-lead/data/ft3b.tsv')   # severity proxies (FT3): ICD count + investigations, with missing flags
    if os.path.exists(sv):
        c = pd.read_csv(sv, sep='\t', dtype=str)[['prescription_uid', 'dx_icd', 'num_investigations']]
        c['n_icd'] = c['dx_icd'].fillna('').map(lambda v: len([x for x in re.split(r'[|,;]', v) if x.strip()]))
        c['icd_missing'] = (c['n_icd'] == 0).astype(int)
        c['n_inv'] = pd.to_numeric(c['num_investigations'], errors='coerce')
        c['inv_missing'] = c['n_inv'].isna().astype(int); c['n_inv'] = c['n_inv'].fillna(0).clip(0, 5)
        df = df.merge(c[['prescription_uid', 'n_icd', 'icd_missing', 'n_inv', 'inv_missing']], on='prescription_uid', how='left')
    return df, names, nsplit

if __name__ == '__main__':
    df, names, nsplit = episodes()
    print('source', df['src'].iloc[0], 'split counts (episodes)', nsplit)
    print('D episodes', len(df), 'm14', int(df.m14.sum()), 'h14 pos', int(df[df.m14].h14.sum()), 'm90', int(df.m90.sum()), 'h90 pos', int(df[df.m90].h90.sum()))
    df.to_pickle(f'{OUT}/episodes_D.pkl'); os.chmod(f'{OUT}/episodes_D.pkl', 0o600)
