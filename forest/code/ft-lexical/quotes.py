"""ft-lexical: example snippets for the top-25 terms each way (Ale, all text) per corpus x speaker, and English glosses for non-Latin terms.
Snippet = up to 4 words either side of the term, from a unit of that direction's group. Haiku 5.5 renders it in English (translates if needed) and masks
person names as [name] and numbers as [#]; the rendering is NOT verbatim for native-script snippets (said in the report). Cached in work dir quotes.json."""
import json, os, re, random, collections
import pandas as pd
import common as C, lex
sys_path = os.path.expanduser('~/oc/forest-lead/ft/out/ft-calltext/code')
import sys; sys.path.insert(0, sys_path)
import ftc_tag as F

GROUPS = [('R', 'counsellor'), ('R', 'patient'), ('S', 'summary'), ('K', 'doctor'), ('K', 'patient')]
TOP = 25
SYS = ("You help write a hospital research report. For each item you get a term and a short snippet from a call or consultation transcript or a staff "
       "summary (Even Hospitals, Bangalore; may be Kannada, Hindi, Tamil, Telugu, English or mixed, with speech-recognition errors). Return for each item: "
       "\"gloss\": the English meaning of the term in 1-4 words (the term itself if already English), and \"en\": the snippet in plain English, at most 14 words, "
       "faithful to the snippet (translate if needed, no added meaning). In \"en\" replace every person name with [name], every number, date, phone or amount "
       "with [#], and any hospital or place name with [place]. Return ONLY JSON {\"items\":[{\"i\":1,\"gloss\":\"...\",\"en\":\"...\"},...]}.")


def snippet(text, term):
    words = text.split(); tw = term.split()
    toks = [C.tokens(w) for w in words]
    flat = [(i, t) for i, ts in enumerate(toks) for t in ts]
    for k in range(len(flat) - len(tw) + 1):
        if [t for _, t in flat[k:k + len(tw)]] == tw:
            i0, i1 = flat[k][0], flat[k + len(tw) - 1][0]
            return ' '.join(words[max(0, i0 - 4):i1 + 5])
    return None


def segs_of(its, corpus, speaker):
    out = collections.defaultdict(list)
    for it in its:
        if it['corpus'] != corpus: continue
        if corpus == 'R' and it['role_src'] not in C.ROLE_OK: continue
        if corpus == 'K' and not C.k_role_ok(it): continue
        for role, lg, txt, *_ in it['segs']:
            if speaker == 'summary':
                out[it['unit_id']] += re.split(r'(?<=[.!?])\s+', txt)
            elif role == speaker: out[it['unit_id']].append(txt)
    return out


def ask(items):
    rt = F.client()
    msg = '\n'.join(f'{i + 1}. term: {t} | snippet: {s}' for i, (t, s) in enumerate(items))
    for _ in range(3):
        try:
            r = rt.converse(modelId=F.MODEL, system=[{'text': SYS}], messages=[{'role': 'user', 'content': [{'text': msg}]}], inferenceConfig={'maxTokens': 8000})
            txt = ''.join(b.get('text', '') for b in r['output']['message']['content'])
            d = json.loads(re.search(r'\{.*\}', txt, re.S).group(0))
            return {x['i']: x for x in d['items']}, r.get('usage', {})
        except Exception as e:
            err = type(e).__name__
    raise SystemExit('haiku failed ' + err)


def main():
    its = C.items(); U = C.units()
    R = pd.read_parquet(f'{C.W}/lex.parquet'); R = R[(R['mode'] == 'all') & (R.label == 'ale')]
    out = {}; usage = collections.Counter()
    for corpus, sp in GROUPS:
        g = R[(R.corpus == corpus) & (R.speaker == sp)]
        L = C.label_map(U, 'ale', 'consult' if corpus == 'K' else 'episode')
        segs = segs_of(its, corpus, sp)
        rows = []
        for direc, sub in (('conv', g.nlargest(TOP, 'z')), ('non', g.nsmallest(TOP, 'z'))):
            want = 1 if direc == 'conv' else 0
            for r in sub.itertuples():
                cand = [snippet(s, r.term) for u, ss in segs.items() if L.get(u) == want for s in ss]
                cand = [c for c in cand if c]
                random.Random(hash(r.term) % 1000).shuffle(cand)
                rows.append((direc, r.term, (sorted(cand[:5], key=len)[len(cand[:5]) // 2] if cand else '')))
        res, u = ask([(t, s) for _, t, s in rows]); usage.update(u)
        out[f'{corpus}:{sp}'] = [dict(direction=d, term=t, gloss=res.get(i + 1, {}).get('gloss', ''), en=res.get(i + 1, {}).get('en', '') if s else '')
                                 for i, (d, t, s) in enumerate(rows)]
        print(corpus, sp, len(rows), dict(usage))
    p = f'{C.W}/quotes.json'; json.dump(out, open(p, 'w'), ensure_ascii=False, indent=0); os.chmod(p, 0o600)


if __name__ == '__main__': main()
