#!/usr/bin/env bash
# gh-gate.sh — run the ETA gate on GitHub Actions (8 vitest shards + typecheck + build, in parallel) for one
# commit, and wait for the verdict. orders/CI-GH-SHARDS.md (lx, 23 Sep). For builders AND ETA-Refuter.
#
#   kit/gh-gate.sh <sha> [--repo <path>] [--delete-branch] [--rerun]
#
# RE-GATING (eta-refuter-2, F4 residue): the pushed commit is deterministic, so gating the same sha again while
# ci/<sha12> still points at it makes NO new push event. That run is REUSED, and said so. --rerun deletes the
# branch and pushes again to get a fresh run (e.g. to retry a flake). Either way, a run is only accepted if it is
# for the pushed commit and, when a push happened, was created after it (60 s clock margin).
#
# What it pushes: branch `ci/<sha12>` pointing at a SYNTHETIC commit whose tree is <sha>'s tree with the CI config
# (.github/workflows/gate.yml + .github/check-silent-baseline.txt) overlaid (from GATE_WORKFLOW_REF, default origin/vinay/ci-gh-shards —
# origin/main once merged), and whose only parent is <sha>. The code under test is exactly <sha>; the only
# added file is the workflow, which GitHub needs in the pushed commit to run it. No working tree is touched.
# When <sha> already carries an identical gate.yml, <sha> itself is pushed.
#
# Watching: `gh run watch` when gh is logged in; otherwise the PUBLIC REST API (the ETA repo is public), polled
# every 60 s (30 s with gh or GH_TOKEN) — unauthenticated calls are limited to 60/hour per IP, shared by every pane.
#
# Prints:  GATE PASS|FAIL sha=<sha> run=<url> wall=<m>m<s>s  (+ each job's duration, slowest shard marked)
# Exit:    0 PASS · 1 FAIL (the run completed, conclusion not success) · 2 usage · 3 push/lookup/API error
#          (rate limit included: NEVER a test result) · 4 timed out waiting
set -euo pipefail
SHA="${1:?usage: gh-gate.sh <sha> [--repo <path>] [--delete-branch]}"; shift || true
REPO_DIR="${ETA_REPO:-$HOME/dev/Even-Transcription-Assistant}"; DELETE=0; RERUN=0
while [ $# -gt 0 ]; do case "$1" in
  --repo) REPO_DIR="$2"; shift 2 ;;
  --delete-branch) DELETE=1; shift ;;
  --rerun) RERUN=1; shift ;;
  *) echo "unknown arg $1"; exit 2 ;;
esac; done
WF=".github/workflows/gate.yml"
GATE_WORKFLOW_REF="${GATE_WORKFLOW_REF:-origin/vinay/ci-gh-shards}"
OWNER_REPO="${OWNER_REPO:-vinaybhardwaj-commits/Even-Transcription-Assistant}"
TIMEOUT_S="${TIMEOUT_S:-3600}"
git_() { git -C "$REPO_DIR" "$@"; }

git_ fetch -q origin 2>/dev/null || true
FULL="$(git_ rev-parse --verify "$SHA^{commit}" 2>/dev/null)" || { echo "GATE ERROR unknown commit $SHA in $REPO_DIR"; exit 3; }
SHORT="${FULL:0:12}"
# The CI CONFIG set overlaid onto the target (eta-refuter-2 G1): the workflow AND the files it reads. Never code
# under test. A target that predates one of them must still be gated by today's rules, not fail for its absence.
CI_FILES=(".github/workflows/gate.yml" ".github/check-silent-baseline.txt")
declare -A BLOB
for f in "${CI_FILES[@]}"; do
  BLOB[$f]="$(git_ rev-parse --verify "$GATE_WORKFLOW_REF:$f" 2>/dev/null)" || { echo "GATE ERROR no $f at $GATE_WORKFLOW_REF"; exit 3; }
done
SAME=1
for f in "${CI_FILES[@]}"; do [ "$(git_ rev-parse --verify -q "$FULL:$f" || true)" = "${BLOB[$f]}" ] || SAME=0; done

if [ "$SAME" = 1 ]; then
  PUSH="$FULL"
