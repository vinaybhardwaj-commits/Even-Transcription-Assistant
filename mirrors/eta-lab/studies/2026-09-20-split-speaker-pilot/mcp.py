"""Call the app's operator MCP endpoint from a script. The bearer token is read from .env.local IN-PROCESS by name and is
never printed; presigned URLs in a response stay in memory (they are short-lived credentials)."""
import json, os, re, urllib.request
ENV = '/Users/vinaybhardwaj/dev/Even-Transcription-Assistant/.env.local'
def _env(name):
    for line in open(ENV):
        m = re.match(r'\s*%s\s*=\s*"?([^"\n]*)"?' % re.escape(name), line)
        if m: return m.group(1)
    raise SystemExit('env var %s not found in .env.local' % name)
def call(tool, args, timeout=290):
    base, tok = _env('APP_URL').rstrip('/').replace('://evenscribe.app', '://www.evenscribe.app'), _env('SCRIBE_MCP_TOKEN')  # the apex 307s to www and urllib will not re-POST
    if tok.strip() in ('', '[SENSITIVE]'): raise SystemExit('SCRIBE_MCP_TOKEN is a placeholder in .env.local')
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(base + '/api/mcp', data=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json'})
    m = json.load(urllib.request.urlopen(req, timeout=timeout))
    if 'error' in m: raise RuntimeError(str(m['error'])[:300])
    res = m['result']; txt = res['content'][0]['text']
    out = json.loads(txt)
    if res.get('isError'): raise RuntimeError(str(out)[:300])
    return out
def shape(x, depth=0):
    if isinstance(x, dict): return {k: shape(v, depth + 1) for k, v in x.items()}
    if isinstance(x, list): return [shape(x[0], depth + 1), '…%d items' % len(x)] if x else []
    if isinstance(x, str): return '<url>' if x.startswith('http') else ('str(%d)' % len(x))
    return x
