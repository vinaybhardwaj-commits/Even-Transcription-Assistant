"""ft-rl-feat step 3: Haiku 5.5 tags on Runo call TRANSCRIPTS, using the ft-calltext tagger (ftc_tag.py) schema, prompt and quote verifier unchanged
except 'summaries' -> 'transcripts'. One request per call-chunk (<= 3 calls / 30k chars). Every positive tag needs a quote verified as a substring of THAT call's
transcript; misses are dropped (counted). Only ids/counts print. Usage: rlf_tag.py preflight|run <work_dir> [--limit N] [--workers W] [--cap TOKENS]"""
import sys, os, json, importlib.util, threading, time, collections
from concurrent.futures import ThreadPoolExecutor, as_completed
spec = importlib.util.spec_from_file_location('ftc_tag', '~/wt/ft-calltext/code/ftc_tag.py'); T = importlib.util.module_from_spec(spec); spec.loader.exec_module(T)
T.SYSTEM = T.SYSTEM.replace('call summaries', 'call transcripts').replace('Each summary describes', 'Each transcript is a speaker-labelled ([Counsellor]/[Patient], labels may be wrong) machine transcript of').replace("THAT call's summary", "THAT call's transcript") \
    + "\nThe transcript may be in English, Hindi, Kannada, Telugu, Tamil or code-mixed; copy quotes in their original script exactly. Transcripts can contain recognition errors; quote them as they are."
Row = collections.namedtuple('Row', 'call_id summary')


def chunks(work):
    by = collections.defaultdict(list)
    for l in open(f'{work}/texts.jsonl'):
        j = json.loads(l); by[j['episode_id']].append(Row(j['call_id'], j['text']))
    out = []
    for ep, rows in by.items():
        cur, n = [], 0
        for r in rows:
            if cur and (len(cur) >= 3 or n + len(r.summary) > 30000): out.append((ep, cur)); cur, n = [], 0
            cur.append(r); n += len(r.summary)
        if cur: out.append((ep, cur))
    return out


def main(a):
    mode, work = a[0], a[1]
    opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
    chs = chunks(work); cap = opt('--cap', 3_000_000)
    proj = T.project(chs); print('chunks', len(chs), 'calls', sum(len(r) for _, r in chs), 'projected_in_tokens', proj, 'cap', cap)
    if mode == 'preflight': return
    if proj > cap: sys.exit('PREFLIGHT: over cap, stop (raise --cap deliberately)')
    path = f'{work}/tags.jsonl'
    done = {json.loads(l)['call_id'] for l in open(path)} if os.path.exists(path) else set()
    todo = [(e, r) for e, r in chs if not all(x.call_id in done for x in r)][:opt('--limit', 10**9)]
    print('todo chunks', len(todo))
    lock = threading.Lock(); tot = dict(inp=0, out=0, fail=0, unverified=0, rows=0); errs = {}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with ThreadPoolExecutor(opt('--workers', 6)) as ex:
        futs = {ex.submit(T.ask, r): (e, r) for e, r in todo}
        for f in as_completed(futs):
            e, rows = futs[f]; calls, tin, tout, err = f.result()
            with lock:
                tot['inp'] += tin; tot['out'] += tout
                if calls is None: tot['fail'] += 1; errs[err] = errs.get(err, 0) + 1; continue
                for i, r in enumerate(rows):
                    t, unv = T.verify(calls[f'C{i + 1}'], r.summary); tot['unverified'] += unv; tot['rows'] += 1
                    os.write(fd, (json.dumps({'call_id': r.call_id, 'episode_id': e, 'model': T.MODEL, **t}, ensure_ascii=False) + '\n').encode())
                if tot['inp'] > cap: print('CAP HIT'); ex.shutdown(cancel_futures=True); break
    os.close(fd); print(json.dumps({**tot, 'errors': errs, 'model': T.MODEL}))


if __name__ == '__main__': main(sys.argv[1:])
