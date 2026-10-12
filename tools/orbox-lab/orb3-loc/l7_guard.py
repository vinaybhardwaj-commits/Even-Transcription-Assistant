"""O18 guard test: walk_sync on good data must pass; with one mic's pairing in block 0 forced off by one period (both blocks shifted alike is just a clock offset and cannot be detected) it must exit with the residual message.
usage: l7_guard.py DIR [DIR...]   (DIR holds mic1.wav mic2.wav pi.wav)"""
import sys
import walk_sync as W
for d in sys.argv[1:]:
    p = [f"{d}/{n}.wav" for n in ("mic1", "mic2", "pi")]
    r = W.run(p)
    print(f"{d}: good data OK, rms mic2 {r['resid_rms_us']['mic2']:.2f} us, pi {r['resid_rms_us']['pi']:.2f} us")
    for mic, j in (("mic2", 1), ("pi", -1)):
        try:
            W.run(p, force_j={mic: j}); print(f"{d}: forced {mic} {j:+d} period: DID NOT FIRE")
        except SystemExit as e:
            print(f"{d}: forced {mic} {j:+d} period: fired: {str(e)[:150]}")
