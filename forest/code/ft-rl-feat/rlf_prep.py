"""ft-rl-feat step 1 (venv-forest): Runo call STT JSON + manifest -> per-call talk-time/turn features, speaker roles, speaker-labelled transcript text,
and Odyssey windows. Transcript text and audio never leave the lab box; only ids/numbers are printed. D split only (episode_id must be in labels.parquet split D).
Usage: rlf_prep.py <manifest.tsv|dir of shards> <stt_dir> <work_dir>
Manifest: key_id, episode_id, duration, path [, day_from_rx, call_day, in_t7, in_t14]. ASSUMPTION (logged): key_id == Runo call_id; day_from_rx / call_day
are joined from ft-calltext calls_D.parquet when the manifest lacks them.
STT JSON: tolerant parser. Accepts Sarvam batch diarised output (diarized_transcript.entries[] with transcript/start_time_seconds/end_time_seconds/speaker_id)
or {segments|entries|chunks: [{speaker, start|t0|start_time_seconds, end|t1|end_time_seconds, text|transcript, lang}]}; ms keys (t0_ms/t1_ms) accepted.
Outputs (0600): work/calls_basic.parquet, work/windows.jsonl, work/texts.jsonl (call_id, episode_id, text)."""
import glob, json, os, re, sys, collections
import numpy as np, pandas as pd

LAB = '~/oc/forest-lead/ft/out/ft-labels-base/labels.parquet'
CALLS = '~/oc/forest-lead/ft/out/ft-calltext/calls_D.parquet'
WIN_S, MIN_SEG_S, MAX_WIN_PER_SPK = 8.0, 1.0, 24

# counsellor-side cues (English / romanised Hinglish, since some segments are translated or code-mixed); patient-side cues
CS = re.compile(r"\b(even hospital\w*|calling from|this is .{1,30} from|your (appointment|surgery|report|consultation)|doctor (has )?(advised|suggested|recommended)|"
                r"package|estimate|cashless|tpa|pre.?auth\w*|slot|admission|discharge|follow.?up|we will|i will (send|share|call)|can i help|how may i)\b", re.I)
PT = re.compile(r"\b(my (mother|father|wife|husband|son|daughter|pain)|i will (think|discuss|see|ask)|let me (think|discuss|ask)|not now|call (me )?later|"
                r"too (costly|expensive)|how much|kitna|ghar pe|family se|wrong number|who is this)\b", re.I)


def read_manifest(p):
    fs = sorted(glob.glob(p + '/*.tsv')) if os.path.isdir(p) else [p]
    m = pd.concat([pd.read_csv(f, sep='\t', dtype=str) for f in fs], ignore_index=True)
    return m.drop_duplicates('key_id')


def num(d, *ks):
    for k in ks:
        if k in d and d[k] is not None:
            try: return float(d[k])
            except (TypeError, ValueError): pass
    return None


def parse_stt(j):
    """-> list of (t0_s, t1_s, speaker, text, lang)"""
    if isinstance(j.get('result'), dict) and 'diarized_transcript' not in j:   # ft-rl-stt wrapper: result{'0.json': <Sarvam batch output>, ...}
        parts = [j['result'][k] for k in sorted(j['result'], key=lambda x: (len(x), x))]
        if len(parts) == 1: j = parts[0]
        else:   # multi-part (long audio): concatenate; part offsets unknown -> offset each part by the end of the previous one
            outs, off = [], 0.0
            for p in parts:
                o = parse_stt(p)
                outs += [(a + off, b + off, s, t, l) for a, b, s, t, l in o]; off = max([off] + [b + off for _, b, *_ in o])
            return outs
    ent = None
    dt = j.get('diarized_transcript')
    if isinstance(dt, dict): ent = dt.get('entries')
    for k in ('segments', 'entries', 'chunks', 'utterances'):
        if ent is None and isinstance(j.get(k), list): ent = j[k]
    out = []
    for e in ent or []:
        t0 = num(e, 'start_time_seconds', 'start', 't0', 'start_s'); t1 = num(e, 'end_time_seconds', 'end', 't1', 'end_s')
        if t0 is None and 't0_ms' in e: t0, t1 = float(e['t0_ms']) / 1000, float(e['t1_ms']) / 1000
        txt = e.get('transcript') or e.get('text') or ''
        sp = str(e.get('speaker_id', e.get('speaker', 'unk')))
        if t0 is None or t1 is None or t1 <= t0: continue
        out.append((t0, t1, sp, txt.strip(), e.get('language_code') or e.get('lang')))
    if out:  # ms-vs-s guard: Sarvam gives seconds; absolute ms epochs would give absurd spans
        mx = max(o[1] for o in out)
        if mx > 36000: out = [(a / 1000, b / 1000, s, t, l) for a, b, s, t, l in out]
        t00 = min(o[0] for o in out)
        if t00 > 3600: out = [(a - t00, b - t00, s, t, l) for a, b, s, t, l in out]
    return sorted(out)


