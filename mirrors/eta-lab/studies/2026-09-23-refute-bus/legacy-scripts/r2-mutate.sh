#!/bin/zsh
F=/Users/vinaybhardwaj/dev/_fable
L=$F/r2-mut.log
rm -rf $F/r2mut; mkdir -p $F/r2mut
cp -R $F/r2tree/. $F/r2mut/ 2>/dev/null
rm -f $F/r2mut/node_modules
ln -s /Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow/node_modules $F/r2mut/node_modules
cd $F/r2mut
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
TESTS=(tests/unit/route-metrics-truth.test.ts tests/unit/vad-starvation-job-path.test.ts)

run_case () {
  echo "########## $1" >> $L
  npx vitest run "${TESTS[@]}" 2>&1 | grep -E "Test Files|Tests  |× |FAIL|AssertionError" | head -25 >> $L
  echo "" >> $L
}

python3 - <<'PY'
import shutil
F="/Users/vinaybhardwaj/dev/_fable/r2mut/"
for p in ["lib/stt/adapters/route.ts","lib/jobs/kinds/route-transcribe.ts","lib/room-day/admin.ts","lib/stt/room-drain.ts"]:
    shutil.copy(F+p, F+p+".orig")
PY

: > $L
run_case "M0 CONTROL (unmutated 135d33e)"

# M1 — revert F1: adapter reads outcome from the TOP LEVEL again
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/stt/adapters/route.ts"
s=open(F).read()
old="""      segmentation,
      outcome: segmentation?.outcome,"""
new="""      segmentation: (r as Record<string, unknown>).segmentation as never,
      outcome: (r as Record<string, unknown>).outcome as never,"""
assert s.count(old)==1, ("M1 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M1 applied")
PY
run_case "M1 = F1 REVERTED (adapter reads top-level outcome)"
cp $F/r2mut/lib/stt/adapters/route.ts.orig $F/r2mut/lib/stt/adapters/route.ts

# M2 — revert F2: drop the outcome!==null guard
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/jobs/kinds/route-transcribe.ts"
s=open(F).read()
old='silent_window: (outcome.known && outcome.outcome !== null) ? outcome.outcome === "engine_no_text" : chars === 0,'
new='silent_window: outcome.known ? outcome.outcome === "engine_no_text" : chars === 0,'
assert s.count(old)==1, ("M2 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M2 applied")
PY
run_case "M2 = F2 REVERTED (silent_window drops the null guard)"
cp $F/r2mut/lib/jobs/kinds/route-transcribe.ts.orig $F/r2mut/lib/jobs/kinds/route-transcribe.ts

# M3 — invert admin.ts engines ternary
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/room-day/admin.ts"
s=open(F).read()
old='engines: engineReading.known ? (engineReading.skipped ? "skipped" : "ran") : "unknown",'
new='engines: engineReading.known ? (engineReading.skipped ? "ran" : "skipped") : "unknown",'
assert s.count(old)==1, ("M3 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M3 applied")
PY
run_case "M3 = admin.ts engines ternary INVERTED"
cp $F/r2mut/lib/room-day/admin.ts.orig $F/r2mut/lib/room-day/admin.ts

# M4 — admin.ts drops the windows_* counts (F5 regression)
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/room-day/admin.ts"
s=open(F).read()
old="""              windows_total: engineReading.known ? engineReading.windows_total : null,
              windows_skipped: engineReading.known ? engineReading.windows_skipped : null,"""
new="""              windows_total: null,
              windows_skipped: null,"""
assert s.count(old)==1, ("M4 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M4 applied")
PY
run_case "M4 = admin.ts windows_* DROPPED"
cp $F/r2mut/lib/room-day/admin.ts.orig $F/r2mut/lib/room-day/admin.ts

# M5 — room-drain: restore the `|| asr.routerOutcome` gate (F7 regression)
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/stt/room-drain.ts"
s=open(F).read()
old="""...(asr.languageTimeline
             ? buildRouteMetrics(asr.languageTimeline, {}, asr.routerOutcome ?? undefined)"""
new="""...(asr.languageTimeline || asr.routerOutcome
             ? buildRouteMetrics(asr.languageTimeline ?? [], {}, asr.routerOutcome ?? undefined)"""
assert s.count(old)==1, ("M5 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M5 applied")
PY
run_case "M5 = room-drain F7 REVERTED (empty timeline block returns)"
cp $F/r2mut/lib/stt/room-drain.ts.orig $F/r2mut/lib/stt/room-drain.ts

echo "rc=0" >> $L
echo "--- mutation log ---"
cat $L
