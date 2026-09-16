#!/bin/bash
# U2 acceptance verdict — run as root, AFTER the acceptance run. One command for V.
#
#   sudo deploy/u2-acceptance-verify.sh [/var/lib/room-recorder/tape]
#
# It answers the PRD's question — "an hour later there is a tape with sound in it" — from the INDEX'S OWN NUMBERS,
# so that nobody has to listen to the room to find out whether the recorder worked.
#
# WHAT IT READS AND WHAT IT WILL NOT DO
# It reads tape.idx, which is one JSON object per line and contains no audio. It reads tape.pcm's SIZE ONLY, via
# stat(2), to check that the bytes the index claims are actually there; it never opens tape.pcm, never reads a
# sample from it, and never copies it anywhere. It prints no sample values — the loudness fields (peak, rms,
# zero_ratio) are printed only as DISTRIBUTIONS across checkpoints, never as a per-checkpoint series, because a
# per-checkpoint series of loudness is an envelope of what happened in the room and this report is meant to be
# safe to paste into a ticket.
#
# It needs root because /var/lib/room-recorder is 0750 room-recorder:room-recorder and MUST STAY THAT WAY. Do not
# add anyone to the group and do not loosen the mode to make this readable without root; needing root is the point.
#
# WHAT THIS IS NOT
# It is not the conformance suite and does not replace it. It checks the index's OWN arithmetic — byte_offset =
# samples x 2, samples and byte_offset never going backwards, mono_ns advancing along the checkpoint spine, and
# every nanosecond of the span either backed by samples or explained by a gap_ns. mono_ns is CLOCK_MONOTONIC, which
# restarts at zero on every boot, and the tape is appended across reboots with no boot epoch in the index; so a
# backwards mono_ns across a `restart` marker is reported as a boot boundary, not a break, and coverage and the
# restart-crossing time accounting are measured on wall_ns. Corruption that lowers mono_ns on the first checkpoint
# after a restart marker is not detectable by this rule. It does NOT check the
# tape-to-piece conversion contract: key ordering, double formatting, gap attribution, anchor placement, piece
# boundaries. Run `conformance` for those. Checked against the fixture corpus: of the 28 negative fixtures that
# carry a tape.idx, the structural claim fails exactly the four whose index arithmetic is damaged
# (c1-offset-not-twice-samples, c1-restart-odd-tail-untrimmed, c3-blank-line-inside-torn-log, c4-one-sample-lost)
# and holds for the other 24, which violate conversion rules while still being real tapes. Two of those 24
# (c5-reanchored-seam, c6-first-piece-one-short), and good/multi-piece and good/multi-piece-gap, then FAIL the
# clipping claim, correctly by their own numbers: the generator writes peak from formatting literals that no case
# asserts (Generator.swift:36, :113), "1" on one checkpoint in six, so 11 of 70 checkpoints sit on the rail.
# Index-only tapes for this script (a reboot, backwards mono_ns without a restart, clipping, silence) are made by
# fixtures/verify/generate.py, uncommitted like the rest of fixtures/. That is the intended scope: "is there a tape with sound in it", not "is every rule obeyed".
#
# Exit status: 0 only when a tape with sound in it exists and it is not clipping. 1 otherwise, or on any structural
# failure.
set -uo pipefail

TAPEDIR=${1:-/var/lib/room-recorder/tape}

[ "$(id -u)" = 0 ] || { echo "must be root: sudo $0 ${1:+$1}" >&2; exit 1; }
[ -d "$TAPEDIR" ] || { echo "no such tape directory: $TAPEDIR" >&2; exit 1; }

exec python3 - "$TAPEDIR" <<'PY'
import json, os, sys, time

TAPE = sys.argv[1]
IDX, PCM = os.path.join(TAPE, "tape.idx"), os.path.join(TAPE, "tape.pcm")

# Tape format facts, TapeFormat.swift:7-12 — 16 kHz mono S16_LE, so one sample is 2 bytes and 62 500 ns.
NS_PER_SAMPLE, BYTES_PER_SAMPLE = 62_500, 2
GAP_CARRYING = {"capture_discontinuity", "resumed", "ring_overflow", "device_lost"}

