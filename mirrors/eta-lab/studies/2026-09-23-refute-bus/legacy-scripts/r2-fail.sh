#!/bin/zsh
O=/Users/vinaybhardwaj/dev/_fable/r2-fail.txt
{
echo "=== wt-fix failure detail ==="
grep -n "R58 — THE LIMITER" -A 30 /Users/vinaybhardwaj/dev/_fable/r2-wt-fix.log | grep -v "^.*doctor_id" | head -45
echo; echo "=== same test in round-1 repo run (bbaba3b) ==="
grep -c "R58 — THE LIMITER STILL THROTTLES" /Users/vinaybhardwaj/dev/_fable/test-vad.log
grep "R58 — THE LIMITER STILL THROTTLES" /Users/vinaybhardwaj/dev/_fable/test-vad.log | head -3
} > $O 2>&1
cat $O
