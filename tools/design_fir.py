#!/usr/bin/env python3
"""One-off design of the 48 kHz -> 16 kHz decimation FIR. Provenance only.

The integer taps this writes are the normative specification; nothing computes them at runtime.
Windowed sinc, Kaiser window. Taps are scaled by 2**Q, rounded half away from zero, and the
residual needed to make the sum exactly 2**Q is added to the centre tap (keeps symmetry).

usage: design_fir.py TAPS CUTOFF_HZ BETA Q [--write DIR]
"""
import math, sys

FS = 48000.0

def i0(x):
    # Modified Bessel function of the first kind, order 0, by power series.
    s, t, k = 1.0, 1.0, 1
    while True:
        t *= (x / (2.0 * k)) ** 2
        s += t
        if t < 1e-17 * s:
            return s
        k += 1

def design(n, fc, beta, q):
    m = (n - 1) / 2.0
    h = []
    for i in range(n):
        x = i - m
        sinc = 2.0 * fc / FS if x == 0 else math.sin(2.0 * math.pi * fc / FS * x) / (math.pi * x)
        w = i0(beta * math.sqrt(1.0 - (x / m) ** 2)) / i0(beta)
        h.append(sinc * w)
    total = sum(h)
    scale = 2 ** q
    ints = [int(math.floor(abs(v / total) * scale + 0.5)) * (1 if v >= 0 else -1) for v in h]
    ints[n // 2] += scale - sum(ints)
    assert sum(ints) == scale and ints == ints[::-1]
    return ints

def response_db(ints, f, q):
    re = sum(c * math.cos(2 * math.pi * f / FS * i) for i, c in enumerate(ints))
    im = sum(c * math.sin(2 * math.pi * f / FS * i) for i, c in enumerate(ints))
    mag = math.hypot(re, im) / 2 ** q
    return 20 * math.log10(mag) if mag > 0 else -999.0

def report(ints, q):
    pb = [response_db(ints, f, q) for f in range(0, 6001, 50)]
    sb = [response_db(ints, f, q) for f in range(8000, 24001, 25)]
    print(f"taps={len(ints)} sum={sum(ints)} max={max(ints)} min={min(ints)}")
    print(f"passband 0-6000 Hz: {min(pb):+.4f} .. {max(pb):+.4f} dB")
    for f in (3400, 6000, 6500, 7000, 7500, 8000):
        print(f"  {f} Hz: {response_db(ints, f, q):+.2f} dB")
    print(f"stopband >= 8000 Hz: worst {max(sb):+.2f} dB")
    print(f"sum|h| = {sum(abs(c) for c in ints)}")

if __name__ == "__main__":
    n, fc, beta, q = int(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
    ints = design(n, fc, beta, q)
    report(ints, q)
    if "--write" in sys.argv:
        d = sys.argv[sys.argv.index("--write") + 1]
        name = f"fir-48k-to-16k-{n}tap-q{q}.taps"
        with open(f"{d}/{name}", "w") as fh:
            fh.write("".join(f"{c}\n" for c in ints))
        print("wrote", f"{d}/{name}")
