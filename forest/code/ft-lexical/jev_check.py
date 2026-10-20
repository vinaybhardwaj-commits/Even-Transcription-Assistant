"""ft-lexical: Jev cross-check of the Haiku themes on a 15% random sample (seed 20) of all items (drawn from items.jsonl, so it can run beside Haiku) (as ft-text2: jev-latest, box key, noul questions,
the same theme wording). Jev yes = p >= 0.5. Output (0600): ~/eta-data/forest/ft-lexical/jev.jsonl. Ids and counts only on stdout.
Usage: jev_check.py run [--workers W]"""
import json, os, sys, random, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, '~/oc/diar-lab-wt/kit/reb')
from jev_client import JevClient, JevError
import tag as T

OUTF = f'{T.W}/jev.jsonl'
PRE = 'Even Hospitals, Bangalore. Below is {desc}. Answer only from this text.\n\n'


def sample():
    ids = sorted(json.loads(l)['item_id'] for l in open(f'{T.W}/items.jsonl')); random.Random(20).shuffle(ids)
    return ids[:round(0.15 * len(ids))]


def one(jc, it):
    qs = {k: {'type': 'noul', 'instructions': f'Does this text show the following? {v}'} for k, v in T.TH.items()}
    try:
        r = jc._post({'state': PRE.format(desc=T.DESC[it['corpus']]) + T.text_of(it), 'model': jc.model, 'questions': qs})
    except JevError as e:
        return {'item_id': it['item_id'], 'err': e.reason}
    p = {}
    for k in T.TH:
        v = ((r.get('answers') or {}).get(k) or {}).get('noul')
        if not isinstance(v, (int, float)): return {'item_id': it['item_id'], 'err': 'bad_answer'}
        p[k] = float(v)
    return {'item_id': it['item_id'], 'corpus': it['corpus'], 'p': p, 'model': r.get('model')}


def main(a):
    its = {json.loads(l)['item_id']: json.loads(l) for l in open(f'{T.W}/items.jsonl')}
    ids = sample()
    done = {json.loads(l)['item_id'] for l in open(OUTF) if 'p' in json.loads(l)} if os.path.exists(OUTF) else set()
    todo = [i for i in ids if i not in done]
    print('sample', len(ids), 'todo', len(todo), flush=True)
    jc = JevClient(timeout=120); lock = threading.Lock(); n = {'ok': 0, 'err': 0}
    w = int(a[a.index('--workers') + 1]) if '--workers' in a else 6
    fd = os.open(OUTF, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with ThreadPoolExecutor(w) as ex:
        for f in as_completed([ex.submit(one, jc, its[i]) for i in todo]):
            r = f.result()
            with lock:
                os.write(fd, (json.dumps(r) + '\n').encode()); n['err' if 'err' in r else 'ok'] += 1
    os.close(fd)
    print(json.dumps({**n, 'jev_calls': jc.stats['calls'], 'in_tok': jc.stats['input_tokens'], 'out_tok': jc.stats['output_tokens']}))


if __name__ == '__main__': main(sys.argv[1:])