def ist(ns):
    # The zone name is READ, not assumed. S8 pins this machine to Asia/Kolkata, but a report that prints "IST" on a
    # machine that is not on IST would be a lie in the one field an operator uses to line the tape up against events.
    t = time.localtime(ns / 1e9)
    return (time.strftime("%Y-%m-%d %H:%M:%S", t) + f".{int(ns % 1_000_000_000):09d}"[:4]
            + " " + time.strftime("%Z", t))

def dur(ns):
    if ns < 0:
        return "-" + dur(-ns)
    s, ns = divmod(int(ns), 1_000_000_000)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m {s:02d}.{ns//1_000_000:03d}s"

def head(t):
    print(f"\n{t}\n" + "-" * len(t))

def pct(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * p / 100.0
    lo, hi = int(k), min(int(k) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)

def distribution(name, vals):
    if not vals:
        print(f"  {name:<11} no checkpoint carried this field")
        return
    v = sorted(vals)
    print(f"  {name:<11} n={len(v)}  min={v[0]:.6g}  p10={pct(v,10):.6g}  median={pct(v,50):.6g}  "
          f"p90={pct(v,90):.6g}  p99={pct(v,99):.6g}  max={v[-1]:.6g}")
    print(f"  {'':<11} exactly 0: {sum(1 for x in v if x == 0):<7d} exactly 1: {sum(1 for x in v if x == 1):<7d} "
          f"mean={sum(v)/len(v):.6g}")

print(f"U2 acceptance verdict from the index alone — {TAPE}")
print(f"read at {time.strftime('%Y-%m-%d %H:%M:%S %Z')}")

# ---- parse ------------------------------------------------------------------------------------------------------
if not os.path.exists(IDX):
    print(f"\nFAIL  {IDX} does not exist. No tape was written at all.")
    sys.exit(1)

raw = open(IDX, "rb").read()
lines = raw.split(b"\n")
partial = b""
if lines and lines[-1] == b"":
    lines.pop()
else:
    partial = lines.pop() if lines else b""

recs, bad = [], []
for i, line in enumerate(lines, 1):
    if not line.strip():
        bad.append((i, "blank line — TapeWriter treats this as a hard error, not something to repair"))
        continue
    try:
        recs.append((i, json.loads(line)))
    except Exception as e:
        bad.append((i, f"not JSON: {e}"))

head("Records")
print(f"  tape.idx            {len(raw)} bytes, {len(lines)} complete line(s)")
print(f"  parsed              {len(recs)} record(s)")
if partial:
    print(f"  trailing partial    {len(partial)} byte(s) with no newline — the recorder is still writing; excluded")
for i, why in bad:
    print(f"  MALFORMED line {i}: {why}")

if not recs:
    print("\nFAIL  no parseable index records. There is no tape.")
    sys.exit(1)

ckpts = [(n, r) for n, r in recs if "discontinuity" not in r]
discs = [(n, r) for n, r in recs if "discontinuity" in r]
print(f"  checkpoints         {len(ckpts)}")
print(f"  discontinuities     {len(discs)}")
devices = sorted({r.get("device", "") for _, r in recs})
for d in devices:
    print(f"  device              {d!r}")

# ---- span -------------------------------------------------------------------------------------------------------
head("Committed span (wall_ns, first and last record)")
first, last = recs[0][1], recs[-1][1]
w0, w1 = int(first["wall_ns"]), int(last["wall_ns"])
m0, m1 = int(first["mono_ns"]), int(last["mono_ns"])
wall_span, mono_span = w1 - w0, m1 - m0

# CLOCK_MONOTONIC restarts at zero on every boot. A step along the checkpoint spine whose mono_ns goes backwards with a
# `restart` marker between its two checkpoints is a boot boundary; see the continuity section for why only there.
def restart_between(n_prev, n_cur):
    return any(r["discontinuity"] == "restart" for n, r in discs if n_prev < n < n_cur)
boot_steps = {i for i in range(1, len(ckpts))
              if int(ckpts[i][1]["mono_ns"]) < int(ckpts[i - 1][1]["mono_ns"])
              and restart_between(ckpts[i - 1][0], ckpts[i][0])}

print(f"  first wall_ns       {w0}   {ist(w0)}")
print(f"  last  wall_ns       {w1}   {ist(w1)}")
print(f"  span                {wall_span} ns = {dur(wall_span)}")
print(f"  monotonic span      {mono_span} ns = {dur(mono_span)}  (information only: it resets at every boot)")
print(f"  wall - mono         {wall_span - mono_span} ns  (non-zero means the wall clock was stepped, e.g. NTP)")
if boot_steps:
    # wall - mono is an NTP measure only within one boot, so it is re-summed over the spine steps that stay in one.
    within = sum((int(b["wall_ns"]) - int(a["wall_ns"])) - (int(b["mono_ns"]) - int(a["mono_ns"]))
                 for i, ((_, a), (_, b)) in enumerate(zip(ckpts, ckpts[1:]), 1) if i not in boot_steps)
    print(f"    this tape crosses {len(boot_steps)} boot boundary(ies), so the figure above includes a monotonic clock")
    print(f"    reset; summed along the checkpoint spine within each boot, wall - mono = {within} ns")

# ---- continuity -------------------------------------------------------------------------------------------------
head("Did the index advance continuously?")
# Three different things are checked here, because they have three different guarantees.
#
# 1. byte_offset == samples x 2, on EVERY record. A hard invariant of the format.
# 2. samples and byte_offset never go backwards, on EVERY record. Also hard.
# 3. mono_ns never goes backwards ALONG THE CHECKPOINT SPINE — checkpoints only, not marker records.
#    A marker carries the instant of the EVENT, and that instant can land a few microseconds BEFORE the checkpoint
#    written just before it: fixtures/good/ist-midnight-two-rollovers line 3 is a day_rollover stamped 10 417 ns
#    behind line 2, and that fixture is a GOOD one. Demanding global mono_ns monotonicity fails every run that
#    crosses IST midnight — which S8 exists for and an hour-long run can easily do. Marker inversions are reported
#    below as information, never as a break.
#    The one spine exemption: a backwards step with a `restart` marker between its two checkpoints. The tape is
#    appended across reboots and CLOCK_MONOTONIC restarts at zero at boot, so that is what a reboot looks like. The
#    index carries no boot epoch, so a reboot and a corrupted mono_ns there cannot be told apart; the exemption is
#    confined to restart-adjacent steps, and a backwards step anywhere else stays a hard break.
#    Across any restart the spine step is measured on wall_ns for the time accounting, because the two checkpoints
#    may be on different boots and wall_ns is the only clock in the index that survives one.
inv, marker_inversions = [], []
prev_s, prev_b = -1, -1
for n, r in recs:
    s_cur, b_cur = int(r.get("samples", 0)), int(r.get("byte_offset", 0))
    if b_cur != s_cur * BYTES_PER_SAMPLE:
        inv.append(f"line {n}: byte_offset {b_cur} != samples {s_cur} x {BYTES_PER_SAMPLE}")
    if s_cur < prev_s:
        inv.append(f"line {n}: samples went backwards, {prev_s} -> {s_cur}")
    if b_cur < prev_b:
        inv.append(f"line {n}: byte_offset went backwards, {prev_b} -> {b_cur}")
    prev_s, prev_b = max(prev_s, s_cur), max(prev_b, b_cur)

# The spine: consecutive checkpoints, with any marker records between them attributed to that step.
unaccounted_steps, total_unaccounted, explained, boot_notes = [], 0, 0, []
for i in range(1, len(ckpts)):
    (n_prev, a), (n_cur, b) = ckpts[i - 1], ckpts[i]
    if i in boot_steps:
        boot_notes.append((n_prev, n_cur, int(a["mono_ns"]) - int(b["mono_ns"])))
    elif int(b["mono_ns"]) < int(a["mono_ns"]):
        inv.append(f"line {n_cur}: mono_ns went backwards along the checkpoint spine with no restart marker "
                   f"between, {a['mono_ns']} -> {b['mono_ns']}")
    between = [r for n, r in discs if n_prev < n < n_cur]
    gap_here = sum(int(r["gap_ns"]) for r in between if r.get("gap_ns") is not None)
    clock = "wall_ns" if restart_between(n_prev, n_cur) else "mono_ns"
    step = int(b[clock]) - int(a[clock]) - (int(b.get("samples", 0)) - int(a.get("samples", 0))) * NS_PER_SAMPLE
    if step:
        total_unaccounted += step
        explained += min(gap_here, step) if step > 0 else 0
        residual = step - gap_here
        if residual:
            unaccounted_steps.append((n_prev, n_cur, residual, [r["discontinuity"] for r in between]))
for i in range(1, len(recs)):
    if recs[i][1].get("discontinuity") and int(recs[i][1]["mono_ns"]) < int(recs[i - 1][1]["mono_ns"]):
        marker_inversions.append((recs[i][0], recs[i][1]["discontinuity"],
                                  int(recs[i - 1][1]["mono_ns"]) - int(recs[i][1]["mono_ns"])))

b_last, s_last = int(last.get("byte_offset", 0)), int(last.get("samples", 0))
audio_ns = s_last * NS_PER_SAMPLE
span_audio_ns = (s_last - int(first.get("samples", 0))) * NS_PER_SAMPLE
gap_total = sum(int(r["gap_ns"]) for _, r in discs if r.get("gap_ns") is not None)
print(f"  samples on tape     {s_last}  = {dur(audio_ns)} of audio at 16 kHz mono")
print(f"  byte_offset         {b_last}  (= samples x 2, checked on every record)")
print(f"  structural breaks   {len(inv)}")
for v in inv[:20]:
    print(f"    {v}")
if len(inv) > 20:
    print(f"    ... and {len(inv)-20} more")
print(f"  time not backed by samples: {total_unaccounted} ns = {dur(abs(total_unaccounted))}")
print(f"    explained by gap_ns on discontinuity records   {explained} ns = {dur(abs(explained))}")
print(f"    residual, not explained by any gap_ns          {total_unaccounted - explained} ns "
      f"over {len(unaccounted_steps)} step(s)")
for n_prev, n_cur, residual, kinds in unaccounted_steps[:10]:
    k = ", ".join(kinds) if kinds else "no discontinuity record between them"
    print(f"      lines {n_prev}->{n_cur}: {residual} ns unexplained ({k})")
if len(unaccounted_steps) > 10:
    print(f"      ... and {len(unaccounted_steps)-10} more")
if boot_notes:
    print(f"  mono_ns backwards across a restart marker (EXPECTED — a reboot resets CLOCK_MONOTONIC; not a break):")
    for n_prev, n_cur, by in boot_notes[:10]:
        print(f"      lines {n_prev}->{n_cur}: {by} ns backwards; step measured on wall_ns instead")
if marker_inversions:
    print(f"  marker timestamps behind the record above them (EXPECTED, not a break):")
    for n, kind, by in marker_inversions[:10]:
        why = ("a reboot restarted CLOCK_MONOTONIC" if kind == "restart"
               else "it carries the instant of the event")
        print(f"      line {n}: {kind} stamped {by} ns earlier — {why}")
# Coverage is on wall_ns, never mono_ns: mono_ns restarts at every boot and this tape is appended across reboots.
cov_den = wall_span - gap_total
coverage = (span_audio_ns / cov_den * 100) if cov_den > 0 else float("nan")
print(f"  coverage            {coverage:.4f}%  of the wall-clock span, less {dur(gap_total)} of recorded gap_ns, is on tape")
print(f"                      ({span_audio_ns / wall_span * 100 if wall_span > 0 else float('nan'):.4f}% of the raw "
      f"wall-clock span; restarts carry no gap_ns by rule, so their downtime counts as missing)")

# ---- discontinuities --------------------------------------------------------------------------------------------
head("Every discontinuity record")
if not discs:
    print("  none — the tape is one unbroken run")
else:
    print(f"  {'line':>6}  {'kind':<22} {'gap_ns':>14}  {'gap':>14}  at wall")
    for n, r in discs:
        kind = r["discontinuity"]
        g = r.get("gap_ns")
        gtxt = f"{g}" if g is not None else "-"
        gdur = dur(g) if g is not None else ("carries none by rule" if kind not in GAP_CARRYING else "-")
        extra = []
        if "dropped_input_frames" in r:
            extra.append(f"dropped_input_frames={r['dropped_input_frames']}")
        if "surviving_tail_bytes" in r:
            extra.append(f"surviving_tail_bytes={r['surviving_tail_bytes']}")
        if "previous_byte_offset" in r:
            extra.append(f"previous_byte_offset={r['previous_byte_offset']}")
        print(f"  {n:>6}  {kind:<22} {gtxt:>14}  {gdur:>14}  {ist(int(r['wall_ns']))}"
              + (("  " + " ".join(extra)) if extra else ""))
    kinds = {}
    for _, r in discs:
        kinds[r["discontinuity"]] = kinds.get(r["discontinuity"], 0) + 1
    print("  by kind             " + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())))

