"""Beacon block for the phone walk (O17 ruling 5): 120 s, a left sweep every 15 s (L) and a check chirp 7.5 s after each (R).
usage: walk_track.py OUT.wav     (the same file is played before and after the walk)"""
import sys
import numpy as np, soundfile as sf
import beacon_gen as bg

BLOCK_S, PERIOD_S, LEAD_S, CHECK_DELAY_S = 120.0, 15.0, 3.0, 7.5
N_EVENTS = int((BLOCK_S - LEAD_S) // PERIOD_S)          # 7 beacons + 7 checks


def make_block(fs=bg.FS):
    sweep = bg.make_sweep(fs)
    x = np.zeros((int(BLOCK_S * fs), 2))
    for i in range(N_EVENTS):
        b = int(round((LEAD_S + i * PERIOD_S) * fs)); c = int(round((LEAD_S + i * PERIOD_S + CHECK_DELAY_S) * fs))
        x[b:b + len(sweep), 0] = sweep
        x[c:c + len(sweep), 1] = sweep[::-1]
    return x


if __name__ == "__main__":
    sf.write(sys.argv[1], make_block(), bg.FS, subtype="PCM_16")
    print(f"wrote {sys.argv[1]}: {BLOCK_S:.0f} s, {N_EVENTS} beacons + {N_EVENTS} checks, one every {PERIOD_S:.0f} s")
