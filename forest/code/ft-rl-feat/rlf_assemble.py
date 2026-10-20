"""ft-rl-feat step 4 (venv-forest): per-call basic + Odyssey + Haiku tags -> per-episode features, one row per D episode with >= 1 transcribed call.
Prediction-time rule: window T in {7, 14}: calls with day_from_rx < T (manifest/calls_D), call_day < event_date, and calls with a verified outcome_revealed tag dropped.
Columns suffixed _t7 / _t14. Also writes COVERAGE.md (counts only). Usage: rlf_assemble.py <work_dir> <out_dir>"""
import sys, os, json
import warnings; warnings.simplefilter('ignore', FutureWarning)
import numpy as np, pandas as pd

LAB = '~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']
INT = ['wants_surgery', 'undecided', 'declines']
NXT = ['visit_or_consult_scheduled', 'callback_agreed', 'details_to_be_sent']
TALK = ['patient_talk_share', 'turns_per_min', 'mean_patient_turn_s', 'patient_interrupt_per_min', 'patient_wpm']


def jl(p): return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def agg_emo(e, who, calls):
    g = e[(e.who == who) & e.call_id.isin(calls) & (e.status == 'ok')]
    o = {}
    for k in ('valence', 'arousal'):
        o[f'{who}_{k}_mean'] = g[k].mean() if len(g) else np.nan
        o[f'{who}_{k}_std'] = g[k].std() if len(g) > 1 else np.nan
        o[f'{who}_{k}_min'] = g[k].min() if len(g) else np.nan
    o[f'{who}_n_windows'] = len(g)
    return o, g


