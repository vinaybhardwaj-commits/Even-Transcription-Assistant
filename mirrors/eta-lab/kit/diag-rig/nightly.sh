#!/usr/bin/env bash
# DIAG-RIG nightly on the box twin (W30.6c): full nightly suite through the box router on loopback (production-shape path) + SraVaani shadow
# column. Refuses outside 23:00-06:00 IST (diagrig --nightly). One GPU-etiquette flock; nice 10. Summary text goes to stdout (post it as counts only).
set -euo pipefail
cd "$(dirname "$0")"
exec flock -w 900 /home/eta/gpu.lock nice -n 10 python3 diagrig.py run --suite nightly --tts elevenlabs --machine box --nightly \
  --router-local http://127.0.0.1:8083 --shadow-sravaani http://127.0.0.1:8085/inference --target-sha "$(git -C . rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
