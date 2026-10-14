# R4 refuter runner. Uses scorer4.py's own score() and VARIANTS (the thing under test); records full text and jiwer S/D/I.
# Cell spec: arm:run:tag:mic:shift   e.g. dfn:run3:snr0:B:2   (run4 is scored from 6.0 s, as scorer4 does)
# Usage: python r4run.py one   <V> <th> <cell>                 one score, fresh process
#        python r4run.py inter <V> <th> <rounds> <cell> <cell> ...   rounds x (each cell once), one process: calls of a cell are separated by other cells
#        python r4run.py seq   <V> <th> <cell> <cell> ...       cells in the given order, one process
import sys, json, time, hashlib, jiwer
import scorer4 as S
def load(spec):
    arm, run, tag, mic, sh = spec.split(":"); return S.loadarr(S.read48(arm, run, tag, mic)[int(sh):]), (6.0 if run == "run4" else 0.0)
def emit(m, V, th, spec, x, start, mode, call):
    t0 = time.time(); w, text, loops, nseg = S.score(m, x, V, start)
    o = jiwer.process_words(S.norm(S.ref), S.norm(text))
    print(json.dumps(dict(mode=mode, call=call, variant=V, threads=th, cell=spec, wer=round(w, 2),
          text_sha=hashlib.sha256(text.encode()).hexdigest()[:12], in_sha=hashlib.sha256(x.tobytes()).hexdigest()[:12],
          nseg=nseg, loops=loops, loops_full=S.loops_full(text), nwords=len(S.norm(text).split()),
          S=o.substitutions, D=o.deletions, I=o.insertions, H=o.hits, sec=round(time.time() - t0), text=text)), flush=True)
mode, V, th = sys.argv[1], sys.argv[2], int(sys.argv[3]); m = S.make_model(th)
if mode == "one":
    x, st = load(sys.argv[4]); emit(m, V, th, sys.argv[4], x, st, "fresh", 0)
elif mode == "inter":
    rounds, cells = int(sys.argv[4]), sys.argv[5:]; X = {c: load(c) for c in cells}
    for r in range(rounds):
        for c in cells: emit(m, V, th, c, *X[c], "inter", r)
elif mode == "seq":
    for i, c in enumerate(sys.argv[4:]): emit(m, V, th, c, *load(c), "seq", i)
