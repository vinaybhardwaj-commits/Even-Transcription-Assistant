#!/bin/zsh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
O=/Users/vinaybhardwaj/dev/_fable/r3-read2.txt
cd $R || exit 9
{
echo "=== runArm callers ==="
grep -rn "runArm(" lib app services tests 2>/dev/null | head -20
echo
echo "=== listBenchSessions ==="
grep -rn "export async function listBenchSessions" -A 45 lib/bench.ts 2>/dev/null | head -60
echo
echo "=== fuse-report location + the walk-back idiom ==="
grep -rln "realRoomIdFor" lib app 2>/dev/null
echo "--- occurrences:"
grep -rn "realRoomIdFor" -B 4 -A 8 lib app 2>/dev/null | head -60
echo
echo "=== who creates the scratch room_day, and with what ist_date ==="
grep -rn "ensureScratchRoomDay\|SQL_SCRATCH_DAY_INSERT\|scratchRoomDayIdFor" lib app 2>/dev/null | head -20
echo
echo "=== scratch.ts 150-215 (day creation) ==="
sed -n '150,215p' lib/brain/scratch.ts
echo
echo "=== JOB_KIND_NAMES ==="
grep -rn "JOB_KIND_NAMES" lib app 2>/dev/null | head -10
echo "--- kinds/index.ts:"
cat lib/jobs/kinds/index.ts | head -60
} > $O 2>&1
echo "wrote $(wc -l < $O) lines"
