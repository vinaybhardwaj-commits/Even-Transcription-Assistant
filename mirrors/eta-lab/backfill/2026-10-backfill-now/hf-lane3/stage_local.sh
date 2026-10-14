#!/bin/bash
# stage_local.sh — HF-3c: idempotent, run once per Space session (the local disk is ephemeral). Builds EVERYTHING lane 3 reads under a LOCAL root (default /tmp/lane3-local) because /data on HF-1 is hf-mount FUSE
# (importing transformers from it took 5.5 min wall / 5 s CPU). /data stays the persistent SOURCE (bin, hf_home snapshots, audio, uv-cache) and the destination of finished outputs.
#   bash /data/lane3/bin/stage_local.sh <windows.json> [more windows.json ...]        (audio of exactly those windows is staged + sha256-verified)
# Steps: 1 bin/ -> local (cp, byte compare)  2 hf_home snapshots -> local, then install_hf1.sh with L3_ROOT=local (rebuilds both venvs under the local path; wheels downloaded fresh into a local uv cache; full OFFLINE byte-verify of the snapshots)
#       3 audio -> local, sha256 vs the window lists  4 READY marker (job sha16, pins manifest sha16, every staged file + size). Nothing on /data is modified or deleted; no token is read.
set -euo pipefail
umask 077
P=${L3_PERSIST:-/data/lane3}; L=${L3_LOCAL:-/tmp/lane3-local}; [ $# -ge 1 ] || { echo "usage: $0 <windows.json> [...]"; exit 2; }
avail=$(df -Pk "$(dirname "$L")" | awk 'NR==2{print int($4/1048576)}'); [ "$avail" -ge 20 ] || { echo "REFUSED: only ${avail} GB free for $L (need >= 20)"; exit 2; }
mkdir -p "$L"/{bin,audio,work,out}
cp -f "$P"/bin/{lane3_cpu_job.py,install_hf1.sh,run_lane3.sh,bench_summary.py,stage_local.py,stage_local.sh} "$L/bin/"; for w in "$@"; do cp -f "$w" "$L/bin/$(basename "$w")"; done
for f in lane3_cpu_job.py install_hf1.sh run_lane3.sh stage_local.py; do cmp -s "$P/bin/$f" "$L/bin/$f" || { echo "REFUSED: copy of $f differs"; exit 3; }; done
echo "bin: $(sha256sum "$L/bin/lane3_cpu_job.py" | cut -c1-16) lane3_cpu_job.py"
if [ ! -d "$L/hf_home/hub" ] || [ ! -s "$L/hf_home/lane3-pins/pinned_snapshots.json" ]; then
  [ -d "$P/hf_home/hub" ] || { echo "REFUSED: no $P/hf_home/hub (stage the snapshots first)"; exit 3; }
  [ -e "$L/hf_home.partial" ] && mv "$L/hf_home.partial" "$L/hf_home.partial._old-$$"          # local scratch only; never delete
  cp -a "$P/hf_home" "$L/hf_home.partial"; [ -e "$L/hf_home" ] && mv "$L/hf_home" "$L/hf_home._old-$$"; mv "$L/hf_home.partial" "$L/hf_home"
fi
[ -x "$L/uvbin/uv" ] || { mkdir -p "$L/uvbin"; cp "$P/uvpip/bin/uv" "$L/uvbin/uv"; }; export PATH="$L/uvbin:$PATH"       # uv is a standalone binary: copy it local (from the /data uvpip install; a venv there has absolute paths)
export UV_CACHE_DIR="${UV_CACHE_DIR:-$L/uv-cache}" UV_LINK_MODE=copy       # LOCAL cache: reading the cold /data/lane3/uv-cache over FUSE ran at ~5 MB/100 s; direct wheel downloads take ~1 min
L3_ROOT="$L" bash "$L/bin/install_hf1.sh"                                     # venvs under $L (absolute paths are local) + OFFLINE full byte verification of both snapshots; must print INSTALL-OK
python3 "$L/bin/stage_local.py" audio --src "$P/audio" --dst "$L/audio" --windows "$@"
python3 "$L/bin/stage_local.py" marker-write --root "$L" --job "$L/bin/lane3_cpu_job.py"
for v in venv-indic venv-sra; do s=$(date +%s.%N); "$L/$v/bin/python" -c "import torch, transformers"; echo "$v import torch+transformers: $(echo "$(date +%s.%N) - $s" | bc 2>/dev/null || python3 -c "import time;print(round(time.time()-$s,1))") s wall"; done
echo "STAGE-LOCAL-OK root=$L"
