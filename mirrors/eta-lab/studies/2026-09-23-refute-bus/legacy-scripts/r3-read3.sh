#!/bin/zsh
F=/Users/vinaybhardwaj/dev/_fable/wt3-fix
O=/Users/vinaybhardwaj/dev/_fable/r3-read3.txt
{
echo "=== runJevArm signature + session handling ==="
grep -n "export function runJevArm" -A 60 $F/lib/brain/fuse/jev-arm.ts | head -80
echo
echo "=== any per-session grouping/sort in jev-arm ==="
grep -n "session_id\|sessions\|sort(" $F/lib/brain/fuse/jev-arm.ts | head -40
echo
echo "=== brain db driver ==="
sed -n '1,45p' $F/lib/brain/db.ts
echo
echo "=== prior = ANY(\$1) uses on the brain pool (pre-existing idiom) ==="
grep -rn "= ANY(\$1)" $F/lib $F/app 2>/dev/null | head -12
} > $O 2>&1
echo "wrote $(wc -l < $O) lines"
