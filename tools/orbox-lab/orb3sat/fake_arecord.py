#!/usr/bin/env python3
"""Fake arecord: 48 kHz mono S16 silence, wall-clock paced, cut every --max-file-time s like arecord
(first file is <base>.wav, later ones <base>-02.wav ...). Writes total frames to $FAKE_TOTAL and pid to $FAKE_PID."""
import os, struct, sys, time, signal
a = sys.argv[1:]; mft = int(a[a.index("--max-file-time") + 1]); base = a[-1]
open(os.environ["FAKE_PID"], "w").write(str(os.getpid())) if os.environ.get("FAKE_PID") else None
R, total, n, f, fr, t0 = 48000, 0, 1, None, 0, time.monotonic()
def hdr(fr): return b"RIFF" + struct.pack("<I", 36 + fr * 2) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, R, R * 2, 2, 16) + b"data" + struct.pack("<I", fr * 2)
def close():
    global f
    if f: f.seek(0); f.write(hdr(fr)); f.close(); f = None
def done(*_):
    close()
    if os.environ.get("FAKE_TOTAL"): open(os.environ["FAKE_TOTAL"], "w").write(str(total))
    sys.exit(0)
signal.signal(signal.SIGINT, done)
while True:
    if f is None:
        root, ext = os.path.splitext(base)
        f = open(base if n == 1 else f"{root}-{n:02d}{ext}", "wb"); f.write(hdr(0)); fr = 0; n += 1
    time.sleep(0.05)
    k = min(int((time.monotonic() - t0) * R) - total, mft * R - fr)  # frames due, never past the piece end
    if k > 0: f.write(b"\0" * k * 2); fr += k; total += k
    if fr >= mft * R: close()