# ---- loudness distributions -------------------------------------------------------------------------------------
head("Loudness across checkpoints (distributions only — never a per-checkpoint series)")
peaks = [float(r["peak"]) for _, r in ckpts if "peak" in r]
rmss = [float(r["rms"]) for _, r in ckpts if "rms" in r]
zeros = [float(r["zero_ratio"]) for _, r in ckpts if "zero_ratio" in r]
distribution("peak", peaks)
distribution("rms", rmss)
distribution("zero_ratio", zeros)

head("zero_ratio histogram (fraction of samples that were exactly zero)")
edges = [0.0, 1e-9, 0.001, 0.01, 0.1, 0.5, 0.9, 0.999, 1.0]
labels = ["== 0", "(0, 1e-3)", "[1e-3, 0.01)", "[0.01, 0.1)", "[0.1, 0.5)", "[0.5, 0.9)", "[0.9, 0.999)", "[0.999, 1)", "== 1"]
counts = [0] * len(labels)
for z in zeros:
    if z == 0:       counts[0] += 1
    elif z == 1:     counts[8] += 1
    elif z < 0.001:  counts[1] += 1
    elif z < 0.01:   counts[2] += 1
    elif z < 0.1:    counts[3] += 1
    elif z < 0.5:    counts[4] += 1
    elif z < 0.9:    counts[5] += 1
    elif z < 0.999:  counts[6] += 1
    else:            counts[7] += 1
