#!/usr/bin/env python3
"""E-4 eval — a SHAPE CHECK, not an accuracy claim: there is no labelled ground truth until V's session.

Runs the COMMITTED gate + smoother (bundled from vinay/encounter-clock by esbuild into driver.cjs) over
whole room-days, read-only. Energy comes from the original chunks decoded to 20 ms RMS frames (each stretch
of clock from ONE chunk, earliest first — r5's overlap rule). Transcript evidence is the stored window text
placed on the clock by splitWindowText; it goes to the driver over stdin only and is never written down.

Activity reference (Fable, 22:50): tape/chunk continuity plus per-chunk level peaks. Stored chunk levels do
not exist (11 of 11,287 chunks in 21 days, none since 17 Sep), so the per-chunk peak is taken from the
decoded audio — which makes the level reference NOT independent of the gate's energy half. Continuity is.
Output: counts and times only, 0600, ~/dev/_fable/scratch/e4-eval/."""
import base64, datetime, json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp, q

OUT = '/Users/vinaybhardwaj/dev/_fable/scratch/e4-eval'
DRIVER = os.path.join(OUT, 'driver.cjs')
SR, FRAME_MS, PROBE_MS, HOP_MS = 16000, 20, 180_000, 60_000
MIN_FRAME_COVERAGE = 0.8                     # as the gate's LEVEL_MIN_COVERAGE: partial audio is not evidence
TAPE_GAP_MS = 5_000                          # chunks closer than this are one continuous tape
MERGE_GAPS = [120_000, 180_000, 300_000]
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat()
ts = lambda s: datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00')).timestamp() * 1000
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
hh = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, IST).strftime('%H:%M')

def wjson(name, obj):
    p = os.path.join(OUT, name); fd = os.open(p + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(p + '.tmp', p)

def chunk_audio(sess, start_ms):
    for span in (2000, 300, 50):
        r = mcp.call('scribe_extract_audio', {'session_id': sess, 'start': iso(start_ms + 1000), 'end': iso(start_ms + 1000 + span), 'source': 'primary'})
        if isinstance(r, dict) and r.get('ok') and r.get('presigned_get') and r.get('chunk_bounds'): break
    else:
        return None
    with urllib.request.urlopen(r['presigned_get'], timeout=300) as resp: blob = resp.read()
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', str(SR), '-f', 'f32le', 'pipe:1'], input=blob, capture_output=True)
    x = np.frombuffer(p.stdout, dtype=np.float32)
    n = SR * FRAME_MS // 1000; k = len(x) // n
    rms = np.sqrt(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1)).astype(np.float32) if k else np.zeros(0, np.float32)
    return {'start_ms': ts(r['chunk_bounds']['started_at']), 'end_ms': ts(r['chunk_bounds']['ended_at']), 'rms': rms,
            'peak': float(np.max(np.abs(x))) if len(x) else 0.0, 'chunk_rms': float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0}

