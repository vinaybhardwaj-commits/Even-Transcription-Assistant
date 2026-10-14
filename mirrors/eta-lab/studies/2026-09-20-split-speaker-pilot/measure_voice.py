#!/usr/bin/env python3
"""Speech presence over every clip served in v1-v6.

Uses the measures ALREADY on this Mini and nothing else:
  - silero-VAD, exactly as ~/eta-router/router_server.py loads it, at the production threshold 0.5
    and at a sensitive 0.3 (the router's own note records that silero UNDER-detects far-field room
    audio, so a single threshold cannot be trusted on its own);
  - RMS and peak, the router's cheap silence gate, which separates "quiet room" from "loud but
    voiceless" (clatter, a door, a trolley).
No model is installed. No service is started. Output is counts and numbers only: no audio, no text.
"""
import csv, json, os, sys
import numpy as np, soundfile as sf, torch, torchaudio
from silero_vad import load_silero_vad, get_speech_timestamps

SCRATCH = '/Users/vinaybhardwaj/dev/scratch'
VERSIONS = [('v1', 'split-speaker-pilot'), ('v2', 'split-speaker-pilot-v2'), ('v3', 'split-speaker-pilot-v3'),
            ('v4', 'split-speaker-pilot-v4'), ('v5', 'split-speaker-pilot-v5'), ('v6', 'split-speaker-pilot-v6')]
OUT = os.path.join(SCRATCH, 'voice-presence-v1-v6.csv')

model = load_silero_vad()

def speech_s(t16, thr):
    # silero takes 8k or 16k ONLY. The clips are written at 48k, so they are resampled first;
    # handing 48k samples to the model while declaring 16k makes every voice sound 3x slow and the
    # model reports silence. That is a measurement bug, not a finding, and it cost a full pass.
    ts = get_speech_timestamps(t16, model, sampling_rate=16000, return_seconds=True, threshold=thr)
    return sum(float(t['end']) - float(t['start']) for t in ts), len(ts)

rows = []
for ver, d in VERSIONS:
    base = os.path.join(SCRATCH, d)
    man = json.load(open(os.path.join(base, 'manifest.json')))
    meta = {c['id']: c for c in man['clips']}
    # v6's answers are keyed by PAIR; every other version answers a clip directly.
    pairmap = man.get('pairmap') or {}
    ansfile = os.path.join(base, 'answers.jsonl')
    ans = {}
    if os.path.exists(ansfile):
        for l in open(ansfile):
            try: r = json.loads(l)
            except ValueError: continue
            if r.get('kind') != 'clip': continue
            for cid in (pairmap.get(r['id']) or [r['id']]):
                ans[cid] = r['answer']            # last line wins, as the server's own state does
    for cid, c in sorted(meta.items()):
        p = os.path.join(base, 'clips', cid + '.wav')
        if not os.path.isfile(p): continue
        arr, sr = sf.read(p, dtype='float32')
        if arr.ndim > 1: arr = arr.mean(axis=1)
        dur = len(arr) / sr
        t16 = torch.from_numpy(arr)
        if sr != 16000: t16 = torchaudio.functional.resample(t16, sr, 16000)
        s50, n50 = speech_s(t16, 0.5)
        s30, n30 = speech_s(t16, 0.3)
        rms = float(np.sqrt(np.mean(arr ** 2))); peak = float(np.max(np.abs(arr)))
        rows.append({'version': ver, 'clip': cid, 'sr': sr,
                     'doctor': c.get('true_doctor') or c.get('doctor') or '',
                     'kind': c.get('kind') or '', 'dur_s': round(dur, 2),
                     'speech_s_50': round(s50, 2), 'frac_50': round(s50 / dur, 3), 'n_spans_50': n50,
                     'speech_s_30': round(s30, 2), 'frac_30': round(s30 / dur, 3), 'n_spans_30': n30,
                     'rms': round(rms, 5), 'peak': round(peak, 4),
                     'answer': ans.get(cid, '')})
    print('%s: %d clips measured' % (ver, sum(1 for r in rows if r['version'] == ver)), flush=True)

fd = os.open(OUT, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
print('wrote %d rows to %s' % (len(rows), OUT))
