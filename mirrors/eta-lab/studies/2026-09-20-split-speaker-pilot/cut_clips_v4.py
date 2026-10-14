#!/usr/bin/env python3
"""Pilot v2 stage 2: cut one clip per TURN. Counts and IST clock times only on stdout.

ONE TURN, ONE CLIP. The question is a per-turn false-positive rate, so a clip is exactly the turn the
matcher made its claim about. scribe_extract_audio is asked for that turn's own span, which means the
returned audio IS the clip: nothing is sliced and there are no offsets that could drift. Turns longer
than the plan's cap were already capped in the manifest.

The presigned GET carries an R2 key and a signature. It is held in memory, handed to urlopen, and is
never printed, logged or written to a file. These are real patient consultations: no transcript text,
no patient or clinician name, no room label appears in any output, including the error paths.
"""
import datetime, json, os, subprocess, sys, tempfile, urllib.request, wave

DATA = '/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v4'
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
hhmm = lambda ms: datetime.datetime.fromtimestamp(int(ms) / 1000, IST).strftime('%H:%M:%S')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def iso(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).isoformat()


def fetch_span(clip, tmp, n):
    """Download+decode the object carrying one turn, and say WHERE in it the turn starts.

    joined=true  -> the object IS the requested span, so the turn starts at 0.
    otherwise    -> the object is the WHOLE CHUNK (5 minutes here) and the turn starts
                    offset_in_chunk_s into it. Taking the object as-is would hand the listener five
                    minutes from a chunk boundary instead of the turn — the wrong audio entirely, and
                    they would answer honestly about the wrong voice. Checked, never assumed.
    """
    import mcp
    try:
        r = mcp.call('scribe_extract_audio', {'session_id': clip['session_id'],
                                              'start': iso(clip['start_ms']), 'end': iso(clip['end_ms']),
                                              'source': 'primary'})
    except Exception as e:
        return None, type(e).__name__
    if not isinstance(r, dict) or not r.get('ok'):
        return None, str(r.get('error') if isinstance(r, dict) else 'bad_shape')[:32]
    c = r.get('clip') if isinstance(r.get('clip'), dict) else {}
    url = c.get('presigned_get') or r.get('presigned_get')
    if not url:
        return None, 'no_presigned_get'
    if r.get('joined'):
        base_ms = 0
    else:
        pieces = r.get('pieces') if isinstance(r.get('pieces'), list) else []
        off = (r.get('offset_in_chunk_s') or c.get('offset_in_chunk_s')
               or (pieces[0].get('offset_in_chunk_s') if pieces and isinstance(pieces[0], dict) else None))
        if off is None:
            return None, 'no_offset_in_chunk'
        base_ms = int(float(off) * 1000)
    raw, pcm = os.path.join(tmp, 's%d.src' % n), os.path.join(tmp, 's%d.wav' % n)
    try:
        with urllib.request.urlopen(url, timeout=300) as resp, open(raw, 'wb') as f:
            f.write(resp.read())
        p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-c:a', 'pcm_s16le', pcm], capture_output=True)
        if p.returncode != 0:
            return None, 'decode_rc%d' % p.returncode
    except Exception as e:
        return None, type(e).__name__
    return pcm, {'joined': bool(r.get('joined')), 'base_ms': base_ms,
                 'duration_ms': int(c.get('duration_ms') or 0)}


def main():
    man = json.load(open(os.path.join(DATA, 'manifest.json')))
    clips = man['clips']
    outdir = os.path.join(DATA, 'clips'); os.makedirs(outdir, exist_ok=True)
    # repeats share a span with their source: fetch each distinct span once
    spans = {}
    for c in clips:
        spans.setdefault((c['session_id'], c['start_ms'], c['end_ms']), []).append(c)
    print('manifest: %d clips over %d distinct turns' % (len(clips), len(spans)))

    written = failed = 0
    total_ms = 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, (key, group) in enumerate(sorted(spans.items(), key=lambda kv: kv[0][1]), 1):
            pcm, meta = fetch_span(group[0], tmp, i)
            if pcm is None:
                print('  turn %2d/%d %s: NO AUDIO (%s) -> %d clip(s) dropped'
                      % (i, len(spans), hhmm(key[1]), meta, len(group)))
                failed += len(group)
                continue
            with wave.open(pcm, 'rb') as w:
                nch, sw, fr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                body = w.readframes(nf)
            want_ms = key[2] - key[1]
            # cut the turn out of whatever the object turned out to be
            bpf = nch * sw
            a = max(0, int(meta['base_ms'] * fr / 1000)) * bpf
            b = min(len(body), a + int(want_ms * fr / 1000) * bpf)
            body = body[a:b]
            got_ms = int(len(body) / bpf * 1000 / fr)
            if abs(got_ms - want_ms) > 500:
                print('  turn %2d/%d %s: ALIGNMENT OFF (asked %.1fs, sliced %.1fs) -> %d clip(s) dropped'
                      % (i, len(spans), hhmm(key[1]), want_ms / 1000.0, got_ms / 1000.0, len(group)))
                failed += len(group)
                continue
            for c in group:
                try:
                    with wave.open(os.path.join(outdir, c['id'] + '.wav'), 'wb') as o:
                        o.setnchannels(nch); o.setsampwidth(sw); o.setframerate(fr); o.writeframes(body)
                    written += 1; total_ms += got_ms
                except Exception as e:
                    print('    clip %s: WRITE FAILED (%s)' % (c['id'], type(e).__name__)); failed += 1
            print('  turn %2d/%d %s: %.1fs asked, %.1fs got (%s) -> %d clip(s)'
                  % (i, len(spans), hhmm(key[1]), want_ms / 1000.0, got_ms / 1000.0,
                     'joined' if meta['joined'] else 'chunk+%.1fs' % (meta['base_ms'] / 1000.0), len(group)))

    missing = [c['id'] for c in clips if not os.path.isfile(os.path.join(outdir, c['id'] + '.wav'))]
    print('done: %d written, %d failed; %.1f min of audio' % (written, failed, total_ms / 60000.0))
    print('      readiness: %d/%d present%s' % (len(clips) - len(missing), len(clips),
                                                '' if not missing else ' -> page will NOT render'))
    sys.exit(0 if written and not missing else 1)


if __name__ == '__main__':
    main()
