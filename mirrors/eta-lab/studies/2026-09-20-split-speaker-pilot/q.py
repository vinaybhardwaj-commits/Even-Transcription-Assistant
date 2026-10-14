import re, sys, json, urllib.request
def _url():
    t = open('/Users/vinaybhardwaj/dev/Neon Database Connection String.rtf', errors='ignore').read()
    m = re.search(r'postgres(?:ql)?://[^\s"\'\\}]+', t)
    return m.group(0)
def q(sql, params=None):
    u = _url()
    host = re.search(r'@([^/:?]+)', u).group(1).replace('-pooler', '')
    req = urllib.request.Request(f'https://{host}/sql', data=json.dumps({"query": sql, "params": params or []}).encode(),
        headers={'Content-Type': 'application/json', 'Neon-Connection-String': u})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()[:500]}
if __name__ == '__main__':
    r = q(sys.stdin.read())
    if 'error' in r or 'message' in r: print(json.dumps(r)[:600]); sys.exit(1)
    print(json.dumps(r.get('rows'), default=str)[:int(sys.argv[1]) if len(sys.argv)>1 else 6000])
