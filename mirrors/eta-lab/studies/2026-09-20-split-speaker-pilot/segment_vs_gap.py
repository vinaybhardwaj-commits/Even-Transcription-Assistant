#!/usr/bin/env python3
"""Does the voicelessness live in the diarizer's SEGMENTS, or in the GAPS our stitcher kept?

The v4 clips are the one arm that answers this on identical audio: each is a CONTIGUOUS turn span,
so it contains both the diarizer's segments and everything between them. Segment boundaries come
from room_diarize_window.segments_json (window-relative; the window's start_ms makes them absolute).

For every v4 clip we measure silero speech seconds inside the segment sub-ranges and inside the gap
sub-ranges SEPARATELY, on the same wav, with the same model and threshold.

Counts and seconds only. No audio is written, no text is read, no service is started.
"""
import json, os, sys
import numpy as np, soundfile as sf, torch, torchaudio
from silero_vad import load_silero_vad, get_speech_timestamps

SCRATCH = '/Users/vinaybhardwaj/dev/scratch'
V4 = os.path.join(SCRATCH, 'split-speaker-pilot-v4')
WINS = json.load(open(os.path.join(SCRATCH, 'v4-window-segments.json')))
THR = 0.5
model = load_silero_vad()

def speech_in(t16, ranges_s):
    """silero over the WHOLE clip once, then intersect its spans with the ranges."""
    ts = get_speech_timestamps(t16, model, sampling_rate=16000, return_seconds=True, threshold=THR)
    tot = 0.0
    for a, b in ranges_s:
        for t in ts:
            s, e = max(a, float(t['start'])), min(b, float(t['end']))
            if e > s: tot += e - s
    return tot

man = json.load(open(os.path.join(V4, 'manifest.json')))
rows = []
for c in man['clips']:
    p = os.path.join(V4, 'clips', c['id'] + '.wav')
    if not os.path.isfile(p): continue
    ws = [w for w in WINS if w['session_id'] == c['session_id']
          and w['start_ms'] < c['end_ms'] and w['end_ms'] > c['start_ms']]
    # window-relative -> absolute, then clip-relative seconds, clamped to the clip
    segs = []
    for w in ws:
        for s0, e0, spk in w['segs']:
            a, b = w['start_ms'] + s0, w['start_ms'] + e0
            a, b = max(a, c['start_ms']), min(b, c['end_ms'])
            if b > a: segs.append(((a - c['start_ms']) / 1000, (b - c['start_ms']) / 1000))
    segs.sort()
    merged = []
    for a, b in segs:
        if merged and a <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    arr, sr = sf.read(p, dtype='float32')
    if arr.ndim > 1: arr = arr.mean(axis=1)
    dur = len(arr) / sr
    t16 = torch.from_numpy(arr)
    if sr != 16000: t16 = torchaudio.functional.resample(t16, sr, 16000)
    gaps, prev = [], 0.0
    for a, b in merged:
        if a > prev: gaps.append((prev, a))
        prev = b
    if prev < dur: gaps.append((prev, dur))
    seg_s = sum(b - a for a, b in merged); gap_s = sum(b - a for a, b in gaps)
    rows.append({'clip': c['id'], 'doctor': c.get('true_doctor', ''), 'dur_s': round(dur, 2),
                 'n_segs': len(merged), 'seg_s': round(seg_s, 2), 'gap_s': round(gap_s, 2),
                 'speech_in_seg_s': round(speech_in(t16, merged), 2) if merged else 0.0,
                 'speech_in_gap_s': round(speech_in(t16, gaps), 2) if gaps else 0.0})
    print('.', end='', flush=True)
print()
out = os.path.join(SCRATCH, 'v4-segment-vs-gap.json')
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(rows, f, indent=1)

S = sum(r['seg_s'] for r in rows); G = sum(r['gap_s'] for r in rows)
SS = sum(r['speech_in_seg_s'] for r in rows); GS = sum(r['speech_in_gap_s'] for r in rows)
withseg = [r for r in rows if r['n_segs']]
print('clips %d (with diarizer segments inside the span: %d)' % (len(rows), len(withseg)))
print('SEGMENT time %.1f s, speech in it %.1f s  -> %.0f%%' % (S, SS, 100 * SS / S if S else 0))
print('GAP     time %.1f s, speech in it %.1f s  -> %.0f%%' % (G, GS, 100 * GS / G if G else 0))
print('wrote', out)
