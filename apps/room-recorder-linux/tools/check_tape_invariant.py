#!/usr/bin/env python3
"""U1 §2.3 invariant on a tape left by an abrupt stop: the index never references a byte that is not in the PCM.

For every complete (0x0A-terminated) index line: it parses, byte_offset == samples * 2, and byte_offset <= size of
tape.pcm. Reports a torn trailing line if one exists (bytes after the last 0x0A). Exit 0 iff the invariant holds.

With --expect-stopped yes|no also asserts the tape's ending: after a clean stop exactly one `stopped` record, and it is
the final line; after kill -9 none.

usage: check_tape_invariant.py TAPEDIR [--expect-stopped yes|no]
"""
import json, os, sys

tape = sys.argv[1]
pcm_size = os.path.getsize(os.path.join(tape, "tape.pcm"))
idx = open(os.path.join(tape, "tape.idx"), "rb").read()
complete, _, tail = idx.rpartition(b"\n")
lines = complete.split(b"\n") if complete else []
problems = []
max_offset = -1
for n, raw in enumerate(lines, 1):
    try:
        rec = json.loads(raw)
    except Exception as e:
        problems.append(f"line {n} does not parse: {e}")
        continue
    bo, sa = rec.get("byte_offset"), rec.get("samples")
    if bo is None:
        continue
    if bo != sa * 2:
        problems.append(f"line {n}: byte_offset {bo} != samples {sa} * 2")
    if bo > pcm_size:
        problems.append(f"line {n}: byte_offset {bo} beyond tape.pcm size {pcm_size}")
    max_offset = max(max_offset, bo)
stopped_lines = [n for n, raw in enumerate(lines, 1) if b'"discontinuity":"stopped"' in raw]
if "--expect-stopped" in sys.argv:
    want = sys.argv[sys.argv.index("--expect-stopped") + 1]
    if want == "yes" and not (len(stopped_lines) == 1 and stopped_lines[0] == len(lines) and not tail):
        problems.append(f"expected exactly one stopped record as the final line; stopped at lines {stopped_lines} of {len(lines)}, torn tail {len(tail)} B")
    if want == "no" and stopped_lines:
        problems.append(f"expected no stopped record after kill -9; found at lines {stopped_lines}")
result = {
    "tape": tape, "pcm_bytes": pcm_size, "complete_lines": len(lines), "max_byte_offset": max_offset,
    "pcm_bytes_beyond_last_record": pcm_size - max_offset if max_offset >= 0 else None,
    "torn_tail_bytes": len(tail), "stopped_record_lines": stopped_lines, "invariant_holds": not problems, "problems": problems,
}
print(json.dumps(result, sort_keys=True))
sys.exit(0 if not problems else 1)
