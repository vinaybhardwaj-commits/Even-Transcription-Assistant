#!/usr/bin/env python3
"""U1 step 4: the tape's PCM is exactly the specified conversion of what the converter received, region by region.

For each recording session the tee holds every input frame fed to the converter, in order. The converter resets at
every discontinuity (U1 §11.4), so the session's tape bytes must equal the reference conversion applied separately to
each region of the tee, concatenated — which also proves no zero fill. Region boundaries come from the index:
input_frames on each ring_overflow / capture_discontinuity / device_lost record, minus the session's seed.

usage: verify_tee_regions.py TAPEDIR TEE_A [TEE_B]   (TEE_B: the session after a restart record)
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from reference_decimator import convert

tape, tees = sys.argv[1], sys.argv[2:]
taps = [int(x) for x in open(os.path.join(os.path.dirname(__file__), "..", "spec", "fir-48k-to-16k-121tap-q16.taps")).read().split()]
pcm = open(os.path.join(tape, "tape.pcm"), "rb").read()
recs = [json.loads(l) for l in open(os.path.join(tape, "tape.idx"))]
restarts = [i for i, r in enumerate(recs) if r.get("discontinuity") == "restart"]
sessions = []
bounds = [0] + restarts + [len(recs)]
for si in range(len(bounds) - 1):
    chunk = recs[bounds[si]:bounds[si + 1]]
    start_byte = chunk[0]["byte_offset"] if chunk[0].get("discontinuity") == "restart" else 0
    seed = next((r["input_frames"] for r in chunk if "input_frames" in r), 0) if start_byte else 0
    if start_byte:
        seed = next(r["input_frames"] for r in chunk[1:] if "input_frames" in r and "discontinuity" not in r)
    cuts = sorted({r["input_frames"] - seed for r in chunk
                   if r.get("discontinuity") in ("ring_overflow", "capture_discontinuity", "device_lost")})
    end_byte = recs[bounds[si + 1]]["byte_offset"] if bounds[si + 1] < len(recs) else len(pcm)
    sessions.append((start_byte, end_byte, cuts))
ok = True
for (start, end, cuts), tee_path in zip(sessions, tees):
    tee = open(tee_path, "rb").read()
    frames = len(tee) // 4
    edges = [0] + [c for c in cuts if 0 < c < frames] + [frames]
    ref = b"".join(convert(taps, tee[4 * a:4 * b]) for a, b in zip(edges, edges[1:]))
    got = pcm[start:end]
    same = ref[:len(got)] == got
    ok &= same
    print(json.dumps({"session_bytes": [start, end], "tee_frames": frames, "region_cuts_input_frames": cuts,
                      "reference_bytes": len(ref), "tape_bytes": len(got), "tape_equals_reference_prefix": same,
                      "reference_beyond_tape_bytes": len(ref) - len(got)}))
sys.exit(0 if ok else 1)
