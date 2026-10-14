#!/usr/bin/env python3
"""v6 pair-mode self-test. Two parts:
   A. synthetic pairs in a temp dir  — the mechanics (state shape, audio reachability, path games)
   B. the REAL v6 manifest, loopback port 0 — the blindness check, torn down immediately.
No network beyond 127.0.0.1, no database, no tailnet bind."""
import array, json, math, os, secrets, tempfile, urllib.request, urllib.error, wave
import serve

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, 'page_v6.html')
REAL = '/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot-v6'
ok = fail = 0
def check(name, cond):
    global ok, fail
    print(('PASS ' if cond else 'FAIL ') + name)
    if cond: ok += 1
    else: fail += 1

def tone(path, hz):
    x = array.array('h', [int(6000 * math.sin(2 * math.pi * hz * t / 16000)) for t in range(16000)])
    with wave.open(path, 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(x.tobytes())

def getter(B):
    def get(p, hdr=None): return urllib.request.urlopen(urllib.request.Request(B + p, headers=hdr or {}), timeout=10)
    return get
def status(fn):
    try: return fn().status
    except urllib.error.HTTPError as e: return e.code

# ---------- A. synthetic ----------
tmp = tempfile.mkdtemp(prefix='vc6_'); os.makedirs(tmp + '/clips')
clips = ['k' + secrets.token_hex(4) for _ in range(6)]
for i, k in enumerate(clips): tone('%s/clips/%s.wav' % (tmp, k), 300 + 20 * i)
pairs = [{'id': 'p' + secrets.token_hex(4), 'a': clips[0], 'b': clips[1], 'kind': 'same',      'truth': 'SECRET_TRUTH'},
         {'id': 'p' + secrets.token_hex(4), 'a': clips[2], 'b': clips[3], 'kind': 'different', 'truth': 'SECRET_TRUTH'},
         {'id': 'p' + secrets.token_hex(4), 'a': clips[4], 'b': clips[4], 'kind': 'identity',  'truth': 'SECRET_TRUTH'}]
order = [p['id'] for p in pairs]
json.dump({'kind': 'pairs', 'order': order, 'pairs': pairs,
           'pairmap': {p['id']: [p['a'], p['b']] for p in pairs},
           'clips': [{'id': k, 'doctor': 'SECRET_NAME', 'wid': 'bw_SECRET', 'spk': 3, 'session_id': 'ses_SECRET'} for k in clips]},
          open(tmp + '/manifest.json', 'w'))
store, servers = serve.serve(tmp, 0, ['127.0.0.1'], PAGE)
port = servers[0].server_address[1]; get = getter('http://127.0.0.1:%d/v/%s' % (port, store.token))
st = json.load(get('/api/state')); html = get('/').read().decode()

check('state is the pair state and nothing more', set(st) == {'order', 'answers', 'clinician', 'ready', 'pairs'})
check('the order is pair ids, never clip ids', st['order'] == order and not set(st['order']) & set(clips))
check('every pair resolves to exactly two clip ids', all(len(st['pairs'][p]) == 2 for p in order))
check('the identity pair is the same id twice (the floor check)', st['pairs'][order[2]][0] == st['pairs'][order[2]][1])
check('ready is true when every clip behind every pair is on disk', st['ready'] is True)
check('both members of a pair play', get('/audio/%s.wav' % clips[0]).status == 200 and get('/audio/%s.wav' % clips[1]).status == 200)
check('a clip outside every pair is refused', status(lambda: get('/audio/k00000000.wav')) == 404)
check('the manifest is not reachable through the audio route', status(lambda: get('/audio/..%2fmanifest.json')) == 404)
check('a pair id is not an audio id', status(lambda: get('/audio/%s.wav' % order[0])) == 404)
check('answers are keyed by pair, and a clip id is not an answerable id',
      urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/v/%s/api/answer' % (port, store.token),
        data=json.dumps({'id': order[0], 'answer': 'me'}).encode(), headers={'Content-Type': 'application/json'}), timeout=10).status == 200
      and status(lambda: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:%d/v/%s/api/answer' % (port, store.token),
        data=json.dumps({'id': clips[0], 'answer': 'me'}).encode(), headers={'Content-Type': 'application/json'}), timeout=10)) == 400)
everything = html + json.dumps(st)
for bad in ['SECRET', 'doctor', 'session', 'spk', 'truth']:
    check('page + state never contain %r' % bad, bad.lower() not in everything.lower())
# 'wid' and 'kind' are checked as JSON KEYS, not as substrings: the page's own CSS says "width".
for bad in ['wid', 'kind', 'spk', 'segs']:
    check('state never carries a %r field' % bad, ('"%s"' % bad) not in json.dumps(st))
for s in servers: s.shutdown()

# ---------- B. the real manifest ----------
man = json.load(open(REAL + '/manifest.json'))
store2, servers2 = serve.serve(REAL, 0, ['127.0.0.1'], PAGE)
port2 = servers2[0].server_address[1]; get2 = getter('http://127.0.0.1:%d/v/%s' % (port2, store2.token))
st2 = json.load(get2('/api/state')); html2 = get2('/').read().decode()
blob = json.dumps(st2)                      # the kind words live in the page copy, so kinds are checked against STATE only
both = html2 + blob
names = sorted({c['doctor'] for c in man['clips']})
check('real: every doctor name is absent from page and state', not any(n.lower() in both.lower() for n in names))
check('real: no window, session or speaker identifier is in page or state',
      not any(t in both for t in [c['wid'] for c in man['clips']] + [c['session_id'] for c in man['clips']]))
check('real: the answer key (kind / truth / note) never reaches the state',
      not any(w in blob for w in ['same', 'different', 'open', 'identity', 'truth', 'note', 'doctor']))
check('real: the state is order + pairs + own answers + ready, nothing else', set(st2) == {'order', 'answers', 'clinician', 'ready', 'pairs'})
check('real: 28 pairs are ready and every clip behind them is on disk', len(st2['order']) == 28 and st2['ready'] is True)
check('real: the page renders no name anywhere', 'S.names' not in html2 and 'Dr ' not in html2)
check('real: the key on disk is 0600', oct(os.stat(REAL + '/manifest.json').st_mode & 0o777) == '0o600')
check('real: no answer has been recorded yet (nothing has been served)', not os.path.exists(REAL + '/answers.jsonl'))
for s in servers2: s.shutdown()

print('\n%d checks passed, %d failed' % (ok, fail))
raise SystemExit(1 if fail else 0)
