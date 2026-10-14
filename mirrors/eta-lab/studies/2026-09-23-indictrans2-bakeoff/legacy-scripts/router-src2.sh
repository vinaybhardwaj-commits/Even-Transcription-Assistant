#!/bin/zsh
P=/Users/vinaybhardwaj/eta-router/router_server.py
echo "=== where the merged segmentation dict is attached to the job ==="
grep -n 'segmentation' "$P" | head -30
echo "=== job[...] top-level assignments after merge ==="
sed -n '820,880p' "$P"
