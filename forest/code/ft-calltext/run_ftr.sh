#!/bin/bash
# FTR run (RUNO-AUDIO step 4): base vs base+call-text vs base+call-text+call-audio, landmark T=3/7, h14/h90/ale, cohort P, payer off.
# Usage: run_ftr.sh [audio parquet]   (default out/ft-rl-feat/call_audio_feats.parquet). Episode-level audio files need AUDIO_T=<T> and only that T runs.
set -euo pipefail
cd "$(dirname "$0")/.."
A=${1:-$HOME/oc/forest-lead/ft/out/ft-rl-feat/call_audio_feats.parquet}
L=$HOME/oc/forest-lead/ft/out/ft-calltext; PY=$HOME/.venv-forest/bin/python
[ -f "$A" ] || { echo "no audio file: $A"; exit 1; }
$PY - "$A" <<'EOF'
import sys, pandas as pd
a = pd.read_parquet(sys.argv[1]); ac = [c for c in a.columns if c.startswith('aud_')]
print('audio rows', len(a), 'episodes', a.episode_id.nunique(), 'aud_ cols', len(ac), 'per-call' if 'day_from_rx' in a.columns else 'episode-level')
assert 'episode_id' in a.columns and (ac or any(c.endswith(('_t3', '_t7')) for c in a.columns)), 'schema: need episode_id + aud_* or rl-feat _t3/_t7 columns'
EOF
RLF=$($PY -c "import sys,pandas as pd; a=pd.read_parquet(sys.argv[1]); print(int(not any(c.startswith('aud_') for c in a.columns)))" "$A")
if [ "$RLF" = 1 ]; then   # ft-rl-feat episode-level format: _t7 window only (T=14 is not a valid landmark for h14/Ale)
  (AUDIO=$A NJ=4 $PY code/ftc_model.py h14-P-lm3 h14-P-lm7 > $L/ftr_a.log 2>&1 &
   AUDIO=$A NJ=4 $PY code/ftc_model.py h90-P-lm3 h90-P-lm7 > $L/ftr_b.log 2>&1 &
   AUDIO=$A NJ=4 $PY code/ftc_model.py ale-P-lm3 ale-P-lm7 > $L/ftr_c.log 2>&1 &
   wait)   # rlfeat_to_aud asserts if a _t3 window is absent
elif [ -n "${AUDIO_T:-}" ]; then LM="lm$AUDIO_T"; C1="h14-P-$LM h90-P-$LM ale-P-$LM"
  AUDIO=$A AUDIO_T=$AUDIO_T NJ=6 $PY code/ftc_model.py $C1 > $L/ftr_a.log 2>&1
else
  (AUDIO=$A NJ=4 $PY code/ftc_model.py h14-P-lm3 h14-P-lm7 > $L/ftr_a.log 2>&1 &
   AUDIO=$A NJ=4 $PY code/ftc_model.py h90-P-lm3 h90-P-lm7 > $L/ftr_b.log 2>&1 &
   AUDIO=$A NJ=4 $PY code/ftc_model.py ale-P-lm3 ale-P-lm7 > $L/ftr_c.log 2>&1 &
   wait)
fi
T=${TAG:-v2_audio}
$PY code/ftc_table.py "$L/model_${T}_*.json" > $L/FTR-TABLES${TAG:+-$TAG}.md
chmod 600 $L/model_${T}_*.json $L/FTR-TABLES*.md $L/ftr_*.log
echo "tables: $L/FTR-TABLES${TAG:+-$TAG}.md"
