#!/bin/zsh
{
echo "--- ps ---"
ps aux | grep pya_bake | grep -v grep
echo "--- curl ---"
ps aux | grep curl | grep -v grep
echo "--- log tail ---"
tail -20 /Users/vinaybhardwaj/dev/_fable/scratch/pyabake/pya_bake.log
echo "--- END ---"
} > /Users/vinaybhardwaj/dev/_fable/scratch/pyabake/check_out.txt 2>&1
