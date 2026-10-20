import sys, os, glob, csv, collections
H = os.path.expanduser
sys.path.insert(0, H('~/oc/forest-lead/ft/vendor_split'))
import split_guard as SG
g = SG.load(lock_dir=H('~/eta-data/forest/split'), pinned_list_sha256='52959278edd8cd5db65c362fb8fb872c1d8e7b79767fac81334d321491052d65')
print('lock_id', g.lock_id)
uids = [os.path.basename(f)[8:-5] for f in sorted(glob.glob(H('~/oc/palimpsest/ft6/run1/consult-*.json')))]
pk = {r['consult_uid']: r['patient_key'] for r in csv.DictReader(open(H('~/oc/forest-lead/data/10b-patient-key-c2.tsv')), delimiter='\t')}
pk10 = {}
cl = {r['patient_key']: r['cluster_key'] for r in csv.DictReader(open(H('~/eta-data/forest/split/clusters-2026-10-18.tsv')), delimiter='\t')}
cand = [l.strip() for l in open(H('~/oc/forest-lead/ft/ft6-candidates.txt')) if l.strip()]
st = collections.Counter()
for u in uids:
    k = pk.get(u)
    if not k: st['no_patient_key'] += 1; continue
    try: st[g.set_of(cl.get(k, k))] += 1
    except SG.GuardError as e: st['guard_' + type(e).__name__] += 1
print('n_uids', len(uids), 'in_candidates', sum(u in cand for u in uids), 'in_first48', sum(u in cand[:48] for u in uids))
print('split', dict(st))
