#!/bin/bash
# Measure capture levels through our own capture path, for setting the -6 dBFS target on the mic we ship.
# Levels come from the tape's own checkpoint records (rms/peak/zero_ratio of the 16 kHz output, one window per record),
# so this measures what the recorder writes, not what a meter thinks.
# usage: tools/u1-level-run.sh SECONDS [DEVICE] [TAPEDIR]
set -eu
secs=$1
dev=${2:-hw:CARD=Device,DEV=0}
tape=${3:-/home/vinay/tapes/level-$(date +%H%M%S)}
here=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$tape" "$tape.json"
"$here/.build/release/room-recorder" record --device "$dev" --tape "$tape" --seconds "$secs" > "$tape.json"
python3 - "$tape" <<'PY'
import json, sys, math
t = sys.argv[1]
recs = [json.loads(l) for l in open(t + "/tape.idx")]
s = json.load(open(t + ".json"))
wins = [r for r in recs if "peak" in r]
def db(x): return "-inf" if x <= 0 else f"{20 * math.log10(x):+.2f}"
print(f"device {s['device']['name']}  {s['negotiated']['channels']} ch {s['negotiated']['rate']} Hz  "
      f"conversion_channels {s['conversion_channels']}  {s['samples']} samples ({s['samples']/16000:.1f} s)")
print(f"{len(wins)} level windows (one per checkpoint; measured effective interval 1.275 s, 1.300 s worst observed)")
print()
print("  window   length_s     peak      peak dBFS      rms       rms dBFS   zero_ratio")
prev = 0
for i, r in enumerate(wins):
    length = (r["samples"] - prev) / 16000
    prev = r["samples"]
    print(f"  {i:6d}  {length:8.3f}  {r['peak']:.9f}  {db(r['peak']):>9s}  {r['rms']:.9f}  {db(r['rms']):>9s}  {r['zero_ratio']:.6f}")
peak = max(r["peak"] for r in wins)
loud = max(wins, key=lambda r: r["rms"])
quiet = min(wins, key=lambda r: r["rms"])
print()
print(f"OVERALL peak {peak:.9f} ({db(peak)} dBFS)   headroom to full scale {-20*math.log10(peak):.2f} dB")
print(f"LOUDEST window rms {loud['rms']:.9f} ({db(loud['rms'])} dBFS)  its peak {loud['peak']:.9f} ({db(loud['peak'])} dBFS)")
print(f"QUIETEST window rms {quiet['rms']:.9f} ({db(quiet['rms'])} dBFS)  zero_ratio {quiet['zero_ratio']:.6f}")
print()
print(f"For the -6 dBFS target: a peak of {peak:.6f} is {20*math.log10(peak):+.2f} dBFS, so the input gain wants "
      f"{-6 - 20*math.log10(peak):+.2f} dB of change to put the loudest peak at -6 dBFS.")
PY
