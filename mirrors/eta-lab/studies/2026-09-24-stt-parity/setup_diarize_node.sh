#!/usr/bin/env bash
# Diarize/embed twin (Mini's server.py + the box's cuda DEVICE patch + /speech_regions block) on a gcp-l4 clone. Run FROM THE BOX: setup_diarize_node.sh hist-gpu-1
# User systemd unit, localhost :8001, HF offline with cached models (no HF token copied; a placeholder file satisfies the file read).
set -euo pipefail
N=$1; S=/home/eta/services/eta-diarize
ssh $N 'mkdir -p ~/services/eta-diarize ~/.cache/torch/hub ~/.huggingface ~/.cache/torch; [ -e ~/eta-diarize ] || ln -s ~/services/eta-diarize ~/eta-diarize'
rsync -a $S/server.py $S/requirements.txt $S/requirements-notorch.txt $S/.cache $N:services/eta-diarize/
rsync -a ~/.cache/torch/pyannote $N:.cache/torch/
ssh $N 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
[ -s ~/.huggingface/token ] || { echo "offline-placeholder" > ~/.huggingface/token; chmod 600 ~/.huggingface/token; }
cd ~/services/eta-diarize
[ -d venv ] || uv venv --python 3.11 venv >/dev/null
uv pip install --python venv/bin/python --extra-index-url https://download.pytorch.org/whl/cu121 --index-strategy unsafe-best-match "torch==2.2.2+cu121" "torchaudio==2.2.2+cu121" -r requirements-notorch.txt >/dev/null
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/eta-diarize-twin.service <<EOF2
[Unit]
Description=eta-diarize twin (Mini server.py + cuda + /speech_regions; localhost :8001)
[Service]
WorkingDirectory=%h/services/eta-diarize
Environment=HF_HUB_OFFLINE=1 PATH=%h/services/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/services/eta-diarize/venv/bin/uvicorn server:app --host 127.0.0.1 --port 8001
Restart=on-failure
RestartSec=10
[Install]
WantedBy=default.target
EOF2
systemctl --user daemon-reload; systemctl --user enable --now eta-diarize-twin >/dev/null 2>&1; echo installed
REMOTE
