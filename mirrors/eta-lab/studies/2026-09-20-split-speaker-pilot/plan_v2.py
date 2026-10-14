#!/usr/bin/env python3
"""Pilot v2 selection (no audio): choose CLAIMED and CONTROL turns and write the server-side key.

THE QUESTION. Of the turns where the matcher names a clinician, how many are actually that person —
a false-positive rate on real clinical audio. So the unit is ONE TURN per clip: concatenating turns
would hide which turn was wrong, and the rate is per turn.

WHY THERE ARE CONTROLS. Without them a listener says yes to everything and we measure nothing. The
controls are turns the matcher did NOT name, from the same room, the same day, the SAME TIME BAND as
the claims, and duration-matched — so the only thing separating the two sets is the claim itself.
Drawing controls from a different hour would let the listener sort them by room noise instead of by
voice, and we would learn nothing about the matcher.

DURATION FLOOR. Claimed turns have a median of 1.7 s, which is too short to judge a voice; the floor
keeps a clip long enough to be answerable and still leaves a real choice of which to take.

Prints counts and IST clock times only. No transcript text, no name, no room label.
"""
import datetime, json, os, random, secrets, sys
from q import q

ROOM, DAY = 'room_87frpus9', '2026-09-19'
OUT = '/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v2'
N_CLAIMED, N_CONTROL, N_REPEAT = 14, 8, 3
CLAIM_MIN_MS, CTRL_MIN_MS = 4000, 3000
# A turn can run minutes (one claimed is 203 s, one unnamed 226 s) — almost certainly a
# mis-segmented block, and two of those alone would eat a third of the listening session. Cap what
# is CUT at the first MAX_MS, and match durations on the capped length, which is what is heard.
MAX_MS = 20000
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
ist = lambda ms: datetime.datetime.fromtimestamp(int(ms) / 1000, IST)
hhmm = lambda ms: ist(ms).strftime('%H:%M:%S')


def fetch():
    r = q("""select t.clinician_id is not null as named,
                    split_part(t.source_ref,'|',1) as session_id,
                    split_part(t.source_ref,'|',2)::bigint as s_ms,
                    split_part(t.source_ref,'|',3)::bigint as e_ms
             from room_turn_speaker t join room_day rd on rd.id = t.room_day_id
             where rd.room_id = $1 and rd.ist_date = $2::date""", [ROOM, DAY])
    rows = r['rows'] if isinstance(r, dict) and 'rows' in r else r
    if not isinstance(rows, list):
        print('BLOCKED: could not read turns'); sys.exit(2)
    out = []
    for x in rows:
        s, e = int(x['s_ms']), int(x['e_ms'])
        d = e - s
        out.append(dict(named=bool(x['named']), session_id=x['session_id'], start_ms=s,
                        end_ms=min(e, s + MAX_MS), dur_ms=min(d, MAX_MS), full_ms=d))
    return out


def spread(pool, n):
    """n turns spread evenly over the band: the longest turn in each of n equal time strata."""
    pool = sorted(pool, key=lambda x: x['start_ms'])
    lo, hi = pool[0]['start_ms'], pool[-1]['start_ms']
    picked, used = [], set()
    for i in range(n):
        a = lo + (hi - lo) * i // n
        b = lo + (hi - lo) * (i + 1) // n
        band = [x for x in pool if a <= x['start_ms'] <= b and id(x) not in used]
        if band:
            best = max(band, key=lambda x: x['dur_ms'])
            picked.append(best); used.add(id(best))
    for x in sorted(pool, key=lambda x: -x['dur_ms']):      # top up if a stratum was empty
        if len(picked) >= n: break
        if id(x) not in used: picked.append(x); used.add(id(x))
    return sorted(picked, key=lambda x: x['start_ms'])


