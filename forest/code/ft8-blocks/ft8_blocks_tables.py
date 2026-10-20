# ft8-blocks tables: blocks_<lab>.json -> table rows (markdown) + parity check against the frozen ft-forest M0 / M1 OOF (read only).
# Usage: ft8_blocks_tables.py DIR  -> prints markdown table blocks; the summary is written by hand into FT8-BLOCKS.md.
import sys, json, os
import numpy as np

D = sys.argv[1]; FF = os.path.expanduser('~/oc/forest-lead/ft/out/ft-forest')
LABS = ['h14', 'h90', 'ale']; R = {l: json.load(open(f'{D}/blocks_{l}.json')) for l in LABS}
BL = list(R['h14']['blocks'])


def fd(d): return f"{d['delta']:+.3f} [{d['ci'][0]:+.3f}, {d['ci'][1]:+.3f}]"


for l in LABS:
    fz = json.load(open(f'{FF}/model_frozen_rx_{l}.json'))[0]['oof']['by_model_repeat']
    o = R[l]['oof']['by_model_repeat']
    print(f"parity {l}: M0 max|diff| {np.abs(np.array(fz['M0']) - np.array(o['M0'])).max():.2e}, "
          f"M1 max|diff| {np.abs(np.array(fz['M1']) - np.array(o['M1'])).max():.2e}")
print()
print('| label | n / conv | M0 AUC | M1 AUC | M1 - M0 [95% CI] | P(Δ<=0) |')
print('|---|---|---|---|---|---|')
for l in LABS:
    r = R[l]; d = r['delta']['M1 vs M0']
    print(f"| {l} | {r['n']} / {r['pos']} | {r['auc']['M0'][0]:.3f} | {r['auc']['M1'][0]:.3f} | {fd(d)} | {d['p_boot_le0']:.2f} |")
for tag, lab in (('M0+', '(a) M0 + one block: Δ vs M0'), ('M1-', '(b) M1 minus one block: Δ vs M1 (negative = removing it hurts, positive = removing it helps)')):
    print(f'\n{lab}\n')
    print('| block | n cols | ' + ' | '.join(f'{l} Δ [95% CI] | {l} P(Δ<=0)' for l in LABS) + ' |')
    print('|---|---|' + '---|---|' * len(LABS))
    for b in BL:
        k = f'{tag}{b} vs ' + ('M0' if tag == 'M0+' else 'M1')
        print(f"| {b} | {len(R['h14']['blocks'][b])} | " + ' | '.join(f"{fd(R[l]['delta'][k])} | {R[l]['delta'][k]['p_boot_le0']:.2f}" for l in LABS) + ' |')
print("\n**(c) M0 + flags only, and (d) the shuffled-FT8 dilution control: Δ vs the model named**\n")
print('| added | n cols | ' + ' | '.join(f'{l} Δ [95% CI] | {l} P(Δ<=0)' for l in LABS) + ' |')
print('|---|---|' + '---|---|' * len(LABS))
for m, n, k in (('has_flags', 9, 'M0+has_flags vs M0'), ('any_history', 1, 'M0+any_history vs M0'), ('has_prior_rx', 1, 'M0+has_prior_rx vs M0'),
                ('(d) ft8 shuffled vs M0', 42, 'M0+ft8_shuffled vs M0'), ('(d) M1 vs ft8 shuffled', 42, 'M1 vs M0+ft8_shuffled')):
    print(f"| {m} | {n} | " + ' | '.join(f"{fd(R[l]['delta'][k])} | {R[l]['delta'][k]['p_boot_le0']:.2f}" for l in LABS) + ' |')
print('\nCoverage: rows with any data in the block, converters vs non-converters (n, share)\n')
print('| block | ' + ' | '.join(f'{l} conv | {l} non-conv' for l in LABS) + ' |')
print('|---|' + '---|---|' * len(LABS))
for b in BL + ['any_history']:
    print(f'| {b} | ' + ' | '.join(f"{R[l]['coverage'][b]['conv']} ({R[l]['coverage'][b]['conv_share']:.2f}) | "
                                   f"{R[l]['coverage'][b]['nonconv']} ({R[l]['coverage'][b]['nonconv_share']:.2f})" for l in LABS) + ' |')
print('\ncomparisons per label:', len(R['h14']['delta']), '; total:', sum(len(R[l]['delta']) for l in LABS))
