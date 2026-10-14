#!/bin/zsh
echo "--- ps ---"
ps aux | grep pya_bake | grep -v grep
echo "--- lsof net (curl) ---"
ps aux | grep curl | grep -v grep
echo "--- log tail ---"
tail -20 /Users/vinaybhardwaj/dev/_fable/scratch/pyabake/pya_bake.log