else
  IDX="$(mktemp)"; trap 'rm -f "$IDX"' EXIT
  GIT_INDEX_FILE="$IDX" git -C "$REPO_DIR" read-tree "$FULL"
  for f in "${CI_FILES[@]}"; do
    GIT_INDEX_FILE="$IDX" git -C "$REPO_DIR" update-index --add --cacheinfo "100644,${BLOB[$f]},$f"
  done
  TREE="$(GIT_INDEX_FILE="$IDX" git -C "$REPO_DIR" write-tree)"
  # DETERMINISTIC (eta-refuter-2 F4): author/committer name, email and date are copied from the target, so the
  # same target + the same gate.yml always make the SAME commit. A second gate of one sha pushes an identical
  # ref (no new run) instead of a new commit whose run cancels the first and reads as a false FAIL.
  IFS=$'\t' read -r AN AE AD CN CE CD < <(git_ log -1 --format='%an%x09%ae%x09%aI%x09%cn%x09%ce%x09%cI' "$FULL")
  PUSH="$(GIT_AUTHOR_NAME="$AN" GIT_AUTHOR_EMAIL="$AE" GIT_AUTHOR_DATE="$AD" \
          GIT_COMMITTER_NAME="$CN" GIT_COMMITTER_EMAIL="$CE" GIT_COMMITTER_DATE="$CD" \
          git -C "$REPO_DIR" commit-tree "$TREE" -p "$FULL" -m "ci: gate $SHORT (tree of $FULL + CI config: ${CI_FILES[*]})")"
fi
BRANCH="ci/$SHORT"
REMOTE_AT="$(git_ ls-remote origin "refs/heads/$BRANCH" | cut -f1)"
MIN_CREATED=0   # epoch seconds; 0 = accept an existing run for this commit
if [ "$REMOTE_AT" = "$PUSH" ] && [ $RERUN = 0 ]; then
  echo "=== $BRANCH already at ${PUSH:0:12}: REUSING its existing run (no new push event); --rerun for a fresh one"
else
  if [ "$REMOTE_AT" = "$PUSH" ]; then
    git_ push -q origin --delete "$BRANCH" || { echo "GATE ERROR could not delete $BRANCH for --rerun"; exit 3; }
    sleep 3
  fi
  MIN_CREATED=$(( $(date +%s) - 60 ))   # 60 s: tolerates a drifted pane clock; earlier-push runs are minutes older
  git_ push -q -f origin "$PUSH:refs/heads/$BRANCH" || { echo "GATE ERROR push $BRANCH failed"; exit 3; }
  echo "=== pushed $BRANCH -> ${PUSH:0:12} (target $SHORT)"
fi

