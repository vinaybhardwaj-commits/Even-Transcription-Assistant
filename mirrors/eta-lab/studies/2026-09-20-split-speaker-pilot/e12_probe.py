#!/usr/bin/env python3
"""E-1 + E-2 prototype on one room-day. Read-only on prod; output to ~/dev/_fable/scratch/e12 only.

E-1  probe scheduler: 180 s probes every 60 s across the session. Audio round-trips through
     scribe_extract_audio: each chunk is fetched via a single-chunk request (not a join, so recording
     rooms do not block it), its object hashed, then fetched AGAIN and the hash compared.
E-2  gate per probe: energy_active_frac = share of 20 ms frames at or above production's floor,
     DEFAULT_ROOM_ENERGY_FLOOR 0.00398 RMS (-48 dBFS, lib/stt/window-measure.ts:73). The transcript half
     (unique chars/s) needs stored text; this day has none, so it is recorded null with the reason.
Also: the server's own stored chunk level (bench_chunk.peak_level) against audio-derived chunk RMS —
the nearest available test of whether a stored level can replace decoding.
Presigned URLs are credentials: never printed or written. Output carries counts, times, hashes only."""
import datetime, hashlib, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp, q

SESSION, ROOM_DAY = 'bs_gkzmch9p', 'rd_v7kw7x4d'
OUT = '/Users/vinaybhardwaj/dev/_fable/scratch/e12'
FLOOR, FRAME_S, SR = 0.00398, 0.020, 16000
PROBE_S, HOP_S = 180, 60
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()
ts = lambda s: datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp() * 1000
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
hh = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, IST).strftime('%H:%M:%S')

def wjson(name, obj):
    p = os.path.join(OUT, name); fd = os.open(p + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(p + '.tmp', p)

def extract_whole_chunk(t_ms):
    for span in (2000, 300, 50):
        r = mcp.call('scribe_extract_audio', {'session_id': SESSION, 'start': iso(t_ms), 'end': iso(t_ms + span), 'source': 'primary'})
        if isinstance(r, dict) and r.get('ok') and r.get('presigned_get') and r.get('chunk_bounds'): return r, None
    return None, str((r or {}).get('error') if isinstance(r, dict) else 'bad')[:40]

def fetch(url):
    import urllib.request
    t0 = time.time()
    with urllib.request.urlopen(url, timeout=300) as resp: b = resp.read()
    return b, time.time() - t0

def decode_frames(blob):
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'],
                       input=blob, capture_output=True)
    x = np.frombuffer(p.stdout, dtype=np.float32)
    n = int(SR * FRAME_S); k = len(x) // n
    rms = np.sqrt(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1)) if k else np.zeros(0)
    whole = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    return rms, len(x) / SR, whole

T0 = time.time()
chunks = q.q("""select idx as chunk_idx, started_at, ended_at, peak_level, avg_level from bench_chunk
                 where session_id=$1 and coalesce(source,'primary')='primary' order by chunk_idx""", [SESSION])['rows']
print('chunks listed: %d (primary)' % len(chunks), flush=True)

def do_chunk(c):
    mid = ts(c['started_at']) + 1000
    r1, err = extract_whole_chunk(mid)
    if not r1: return {'chunk_idx': c['chunk_idx'], 'error': err}
    b1, dl1 = fetch(r1['presigned_get'])
    r2, err2 = extract_whole_chunk(mid)                       # the round trip: ask again, hash again
    b2 = fetch(r2['presigned_get'])[0] if r2 else None
    t_dec = time.time(); rms, dur, whole = decode_frames(b1); dec_s = time.time() - t_dec
    cs, ce = ts(r1['chunk_bounds']['started_at']), ts(r1['chunk_bounds']['ended_at'])
    return {'chunk_idx': c['chunk_idx'], 'r2_key_same': bool(r2) and r1.get('r2_key') == r2.get('r2_key'),
            'sha256': hashlib.sha256(b1).hexdigest(), 'sha256_roundtrip': hashlib.sha256(b2).hexdigest() if b2 else None,
            'bytes': len(b1), 'start_ms': cs, 'end_ms': ce, 'bounds_s': (ce - cs) / 1000, 'decoded_s': dur,
            'download_s': round(dl1, 3), 'decode_s': round(dec_s, 3), 'audio_rms': whole,
            'stored_peak_level': float(c['peak_level']) if c['peak_level'] is not None else None,
            'stored_avg_level': float(c['avg_level']) if c['avg_level'] is not None else None,
            '_rms': rms}

