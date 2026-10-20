"""ft-engines: Clef-omni (@cf/cloudflare/clef-omni) per item and speaker role. Run under `sg clef -c` (the /opt/clef helper reads its own credential; this script never
reads, prints or passes it). Request/parse code is Timbre's tools/timbre/extractors/clef_omni.py (encode_wav, questions_payload, parse_features, US$0.15 per M input tokens);
transport is /opt/clef clef.run (as kit/reb parts_lane). Question set: timbre-clef-v1 text with the speaker role substituted for "patient" and a call/consult state.
One request = one clip = the role's scored windows of that item concatenated (0.15 s gaps) up to CAP_S, evenly thinned if longer. Numbers only, no audio/text logged.
Usage: clef_run.py <windows.jsonl> <out.jsonl> <setting call|consult> [--limit N] [--synthetic]
windows rows need item, path, t0, t1 and role (patient|counsellor|doctor|all; 'all' rows = every window again, role-free). Resumable on (item, role)."""
import sys, os, json, time, subprocess, collections, argparse, threading
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, '~/dev/eta-fs-run'); sys.path.insert(0, '/opt/clef')
from tools.timbre.extractors import clef_omni as tc
import clef

CAP_S, GAP_S, SR = 240.0, 0.15, 16000      # 240 s of 16 kHz int16 = 7.7 MB < the 8 MiB clip limit
QSET = 'ftengines-clef-v1 (timbre-clef-v1 role-substituted)'
STATE = {'call': "Phone call between a hospital counsellor and a patient (or the patient's family) about a planned treatment. The audio is a clip of the {role} only. "
                 "Judge the {role}'s affect from the audio only.",
         'consult': "Outpatient clinic consultation. The audio is a clip of the {role} only. Judge the {role}'s affect from the audio only."}
SPEAKER = {'patient': 'patient', 'counsellor': 'counsellor', 'doctor': 'doctor', 'all': 'patient'}
# role 'all' = role-free: every scored window of the item (both speakers); the questions stay about the patient and Clef itself tells who is who
STATE_ALL = {'call': "Phone call between a hospital counsellor and a patient (or the patient's family) about a planned treatment. The audio is a clip of the conversation "
                     "(both speakers). Judge the patient's affect from the audio only.",
             'consult': "Outpatient clinic consultation. The audio is a clip of the conversation (doctor and patient). Judge the patient's affect from the audio only."}


def questions(role):
    q = tc.questions_payload()   # keys stay as Timbre's (parse_features reads 'one_patient'); only the instruction text names the role
    for v in q.values(): v['instructions'] = v['instructions'].replace('patient', role)
    return q


def load(p):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', p, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def build_clip(a, ws):
    ws = sorted(ws, key=lambda w: w['t0'])
    tot = sum(w['t1'] - w['t0'] + GAP_S for w in ws)
    if tot > CAP_S:
        k = max(1, int(len(ws) * CAP_S / tot))
        ws = [ws[i] for i in np.linspace(0, len(ws) - 1, k).astype(int)]
    gap = np.zeros(int(GAP_S * SR), np.float32); parts = []
    for w in ws: parts += [a[int(w['t0'] * SR):int(w['t1'] * SR)], gap]
    x = np.concatenate(parts)[:int(CAP_S * SR)]
    return x, len(ws)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('windows'); ap.add_argument('out'); ap.add_argument('setting', choices=list(STATE))
    ap.add_argument('--limit', type=int, default=0); ap.add_argument('--synthetic', action='store_true'); ap.add_argument('--workers', type=int, default=4)
    a = ap.parse_args()
    W = [json.loads(l) for l in open(a.windows)]
    done = {(json.loads(l)['item'], json.loads(l)['role']) for l in open(a.out)} if os.path.exists(a.out) else set()
    g = collections.defaultdict(list)
    for w in W:
        if w.get('role') in SPEAKER and (w['item'], w['role']) not in done: g[(w['item'], w['role'])].append(w)
    keys = sorted(g)[:a.limit] if a.limit else sorted(g)
    print('clips todo', len(keys), 'done', len(done), flush=True)
    lock = threading.Lock(); tot = collections.Counter(); cache = {}

    def one(key):
        item, role = key; ws = g[key]
        row = dict(item=item, role=role, question_set=QSET, model=clef.MODEL_ID)
        try:
            if a.synthetic: x = (0.05 * np.sin(np.linspace(0, 2000, SR * 10))).astype(np.float32); n = 0
            else:
                with lock:
                    if ws[0]['path'] not in cache: cache.clear(); cache[ws[0]['path']] = load(ws[0]['path'])
                    au = cache[ws[0]['path']]
                x, n = build_clip(au, ws)
            wav = tc.encode_wav(x, SR)
            st = STATE_ALL[a.setting] if role == 'all' else STATE[a.setting].format(role=SPEAKER[role])
            for att in range(4):
                try: payload = clef.run(st, questions(role), audio=[wav], timeout=180); break
                except clef.ClefError as e:
                    msg = str(e)
                    if att == 3 or not any(c in msg for c in ('HTTP 429', 'HTTP 5', 'timed out')): raise
                    time.sleep(5 * (att + 1))
                except (TimeoutError, OSError):
                    if att == 3: raise
                    time.sleep(5 * (att + 1))
            f = tc.parse_features(payload)
            f['one_speaker'] = f.pop('one_patient')
            row.update(f, status='ok', clip_s=round(len(x) / SR, 2), n_windows=n)
        except Exception as e:
            row.update(status='error ' + type(e).__name__ + ' ' + tc.scrub(str(e))[:80])
        with lock:
            fh.write(json.dumps(row) + '\n'); fh.flush()
            tot['n'] += 1; tot['ok'] += row['status'] == 'ok'; tot['usd'] += row.get('cost_usd', 0) or 0; tot['tok'] += row.get('input_tokens', 0) or 0
            if tot['n'] % 50 == 0: print('clef', dict(tot), flush=True)

    # items in path order so the decode cache hits; one decoded item at a time
    keys.sort(key=lambda k: g[k][0]['path'])
    with open(a.out, 'a', opener=lambda p, f: os.open(p, f, 0o600)) as fh:
        with ThreadPoolExecutor(a.workers) as pool: list(pool.map(one, keys))
    print('DONE clef', dict(tot), flush=True)


if __name__ == '__main__': main()
