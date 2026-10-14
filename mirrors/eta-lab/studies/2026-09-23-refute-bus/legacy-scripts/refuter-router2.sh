#!/bin/zsh
O=/Users/vinaybhardwaj/dev/_fable/refuter-router2.txt
{
echo "=== 525-620 ==="; sed -n '525,620p' ~/eta-router/router_server.py
echo "=== 640,690 ==="; sed -n '640,690p' ~/eta-router/router_server.py
echo "=== job dict init ==="; grep -n 'job\[' ~/eta-router/router_server.py | head -40
echo "=== job/{id} GET ==="; grep -n '/route/job' -A 25 ~/eta-router/router_server.py | head -70
} > $O 2>&1
echo "wrote $(wc -l < $O)"
