#!/bin/zsh
R=/Users/vinaybhardwaj/dev/Even-Transcription-Assistant-ow
O=/Users/vinaybhardwaj/dev/_fable/r3-read.txt
cd $R || exit 9
{
echo "=== fuse.ts: guard + handler ordering (lines 195-250) ==="
git show 38a7dac:lib/mcp/tools/fuse.ts | sed -n '195,250p'
echo
echo "=== fuse.ts: RoomDayByIdRow + readDay ==="
git show 38a7dac:lib/mcp/tools/fuse.ts | grep -n "RoomDayByIdRow" -A 14 | head -40
echo
echo "=== fuse.ts: readJevSignals row mapper (lines 108-150) ==="
git show 38a7dac:lib/mcp/tools/fuse.ts | sed -n '108,150p'
echo
echo "=== iso() helper ==="
git show 38a7dac:lib/mcp/tools/fuse.ts | grep -n "function iso\|const iso" -A 6
echo
echo "=== runArm callers anywhere ==="
grep -rn "runArm(" lib app services tests --include=*.ts | head -20
echo
echo "=== listBenchSessions definition ==="
grep -rn "export async function listBenchSessions" -A 40 lib/bench.ts lib/bench/*.ts 2>/dev/null | head -60
echo
echo "=== scratch.ts: realRoomIdFor / SCRATCH_ROOM_PREFIX / scratchRoomIdFor ==="
grep -n "SCRATCH_ROOM_PREFIX\|realRoomIdFor\|scratchRoomIdFor" -A 10 lib/brain/scratch.ts | head -60
echo
echo "=== fuse-report.ts 105-145 (the idiom being mirrored) ==="
sed -n '105,145p' lib/brain/fuse/fuse-report.ts
echo
echo "=== scratch day creation: ist_date ==="
grep -rn "ist_date" lib/brain/scratch.ts | head -30
echo
echo "=== jev_window_signal schema: start_ms/end_ms/session_id types ==="
grep -rn "jev_window_signal" -A 25 db/migrations/0106_jev_window_signal.sql 2>/dev/null | head -45
echo
echo "=== JOB_KIND_NAMES / job kinds registry ==="
grep -rn "JOB_KIND_NAMES" lib app --include=*.ts | head -10
grep -n "jev_english\|jev_window\|jev_role" lib/jobs/kinds/index.ts | head -20
} > $O 2>&1
echo "wrote $(wc -l < $O) lines"
