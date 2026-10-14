"""O18 R15 cases from an L4 dir: pi9 = the Pi recording starts 9 s late (first 9 s removed, offset moves by -9 s); pijump = the Pi clock jumps 3 s between the blocks (3 s of zeros inserted at 300 s).
usage: l8_cases.py L4_DIR OUT_DIR     then: walk_sync on pi9 (must pass, offsets -10.08 s in both blocks), on pijump (must fail loudly), locate on pi9 (positions as before)"""
import os, sys, json, subprocess
import numpy as np, soundfile as sf
import beacon_gen as bg, walk_sync as W, locate as L
src, out = sys.argv[1:3]; FS = bg.FS
x, fs = sf.read(f"{src}/pi.wav", dtype="int16")
for name, y in (("pi9", x[9 * FS:]), ("pijump", np.concatenate([x[:300 * FS], np.zeros(3 * FS, np.int16), x[300 * FS:]]))):
    d = f"{out}/{name}"; os.makedirs(d, exist_ok=True)
    for n in ("mic1", "mic2"):
        if not os.path.exists(f"{d}/{n}.wav"): os.symlink(os.path.abspath(f"{src}/{n}.wav"), f"{d}/{n}.wav")
    sf.write(f"{d}/pi.wav", y, FS, subtype="PCM_16")
    p = [f"{d}/{n}.wav" for n in ("mic1", "mic2", "pi")]
    try:
        r = W.run(p); json.dump(r, open(f"{d}/walk_sync.json", "w"))
        print(f"{name}: walk_sync OK  Pi offsets {r['offset_s']['pi']}  drift pi {r['drift_ppm']['pi']:+.4f} ppm mic2 {r['drift_ppm']['mic2']:+.4f}  c0_left pi {r['c0_left_ms']['pi']:+.1f} ms  rms {r['resid_rms_us']['pi']:.2f} us")
    except SystemExit as e:
        print(f"{name}: walk_sync exit: {str(e)[:260]}")
