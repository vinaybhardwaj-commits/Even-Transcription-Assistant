#!/bin/zsh
F=/Users/vinaybhardwaj/dev/_fable
L=$F/r2-mut6.log
cd $F/r2mut
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
T1=tests/unit/route-metrics-truth.test.ts
T2=tests/unit/vad-starvation-job-path.test.ts
cp lib/stt/route-run.ts lib/stt/route-run.ts.orig
: > $L

# M6 — buildRouteOutcome ignores the carrier's `outcome` entirely
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/stt/route-run.ts"
s=open(F).read()
old="const outcome = isOutcome(router.outcome) ? router.outcome : null;"
new="const outcome = null as RouteOutcome | null;"
assert s.count(old)==1, ("M6 anchor", s.count(old))
open(F,"w").write(s.replace(old,new))
print("M6 applied")
PY
echo "########## M6 = buildRouteOutcome IGNORES carrier.outcome" >> $L
npx vitest run $T1 $T2 2>&1 | grep -E "Test Files|Tests  |× |FAIL|AssertionError" | head -20 >> $L
cp lib/stt/route-run.ts.orig lib/stt/route-run.ts

# M7 — buildRouteOutcome reads seg.outcome INSTEAD of carrier.outcome
python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/r2mut/lib/stt/route-run.ts"
s=open(F).read()
old="  const outcome = isOutcome(router.outcome) ? router.outcome : null;"
assert s.count(old)==1
s=s.replace(old,"  const _segForOutcome = (router.segmentation && typeof router.segmentation === 'object' && !Array.isArray(router.segmentation)) ? (router.segmentation as Record<string, unknown>) : null;\n  const outcome = isOutcome(_segForOutcome?.outcome) ? _segForOutcome!.outcome as RouteOutcome : null;")
open(F,"w").write(s)
print("M7 applied")
PY
echo "########## M7 = buildRouteOutcome reads seg.outcome INSTEAD" >> $L
npx vitest run $T1 $T2 2>&1 | grep -E "Test Files|Tests  |× |FAIL|AssertionError" | head -20 >> $L
cp lib/stt/route-run.ts.orig lib/stt/route-run.ts
cat $L
