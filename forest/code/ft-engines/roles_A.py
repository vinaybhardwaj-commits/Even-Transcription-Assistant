"""ft-engines set A step 2 (venv-forest): roles from Nemotron-3 diarization plus the ft-rl-feat lexicon, Nemotron turn features, and window re-roling.
- Sarvam STT segments (rlf_prep.parse_stt) are assigned to the Nemotron speaker they overlap most; the rlf_prep lexicon (CS counsellor cues, PT patient cues, unchanged) is
  counted per Nemotron speaker. Top-2 Nemotron speakers by talk time are the parties; score = (CS-PT)[a] - (CS-PT)[b].
  role_src: lexicon (|score| >= 2, rlf_prep's threshold) | lexicon_weak (|score| == 1) | fallback (tie: more Nemotron talk time = counsellor, the old guess) |
  single_speaker (Nemotron found one speaker) | no_diar (Nemotron failed / no speech).
- Turn features on Nemotron segments (same definitions as rlf_prep / ft-audio: same-role merge gap 1.5 s; interruption = a turn starting inside the other side's turn that runs
  on >= 0.5 s).
- Windows (ft-rl-feat's Sarvam-turn windows, the ones Odyssey scored) get the role of the Nemotron speaker covering >= 60 % of the window, else role None (overlap/unclear).
Usage: roles_A.py <A_nemo.jsonl> <winA.jsonl> <work dir>  -> calls_roles.parquet, winA_role.jsonl (0600). Ids and numbers only."""
import sys, os, json, collections
import numpy as np, pandas as pd
sys.path.insert(0, '~/wt/ft-rl-feat/code')
import rlf_prep as rp

STT = '~/eta-data/forest/rl/stt'
WIN_COVER = 0.6


def ov(a0, a1, b0, b1): return max(0.0, min(a1, b1) - max(a0, b0))


def one(cid, nemo):
    f = dict(call_id=cid, diar_status=nemo.get('status', 'missing'))
    segs = nemo.get('segments') or []
    if f['diar_status'] != 'ok' or not segs: f['role_src'] = 'no_diar'; return f, {}, segs
    talk = collections.Counter()
    for a, b, s in segs: talk[s] += b - a
    f['n_speakers_nemo'] = len(talk); f['speech_s_nemo'] = sum(talk.values())
    try: stt = rp.parse_stt(json.load(open(f'{STT}/{cid}.json')))
    except Exception: stt = []
    cs, pt, wd = collections.Counter(), collections.Counter(), collections.Counter()
    for a, b, _, t, _ in stt:
        o = collections.Counter()
        for c, e, s in segs: o[s] += ov(a, b, c, e)
        if not o or o.most_common(1)[0][1] <= 0: continue
        s = o.most_common(1)[0][0]
        cs[s] += len(rp.CS.findall(t)); pt[s] += len(rp.PT.findall(t)); wd[s] += len(t.split())
    sps = [s for s, _ in talk.most_common()]
    rl = {s: 'other' for s in sps[2:]}
    if len(sps) == 1: rl[sps[0]] = 'unknown_single'; f['role_src'] = 'single_speaker'
    else:
        a, b = sps[:2]; sc = (cs[a] - pt[a]) - (cs[b] - pt[b])
        if abs(sc) >= 2: f['role_src'] = 'lexicon'
        elif abs(sc) == 1: f['role_src'] = 'lexicon_weak'
        else: f['role_src'] = 'fallback'
        c, p = (a, b) if sc > 0 else ((b, a) if sc < 0 else (a, b))
        rl[c], rl[p] = 'counsellor', 'patient'
        f['lex_score'] = int(sc)
    tt = collections.Counter()
    for a, b, s in segs: tt[rl[s]] += b - a
    tot = tt['counsellor'] + tt['patient']
    span = max(b for _, b, _ in segs) - min(a for a, _, _ in segs)
    if f['role_src'] != 'single_speaker' and tot > 0:
        f['patient_talk_share'] = tt['patient'] / tot; f['counsellor_talk_share'] = tt['counsellor'] / tot
        tr = []
        for a, b, s in sorted(segs):
            ro = rl[s]
            if ro not in ('patient', 'counsellor'): continue
            if tr and tr[-1][2] == ro and a - tr[-1][1] <= 1.5: tr[-1][1] = max(tr[-1][1], b)
            else: tr.append([a, b, ro])
        f['turns_per_min'] = sum(1 for x, y in zip(tr, tr[1:]) if x[2] != y[2]) / (span / 60) if span > 10 else np.nan
        for ro in ('patient', 'counsellor'):
            L = [b - a for a, b, r in tr if r == ro]
            f[f'mean_{ro}_turn_s'] = float(np.mean(L)) if L else np.nan
            n = sum(1 for x in tr if x[2] == ro and any(y[2] != ro and y[0] < x[0] < y[1] - 0.5 for y in tr))
            f[f'{ro}_interrupt_per_min'] = n / (span / 60) if span > 10 else np.nan
    # role-free (mixed) turn features: any speaker change
    tr = []
    for a, b, s in sorted(segs):
        if tr and tr[-1][2] == s and a - tr[-1][1] <= 1.5: tr[-1][1] = max(tr[-1][1], b)
        else: tr.append([a, b, s])
    f['all_turns_per_min'] = sum(1 for x, y in zip(tr, tr[1:]) if x[2] != y[2]) / (span / 60) if span > 10 else np.nan
    f['all_mean_turn_s'] = float(np.mean([b - a for a, b, _ in tr]))
    f['all_interrupt_per_min'] = sum(1 for x in tr if any(y[2] != x[2] and y[0] < x[0] < y[1] - 0.5 for y in tr)) / (span / 60) if span > 10 else np.nan
    iv = []   # union of Nemotron segments (overlapping speech counted once), as a share of the diarized span
    for a, b, _ in sorted(segs):
        if iv and a <= iv[-1][1]: iv[-1][1] = max(iv[-1][1], b)
        else: iv.append([a, b])
    f['all_speech_cover_share'] = sum(b - a for a, b in iv) / span if span > 0 else np.nan
    f['all_overlap_s'] = f['speech_s_nemo'] - sum(b - a for a, b in iv)
    return f, rl, segs


def main(nemo_p, win_p, work):
    N = {}
    for l in open(nemo_p):
        d = json.loads(l); N[d['call_id']] = d
    W = [json.loads(l) for l in open(win_p)]
    cids = sorted({w['call_id'] for w in W} | set(N))
    F, RL, SG = [], {}, {}
    for c in cids:
        f, rl, sg = one(c, N.get(c, {}))
        F.append(f); RL[c] = rl; SG[c] = sg
    df = pd.DataFrame(F)
    p = f'{work}/calls_roles.parquet'; df.to_parquet(p, index=False); os.chmod(p, 0o600)
    cnt = collections.Counter()
    with open(f'{work}/winA_role.jsonl', 'w', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
        for w in W:
            o = collections.Counter()
            for a, b, s in SG.get(w['call_id'], []): o[s] += ov(w['t0'], w['t1'], a, b)
            role = None
            if o:
                s, v = o.most_common(1)[0]
                if v >= WIN_COVER * (w['t1'] - w['t0']): role = RL[w['call_id']].get(s)
            if role not in ('patient', 'counsellor'): role = None
            w['role'] = role; cnt[(w['who_old'], role)] += 1; fh.write(json.dumps(w) + '\n')
    print('calls', len(df), df.role_src.value_counts().to_dict())
    print('windows old->new role', dict(cnt))


if __name__ == '__main__': main(*sys.argv[1:4])
