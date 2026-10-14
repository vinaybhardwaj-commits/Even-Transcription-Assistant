#!/bin/bash
# tone_loop.sh — W43.4 nightly tone pipeline keeper (hist-bulk, 27 Sep). Keeps up to 2 tone_backfill workers
# alive on the newest worklist; refreshes the worklist from Neon (read-only, kit/neon-select.mjs) whenever no
# worker is running. Stops on ~/eta-data/hist/tone/LOOP_STOP. Poll every 10 min (W28 cadence rule).
# STT first lives INSIDE tone_backfill (yields while a box STT route job holds the GPU).
D=~/dev/eta-lab/studies/2026-09-24-hist-bulk; HD=~/eta-data/hist/tone; PY=~/.venv-r2/bin/python
cd ~/dev/Even-Transcription-Assistant || exit 1
RUN_ID="hist-bulk-tone-nightly-$(date +%Y%m%d)"
stopped() { [ -e $HD/LOOP_STOP ]; }
workers() { pgrep -f "[t]one_backfill.py --run-id $RUN_ID" | wc -l; }
refresh_worklist() {
  node ~/dev/eta-lab/kit/neon-select.mjs "SELECT bw.id, bw.session_id, bw.start_ms, bw.end_ms, rd.ist_date, r.name AS room FROM bench_window bw LEFT JOIN room_emotion_window ew ON ew.window_id=bw.id JOIN room_day rd ON rd.id=bw.room_day_id JOIN room r ON r.id=rd.room_id WHERE bw.state='closed' AND ew.window_id IS NULL ORDER BY bw.start_ms DESC" > $HD/.wl_new.json 2>/dev/null \
    && python3 -c "import json,sys; d=json.load(open('$HD/.wl_new.json')); sys.exit(0 if isinstance(d,list) and d else 1)" \
    && mv $HD/.wl_new.json $HD/tone_worklist.json
  node ~/dev/eta-lab/kit/neon-select.mjs "SELECT id, session_id, r2_key, started_at, ended_at, idx FROM bench_chunk WHERE upload_state='verified'" > $HD/.bc_new.json 2>>$HD/tone_loop.log \
    && python3 -c "import json,sys; d=json.load(open('$HD/.bc_new.json')); sys.exit(0 if isinstance(d,list) and d else 1)" \
    && mv $HD/.bc_new.json $HD/bench_chunks.json || echo "$(date +%T) bench_chunk refresh FAILED (keeping the old snapshot)" >> $HD/tone_loop.log
}
while ! stopped; do
  refresh_worklist || true   # every cycle: workers re-read the file each window (dynamic newest-first)
  if [ "$(workers)" -lt 2 ]; then
    N=$(python3 -c "
import json,os,glob
wl=json.load(open('$HD/tone_worklist.json'))
have={os.path.basename(f)[:-5] for f in glob.glob('$HD/runs/*/*.json')}|{os.path.basename(f)[:-5] for f in glob.glob('$HD/claims/*.json')}
print(sum(1 for w in wl if w['id'] not in have))" 2>/dev/null || echo 0)
    if [ "$N" -gt 0 ]; then
      SH=$( [ "$(workers)" -eq 0 ] && echo 0 || echo 1 )
      (cd $D && setsid nohup $PY tone_backfill.py --run-id $RUN_ID --shard $SH/2 </dev/null >>$HD/worker$SH.log 2>&1 & disown)
      echo "$(date +%T) tone loop: started worker shard $SH/2, $N windows to do" >> $HD/tone_loop.log
    fi
  fi
  sleep 600
done
echo "$(date +%T) tone loop ended" >> $HD/tone_loop.log
