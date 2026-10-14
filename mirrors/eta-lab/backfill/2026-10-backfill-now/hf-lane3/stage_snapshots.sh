#!/bin/bash
# stage_snapshots.sh — HF-3b (BOX side): write to STDOUT a tar of ONLY the two pinned model snapshots (symlinks dereferenced, so no blobs/refs/other cache) plus lane3-pins/pinned_snapshots.json (the full-file sha256 manifest),
# laid out for extraction INTO /data/lane3/hf_home:  hub/models--<org>--<name>/snapshots/<40-hex>/...   and   lane3-pins/pinned_snapshots.json.   No audio, no token, no other cache. Diagnostics go to STDERR only.
# Before streaming it VERIFIES both snapshots (pinned revision dir, code-file pins, every file's sha256 vs the c4 measurement) and refuses otherwise.
#   bash stage_snapshots.sh | ssh mini "ssh -i ~/.ssh/hf_spaces vrbeven-eta-hf-1@ssh.hf.space 'mkdir -p /data/lane3/hf_home && tar -C /data/lane3/hf_home -xf -'"
set -euo pipefail
HERE=$(dirname "$(readlink -f "$0")")
INDIC_HUB=${STAGE_INDIC_HUB:-$HOME/.cache/huggingface/hub}; SRA_HUB=${STAGE_SRA_HUB:-$HERE/pinned_hub}
MEAS=${STAGE_MEASURED:-$HERE/../c4_measured-20261008.json}; STAGE=${STAGE_DIR:-$HERE/stage}
python3 "$HERE/stage_pins.py" --indic-hub "$INDIC_HUB" --sra-hub "$SRA_HUB" --measured "$MEAS" --stage-dir "$STAGE" 1>&2
IREV=$(python3 -c "import sys;sys.path.insert(0,'$HERE');import stage_pins as s;print(s.job().MODELS['indic'][1])")
SREV=$(python3 -c "import sys;sys.path.insert(0,'$HERE');import stage_pins as s;print(s.job().MODELS['sravaani'][1])")
echo "stage_snapshots: streaming tar (indic@${IREV:0:12}, sravaani@${SREV:0:12}, manifest)" 1>&2
exec tar -h --owner=0 --group=0 -cf - --transform 's,^models--,hub/models--,' \
  -C "$INDIC_HUB" "models--ai4bharat--indic-conformer-600m-multilingual/snapshots/$IREV" \
  -C "$SRA_HUB" "models--ARTPARK-IISc--SraVaani-1.0/snapshots/$SREV" \
  -C "$STAGE" lane3-pins
