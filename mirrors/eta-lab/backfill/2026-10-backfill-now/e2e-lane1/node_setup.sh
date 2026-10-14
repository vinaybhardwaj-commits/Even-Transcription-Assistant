#!/usr/bin/env bash
# node_setup.sh — HF-4: idempotent setup of a fresh E2E Ubuntu 22.04 GPU node for the lane-1 Whisper workers. Run ON THE NODE (as root or a sudoer): NODE_ROOT=/srv/e2e-lane1 bash node_setup.sh
# No token needed (public model), no secret read or printed. Re-running changes nothing that is already in place.
set -euo pipefail
NODE_ROOT="${NODE_ROOT:-/srv/e2e-lane1}"; REV="41f01f3fe87f28c78e2fbf8b568835947dd65ed9"; MODEL="openai/whisper-large-v3-turbo"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
command -v nvidia-smi >/dev/null || { echo "BLOCKED: nvidia-smi missing (E2E GPU images ship the driver)"; exit 2; }
nvidia-smi --query-gpu=index,name,driver_version,memory.total --format=csv,noheader
NG=$(nvidia-smi --query-gpu=index --format=csv,noheader | wc -l); echo "gpus=$NG"
$SUDO mkdir -p "$NODE_ROOT"; $SUDO chown "$(id -u):$(id -g)" "$NODE_ROOT"
mkdir -p "$NODE_ROOT"/{code,audio,out,claims,run/logs,hf}; chmod 700 "$NODE_ROOT"/{out,claims,run}
if ! command -v ffmpeg >/dev/null || ! python3 -c "import venv, ensurepip" 2>/dev/null; then $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv python3-pip ffmpeg rsync; fi
[ -x "$NODE_ROOT/venv/bin/python" ] || python3 -m venv "$NODE_ROOT/venv"
PIP="$NODE_ROOT/venv/bin/pip"
if ! "$NODE_ROOT/venv/bin/python" -c "import torch,transformers,av,accelerate,huggingface_hub,soundfile" 2>/dev/null; then
  "$PIP" install -q --upgrade pip
  "$PIP" install -q "torch==2.5.1" "transformers==4.46.3" accelerate huggingface_hub soundfile av "numpy<2.3"
fi
export HF_HOME="$NODE_ROOT/hf" HF_HUB_DISABLE_TELEMETRY=1
"$NODE_ROOT/venv/bin/python" - <<PY
import os, hashlib, json
import torch, transformers, av, huggingface_hub
from huggingface_hub import snapshot_download
p = snapshot_download("$MODEL", revision="$REV")
assert os.path.basename(p.rstrip("/")) == "$REV", "snapshot dir != pinned revision"
h = hashlib.sha256()
for n in sorted(os.listdir(p)):
    f = os.path.realpath(os.path.join(p, n))
    if os.path.isfile(f):
        s = hashlib.sha256()
        with open(f, "rb") as fh:
            for c in iter(lambda: fh.read(1 << 22), b""): s.update(c)
        h.update(n.encode() + s.digest())
print(json.dumps({"torch": torch.__version__, "cuda_build": torch.version.cuda, "cuda_available": torch.cuda.is_available(), "n_cuda": torch.cuda.device_count(), "gpu0": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                  "transformers": transformers.__version__, "av": av.__version__, "huggingface_hub": huggingface_hub.__version__, "snapshot": os.path.basename(p), "snapshot_files_sha16": h.hexdigest()[:16]}))
assert torch.cuda.is_available(), "BLOCKED: CUDA not available to torch"
PY
echo "NODE_SETUP_OK root=$NODE_ROOT"
