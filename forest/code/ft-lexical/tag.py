"""ft-lexical step 2: theme coding with Haiku 5.5 (global.anthropic.claude-haiku-5-5, Bedrock ZDR steward route via ft-calltext ftc_tag.client).
Themes are the fixed PLAN.md list (pre-registered before outcomes). One request per call transcript (R) or consult (K); summaries (S) in chunks of 10.
Every yes must carry a quote that code verifies as a whitespace-normalised substring of THAT item's text (ftc_tag.locate); a miss = no (counted).
The model never sees outcomes. Ids and counts only on stdout.
Usage: tag.py preflight | run [--workers W] [--limit N]   -> ~/eta-data/forest/ft-lexical/themes.jsonl (0600), tag_report.json"""
import json, os, re, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.expanduser('~/oc/forest-lead/ft/out/ft-calltext/code'))
import ftc_tag as F

W = os.path.expanduser('~/eta-data/forest/ft-lexical'); OUTF = f'{W}/themes.jsonl'
MODEL = F.MODEL; CAP_IN = 5_000_000
SCH = int(os.environ.get('SCH', 10))   # summaries per request (retry pass used 4)
TH = {
    'procedure_explained': 'staff/doctor explains what the operation or procedure is or how it is done',
    'risks_explained': 'risks, complications, side effects or safety of the procedure are discussed',
    'recovery_stay_explained': 'hospital stay length, recovery time, rest, return to work or post-op care is explained',
    'cost_quoted': 'a specific price, package amount or estimate is stated',
    'insurance_cashless': 'insurance, TPA, cashless, claim, pre-authorisation or coverage is discussed',
    'urgency_by_doctor': 'the doctor (or staff relaying the doctor) says it should be done soon / not delayed / can get worse',
    'reassurance': 'staff/doctor reassures (it is simple, safe, common, nothing to worry, quick recovery)',
    'empathy': "staff/doctor acknowledges the patient's feelings or situation (I understand, sorry to hear, take care)",
    'followup_date_offered': 'staff/doctor offers a specific day or time for a visit, review, test or call',
    'patient_fear': 'patient/family expresses fear, worry or anxiety about the surgery, pain, anaesthesia or risk',
    'family_decision': 'patient says they need to discuss with or wait for family / spouse / children',
    'second_opinion': "patient wants or mentions another doctor's opinion",
    'going_elsewhere': 'patient is getting or considering treatment at another hospital, govt scheme or hometown',
    'timing_later': 'patient wants to delay / do it later / is busy, travelling, festival, exams',
    'doctor_named': 'the treating doctor is referred to by name',
    'callback_prompt': 'the call is a callback made as promised or at the time the patient asked for (phone calls only; for consults always no)',
}
DESC = {'R': 'a machine transcript (speech recognition, may contain errors; speaker labels may be wrong; text may be Kannada, Hindi, Tamil, Telugu, '
              'English or mixed) of one phone call between Even Hospitals staff (counsellor) and a patient or family member after a doctor advised surgery or a procedure',
        'S': 'a staff-written summary of one phone call between Even Hospitals staff and a patient or family member after a doctor advised surgery or a procedure',
        'K': 'a machine transcript (speech recognition, may contain errors; speaker labels may be wrong; text is in the original language, often Kannada, Hindi, '
              'Telugu, Tamil or English, possibly mixed) of one outpatient consultation at Even Hospitals in which surgery or a procedure was discussed'}
THL = '\n'.join(f'- {k}: {v}' for k, v in TH.items())


def system(corpus):
    return f"""You code {DESC[corpus]}.
For each theme below, answer yes or no. Every yes MUST carry "quote": an EXACT, contiguous, verbatim copy of 3-25 words from the text, in the text's own
script and language (copy characters exactly; no translation, no paraphrase, no ellipsis). If you cannot quote it, answer no.
Themes:
{THL}
Return ONLY JSON: {{"items":[{{"c":"C1","themes":{{"<theme>":{{"value":true,"quote":"..."}}, "<theme>":{{"value":false}}, ...}}}}]}} with every theme for every item id given."""


def text_of(it):
    if it['corpus'] == 'S': return it['segs'][0][2]
    lab = {'counsellor': 'Counsellor', 'patient': 'Patient', 'doctor': 'Doctor', 'unclear': 'Speaker'}
    return '\n'.join(f'[{lab[s[0]]}] {s[2]}' for s in it['segs'] if s[2].strip())