with ThreadPoolExecutor(6) as ex: res = list(ex.map(do_chunk, chunks))
T_EXTRACT = time.time() - T0
ok = [r for r in res if 'error' not in r]
bad = [r for r in res if 'error' in r]
rt_match = sum(1 for r in ok if r['sha256'] == r['sha256_roundtrip'])
len_bad = sum(1 for r in ok if abs(r['decoded_s'] - r['bounds_s']) > 1.5)
print('fetched %d/%d chunks in %.0f s | round-trip hash match %d/%d | decoded-vs-bounds length mismatch %d | errors %s'
      % (len(ok), len(res), T_EXTRACT, rt_match, len(ok), len_bad, [r['error'] for r in bad][:3]), flush=True)

# absolute timeline of 20 ms frames
T1 = time.time()
frames = []
for r in sorted(ok, key=lambda r: r['start_ms']):
    t = r['start_ms'] + np.arange(len(r['_rms'])) * FRAME_S * 1000
    frames.append((t, r['_rms'], r))
ft = np.concatenate([f[0] for f in frames]); fr = np.concatenate([f[1] for f in frames])
s0, s1 = min(r['start_ms'] for r in ok), max(r['end_ms'] for r in ok)
probes, gate = [], []
t = s0
while t + PROBE_S * 1000 <= s1:
    sel = (ft >= t) & (ft < t + PROBE_S * 1000)
    n = int(sel.sum()); expect = PROBE_S / FRAME_S
    act = float((fr[sel] >= FLOOR).mean()) if n else None
    covering = [r for r in ok if r['start_ms'] < t + PROBE_S * 1000 and r['end_ms'] > t]
    probes.append({'probe': len(probes), 'start_ist': hh(t), 'start_ms': int(t), 'end_ms': int(t + PROBE_S * 1000),
                   'chunks': [{'chunk_idx': r['chunk_idx'], 'sha256': r['sha256'], 'roundtrip_ok': r['sha256'] == r['sha256_roundtrip']} for r in covering],
                   'coverage': round(n / expect, 3)})
    gate.append({'probe': len(gate), 'start_ist': hh(t), 'energy_active_frac': None if act is None else round(act, 4),
                 'median_frame_rms': None if not n else float(np.median(fr[sel])),
                 'unique_chars_per_s': None, 'transcript_half': 'unavailable: 0 of 38 windows on this day have stored transcript text'})
    t += HOP_S * 1000
T_PROBE = time.time() - T1

ea = np.array([g['energy_active_frac'] for g in gate if g['energy_active_frac'] is not None])
thr = {str(x): round(float((ea >= x).mean()), 3) for x in (0.05, 0.10, 0.20, 0.30)}
# stored chunk level vs audio-derived chunk RMS
def level_vs_audio(field):
    pairs = [(r[field], r['audio_rms']) for r in ok if r.get(field) is not None]
    if len(pairs) < 3: return {'n_chunks': len(pairs)}
    a = np.array([p[0] for p in pairs]); b = np.array([p[1] for p in pairs])
    return {'n_chunks': len(pairs), 'pearson_r': round(float(np.corrcoef(a, b)[0, 1]), 3),
            'agree_on_floor': round(float(((a >= FLOOR) == (b >= FLOOR)).mean()), 3),
            'stored_median': float(np.median(a)), 'audio_median': float(np.median(b))}
lv = {'peak_level': level_vs_audio('stored_peak_level'), 'avg_level': level_vs_audio('stored_avg_level')}
for r in ok: r.pop('_rms', None)
wjson('probes.json', {'session_id': SESSION, 'room_day_id': ROOM_DAY, 'probe_s': PROBE_S, 'hop_s': HOP_S,
                      'chunks': ok, 'chunk_errors': bad, 'probes': probes})
wjson('gate.json', {'floor_rms': FLOOR, 'frame_s': FRAME_S, 'gate': gate,
                    'energy_active_frac_quartiles': [round(float(np.percentile(ea, p)), 4) for p in (10, 25, 50, 75, 90)],
                    'pass_rate_by_threshold': thr, 'stored_level_vs_audio': lv,
                    'timing_s': {'extract_and_decode_wall': round(T_EXTRACT, 1), 'probe_compute': round(T_PROBE, 2),
                                 'per_chunk_download_median': float(np.median([r['download_s'] for r in ok])),
                                 'per_chunk_decode_median': float(np.median([r['decode_s'] for r in ok]))}})
print('probes %d (%s -> %s IST) | energy_active_frac p10/25/50/75/90 %s | pass-rate by threshold %s'
      % (len(probes), hh(s0), hh(s1), [round(float(np.percentile(ea, p)), 3) for p in (10, 25, 50, 75, 90)], thr))
print('stored chunk level vs audio RMS: %s' % lv)
print('timing: extract+decode wall %.0f s for %d chunks | probe compute %.2f s' % (T_EXTRACT, len(ok), T_PROBE))
