#!/usr/bin/env python3
"""Stage 1 (no audio): choose the clips for the pilot day and write the SERVER-SIDE key. Prints counts only.
Clip = one diarizer label in one window. Pool, in priority order, capped at MAX_REAL:
  (a) labels >= 20 s that have a same-window partner above the ceiling, and those partners (>= 5 s),
  (b) every other label with >= 6 s of clean speech, longest first (the day has only 19 labels in all).
The key (opaque id -> window, label, segments) never reaches the page."""
import base64, itertools, json, math, os, random, secrets, struct, sys
from q import q
DAY = sys.argv[1]; CEIL, MIN_SEC, MIN_PARTNER, MAX_REAL, TARGET_S, MIN_CLIP_S, MAX_CLIP_S = 0.545, 20.0, 5.0, 29, 12.0, 6.0, 18.0
OUT = '/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot'; os.makedirs(OUT, exist_ok=True)
rows = q("""select d.window_id, w.session_id, w.start_ms, w.end_ms, d.speakers_json, d.segments_json, s.started_at::text as sess_start
            from room_diarize_window d join bench_window w on w.id = d.window_id join bench_session s on s.id = w.session_id
            where d.state = 'ok' and w.room_day_id = $1 order by w.start_ms""", [DAY])
rows = rows['rows'] if isinstance(rows, dict) else rows
def dec(b):
    raw = base64.b64decode(b); x = struct.unpack('<%df' % (len(raw) // 4), raw); n = math.sqrt(sum(t * t for t in x)); return [t / n for t in x]
cands, seen_pair = [], 0
for r in rows:
    sp = r['speakers_json'] if isinstance(r['speakers_json'], list) else json.loads(r['speakers_json'])
    segs = r['segments_json'] if isinstance(r['segments_json'], list) else json.loads(r['segments_json'] or '[]')
    S = {s['idx']: dict(sec=float(s.get('total_speech_sec') or 0), emb=dec(s['embedding_base64'])) for s in sp if s.get('embedding_base64')}
    partner = {i: 0 for i in S}
    for a, b in itertools.combinations(S, 2):
        if sum(x * y for x, y in zip(S[a]['emb'], S[b]['emb'])) > CEIL: partner[a] += 1; partner[b] += 1; seen_pair += 1
    for i, v in S.items():
        own = sorted([(g['end_ms'] - g['start_ms'], g['start_ms'], g['end_ms']) for g in segs if g['speaker_idx'] == i and not g.get('overlap')], reverse=True)
        pick, tot = [], 0.0
        for dur, a, b in own:
            if tot >= TARGET_S: break
            d = min(dur / 1000.0, MAX_CLIP_S - tot)
            if d <= 0: break
            pick.append([a, a + int(d * 1000)]); tot += d
        if tot < MIN_CLIP_S: continue
        cands.append(dict(window_id=r['window_id'], session_id=r['session_id'], start_ms=int(r['start_ms']), end_ms=int(r['end_ms']), sess_start=r['sess_start'],
                          idx=i, speech_s=round(v['sec'], 1), has_partner=partner[i] > 0, segs=sorted(pick), clip_s=round(tot, 1)))
core = [c for c in cands if c['has_partner'] and c['speech_s'] >= MIN_SEC]
core_windows = {c['window_id'] for c in core}
partners = [c for c in cands if c['has_partner'] and c['speech_s'] < MIN_SEC and c['speech_s'] >= MIN_PARTNER and c['window_id'] in core_windows]
rest = sorted([c for c in cands if c not in core and c not in partners], key=lambda c: -c['speech_s'])
real = (core + partners + rest)[:MAX_REAL]
rng = random.Random(20260920)
clips = []
for k, c in enumerate(real): clips.append(dict(c, id='k' + secrets.token_hex(4), repeat_of=None, kind='core' if c in core else 'partner' if c in partners else 'other'))
reps = rng.sample(real, 3)  # test-retest: three clips played a second time later, unlabelled as repeats
order = list(range(len(clips))); rng.shuffle(order)
for _ in range(400):  # no two clips from one window back to back (adjacency is a cue)
    bad = [p for p in range(1, len(order)) if clips[order[p]]['window_id'] == clips[order[p - 1]]['window_id']]
    if not bad: break
    p = bad[0]; j = rng.randrange(len(order)); order[p], order[j] = order[j], order[p]
seq = [clips[i]['id'] for i in order]
for rc in reps:
    orig = next(c for c in clips if c['window_id'] == rc['window_id'] and c['idx'] == rc['idx'])
    dup = dict(orig, id='k' + secrets.token_hex(4), repeat_of=orig['id'], kind='repeat'); clips.append(dup)
    pos = seq.index(orig['id']); seq.insert(min(len(seq), pos + 8 + rng.randrange(6)), dup['id'])
json.dump(dict(day=DAY, clips=clips, order=seq), open(OUT + '/manifest.json', 'w'))
os.chmod(OUT + '/manifest.json', 0o600)
from collections import Counter
print('day', DAY, '| windows', len(rows), '| pairs above ceiling', seen_pair, '| candidate labels', len(cands))
print('clips: real', len(real), Counter(c['kind'] for c in clips if c['kind'] != 'repeat'), '| repeats', len(reps), '| total to play', len(seq), '| windows needed', len({c['window_id'] for c in clips}))
print('clip seconds: min %.1f max %.1f mean %.1f' % (min(c['clip_s'] for c in clips), max(c['clip_s'] for c in clips), sum(c['clip_s'] for c in clips) / len(clips)))
