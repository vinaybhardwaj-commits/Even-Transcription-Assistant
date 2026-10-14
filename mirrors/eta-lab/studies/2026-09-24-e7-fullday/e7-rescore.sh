#!/usr/bin/env bash
# e7-rescore.sh — E-7 full-day rescore in ONE command (lx, 23 Sep, for the 24 Sep run at 21:00 IST).
#
#   e7-rescore.sh 2026-09-24            the whole thing: rooms+voiceprint -> PQM -> truth -> replay -> score
#   e7-rescore.sh 2026-09-24 --check    credentials and endpoints only: no Jev call, no DB write, no PQM pull
#   e7-rescore.sh 2026-09-24 --from <stage> [--to <stage>]   run a slice: stages rooms|pqm|truth|replay|score
#                                                              (earlier outputs are reused from out-<date>/)
#
# PQM WITHOUT METABASE: if ~/eta-data/pqm-consults-<date>.csv already exists (Fable/V can drop the export there,
# as on 23 Sep), stage 2 uses it and Metabase is not needed at all.
#
# Stages (each prints one *_DONE line, or STAGE_FAIL and stops):
#   1 rooms    every room-day of the date + voiceprint attribution; confirmed = >=30 attributed turns, one
#              clinician >=80% (ETA database, the same room_turn_speaker rows scribe_voice/window_speakers reads,
#              without its 500-turn cap)
#   2 pqm      Metabase db 13 consults, by the call time's IST date  -> ~/eta-data/pqm-consults-<date>.csv
#   3 truth    PQM consults of each confirmed room-day's doctor (both times, 1-60 min)
#   4 replay   shadow-runner v2 on the E-6.1 branch over the CONFIRMED room-days only (writes acoustic + fused
#              runs to the ETA database, shadow, as the E-7 replays did); three arms from ONE Jev sample
#   5 score    e7_score.py on acoustic / fused (E-6) / fused+E-6.1  -> SUMMARY.md
#
# Secrets are read from files (or, for the DB, fetched fresh from Neon's API) into the CHILD
# environment only (never argv, never printed):
#   ~/.claude/secrets/neon_api_key       Neon API key -- APP_DATABASE_URL (direct, not -pooler)
#                                         is fetched fresh each run via kit/neon-connection-uri.mjs,
#                                         not read from a static file: no eta_database_url secret
#                                         exists anywhere (orders/queue 001-herdr-kit.md item 1,
#                                         23 Sep -- herdr-kit switched this from the old design).
#   ~/.config/even-jev/key               TypeSafe (Jev) API key
#   ~/.claude/secrets/openrouter_api_key OpenRouter key (translation)
#   ~/.claude/secrets/metabase_url       Metabase base URL
#   ~/.claude/secrets/metabase_api_key   Metabase API key with read on database 13
# Code: the E-6.1 worktree (E61_WT, default ~/dev/eta-wt-e61), pinned: E61_SHA (default 81cec3a) must be HEAD.
set -euo pipefail
DATE="${1:?usage: e7-rescore.sh YYYY-MM-DD [--check | --from <stage> [--to <stage>]]}"; shift
MODE=run; FROM=rooms; TO=score
while [ $# -gt 0 ]; do case "$1" in
  --check) MODE=--check; shift ;;
  --from) FROM="${2:?--from needs a stage}"; shift 2 ;;
  --to) TO="${2:?--to needs a stage}"; shift 2 ;;
  *) echo "STAGE_FAIL unknown arg $1"; exit 2 ;;
esac; done
for x in "$FROM" "$TO"; do case "$x" in rooms|pqm|truth|replay|score) ;; *) echo "STAGE_FAIL unknown stage $x"; exit 2 ;; esac; done
PQM_CSV="$HOME/eta-data/pqm-consults-$DATE.csv"
HERE="$(cd "$(dirname "$0")" && pwd)"
E61_WT="${E61_WT:-$HOME/dev/eta-wt-e61}"; E61_SHA="${E61_SHA:-81cec3a}"
OUT="$HERE/out-$DATE"; mkdir -p "$OUT" "$HOME/eta-data"
LOG="$OUT/run-$(date +%Y%m%dT%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
exec 9>/tmp/e7-rescore.lock; flock -n 9 || { echo "STAGE_FAIL another e7-rescore is running"; exit 9; }

need() { [ -s "$1" ] || { echo "MISSING $2 ($1)"; MISSING=1; }; }
MISSING=0
# only what the stages being run need
idx() { local i=0; for s in rooms pqm truth replay score; do [ "$s" = "$1" ] && echo $i; i=$((i+1)); done; }
runs() { [ "$MODE" = "--check" ] || { [ "$(idx "$1")" -ge "$(idx "$FROM")" ] && [ "$(idx "$1")" -le "$(idx "$TO")" ]; }; }
if runs rooms || runs replay; then need "$HOME/.claude/secrets/neon_api_key" "Neon API key (for a fresh APP_DATABASE_URL)"; fi
if runs replay; then need "$HOME/.config/even-jev/key" "Jev key"; need "$HOME/.claude/secrets/openrouter_api_key" "OpenRouter key"; fi
if runs pqm; then
  if [ -s "$PQM_CSV" ]; then echo "PQM: using the dropped export $PQM_CSV (Metabase not needed)"
  else need "$HOME/.claude/secrets/metabase_url" "Metabase URL (or drop $PQM_CSV)"; need "$HOME/.claude/secrets/metabase_api_key" "Metabase API key (or drop $PQM_CSV)"; fi
