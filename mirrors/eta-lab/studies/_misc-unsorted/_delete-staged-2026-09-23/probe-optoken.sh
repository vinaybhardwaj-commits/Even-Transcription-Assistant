#!/bin/zsh
cd /Users/vinaybhardwaj/dev/Even-Transcription-Assistant || exit 1
echo "=== who reads OPERATOR_TOKEN ==="
grep -rn "OPERATOR_TOKEN" --include=*.ts --include=*.tsx lib app scripts 2>/dev/null | head -20
echo
echo "=== bench/windows route exists? ==="
ls -1 app/api/admin/bench/windows/ 2>&1
echo
echo "=== its auth lines ==="
grep -n -i -E "token|bearer|authorization|gate|admin" app/api/admin/bench/windows/route.ts 2>/dev/null | head -20
echo
echo "=== branches ==="
git branch --list 'vinay/*' | head -20
