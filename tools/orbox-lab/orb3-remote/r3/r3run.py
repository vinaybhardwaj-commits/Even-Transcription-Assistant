# R3 refuter runner. One score per fresh process, using scorer3.py's own score() (the thing under test).
# Usage: python r3run.py <cell> <threads> <shift> [noseed|inproc3]   inproc3: score the same input 3 times in ONE process (seeded)
#   cells: dfn_snr0_B (C2/C4), run4_spR_nzL_0_A (C3, from 6.0 s as run4_score.py), raw_snr20_B (C3), raw_snr5_A (C5/C6)
# noseed: replaces ctranslate2.set_random_seed with a no-op in THIS process only (C4 negative control); scorer3.py is not edited.
import sys, json, time, hashlib, ctranslate2
cell, th, sh = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); noseed = len(sys.argv) > 4 and sys.argv[4] == "noseed"; reps = 3 if len(sys.argv) > 4 and sys.argv[4] == "inproc3" else 1
if noseed: ctranslate2.set_random_seed = lambda seed: None
import scorer3 as S
CELLS = {"dfn_snr0_B": ("dfn", "run3", "snr0", "B", 0.0), "run4_spR_nzL_0_A": ("raw", "run4", "spR_nzL_0", "A", 6.0),
         "raw_snr20_B": ("raw", "run3", "snr20", "B", 0.0), "raw_snr5_A": ("raw", "run3", "snr5", "A", 0.0)}
arm, run, tag, mic, start = CELLS[cell]
t0 = time.time(); x16 = S.loadarr(S.read48(arm, run, tag, mic)[sh:])
m = S.make_model(th)
for rep in range(reps):
  w, text, temps = S.score(m, x16, start)
  print(json.dumps(dict(cell=cell, threads=th, shift=sh, seeded=not noseed, wer=round(w, 2),
                      text_sha=hashlib.sha256(text.encode()).hexdigest()[:12], in_sha=hashlib.sha256(x16.tobytes()).hexdigest()[:12],
                      nseg=len(temps), n_temp_gt0=int(sum(t > 0 for t in temps)), sec=round(time.time() - t0))), flush=True)
