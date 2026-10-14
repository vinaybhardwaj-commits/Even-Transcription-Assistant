#!/bin/zsh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
LOG=~/dev/_fable/scratch/jev-commit-push.log
cd ~/dev/qo-wt
{
  echo "=== commit ==="
  git commit -m "$(cat <<'EOF'
Jev translate: veto romanised Hindi, bound the whole OpenRouter call, cap the fallback chain

Fixes the four blockers ETA-Refuter found on top of 7e54307 (docs/handoff/
ETA-JEV-TRANSLATE-REFUTER-22-SEP-2026.md):

- D1: verifiedEnglish() now vetoes any romanised-Indic token before the ASCII/
  function-word ratio can pass it, ported verbatim from the router's
  ROMANISED_INDIC_VETO (~/eta-router/router_server.py:366-374, live at cd62569).
  "aapko kitne din se bukhar hai to take the goli morning and night" and
  "vo kal the two days morning" now translate instead of skipping.

- D2: openrouterChat's AbortController timer now stays armed for the whole
  function (one try/finally around the fetch AND res.json()), not just until
  doFetch resolves. A server that sends headers and never closes the body now
  fails around timeoutMs instead of hanging indefinitely.

- D3: added tests pinning that a non-string message.content (null, a list)
  falls through to the fallback model, and that total failure never stores the
  literal string "null" as a translation.

- D4: translateToEnglish now shares ONE total deadline across every model in
  the chain (JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT, 40s) instead of giving each
  model its own full per-call timeout (JEV_TRANSLATE_CALL_TIMEOUT_MS_DEFAULT,
  20s, shrinking to whatever budget remains for a later model). With
  JEV_TRANSLATE_BATCH=3, worst case is now 3 x 40s = 120s, under MAX_STEP_MS
  (200s) with ~80s left for the step's DB work — was 3 x 2 x 60s = 360s.

- D5: default models moved to primary google/gemini-3.8-flash, fallback
  meta-llama/llama-4-scout (V's choice, matching the router), in both
  lib/jev/translate.ts and lib/llm/gemini.ts's routedChat OpenRouter fallback
  (LLM_FALLBACK_DEFAULT). The Vertex primary models are untouched.

Each new guard was mutated once and confirmed to turn its test red (D1 veto
removed, D2 timer cleared early, D3 content coerced with String(), D4 deadline
break removed). Full suite: 161 files, 3636 passed | 1 skipped, via Docker
Postgres for the migration/E2E tests.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PdUpQZUtoniiquFdLfiVtP
EOF
)"
  echo "EXIT=$?"
  echo "=== log ==="
  git log -1 --stat
  echo "=== push ==="
  git push origin HEAD:vinay/eta-qwen-out
  echo "PUSH_EXIT=$?"
} > $LOG 2>&1
echo done
