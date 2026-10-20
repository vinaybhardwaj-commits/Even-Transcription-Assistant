import json, glob, os, collections, random, itertools, statistics as stt
H = os.path.expanduser
R = H('~/oc/palimpsest/ft6/run1')
C = [json.load(open(f)) for f in sorted(glob.glob(R + '/consult-*.json'))]
out = []
P = lambda *a: out.append(' '.join(str(x) for x in a))
ARMS = ['CUR', 'S', 'M']
P('consults', len(C), 'lang', dict(collections.Counter(c['lang'] for c in C)))
P('turns', sum(len(c['turns']) for c in C), 'judged', sum(len(c['judged']) for c in C),
  'per-consult judged', sorted(collections.Counter(len(c['judged']) for c in C).items()))
P('turn lang', dict(collections.Counter(t['lang'] for c in C for t in c['turns'])))
P('current_track', dict(collections.Counter(t['current_track'] for c in C for t in c['turns'])))
P('judged current_track', dict(collections.Counter(c['turns'][j['index']]['current_track'] for c in C for j in c['judged'])))
P('empty S/M/current all turns', sum(not t['S'] for c in C for t in c['turns']), sum(not t['M'] for c in C for t in c['turns']), sum(not (t['current'] or '').strip() for c in C for t in c['turns']))
# consistency judged vs turns
bad = 0
for c in C:
    for j in c['judged']:
        t = c['turns'][j['index']]
        if not (t['native'] == j['native'] and t['current'] == j['versions']['CUR'] and t['S'] == j['versions']['S'] and t['M'] == j['versions']['M']): bad += 1
P('judged rows inconsistent with turns', bad)
# scores
sc = {a: [] for a in ARMS}; fl = collections.Counter(); wins = collections.defaultdict(collections.Counter)
vals = collections.Counter()
for c in C:
    for j in c['judged']:
        s = j['judge']['scores_by_arm']
        for a in ARMS: sc[a].append(s[a]); vals[s[a]] += 1
        for f in j['judge']['flips']: fl[f['arm']] += 1
        m = max(s[a] for a in ARMS); best = [a for a in ARMS if s[a] == m]
        wins[c['lang']][best[0] if len(best) == 1 else 'TIE'] += 1
P('score values', dict(vals))
for a in ARMS: P(a, 'mean', round(sum(sc[a]) / len(sc[a]), 4), 'n', len(sc[a]), 'flips', fl[a])
P('wins/ties', {k: dict(v) for k, v in sorted(wins.items())})
P('flips_unverified total', sum(j['judge']['flips_unverified'] for c in C for j in c['judged']))
# turn-level flip count vs flips (a turn can have >1 flip per arm?)
P('CUR flip turns', sum(any(f['arm'] == 'CUR' for f in j['judge']['flips']) for c in C for j in c['judged']),
  'consults with CUR flip', sum(any(f['arm'] == 'CUR' for j in c['judged'] for f in j['judge']['flips']) for c in C))
P('CUR flips by lang', dict(collections.Counter(c['lang'] for c in C for j in c['judged'] for f in j['judge']['flips'] if f['arm'] == 'CUR')))
P('CUR flips by consult (sorted)', sorted((sum(f['arm'] == 'CUR' for j in c['judged'] for f in j['judge']['flips']) for c in C), reverse=True))
# flip score consistency
P('flip arm score dist', dict(collections.Counter((f['arm'], j['judge']['scores_by_arm'][f['arm']]) for c in C for j in c['judged'] for f in j['judge']['flips'])))
P('preserves contains flipped arm', sum(f['arm'] in j['judge']['preserves'] for c in C for j in c['judged'] for f in j['judge']['flips']))
# (3) quotes
ok_n = ok_e = ok_lab = ok_both = 0; n = 0; ok_e_norm = 0; e_in_other = 0
def norm(s): return ' '.join(s.split()).lower()
for c in C:
    for j in c['judged']:
        inv = {v: k for k, v in j['labels'].items()}
        for f in j['judge']['flips']:
            n += 1
            a = f['arm']; nq = f.get('native_quote', ''); eq = f.get('english_quote', '')
            i1 = bool(nq) and nq in j['native']; i2 = bool(eq) and eq in j['versions'][a]
            ok_n += i1; ok_e += i2; ok_both += i1 and i2
            ok_e_norm += bool(eq) and norm(eq) in norm(j['versions'][a])
            ok_lab += j['labels'].get(f.get('label')) == a
            e_in_other += any(eq and eq in j['versions'][b] for b in ARMS if b != a)
