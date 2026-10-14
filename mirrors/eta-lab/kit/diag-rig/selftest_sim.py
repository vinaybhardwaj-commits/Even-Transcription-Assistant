#!/usr/bin/env python3
"""Synthetic room recording for the self-test scorer (tests and reviewers): plays a pack the way the Room Recorder app does (files in pack.json order, `gap_s` of
silence between them, `lead_s` before the first and `tail_s` after the last) through a cheap synthetic room and writes the recording + the app-style play log.
Room = broadband gain, parallel feedback combs sharing ONE exponential decay (known RT60), optional biquad notch (a room mode / resonance dip), white noise floor and
optional intermittent noise bursts (talk nearby). Stdlib only; ~10-20 s for a 26 s excerpt."""
import argparse
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wavio  # noqa: E402
from score_selftest_room import read_any  # noqa: E402


def play(pack_dir, gap_s=0.5, lead_s=1.5, tail_s=1.5, upto=None, sr_expect=48000):
    """-> (samples, {stimulus id: file start time s on the recording clock})."""
    pj = wavio.jload(os.path.join(pack_dir, "pack.json"))
    out = wavio.silence(lead_s, sr_expect)
    starts, t = {}, lead_s
    for s in pj["stimuli"]:
        x, sr = read_any(os.path.join(pack_dir, s["file"]))
        starts[s["id"]] = t
        out.extend(x)
        t += len(x) / sr
        out.extend(wavio.silence(gap_s, sr))
        t += gap_s
        if s["id"] == upto:
            break
    out.extend(wavio.silence(tail_s, sr_expect))
    return out, starts


def room(x, sr, gain=0.5, rt60=0.6, noise_dbfs=-55.0, burst_dbfs=None, burst_s=0.3, burst_period_s=1.0, notch_hz=None, notch_q=8.0, seed=7):
    rnd = random.Random(seed)
    delays = [int(sr * d) for d in (0.0123, 0.0177, 0.0231)]
    gains = [10 ** (-3.0 * d / sr / rt60) for d in delays]
    bufs = [[0.0] * d for d in delays]
    pos = [0] * len(delays)
    if notch_hz:                                                     # RBJ biquad notch: a deep dip at one frequency
        w0 = 2 * math.pi * notch_hz / sr
        al = math.sin(w0) / (2 * notch_q)
        b0, b1, b2, a0, a1, a2 = 1.0, -2 * math.cos(w0), 1.0, 1 + al, -2 * math.cos(w0), 1 - al
        z1 = z2 = 0.0
    sig = wavio.db(noise_dbfs)
    bamp = wavio.db(burst_dbfs) if burst_dbfs is not None else 0.0
    out = []
    for i, v in enumerate(x):
        acc = 0.0
        for j, d in enumerate(delays):
            y = v + gains[j] * bufs[j][pos[j]]
            bufs[j][pos[j]] = y
            pos[j] = (pos[j] + 1) % d
            acc += y
        y = gain * acc / len(delays)
        if notch_hz:
            o = (b0 * y + z1) / a0
            z1 = b1 * y - a1 * o + z2
            z2 = b2 * y - a2 * o
            y = o
        y += rnd.gauss(0, sig)
        if bamp and (i / sr) % burst_period_s < burst_s:
            y += rnd.gauss(0, bamp)
        out.append(y)
    return out


def simulate(pack_dir, out_wav, play_log_path=None, gap_s=0.5, lead_s=1.5, upto="canary-3", **room_kw):
    comp, starts = play(pack_dir, gap_s, lead_s, upto=upto)
    rec = room(comp, 48000, **room_kw)
    wavio.write_wav(out_wav, rec, 48000)
    if play_log_path:
        with open(play_log_path, "w") as f:
            json.dump(starts, f, indent=1)
    return starts


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--play-log", default=None)
    ap.add_argument("--gap-s", type=float, default=0.5)
    ap.add_argument("--lead-s", type=float, default=1.5)
    ap.add_argument("--upto", default="canary-3")
    ap.add_argument("--gain", type=float, default=0.5)
    ap.add_argument("--rt60", type=float, default=0.6)
    ap.add_argument("--noise-dbfs", type=float, default=-55.0)
    ap.add_argument("--burst-dbfs", type=float, default=None)
    ap.add_argument("--notch-hz", type=float, default=None)
    a = ap.parse_args()
    simulate(a.pack, a.out, a.play_log, a.gap_s, a.lead_s, a.upto, gain=a.gain, rt60=a.rt60, noise_dbfs=a.noise_dbfs, burst_dbfs=a.burst_dbfs, notch_hz=a.notch_hz)
