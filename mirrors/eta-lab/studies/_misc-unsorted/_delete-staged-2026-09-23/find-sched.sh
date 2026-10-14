#!/bin/zsh
echo "=== September schedule / roster candidates ==="
find /Users/vinaybhardwaj/dev /Users/vinaybhardwaj/Documents /Users/vinaybhardwaj/Downloads /Users/vinaybhardwaj/Desktop \
  -maxdepth 4 -iname "*schedul*" -o -maxdepth 4 -iname "*roster*" -o -maxdepth 4 -iname "*duty*" -o -maxdepth 4 -iname "*sept*" 2>/dev/null | grep -v node_modules | head -30
echo
echo "=== 'OPD Pulse' folder ==="
ls -1 "/Users/vinaybhardwaj/OPD Pulse" 2>&1 | head -20
echo
echo "=== centroid repository candidates ==="
find /Users/vinaybhardwaj/dev -maxdepth 4 -iname "*centroid*" -o -maxdepth 4 -iname "*voiceprint*" -o -maxdepth 4 -iname "*voice*print*" 2>/dev/null | grep -v node_modules | head -25
