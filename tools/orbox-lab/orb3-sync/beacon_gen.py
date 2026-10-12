"""Generate the beacon track: stereo, L = beacon sweeps, R = reversed check chirps."""
import sys
import numpy as np
import soundfile as sf

FS = 48000
SWEEP_S = 0.5
F1, F2 = 1000.0, 8000.0
PEAK_DBFS = -12.0
FADE_S = 0.010
LEAD_S = 3.0
PERIOD_S = 30.0
CHECK_DELAY_S = 15.0


def make_sweep(fs=FS, dur=SWEEP_S, f1=F1, f2=F2, peak_dbfs=PEAK_DBFS, fade=FADE_S):
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    k = dur / np.log(f2 / f1)
    s = np.sin(2 * np.pi * f1 * k * (np.exp(t / k) - 1.0))
    nf = int(round(fade * fs))
    ramp = 0.5 * (1.0 - np.cos(np.pi * np.arange(nf) / nf))
    w = np.ones(n)
    w[:nf] = ramp
    w[-nf:] = ramp[::-1]
    s *= w
    return s * (10.0 ** (peak_dbfs / 20.0) / np.abs(s).max())


def sweep_at(t, stretch=1.0, dur=SWEEP_S, f1=F1, f2=F2, peak_dbfs=PEAK_DBFS, fade=FADE_S):
    """Analytic sweep at times t (s from its start) on a clock that reads `stretch` times true time.

    Value at t is the unstretched sweep at t/stretch, so no resampling is involved. Zero outside [0, dur*stretch].
    """
    u = np.asarray(t, dtype=float) / stretch
    k = dur / np.log(f2 / f1)
    inside = (u >= 0) & (u < dur)
    uu = np.where(inside, u, 0.0)
    s = np.sin(2 * np.pi * f1 * k * (np.exp(uu / k) - 1.0))
    w = np.ones_like(uu)
    rise = uu < fade
    fall = uu > dur - fade
    w[rise] = 0.5 * (1.0 - np.cos(np.pi * uu[rise] / fade))
    w[fall] = 0.5 * (1.0 - np.cos(np.pi * (dur - 1.0 / FS - uu[fall]) / fade))  # make_sweep's last sample is index n-1
    return np.where(inside, s * w, 0.0) * SWEEP_GAIN


SWEEP_GAIN = 1.0
SWEEP_GAIN = 10.0 ** (PEAK_DBFS / 20.0) / np.abs(sweep_at(np.arange(int(round(SWEEP_S * FS))) / FS)).max()


def make_sweep_stretched(stretch, fs=FS):
    """The sweep as a recording clock that reads `stretch` times true time would hold it (starts at sample 0)."""
    n = int(np.ceil(SWEEP_S * stretch * fs)) + 1
    return sweep_at(np.arange(n) / fs, stretch)


def make_check_stretched(stretch, fs=FS):
    """The reversed check chirp on a clock reading `stretch` times true time (starts at sample 0)."""
    n = int(np.ceil(SWEEP_S * stretch * fs)) + 1
    end = (int(round(SWEEP_S * fs)) - 1) / fs * stretch  # last sample of the reversed sweep, as sweep[::-1]
    return sweep_at(end - np.arange(n) / fs, stretch)


def make_track(duration_s=360, fs=FS):
    """Return (stereo array, beacon start times, check start times) in track seconds."""
    sweep = make_sweep(fs)
    check = sweep[::-1].copy()
    n_b = int(duration_s // PERIOD_S)
    total = int(round((LEAD_S + duration_s) * fs))
    left = np.zeros(total)
    right = np.zeros(total)
    tb, tc = [], []
    for i in range(n_b):
        b = LEAD_S + i * PERIOD_S
        c = b + CHECK_DELAY_S
        ib, ic = int(round(b * fs)), int(round(c * fs))
        left[ib:ib + len(sweep)] = sweep
        right[ic:ic + len(check)] = check
        tb.append(b)
        tc.append(c)
    return np.stack([left, right], axis=1), tb, tc


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "beacon_track.wav"
    d = float(sys.argv[2]) if len(sys.argv) > 2 else 360
    x, tb, _ = make_track(d)
    sf.write(out, x, FS, subtype="PCM_16")
    print(f"wrote {out}: {len(x) / FS:.1f} s, {len(tb)} beacons")
