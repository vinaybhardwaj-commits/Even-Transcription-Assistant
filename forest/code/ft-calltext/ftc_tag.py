"""ft-calltext tagger: Haiku 5.5 on Bedrock (ZDR account, steward creds, global profile per V ZDR ruling) over D-split prediction-window
Runo call summaries (calls_D.parquet from ftc_join.py). One request per episode chunk (<= 10 calls), one tag row per call.
Every positive tag must carry a quote that code verifies as a whitespace-normalised substring of THAT call's text; a miss drops the tag
(counted as unverified, never positive). Patient text never goes to stdout/logs: only ids and counts.
Usage: ftc_tag.py preflight | run [--limit N] [--workers W]
Output (0600): out/ft-calltext/tags_D.jsonl (call_id, episode_id, model, tags, quotes, char offsets), tag_report.json (counts, tokens)."""
import json, os, re, sys, threading, time, hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd
sys.path.append('~/oc/consult/steward/venv/lib/python3.10/site-packages')  # boto3 from the steward venv

HOME = os.path.expanduser('~')
OUT = f'{HOME}/oc/forest-lead/ft/out/ft-calltext'
TAGS = f'{OUT}/tags_D.jsonl'
MODEL = 'global.anthropic.claude-haiku-5-5'
CAP_IN = 5_000_000
CHUNK = 10
OBJ = ['cost', 'insurance', 'fear', 'second_opinion', 'going_elsewhere', 'timing', 'family_decision', 'unreachable']
INTENT = ['wants_surgery', 'undecided', 'declines', 'not_stated']
NEXT = ['visit_or_consult_scheduled', 'callback_agreed', 'details_to_be_sent', 'none']

SYSTEM = f"""You tag hospital counselling-call summaries (Even Hospitals, Bangalore). Each summary describes one phone call between hospital staff and a patient or family member after a doctor advised surgery or a procedure.
For EACH call, return tags. Every tag you set must carry "quote": an EXACT, contiguous, verbatim copy of words from THAT call's summary (copy characters exactly; 3-25 words; no paraphrase, no ellipsis). If you cannot quote it, do not tag it.

Tags per call:
- outcome_revealed: true if the summary shows the surgery/procedure is already booked, scheduled with a date or OT slot, the patient is admitted or being admitted, pre-op / admission instructions are given (arrival time, fasting, attendant for admission), or the surgery is done / patient discharged / post-op follow-up. Give the quote. Otherwise false.
- objections: list of {{"tag","quote"}} for barriers the PATIENT/FAMILY raises or that the call shows: {', '.join(OBJ)}.
  cost = price too high, affordability, asks for discount; insurance = insurance/TPA/cashless/claim coverage questions or problems; fear = fear or anxiety about surgery, pain, risk, anaesthesia; second_opinion = wants another doctor's opinion; going_elsewhere = getting or considering it at another hospital / govt scheme / hometown; timing = wants to delay, busy, travel, exams, festival, 'later', 'after some time'; family_decision = needs to discuss with or wait for spouse/family; unreachable = patient did not pick up, call disconnected, wrong number, switched off, or asked to call later without any discussion.
- intent: one of {INTENT} with quote (not_stated needs no quote). wants_surgery = patient says they want / are ready to do it; declines = says no / not interested / already done elsewhere; undecided = explicitly unsure / will think.
- next_step: one of {NEXT} with quote (none needs no quote). Agreed next step for the patient: a visit, consult, test or appointment date; staff will call back / patient will call back; details/estimate to be sent on WhatsApp etc.
- price_quoted: true with quote if a specific price, package amount or estimate is stated in the call.

Return ONLY JSON: {{"calls":[{{"c":"C1","outcome_revealed":{{"value":false}},"objections":[],"intent":{{"value":"not_stated"}},"next_step":{{"value":"none"}},"price_quoted":{{"value":false}}}}, ...]}} with one entry per call id given. Use {{"value":...,"quote":"..."}} for each set tag."""


def norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def locate(quote, text):
    """Whitespace-normalised exact substring check. Returns (start, end) in normalised text or None."""
    q, t = norm(quote).strip('"\''), norm(text)
    if len(q) < 6:
        return None
    i = t.find(q)
    if i < 0:
        i = t.lower().find(q.lower())          # case-only difference still verbatim
    return (i, i + len(q)) if i >= 0 else None


def chunks():
    c = pd.read_parquet(f'{OUT}/calls_D.parquet')
    c = c[c.summary.notna()].sort_values(['episode_id', 'call_day', 'summary_ts'])
    out = []
    for ep, g in c.groupby('episode_id'):
        rows = list(g[['call_id', 'summary']].itertuples(index=False))
        for k in range(0, len(rows), CHUNK):
            out.append((ep, rows[k:k + CHUNK]))
    return out


def prompt_of(rows):
    return '\n\n'.join(f'[C{i + 1}]\n{r.summary}' for i, r in enumerate(rows)) + '\n\nReturn only the JSON object.'


def project(chs):
    sysn = len(SYSTEM)
    tot = sum(max(len(prompt_of(r)) / 3.5, len(prompt_of(r).encode()) / 2.5) + sysn / 3.5 for _, r in chs)
    return int(tot)


