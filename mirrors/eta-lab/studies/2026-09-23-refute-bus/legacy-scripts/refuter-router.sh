#!/bin/zsh
O=/Users/vinaybhardwaj/dev/_fable/refuter-router.txt
{
echo "=== file ==="; ls -la ~/eta-router/router_server.py 2>&1
echo "=== job_verdict ==="; grep -n "job_verdict" -A 60 ~/eta-router/router_server.py | head -120
echo "=== outcome mentions ==="; grep -n "outcome\|silent_skipped\|windows_total\|windows_skipped\|n_engine_segments" ~/eta-router/router_server.py | head -80
} > $O 2>&1
echo "wrote $(wc -l < $O)"