for lbl, c in zip(labels, counts):
    bar = "#" * min(48, int(48 * c / max(1, len(zeros))))
    print(f"  {lbl:<14} {c:>7}  {bar}")

# ---- tape.pcm, size only ----------------------------------------------------------------------------------------
head("tape.pcm (size only — never opened, never read, never copied)")
if os.path.exists(PCM):
    size = os.stat(PCM).st_size
    print(f"  st_size             {size} bytes")
    print(f"  index claims        {b_last} bytes")
    if size == b_last:
        print("  MATCH               every byte the index accounts for is present")
    elif size > b_last:
        print(f"  AHEAD BY {size - b_last} byte(s) — audio written since the last index line (the recorder is running)")
    else:
        print(f"  SHORT BY {b_last - size} byte(s) — the index references bytes that are NOT in tape.pcm")
        inv.append("tape.pcm is shorter than the index claims")
else:
    print("  MISSING             tape.idx exists but tape.pcm does not")
    inv.append("tape.pcm missing")

# ---- verdict ----------------------------------------------------------------------------------------------------
# "A tape with sound in it" is three claims, decided separately and stated separately.
# 1. A TAPE: it parses, the invariants hold, and it actually advanced.
# 2. WITH SOUND: the audio is not digital silence. The TM20's hardware mute is bit-exact zero (NOTES.md, carried to
#    U3), so a muted or dead mic produces peak == 0, rms == 0 and zero_ratio == 1 on EVERY checkpoint. A tape of
#    silence is structurally perfect and worthless, which is exactly why the verdict cannot rest on structure alone.
# 3. NOT CLIPPING: peak = max |s| / 32768 and the decimator clips to [-32768, 32767] (Decimator.swift clipMin/clipMax),
#    so peak >= 32767/32768 means a sample sat on the rail. A tape that is mostly rail is loud, structurally perfect and
#    as useless as silence. Threshold: the peak p99 printed above reaching the rail, because one slam or cough touches a
#    handful of checkpoints an hour while a p99 on the rail makes clipping the tape's ordinary texture.
head("VERDICT")
loud = [n for n, r in ckpts if float(r.get("peak", 0)) > 0 and float(r.get("rms", 0)) > 0]
loud_frac = len(loud) / len(ckpts) if ckpts else 0.0
nonsilent = [z for z in zeros if z < 1.0]
nonsilent_frac = len(nonsilent) / len(zeros) if zeros else 0.0