def load():
    its = [json.loads(l) for l in open(f'{W}/items.jsonl')]
    reqs = []
    for c in ('R', 'K'):
        reqs += [(c, [it]) for it in its if it['corpus'] == c]
    S = sorted([it for it in its if it['corpus'] == 'S'], key=lambda x: (x['unit_id'], x['item_id']))
    reqs += [('S', S[k:k + SCH]) for k in range(0, len(S), SCH)]
    return reqs


def prompt_of(rows):
    return '\n\n'.join(f'[C{i + 1}]\n{text_of(r)}' for i, r in enumerate(rows)) + '\n\nReturn only the JSON object.'


def project(reqs):
    return int(sum(max(len(prompt_of(r)) / 3.5, len(prompt_of(r).encode()) / 2.5) + len(system(c)) / 3.5 for c, r in reqs))


def ask(c, rows):
    rt = F.client(); tin = tout = 0; err = None
    for _ in range(3):
        try:
            r = rt.converse(modelId=MODEL, system=[{'text': system(c)}], messages=[{'role': 'user', 'content': [{'text': prompt_of(rows)}]}],
                            inferenceConfig={'maxTokens': 8000})
        except Exception as e:
            err = type(e).__name__; time.sleep(5); continue
        u = r.get('usage', {}); tin += u.get('inputTokens', 0); tout += u.get('outputTokens', 0)
        try:
            txt = ''.join(b.get('text', '') for b in r['output']['message']['content'])
            d = json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
            got = {x['c']: x.get('themes') or {} for x in d['items']}
            if set(got) != {f'C{i + 1}' for i in range(len(rows))}: raise ValueError('ids')
            return got, tin, tout, None
        except Exception as e:
            err = 'parse:' + type(e).__name__
    return None, tin, tout, err


def verify(raw, text):
    out, q, unv = {}, {}, 0
    for k in TH:
        v = raw.get(k) or {}
        if v.get('value') is True:
            loc = F.locate(v.get('quote') or '', text)
            if loc: out[k] = 1; q[k] = v['quote']
            else: out[k] = 0; unv += 1
        else: out[k] = 0
    return out, q, unv


def run(limit=None, workers=8):
    reqs = load(); proj = project(reqs)
    print('requests', len(reqs), 'projected_in', proj, 'cap', CAP_IN)
    if proj > CAP_IN: sys.exit('PREFLIGHT over cap')
    done = {json.loads(l)['item_id'] for l in open(OUTF)} if os.path.exists(OUTF) else set()
    todo = [(c, r) for c, r in reqs if not all(x['item_id'] in done for x in r)][:limit]
    print('todo', len(todo))
    tot = dict(inp=0, out=0, fail=0, unverified=0, rows=0); errs = {}; lock = threading.Lock()
    fd = os.open(OUTF, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(ask, c, r): (c, r) for c, r in todo}
        for f in as_completed(futs):
            c, rows = futs[f]; got, tin, tout, err = f.result()
            with lock:
                tot['inp'] += tin; tot['out'] += tout
                if got is None: tot['fail'] += 1; errs[err] = errs.get(err, 0) + 1; continue
                for i, it in enumerate(rows):
                    th, q, unv = verify(got[f'C{i + 1}'], text_of(it))
                    tot['unverified'] += unv; tot['rows'] += 1
                    os.write(fd, (json.dumps({'corpus': c, 'item_id': it['item_id'], 'unit_id': it['unit_id'], 'model': MODEL, 'themes': th, 'quotes': q},
                                             ensure_ascii=False) + '\n').encode())
                if tot['rows'] % 100 < len(rows): print('progress', tot, flush=True)
                if tot['inp'] > CAP_IN: print('CAP HIT'); ex.shutdown(cancel_futures=True); break
    os.close(fd)
    rep = {**tot, 'errors': errs, 'model': MODEL, 'projected_in': proj, 'ts': time.strftime('%Y-%m-%d %H:%M:%S')}
    p = f'{W}/tag_report.json'; prev = json.load(open(p)) if os.path.exists(p) else []
    json.dump(prev + [rep], open(p, 'w'), indent=1); os.chmod(p, 0o600); print(json.dumps(rep))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'preflight':
        r = load(); print('requests', len(r), 'projected_in', project(r))
    else:
        run(int(a[a.index('--limit') + 1]) if '--limit' in a else None, int(a[a.index('--workers') + 1]) if '--workers' in a else 8)
