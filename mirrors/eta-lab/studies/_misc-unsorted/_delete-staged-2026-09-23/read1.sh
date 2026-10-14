#!/bin/bash
set -e
F=~/eta-router/router_server.py
echo "=== window_outcome function ==="
grep -n "def window_outcome" -A 30 "$F"
echo "=== NO_ENGINE / outcome constants ==="
grep -n "NO_ENGINE\|_OUTCOME\|outcome =" "$F" | head -40