def roles(segs):
    """speaker -> 'counsellor'|'patient'|'other'; source. Lexicon first, talk-time fallback (counsellors usually talk more)."""
    words = collections.Counter(); cs = collections.Counter(); pt = collections.Counter()
    for a, b, sp, t, _ in segs:
        words[sp] += len(t.split()); cs[sp] += len(CS.findall(t)); pt[sp] += len(PT.findall(t))
    sps = [s for s, _ in words.most_common()]
    if not sps: return {}, 'none'
    main = sps[:2]; rest = sps[2:]
    r = {s: 'other' for s in rest}
    if len(main) == 1: r[main[0]] = 'unknown_single'; return r, 'single_speaker'
    a, b = main; sc = (cs[a] - pt[a]) - (cs[b] - pt[b])
    if abs(sc) >= 2: c, p = (a, b) if sc > 0 else (b, a); src = 'lexicon'
    else: c, p = a, b; src = 'talk_fallback'      # a = most words
    r[c], r[p] = 'counsellor', 'patient'
    return r, src


def ov(a0, a1, b0, b1): return max(0.0, min(a1, b1) - max(a0, b0))


def one(row, stt_dir):
    f = dict(call_id=row.key_id, episode_id=row.episode_id, stt_status='ok')
    p = f'{stt_dir}/{row.key_id}.json'
    if not os.path.exists(p): f['stt_status'] = 'no_stt'; return f, [], None
    try: segs = parse_stt(json.load(open(p)))
    except Exception as e: f['stt_status'] = 'bad_json ' + type(e).__name__; return f, [], None
    if not segs: f['stt_status'] = 'empty'; return f, [], None
    rl, f['role_src'] = roles(segs)
    f['n_speakers'] = len({s for _, _, s, _, _ in segs}); f['n_segs'] = len(segs)
    f['lang_main'] = collections.Counter(l for *_, l in segs if l).most_common(1)[0][0] if any(l for *_, l in segs) else None
    span = max(b for _, b, *_ in segs) - min(a for a, *_ in segs)
    f['call_span_s'] = span; f['audio_dur_s'] = float(row.duration) if getattr(row, 'duration', None) not in (None, '') else np.nan
    tt = collections.Counter(); wd = collections.Counter()
    for a, b, sp, t, _ in segs: tt[rl[sp]] += b - a; wd[rl[sp]] += len(t.split())
    f['counsellor_s'], f['patient_s'] = tt['counsellor'], tt['patient']
    tot = tt['counsellor'] + tt['patient']
    f['patient_talk_share'] = tt['patient'] / tot if tot > 0 else np.nan
    f['counsellor_talk_share'] = tt['counsellor'] / tot if tot > 0 else np.nan
    f['speech_s'] = sum(b - a for a, b, *_ in segs); f['words_total'] = sum(len(t.split()) for *_, t, _ in segs); f['wpm_all'] = f['words_total'] / (f['speech_s'] / 60) if f['speech_s'] > 5 else np.nan
    f['patient_words'], f['counsellor_words'] = wd['patient'], wd['counsellor']
    f['patient_wpm'] = wd['patient'] / (tt['patient'] / 60) if tt['patient'] > 5 else np.nan
    # turns: merge consecutive same-role segments with gap <= 1.5 s
    tr = []
    for a, b, sp, *_ in segs:
        ro = rl[sp]
        if tr and tr[-1][2] == ro and a - tr[-1][1] <= 1.5: tr[-1][1] = max(tr[-1][1], b)
        else: tr.append([a, b, ro])
    ch = sum(1 for x, y in zip(tr, tr[1:]) if x[2] != y[2])
    f['turns_per_min'] = ch / (span / 60) if span > 10 else np.nan
    ptn = [b - a for a, b, ro in tr if ro == 'patient']
    f['mean_patient_turn_s'] = float(np.mean(ptn)) if ptn else np.nan
    f['first_speaker_role'] = rl[segs[0][2]]
    inter = sum(1 for x in tr for y in tr if y[2] != x[2] and y[0] < x[0] < y[1] - 0.5 and x[2] == 'patient')
    f['patient_interrupt_per_min'] = inter / (span / 60) if span > 10 else np.nan
    # Odyssey windows: per role, own segments, no >0.2 s overlap with the other role; capped, evenly spaced
    W = []
    single = f['role_src'] == 'single_speaker'      # engine without diarisation (e.g. on-box whisper/indic-conformer): no role split, score all speech as 'mixed'
    for who in (('mixed',) if single else ('patient', 'counsellor')):
        oth = [(a, b) for a, b, sp, *_ in segs if not single and rl[sp] not in (who, 'other')]
        cand = []
        for a, b, sp, *_ in segs:
            if (not single and rl[sp] != who) or b - a < MIN_SEG_S: continue
            if any(ov(a, b, c, e) > 0.2 for c, e in oth): continue
            x = a
            while b - x >= MIN_SEG_S:
                y = min(b, x + WIN_S); cand.append((round(x, 3), round(y, 3))); x = y
        if len(cand) > MAX_WIN_PER_SPK: cand = [cand[i] for i in np.linspace(0, len(cand) - 1, MAX_WIN_PER_SPK).astype(int)]
        W += [dict(call_id=row.key_id, episode_id=row.episode_id, path=row.path, who=who, t0=a, t1=b) for a, b in cand]
    f['n_windows_patient'] = sum(w['who'] == 'patient' for w in W); f['n_windows_counsellor'] = sum(w['who'] == 'counsellor' for w in W); f['n_windows_mixed'] = sum(w['who'] == 'mixed' for w in W)
    lab = {'counsellor': 'Counsellor', 'patient': 'Patient', 'other': 'Other', 'unknown_single': 'Speaker'}
    text = '\n'.join(f'[{lab[rl[sp]]}] {t}' for _, _, sp, t, _ in segs if t)
    return f, W, text


