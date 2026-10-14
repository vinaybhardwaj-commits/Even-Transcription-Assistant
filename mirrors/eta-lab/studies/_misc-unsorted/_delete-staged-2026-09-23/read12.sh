#!/bin/bash
set -e
F=~/eta-router/router_server.py
echo "=== job status reply / run_job aggregation, search language_timeline ==="
grep -n "language_timeline" "$F"
echo "=== context around run_job end / job status GET ==="
sed -n '785,900p' "$F"
