#!/usr/bin/env python3
"""Index-only tapes for deploy/u2-acceptance-verify.sh.

    tools/verify-fixtures-generate.py [OUT]        default OUT: fixtures/verify beside this repository's tools/

These are NOT conformance fixtures. They have no manifest.json, so `conformance run` never discovers them, and
`conformance generate --force` deletes all of fixtures/, so run this again after regenerating. Like all of fixtures/
the output is not committed; this generator is. It is deterministic: SEED is pinned, nothing reads the clock, and two
runs write byte-identical files.

Each tape.pcm is created empty and extended with truncate to the index's final byte_offset, so it is all zero bytes
and nothing ever reads it: the verify script only stat()s it. The levels in tape.idx are written directly and do not
describe the PCM. Windows are 100 samples (6.25 ms), so every tape is small.

  tape                              expected from u2-acceptance-verify.sh
  boot-crossing                     PASS. A same-boot restart after 1.002 s, then a reboot after 17.270 s where mono_ns
                                    drops from ~5000 s to 12 s and the implied boot instant is inside the downtime.
                                    0 breaks; coverage 2.250 s / 20.522 s = 10.9638 %. One isolated rail hit.
  reboot-mono-forward               PASS. A reboot where mono_ns happens to go FORWARD (8.75 s -> 12.003 s); only the
                                    boot epoch shows it.
  mono-backwards-no-marker          FAIL. boot-crossing with the reboot's stopped/restart removed.
  mono-backwards-at-device-lost     FAIL. The same with device_lost/resumed in their place: only restart can be a boot.
  epoch-step-no-restart             FAIL. wall_ns steps +2 s mid-session, mono_ns continuous, no marker.
  restart-epoch-outside-downtime    FAIL. A restart whose new epoch implies a boot 12.7 s BEFORE the old session ended.
  levels-missing                    FAIL. A checkpoint that added samples carries rms but no peak or zero_ratio.
  empty-checkpoint-with-levels      FAIL. A checkpoint that added no samples carries peak and zero_ratio.
  clipping                          FAIL on "not clipping" only. 27 of 300 checkpoints at peak 1.
  silence                           FAIL on "has sound" only. peak 0, rms 0, zero_ratio 1 everywhere.
"""
import json
import os
import random
import shutil
import sys

SEED = 20260916
MARK = ".generated-by-verify-fixtures-generate"
DEV = "sof-hda-dsp: DMIC Raw (hw:0,6) / Yoga — built-in"
W, NS = 100, 62_500                                     # samples per checkpoint window; ns per sample
G1, G2 = 1_002_000_000, 17_270_000_000                  # the live run's same-boot and reboot downtimes
BOOT1_MONO, BOOT2_MONO = 5_000_000_000_000, 12_000_000_000
WALL0 = 1_789_378_802_000_000_000                       # 2026-09-14 15:10:02 IST


