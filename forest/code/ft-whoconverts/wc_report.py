# ft-whoconverts: desc.json + perm_*.json + logit_*.json -> WHO-CONVERTS.md tables (the summary block is written by hand from these tables).
import os, sys, json, hashlib, datetime as dt
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
from wc_names import plain

OUT = os.path.expanduser('~/oc/forest-lead/ft/out/ft-whoconverts'); CODE = os.path.dirname(os.path.abspath(__file__))
FR = os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest')


def sha12(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:12]
def pc(x): return '-' if x is None or (isinstance(x, float) and np.isnan(x)) else f'{100 * x:.0f}%'
def ci(r): return f"{pc(r['rate'])} [{100 * r['lo']:.0f}-{100 * r['hi']:.0f}]"
def qf(q): return '' if q is None or np.isnan(q) else (f'**{q:.3f}** ⚑' if q < 0.10 else f'{q:.2f}')
def orf(r): return '' if np.isnan(r.get('or_mh', np.nan)) else f"{r['or_mh']:.2f} [{r['or_lo']:.2f}-{r['or_hi']:.2f}]"


def main():
    d = json.load(open(f'{OUT}/desc.json')); R = {lab: pd.DataFrame(d['res'][lab]['rows']) for lab in d['res']}
    for lab, df in R.items(): df['key'] = df['char'] + '|' + df['sub'] + '|' + df['level']
    h = R['h14']; sec = {lab: R[lab].set_index('key') for lab in ('h90', 'ale')}
    def secf(r, lab):
        s = sec[lab]
        if r['key'] not in s.index: return '-'
        x = s.loc[r['key']]; return f"{pc(x['rate'])} ({x['n']})" + (' ⚑' if x['q'] < 0.10 else '')
    def flagged_any(r): return (r['q'] < 0.10) or any(r['key'] in sec[l].index and sec[l].loc[r['key'], 'q'] < 0.10 for l in sec)
    L = []; A = L.append
    res = d['res']; t = res['h14']
    A('## 1. Patient, visit, doctor and process (design A rows; h14 primary)')
    A(f"Rows: every D episode with a final label: h14 n = {t['n']} ({t['pos']} converted), h90 n = {res['h90']['n']} ({res['h90']['pos']}), "
      f"Ale n = {res['ale']['n']} ({res['ale']['pos']}). ⚑ = BH q < 0.10 within that outcome. Levels not flagged for any outcome are folded into one line.")
    A('')
    A('| Characteristic | Level | n | h14 conv [95% CI] | h14 q | OR within specialty [95% CI] | h90 (n) | Ale (n) |')
    A('|---|---|---|---|---|---|---|---|')
    def block(df):
        for ch, g in df.groupby('char', sort=False):
            show = g[g.apply(flagged_any, axis=1) | (len(g) <= 2)]
            for _, r in show.iterrows():
                A(f"| {ch} | {r['level']} | {r['n']} | {ci(r) if not np.isnan(r['lo']) else pc(r['rate'])} | {qf(r['q'])} | {orf(r)} | {secf(r, 'h90')} | {secf(r, 'ale')} |")
            rest = g.drop(show.index)
            if len(rest):
                A(f"| {ch} | " + ('other levels' if len(show) else 'all levels') + ': ' +
                  '; '.join(f"{x['level']} {pc(x['rate'])} ({x['n']})" for _, x in rest.iterrows()) + ' | | | none < 0.10 | | | |')
    block(h[(h.cohort == 'A') & h.family.isin(['patient', 'visit', 'doctor', 'process'])])
    A('Doctor gender q and OR are episode-level. Only General Surgery (1 female, 6 male doctors) and Gynaecology (10 female, 1 male) mix genders. '
      'Shuffling gender across doctors within specialty gives p = 0.40 (refute r2), so the gap cannot be told apart from individual-doctor differences. '
      '"Procedures advised 0" (= procedure group "none") and "Z1" (near-complement of "no pincode") are shown but not tested.')
    A('')
    A(f"### 1b. Counsellor calls before day 7 (design B day-7 rows: Rx from 1 Jan 2026, not converted by day 7; h14 n = {t['n_lm7']}, "
      f"{t['pos_lm7']} converted on days 8-14)")
    A("Caution: 19 of the 42 converters (45%) vs 109 of 884 non-converters (12%) had a call before day 7 that was flagged outcome-revealing and is "
      "dropped here (ft-refute-whoconverts r3_calls). Counsellors often already knew. Read these rows as partly reverse-driven. "
      "Levels marked 'untested' repeat another row's split.")
    A('| Characteristic | Level | n | h14 conv [95% CI] | h14 q | OR within specialty [95% CI] | h90 (n) | Ale (n) |')
    A('|---|---|---|---|---|---|---|---|')
    hb = h[h.cohort == 'lm7']
    for _, r in hb.iterrows():
        A(f"| {r['char']} | {r['level']} | {r['n']} | {ci(r)} | {qf(r['q']) or ('untested' if r['level'] in ('no call', '0') and r['char'] != 'Counsellor calls before day 7' else '')} | {orf(r)} | {secf(r, 'h90')} | {secf(r, 'ale')} |")
    A('')
    doc = h[h.family == 'doctor'].iloc[-1]; G = pd.read_csv(f'{OUT}/doctors_h14.csv')
    big = G[G.n >= 30]
    A(f"### 1c. Doctors (h14; {len(G)} doctors, labels D1..D{len(G)} by volume; shrunk = (k + 10 x specialty rate) / (n + 10))")
    A(f"Doctor spread within specialty: permutation test p = {doc['p']:.4f}, q = {doc['q']:.3f}{' ⚑' if doc['q'] < 0.10 else ''}. "
      f"Among the {int((G.n >= 10).sum())} doctors with n >= 10, shrunk rates run {pc(G[G.n >= 10].shrunk.min())} to {pc(G[G.n >= 10].shrunk.max())}; "
      f"{int((G.n < 10).sum())} doctors have under 10 episodes. Doctors with n >= 30:")
    A('| Doctor | Specialty | n | Converted | Raw | Shrunk | Specialty rate |')
    A('|---|---|---|---|---|---|---|')
    for _, r in big.iterrows():
        A(f"| {r['label']} | {r['spec']} | {r['n']} | {r['k']} | {pc(r['raw'])} | {pc(r['shrunk'])} | {pc(r['spec_rate'])} |")
    A('Full list (anonymised): doctors_h14.csv, doctors_h90.csv, doctors_ale.csv.')
    A('')
    # 2. permutation
    P = {k: json.load(open(f'{OUT}/perm_{k}_h14.json')) for k in ('rx', 'lm7')}
    A('## 2. Single inputs that matter most inside the frozen FULL forests (h14)')
    for k, nm in (('rx', 'A (at the advice), M2'), ('lm7', 'B (day 7), FULL')):
        p = P[k]; A(f"- Design {nm}: n = {p['n']} ({p['pos']} pos), frozen AUC {p['frozen_auc'][0]:.3f}; {len(p['perm'])} inputs; refit scores match the frozen OOF to "
                    f"{p['max_abs_diff_vs_frozen_oof']:.0e}. {len(p['reps']) * 5} held-out folds x {p['n_perm']} shuffles = {len(p['reps']) * 5 * p['n_perm']} draws per input.")
    A('- Drop = mean AUC loss when that one input is shuffled in the held-out fold (x 1000, so 10 = 0.010 AUC); [2.5-97.5%] of the draws; '
      'cover = share of rows with a value. Correlated inputs share credit; an interval crossing 0 means no clear use.')
    A('')
    A('| # | Design A input (layer) | Drop [2.5-97.5] | Cover | Design B day-7 input (layer) | Drop [2.5-97.5] | Cover |')
    A('|---|---|---|---|---|---|---|')
    tops = {k: sorted(P[k]['perm'].items(), key=lambda kv: -kv[1]['mean'])[:30] for k in P}
    for i in range(30):
        cells = []
        for k in ('rx', 'lm7'):
            c, v = tops[k][i]
            cells += [f"{plain(c)} ({P[k]['layer_of'][c]})", f"{1000 * v['mean']:.1f} [{1000 * v['lo']:.0f}, {1000 * v['hi']:.0f}]", pc(P[k]['coverage'][c])]
        A(f'| {i + 1} | ' + ' | '.join(cells) + ' |')
    A('')
    # 3. logistic
    A('## 3. Readable comparison: L2 logistic regression (Pulse baseline + top 10 non-baseline inputs from section 2)')
    for k, nm in (('rx', 'A'), ('lm7', 'B day 7')):
        g = json.load(open(f'{OUT}/logit_{k}_h14.json')); dl = g['delta_logit_minus_forest']
        A(f"- Design {nm}: logistic OOF AUC {g['auc_logit'][0]:.3f} [{g['auc_logit'][1]:.3f}-{g['auc_logit'][2]:.3f}] vs frozen forest "
          f"{g['auc_forest'][0]:.3f}; logistic - forest {dl['delta']:+.3f} [{dl['ci'][0]:+.3f}, {dl['ci'][1]:+.3f}] (same rows and folds).")
        g0 = json.load(open(f'{OUT}/logit_{k}_h14_top0.json')); d0 = g0['delta_logit_minus_forest']
        A(f"  Pulse baseline alone: {g0['auc_logit'][0]:.3f} (vs this forest {d0['delta']:+.3f} [{d0['ci'][0]:+.3f}, {d0['ci'][1]:+.3f}]). The top 10 were picked on these same D folds, "
          "so the '+ top 10' AUC is optimistic.")
        if k == 'rx':
            m0 = json.load(open(f'{FR}/model_frozen_rx_h14.json'))[0]['auc']['M0']['auc']
            A(f"  Like for like: the frozen Pulse-only forest M0 scores {m0[0]:.3f}, so the logistic regression and the forest are level on the Pulse baseline; M2 is below M0.")
    A('- OR > 1 = more likely to convert. Per 1 SD for counts and scores, yes vs no for 0/1 inputs, vs the most common level for categories; '
      'L2-penalised, so pulled towards 1. Shown: the 10 added inputs, plus baseline inputs whose interval excludes 1.')
    A('')
    A('| Design | Added input | OR per SD or yes vs no [95% CI] | Direction | Missing vs present OR (if any) |')
    A('|---|---|---|---|---|')
    def dirn(o):
        clear = o['lo'] > 1 or o['hi'] < 1; return ('more likely' if o['OR'] > 1 else 'less likely') + ('' if clear else ' (unclear)')
    base_clear = {}
    for k, nm in (('rx', 'A'), ('lm7', 'B7')):
        g = json.load(open(f'{OUT}/logit_{k}_h14.json')); by = {}
        for o in g['ors']: by.setdefault(o['col'], []).append(o)
        for c in g['top10']:
            m = [o for o in by[c] if o['contrast'] != 'missing vs present'][0]; mm = [o for o in by[c] if o['contrast'] == 'missing vs present']
            ms = f"{mm[0]['OR']:.2f} [{mm[0]['lo']:.2f}-{mm[0]['hi']:.2f}]" if mm else ''
            A(f"| {nm} | {m['input']} | {m['OR']:.2f} [{m['lo']:.2f}-{m['hi']:.2f}] | {dirn(m)} | {ms} |")
        base_clear[nm] = [o for o in g['ors'] if not o['top10'] and (o['lo'] > 1 or o['hi'] < 1)]
    for nm, os_ in base_clear.items():
        A(f"- Pulse baseline inputs with intervals clear of 1, design {nm}: " + '; '.join(
            f"{o['input']}{'' if o['contrast'] in ('per SD', 'yes vs no') else ' ' + o['contrast']} {o['OR']:.2f}" for o in os_) + '.')
    A('- The added inputs were chosen on these same data, so their "clear" ORs are post-selection and not confirmatory. "Day of first call" is -1 when there was no call, '
      'so its OR mixes "called at all" with timing. Intervals for sparse levels (for example a specialty with 0 conversions) mostly reflect the penalty, not the data.')
    A('Full OR lists: logit_rx_h14.json, logit_lm7_h14.json.')
    A('')
    # 4. history
    rt = res['h14']
    A(f"## 4. Medical history blocks (design A rows, h14; returning = an earlier Even Rx before the advice day, n = {rt['n_returning']}, {rt['pos_returning']} converted)")
    A('| History block | All: present n | present conv | absent conv | q | OR within specialty | Returning: present n | present conv | absent conv | q |')
    A('|---|---|---|---|---|---|---|---|---|---|')
    hh = h[h.family == 'history']
    for blk, g in hh.groupby('char', sort=False):
        a = g[g['sub'] == '']; r_ = g[g['sub'] != '']
        def get(df, lv): x = df[df.level == lv]; return x.iloc[0] if len(x) else None
        ap, aa, rp, ra = get(a, 'present'), get(a, 'absent'), get(r_, 'present'), get(r_, 'absent')
        tq = lambda df: qf(df[~df.p.isna()].q.iloc[0]) if (~df.p.isna()).any() else 'n < 10'
        def tor(df):
            if not (~df.p.isna()).any(): return ''
            x = df[~df.p.isna()].iloc[0]
            if x.level == 'absent' and not np.isnan(x.or_mh): x = dict(or_mh=1 / x.or_mh, or_lo=1 / x.or_hi, or_hi=1 / x.or_lo)
            return orf(x)
        A(f"| {blk} | {ap['n'] if ap is not None else 0} | {ci(ap) if ap is not None else '-'} | {ci(aa) if aa is not None else '-'} | {tq(a)} | "
          f"{tor(a)} | {rp['n'] if rp is not None else 0} | {pc(rp['rate']) if rp is not None else '-'} | {pc(ra['rate']) if ra is not None else '-'} | {tq(r_)} |")
    A('OR within specialty = Mantel-Haenszel odds ratio, present vs absent, stratified by specialty: < 1 = less conversion when the block is present.')
    return '\n'.join(L)