def main(work, out):
    os.makedirs(out, exist_ok=True)
    cb = pd.read_parquet(f'{work}/calls_basic.parquet')
    emo = pd.DataFrame(jl(f'{work}/emo.jsonl')); tg = pd.DataFrame(jl(f'{work}/tags.jsonl'))
    lab = pd.read_parquet(LAB); lab = lab[lab.split == 'D'].set_index('episode_id')
    if len(emo) == 0: emo = pd.DataFrame(columns=['call_id', 'who', 'status', 'valence', 'arousal', 't0'])
    if len(tg):
        tg = tg.drop_duplicates('call_id', keep='last')
        cb = cb.merge(tg[['call_id', 'outcome_revealed', 'intent', 'next_step', 'price_quoted', 'objections']], on='call_id', how='left')
        cb['tagged'] = cb.intent.notna()
    else:
        for c in ('outcome_revealed', 'intent', 'next_step', 'price_quoted', 'objections'): cb[c] = np.nan
        cb['tagged'] = False
    cb['outcome_revealed'] = cb.outcome_revealed.fillna(False).astype(bool)
    ev = pd.to_datetime(cb.episode_id.map(lab.event_date))
    cb['post_event'] = ev.notna() & cb.call_day.notna() & (cb.call_day >= ev)
    ok = cb.stt_status.eq('ok')
    rows = []
    for ep, g in cb.groupby('episode_id'):
        r = dict(episode_id=ep, n_calls_stt=int(g.stt_status.eq('ok').sum()), n_calls_stt_failed=int((~g.stt_status.eq('ok')).sum()))
        for T in (3, 7, 14):
            w = g[g[f'in_t{T}'].fillna(False) & g.stt_status.eq('ok') & ~g.post_event]
            r[f'n_calls_dropped_outcome_t{T}'] = int(w.outcome_revealed.sum())
            if len(tg): w = w[w.tagged | w.outcome_revealed]   # untagged (tagger failed) calls can't be screened for outcome-revealing content: excluded, counted
            w = w[~w.outcome_revealed]; s = f'_t{T}'
            r['n_calls' + s] = len(w); r['wpm_all' + s] = w.wpm_all.mean() if len(w) else np.nan; r['speech_min' + s] = w.speech_s.sum() / 60 if len(w) else np.nan; r['minutes' + s] = (w.call_span_s.sum() / 60) if len(w) else np.nan
            r['n_calls_tagged' + s] = int(w.tagged.sum())
            for k in TALK: r[k + s] = w[k].mean() if len(w) else np.nan
            r['counsellor_talk_share' + s] = w.counsellor_talk_share.mean() if len(w) else np.nan
            r['role_fallback_share' + s] = w.role_src.eq('talk_fallback').mean() if len(w) else np.nan
            for who in ('patient', 'counsellor', 'mixed'):
                o, ge = agg_emo(emo, who, set(w.call_id))
                for k, v in o.items(): r[k + s] = v
                if len(ge):  # change across calls: last call mean minus first call mean (needs >= 2 calls with windows)
                    order = w.sort_values(['day_from_rx', 'call_id']).call_id.tolist()
                    pc = ge.groupby('call_id').valence.mean().reindex(order).dropna()
                    if len(pc) >= 2: r[f'{who}_valence_last_minus_first' + s] = pc.iloc[-1] - pc.iloc[0]
            r['valence_gap_patient_minus_counsellor' + s] = r.get('patient_valence_mean' + s, np.nan) - r.get('counsellor_valence_mean' + s, np.nan)
            wt = w[w.tagged]; nt = max(len(wt), 1)
            for o in OBJ: r[f'obj_{o}_n' + s] = int(wt.objections.apply(lambda x: isinstance(x, (list, np.ndarray)) and o in list(x)).sum()) if len(wt) else np.nan
            r['obj_any' + s] = int(wt.objections.apply(lambda x: isinstance(x, (list, np.ndarray)) and len(x) > 0).any()) if len(wt) else np.nan
            for i in INT: r[f'intent_{i}_any' + s] = int(wt.intent.eq(i).any()) if len(wt) else np.nan
            r['intent_last' + s] = wt.sort_values('day_from_rx').intent.iloc[-1] if len(wt) else None
            for n in NXT: r[f'next_{n}_any' + s] = int(wt.next_step.eq(n).any()) if len(wt) else np.nan
            r['price_quoted_any' + s] = int(wt.price_quoted.fillna(False).astype(bool).any()) if len(wt) else np.nan
        rows.append(r)
    df = pd.DataFrame(rows); df = df[df.n_calls_stt > 0].reset_index(drop=True)   # episodes with >= 1 transcribed call
    for c in ('h14', 'h90', 'split'): df[c] = df.episode_id.map(lab[c]) if c in lab else None
    assert (df.split == 'D').all(), 'non-D episode in output'
    p = f'{out}/call_audio_feats.parquet'; df.to_parquet(p, index=False); os.chmod(p, 0o600)
    cov = [f'# ft-rl-feat COVERAGE (counts only). Rows = D episodes with >= 1 transcribed call: {len(df)}',
           f'Manifest calls (D): {len(cb)}; STT ok: {int(ok.sum())}; STT failed/missing: {int((~ok).sum())} ({cb.stt_status[~ok].value_counts().to_dict()})',
           f'Roles source (calls): {cb.role_src.value_counts().to_dict() if "role_src" in cb else {}}  (talk_fallback = lexicon tie, speaker with more words = counsellor; talk-share features on those calls are weaker)',
           f'Odyssey windows scored ok: {int((emo.status == "ok").sum()) if len(emo) else 0}, errors: {int((emo.status != "ok").sum()) if len(emo) else 0}; calls with >=1 patient window: {emo[(emo.who=="patient")&(emo.status=="ok")].call_id.nunique() if len(emo) else 0}',
           f'Haiku-tagged calls: {int(cb.tagged.sum())} (STT-ok calls untagged after retry, excluded from aggregates: {int((ok & ~cb.tagged).sum()) if len(tg) else 0}); outcome_revealed (verified) calls: {int(cb.outcome_revealed.sum())}; post-event calls: {int(cb.post_event.sum())}', '',
           '| window | episodes with >=1 call | with patient valence | with tags | h14 pos among covered | h90 pos among covered |', '|---|---|---|---|---|---|']
    for T in (3, 7, 14):
        s = f'_t{T}'; c = df[df['n_calls' + s] > 0]
        cov.append(f'| T={T} (day_from_rx < {T}) | {len(c)} | {int(c["patient_valence_mean" + s].notna().sum())} | {int((c["n_calls_tagged" + s] > 0).sum())} | {int(c.h14.fillna(0).sum())}/{int(c.h14.notna().sum())} | {int(c.h90.fillna(0).sum())}/{int(c.h90.notna().sum())} |')
    cov += ['', 'Notes: D split only (non-D episode ids in the manifest are dropped before any STT/audio is read; output asserts split == D). Calls with a verified outcome_revealed tag and calls on/after the event date are excluded from every aggregate.',
            'h14/h90 columns are copied from labels.parquet for convenience; h90 is NaN/pending for young Rx. Small n = DIRECTIONAL.']
    open(f'{out}/COVERAGE.md', 'w').write('\n'.join(cov) + '\n')
    print('\n'.join(cov))


if __name__ == '__main__': main(*sys.argv[1:3])
