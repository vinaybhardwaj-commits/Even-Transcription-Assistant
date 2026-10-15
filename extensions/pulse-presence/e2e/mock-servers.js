// Mock Pulse (3 endpoints, scriptable) and mock ETA sink (records POSTed {events:[...]}). Real HTTP on 127.0.0.1.
// No credentials, no real Pulse, no real sink. The harness rewrites https://pulse.even.in and the baked ingest
// URL to these listeners (see run.js).
const http = require('node:http');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function startPulse() {
  // mode: doctor | expired | impersonating | broken | error500
  const state = { mode: 'doctor', uid: 'DOC-E2E-1', name: 'Dr E2E One', requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push(req.method + ' ' + req.url);
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.url === '/login') return send(200, '<html><body>mock pulse login</body></html>', 'text/html');
    if (req.url === '/api/auth/clinical/access/verify') {
      if (state.mode === 'expired') return send(401, { message: 'Unauthorized' });
      if (state.mode === 'error500') return send(500, { message: 'boom' });
      if (state.mode === 'broken') return send(200, { result: { has_access: true, doctor: { uid: state.uid } }, message: 'OK' }); // contract change: data -> result
      return send(200, { data: { has_access: true, doctor: { uid: state.uid, specialty: 'HEALTH_CHECK_UP', stream_data: {} }, user_type: 'DOCTOR', is_impersonating: state.mode === 'impersonating', message: 'OK' }, message: 'OK' });
    }
    if (req.url === '/api/auth/getName') {
      if (state.mode === 'expired') return send(401, { message: 'Unauthorized' });
      return send(200, { data: state.name, message: 'OK' });
    }
    return send(404, { message: 'not found' });
  });
  const port = await listen(server);
  return { base: 'http://127.0.0.1:' + port, state, close: () => new Promise((r) => server.close(r)) };
}

async function startSink(token) {
  // failNext: number of upcoming POSTs to answer 500 (retryable) instead of 200
  const sink = { failNext: 0, posts: [], accepted: [], rejected: 0, badAuth: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const at = Date.now();
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      if (req.headers.authorization !== 'Bearer ' + token) { sink.badAuth++; res.writeHead(401); return res.end(); }
      let body;
      try { body = JSON.parse(raw); } catch (e) { res.writeHead(400); return res.end(); }
      if (sink.failNext > 0) { sink.failNext--; sink.rejected++; res.writeHead(500); return res.end('{}'); }
      const events = Array.isArray(body.events) ? body.events : [];
      sink.posts.push({ receivedAt: at, n: events.length, keys: Object.keys(body) });
      for (const e of events) sink.accepted.push({ receivedAt: at, event: e });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: events.length }));
    });
  });
  const port = await listen(server);
  sink.base = 'http://127.0.0.1:' + port;
  sink.close = () => new Promise((r) => server.close(r));
  return sink;
}

module.exports = { startPulse, startSink };
