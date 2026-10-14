#!/usr/bin/env bash
# Ruling 107c experiment: IndicConformer + SraVaani on the L4 GPU instead of CPU, ONE node only (hist-gpu-6), side by side with the CPU twins
# (CPU: 8082/8085/8083 unchanged; GPU: indic 8182, sravaani 8185, router 8183 -> GPU backends). Same code files, same model files, same pins EXCEPT
# torch (CUDA wheel instead of +cpu) and onnxruntime-gpu instead of onnxruntime. This is a DIFFERENT BUILD: it needs its own parity.
set -euo pipefail
N=${1:-hist-gpu-6}
ssh $N 'bash -s' <<'REMOTE_END'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
FZ=$HOME/vad-stt
cd ~/services/eta-indic-twin
[ -d venv-gpu ] || uv venv --python 3.11 venv-gpu >/dev/null
grep -v -E "^(torch|torchaudio|onnxruntime)==" $FZ/indic_freeze.txt > req-gpu.txt
uv pip install --python venv-gpu/bin/python "torch==2.12.0" "torchaudio==2.11.0" "onnxruntime-gpu==1.26.0" -r req-gpu.txt >/dev/null
cd ~/services/eta-sravaani-twin
[ -d venv-gpu ] || uv venv --python 3.14 venv-gpu >/dev/null
grep -v -E "^torch==" $FZ/sravaani_freeze.txt > req-gpu.txt
uv pip install --python venv-gpu/bin/python "torch==2.14.0" -r req-gpu.txt >/dev/null
U=~/.config/systemd/user
NV() { ls -d $1/lib/python*/site-packages/nvidia/*/lib 2>/dev/null | paste -sd: ; }
LDI=$(NV ~/services/eta-indic-twin/venv-gpu); LDS=$(NV ~/services/eta-sravaani-twin/venv-gpu)
cat > $U/eta-indic-gpu.service <<UNIT_END
[Unit]
Description=eta-indic GPU variant (IndicConformer rnnt; onnxruntime-gpu + CUDA torch) EXPERIMENT 107c :8182
[Service]
WorkingDirectory=%h/services/eta-indic-twin
Environment=PATH=%h/services/bin:/usr/local/bin:/usr/bin:/bin INDIC_PORT=8182 INDIC_DECODING=rnnt HF_HUB_OFFLINE=1 HF_HUB_CACHE=%h/services/eta-indic-twin/hf-cache HF_HOME=%h/services/eta-indic-twin/hfhome PYTHONUNBUFFERED=1 LD_LIBRARY_PATH=$LDI
ExecStart=%h/services/eta-indic-twin/venv-gpu/bin/python %h/services/eta-indic-twin/indic_server.py
Restart=on-failure
RestartSec=10
UNIT_END
cat > $U/eta-sravaani-gpu.service <<UNIT_END
[Unit]
Description=eta-sravaani GPU variant (SraVaani-1.0 TorchScript on CUDA) EXPERIMENT 107c :8185
[Service]
WorkingDirectory=%h/services/eta-sravaani-twin
Environment=PATH=%h/services/bin:/usr/local/bin:/usr/bin:/bin SRAVAANI_PORT=8185 SRAVAANI_HOST=127.0.0.1 SRAVAANI_REPO=ARTPARK-IISc/SraVaani-1.0 SRAVAANI_DEVICE=cuda HF_HUB_OFFLINE=1 HF_HUB_CACHE=%h/services/eta-sravaani-twin/hf-cache HF_HOME=%h/services/eta-sravaani-twin/hfhome HF_HUB_ENABLE_HF_TRANSFER=0 PYTHONUNBUFFERED=1 LD_LIBRARY_PATH=$LDS
ExecStart=%h/services/eta-sravaani-twin/venv-gpu/bin/python %h/services/eta-sravaani-twin/sravaani_server.py
Restart=on-failure
RestartSec=10
UNIT_END
cat > $U/eta-router-gpu.service <<UNIT_END
[Unit]
Description=eta-router pointed at the GPU-variant backends (EXPERIMENT 107c) :8183
[Service]
WorkingDirectory=%h/services/eta-router-twin
Environment=PATH=%h/services/bin:/usr/local/bin:/usr/bin:/bin ETA_ROUTER_PORT=8183 ETA_DEFAULT_CANDIDATES=en,kn,hi,ta,te,ml,mr,bn ETA_MAX_INFLIGHT=3 ETA_WHISPER_URL=http://127.0.0.1:8081 ETA_INDIC_URL=http://127.0.0.1:8182 ETA_SRAVAANI_URL=http://127.0.0.1:8185 ETA_JOBS_DIR=%h/services/eta-router-twin/jobs-gpu PYTHONUNBUFFERED=1
ExecStart=%h/services/eta-router-twin/venv/bin/uvicorn router_server:app --host 127.0.0.1 --port 8183
Restart=on-failure
RestartSec=10
UNIT_END
mkdir -p ~/services/eta-router-twin/jobs-gpu
systemctl --user daemon-reload
echo "gpu variant installed (not started)"
REMOTE_END
