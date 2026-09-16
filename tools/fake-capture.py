#!/usr/bin/env python3
"""A synthetic stand-in for `room-recorder record`, for dry runs: writes tape.pcm (a 440 Hz tone, never room audio) and
tape.idx checkpoints every 20 400 samples, like the real capture's cadence, SPEED times faster than real time.

    tools/fake-capture.py TAPE_DIR SPEED

The index lines carry the real format's keys. wall_ns advances with the audio (it is synthetic time), starting now.
"""
import json
import math
import os
import struct
import sys
import time

tape, speed = sys.argv[1], float(sys.argv[2])
os.makedirs(tape, exist_ok=True)
idx_path, pcm_path = os.path.join(tape, "tape.idx"), os.path.join(tape, "tape.pcm")
DEVICE = "hw:CARD=Fake,DEV=0"
WINDOW = 20_400


def line(record):
    return json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"


samples = os.path.getsize(pcm_path) // 2 if os.path.exists(pcm_path) else 0
wall0 = time.time_ns() - samples * 62_500
mono0 = time.monotonic_ns()
with open(idx_path, "a") as idx, open(pcm_path, "ab") as pcm:
    if samples == 0:
        idx.write(line({"byte_offset": 0, "device": DEVICE, "input_frames": 0, "input_sample_rate": 48000, "mono_ns": mono0,
                        "rms": 0, "samples": 0, "wall_ns": wall0}))
    else:
        idx.write(line({"byte_offset": samples * 2, "device": DEVICE, "discontinuity": "restart", "mono_ns": mono0,
                        "previous_byte_offset": samples * 2, "samples": samples, "surviving_tail_bytes": 0, "wall_ns": time.time_ns()}))
    idx.flush()
    while True:
        frame = bytearray()
        for i in range(WINDOW):
            frame += struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * (samples + i) / 16000)))
        pcm.write(frame)
        pcm.flush()
        os.fsync(pcm.fileno())
        samples += WINDOW
        idx.write(line({"byte_offset": samples * 2, "device": DEVICE, "input_frames": samples * 3, "input_sample_rate": 48000,
                        "mono_ns": mono0 + samples * 62_500, "peak": 0.244140625, "rms": 0.17261, "samples": samples,
                        "wall_ns": wall0 + samples * 62_500, "zero_ratio": 0}))
        idx.flush()
        os.fsync(idx.fileno())
        time.sleep(WINDOW / 16000 / speed)
