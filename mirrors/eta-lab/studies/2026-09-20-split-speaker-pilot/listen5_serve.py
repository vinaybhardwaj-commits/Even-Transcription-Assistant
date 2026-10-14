#!/usr/bin/env python3
"""listen5 player: five disagreement windows, each with its local and pyannote.ai speaker lanes.
Stdlib only. Binds loopback plus the tailnet address, never 0.0.0.0. Token-in-path, no access log.

The pyannote lane is read from bake3/pyannote-segments.json ON EVERY STATE REQUEST, so the lane
appears the moment that file lands, with no restart. Schema: {"<window_id>": [{"start_ms", "end_ms",
"speaker"}...]}, times relative to the window start.

V's answers go to ~/dev/_fable/scratch/bake3/v-listen.json (latest per window, 0600) and are also
appended to v-listen.log.jsonl beside it, so a changed answer never erases the first one."""
import argparse, hmac, json, os, re, secrets, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = '/Users/vinaybhardwaj/dev/scratch/listen5'
BAKE = '/Users/vinaybhardwaj/dev/_fable/scratch/bake3'
HERE = os.path.dirname(os.path.abspath(__file__))
CLOSER = ('local', 'pyannote', 'both_wrong')
lock = threading.Lock()

def jload(p, default):
    try: return json.load(open(p))
    except Exception: return default

def wjson(p, obj):
    fd = os.open(p + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(p + '.tmp', p)

def token():
    p = os.path.join(DATA, 'token.json')
    if os.path.exists(p): return json.load(open(p))['token']
    t = secrets.token_urlsafe(18); wjson(p, {'token': t}); return t

def state():
    F = sorted(jload(os.path.join(DATA, 'fetched.json'), []), key=lambda m: m['n'])
    L = jload(os.path.join(DATA, 'local-segments.json'), {})
    P = jload(os.path.join(BAKE, 'pyannote-segments.json'), {})
    A = jload(os.path.join(BAKE, 'v-listen.json'), {})
    import datetime
    IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    wins = []
    for m in F:
        wid = m['window_id']
        a = datetime.datetime.fromtimestamp(m['start_ms'] / 1000, IST)
        wins.append({'n': m['n'], 'label': 'W%d' % m['n'], 'when': a.strftime('%d %b %H:%M'),
                     'duration_s': m['got_s'], 'audio': m['audio'],
                     'local': L.get(wid, []), 'pyannote': P.get(wid), 'answer': A.get(wid)})
    return {'windows': wins}

def handler(tok, page):
    ids = {m['n']: m['window_id'] for m in jload(os.path.join(DATA, 'fetched.json'), [])}
    class H(BaseHTTPRequestHandler):
        server_version = 'listen5'
        def log_message(self, *a): pass
        def _ok(self, code, ctype, body, extra=None):
            self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff')
            for k, v in (extra or {}).items(): self.send_header(k, v)
            self.end_headers(); self.wfile.write(body)
        def _route(self):
            m = re.match(r'^/v/([^/]+)(/.*)?$', self.path.split('?')[0])
            if not m or not hmac.compare_digest(m.group(1), tok): return None
            return m.group(2) or '/'
        def do_GET(self):
            r = self._route()
            if r is None: return self._ok(404, 'text/plain', b'not found')
            if r == '/': return self._ok(200, 'text/html; charset=utf-8', page)
            if r == '/api/state': return self._ok(200, 'application/json', json.dumps(state()).encode())
            m = re.match(r'^/audio/(w[1-5])\.mp3$', r)
            if m:
                p = os.path.join(DATA, 'audio', m.group(1) + '.mp3')
                if not os.path.isfile(p): return self._ok(404, 'text/plain', b'not found')
                data = open(p, 'rb').read(); size = len(data); rng = self.headers.get('Range')
                if rng and (mm := re.match(r'bytes=(\d*)-(\d*)$', rng)):
                    a = int(mm.group(1)) if mm.group(1) else max(0, size - int(mm.group(2) or 0))
                    b = min(int(mm.group(2)) if mm.group(1) and mm.group(2) else size - 1, size - 1)
                    if a > b: return self._ok(416, 'text/plain', b'bad range', {'Content-Range': 'bytes */%d' % size})
                    return self._ok(206, 'audio/mpeg', data[a:b + 1], {'Content-Range': 'bytes %d-%d/%d' % (a, b, size), 'Accept-Ranges': 'bytes'})
                return self._ok(200, 'audio/mpeg', data, {'Accept-Ranges': 'bytes'})
            return self._ok(404, 'text/plain', b'not found')
        def do_POST(self):
            r = self._route()
            if r != '/api/answer': return self._ok(404, 'text/plain', b'not found')
            n = int(self.headers.get('Content-Length') or 0)
            if n > 512: return self._ok(413, 'text/plain', b'too large')
            try: body = json.loads(self.rfile.read(n) or b'{}')
            except ValueError: return self._ok(400, 'text/plain', b'bad json')
            win = body.get('n'); closer = body.get('closer'); spk = body.get('speakers')
            if win not in ids or closer not in CLOSER or not (isinstance(spk, int) and 0 <= spk <= 30):
                return self._ok(400, 'text/plain', b'bad answer')
            rec = {'window_id': ids[win], 'label': 'W%d' % win, 'closer': closer, 'speakers': spk,
                   'pyannote_lane_shown': bool(jload(os.path.join(BAKE, 'pyannote-segments.json'), {}).get(ids[win])),
                   't': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
            with lock:
                A = jload(os.path.join(BAKE, 'v-listen.json'), {}); A[ids[win]] = rec
                wjson(os.path.join(BAKE, 'v-listen.json'), A)
                fd = os.open(os.path.join(BAKE, 'v-listen.log.jsonl'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, 'a') as f: f.write(json.dumps(rec) + '\n'); f.flush(); os.fsync(f.fileno())
            return self._ok(200, 'application/json', b'{"ok":true}')
    return H

def serve(port, binds):
    tok = token(); page = open(os.path.join(HERE, 'listen5.html'), 'rb').read()
    servers = []
    for b in binds:
        s = ThreadingHTTPServer((b, port), handler(tok, page)); s.daemon_threads = True
        threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)
    return tok, servers

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--port', type=int, default=8797); ap.add_argument('--bind', action='append', default=[])
    a = ap.parse_args()
    tok, servers = serve(a.port, ['127.0.0.1'] + a.bind)
    print('listen5 up on %s port %d' % (['127.0.0.1'] + a.bind, a.port), flush=True)
    threading.Event().wait()
