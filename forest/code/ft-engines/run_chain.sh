#!/bin/bash
# ft-engines: run the remaining the lab box GPU window jobs one after another per engine (all hold ~/gpu.lock per item; few models resident so the VRAM gate can open).
cd $HOME/wt/ft-engines; W=$HOME/eta-data/forest/ft-engines; umask 077
TV=$HOME/timbre-nightly/venv/bin/python; EV=$HOME/eta-emotion/venv/bin/python
waitpid() { while kill -0 $1 2>/dev/null; do sleep 10; done; }
case $1 in
 wavlm) waitpid $2; $TV -I code/score_windows.py wavlm_aniemore.v1 $W/winB.jsonl $W/B_wavlm.jsonl $W/B_emb_wavlm >> logs/B_wavlm.log 2>&1
        $TV -I code/score_windows.py wavlm_aniemore.v1 $W/winB2.jsonl $W/B2_wavlm.jsonl $W/B_emb_wavlm >> logs/B2_wavlm.log 2>&1 ;;
 ody)   waitpid $2; $TV -I code/score_windows.py odyssey_wavlm_dim.v1 $W/winB2_doc.jsonl $W/B2_ody_doc.jsonl $W/B_emb_ody >> logs/B2_ody.log 2>&1 ;;
 e2v)   waitpid $2; $EV -I code/score_windows.py emotion2vec_plus_large.v1 $W/winB.jsonl $W/B_e2v.jsonl $W/B_emb_e2v >> logs/B_e2v.log 2>&1
        $EV -I code/score_windows.py emotion2vec_plus_large.v1 $W/winB2.jsonl $W/B2_e2v.jsonl $W/B_emb_e2v >> logs/B2_e2v.log 2>&1 ;;
esac
