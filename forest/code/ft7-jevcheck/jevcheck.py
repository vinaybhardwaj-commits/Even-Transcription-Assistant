"""FT7 claim-support check with Jev. One request per claim: q 'sup' (noul, P(supported)) + q 'quote' (choice over verbatim evidence sentences + none).
The quote is then code-checked as a verbatim substring of FT7-REPORT.md. Resumable; output work/jev_claims.jsonl (0600); counts only on stdout."""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, '~/wt/ft-text2/code')
sys.path.insert(0, '~/oc/diar-lab-wt/kit/reb')
import ft2common as C
from jev_client import JevClient, JevError
from claims import CLAIMS

REPORT = os.path.expanduser('~/oc/forest-lead/ft/out/FT7-REPORT.md')
OUTF = f'{HERE}/jev_claims.jsonl'
RPT = open(REPORT).read()


def sections():
    lines = RPT.split('\n'); sec = {'H': []}; cur = 'H'
    for l in lines:
        m = re.match(r'## (\d+[a-f]?)\. ', l)
        if m: cur = m.group(1); sec[cur] = []
        elif l.startswith('## '): cur = None
        if cur: sec[cur].append(l)
    return {k: '\n'.join(v).strip() for k, v in sec.items()}


def candidates(text):
    """Verbatim pieces of the evidence: each non-empty line, long lines also split into sentences. Every piece is a substring of the report by construction."""
    out = []
    for l in text.split('\n'):
        s = l.strip()
        if len(s) < 12 or set(s) <= set('|-: '): continue
        parts = [s] if len(s) <= 220 else [p for p in re.split(r'(?<=[.;:])\s+(?=[A-Z*(\["])', s) if len(p) >= 12]
        for p in parts:
            if p not in out: out.append(p)
    return out


SUP_Q = ('The text above is an excerpt of a report, followed by one CLAIM taken from a one-page summary of that report. Is the CLAIM supported by the report excerpt? '
         'Supported means the excerpt states it, or it follows directly from what the excerpt states, and every number in the claim matches the excerpt '
         '(normal rounding allowed). If a number differs, the claim goes beyond the excerpt, or the excerpt says something weaker or different, it is not supported.')
QUOTE_Q = 'Which single passage of the report excerpt best supports the CLAIM? Choose none if no passage supports it.'


def one(jc, cid, kind, claim, secs, S):
    ev = '\n\n'.join(S[s] for s in secs)
    cands = candidates(ev)
    crit = {f'p{i}': f'Passage: {c}' for i, c in enumerate(cands)}
    crit['none'] = 'No passage of the excerpt supports the claim.'
    state = f'REPORT EXCERPT (sections {", ".join(secs)}):\n{ev}\n\nCLAIM: {claim}'
    qs = {'sup': {'type': 'noul', 'instructions': SUP_Q, 'criteria': {'true': 'The claim is supported by the excerpt.', 'false': 'The claim is not supported by the excerpt.'}},
          'quote': {'type': 'choice', 'instructions': QUOTE_Q, 'criteria': crit}}
    t0 = time.time()
    try:
        r = jc._post({'state': state, 'model': jc.model, 'questions': qs})
    except JevError as e:
        return {'id': cid, 'err': e.reason}
    a = r.get('answers') or {}
    p = (a.get('sup') or {}).get('noul')
    q = a.get('quote') or {}
    ch = q.get('choice'); pr = q.get('probabilities') or {}
    quote = cands[int(ch[1:])] if ch and ch.startswith('p') and ch[1:].isdigit() and int(ch[1:]) < len(cands) else None
    return {'id': cid, 'kind': kind, 'claim': claim, 'secs': secs, 'p': p, 'quote_choice': ch, 'quote_p': pr.get(ch) if ch else None,
            'p_none': pr.get('none'), 'quote': quote, 'quote_verbatim': bool(quote) and quote in RPT, 'n_cands': len(cands),
            'model': r.get('model'), 'latency_s': round(time.time() - t0, 2)}


def main():
    os.umask(0o077)
    S = sections()
    done = {r['id'] for r in C.read_jsonl(OUTF) if 'p' in r and isinstance(r['p'], (int, float))}
    todo = [c for c in CLAIMS if c[0] not in done]
    print('sections', sorted(S), 'claims', len(CLAIMS), 'todo', len(todo), flush=True)
    jc = JevClient(timeout=120)
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda c: one(jc, c[0], c[1], c[2], c[3], S), todo))
    C.write_jsonl(OUTF, res)
    print(json.dumps({'ok': sum('p' in r for r in res), 'err': sum('err' in r for r in res), 'calls': jc.stats['calls'],
                      'in_tok': jc.stats['input_tokens'], 'out_tok': jc.stats['output_tokens'], 'models': sorted({r.get('model') for r in res if r.get('model')})}))


if __name__ == '__main__':
    main()
