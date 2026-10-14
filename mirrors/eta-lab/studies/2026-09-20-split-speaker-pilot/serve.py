#!/usr/bin/env python3
"""The voice-check page's server. Stdlib only.

BLIND BY CONSTRUCTION. The page is told the clips' opaque ids, their order, and the occupant's OWN answers — nothing else.
The key (which window and diarizer label an id came from, what any pipeline said) lives in manifest.json, is read by this
process only to learn the ids and their order, and is never sent. No transcript, speaker id, confidence, room label or
clinician name exists anywhere the page can reach.

PERSISTED AS GIVEN. Each answer is appended to answers.jsonl and fsynced before the reply goes out. The state the page loads is
rebuilt from that file, so closing the tab and coming back resumes at the first unanswered clip. An answer changed via "Back"
is a new line; the LAST line per id is the answer.

ACCESS. Binds 127.0.0.1 and (if given) the tailnet address only, never 0.0.0.0. Every path carries the token from state.json
(constant-time compare). Nothing is logged that contains the token, an id or an answer.

  serve.py [--data DIR] [--port 8791] [--bind 100.x.y.z]
"""
import argparse, hmac, json, os, re, secrets, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ANSWERS = ('me', 'not_me', 'cant_tell')
CLINICIAN = ('no', 'yes', 'not_sure')
ID_RE = re.compile(r'^[kp][0-9a-f]{8}$')   # k = a clip (an audio id); p = a v6 pair (an answerable id, never audio)