P('kept flips', n, 'native_quote exact', ok_n, 'english_quote exact in named arm', ok_e, 'both', ok_both, 'eng norm', ok_e_norm, 'label->arm consistent', ok_lab, 'eng quote also in another arm', e_in_other)
P('quote lens native', sorted(len(f['native_quote']) for c in C for j in c['judged'] for f in j['judge']['flips']))
# (4) blinding
perms = collections.Counter(tuple(j['labels'][k] for k in sorted(j['labels'])) for c in C for j in c['judged'])
P('label perms', len(perms), dict(perms))
P('label keys', dict(collections.Counter(tuple(sorted(j['labels'])) for c in C for j in c['judged'])))
P('CUR position', dict(collections.Counter(inv for c in C for j in c['judged'] for inv, a in j['labels'].items() if a == 'CUR')))
leak = collections.Counter()
for c in C:
    for j in c['judged']:
        for a in ARMS:
            v = j['versions'][a]
            for w in ['CUR', 'Sarvam', 'Gemini', 'Mayura', 'Saaras', 'translat', 'Translat', 'Here is', 'Note:', '\n', '"', '(']:
                if w in v: leak[(a, w)] += 1
P('version-text markers', dict(leak))
P('identical CUR==S', sum(j['versions']['CUR'] == j['versions']['S'] for c in C for j in c['judged']), 'CUR==M', sum(j['versions']['CUR'] == j['versions']['M'] for c in C for j in c['judged']), 'S==M', sum(j['versions']['S'] == j['versions']['M'] for c in C for j in c['judged']))
# mean score by position letter (position bias)
pos = collections.defaultdict(list)
for c in C:
    for j in c['judged']:
        for L, a in j['labels'].items(): pos[L].append(j['judge']['scores_by_arm'][a])
P('mean score by label letter', {L: round(sum(v) / len(v), 3) for L, v in sorted(pos.items())})
# (5) selection: are judged turns the top-8 by affect? ties at threshold? length
for c in C[:0]: pass
lens_j = [len(j['native']) for c in C for j in c['judged']]; lens_a = [len(t['native']) for c in C for t in c['turns']]
P('native len judged median', stt.median(lens_j), 'all median', stt.median(lens_a))
P('affect values judged', sorted(collections.Counter(j['affect'] for c in C for j in c['judged']).items()))
# CUR vs M length ratio on judged turns (alignment proxy)
def wl(s): return max(1, len((s or '').split()))
rat = [wl(j['versions']['CUR']) / wl(j['versions']['M']) for c in C for j in c['judged']]
P('CUR/M wordlen ratio judged: <0.5', sum(r < 0.5 for r in rat), '>2', sum(r > 2 for r in rat), 'of', len(rat))
ratf = [wl(j['versions']['CUR']) / wl(j['versions']['M']) for c in C for j in c['judged'] for f in j['judge']['flips'] if f['arm'] == 'CUR']
P('on CUR flips: <0.5', sum(r < 0.5 for r in ratf), '>2', sum(r > 2 for r in ratf), 'of', len(ratf))
# (8) bootstrap over consults
def stats(cs):
    nt = sum(len(c['judged']) for c in cs)
    fc = sum(f['arm'] == 'CUR' for c in cs for j in c['judged'] for f in j['judge']['flips'])
    fm = sum(f['arm'] == 'M' for c in cs for j in c['judged'] for f in j['judge']['flips'])
    gap = sum(j['judge']['scores_by_arm']['M'] - j['judge']['scores_by_arm']['CUR'] for c in cs for j in c['judged'])
    fs = sum(f['arm'] == 'S' for c in cs for j in c['judged'] for f in j['judge']['flips'])
    gapS = sum(j['judge']['scores_by_arm']['M'] - j['judge']['scores_by_arm']['S'] for c in cs for j in c['judged'])
    return (fc - fm) / nt, gap / nt, fc / nt, (fc - fs) / nt, gapS / nt
rng = random.Random(20261020); B = 10000
bs = [stats([rng.choice(C) for _ in C]) for _ in range(B)]
names = ['CUR-M flip rate', 'M-CUR mean gap', 'CUR flip rate', 'CUR-S flip rate', 'M-S mean gap']
pt = stats(C)
for i, nm in enumerate(names):
    v = sorted(b[i] for b in bs)
    P(nm, 'point', round(pt[i], 4), '95%CI', round(v[int(.025 * B)], 4), round(v[int(.975 * B) - 1], 4), 'P(<=0)', sum(x <= 0 for x in v) / B)
# per-language CUR flip rate and gap
for L in ['hi', 'kn', 'te']:
    cs = [c for c in C if c['lang'] == L]; s = stats(cs); P('lang', L, 'n', len(cs), 'CUR flip rate', round(s[2], 3), 'gap', round(s[1], 3))
# sign test over consults on gap
g = [stats([c])[1] for c in C]; P('consults with M>CUR mean', sum(x > 0 for x in g), '=', sum(x == 0 for x in g), '<', sum(x < 0 for x in g))
open(H('~/wt/ft-refute-ft6/work/OWN-NUMBERS.txt'), 'w').write('\n'.join(out) + '\n')
print('\n'.join(out))
