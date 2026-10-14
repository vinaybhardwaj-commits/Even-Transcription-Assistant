#!/bin/bash
# backfill_driver.sh — [BACKFILL-DRIVER] (Fable, V-approved, 28 Sep; refuter-3 reviewed: r1 a626c618 FAIL B1-B3,
# r2 e0dcd694): for each IST date from --from-date (default 2026-09-25) back to --to-date (default 2026-08-19),
# newest first, in OUTER PASSES (deferred/failed dates retried; exits when a pass leaves nothing, or 10 passes):
#   (1) CUT   that date's room windows, 2 nice'd shards, proven recipe (reb_windows.py, pinned
#             cut_window import): tier-C plan for 24-25 Sep, tier-A/B union for older dates
#             -> ~/eta-data/hist/windows-reb/<date>/<room>/<win>.webm + manifest-<date>.jsonl
#   (2) STT   that date's catalog through reb's own run_real_ingest (whisper x3 + SraVaani twins,
#             --skip-indic: the indic twin is shared with the live STT route; a later indic-only pass
#             picks the windows back up) -> tracks land in ~/eta-data/reb/<date>/. ONE worker, only while
#             NO reb-owned run_real_ingest is alive; deferred otherwise, retried next pass. STT done is
#             recorded as windows-reb/stt-<date>.done (also written when the catalog is empty = nothing to do).
#   (3) TONE  NONE — tone is PARKED by Fable's ruling (29 Sep, emotion twin inactive). The driver does not
#             touch tone: no park, no kill, no relaunch (refuter-3 T-BACKFILL-7 B1). Tone's own keeper
#             (tone_loop.sh) covers dates when tone resumes.
# Resume-safe: every step skips windows that already have output (O_EXCL claims + existing files).
# N1: shas of reb's ingest code logged at START; the STT step ABORTS if they changed mid-run.
D=~/dev/eta-lab/studies/2026-09-24-hist-bulk
HD=~/eta-data/hist
LOG=$HD/backfill_driver.log
PIDF=$HD/backfill_driver.pid
PY=~/.venv-r2/bin/python
REB_LIB=/tmp/wt-reb-lib/kit      # reb's runner code lives in reb's worktree (their lane); DEFAULT_ROOT ~/eta-data/reb
REB_INGEST_SHA=$(sha256sum $REB_LIB/reb_runner/real_ingest/run_real_ingest.py | cut -d' ' -f1)
REB_CATALOG_SHA=$(sha256sum $REB_LIB/reb_runner/real_ingest/build_real_catalog.py | cut -d' ' -f1)
FROM=${1:-2026-09-25}
TO=${2:-2026-08-19}
if [ -e "$PIDF" ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then
  echo "$(date +%T) driver already running pid $(cat $PIDF), refusing to start" >> $LOG; exit 1
fi
echo $$ > $PIDF
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') driver[$$] $*" >> $LOG; }
stopped() { [ -e $HD/BACKFILL_STOP ]; }
date_range() { python3 - "$FROM" "$TO" <<'EOF'
import sys
from datetime import date, timedelta
f, t = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])
d = f
while d >= t:
    print(d.isoformat()); d -= timedelta(days=1)
EOF
}
log "START from=$FROM to=$TO pid=$$ reb_ingest=$REB_INGEST_SHA reb_catalog=$REB_CATALOG_SHA"
# TONE IS PARKED (Fable 29 Sep): the driver does NOT own tone at all — no park, no kill, no relaunch.
# (refuter-3 T-BACKFILL-7 B1: the old park+relaunch here was wrong; tone_loop is another lane's keeper.)
# C2 (refuter-3): orphan claims in BOTH stores, any run incl. the driver's own — no workers are alive at START
python3 - <<'EOF'
import glob, json, os
HD = os.path.expanduser("~/eta-data/hist")
# tone claims without a record
rel = 0
for c in glob.glob(f"{HD}/tone/claims/*.json"):
    try: cl = json.load(open(c))
    except Exception: continue
    run = cl.get("run")
    p = f"{HD}/tone/runs/{run}/{os.path.basename(c)[:-5]}.json" if run else None
    if p and not os.path.exists(p):
        os.unlink(c); rel += 1
print(f"orphan tone claims released: {rel}")
# cut claims without output
relc = 0
for c in glob.glob(f"{HD}/windows-reb/.claims/*.json"):
    wid = os.path.basename(c)[:-5]
    out = glob.glob(f"{HD}/windows-reb/*/*/{wid}*")
    if not out:
        os.unlink(c); relc += 1
print(f"orphan cut claims released: {relc}")
EOF
restore_on_exit() {
  rm -f $PIDF
  log "EXIT: PID file removed (tone untouched: parked by Fable, another lane's keeper owns it)"
}
trap restore_on_exit EXIT
PASS=0
while ! stopped; do
  PASS=$((PASS + 1))
  ANY_LEFT=0
  log "PASS $PASS begins"
