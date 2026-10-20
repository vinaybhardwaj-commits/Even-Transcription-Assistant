# Markdown tables from ftc_model.py v2 result files. Usage: ftc_table.py <glob> ...  (counts and AUCs only)
import glob, json, sys
R = [r for p in sys.argv[1:] for f in sorted(glob.glob(p)) for r in json.load(open(f))]
order = {'lm3': 0, 'lm7': 1, 'asis': 2, 'matched': 3}
f3 = lambda t: f'{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]'
models = [m for m in ('base', 'text', 'text_audio', 'audio', 'text_only') if any(m in r['auc'] for r in R)]
deltas = sorted({k for r in R for k in r['delta']}, key=lambda k: ['text-base', 'text_audio-text', 'text_audio-base', 'audio-base'].index(k))
print('| label | cohort | design | payer | n | pos | window call | tagged call | ' + ('audio | ' if 'text_audio' in models else '')
      + ' | '.join(f'{m} AUC' for m in models) + ' | ' + ' | '.join(f'Δ {k} [CI]; P(Δ≤0) boot / repeats' for k in deltas) + ' |')
print('|---' * (8 + ('text_audio' in models) + len(models) + len(deltas)) + '|')
for r in sorted(R, key=lambda r: (r['lab'], r['cohort'], order[r['design']], r['payer'])):
    row = [r['lab'], r['cohort'], r['design'] + (' (leaky)' if r['design'] == 'asis' else ''), 'yes' if r['payer'] else 'no', r['n'], r['pos'],
           r['with_window_call'], r['with_tagged_call']] + ([r.get('with_audio', '-')] if 'text_audio' in models else [])
    row += [f3(r['auc'][m]['auc']) if m in r['auc'] else '-' for m in models]
    for k in deltas:
        d = r['delta'].get(k)
        row.append(f"{d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]; {d['p_boot_le0']:.2f} / {d['p_repeats_le0']:.2f}" if d else '-')
    print('| ' + ' | '.join(map(str, row)) + ' |')
print()
for r in R:
    if r['design'].startswith('lm') and r['cohort'] == 'P' and not r['payer']:
        sig = [(k, v) for k, v in sorted(r['perm'].items(), key=lambda kv: -kv[1][0]) if v[1] > 0]
        print(f"- {r['lab']} {r['design']} ({r['perm_model']}): " + '; '.join(f"{k} {v[0]:+.3f} [{v[1]:+.3f}, {v[2]:+.3f}]" for k, v in sig))


def holm(ps):
    """Holm step-down adjusted p-values (same order as input)."""
    m = len(ps); o = sorted(range(m), key=lambda i: ps[i]); adj = [0.0] * m; run = 0.0
    for k, i in enumerate(o):
        run = max(run, min(1.0, (m - k) * ps[i])); adj[i] = run
    return adj


FAM18 = ('text-base', 'text_audio-base', 'audio-base')
rows = [(r['lab'], r['design'], k, d) for r in R if r['design'].startswith('lm') and not r['payer'] for k, d in r['delta'].items()]
if any(k in FAM18 for _, _, k, _ in rows):
    p2 = lambda d: max(2 * min(d['p_boot_le0'], 1 - d['p_boot_le0']), 1 / 1000)
    for name, keep in (('18 deltas: text, text_audio, audio vs base x 6 designs', lambda k: k in FAM18), ('24 deltas: adds text_audio vs text', lambda k: True)):
        fam = [x for x in rows if keep(x[2])]
        adj = holm([p2(x[3]) for x in fam])
        print(f'\nHolm, family of {len(fam)} ({name}); two-sided bootstrap p = 2*min(P(d<=0), P(d>=0)), floor 1/1000. Holm-adjusted min p = {min(adj):.3f}')
        if len(fam) == 18:
            print('| label | T | delta | ΔAUC | raw p | Holm p |'); print('|---|---|---|---|---|---|')
            for (l, ds, k, d), a in sorted(zip(fam, adj), key=lambda z: z[1]):
                print(f"| {l} | {ds[2:]} | {k} | {d['delta']:+.3f} | {p2(d):.3f} | {a:.3f} |")
