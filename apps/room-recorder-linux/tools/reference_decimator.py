#!/usr/bin/env python3
"""Independent reference implementation of spec/CONVERSION-48K-TO-16K-MONO.md.

Written from the specification document, not from the Swift code, to show the written rules are enough.
Variants exist only to measure that each rule is exercised by the C9 fixture; the default is the spec.

usage: reference_decimator.py TAPS INPUT OUTPUT [--channels C] [--phase P] [--round-half-away] [--acc32] [--perturb I]
       [--divisor-channels D]   (variant: the divisor's channel factor, when it must differ from --channels)
"""
import struct, sys

def convert(taps, data, channels=2, phase=2, round_half_away=False, acc32=False, divisor_channels=None):
    n_taps = len(taps)
    bytes_per_frame = 2 * channels
    frames = len(data) // bytes_per_frame
    divisor = (divisor_channels if divisor_channels else channels) << 16   # §5: channels x 2^16
    bias = divisor // 2
    history = [0] * n_taps          # m[n - i] for i = 0 .. 120; zero before stream start
    out = bytearray()
    for n in range(frames):
        s = struct.unpack_from("<" + "h" * channels, data, bytes_per_frame * n)
        m = sum(s)                  # §2: the mean, held as the exact sum; the division by channels is in `divisor`
        history.pop()
        history.insert(0, m)
        if n % 3 != phase:
            continue
        acc = sum(h * x for h, x in zip(taps, history))
        if acc32:
            acc = (acc + 2**31) % 2**32 - 2**31
        if round_half_away:
            q, rem = divmod(abs(acc), divisor)
            y = (q + (1 if rem >= bias else 0)) * (1 if acc >= 0 else -1)
        else:
            y = (acc + bias) // divisor  # Python // on ints is floor division, as §5 requires
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
                  channels=int(a[a.index("--channels") + 1]) if "--channels" in a else 2,
                  phase=int(a[a.index("--phase") + 1]) if "--phase" in a else 2,
                  round_half_away="--round-half-away" in a,
                  acc32="--acc32" in a,
                  divisor_channels=int(a[a.index("--divisor-channels") + 1]) if "--divisor-channels" in a else None)
    open(sys.argv[3], "wb").write(out)
