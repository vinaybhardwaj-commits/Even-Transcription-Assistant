#!/usr/bin/env bash
# Install the full STT stack twins (eta-indic, SraVaani, eta-router) on a gcp-l4 clone, as USER systemd units (no sudo there).
# Run FROM THE BOX:  setup_stt_node.sh hist-gpu-1
# Sources and model caches come from the box's verified twins (~/services/eta-*-twin); venvs are rebuilt on the node with the
# same pins as the Mini/Yoga (uv, CPU torch wheels). No secrets are copied. Localhost-only listeners.
set -euo pipefail
N=$1
B=/home/eta/services
ssh $N 'mkdir -p ~/services/eta-indic-twin ~/services/eta-sravaani-twin ~/services/eta-router-twin ~/.local/bin ~/vad-stt'
scp -q ~/.local/bin/uv ~/.local/bin/uvx $N:.local/bin/ 2>/dev/null || scp -q ~/.local/bin/uv $N:.local/bin/
# sources, pins, models (hardlinks kept: onnxruntime rejects symlinked external data)
rsync -aH --info=stats0 $B/eta-indic-twin/indic_server.py $B/eta-indic-twin/hf-cache $N:services/eta-indic-twin/
rsync -aH --info=stats0 $B/eta-sravaani-twin/sravaani_server.py $B/eta-sravaani-twin/hf-cache $N:services/eta-sravaani-twin/
rsync -a  --info=stats0 $B/eta-router-twin/router_server.py $B/eta-router-twin/eta_number_words.py $N:services/eta-router-twin/
rsync -a  ~/vad/work/stt-parity/indic_freeze.txt ~/vad/work/stt-parity/sravaani_freeze.txt ~/vad/work/stt-parity/router_freeze.txt $N:vad-stt/
ssh $N 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
FZ=$HOME/vad-stt
X="--extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match"
cd ~/services/eta-indic-twin
[ -d venv ] || uv venv --python 3.11 venv >/dev/null
grep -v -E "^(torch|torchaudio)==" $FZ/indic_freeze.txt > req.txt
uv pip install --python venv/bin/python $X "torch==2.12.0+cpu" "torchaudio==2.11.0+cpu" -r req.txt >/dev/null
cd ~/services/eta-sravaani-twin
[ -d venv ] || uv venv --python 3.14 venv >/dev/null
grep -v -E "^torch==" $FZ/sravaani_freeze.txt > req.txt
uv pip install --python venv/bin/python $X "torch==2.14.0+cpu" -r req.txt >/dev/null
cd ~/services/eta-router-twin; mkdir -p jobs
[ -d venv ] || uv venv --python 3.13 venv >/dev/null
grep -v -E "^(torch|torchaudio)==" $FZ/router_freeze.txt | grep -v -E "^#|^Python|^(fastapi>=|uvicorn\[|python-multipart>=|requests>=)" > req.txt
uv pip install --python venv/bin/python $X "torch==2.12.0+cpu" "torchaudio==2.11.0+cpu" -r req.txt >/dev/null
# cache refs (offline loading reads refs/main)
printf e9b71b369c048e2c6b634d4c131061c34e441179 > ~/services/eta-indic-twin/hf-cache/models--ai4bharat--indic-conformer-600m-multilingual/refs/main
printf f5dd5358325a5208775b91dad98918e079ea2b27 > ~/services/eta-sravaani-twin/hf-cache/models--ARTPARK-IISc--SraVaani-1.0/refs/main
U=~/.config/systemd/user; mkdir -p $U
cat > $U/eta-indic-twin.service <<EOF
[Unit]
Description=eta-indic twin (IndicConformer-600M rnnt; Mini ref 643e4e1). Localhost only.
[Service]
WorkingDirectory=%h/services/eta-indic-twin
Environment=INDIC_PORT=8082 INDIC_DECODING=rnnt HF_HUB_OFFLINE=1 HF_HUB_CACHE=%h/services/eta-indic-twin/hf-cache HF_HOME=%h/services/eta-indic-twin/hfhome PYTHONUNBUFFERED=1
ExecStart=%h/services/eta-indic-twin/venv/bin/python %h/services/eta-indic-twin/indic_server.py
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
EOF
cat > $U/eta-sravaani-twin.service <<EOF
[Unit]
Description=eta-sravaani twin (SraVaani-1.0 f5dd5358, CPU). Localhost only.
[Service]
WorkingDirectory=%h/services/eta-sravaani-twin
Environment=SRAVAANI_PORT=8085 SRAVAANI_HOST=127.0.0.1 SRAVAANI_REPO=ARTPARK-IISc/SraVaani-1.0 SRAVAANI_DEVICE=cpu HF_HUB_OFFLINE=1 HF_HUB_CACHE=%h/services/eta-sravaani-twin/hf-cache HF_HOME=%h/services/eta-sravaani-twin/hfhome HF_HUB_ENABLE_HF_TRANSFER=0 PYTHONUNBUFFERED=1
ExecStart=%h/services/eta-sravaani-twin/venv/bin/python %h/services/eta-sravaani-twin/sravaani_server.py
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
EOF
cat > $U/eta-router-twin.service <<EOF
[Unit]
Description=eta-router twin (router_server.py 400710ee, git 5e841f0; backends = this node's twins). Localhost only. No OpenRouter key here (translate=false only).
After=eta-indic-twin.service eta-sravaani-twin.service whisper-shim-twin.service
[Service]
WorkingDirectory=%h/services/eta-router-twin
Environment=ETA_DEFAULT_CANDIDATES=en,kn,hi,ta,te,ml,mr,bn ETA_MAX_INFLIGHT=3 ETA_WHISPER_URL=http://127.0.0.1:8081 ETA_INDIC_URL=http://127.0.0.1:8082 ETA_SRAVAANI_URL=http://127.0.0.1:8085 ETA_TRANSLATE_ENGINE=openrouter:google/gemini-3.8-flash ETA_TRANSLATE_FALLBACK=openrouter:meta-llama/llama-4-scout ETA_JOBS_DIR=%h/services/eta-router-twin/jobs PYTHONUNBUFFERED=1
ExecStart=%h/services/eta-router-twin/venv/bin/uvicorn router_server:app --host 127.0.0.1 --port 8083
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now eta-indic-twin eta-sravaani-twin >/dev/null 2>&1
sleep 5
systemctl --user enable --now eta-router-twin >/dev/null 2>&1
echo installed
REMOTE
echo "$N done"