def main():
    rows = fetch()
    claimed_all = [x for x in rows if x['named']]
    lo = min(x['start_ms'] for x in claimed_all); hi = max(x['start_ms'] for x in claimed_all)
    print('day %s %s | %d turns, %d claimed, %d unnamed'
          % (DAY, ist(lo).strftime('%A'), len(rows), len(claimed_all), len(rows) - len(claimed_all)))
    print('CLAIMED BAND: %s .. %s IST (span %d min) — every claim on this day falls inside it'
          % (hhmm(lo), hhmm(hi), (hi - lo) // 60000))

    cpool = [x for x in claimed_all if x['dur_ms'] >= CLAIM_MIN_MS]
    claimed = spread(cpool, N_CLAIMED)
    print('claimed pool >=%.1fs: %d -> selected %d' % (CLAIM_MIN_MS / 1000, len(cpool), len(claimed)))

    # controls: same band, duration-matched to the claims we actually took
    pool = [x for x in rows if not x['named'] and x['dur_ms'] >= CTRL_MIN_MS and lo <= x['start_ms'] <= hi]
    targets = sorted((c['dur_ms'] for c in claimed))
    targets = [targets[round(i * (len(targets) - 1) / max(1, N_CONTROL - 1))] for i in range(N_CONTROL)]
    controls, used = [], set()
    for t in targets:
        cand = [x for x in pool if id(x) not in used]
        if not cand: break
        best = min(cand, key=lambda x: abs(x['dur_ms'] - t))
        controls.append(best); used.add(id(best))
    print('control pool in-band >=%.1fs: %d -> selected %d' % (CTRL_MIN_MS / 1000, len(pool), len(controls)))

    clips = []
    for x in claimed: clips.append(dict(x, kind='claimed', repeat_of=None))
    for x in controls: clips.append(dict(x, kind='control', repeat_of=None))
    for c in clips: c['id'] = 'k' + secrets.token_hex(4)

    rnd = random.Random(20260920)
    for src in rnd.sample(clips, N_REPEAT):                 # unmarked repeats, own opaque ids
        clips.append(dict(src, id='k' + secrets.token_hex(4), kind=src['kind'], repeat_of=src['id']))

    order = [c['id'] for c in clips]
    rnd.shuffle(order)
    os.makedirs(OUT, exist_ok=True)
    man = dict(day=DAY, room_day_id=None, clips=clips, order=order)
    path = os.path.join(OUT, 'manifest.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(man, f)

    n_c = sum(1 for c in clips if c['kind'] == 'claimed'); n_k = sum(1 for c in clips if c['kind'] == 'control')
    print('\nSELECTED %d clips: %d claimed, %d control (%d of them repeats), shuffled'
          % (len(clips), n_c, n_k, N_REPEAT))
    print('TIMING CHECK — IST clock time of every selected clip, in time order:')
    for c in sorted(clips, key=lambda x: x['start_ms']):
        print('  %s  %5.1fs  %-7s%s%s' % (hhmm(c['start_ms']), c['dur_ms'] / 1000.0, c['kind'],
                                          '  (repeat)' if c['repeat_of'] else '',
                                          '  [capped from %.0fs]' % (c['full_ms'] / 1000.0) if c['full_ms'] > c['dur_ms'] else ''))
    e_lo, e_hi = min(c['start_ms'] for c in clips), max(c['start_ms'] for c in clips)
    print('selected span: %s .. %s IST' % (hhmm(e_lo), hhmm(e_hi)))
    print('total listening: %.1f min of audio across %d clips' % (sum(c['dur_ms'] for c in clips)/60000.0, len(clips)))
    print('durations: claimed %.1f-%.1fs, control %.1f-%.1fs'
          % (min(c['dur_ms'] for c in clips if c['kind'] == 'claimed') / 1000,
             max(c['dur_ms'] for c in clips if c['kind'] == 'claimed') / 1000,
             min(c['dur_ms'] for c in clips if c['kind'] == 'control') / 1000,
             max(c['dur_ms'] for c in clips if c['kind'] == 'control') / 1000))


if __name__ == '__main__':
    main()
