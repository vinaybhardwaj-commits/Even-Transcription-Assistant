"""ft-engines set B: per-consult speaker windows (patient-side and doctor) from the REB store, reusing ft-audio's audio_feats.py (roles llm-roles > text-judge >
sarvam-doctor-map on Sarvam speakers, carried to Nemotron-3 diar segments by overlap). Patient windows are ft-audio's exactly (so its Odyssey rows are reused);
doctor windows are built the same way (doctor segments minus >0.2 s patient-side overlap, 8 s windows), capped at 48 per consult, evenly spaced.
Usage: winB.py <base.parquet> <audio_feats.py> <out windows.jsonl> [exclude base.parquet]   D split only. Ids/times only.
The extension to the FT4 Ale cohort uses ft-cohortb-expand's audio_feats.py (tape-cut audio fallback, caa roles); doctor windows only where Nemotron diar exists."""
import sys, json, os
import numpy as np, pandas as pd
src = open(sys.argv[2]).read().split("if __name__")[0]
ns = {}; exec(src, ns)
MAX_DOC = 48


def doctor_windows(r):
    d = ns['reb_dir'](r)
    t = d + '/tracks'; man = json.load(open(d + '/manifest.json')); T0 = man['t0_ms']
    stt = ns['newest'](f'{t}/stt.sarvam-saaras*'); dia = ns['newest'](f'{t}/diar.nemotron__*')
    rmap, src_ = ns['roles_map'](t)
    if not dia or dia.get('status') != 'ok' or src_ == 'none': return []
    rs = [((s['t0_ms'] - T0) / 1000, (s['t1_ms'] - T0) / 1000, rmap.get(str(s['speaker']))) for s in (stt or {}).get('segments') or []]
    nsg = [((s['t0_ms'] - T0) / 1000, (s['t1_ms'] - T0) / 1000, s['speaker']) for s in dia['segments']]
    import collections
    acc = collections.defaultdict(collections.Counter)
    for a, b, sp in nsg:
        for c, e, ro in rs:
            if ro and e > a and c < b: acc[sp][ro] += ns['ov'](a, b, c, e)
    nrole = {sp: (c.most_common(1)[0][0] if c else None) for sp, c in acc.items()}
    seg = [(a, b, nrole.get(sp)) for a, b, sp in nsg]
    oth = [(a, b) for a, b, ro in seg if ro in ns['SIDE']]
    cand = []
    for a, b, ro in seg:
        if ro != 'doctor' or b - a < ns['MIN_SEG_S']: continue
        if any(ns['ov'](a, b, c, e) > 0.2 for c, e in oth): continue
        x = a
        while b - x >= ns['MIN_SEG_S']:
            y = min(b, x + ns['WIN_S']); cand.append((round(x, 3), round(y, 3))); x = y
    if len(cand) > MAX_DOC: cand = [cand[i] for i in np.linspace(0, len(cand) - 1, MAX_DOC).astype(int)]
    return [dict(consult_uid=r.consult_uid, t0=a, t1=b, who='doctor') for a, b in cand]


if __name__ == '__main__':
    base = pd.read_parquet(sys.argv[1]); base = base[base.split == 'D']
    if len(sys.argv) > 4: base = base[~base.consult_uid.isin(pd.read_parquet(sys.argv[4]).consult_uid)]
    W, nf = [], 0
    for r in base.itertuples():
        p = ns['audio_path'](r)
        if p is None: nf += 1; continue
        try: f, pw = ns['one'](r)
        except Exception as e: print('err', type(e).__name__); continue
        try: dw = doctor_windows(r)
        except Exception as e: print('doc err', type(e).__name__); dw = []
        for w in pw + dw: w['item'] = r.consult_uid; w['path'] = p; W.append(w)
    with open(sys.argv[3], 'w', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
        for w in W: fh.write(json.dumps(w) + '\n')
    import collections
    print('consults', len(base), 'no_audio', nf, 'windows', len(W), collections.Counter(w['who'] for w in W), 'items', len({w['item'] for w in W}))