RAIL = 32_767 / 32_768
railed = [p for p in peaks if p >= RAIL]
rail_frac = len(railed) / len(peaks) if peaks else 0.0
peak_p99 = pct(sorted(peaks), 99)

is_tape = not inv and not bad and s_last > 0
has_sound = loud_frac > 0.01 and nonsilent_frac > 0.01 and (max(peaks) if peaks else 0) > 0
clipping = bool(peaks) and peak_p99 >= RAIL

print(f"  a tape exists and advanced      {'YES' if is_tape else 'NO'}")
print(f"    decided by: {len(recs)} records parsed, {len(bad)} malformed, {len(inv)} structural breaks,")
print(f"                {s_last} samples = {dur(audio_ns)} of audio, coverage {coverage:.4f}% of the wall-clock span")
print(f"  it has sound in it              {'YES' if has_sound else 'NO'}")
print(f"    decided by: {len(loud)}/{len(ckpts)} checkpoints ({loud_frac*100:.2f}%) have peak > 0 AND rms > 0;")
print(f"                {len(nonsilent)}/{len(zeros)} ({nonsilent_frac*100:.2f}%) have zero_ratio < 1;")
print(f"                highest peak anywhere on the tape is {max(peaks) if peaks else 0:.6g}")
print(f"    threshold:  more than 1% of checkpoints on both counts. The numbers above are printed so that this")
print(f"                threshold can be disagreed with without re-running anything.")
print(f"  it is not clipping              {'NO' if clipping else 'YES'}")
print(f"    decided by: {len(railed)}/{len(peaks)} checkpoints ({rail_frac*100:.2f}%) have peak >= 32767/32768, a sample on the rail;")
print(f"                peak p99 is {peak_p99:.6g}; rms p99 is {pct(sorted(rmss), 99):.6g}")
print(f"    threshold:  clipping when the peak p99 is on the rail (>= 32767/32768). One slam or cough is a handful of")
print(f"                rail checkpoints an hour; a p99 on the rail is a gain or capture-chain fault.")
print()
if is_tape and has_sound and not clipping:
    print(f"PASS  A tape exists and there is sound in it: {dur(audio_ns)} of audio committed across a")
    print(f"      {dur(wall_span)} wall-clock span. The PRD asks for an hour; compare those two numbers against")
    print(f"      what was actually run rather than taking PASS to mean the hour was reached. Read the")
    print(f"      discontinuity list above too — this says the tape is real, not that the room was quiet.")
    sys.exit(0)
if is_tape and not has_sound:
    print("FAIL  A structurally perfect tape of SILENCE. The recorder ran and the index is sound, but every")
    print("      checkpoint is digital zero — a muted, dead or disconnected mic. This is the failure the")
    print("      structure checks cannot see, and it is why the verdict does not rest on them.")
    sys.exit(1)
if is_tape:
    print(f"FAIL  A structurally sound tape that is CLIPPING: {len(railed)} of {len(peaks)} checkpoints put a sample on the")
    print(f"      rail. The recorder ran and there is sound, but the capture chain is overdriven — gain, mic or")
    print(f"      mixer. Fix the level before calling this tape the acceptance run.")
    sys.exit(1)
print("FAIL  The tape is not structurally sound. Read the structural breaks above; the loudness numbers are")
print("      not meaningful until they are explained.")
sys.exit(1)
PY
