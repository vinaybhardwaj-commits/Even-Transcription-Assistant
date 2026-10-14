#!/usr/bin/env python3
"""listen5: fill the pyannote.ai lane. Diarization only (precision-3), no transcription requested.
Uploads the SAME trimmed MP3 the player serves, so pyannote's times line up with the lanes.
The API key and the presigned upload URL are never printed or written. Prints counts only."""
import json, os, secrets, sys, time, urllib.request, urllib.error
KEY = open(os.path.expanduser('~/.claude/secrets/pyannote_api_key')).read().strip()
API = 'https://api.pyannote.ai/v1'
DATA = '/Users/vinaybhardwaj/dev/scratch/listen5'
BAKE = '/Users/vinaybhardwaj/dev/_fable/scratch/bake3'
H = {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, headers=H, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)

F = sorted(json.load(open(os.path.join(DATA, 'fetched.json'))), key=lambda m: m['n'])
out = {}; eur_min = 0.0
for m in F:
    key = 'media://eta-listen5/w%d-%s.mp3' % (m['n'], secrets.token_hex(4))
    try:
        put = call('POST', '/media/input', {'url': key})['url']
        data = open(os.path.join(DATA, 'audio', m['audio']), 'rb').read()
        urllib.request.urlopen(urllib.request.Request(put, method='PUT', data=data, headers={'Content-Type': 'application/octet-stream'}), timeout=300)
        job = call('POST', '/diarize', {'url': key, 'model': 'precision-3'})['jobId']
    except urllib.error.HTTPError as e:
        print('W%d  SUBMIT FAILED http %d' % (m['n'], e.code)); continue
    t0 = time.time(); st = None
    while time.time() - t0 < 900:
        j = call('GET', '/jobs/%s' % job); st = j.get('status')
        if st in ('succeeded', 'failed', 'canceled'): break
        time.sleep(5)
    if st != 'succeeded':
        print('W%d  JOB %s' % (m['n'], st)); continue
    D = (j.get('output') or {}).get('diarization') or []
    segs = [{'start_ms': int(round(float(d['start']) * 1000)), 'end_ms': int(round(float(d['end']) * 1000)), 'speaker': d['speaker']} for d in D]
    out[m['window_id']] = segs
    spk = {}
    for s in segs: spk[s['speaker']] = spk.get(s['speaker'], 0) + (s['end_ms'] - s['start_ms']) / 1000
    over = sum(1 for s in segs if s['end_ms'] > m['got_s'] * 1000 + 500)
    eur_min += m['got_s'] / 60
    print('W%d  %3d segments  %4.0f s labelled  speakers=%d  %4.0f s job  segments past the audio end: %d'
          % (m['n'], len(segs), sum(spk.values()), len(spk), time.time() - t0, over))
p = os.path.join(BAKE, 'pyannote-segments.json')
fd = os.open(p + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(out, f)
os.replace(p + '.tmp', p)
print('wrote %d windows -> %s | audio %.1f min, ~EUR %.2f at EUR 0.112/h' % (len(out), p, eur_min, eur_min / 60 * 0.112))
