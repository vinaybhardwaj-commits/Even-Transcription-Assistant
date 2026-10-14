#!/usr/bin/env python3
"""listen5: fetch the five disagreement windows whole (15 min each) for V's ear.
Presigned URLs are credentials: never printed, logged or written. Prints durations only."""
import datetime, json, os, subprocess, sys, tempfile, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp, q
OUT = '/Users/vinaybhardwaj/dev/scratch/listen5'
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
iso = lambda ms: datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).isoformat()
hh = lambda ms: datetime.datetime.fromtimestamp(int(ms) / 1000, IST).strftime('%d %b %H:%M')
WINS = ['bw_yce79u6r_1789999200000_primary', 'bw_d4t5tvg9_1789986600000_primary', 'bw_maaacrdh_1790058600000_primary',
        'bw_zyjykmwa_1790057700000_primary', 'bw_m6nq7upz_1790057700000_primary']

def dur(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except ValueError: return None

def ts(iso_s):
    return datetime.datetime.fromisoformat(iso_s.replace('Z', '+00:00')).timestamp() * 1000

def chunk_at(sess, t_ms):
    """A 2-second request inside one chunk is not a join, so room_recording does not refuse it,
    and its link fetches the WHOLE chunk. Returns (url, start_ms, end_ms) or (None, reason)."""
    # A probe that straddles a chunk boundary becomes a join and is refused while rooms record, so
    # shrink it before giving up.
    for span in (2000, 300, 50):
        r = mcp.call('scribe_extract_audio', {'session_id': sess, 'start': iso(t_ms), 'end': iso(t_ms + span), 'source': 'primary'})
        if isinstance(r, dict) and r.get('ok'): break
    if not isinstance(r, dict) or not r.get('ok'): return None, str((r or {}).get('error'))[:40]
    cb = r.get('chunk_bounds') or {}
    url = r.get('presigned_get')
    if not url or not cb: return None, 'not_single_chunk'
    return (url, ts(cb['started_at']), ts(cb['ended_at'])), None

rows = q.q("select id, session_id, start_ms, end_ms from bench_window where id = any($1)", [WINS])['rows']
meta = {r['id']: r for r in rows}
prev = json.load(open(os.path.join(OUT, 'fetched.json'))) if os.path.exists(os.path.join(OUT, 'fetched.json')) else []
man = [m for m in prev if m.get('ok')]
done = {m['window_id'] for m in man}
with tempfile.TemporaryDirectory() as tmp:
    for i, wid in enumerate(WINS, 1):
        if wid in done: continue
        w = meta[wid]; a, b = int(w['start_ms']), int(w['end_ms']); want = (b - a) / 1000
        t = a; parts = []; err = None
        while t < b - 500:
            got, err = chunk_at(w['session_id'], t)
            if got is None: break
            url, cs, ce = got
            raw = os.path.join(tmp, 'w%d_%d.src' % (i, len(parts))); wav = raw + '.wav'
            with urllib.request.urlopen(url, timeout=600) as resp, open(raw, 'wb') as f: f.write(resp.read())
            if subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav], capture_output=True).returncode:
                err = 'decode'; break
            d = dur(wav); want_c = (ce - cs) / 1000
            parts.append({'wav': wav, 'start': cs, 'end': ce, 'dur': d, 'want': want_c})
            t = ce + 1
        if err or not parts:
            print('%d %s  NO AUDIO (%s)' % (i, hh(a), err)); continue
        bad_len = [p_ for p_ in parts if p_['dur'] is None or abs(p_['dur'] - p_['want']) > 1.5]
        gaps = [round((parts[k + 1]['start'] - parts[k]['end']) / 1000, 2) for k in range(len(parts) - 1)
                if abs(parts[k + 1]['start'] - parts[k]['end']) > 500]
        lst = os.path.join(tmp, 'w%d.txt' % i)
        with open(lst, 'w') as f: f.writelines("file '%s'\n" % p_['wav'] for p_ in parts)
        joined = os.path.join(tmp, 'w%d_joined.wav' % i)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', joined], capture_output=True)
        off = (a - parts[0]['start']) / 1000
        mp3 = os.path.join(OUT, 'audio', 'w%d.mp3' % i)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '%.3f' % off, '-i', joined, '-t', '%.3f' % want, '-ac', '1', '-b:a', '64k', mp3], capture_output=True)
        os.chmod(mp3, 0o600)
        got_s = dur(mp3)
        ok = got_s is not None and abs(got_s - want) < 2.0 and not bad_len and not gaps
        print('%d %s  chunks=%d  asked %.1f s  got %.1f s  offset=%.1f  chunk-length-mismatch=%d  gaps=%s  %s'
              % (i, hh(a), len(parts), want, got_s or -1, off, len(bad_len), gaps or 'none', 'OK' if ok else 'CHECK'))
        man.append({'n': i, 'window_id': wid, 'session_id': w['session_id'], 'start_ms': a, 'end_ms': b, 'audio': 'w%d.mp3' % i,
                    'asked_s': want, 'got_s': got_s, 'chunks': len(parts), 'gaps_s': gaps, 'ok': ok})
fd = os.open(os.path.join(OUT, 'fetched.json'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f: json.dump(man, f)
print('fetched %d of %d' % (len(man), len(WINS)))
