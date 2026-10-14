"""vj-refuter: independent recompute of ruling 186 (best, margin, confident) from vj-data's stored vectors + stored centroids."""
import json, os, base64, struct
import numpy as np
from collections import Counter
D = "/home/eta/dev/eta-lab/studies/2026-09-24-voice-jev/data"
t = json.load(open(f'{D}/classification186.json'))['turns']; vec = json.load(open(f'{D}/emb_ecapa/turn_vecs_rooms.json')); cl = {}
for f in ('clusters_core.json', 'clusters_w58.json', 'clusters_wlist.json'):
    p = f'{D}/emb_ecapa/{f}'
    if os.path.exists(p): cl.update(json.load(open(p)))
CD = os.path.expanduser('~/eta-data/vj/centroids')
def cen(f, k):
    b = base64.b64decode(json.load(open(f'{CD}/{f}'))[k]); v = np.array(struct.unpack('<%df' % (len(b)//4), b)); return v/np.linalg.norm(v)
C = {'banerjee': cen('animesh-banerjee-opd3.json','centroid_base64'), 'salanki': cen('salanki-opd5-c270.json','embedding_base64'), 'ankit': cen('ankit-opd7-tonor.json','embedding_base64')}
u = lambda v: np.asarray(v, float)/np.linalg.norm(v)
agree = dis = miss = 0; ex = []; mine_conf = 0
for r in t:
    d = r['verified_doctor']
    if not d: continue
    if r['source_ref'] not in vec: miss += 1; continue
    x = u(vec[r['source_ref']]); best = float(x @ C[d])
    others = [float(x @ u(v['emb'])) for k, v in cl.get(r['item'], {}).items() if str(k) != str(r['speaker_idx'])]
    others += [float(x @ c) for dd, c in C.items() if dd != d]
    m = round(best - max(others), 4) if others else None
    mine = m is not None and m >= 0.10 and best >= 0.50; mine_conf += mine
    if mine == r['confident_186_margin_only']: agree += 1
    else:
        dis += 1
        if len(ex) < 8: ex.append((r['item'], r['source_ref'][-24:], round(best, 4), r['best'], m, r['margin'], mine, r['confident_186_margin_only']))
print('turns with verified doctor', agree + dis + miss, '| agree', agree, 'disagree', dis, 'no vector', miss, '| my confident-186', mine_conf, 'theirs', sum(bool(r['confident_186_margin_only']) for r in t))
for e in ex: print(e)