def sha_block():
    code = sorted(f for f in os.listdir(CODE) if f.endswith(('.py', '.md', '.sh')))
    outs = sorted(f for f in os.listdir(OUT) if f.endswith(('.json', '.csv', '.tsv', '.log')))
    d = json.load(open(f'{OUT}/desc.json'))['inputs']
    fr = {f'ft-forest/{f}': f'{FR}/{f}' for f in ('model_frozen_rx_h14.json', 'model_frozen_lm7_h14.json', 'FOREST-TABLES.md')}
    fc = {f'ft-forest code {f}': os.path.expanduser(f'~/wt/ft-forest/code/{f}') for f in ('forest_lib.py', 'forest_build.py')}
    L = ['## Files (sha256, first 12)',
         '- Inputs: ' + '; '.join(f'{k} {v}' for k, v in d.items()) + '; ' + '; '.join(f'{k} {sha12(v)}' for k, v in {**fr, **fc}.items())
         + '. Design B call layers, engines and layer 8 are loaded through forest_build exactly as frozen (its DONE.md lists their sha).',
         f'- Code ({CODE}): ' + '; '.join(f'{f} {sha12(os.path.join(CODE, f))}' for f in code) + '.',
         f'- Outputs ({OUT}, 0600): ' + '; '.join(f'{f} {sha12(os.path.join(OUT, f))}' for f in outs) + '.',
         '- Run: wc_perm.py rx h14; wc_perm.py lm7 h14; wc_desc.py; wc_logit.py rx|lm7 h14 (and TOPK=0); wc_report.py. Python ~/.venv-forest, -I.']
    return '\n'.join(L)


def write():
    txt = open(os.path.join(CODE, 'wc_text.md')).read(); head, lim = txt.split('<!--LIMITS-->'); head = head.replace('<!--HEAD-->\n', '')
    r = json.load(open(f'{OUT}/desc.json'))['res']
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).strftime('%d %b %Y %H:%M IST')
    head = head.format(now=now, t14=r['h14']['n_tests'], f14=r['h14']['n_flag'], t90=r['h90']['n_tests'], f90=r['h90']['n_flag'],
                       tale=r['ale']['n_tests'], fale=r['ale']['n_flag'])
    doc = head.rstrip() + '\n\n' + main() + '\n\n' + lim.strip() + '\n\n' + sha_block() + '\n'
    p = f'{OUT}/WHO-CONVERTS.md'
    with os.fdopen(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as fh: fh.write(doc)
    print(p, len(doc.splitlines()), 'lines', sha12(p))


if __name__ == '__main__':
    write()