fi
[ -d "$E61_WT" ] || { echo "MISSING E-6.1 worktree ($E61_WT)"; MISSING=1; }
if [ -d "$E61_WT" ]; then
  head_sha="$(git -C "$E61_WT" rev-parse --short HEAD)"
  [ "$head_sha" = "$E61_SHA" ] || { echo "WRONG CODE: $E61_WT is at $head_sha, expected $E61_SHA"; MISSING=1; }
  [ -z "$(git -C "$E61_WT" status --porcelain --untracked-files=no)" ] || { echo "DIRTY: $E61_WT has uncommitted changes"; MISSING=1; }
fi
echo "=== e7-rescore $DATE mode=$MODE code=$E61_SHA out=$OUT"
[ "$MISSING" = 0 ] || { echo "STAGE_FAIL preflight (see MISSING/WRONG/DIRTY above)"; exit 4; }

# children get secrets by env; the parent shell never echoes them.
# eta-refuter-2 PASS-WITH-FIXES (23 Sep): (a) the Neon URI fetch's stderr was swallowed and an
# empty result on failure let the child start anyway with no DB at all -- now fetched first and
# checked. (b) `env VAR="$(...)" cmd` puts the secret in /usr/bin/env's own argv for the instant
# before it execs, visible to anything reading /proc or `ps` on that host in that window -- the
# "never argv" rule in this file's own header. `export` inside a subshell is a shell builtin, not
# a new process, so the value is never an argv anywhere.
secret_env() {
  local db_uri
  db_uri="$(node "$HOME/dev/eta-lab/kit/neon-connection-uri.mjs")" || {
    echo "STAGE_FAIL secret_env: could not fetch a Neon connection URI" >&2; return 9;
  }
  [ -n "$db_uri" ] || { echo "STAGE_FAIL secret_env: Neon connection URI came back empty" >&2; return 9; }
  (
    unset DATABASE_URL OPENROUTER_API_KEY
    export APP_DATABASE_URL="$db_uri"
    export TYPESAFE_API_KEY="$(cat "$HOME/.config/even-jev/key" 2>/dev/null)"
    export OPENROUTER_API_KEY_FILE="$HOME/.claude/secrets/openrouter_api_key"
    export METABASE_URL="$(cat "$HOME/.claude/secrets/metabase_url" 2>/dev/null)"
    export METABASE_API_KEY="$(cat "$HOME/.claude/secrets/metabase_api_key" 2>/dev/null)"
    "$@"
  )
}
# vn <0|1 Jev enabled for this process> <stage args...>
vn() { local jev="$1"; shift; (cd "$E61_WT" && secret_env env ETA_JEV_ENABLED="$jev" node_modules/.bin/vite-node --config vitest.config.ts "$HERE/stage_db.ts" "$@"); }

if [ "$MODE" = "--check" ]; then
  vn 0 check "$DATE" 2>&1 | grep -v "CJS build" || true
  [ -s "$PQM_CSV" ] || secret_env python3 - <<'PY'
import json, os, urllib.request
u = os.environ["METABASE_URL"].rstrip("/")
try:
    with urllib.request.urlopen(urllib.request.Request(f"{u}/api/user/current", headers={"x-api-key": os.environ["METABASE_API_KEY"]}), timeout=30) as r:
        print("CHECK_METABASE ok", r.status)
except Exception as e:
    print("CHECK_METABASE FAIL", type(e).__name__, getattr(e, "code", ""))
PY
  echo "CHECK_DONE"; exit 0
fi

STAGES=(rooms pqm truth replay score)
for st in "${STAGES[@]}"; do
  runs "$st" || { echo "=== $st (skipped: --from $FROM --to $TO)"; continue; }
  case "$st" in
    rooms)  echo "=== 1 rooms";  vn 0 rooms "$DATE" "$OUT" 2>&1 | grep -v "CJS build" ;;
    pqm)    echo "=== 2 pqm"
            if [ -s "$PQM_CSV" ]; then echo "PQM_DONE using dropped export ($(($(wc -l < "$PQM_CSV") - 1)) rows)"
            else secret_env python3 "$HERE/pqm_pull.py" "$DATE" "$PQM_CSV"; fi ;;
    truth)  echo "=== 3 truth";  python3 "$HERE/build_truth.py" "$DATE" "$OUT/confirmed.json" "$PQM_CSV" "$OUT/e7-truth-$DATE.csv" "$OUT/attribution.json" ;;
    replay) echo "=== 4 replay"; vn 1 replay "$DATE" "$OUT" 2>&1 | grep -v "CJS build" ;;
    score)  echo "=== 5 score"
            # ENCOUNTER-FIRST arm d, out of sample (Fable 24 Sep 10:20): the same segmenter + declared parameters as 23 Sep
            python3 "$HERE/arm_d.py" "$DATE" "$OUT" "$OUT/e7-truth-$DATE.csv" || echo "ARMD_SKIPPED (the other arms still score)"
            python3 "$HERE/score_arms.py" "$OUT" "$OUT/e7-truth-$DATE.csv" ;;
  esac
done
echo "=== e7-rescore $DATE DONE"