_cl = {}
def client():
    if 'rt' not in _cl:
        for l in open(f'{HOME}/oc/consult/steward/steward.env'):
            l = l.strip()
            if l and not l.startswith('#') and '=' in l:
                k, v = l.split('=', 1); os.environ.setdefault(k, v.strip().strip("'\""))
        sys.path.insert(0, f'{HOME}/oc/consult/steward')
        from steward import creds
        import boto3
        from botocore.config import Config
        _cl['cache'] = creds.CredentialCache(); _cl['exp'] = None
        _cl['mk'] = lambda c: boto3.client('bedrock-runtime', region_name=os.environ.get('AWS_REGION', 'ap-south-1'),
                                           aws_access_key_id=c['access_key'], aws_secret_access_key=c['secret_key'],
                                           aws_session_token=c['token'],
                                           config=Config(read_timeout=120, connect_timeout=15, retries={'total_max_attempts': 3}))
        _cl['lock'] = threading.Lock()
    with _cl['lock']:
        c = _cl['cache'].get()
        if c['expires_at'] != _cl['exp']:
            _cl['rt'] = _cl['mk'](c); _cl['exp'] = c['expires_at']
        return _cl['rt']


def parse(txt, n):
    m = re.search(r'\{.*\}', txt, re.S)
    if not m:
        raise ValueError('no json')
    d = json.loads(m.group(0))
    calls = {x['c']: x for x in d['calls']}
    if set(calls) != {f'C{i + 1}' for i in range(n)}:
        raise ValueError('call ids mismatch')
    return calls


def verify(raw, text):
    """Keep only quote-verified tags. Returns (tags, unverified_count)."""
    unv = 0; t = {'objections': [], 'quotes': {}}

    def chk(key, val, q):
        nonlocal unv
        loc = locate(q, text) if q else None
        if loc is None:
            unv += 1; return False
        t['quotes'][key] = {'quote': q, 'start': loc[0], 'end': loc[1], 'sha': hashlib.sha256(norm(q).encode()).hexdigest()[:12]}
        return True
    o = raw.get('outcome_revealed') or {}
    t['outcome_revealed'] = bool(o.get('value')) and chk('outcome_revealed', True, o.get('quote'))
    t['outcome_revealed_unverified'] = bool(o.get('value')) and not t['outcome_revealed']
    for ob in raw.get('objections') or []:
        tag = ob.get('tag')
        if tag in OBJ and tag not in t['objections'] and chk(f'obj:{tag}', True, ob.get('quote')):
            t['objections'].append(tag)
    for key, allowed, neutral in (('intent', INTENT, 'not_stated'), ('next_step', NEXT, 'none')):
        v = (raw.get(key) or {}).get('value', neutral)
        v = v if v in allowed else neutral
        t[key] = v if v == neutral or chk(key, v, (raw.get(key) or {}).get('quote')) else neutral
    p = raw.get('price_quoted') or {}
    t['price_quoted'] = bool(p.get('value')) and chk('price_quoted', True, p.get('quote'))
    return t, unv


def ask(rows):
    rt = client(); tin = tout = 0; err = None
    for _ in range(3):
        try:
            r = rt.converse(modelId=MODEL, system=[{'text': SYSTEM}],
                            messages=[{'role': 'user', 'content': [{'text': prompt_of(rows)}]}],
                            inferenceConfig={'maxTokens': 4000})
        except Exception as e:                      # error class only, never text
            err = type(e).__name__; time.sleep(5); continue
        u = r.get('usage', {}); tin += u.get('inputTokens', 0); tout += u.get('outputTokens', 0)
        try:
            return parse(''.join(b.get('text', '') for b in r['output']['message']['content']), len(rows)), tin, tout, None
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            err = 'parse:' + type(e).__name__
    return None, tin, tout, err


def run(limit=None, workers=8):
    chs = chunks()
    proj = project(chs)
    print('chunks', len(chs), 'calls', sum(len(r) for _, r in chs), 'projected_in_tokens', proj, 'cap', CAP_IN)
    if proj > CAP_IN:
        sys.exit('PREFLIGHT: over cap, stop')
    done = set()
    if os.path.exists(TAGS):
        done = {json.loads(l)['call_id'] for l in open(TAGS)}
    todo = [(e, r) for e, r in chs if not all(x.call_id in done for x in r)]
    if limit:
        todo = todo[:limit]
    print('todo chunks', len(todo))
    lock = threading.Lock(); tot = {'in': 0, 'out': 0, 'fail': 0, 'unverified': 0, 'rows': 0}; errs = {}
    fd = os.open(TAGS, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(ask, r): (e, r) for e, r in todo}
        for f in as_completed(futs):
            e, rows = futs[f]
            calls, tin, tout, err = f.result()
            with lock:
                tot['in'] += tin; tot['out'] += tout
                if calls is None:
                    tot['fail'] += 1; errs[err] = errs.get(err, 0) + 1; continue
                for i, r in enumerate(rows):
                    t, unv = verify(calls[f'C{i + 1}'], r.summary)
                    tot['unverified'] += unv; tot['rows'] += 1
                    os.write(fd, (json.dumps({'call_id': r.call_id, 'episode_id': e, 'model': MODEL, **t}) + '\n').encode())
                if (tot['rows'] // CHUNK) % 20 == 0:
                    print('progress rows', tot['rows'], 'in', tot['in'], 'out', tot['out'], 'fail', tot['fail'], flush=True)
                if tot['in'] > CAP_IN:
                    print('CAP HIT: stopping'); ex.shutdown(cancel_futures=True); break
    os.close(fd)
    rep = {**tot, 'errors': errs, 'model': MODEL, 'projected_in': proj, 'ts': time.strftime('%Y-%m-%d %H:%M:%S')}
    p = f'{OUT}/tag_report_run.json'
    prev = json.load(open(p)) if os.path.exists(p) else []
    json.dump(prev + [rep], open(p, 'w'), indent=1); os.chmod(p, 0o600)
    print(json.dumps(rep))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'preflight':
        chs = chunks(); print('chunks', len(chs), 'projected_in_tokens', project(chs), 'cap', CAP_IN)
    else:
        lim = int(a[a.index('--limit') + 1]) if '--limit' in a else None
        w = int(a[a.index('--workers') + 1]) if '--workers' in a else 8
        run(lim, w)
