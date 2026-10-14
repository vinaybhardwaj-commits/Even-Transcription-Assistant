#!/usr/bin/env python3
"""Pick the pilot day BY COUNT: among diarized room-days of the room named on the command line, the day with the most
labels of >= 20 s that have a same-window partner whose diarizer-embedding cosine is above the ceiling (0.545).
Prints counts and ids only. Reads speaker embeddings in memory; prints no embedding and no cosine list."""
import base64, itertools, json, math, struct, sys
from q import q
ROOM, CEIL, MIN_SEC = sys.argv[1], 0.545, 20.0
r = q("""select d.window_id, w.room_day_id, w.session_id, w.start_ms, d.speakers_json
         from room_diarize_window d join bench_window w on w.id = d.window_id join room_day rd on rd.id = w.room_day_id
         where d.state = 'ok' and rd.room_id = $1 and jsonb_typeof(d.speakers_json) = 'array' order by w.room_day_id, w.start_ms""", [ROOM])
rows = r['rows'] if isinstance(r, dict) else r
def dec(b):
    raw = base64.b64decode(b); x = struct.unpack('<%df' % (len(raw) // 4), raw); n = math.sqrt(sum(t * t for t in x)); return [t / n for t in x]
days = {}
for row in rows:
    sp = row['speakers_json'] if isinstance(row['speakers_json'], list) else json.loads(row['speakers_json'])
    S = [(s['idx'], float(s.get('total_speech_sec') or 0), dec(s['embedding_base64'])) for s in sp if s.get('embedding_base64')]
    d = days.setdefault(row['room_day_id'], dict(windows=0, qualifying=0, pairs=0, labels20=0))
    d['windows'] += 1
    d['labels20'] += sum(1 for s in S if s[1] >= MIN_SEC)
    hit = set()
    for a, b in itertools.combinations(S, 2):
        if sum(x * y for x, y in zip(a[2], b[2])) > CEIL:
            d['pairs'] += 1
            for s in (a, b):
                if s[1] >= MIN_SEC: hit.add(s[0])
    d['qualifying'] += len(hit)
print('room days diarized:', len(days))
for k, v in sorted(days.items(), key=lambda kv: -kv[1]['qualifying'])[:8]:
    print(k, v)
