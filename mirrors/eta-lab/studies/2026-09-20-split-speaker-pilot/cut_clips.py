#!/usr/bin/env python3
"""Stage 2: cut the pilot's clips. Prints counts and alignment offsets only.

SOURCE IS scribe_extract_audio on the Scribe MCP — one call per WINDOW, by the window's own clock
time, answered with a short-lived presigned GET. R2 keys stay server-side by design; this box never
holds them. manifest.clips[].segs are millisecond offsets measured from the WINDOW START, so the
audio must be the window's own span and the offsets are applied from its first sample.

ALIGNMENT IS CHECKED, NOT ASSUMED. `joined:true` means the answer is the requested span and offset 0
is the window start. A single-chunk answer instead carries `offset_in_chunk_s`, and the object is the
whole CHUNK — so that offset is added to every seg. Getting this wrong shifts every clip silently,
which is the one failure nobody downstream could detect: V would hear the wrong half-second and
answer honestly about the wrong speaker. A window whose audio is short of its own segs is reported.

A window whose clip_r2_key is NULL has its clips DROPPED and counted. No substitute source, ever —
a pilot of 19 real clips is fine; a pilot with two clips cut from the wrong audio is worthless and we
would not know which two.

CONCATENATE, do not pick the longest run: the question is "is this the same person as me", and more
speech is a better sample. Segments are joined in TIME ORDER with a short silence between so the
joins are audible rather than disguised as one continuous take. Capped at CAP_S of speech, taking the
longest segments first and then restoring time order for playback.

NO PROCESSING. The source is decoded once to PCM and sliced sample-exactly; there is no
normalisation, filtering, noise reduction or resampling. V is judging a voice — do not touch it.

PRIVACY. stdout carries counts and offsets ONLY. A presigned URL is a short-lived credential and is
never printed, logged or written down. Never a window id, session id, R2 key, room,
clinician or patient name, or any path that identifies a patient — not in output, not in an error.
The opaque clip id the manifest already uses is the one identifier allowed, since it is opaque by
construction and is the filename serve.py expects.
"""
import datetime, json, os, re, subprocess, sys, tempfile, urllib.error, urllib.request, wave

DATA = '/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot'
ENV = '/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/.env.local'
CAP_S = 25.0          # max concatenated speech per clip (order, 20 Sep)
EXTRACT_TOOL = 'scribe_extract_audio'   # returns a presigned GET for a window's span, 3600s expiry
JOIN_SILENCE_MS = 400  # audible seam between segments

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from q import q


def env(name):
    """Read one var from .env.local in-process. The VALUE is never printed."""
    try:
        for line in open(ENV):
            m = re.match(r'\s*%s\s*=\s*"?([^"\n]*)"?' % re.escape(name), line)
            if m:
                return m.group(1).strip()
    except OSError:
        return None
    return None


def iso(ms):
    """Epoch ms -> absolute UTC instant. The tool reads an instant; UTC avoids any IST ambiguity."""
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()


def window_audio(clip):
    """{url, base_ms, duration_ms} for one window, or None. NEVER returns or prints the URL to stdout.

    The presigned GET carries an R2 key and a signature: it is a credential. It is held in memory,
    handed to urlopen, and never printed, logged or written to a file.
    """
    import mcp
    r = mcp.call(EXTRACT_TOOL, {'session_id': clip['session_id'],
                                'start': iso(clip['start_ms']), 'end': iso(clip['end_ms']),
                                'source': 'primary'})
    if not isinstance(r, dict) or not r.get('ok'):
        return None, str(r.get('error') if isinstance(r, dict) else 'bad_shape')[:40]
    clip_o = r.get('clip') if isinstance(r.get('clip'), dict) else {}
    url = clip_o.get('presigned_get') or r.get('presigned_get') or clip_o.get('url') or r.get('url')
    if not url:
        return None, 'no_presigned_get'
    # joined => the object IS the requested span, so segs are measured from its first sample.
    # single chunk => the object is the whole CHUNK and the span begins offset_in_chunk_s into it,
    # so that offset is added to every seg. Checked, never assumed: getting it wrong shifts silently.
    if r.get('joined'):
        base_ms = 0
    else:
        pieces = r.get('pieces') if isinstance(r.get('pieces'), list) else []
        off = (r.get('offset_in_chunk_s') or clip_o.get('offset_in_chunk_s')
               or (pieces[0].get('offset_in_chunk_s') if pieces and isinstance(pieces[0], dict) else 0))
        base_ms = int(float(off or 0) * 1000)
    duration_ms = int(clip_o.get('duration_ms') or r.get('duration_ms') or 0)
    return {'url': url, 'base_ms': base_ms, 'duration_ms': duration_ms,
            'joined': bool(r.get('joined'))}, None


