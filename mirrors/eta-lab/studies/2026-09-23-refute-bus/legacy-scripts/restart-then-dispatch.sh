#!/bin/zsh
# Fable 23 Sep 13:20 — restart idle panes one at a time (picks up CC update, eta-bus MCP, wider dirs),
# keeping each pane's current model; send each its next order right after its restart.
export PATH=/opt/homebrew/bin:$PATH
F=/Users/vinaybhardwaj/dev/_fable
LOG=$F/scratch/restart-round1.log
typeset -A ORD
ORD[lx]="Fable (after your restart): three items. (1) eta-router ffbe1c7 PASS-WITH-FIXES: fix test_export_is_what_the_generator_writes - the generator must take an explicit output path (argument or env) and the test must write into its temp dir and compare, never overwrite the committed eta_number_words.py; prove old-fails/new-passes. (2) Then merge the lexicon branch into eta-router main and restart the router now (kickstart uk.llmvinayminihome.eta-router) - live room STT is off until 21:30 so the router is idle; verify health and one Hindi dose sample through the translate path (labels only, no text); tag pre-router-lexicon-20260923 first for rollback. (3) Then ruling 3: regenerate ETA lib/stt/number-words.json from router main, and add scripts/check-number-words.sh comparing the lexicon sha256 in ETA's JSON with the router's header hash (one-line hash compare, as ETA-Refuter noted); Yoga gate, push, sha to ETA-Refuter. Report in 8 lines. End with WAITING ON ETA-Refuter."
ORD[scribe]="Fable (after your restart): push freeze lifted. Deploy batch now: merge fleet retention 887d1e9 (PASS 7/7) and lx assembled-collapse 0d13c82 (PASS) onto 95cf2c9 in one tree, Yoga gate --build, one fast-forward push, verify served dpl + /api/health. ROOM_AUTO_DRAIN_ENABLED=off is a Vercel env var so the new build keeps live room STT off - confirm with GET /api/admin/drain-windows (CRON_SECRET, off-argv) that considered is 0. Report sha + dpl id to Fable (needed for the 21:25 restore). End with WAITING ON Fable."
ORD[scribe3]="Fable (after your restart): ETA-Refuter filed your regression pack 750d476 PASS-WITH-FIXES: the port's lexicon is 24 words vs the router's 770, and 6 of 11 differential lines disagree, every one a dose phrase the router protects and the port destroys (pachas/पचास/aivattu milligram, pachhattar goli, half half half, the patient sat). Fix: load the full lexicon from lib/stt/number-words.json instead of the subset, add those 11 lines as fixtures with the router's expected output, and correct the header claims. Yoga gate, PUSH TO ORIGIN, sha to ETA-Refuter. Report in 6 lines. End with WAITING ON ETA-Refuter."
ORD[refuter-gate]="Fable: herdr kit round 4 verified by Fable (O1 guard present, node test/unit.mjs 31/31, zsh -n ok). Kit is accepted. Stand by. End with WAITING ON Fable."
ORD[herdr-kit]="Fable: O1 guard verified by me - kit accepted. Stand by for follow-ups. End with WAITING ON Fable."
ORD[yoga-drain]="Fable: noted - no stop mechanism in the driver; Fable unloads overnight-translate at 21:00 IST and reverts ETA_OVERNIGHT_ALLOW_DAYTIME. Stand by. End with WAITING ON Fable."
for n in lx scribe scribe3 refuter-gate herdr-kit yoga-drain; do
  echo "$(date '+%H:%M:%S') restart $n" >> $LOG
  $F/herdr-ctl.sh restart $n >> $LOG 2>&1; rc=$?
  echo "$(date '+%H:%M:%S') restart $n rc=$rc" >> $LOG
  sleep 8
  /bin/zsh $F/hsend.sh "$ORD[$n]" $n
  echo "$(date '+%H:%M:%S') dispatched $n" >> $LOG
done
echo "$(date '+%H:%M:%S') ALL DONE" >> $LOG