class Tape:
    def __init__(self):
        self.recs, self.samples, self.mono, self.wall = [], 0, 0, 0
        self.rng = random.Random(SEED)

    def base(self, **kw):
        r = dict(byte_offset=self.samples * 2, samples=self.samples, mono_ns=self.mono, wall_ns=self.wall, device=DEV)
        r.update(kw)
        return r

    def frames(self):
        return dict(input_frames=self.samples * 3, input_sample_rate=48000)

    def anchor(self, mono, wall):
        """The empty first-audio checkpoint, TapeSession.swift:123-125."""
        self.mono, self.wall = mono, wall
        self.recs.append(self.base(rms=0, **self.frames()))

    def speech(self, i):
        peak = self.rng.randint(4_000, 16_000) / 32_768
        return peak, round(peak * self.rng.uniform(0.15, 0.4), 6), self.rng.randint(0, 3) / W

    def ckpts(self, n, level=None, after=None):
        for i in range(n):
            self.samples += W
            self.mono += W * NS
            self.wall += W * NS
            peak, rms, zr = (level or self.speech)(i)
            self.recs.append(self.base(rms=rms, peak=peak, zero_ratio=zr, **self.frames()))
            if after:
                after(self, i)

    def marker(self, kind, mono, wall, **kw):
        self.recs.append(self.base(discontinuity=kind, mono_ns=mono, wall_ns=wall, **kw))

    def stopped(self, d=5_000_000):
        self.marker("stopped", self.mono + d, self.wall + d, **self.frames())

    def write(self, root, name):
        d = os.path.join(root, name)
        os.makedirs(d)
        with open(os.path.join(d, "tape.idx"), "w", encoding="utf-8", newline="\n") as f:
            for r in self.recs:
                f.write(json.dumps(r, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
        pcm = os.path.join(d, "tape.pcm")
        open(pcm, "wb").close()
        os.truncate(pcm, self.samples * 2)             # zero bytes, sized only; never read


def three_sessions(reboot_gap, boot2_mono=BOOT2_MONO, rail_at=None):
    t = Tape()
    lvl = (lambda i: (1.0, 0.2, 0.0) if i == rail_at else t.speech(i)) if rail_at is not None else None
    t.anchor(BOOT1_MONO, WALL0)
    t.ckpts(120, lvl)
    m, w = t.mono, t.wall
    t.stopped()
    t.marker("restart", m + G1 - 300_000_000, w + G1 - 300_000_000, previous_byte_offset=t.samples * 2, surviving_tail_bytes=0)
    t.anchor(m + G1, w + G1)
    t.ckpts(120)
    m, w = t.mono, t.wall
    reboot_gap(t, m, w, boot2_mono)
    t.anchor(boot2_mono + 3_000_000, w + G2)
    t.ckpts(120)
    t.stopped(0)
    return t


def clean_reboot(t, m, w, boot2_mono):
    t.stopped()
    t.marker("restart", boot2_mono, w + G2 - 3_000_000, previous_byte_offset=t.samples * 2, surviving_tail_bytes=0)


def no_marker(t, m, w, boot2_mono):
    pass


def device_lost(t, m, w, boot2_mono):
    t.marker("device_lost", m + 5_000_000, w + 5_000_000, **t.frames())
    t.marker("resumed", boot2_mono + 3_000_000, w + G2, gap_ns=G2 - 5_000_000, **t.frames())


def one_session(n=300, level=None, after=None):
    t = Tape()
    t.anchor(BOOT1_MONO, WALL0)
    t.ckpts(n, level, after)
    t.stopped(0)
    return t


def reboot_mono_forward():
    t = Tape()
    t.anchor(8_000_000_000, WALL0)
    t.ckpts(120)
    w = t.wall
    t.stopped()
    t.marker("restart", 11_000_000_000, w + G2 - 1_003_000_000, previous_byte_offset=t.samples * 2, surviving_tail_bytes=0)
    t.anchor(12_003_000_000, w + G2)
    t.ckpts(120)
    t.stopped(0)
    return t


def epoch_step(t, i):
    if i == 99:
        t.wall += 2_000_000_000                          # an NTP step: wall jumps, mono does not


def levels_missing():
    t = one_session(200)
    r = t.recs[50]
    del r["peak"], r["zero_ratio"]
    return t


def empty_checkpoint_with_levels():
    t = one_session(200)
    prev = dict(t.recs[50])
    prev.update(mono_ns=prev["mono_ns"] + 1_000_000, wall_ns=prev["wall_ns"] + 1_000_000)
    t.recs.insert(51, prev)                              # same samples as line 51, but it carries peak and zero_ratio
    return t


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "fixtures", "verify")
    if os.path.exists(out):
        if not os.path.exists(os.path.join(out, MARK)):
            sys.exit(f"{out} exists and was not written by this generator; refusing to replace it")
        shutil.rmtree(out)
    os.makedirs(out)
    open(os.path.join(out, MARK), "w").close()
    tapes = {
        "boot-crossing": three_sessions(clean_reboot, rail_at=60),
        "reboot-mono-forward": reboot_mono_forward(),
        "mono-backwards-no-marker": three_sessions(no_marker),
        "mono-backwards-at-device-lost": three_sessions(device_lost),
        "epoch-step-no-restart": one_session(200, after=epoch_step),
        "restart-epoch-outside-downtime": three_sessions(clean_reboot, boot2_mono=30_000_000_000),
        "levels-missing": levels_missing(),
        "empty-checkpoint-with-levels": empty_checkpoint_with_levels(),
        "clipping": one_session(level=lambda i: (1.0, 0.49, 0.0) if i % 22 == 0 or i % 23 == 0 else (0.25, 0.05, 0.01)),
        "silence": one_session(level=lambda i: (0, 0, 1)),
    }
    for name, t in tapes.items():
        t.write(out, name)
        print(f"{name:<32} {len(t.recs):>4} records  {t.samples * 2:>7} PCM bytes")


if __name__ == "__main__":
    main()