# ---- GitHub API reads. EXIT CODES ARE A CONTRACT (eta-refuter-2 #79): 1 means ONLY "the run completed and its
# conclusion was not success". Anything about reading GitHub (rate limit, network, unparseable reply) is 3.
# api_get <path>: sets API_BODY. Runs in the CALLING shell (never inside $(...)), so its `exit 3` ends the script.
# A 403/429 with x-ratelimit-remaining 0 (unauthenticated: 60/h per IP, shared by every pane here) waits for the
# reset when that fits the timeout, else exits 3 saying so. Other failures retry 10 times, then exit 3.
T_START=$(date +%s)
api_get() {
  local n=0 hdr out code rem reset now wait
  while :; do
    hdr="$(mktemp)"
    out="$(curl -sS -D "$hdr" -w '\n%{http_code}' ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
            -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$OWNER_REPO/$1" 2>/dev/null)" || out=$'\n000'
    code="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"
    rem="$(tr -d '\r' < "$hdr" | awk -F': ' 'tolower($1)=="x-ratelimit-remaining"{print $2}')"
    reset="$(tr -d '\r' < "$hdr" | awk -F': ' 'tolower($1)=="x-ratelimit-reset"{print $2}')"; rm -f "$hdr"
    [ "$code" = 200 ] && return 0
    now=$(date +%s)
    if { [ "$code" = 403 ] || [ "$code" = 429 ]; } && [ "${rem:-x}" = 0 ]; then
      wait=$(( ${reset:-$((now + 60))} - now + 5 )); [ "$wait" -lt 5 ] && wait=5
      if [ $(( now + wait - T_START )) -gt "$TIMEOUT_S" ]; then
        echo "GATE ERROR GitHub API rate limit exhausted (unauthenticated 60/h, shared by every pane on this IP); reset in ${wait}s is past TIMEOUT_S. Not a test result. Set GH_TOKEN or 'gh auth login'. Run: ${RUN_ID:+https://github.com/$OWNER_REPO/actions/runs/$RUN_ID}"
        exit 3
      fi
      echo "=== GitHub API rate limit exhausted (60/h per IP, shared); waiting ${wait}s for the reset (set GH_TOKEN to avoid this)" >&2
      sleep "$wait"; continue
    fi
    n=$((n+1))
    [ $n -ge 10 ] && { echo "GATE ERROR GitHub API $1 failed 10 times (last HTTP $code). Not a test result."; exit 3; }
    echo "=== GitHub API $1 -> HTTP $code, retry $n in 30 s" >&2; sleep 30
  done
}
# api_try <path>: ONE attempt, never exits; 0 and API_BODY set on HTTP 200, else 1. For cosmetic reads only (the
# job table): losing it must never lose a verdict (eta-refuter-2 #85).
api_try() {
  local out code
  out="$(curl -sS -w '\n%{http_code}' ${GH_TOKEN:+-H "Authorization: Bearer $GH_TOKEN"} \
          -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$OWNER_REPO/$1" 2>/dev/null)" || return 1
  code="${out##*$'\n'}"; API_BODY="${out%$'\n'*}"
  [ "$code" = 200 ]
}
# parse <python-expression over d>: prints the value; an unparseable reply is exit 3, never a traceback-then-1
parse() { printf '%s' "$API_BODY" | python3 -c "
import json, sys
from datetime import datetime
ts = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
d = json.load(sys.stdin)
$1" 2>/dev/null || { echo "GATE ERROR unparseable GitHub API reply. Not a test result." >&2; exit 3; }; }

USE_GH=0; gh auth status >/dev/null 2>&1 && USE_GH=1
# unauthenticated public API: 60 calls/hour per IP, shared by every pane here — poll gently
POLL_S="${POLL_S:-$([ $USE_GH = 1 ] || [ -n "${GH_TOKEN:-}" ] && echo 30 || echo 60)}"

# find the run for exactly this pushed commit
RUN_ID=""; t0=$(date +%s)
while [ -z "$RUN_ID" ]; do
  if [ $USE_GH = 1 ]; then
    RUN_ID="$(gh run list -R "$OWNER_REPO" --workflow gate.yml --branch "$BRANCH" --json databaseId,headSha,createdAt \
      -q "map(select(.headSha==\"$PUSH\" and (.createdAt|fromdateiso8601) >= $MIN_CREATED))[0].databaseId // empty" 2>/dev/null || true)"
  else
    # gate.yml's runs only (eta-refuter-2 F3): another workflow on the same ci/ branch must not be mistaken for it
    api_get "actions/workflows/gate.yml/runs?branch=$BRANCH&per_page=5"
    RUN_ID="$(parse "r = [x for x in d.get('workflow_runs', []) if x['head_sha'] == '$PUSH' and ts(x['created_at']) >= $MIN_CREATED]
print(r[0]['id'] if r else '')")" || exit 3
  fi
  [ -n "$RUN_ID" ] && break
  [ $(( $(date +%s) - t0 )) -gt 180 ] && { echo "GATE ERROR no run appeared for $BRANCH in 180 s"; exit 3; }
  sleep 20
done
echo "=== run https://github.com/$OWNER_REPO/actions/runs/$RUN_ID"

if [ $USE_GH = 1 ]; then
  gh run watch -R "$OWNER_REPO" "$RUN_ID" --interval "$POLL_S" >/dev/null 2>&1 || true
fi
while :; do
  api_get "actions/runs/$RUN_ID"
  STATE="$(parse "print(d['status'], d['conclusion'])")" || exit 3
  [ "${STATE%% *}" = completed ] && break
  [ $(( $(date +%s) - t0 )) -gt "$TIMEOUT_S" ] && { echo "GATE TIMEOUT run=$RUN_ID state=$STATE"; exit 4; }
  sleep "$POLL_S"
done
read -r CONC WALL < <(parse "w = ts(d['updated_at']) - ts(d['run_started_at'])
print(d['conclusion'], f'{int(w//60)}m{int(w%60)}s')") || exit 3

# the job table is best-effort: one try, and a failure (rate limit, bad reply) only skips the table. The subshell
# keeps parse's exit 3 from ending the script after the verdict is already known.
if api_try "actions/runs/$RUN_ID/jobs?per_page=50" && ( parse "jobs = d['jobs']
dur = {j['name']: ts(j['completed_at']) - ts(j['started_at']) for j in jobs if j.get('started_at') and j.get('completed_at')}
shards = {k: v for k, v in dur.items() if k.startswith('test')}
slow = max(shards, key=shards.get) if shards else None
for j in jobs:
    x = dur.get(j['name'])
    t = f'{int(x//60)}m{int(x%60)}s' if x is not None else '?'
    print(f\"  {j['name']:<22} {j['conclusion'] or j['status']:<9} {t}{'  <- slowest shard' if j['name'] == slow else ''}\")" ) 2>/dev/null; then :
else echo "=== job table skipped (GitHub API unavailable or unreadable); the verdict below is unaffected"; fi
[ $DELETE = 1 ] && git_ push -q origin --delete "$BRANCH" && echo "=== deleted $BRANCH"
case "$CONC" in
  success) echo "GATE PASS sha=$FULL run=https://github.com/$OWNER_REPO/actions/runs/$RUN_ID wall=$WALL"; exit 0 ;;
  failure|cancelled|timed_out|action_required|startup_failure|stale|neutral|skipped)
           echo "GATE FAIL sha=$FULL conclusion=$CONC run=https://github.com/$OWNER_REPO/actions/runs/$RUN_ID wall=$WALL"; exit 1 ;;
  *)       echo "GATE ERROR run completed with no readable conclusion ('$CONC'). Not a test result."; exit 3 ;;
esac
