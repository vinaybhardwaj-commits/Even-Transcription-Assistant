"""L6: remove one beacon from one mic in an L4 case. usage: l6_missed.py L4_DIR OUT_DIR [--mic mic2] [--index 3] [--ppm 3]
Copies the wavs with the left beacon `index` of block 1 on `mic` silenced (+-2.5 s), runs walk_sync on the copy and on the original,
and compares drift with the truth (mic2 +ppm, pi -ppm against mic1)."""
import argparse, os, json
import numpy as np, soundfile as sf
import beacon_gen as bg, walk_sync as W, beacon_sync as bs, locate as L
ap = argparse.ArgumentParser(); ap.add_argument("src"); ap.add_argument("out"); ap.add_argument("--mic", default="mic2"); ap.add_argument("--index", type=int, default=3); ap.add_argument("--ppm", type=float, default=3.0)
a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
names = ["mic1", "mic2", "pi"]
x = bs.load(f"{a.src}/{a.mic}.wav")
t = sorted(r[0] / bg.FS for r in W.arrivals(x, bg.make_sweep()))[a.index]
x[int((t - 2.5) * bg.FS):int((t + 2.5) * bg.FS)] = 0.0
sf.write(f"{a.out}/{a.mic}.wav", x, bg.FS, subtype="PCM_16")
paths = [f"{a.out}/{n}.wav" if n == a.mic else f"{a.src}/{n}.wav" for n in names]
true = {"mic2": a.ppm, "pi": -a.ppm}
for label, p in (("original", [f"{a.src}/{n}.wav" for n in names]), (f"{a.mic} beacon {a.index} silenced at {t:.1f} s", paths)):
    r = W.run(p)
    print(label + ": " + "; ".join(f"{n} drift {r['drift_ppm'][n]:+.4f} ppm (truth {true[n]:+.1f}, err {r['drift_ppm'][n] - true[n]:+.4f})" for n in names[1:]) +
          f"; unpaired {len(r['pair_dropped'])}, usable left per block {r['usable_left_per_block']}")
    for d in r["pair_dropped"]:
        print("   ", d)
