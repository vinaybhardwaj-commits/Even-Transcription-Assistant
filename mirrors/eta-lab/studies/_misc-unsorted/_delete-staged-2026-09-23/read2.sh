#!/bin/bash
set -e
F=~/eta-router/router_server.py
sed -n '530,560p' "$F"
echo "=== job_verdict ==="
sed -n '760,785p' "$F"
echo "=== route reply 640-680 ==="
sed -n '640,680p' "$F"