for DAY in $(date_range); do
  stopped && break
  # skip a date only when cut+STT+tone are ALL complete (B2: STT done has its own marker)
  STT_DONE=$HD/windows-reb/stt-$DAY.done
  N_CUT=$(python3 - "$DAY" <<'EOF'
import json, os, glob, sys
day = sys.argv[1]
HD = os.path.expanduser('~/eta-data/hist')
plan = []
seen = set()
src = f'{HD}/windows_tierC.json' if day >= '2026-09-24' else None
if src:
    plan = [w for w in json.load(open(src)) if w.get('day') == day]
else:
    for t in ('A', 'B'):
        for w in json.load(open(f'{HD}/windows_tier{t}.json')):
            if w.get('day') == day and w['win_id'] not in seen:
                seen.add(w['win_id']); plan.append(w)
have = {os.path.basename(f)[:-5] for f in glob.glob(f'{HD}/windows-reb/{day}/*/*.webm')}
have |= {os.path.basename(f)[:-5] for f in glob.glob(f'{HD}/windows-reb/{day}/*/*.json')}
print(sum(1 for w in plan if w['win_id'] not in have))
EOF
)
  N_TONE=$(python3 - "$DAY" <<'EOF'
import json, os, glob, sys
day = sys.argv[1]
HD = os.path.expanduser('~/eta-data/hist/tone')
wl = [w for w in json.load(open(f'{HD}/tone_worklist.json')) if w.get('ist_date', '').startswith(day)]
have = {}
for f in glob.glob(f'{HD}/runs/*/bw_*.json'):
    r = json.load(open(f)); have[r['window_id']] = r['state']
print(sum(1 for w in wl if w['id'] not in have))
EOF
)
  # CUT-ONLY completion test: date is done when its windows are cut (STT/tone are separate lanes now)
  if [ "$N_CUT" -eq 0 ]; then log "$DAY SKIP (cut complete; stt/tone handled outside this driver)"; continue; fi
  log "$DAY BEGIN cut_todo=$N_CUT tone_todo=$N_TONE(tone-parked) stt_done=$([ -e $STT_DONE ] && echo yes || echo no)"
  # ---- step 1: CUT (2 shards, nice 10) ----
  PLAN=tierAB; [ "$DAY" '>' "2026-09-23" ] && PLAN=tierC   # 24 Sep onward is in the tier-C plan
  nice -n 10 $PY $D/reb_windows.py --day $DAY --plan $PLAN --shard 0/2 > $HD/windows-reb/cut-$DAY-s0.log 2>&1 &
  P1=$!
  nice -n 10 $PY $D/reb_windows.py --day $DAY --plan $PLAN --shard 1/2 > $HD/windows-reb/cut-$DAY-s1.log 2>&1 &
  P2=$!
  wait $P1; R1=$?
  wait $P2; R2=$?
  RC_CUT=$((R1 | R2))
  N_CUT_NOW=$(find $HD/windows-reb/$DAY -name "*.webm" 2>/dev/null | wc -l)
  if [ $RC_CUT -ne 0 ]; then
    log "$DAY CUT FAILED rc=$RC_CUT (date skipped, retried on a later pass)"; ANY_LEFT=1; continue
  fi
  log "$DAY CUT DONE windows=$N_CUT_NOW"
  # ---- step 2: STT into reb (T-BACKFILL-6 fix, Fable GO 21:2x 29 Sep): the STT success check is the
  # ingest's EXIT CODE (refuter-2 #6594, r3 #6598); the impossible CRASHED grep is gone. STT defaults OFF
  # (the HF lane owns it, T-BACKFILL-9); STT_ENABLE=1 enables box runs explicitly. A date whose STT was
  # completed by the HF lane is detected (reb tracks >= catalog) and marked stt-<date>.done here, so the
  # retry loop treats it as complete instead of deferring forever.
  if [ "${STT_ENABLE:-0}" = "1" ]; then
  # HF-done detection (T-BACKFILL-6): if reb already holds a whisper-auto track for every catalog window
  # of this date, the date's STT is complete regardless of which lane ran it - mark and move on, so the
  # retry loop never defers a date whose STT the HF lane finished.
  # Drift check FIRST (r3 7459 nit): a changed build_real_catalog.py must abort BEFORE it can write a
  # smaller catalog that the HF-done check would wrongly accept.
  CUR_INGEST=$(sha256sum $REB_LIB/reb_runner/real_ingest/run_real_ingest.py | cut -d' ' -f1)
  CUR_CATALOG=$(sha256sum $REB_LIB/reb_runner/real_ingest/build_real_catalog.py | cut -d' ' -f1)
  if [ "$CUR_INGEST" != "$REB_INGEST_SHA" ] || [ "$CUR_CATALOG" != "$REB_CATALOG_SHA" ]; then
    log "$DAY STT ABORTED (reb ingest code changed since START: ingest $CUR_INGEST catalog $CUR_CATALOG); retried on a later pass"; ANY_LEFT=1; continue
  fi
  # B2 (r3 #7435): rebuild the catalog FIRST so the check never runs against a stale catalog that predates
  # this pass's CUT (a fully-tracked old catalog + new untracked windows would wrongly mark done).
  python3 $REB_LIB/reb_runner/real_ingest/build_real_catalog.py $DAY > $HD/windows-reb/catalog-$DAY.json 2>>$LOG
  if [ -s $HD/windows-reb/catalog-$DAY.json ]; then
    COUNTS=$(python3 - "$DAY" <<'PYEOF'
import json, os, glob, sys
day = sys.argv[1]
root = os.path.expanduser('~/eta-data/reb')
cat = json.load(open(os.path.expanduser(f'~/eta-data/hist/windows-reb/catalog-{day}.json')))
n = sum(1 for w in cat if glob.glob(f'{root}/{day}/{w["room_id"]}/{w["window_id"]}/tracks/stt.whisper-auto__*'))
print(n, len(cat))
PYEOF
) || COUNTS=""
    N_STT_DONE=${COUNTS%% *}; N_CAT=${COUNTS##* }
    if [ "$COUNTS" != "${COUNTS%%[!0-9 ]*}" ] || [ -z "$COUNTS" ]; then
      log "$DAY STT CHECK FAILED (python count failed; NOT marked done; retried on a later pass)"; ANY_LEFT=1
    elif [ "$N_STT_DONE" -eq "$N_CAT" ] && [ "$N_CAT" -gt 0 ]; then
      log "$DAY STT ALREADY DONE by the HF lane ($N_STT_DONE/$N_CAT whisper-auto tracks); marking stt-done"
      touch $STT_DONE; chmod 600 $STT_DONE
      continue
    fi
  fi
  if ! pgrep -f "[r]un_real_ingest.py" > /dev/null; then
    if [ -s $HD/windows-reb/catalog-$DAY.json ]; then   # the catalog was rebuilt at the top of this block
      nice -n 10 python3 $REB_LIB/reb_runner/real_ingest/run_real_ingest.py $HD/windows-reb/catalog-$DAY.json --skip-indic \
        > $HD/windows-reb/ingest-$DAY.log 2>&1
      RC_STT=$?
      # refuter-2 #6594: run_real_ingest exits 1 if any window crashed — the exit code IS the check
      # (the old "CRASHED: []" grep could never match the real output line).
      if [ $RC_STT -eq 0 ]; then
        log "$DAY STT DONE (catalog $(wc -l < $HD/windows-reb/catalog-$DAY.json) windows)"
        touch $HD/windows-reb/stt-$DAY.done; chmod 600 $HD/windows-reb/stt-$DAY.done
      else
        log "$DAY STT FAILED rc=$RC_STT (see ingest-$DAY.log; retried on a later pass)"; ANY_LEFT=1
      fi
    else
      log "$DAY STT SKIPPED (empty catalog: no cut windows); marked stt-done"
      touch $STT_DONE; chmod 600 $STT_DONE
    fi
  else
    log "$DAY STT DEFERRED (reb's own ingest workers are live; retried on a later pass of this loop)"; ANY_LEFT=1
  fi
  fi   # end STT_ENABLE gate (CUT-ONLY run: the whole STT step is skipped)
  log "$DAY STT NOT RUN (CUT-ONLY relaunch per Fable #6619; STT goes to HF under T-BACKFILL-9)"
  # ---- step 3: TONE — SKIPPED entirely (Fable 29 Sep: TONE is PARKED, eta-emotion-twin inactive, no
  # emotion tracks; when tone resumes its own resume-safe workers cover these dates). The skip test below
  # therefore no longer requires tone completion; STT done + cut complete make a date SKIP-ready. ----
  log "$DAY TONE SKIPPED (tone parked by Fable ruling; cut+stt state is the date's completion test)"
  log "$DAY DONE cut=$N_CUT_NOW stt=$([ -e $STT_DONE ] && echo done || echo deferred)"
done
log "PASS $PASS ended"
if [ "$ANY_LEFT" -eq 0 ]; then log "nothing left in range, exiting after $PASS pass(es)"; break; fi
if [ "$PASS" -ge 10 ]; then log "safety stop: 10 passes reached with work still left; check ingest-$DAY.log / driver-$DAY-s*.log"; break; fi
sleep 120   # between passes: let reb's own workers finish their current windows before retrying deferred dates
done
log "END"
rm -f $PIDF