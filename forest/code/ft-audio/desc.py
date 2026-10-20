# ft-audio FT4 v2 DESCRIPTIVE (small-n safe): converters vs non-converters per audio/pitch feature (median [IQR], Mann-Whitney p, Cliff's delta),
# Jev items at >= 0.5 (yes share, Fisher exact p, odds ratio), language mix, and PHI-masked doctor quotes for f07/f18 (QUOTES.md, admin-only, never bus).
# usage: desc.py <features_ale.parquet> <label col> <out_md> [quotes_md] [min_age_days]
import sys, os, re, glob, json
import numpy as np, pandas as pd
from scipy.stats import mannwhitneyu, fisher_exact
H = os.path.expanduser
sys.path.insert(0, H('~/dev/eta-fs-run')); from tools.timbre.phi_mask import mask_phi
src = open(H('~/wt/ft-audio/code/audio_feats.py')).read().split("if __name__")[0]; AF = {}; exec(src, AF)
CONT = [('doc_talk_share', 'doctor talk-time share'), ('patient_talk_share', 'patient talk-time share'), ('turns_per_min', 'turn changes / min'),
        ('doc_interrupt_per_min', 'doctor interruptions / min'), ('pat_interrupt_per_min', 'patient-side interruptions / min'), ('mean_patient_turn_s', 'mean patient turn (s)'),
        ('pat_valence', 'patient valence (Odyssey 0-1)'), ('pat_arousal', 'patient arousal (Odyssey 0-1)'), ('val_change', 'valence change post-pre rec.'),
        ('aro_change', 'arousal change post-pre rec.'), ('consult_min', 'consult length (min)'), ('speech_min', 'speech (min)'), ('rec_t_s', 'time to first surgery mention (s)'),
        ('lang_en_share', 'English share of speech'), ('jev_pitch_score', 'Jev pitch score f03/f07/f18'), ('jev_pitch_nof07', 'Jev pitch score f03/f18 (no f07)'),
        ('doc_prior_rate', 'doctor prior H14 rate'), ('age_y', 'age (y)')]
JEV = [('jev_f02', 'f02 urgency / timeframe <= 1 month'), ('jev_f03', 'f03 specific procedure named'), ('jev_f05', 'f05 harm of delay described'),
       ('jev_f06', 'f06 practical detail (how, anaesthesia, stay, recovery)'), ('jev_f07', 'f07 date/slot or booking step (LEAKAGE-suspect)'), ('jev_f18', 'f18 cost discussed')]
QRE = {'jev_f07': re.compile(r"\b(tomorrow|day after|monday|tuesday|wednesday|thursday|friday|saturday|sunday|date|admit\w*|admission|slot|OT|book\w*|counsel\w*|coordinator|schedul\w*|fix\w*|appointment|call)\b", re.I),
       'jev_f18': re.compile(r"\b(cost\w*|rupee\w*|rs\.?|lakh\w*|thousand|package|insurance|charges?|price|expense\w*|amount|pay\w*|bill\w*|cashless|claim)\b", re.I)}


def q(x): return f'{np.median(x):.2f} [{np.percentile(x, 25):.2f}-{np.percentile(x, 75):.2f}]' if len(x) else '-'


def cliff(a, b):
    a, b = np.asarray(a), np.asarray(b)
    return float(((a[:, None] > b[None, :]).sum() - (a[:, None] < b[None, :]).sum()) / (len(a) * len(b))) if len(a) and len(b) else np.nan


def quotes(r, qid, k=2):
    d = AF['reb_dir'](r)
    if not d: return []
    t = d + '/tracks'; man = json.load(open(d + '/manifest.json')); rmap, rsrc = AF['roles_map'](t)
    en = AF['newest'](f'{t}/translate.sarvam-saaras*') or AF['newest'](f'{t}/translate.sarvam-mayura*')
    segs = (en or {}).get('segments') if en and en.get('status') == 'ok' else None
    if not segs:
        stt = AF['newest'](f'{t}/stt.sarvam-saaras*'); segs = [s for s in (stt or {}).get('segments') or [] if (s.get('lang') or '').startswith('en')]
    out = []
    for s in sorted(segs or [], key=lambda s: s['t0_ms']):
        ro = rmap.get(str(s.get('speaker')))
        if ro not in ('doctor', None) and rsrc != 'none': continue
        tx = s.get('text') or ''
        if QRE[qid].search(tx) and len(tx) > 25:
            m = mask_phi(tx[:220]).text
            out.append(f'{int((s["t0_ms"] - man["t0_ms"]) / 1000)} s: "{m}"')
    return out[:k]


