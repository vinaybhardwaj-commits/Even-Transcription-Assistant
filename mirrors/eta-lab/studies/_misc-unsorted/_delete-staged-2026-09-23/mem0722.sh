#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
echo "== top rss (MB)"
ps axo pid=,rss=,comm= | sort -k2 -nr | head -8 | awk '{printf "%s %d %s\n",$1,$2/1024,$3}'
echo "== diarize pid rss"
ps -o rss= -p 70563 | awk '{print $1/1024 " MB"}'
echo "== guard"
cat ~/overnight-translate/diarize-guard.sh | grep -nE "THRESH|GB|MB|kickstart" | head -8
tail -5 ~/overnight-translate/diarize-guard.log 2>/dev/null
echo "== gate source"
grep -rln "sustained_pressure" ~/dev/_fable/wt-merge --include=*.ts --include=*.mjs --include=*.js 2>/dev/null | grep -v node_modules | head
grep -rn "sustained_pressure" ~/dev/_fable/wt-merge --include=*.ts 2>/dev/null | grep -v node_modules | grep -v test | head -5
echo "== last log"
tail -6 ~/overnight-translate/overnight-translate.log | cut -c1-220