def main(man, stt_dir, work):
    os.makedirs(work, mode=0o700, exist_ok=True)
    m = read_manifest(man)
    if 'in_shard' in m.columns:   # only calls actually sent to STT (days 0..13, pre-decision, after consult); others are fetched but never sharded
        nn = (~m.in_shard.isin(['a', 'b', 'c'])).sum(); m = m[m.in_shard.isin(['a', 'b', 'c'])]; print('manifest rows not in a/b/c shard (excluded)', nn)
    if 'call_date' in m.columns and 'call_day' not in m.columns: m['call_day'] = m.call_date
    lab = pd.read_parquet(LAB); D = set(lab[lab.split == 'D'].episode_id)
    nH = (~m.episode_id.isin(D)).sum(); m = m[m.episode_id.isin(D)]           # non-D (H or unknown) dropped unread; fail closed
    print('manifest', len(m), 'dropped_non_D', nH)
    F, W, T = [], [], []
    for r in m.itertuples():
        f, w, t = one(r, stt_dir); F.append(f); W += w
        if t: T.append(dict(call_id=r.key_id, episode_id=r.episode_id, text=t))
    df = pd.DataFrame(F)
    # window membership
    c = pd.read_parquet(CALLS)[['call_id', 'day_from_rx', 'call_day']]
    mm = m[['key_id'] + [x for x in ('day_from_rx', 'call_day', 'in_t3', 'in_t7', 'in_t14') if x in m.columns]].rename(columns={'key_id': 'call_id'})
    df = df.merge(mm, on='call_id', how='left').merge(c.rename(columns={'day_from_rx': 'dfr_j', 'call_day': 'cd_j'}), on='call_id', how='left')
    d = pd.to_numeric(df['day_from_rx'], errors='coerce') if 'day_from_rx' in df else pd.Series(np.nan, index=df.index)
    df['day_from_rx'] = d.fillna(df.dfr_j)
    df['call_day'] = pd.to_datetime(df['call_day'] if 'call_day' in df else df.cd_j, errors='coerce').fillna(df.cd_j)
    for T_ in (3, 7, 14):
        col = f'in_t{T_}'; base = df.day_from_rx < T_
        df[col] = df[col].astype(str).str.lower().isin(['1', 'true']) if col in df else base
    df = df.drop(columns=['dfr_j', 'cd_j'])
    df.to_parquet(f'{work}/calls_basic.parquet', index=False)
    for nm, rows in (('windows', W), ('texts', T)):
        fd = os.open(f'{work}/{nm}.jsonl', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        for x in rows: os.write(fd, (json.dumps(x, ensure_ascii=False) + '\n').encode())
        os.close(fd)
    os.chmod(f'{work}/calls_basic.parquet', 0o600)
    print('calls', len(df), df.stt_status.value_counts().to_dict(), 'roles', df.get('role_src', pd.Series(dtype=str)).value_counts().to_dict(), 'windows', len(W), 'texts', len(T))


if __name__ == '__main__': main(*sys.argv[1:4])
