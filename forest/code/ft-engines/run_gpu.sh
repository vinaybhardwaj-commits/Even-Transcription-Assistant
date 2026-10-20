#!/bin/bash
# ft-engines GPU jobs (resumable). Each job takes ~/gpu.lock per item via code/gpu_manners.py.
cd $HOME/wt/ft-engines; W=$HOME/eta-data/forest/ft-engines; umask 077
TV=$HOME/timbre-nightly/venv/bin/python; EV=$HOME/eta-emotion/venv/bin/python; NV=$HOME/eta-data/nemotron/venv-nemo-main/bin/python
python3 -c "
import json
with open('$W/winB_doc.jsonl','w') as o:
    for l in open('$W/winB.jsonl'):
        if json.loads(l)['who']=='doctor': o.write(l)"
nohup $NV -I code/nemo_diar.py $HOME/eta-data/forest/rl/manifest.tsv $W/A_nemo.jsonl >> logs/A_nemo.log 2>&1 &
nohup $TV -I code/score_windows.py wavlm_aniemore.v1 $W/winA.jsonl $W/A_wavlm.jsonl $W/A_emb_wavlm >> logs/A_wavlm.log 2>&1 &
nohup $EV -I code/score_windows.py emotion2vec_plus_large.v1 $W/winA.jsonl $W/A_e2v.jsonl $W/A_emb_e2v >> logs/A_e2v.log 2>&1 &
nohup $TV -I code/score_windows.py wavlm_aniemore.v1 $W/winB.jsonl $W/B_wavlm.jsonl $W/B_emb_wavlm >> logs/B_wavlm.log 2>&1 &
nohup $EV -I code/score_windows.py emotion2vec_plus_large.v1 $W/winB.jsonl $W/B_e2v.jsonl $W/B_emb_e2v >> logs/B_e2v.log 2>&1 &
nohup $TV -I code/score_windows.py odyssey_wavlm_dim.v1 $W/winB_doc.jsonl $W/B_ody_doc.jsonl $W/B_emb_ody >> logs/B_ody.log 2>&1 &
