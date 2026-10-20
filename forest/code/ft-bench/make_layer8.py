# ft-bench -> forest layer 8 (spec v3.2): Opus 5.5 p14/p90 as given, main text, screen v1 and screen v2 (+insurance; spec v3.3 layer-8 PRIMARY = opus_screen2_*), with has_text flags.
# Design B: one row per (episode_id, T) over the union of FTR v2 at-risk episodes; design C: one row per consult_uid. Missing = no text.
# Also carries Jev p14/p90 (main text) for the declared Jev sensitivity. D only. Output 0600 in out/ft-bench/.
import os, sys, json
import pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from bench_inputs import ftr_designs, WORK, OUT

def sc(name, key):
    p = f'{WORK}/scores_{name}.jsonl'
    if not os.path.exists(p): return pd.DataFrame(columns=key)
    return pd.read_json(p, lines=True).drop_duplicates(key, keep='last')

def main():
    R = ftr_designs(); B = pd.DataFrame([(e, T) for (l, T), o in R.items() for e in o['episode_id']], columns=['episode_id', 'T']).drop_duplicates()
    for nm, col in (('opus', 'opus'), ('screen_opus', 'opus_screen'), ('screen2_opus', 'opus_screen2'), ('jev', 'jev')):
        d = sc(nm, ['episode_id', 'T'])[['episode_id', 'T', 'p14', 'p90']].rename(columns={'p14': f'{col}_p14', 'p90': f'{col}_p90'})
        B = B.merge(d, on=['episode_id', 'T'], how='left')
    B['has_text'] = B.opus_p14.notna(); B['has_text_screen'] = B.opus_screen_p14.notna(); B['has_text_screen2'] = B.opus_screen2_p14.notna()
    B.to_parquet(f'{OUT}/bench_layer8.parquet'); os.chmod(f'{OUT}/bench_layer8.parquet', 0o600)
    C = pd.read_parquet(os.path.expanduser('~/oc/forest-lead/ft/out/ft-audio/designC_cohort.parquet'))[['consult_uid']]
    for nm, col in (('c_opus', 'opus'), ('c_screen_opus', 'opus_screen'), ('c_screen2_opus', 'opus_screen2'), ('c_jev', 'jev')):
        d = sc(nm, ['episode_id'])
        d = d[['episode_id', 'p14', 'p90']].rename(columns={'episode_id': 'consult_uid', 'p14': f'{col}_p14', 'p90': f'{col}_p90'}) if len(d) else pd.DataFrame(columns=['consult_uid'])
        C = C.merge(d, on='consult_uid', how='left')
    C['has_text'] = C.opus_p14.notna(); C['has_text_screen'] = C.opus_screen_p14.notna(); C['has_text_screen2'] = C.opus_screen2_p14.notna()
    C.to_parquet(f'{OUT}/bench_layer8_c.parquet'); os.chmod(f'{OUT}/bench_layer8_c.parquet', 0o600)
    print('B rows', len(B), 'has_text', int(B.has_text.sum()), 'screen', int(B.has_text_screen.sum()), 'screen2', int(B.has_text_screen2.sum()), '| C rows', len(C), 'has_text', int(C.has_text.sum()), 'screen', int(C.has_text_screen.sum()), 'screen2', int(C.has_text_screen2.sum()))

if __name__ == '__main__':
    main()
