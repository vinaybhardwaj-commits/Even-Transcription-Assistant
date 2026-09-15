#!/usr/bin/env python3
"""Independent reference implementation of spec/CONVERSION-48K-STEREO-TO-16K-MONO.md.

Written from the specification document, not from the Swift code, to show the written rules are enough.
Variants exist only to measure that each rule is exercised by the C9 fixture; the default is the spec.

usage: reference_decimator.py TAPS INPUT OUTPUT [--phase P] [--round-half-away] [--acc32] [--perturb I]
"""
import struct, sys

def convert(taps, data, phase=2, round_half_away=False, acc32=False):
    n_taps = len(taps)
    frames = len(data) // 4
    history = [0] * n_taps          # m[n - i] for i = 0 .. 120; zero before stream start
    out = bytearray()
    for n in range(frames):
        l, r = struct.unpack_from("<hh", data, 4 * n)
        m = l + r                   # exact; no halving, no rounding
        history.pop()
        history.insert(0, m)
        if n % 3 != phase:
            continue
        acc = sum(h * x for h, x in zip(taps, history))
        if acc32:
            acc = (acc + 2**31) % 2**32 - 2**31
        if round_half_away:
            q, rem = divmod(abs(acc), 131072)
            y = (q + (1 if rem >= 65536 else 0)) * (1 if acc >= 0 else -1)
        else:
            y = (acc + 65536) >> 17  # Python >> on negative ints is floor, i.e. arithmetic shift
        y = max(-32768, min(32767, y))
        out += struct.pack("<h", y)
    return bytes(out)

if __name__ == "__main__":
    taps = [int(x) for x in open(sys.argv[1]).read().split("\n") if x != ""]
    data = open(sys.argv[2], "rb").read()
    a = sys.argv[4:]
    if "--perturb" in a:
        taps[int(a[a.index("--perturb") + 1])] += 1
    out = convert(taps, data,
                  phase=int(a[a.index("--phase") + 1]) if "--phase" in a else 2,
                  round_half_away="--round-half-away" in a,
                  acc32="--acc32" in a)
    open(sys.argv[3], "wb").write(out)