if __name__ == '__main__':
    path, lab, outp = sys.argv[1:4]; qpath = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != '-' else None
    min_age = int(sys.argv[5]) if len(sys.argv) > 5 else None
    d = pd.read_parquet(path); d = d[d[lab].notna()]
    if min_age is not None: d = d[d.age_days >= min_age]
    if 'jev_pitch_nof07' not in d: d['jev_pitch_nof07'] = d[['jev_f03', 'jev_f18']].mean(axis=1)
    c, n = d[d[lab] == 1], d[d[lab] == 0]
    L = [f'Label {lab}' + (f', age >= {min_age} d' if min_age else '') + f': n {len(d)} ({d.cluster_key.nunique()} patients, {d.doctor_uid.nunique()} doctors), converters {len(c)}, non-converters {len(n)}. D split. DIRECTIONAL; p values are unadjusted (about 24 tests): read them as screening only.', '',
         '### Audio and pitch features: converters vs non-converters', '', '| feature | n conv / non | converters median [IQR] | non-converters median [IQR] | Mann-Whitney p | Cliff delta (conv > non) |', '|---|---|---|---|---|---|']
    for col, name in CONT:
        if col not in d: continue
        a, b = c[col].dropna().values, n[col].dropna().values
        p = mannwhitneyu(a, b, alternative='two-sided').pvalue if len(a) >= 2 and len(b) >= 2 else np.nan
        L.append(f'| {name} | {len(a)} / {len(b)} | {q(a)} | {q(b)} | {p:.3f} | {cliff(a, b):+.2f} |')
    L += ['', '### Jev pitch elements (yes = Jev p >= 0.5)', '', '| element | converters yes | non-converters yes | Fisher exact p | odds ratio |', '|---|---|---|---|---|']
    for col, name in JEV:
        a, b = c[col].dropna(), n[col].dropna()
        ya, yb = int((a >= 0.5).sum()), int((b >= 0.5).sum())
        orr, p = fisher_exact([[ya, len(a) - ya], [yb, len(b) - yb]])
        L.append(f'| {name} | {ya}/{len(a)} ({ya / max(len(a), 1):.0%}) | {yb}/{len(b)} ({yb / max(len(b), 1):.0%}) | {p:.3f} | {orr:.2f} |')
    L += ['', '### Language mix', '', '| consult language | n | converters | rate |', '|---|---|---|---|']
    lg = d.consult_lang.fillna('none')
    for k, g in d.groupby(lg):
        L.append(f'| {k} | {len(g)} | {int(g[lab].sum())} | {g[lab].mean():.0%} |')
    en = d[d.consult_lang == 'en-IN']; ne = d[d.consult_lang.notna() & (d.consult_lang != 'en-IN')]
    orr, p = fisher_exact([[int(en[lab].sum()), len(en) - int(en[lab].sum())], [int(ne[lab].sum()), len(ne) - int(ne[lab].sum())]])
    L.append(f'\nEnglish vs non-English: {int(en[lab].sum())}/{len(en)} vs {int(ne[lab].sum())}/{len(ne)}, Fisher p {p:.3f}, OR {orr:.2f}.')
    gs = d[d.specialty == 'General Surgery']
    if len(gs) and gs[lab].sum():
        L += ['', f'### Inside General Surgery only (n {len(gs)}, converters {int(gs[lab].sum())}; removes the specialty confound)', '', '| feature | converters median | non-converters median | Mann-Whitney p | Cliff delta |', '|---|---|---|---|---|']
        gc, gn = gs[gs[lab] == 1], gs[gs[lab] == 0]
        for col, name in CONT[:10] + JEV:
            a, b = gc[col].dropna().values, gn[col].dropna().values
            p = mannwhitneyu(a, b).pvalue if len(a) >= 2 and len(b) >= 2 else np.nan
            L.append(f'| {name} | {np.median(a) if len(a) else np.nan:.2f} | {np.median(b) if len(b) else np.nan:.2f} | {p:.3f} | {cliff(a, b):+.2f} |')
    open(outp, 'w').write('\n'.join(L) + '\n'); os.chmod(outp, 0o600); print('\n'.join(L))
    if qpath:
        Q = ['# FT4 quotes for Jev f07 / f18 (ft-audio). ADMIN-ONLY, the lab box only, never on the bus. Doctor speech, English (Sarvam translate or English STT), PHI-masked (timbre phi_mask).',
             f'Label {lab}. Top 5 consults per group by Jev p; up to 2 keyword-matching doctor segments each; time = seconds into the consult.', '']
        for qid, nm in (('jev_f07', 'f07 date/slot or booking step'), ('jev_f18', 'f18 cost discussed')):
            for grp, g in (('CONVERTERS', c), ('NON-CONVERTERS', n)):
                Q += [f'## {nm}: {grp} (Jev >= 0.5: {int((g[qid] >= 0.5).sum())}/{int(g[qid].notna().sum())})', '']
                for r in g[g[qid] >= 0.5].sort_values(qid, ascending=False).head(5).itertuples():
                    qs = quotes(r, qid)
                    Q.append(f'- consult {r.consult_uid} ({r.specialty}, {r.consult_lang}, Jev {getattr(r, qid):.2f})' + ('' if qs else ': no keyword segment found'))
                    Q += [f'  - {x}' for x in qs]
                Q.append('')
        open(qpath, 'w').write('\n'.join(Q) + '\n'); os.chmod(qpath, 0o600); print('quotes ->', qpath)
