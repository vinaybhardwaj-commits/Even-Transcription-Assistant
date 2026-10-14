#!/usr/bin/env python3
"""E-1 extract contract on 5 probes: extract -> store -> re-read -> same sha256, and an INDEPENDENT
second extract (fresh extract calls, fresh downloads) must reproduce the same probe hash.
Extraction tries the single joined request first; if the join is refused (a room is recording) it
assembles the probe from single-chunk requests. The stored probe WAVs are deleted after the check,
so no patient audio stays behind; the hashes and sizes are kept. URLs are never printed or written."""
import datetime, hashlib, json, os, subprocess, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp, q
SESSION, ROOM_DAY = 'bs_maaacrdh', 'rd_djmbtzph'
OUT = '/Users/vinaybhardwaj/dev/_fable/scratch/e12'
CDIR = os.path.join(OUT, 'contract'); os.makedirs(CDIR, mode=0o700, exist_ok=True)
SR, PROBE_S = 16000, 180
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()
ts = lambda s: datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp() * 1000
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
hh = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, IST).strftime('%H:%M:%S')

def dl(url):
    with urllib.request.urlopen(url, timeout=300) as r: return r.read()

def pcm(blob, ss=0.0, t=None):
    cmd = ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-ss', '%.3f' % ss] + (['-t', '%.3f' % t] if t else []) + ['-ac', '1', '-ar', str(SR), '-f', 's16le', 'pipe:1']
    return subprocess.run(cmd, input=blob, capture_output=True).stdout

def extract_probe(t0):
    """-> (pcm bytes of exactly [t0, t0+180 s], method, n_requests)"""
    r = mcp.call('scribe_extract_audio', {'session_id': SESSION, 'start': iso(t0), 'end': iso(t0 + PROBE_S * 1000), 'source': 'primary'})
    if isinstance(r, dict) and r.get('ok') and r.get('joined') and (r.get('clip') or {}).get('presigned_get'):
        return pcm(dl(r['clip']['presigned_get']), 0.0, PROBE_S), 'joined', 1
    # join refused or not offered: walk single chunks
    t, parts, n = t0, [], 1
    while t < t0 + PROBE_S * 1000 - 20:
        for span in (2000, 300, 50):
            c = mcp.call('scribe_extract_audio', {'session_id': SESSION, 'start': iso(t), 'end': iso(t + span), 'source': 'primary'}); n += 1
            if isinstance(c, dict) and c.get('ok') and c.get('chunk_bounds') and c.get('presigned_get'): break
        else:
            raise RuntimeError('no chunk at %s' % hh(t))
        cs, ce = ts(c['chunk_bounds']['started_at']), ts(c['chunk_bounds']['ended_at'])
        parts.append((cs, pcm(dl(c['presigned_get']))))
        t = ce + 1
    base = parts[0][0]; joined = b''.join(p for _, p in parts)
    off = int(round((t0 - base) / 1000 * SR)) * 2; want = PROBE_S * SR * 2
    return joined[off: off + want], 'chunk-walk', n

def wav_bytes(p):
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(p)
    return buf.getvalue()

s = q.q("select started_at, ended_at from bench_session where id=$1", [SESSION])['rows'][0]
S0, S1 = ts(s['started_at']), ts(s['ended_at'])
picks = [S0 + (S1 - S0 - PROBE_S * 1000) * f for f in (0.08, 0.30, 0.50, 0.70, 0.92)]
picks = [int(p // 60000 * 60000 + (S0 % 60000)) for p in picks]          # on the probe grid (hop 60 s from session start)
res = []
for k, t0 in enumerate(picks, 1):
    t_a = time.time(); p1, m1, n1 = extract_probe(t0); ta = time.time() - t_a
    b1 = wav_bytes(p1); h1 = hashlib.sha256(b1).hexdigest()
    path = os.path.join(CDIR, 'probe%d.wav' % k)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as f: f.write(b1); f.flush(); os.fsync(f.fileno())
    h2 = hashlib.sha256(open(path, 'rb').read()).hexdigest()               # re-read from disk
    t_b = time.time(); p3, m3, n3 = extract_probe(t0); tb = time.time() - t_b
    h3 = hashlib.sha256(wav_bytes(p3)).hexdigest()                          # independent second extract
    secs = len(p1) / 2 / SR
    res.append({'probe': k, 'start_ist': hh(t0), 'start_ms': t0, 'seconds': round(secs, 3), 'bytes': len(b1),
                'method_first': m1, 'method_second': m3, 'requests_first': n1, 'extract_s_first': round(ta, 2), 'extract_s_second': round(tb, 2),
                'sha256': h1, 'store_reread_match': h1 == h2, 'independent_reextract_match': h1 == h3})
    os.remove(path)                                                           # no patient audio left behind
    print('probe %d %s  %.1f s  via %s (%d req, %.1f s)  store->re-read %s  re-extract %s'
          % (k, hh(t0), secs, m1, n1, ta, 'MATCH' if h1 == h2 else 'DIFFER', 'MATCH' if h1 == h3 else 'DIFFER'), flush=True)
out = {'session_id': SESSION, 'room_day_id': ROOM_DAY, 'probe_s': PROBE_S, 'probes': res,
       'summary': {'store_reread_match': sum(r['store_reread_match'] for r in res), 'independent_reextract_match': sum(r['independent_reextract_match'] for r in res),
                   'n': len(res), 'exact_length': sum(1 for r in res if abs(r['seconds'] - PROBE_S) < 0.001)},
       'note': 'probe WAVs deleted after the check; hashes and sizes kept'}
fd = os.open(os.path.join(OUT, 'contract.json'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(out, f, indent=1)
os.rmdir(CDIR)
print('contract: store->re-read %d/%d, independent re-extract %d/%d, exact 180.000 s %d/%d'
      % (out['summary']['store_reread_match'], len(res), out['summary']['independent_reextract_match'], len(res), out['summary']['exact_length'], len(res)))
