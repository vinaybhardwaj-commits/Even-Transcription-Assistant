#!/bin/zsh
# Fable one-line fixes on 7956f09 per ETA-Refuter PASS-WITH-FIXES: clamp pool workers >=1; bound indictrans2 timeout in D2PoolIsolation.
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd ~/eta-router-pools
python3 - <<'EOF'
import re
p="router_server.py"; s=open(p).read()
old='_BACKEND_POOL_WORKERS = int(os.environ.get("ETA_BACKEND_POOL_WORKERS", "4"))'
assert old in s
s=s.replace(old,'_BACKEND_POOL_WORKERS = max(1, int(os.environ.get("ETA_BACKEND_POOL_WORKERS", "4") or 4))')
open(p,"w").write(s)
t="test_translate.py"; s=open(t).read()
old='mock.patch.object(rs, "OPENROUTER_TIMEOUT", 1.0)):'
assert s.count(old)>=1
i=s.index('class D2PoolIsolation'); j=s.index(old,i)
s=s[:j]+'mock.patch.object(rs, "OPENROUTER_TIMEOUT", 1.0),\n                  mock.patch.object(rs, "INDICTRANS2_TIMEOUT", 1.0)):'+s[j+len(old):]
open(t,"w").write(s)
print("patched")
EOF
~/eta-router/.venv/bin/python -m unittest test_translate test_job_verdict 2>&1 | tail -3
ETA_BACKEND_POOL_WORKERS=0 ~/eta-router/.venv/bin/python -c 'import router_server as rs; print("workers", rs._BACKEND_POOL_WORKERS)'
git add -A && git commit -q -m "Pools: clamp ETA_BACKEND_POOL_WORKERS to >=1; D2PoolIsolation bounds indictrans2 timeout (refuter fixes)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP" && git log --oneline -1
