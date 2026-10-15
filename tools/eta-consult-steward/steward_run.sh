#!/usr/bin/env bash
# Steward advise run. Needs the ENABLED flag file (see steward/spend.py) and AWS env/profile for Bedrock.
set -euo pipefail
cd "$(dirname "$0")"
export TZ=Asia/Kolkata
# Optional env file with AWS_* and STEWARD_* settings (mode 600, never in git).
[ -f "$HOME/oc/consult/steward/steward.env" ] && set -a && . "$HOME/oc/consult/steward/steward.env" && set +a
exec ./venv/bin/python -m steward.run "$@"
