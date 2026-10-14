#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PYTHONUNBUFFERED=1
PY=~/eta-router/.venv/bin/python
OUT=~/dev/_fable/r-pools3.log
: > $OUT
{
cd ~/eta-router
git worktree add --detach /tmp/refute-pools 7956f09 2>&1 | tail -1
cd /tmp/refute-pools
$PY - <<'EOF'
p='router_server.py'; s=open(p).read()
s=s.replace('    pool = _BACKEND_POOLS.get(engine)\n    if pool is not None:\n        return pool\n','    engine = "SHARED"\n    pool = _BACKEND_POOLS.get(engine)\n    if pool is not None:\n        return pool\n',1)
s=s.replace('_BACKEND_POOL_WORKERS = int(os.environ.get("ETA_BACKEND_POOL_WORKERS", "4"))','_BACKEND_POOL_WORKERS = 12')
open(p,'w').write(s)
EOF
git diff --stat
echo "=== MUT1 with ETA_INDICTRANS2_TIMEOUT=1"
ETA_INDICTRANS2_TIMEOUT=1 $PY -m unittest test_translate.D2PoolIsolation 2>&1 | tail -8
echo "=== MUT1 default indictrans2 timeout (bounded 200s)"
( $PY -m unittest test_translate.D2PoolIsolation 2>&1 | tail -4 ) &
BG=$!
for i in {1..200}; do kill -0 $BG 2>/dev/null || break; sleep 1; done
echo "elapsed ~${i}s"
git checkout -q router_server.py
echo "=== unmutated with ETA_BACKEND_POOL_WORKERS=1"
ETA_BACKEND_POOL_WORKERS=1 $PY -m unittest test_translate test_job_verdict 2>&1 | tail -3
cd ~/eta-router
git worktree remove --force /tmp/refute-pools
echo DONE
} >> $OUT 2>&1
