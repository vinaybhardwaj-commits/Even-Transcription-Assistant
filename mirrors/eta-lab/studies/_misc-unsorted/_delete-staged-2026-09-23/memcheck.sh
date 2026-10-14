#!/bin/zsh
chmod +x /Users/vinaybhardwaj/dev/_fable/*.sh 2>/dev/null
echo "=== physical RAM ==="
echo "$(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo
echo "=== TRUSTED #1: memory_pressure free % ==="
timeout 20 memory_pressure 2>/dev/null | tail -6
echo
echo "=== TRUSTED #2: swap-used DELTA over 60s (absolute swap-used is not meaningful here) ==="
A=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
echo "t0 swap used: ${A}M"
sleep 60
B=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
echo "t60 swap used: ${B}M"
python3 -c "print('DELTA over 60s: %+.1f MB' % (float('$B')-float('$A')))"
sysctl vm.swapusage
echo
echo "=== who is actually resident (top 15 by RSS - imperfect, but shows the big holders) ==="
ps -Ao rss,comm -r | head -16 | awk 'NR==1{print "RSS_MB  COMMAND"; next}{printf "%7.0f  %s\n", $1/1024, $2}'
echo
echo "=== the ETA services + ollama specifically ==="
for p in ollama whisper indic sravaani diarize router python3 Docker; do
  printf '%-12s ' "$p"
  ps -Ao rss,comm | grep -i "$p" | grep -v grep | awk '{s+=$1} END {printf "%.1f GB across %d procs\n", s/1048576, NR}'
done
echo
echo "=== launchd ETA services: loaded/running? ==="
launchctl list 2>/dev/null | grep -iE "eta-|ollama" | head -10
