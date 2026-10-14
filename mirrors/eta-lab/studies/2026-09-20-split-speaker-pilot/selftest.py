#!/usr/bin/env python3
"""Self-test on SYNTHETIC tones in a temp dir: no database, no real audio, no network beyond 127.0.0.1."""
import array, json, math, os, secrets, tempfile, urllib.request, urllib.error, wave
import serve

def tone(path, hz):
    x = array.array('h', [int(6000 * math.sin(2 * math.pi * hz * t / 16000)) for t in range(16000)])
    with wave.open(path, 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(x.tobytes())
tmp = tempfile.mkdtemp(prefix='vc_'); os.makedirs(tmp + '/clips')
ids = ['k' + secrets.token_hex(4) for _ in range(22)]
for i, k in enumerate(ids): tone('%s/clips/%s.wav' % (tmp, k), 300 + 20 * i)
# a manifest that carries LOTS of pipeline facts — none may ever reach the page
json.dump({'day': 'rd_SECRET_DAY', 'order': ids, 'clips': [{'id': k, 'window_id': 'bw_SECRET_WINDOW', 'idx': 3, 'speech_s': 41.5, 'kind': 'core'} for k in ids]}, open(tmp + '/manifest.json', 'w'))
store, servers = serve.serve(tmp, 0, ['127.0.0.1'])
port = servers[0].server_address[1]; B = 'http://127.0.0.1:%d/v/%s' % (port, store.token)
def get(p, hdr=None):
    return urllib.request.urlopen(urllib.request.Request(B + p, headers=hdr or {}), timeout=10)
def post(p, body, base=None):
    r = urllib.request.Request((base or B) + p, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(r, timeout=10)
def status(fn):
    try: return fn().status
    except urllib.error.HTTPError as e: return e.code
ok = 0
def check(name, cond):
    global ok; ok += 1 if cond else 0
    print(('PASS ' if cond else 'FAIL ') + name)
    if not cond: raise SystemExit(1)

html = get('/').read().decode(); st = json.load(get('/api/state'))
everything = html + json.dumps(st)
for bad in ['SECRET', 'window', 'speech_s', 'core', 'transcript', 'confidence', 'diariz', 'speaker', 'clinician_id', 'idx', 'Home Office', 'room_']:
    check('page + state never contain %r' % bad, bad.lower() not in everything.lower())
check('state carries only order, own answers, own clinician answer, and a ready flag', set(st) == {'order', 'answers', 'clinician', 'ready'} and st['ready'] is True and st['answers'] == {} and st['clinician'] is None)
check('the order is the opaque ids', st['order'] == ids and all(k.startswith('k') and len(k) == 9 for k in ids))
check('a wrong token is a 404, and so is no token', status(lambda: urllib.request.urlopen('http://127.0.0.1:%d/v/nope/api/state' % port)) == 404 and status(lambda: urllib.request.urlopen('http://127.0.0.1:%d/api/state' % port)) == 404)
check('audio plays with a right token', get('/audio/%s.wav' % ids[0]).status == 200)
r = get('/audio/%s.wav' % ids[0], {'Range': 'bytes=0-99'}); check('Range request answers 206 (Safari needs it)', r.status == 206 and len(r.read()) == 100)
check('an id outside the order is refused (no path games)', status(lambda: get('/audio/k00000000.wav')) == 404 and status(lambda: get('/audio/..%2fmanifest.json')) == 404)
check('the clinician question persists', post('/api/clinician', {'answer': 'no'}).status == 200 and json.load(get('/api/state'))['clinician'] == 'no')
check('a bad clinician answer is refused', status(lambda: post('/api/clinician', {'answer': 'maybe'})) == 400)
for i in range(7): post('/api/answer', {'id': ids[i], 'answer': ['me', 'not_me', 'cant_tell'][i % 3]})
line_count = len(open(tmp + '/answers.jsonl').read().splitlines())
check('each answer is on disk the moment it is given (8 lines: 1 clinician + 7 clips)', line_count == 8)
check('a bad answer, an unknown id and a huge body are refused', status(lambda: post('/api/answer', {'id': ids[7], 'answer': 'yes'})) == 400 and status(lambda: post('/api/answer', {'id': 'k00000000', 'answer': 'me'})) == 400 and status(lambda: post('/api/answer', {'id': ids[7], 'answer': 'me' * 4000})) == 413)
# resume: a brand-new server object over the same directory sees the same progress
store2, s2 = serve.serve(tmp, 0, ['127.0.0.1']); p2 = s2[0].server_address[1]
st2 = json.load(urllib.request.urlopen('http://127.0.0.1:%d/v/%s/api/state' % (p2, store2.token)))
check('token is stable across restarts and progress resumes at 7 of 22', store2.token == store.token and len(st2['answers']) == 7 and st2['order'].index(next(k for k in st2['order'] if k not in st2['answers'])) == 7)
post('/api/answer', {'id': ids[2], 'answer': 'not_me'})
st3 = json.load(get('/api/state'))
check('a changed answer (Back) supersedes: last line wins, count unchanged', st3['answers'][ids[2]] == 'not_me' and len(st3['answers']) == 7)
for i in range(7, 22): post('/api/answer', {'id': ids[i], 'answer': 'me'})
check('all 22 answered', len(json.load(get('/api/state'))['answers']) == 22)
mode = oct(os.stat(tmp + '/state.json').st_mode & 0o777)
check('the token file is 0600', mode == '0o600')
check('the answers file holds ids and answers only', all(set(json.loads(l)) <= {'kind', 'id', 'answer', 't'} for l in open(tmp + '/answers.jsonl')))
os.remove('%s/clips/%s.wav' % (tmp, ids[5]))
check('with one clip missing the state says not ready (the page then refuses to start)', json.load(get('/api/state'))['ready'] is False)
print('\nALL %d CHECKS PASSED' % ok)