def decode_to_pcm(src_path, dst_path):
    """Decode to PCM s16le, preserving rate and channels. No filters, no normalisation."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src_path, '-c:a', 'pcm_s16le', dst_path],
                       capture_output=True)
    if p.returncode != 0:
        raise RuntimeError('decode failed (ffmpeg rc=%d)' % p.returncode)


def pick_segs(segs, cap_s):
    """Longest segments first up to the cap, then restored to TIME ORDER for playback."""
    ordered = sorted(segs, key=lambda s: (s[1] - s[0]), reverse=True)
    kept, total_ms, cap_ms = [], 0, int(cap_s * 1000)
    for s in ordered:
        d = s[1] - s[0]
        if total_ms + d > cap_ms and kept:
            continue
        kept.append(s)
        total_ms += d
    return sorted(kept, key=lambda s: s[0]), total_ms


def main():
    man = json.load(open(os.path.join(DATA, 'manifest.json')))
    clips = man['clips']
    by_window = {}
    for c in clips:
        by_window.setdefault(c['window_id'], []).append(c)
    print('manifest: %d clips over %d windows' % (len(clips), len(by_window)))

    rows = q('select id, clip_r2_key from bench_window where id = any($1)', [sorted(by_window)])
    rows = rows['rows'] if isinstance(rows, dict) and 'rows' in rows else rows
    if not isinstance(rows, list):
        print('BLOCKED: could not read clip keys from the database')
        sys.exit(2)
    keys = {r['id']: r['clip_r2_key'] for r in rows}

    dropped = [c for c in clips if not keys.get(c['window_id'])]
    todo_windows = [w for w in by_window if keys.get(w)]
    print('keys: %d resolved, %d null -> %d clip(s) dropped, %d to cut'
          % (len(todo_windows), len(by_window) - len(todo_windows), len(dropped), len(clips) - len(dropped)))

    outdir = os.path.join(DATA, 'clips')
    os.makedirs(outdir, exist_ok=True)

    written = failed = capped = 0
    speech_ms = out_ms = 0
    with tempfile.TemporaryDirectory() as tmp:
        for wi, wid in enumerate(sorted(todo_windows), 1):
            raw = os.path.join(tmp, 'w%d.src' % wi)
            pcm = os.path.join(tmp, 'w%d.wav' % wi)
            info, why = window_audio(by_window[wid][0])
            if info is None:
                n = len(by_window[wid])
                print('  window %d/%d: NO AUDIO (%s) -> %d clip(s) dropped' % (wi, len(todo_windows), why, n))
                failed += n
                continue
            base_ms = info['base_ms']
            try:
                with urllib.request.urlopen(info['url'], timeout=300) as r, open(raw, 'wb') as f:
                    f.write(r.read())
                decode_to_pcm(raw, pcm)
            except Exception as e:
                # No key, no path, no id — only the failure class and how many clips it costs.
                n = len(by_window[wid])
                print('  window %d/%d: FETCH/DECODE FAILED (%s) -> %d clip(s) not cut'
                      % (wi, len(todo_windows), type(e).__name__, n))
                failed += n
                continue

            with wave.open(pcm, 'rb') as w:
                nch, sw, fr, nframes = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
                pcm_bytes = w.readframes(nframes)
            dur_ms = int(nframes * 1000 / fr)
            print('  window %d/%d: decoded %.1fs @ %dHz %dch (%s, base %dms, tool said %.1fs)'
                  % (wi, len(todo_windows), dur_ms / 1000.0, fr, nch,
                     'joined' if info['joined'] else 'single-chunk', base_ms, info['duration_ms'] / 1000.0))
            bpf = nch * sw
            silence = b'\x00' * (int(fr * JOIN_SILENCE_MS / 1000) * bpf)

            for c in by_window[wid]:
                kept, kept_ms = pick_segs(c['segs'], CAP_S)
                if len(kept) < len(c['segs']):
                    capped += 1
                pieces, offs, clipped = [], [], False
                for a0, b0 in kept:
                    a, b = a0 + base_ms, b0 + base_ms
                    sa, sb = max(0, int(a * fr / 1000)) * bpf, min(nframes, int(b * fr / 1000)) * bpf
                    if sb <= sa:
                        continue
                    if b > dur_ms:
                        clipped = True
                    pieces.append(pcm_bytes[sa:sb])
                    offs.append('%d-%d' % (a0, b0))
                if not pieces:
                    print('    clip %s: no audio at its offsets -> NOT written' % c['id'])
                    failed += 1
                    continue
                body = silence.join(pieces)
                try:
                    with wave.open(os.path.join(outdir, c['id'] + '.wav'), 'wb') as o:
                        o.setnchannels(nch); o.setsampwidth(sw); o.setframerate(fr)
                        o.writeframes(body)
                except Exception as e:
                    print('    clip %s: WRITE FAILED (%s)' % (c['id'], type(e).__name__))
                    failed += 1
                    continue
                written += 1
                speech_ms += kept_ms
                out_ms += int(len(body) / bpf * 1000 / fr)
                print('    clip %s: %d seg(s) %.1fs speech, offsets ms [%s]%s'
                      % (c['id'], len(kept), kept_ms / 1000.0, ' '.join(offs), ' PAST-END' if clipped else ''))

    print('done: %d written, %d dropped (null key), %d failed, %d capped at %.0fs'
          % (written, len(dropped), failed, capped, CAP_S))
    print('      %.1fs speech, %.1fs with joins (%dms seams)' % (speech_ms / 1000.0, out_ms / 1000.0, JOIN_SILENCE_MS))
    missing = [c['id'] for c in clips if not os.path.isfile(os.path.join(outdir, c['id'] + '.wav'))]
    print('      serve.py readiness: %d/%d present%s'
          % (len(clips) - len(missing), len(clips), '' if not missing else ' -> page will NOT render'))
    sys.exit(0 if written and not missing else 1)


if __name__ == '__main__':
    main()
