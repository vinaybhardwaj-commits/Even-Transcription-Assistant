#!/bin/zsh
F=/Users/vinaybhardwaj/dev/_fable
M=$F/wt3-mut
L=$F/r3-mut.log
cd $M || exit 9
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
T=tests/unit/fuse-arms.test.ts
cp lib/mcp/tools/fuse.ts lib/mcp/tools/fuse.ts.orig
: > $L

runcase () {
  echo "########## $1" >> $L
  npx vitest run $T 2>&1 | grep -E "Test Files|Tests  |× |FAIL |AssertionError|Error:" | head -22 >> $L
  echo "" >> $L
  cp lib/mcp/tools/fuse.ts.orig lib/mcp/tools/fuse.ts
}

runcase "M0 CONTROL (unmutated 38a7dac)"

python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/wt3-mut/lib/mcp/tools/fuse.ts"
s=open(F).read()
a="       FROM jev_window_signal WHERE session_id = ANY($1) ORDER BY start_ms`,\n    [sessionIds],"
b="       FROM jev_window_signal WHERE room_day_id = $1 ORDER BY start_ms`,\n    [sessionIds[0]],"
assert s.count(a)==1, ("M1a",s.count(a))
s=s.replace(a,b)
c="const signals = await readJevSignals(sessions.map((s) => s.id));"
d="const signals = await readJevSignals([day.id]);"
assert s.count(c)==1, ("M1b",s.count(c))
open(F,"w").write(s.replace(c,d))
print("M1 applied")
PY
runcase "M1 = readJevSignals REVERTED to room_day_id keying"

python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/wt3-mut/lib/mcp/tools/fuse.ts"
s=open(F).read()
a="  const isScratch = day.room_id.startsWith(SCRATCH_ROOM_PREFIX);"
b="  return [];\n  const isScratch = day.room_id.startsWith(SCRATCH_ROOM_PREFIX);"
assert s.count(a)==1, ("M2",s.count(a))
open(F,"w").write(s.replace(a,b))
print("M2 applied")
PY
runcase "M2 = resolveTapeSessionsForJev returns [] (walk-back broken)"

python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/wt3-mut/lib/mcp/tools/fuse.ts"
s=open(F).read()
a='detail: "no_bench_sessions_for_day"'
b='detail: "sessions_found_no_signals"'
assert s.count(a)==1 and s.count(b)==1, ("M3",s.count(a),s.count(b))
s=s.replace(a,"__TMP__").replace(b,a).replace("__TMP__",b)
open(F,"w").write(s)
print("M3 applied")
PY
runcase "M3 = the two detail values INVERTED"

python3 - <<'PY'
F="/Users/vinaybhardwaj/dev/_fable/wt3-mut/lib/mcp/tools/fuse.ts"
s=open(F).read()
a="      if (day.scratch !== true) {"
b="      if (day.scratch !== true && arm !== \"jev\") {"
assert s.count(a)==1, ("M4",s.count(a))
open(F,"w").write(s.replace(a,b))
print("M4 applied")
PY
runcase "M4 = scratch guard EXEMPTS arm jev"

echo "rc=0" >> $L
cat $L