def run_day(rd):
    t0 = time.time()
    rows = q.q("""select c.session_id, c.idx, c.started_at, c.ended_at from bench_chunk c
                   where c.session_id in (select distinct session_id from bench_window where room_day_id=$1)
                     and coalesce(c.source,'primary')='primary' order by c.started_at""", [rd])['rows']
    with ThreadPoolExecutor(4) as ex:
        audio = list(ex.map(lambda r: chunk_audio(r['session_id'], ts(r['started_at'])), rows))
    ch = sorted([a for a in audio if a], key=lambda a: a['start_ms'])
    failed = sum(1 for a in audio if not a)
    day0, day1 = ch[0]['start_ms'], max(a['end_ms'] for a in ch)
    # dense frame timeline, NaN = no audio; earliest chunk wins an overlap
    nfr = int((day1 - day0) // FRAME_MS) + 1
    fr = np.full(nfr, np.nan, dtype=np.float32)
    for a in ch:
        i0 = int(round((a['start_ms'] - day0) / FRAME_MS)); seg = a['rms'][: max(0, nfr - i0)]
        tgt = fr[i0:i0 + len(seg)]; empty = np.isnan(tgt); tgt[empty] = seg[empty]
    # tape-on stretches from chunk continuity
    tape = []
    for a in ch:
        if tape and a['start_ms'] - tape[-1][1] <= TAPE_GAP_MS: tape[-1][1] = max(tape[-1][1], a['end_ms'])
        else: tape.append([a['start_ms'], a['end_ms']])
    # probes over the whole day
    probes = []; t = day0
    while t + PROBE_MS <= day1:
        i0 = int((t - day0) // FRAME_MS); seg = fr[i0:i0 + PROBE_MS // FRAME_MS]; ok = seg[~np.isnan(seg)]
        cov = len(ok) / (PROBE_MS / FRAME_MS)
        probes.append({'start_ms': t, 'end_ms': t + PROBE_MS,
                       'frames_b64': base64.b64encode(ok.astype('<f4').tobytes()).decode() if cov >= MIN_FRAME_COVERAGE else None})
        t += HOP_MS
    win = q.q("""select distinct on (w.id) w.start_ms, w.end_ms, t.transcript_original as txt, t.metrics_json->'language_timeline' as lt
                   from bench_window w join transcription_run t on t.subject_type='bench_window' and t.subject_id=w.id
                  where w.room_day_id=$1 and coalesce(t.transcript_original,'')<>'' order by w.id, t.created_at desc""", [rd])['rows']
    windows = []
    for w in win:
        lt = w['lt'] if isinstance(w['lt'], dict) else (json.loads(w['lt']) if w['lt'] else None)
        windows.append({'start_ms': int(w['start_ms']), 'end_ms': int(w['end_ms']), 'text': w['txt'],
                        'timeline': [{'start_s': float(s['start_s']), 'end_s': float(s['end_s']), 'chars': int(s['chars'])} for s in lt['spans']] if lt and lt.get('spans') else None})
    tape_off = [{'start_ms': tape[i][1], 'end_ms': tape[i + 1][0]} for i in range(len(tape) - 1)]
    payload = json.dumps({'probes': probes, 'windows': windows, 'tape_off': tape_off, 'merge_gaps_ms': MERGE_GAPS}).encode()
    del windows, win                                                   # the text lives only in this pipe
    p = subprocess.run(['node', DRIVER], input=payload, capture_output=True)
    if p.returncode: raise SystemExit('driver failed: %s' % p.stderr.decode()[:300])
    res = json.loads(p.stdout)
    return summarise(rd, res, ch, tape, failed, day0, day1, time.time() - t0, tape_off)

def summarise(rd, res, ch, tape, failed, day0, day1, wall, tape_off):
    V = res['verdicts']; n = len(V)
    from collections import Counter
    verdict = Counter(v['verdict'] for v in V); reason = Counter(v['reason'] for v in V)
    tape_ms = sum(b - a for a, b in tape)
    in_tape = lambda a, b: sum(max(0, min(b, y) - max(a, x)) for x, y in tape)
    peak_db = np.array([20 * np.log10(max(a['peak'], 1e-9)) for a in ch])
    quiet_chunks = [(a['start_ms'], a['end_ms']) for a in ch if 20 * np.log10(max(a['peak'], 1e-9)) < -40]
    per_gap = {}
    for gap, E in res['smoothed'].items():
        dur = [(e['end_ms'] - e['start_ms']) / 60000 for e in E]; tot = sum(e['end_ms'] - e['start_ms'] for e in E)
        bridging = sum(1 for e in E if in_tape(e['start_ms'], e['end_ms']) < (e['end_ms'] - e['start_ms']) - 60_000)
        quiet_ms = sum(max(0, min(e['end_ms'], y) - max(e['start_ms'], x)) for e in E for x, y in quiet_chunks)
        closed = Counter(e['closed_by'] for e in E)
        per_gap[str(int(gap) // 60000) + '_min'] = {
            'closed_by': dict(closed),
            'encounters': len(E), 'total_min': round(tot / 60000, 1),
            'median_min': round(float(np.median(dur)), 1) if dur else None, 'max_min': round(max(dur), 1) if dur else None,
            'share_of_tape_on': round(tot / tape_ms, 3) if tape_ms else None,
            'inside_tape_on_share': round(sum(in_tape(e['start_ms'], e['end_ms']) for e in E) / tot, 3) if tot else None,
            'encounters_bridging_a_tape_gap': bridging,
            'minutes_over_near_silent_chunks': round(quiet_ms / 60000, 1),
            'closed_by_end_of_input': sum(1 for e in E if e['closed_by'] == 'end_of_input'),
            'unjudged_min_inside': round(sum(e['unjudged_ms'] for e in E) / 60000, 1)}
    s = {'room_day_id': rd, 'shape_check_not_accuracy': True, 'gate_version': res['gate_version'], 'smoother_version': res['smoother_version'],
         'day_ist': [hh(day0), hh(day1)], 'chunks_decoded': len(ch), 'chunks_failed': failed,
         'tape_on': {'stretches': len(tape), 'minutes': round(tape_ms / 60000, 1), 'gaps_over_5s': len(tape) - 1},
         'chunk_audio_peak_dbfs_p10_p50_p90': [round(float(np.percentile(peak_db, p)), 1) for p in (10, 50, 90)],
         'transcript_windows': {'placed': res['windows_placed'], 'unplaceable': res['windows_unplaceable']},
         'bridge_unjudged_max_ms': res.get('bridge_unjudged_max_ms'), 'tape_off_stretches': len(tape_off),
         'probes': n, 'verdicts': {k: verdict.get(k, 0) for k in ('speech', 'non_speech', 'unjudged')},
         'unjudged_fraction': round(verdict.get('unjudged', 0) / n, 3) if n else None,
         'reasons': dict(reason.most_common()), 'by_merge_gap': per_gap, 'wall_s': round(wall, 1)}
    wjson('e4-%s.json' % rd, {'summary': s, 'verdicts': V, 'smoothed': res['smoothed'], 'tape_on': tape})
    return s

if __name__ == '__main__':
    out = [run_day(rd) for rd in sys.argv[1:]]
    wjson('e4-summary.json', out)
    for s in out: print(json.dumps(s))