class Store:
    def __init__(self, data):
        self.data, self.lock = data, threading.Lock()
        man = json.load(open(os.path.join(data, 'manifest.json')))
        self.order = list(man['order'])              # the ONLY thing taken from the key
        # v4 roll call: the NAME a clip is presented under is deliberately public — it is an
        # identification task, not a blind one. Whether that name is the clip's true source
        # (genuine vs control) stays in the key and is never sent. Absent for v1-v3.
        self.names = {k: v for k, v in (man.get('names') or {}).items() if k in self.order}
        # v6 pairs: `order` holds PAIR ids and each maps to two clip ids. The audio route must serve
        # the CLIP ids, so they are tracked separately. Which pair is same/different/open stays in
        # the key and is never sent. Absent for v1-v5, where a clip id is its own audio id.
        self.pairs = {k: list(v) for k, v in (man.get('pairmap') or {}).items() if k in self.order}
        # In pair mode the answerable ids (p...) are NOT audio ids; only the clips behind them are.
        self.audio_ids = {c for v in self.pairs.values() for c in v} if self.pairs else set(self.order)
        sp = os.path.join(data, 'state.json')
        if os.path.exists(sp): self.token = json.load(open(sp))['token']
        else:
            self.token = secrets.token_urlsafe(18)
            fd = os.open(sp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f: json.dump({'token': self.token}, f)
        self.path = os.path.join(data, 'answers.jsonl')
    def _lines(self):
        if not os.path.exists(self.path): return []
        out = []
        for l in open(self.path):
            try: out.append(json.loads(l))
            except ValueError: pass
        return out
    def state(self):
        answers, clin = {}, None
        for r in self._lines():
            if r.get('kind') == 'clip' and r.get('id') in self.order: answers[r['id']] = r['answer']
            if r.get('kind') == 'clinician': clin = r['answer']
        ready = all(os.path.isfile(os.path.join(self.data, 'clips', k + '.wav')) for k in self.audio_ids)   # never show a page whose audio is missing
        out = {'order': self.order, 'answers': answers, 'clinician': clin, 'ready': ready}
        if self.names: out['names'] = self.names
        if self.pairs: out['pairs'] = self.pairs
        return out
    def append(self, rec):
        rec['t'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        with self.lock, open(self.path, 'a') as f:
            f.write(json.dumps(rec) + '\n'); f.flush(); os.fsync(f.fileno())

def make_handler(store, page):
    class H(BaseHTTPRequestHandler):
        server_version = 'voicecheck'
        def log_message(self, *a): pass                                   # no access log: paths carry the token
        def _ok(self, code, ctype, body, extra=None):
            self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (extra or {}).items(): self.send_header(k, v)
            self.end_headers(); self.wfile.write(body)
        def _route(self):
            m = re.match(r'^/v/([^/]+)(/.*)?$', self.path.split('?')[0])
            if not m or not hmac.compare_digest(m.group(1), store.token): return None
            return m.group(2) or '/'
        def do_GET(self):
            r = self._route()
            if r is None: return self._ok(404, 'text/plain', b'not found')
            if r == '/': return self._ok(200, 'text/html; charset=utf-8', page)
            if r == '/api/state': return self._ok(200, 'application/json', json.dumps(store.state()).encode())
            m = re.match(r'^/audio/(k[0-9a-f]{8})\.wav$', r)
            if m and ID_RE.match(m.group(1)) and m.group(1) in store.audio_ids:
                p = os.path.join(store.data, 'clips', m.group(1) + '.wav')
                if not os.path.isfile(p): return self._ok(404, 'text/plain', b'not found')
                data = open(p, 'rb').read(); size = len(data); rng = self.headers.get('Range')   # Safari will not play audio without Range
                if rng and (mm := re.match(r'bytes=(\d*)-(\d*)$', rng)):
                    a = int(mm.group(1)) if mm.group(1) else max(0, size - int(mm.group(2) or 0)); b = int(mm.group(2)) if mm.group(1) and mm.group(2) else size - 1
                    b = min(b, size - 1)
                    if a > b: return self._ok(416, 'text/plain', b'bad range', {'Content-Range': 'bytes */%d' % size})
                    return self._ok(206, 'audio/wav', data[a:b + 1], {'Content-Range': 'bytes %d-%d/%d' % (a, b, size), 'Accept-Ranges': 'bytes'})
                return self._ok(200, 'audio/wav', data, {'Accept-Ranges': 'bytes'})
            return self._ok(404, 'text/plain', b'not found')
        def do_POST(self):
            r = self._route()
            if r is None: return self._ok(404, 'text/plain', b'not found')
            n = int(self.headers.get('Content-Length') or 0)
            if n > 1024: return self._ok(413, 'text/plain', b'too large')
            try: body = json.loads(self.rfile.read(n) or b'{}')
            except ValueError: return self._ok(400, 'text/plain', b'bad json')
            if r == '/api/answer':
                if not (isinstance(body.get('id'), str) and ID_RE.match(body['id']) and body['id'] in store.order and body.get('answer') in ANSWERS):
                    return self._ok(400, 'text/plain', b'bad answer')
                store.append({'kind': 'clip', 'id': body['id'], 'answer': body['answer']})
            elif r == '/api/clinician':
                if body.get('answer') not in CLINICIAN: return self._ok(400, 'text/plain', b'bad answer')
                store.append({'kind': 'clinician', 'answer': body['answer']})
            else: return self._ok(404, 'text/plain', b'not found')
            return self._ok(200, 'application/json', b'{"ok":true}')
    return H

def serve(data, port, binds, page_path=None):
    store = Store(data); page = open(page_path or os.path.join(HERE, 'page.html'), 'rb').read()
    servers = []
    for b in binds:
        s = ThreadingHTTPServer((b, port), make_handler(store, page)); s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)
    return store, servers

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--data', default='/Users/vinaybhardwaj/dev/scratch/split-speaker-pilot')
    ap.add_argument('--port', type=int, default=8791); ap.add_argument('--bind', action='append', default=[])
    ap.add_argument('--page', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'page.html'))
    a = ap.parse_args()
    store, servers = serve(a.data, a.port, ['127.0.0.1'] + a.bind, a.page)
    print('serving %d clips on port %d, binds %s; %d answered so far' % (len(store.order), a.port, ['127.0.0.1'] + a.bind, len(store.state()['answers'])), flush=True)
    try:
        while True: time.sleep(3600)
    except KeyboardInterrupt: pass
