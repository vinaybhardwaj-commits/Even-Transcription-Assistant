#!/bin/bash
set -e
cd /var/lib/orb3-lab
apt-get install -y -qq python3-venv >/dev/null 2>&1 || true
python3 -m venv venv
./venv/bin/pip install -q --upgrade pip
./venv/bin/pip install -q piper-tts faster-whisper jiwer numpy scipy soundfile
mkdir -p voices && cd voices
for f in en_US-lessac-medium.onnx en_US-lessac-medium.onnx.json; do
  curl -sSL -o $f "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/$f"; done
cd ..; echo SETUP_OK
