#!/usr/bin/env bash
# selftest.sh — the W28.2 harness's offline tests, rerunnable by the reviewer. NOTHING here touches
# a database, the Mini, or R2: every run scores already-checked-in 23/24 Sep artifacts or files the
# test itself creates under /tmp. Run from this directory: bash selftest.sh
#
# Covers refuter-2's three blockers on 5addfb47:
#   B1 the version gate is real (mismatch fails; undeclared refused unless --allow-undeclared,
#      and then UNDECLARED is printed in the card);
#   B2 only THIS run's hyp files are scored (the same selection the runner executes);
#   B3 --from/--to parses the FLAGS correctly (the old script validated flag tokens as stages and
#      failed every sliced invocation).
# Plus the metric-identity reproduction (the order's test, unchanged).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=fullday_lib.sh
source "$HERE/fullday_lib.sh"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
SCORER="$HERE/fullday_score.py"
RUNNER="$HERE/fullday-rescore.sh"
T="$(mktemp -d /tmp/lx-w282-selftest-XXXXXXXX)"
# refuter-2 N2 (selftest side): the test tree is housekeeping, gone when the test ends.
trap 'rm -rf "$T"' EXIT
TRUTH="$ROOT/studies/2026-09-23-e7-pqm-truth/e7-truth-23sep.csv"
HYP="$ROOT/studies/2026-09-23-e7-pqm-truth/hyp-fused.json"
SCORE_NAME="selftest-version-$$"
FAIL=0

ok()   { echo "  ok  $1"; }
fail() { echo "  FAIL $1"; FAIL=1; }

check() {  # check <desc> <want_rc> <cmd...>
  local desc="$1" want="$2"; shift 2
  "$@" >/dev/null 2>&1; local rc=$?
  if [ "$rc" = "$want" ]; then ok "$desc (rc=$rc)"; else fail "$desc: rc=$rc wanted $want"; fi
}

echo "== T0 metric identity (order W28.2: reproduce the 23 Sep 3-room score exactly)"
out="$T/t0"
python3 "$SCORER" --truth "$TRUTH" --hyp "$HYP" --transcript "$SCORE_NAME" --allow-undeclared \
  --out "$out.md" --json "$out.json" >/dev/null 2>&1
rc=$?
if [ "$rc" = 0 ] \
   && grep -q "| hyp-fused.json | 14 | 7 | 3 | 21.4% | 42.9% | 0 | 0 |" "$out.md" \
   && grep -q "175.2/369.6 s" "$out.md" && grep -q "327.6/356.8 s" "$out.md" \
   && grep -q "UNDECLARED" "$out.md"; then
  ok "3/14 found, fusion 3/7, start 175.2/369.6 s, end 327.6/356.8 s, UNDECLARED printed"
else
  fail "T0 reproduction (rc=$rc; see $out.md)"
fi

echo "== T1 B1: undeclared hyp file, no --allow-undeclared -> refused (rc=3)"
out="$T/t1"
check "undeclared-without-allow" 3 python3 "$SCORER" --truth "$TRUTH" --hyp "$HYP" \
  --transcript "$SCORE_NAME" --out "$out.md"

echo "== T2 B1: mismatch-declared hyp file -> refused (rc=3) even with --allow-undeclared"
python3 - "$HYP" "$T/hyp-mismatch.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["transcript_version"] = "wrong-name"
json.dump(d, open(sys.argv[2], "w"))
PY
out="$T/t2"
check "declared-mismatch, allow given" 3 python3 "$SCORER" --truth "$TRUTH" \
  --hyp "$T/hyp-mismatch.json" --transcript "$SCORE_NAME" --allow-undeclared --out "$out.md"

echo "== T3 B1: declared-match hyp file -> scores (rc=0), name travels to the card"
python3 - "$HYP" "$T/hyp-matched.json" "$SCORE_NAME" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["transcript_version"] = sys.argv[3]
json.dump(d, open(sys.argv[2], "w"))
PY
out="$T/t3"
if python3 "$SCORER" --truth "$TRUTH" --hyp "$T/hyp-matched.json" --transcript "$SCORE_NAME" \
     --out "$out.md" >/dev/null 2>&1 && grep -q "transcript version: $SCORE_NAME" "$out.md" \
     && grep -q "transcript=$SCORE_NAME" "$out.md" && ! grep -q "UNDECLARED" "$out.md"; then
  ok "declared-match scored, card carries the name, no UNDECLARED note"
else
  fail "T3 declared-match scoring"
fi

echo "== T4 B2: only THIS run's hyp files are picked (fullday_lib.pick_fresh_hyps, the runner's own function)"
# Reproduce the marker semantics: the marker (a run's start time) must sit BETWEEN the stale file's
# mtime and the fresh file's — stale written first, then the marker, then fresh.
mkdir -p "$T/out-selftest"
python3 - "$HYP" "$T/out-selftest/hyp-stale.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["transcript_version"] = None
json.dump(d, open(sys.argv[2], "w"))
PY
sleep 1
MARK="$(mktemp /tmp/lx-selftest-t4-XXXXXXXX)"; touch "$MARK"; sleep 1
python3 - "$HYP" "$T/out-selftest/hyp-fresh.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["transcript_version"] = None
json.dump(d, open(sys.argv[2], "w"))
PY
mapfile -t picked < <(pick_fresh_hyps "$T/out-selftest" "$MARK")
if [ ${#picked[@]} = 1 ] && [ "$(basename "${picked[0]:-x}")" = "hyp-fresh.json" ]; then
  ok "selection: 1 fresh file, the stale one skipped"
else
  fail "T4 selection: picked=${picked[*]:-none}"
fi

echo "== T5 B2 end to end: runner --select-only over a run's out dir uses the same selection"
bash "$RUNNER" selftest-t4 --transcript "$SCORE_NAME" --select-only 2>/dev/null | head -1 | grep -q "SELECTED 0" \
  && ok "runner --select-only on a fresh date dir (0 fresh files)" \
  || fail "runner --select-only BASIC"

echo "== T5 B3: --from/--to parses the flags (plan only)"
plan="$T/t5"
bash "$RUNNER" 2026-09-23 --transcript "$SCORE_NAME" --from replay --to replay --plan >"$plan" 2>&1
rc=$?
if [ "$rc" = 0 ] && grep -q -- "--from replay --to replay" "$plan" && grep -q "nothing executed" "$plan"; then
  ok "--from replay --to replay parses and plans (rc=0)"
else
  fail "T5 plan --from/--to (rc=$rc; see $plan)"
fi

echo "== T6 B3: a bogus stage name is rejected BEFORE anything runs"
out="$T/t6"
bash "$RUNNER" 2026-09-23 --transcript "$SCORE_NAME" --from bogus --to replay --plan >"$out" 2>&1
rc=$?
if [ "$rc" = 2 ] && grep -q "unknown stage" "$out"; then ok "bogus stage rc=2"; else fail "T6 bogus stage rc=$rc"; fi

echo "== T7 the wiring reaches the replay child: e7-rescore.sh parses --transcript and exports it"
# e7-rescore.sh's preflight fails on a stub E61_WT BEFORE any stage runs — offline; the -x trace
# still shows the arg parsed and E7_TRANSCRIPT_VERSION exported before the exit.
out="$T/t7"
E61_WT="$T/no-such-worktree" bash -x "$ROOT/studies/2026-09-24-e7-fullday/e7-rescore.sh" \
  2026-09-23 --transcript probe --check >"$out" 2>&1
rc=$?
if grep -qE "export E7_TRANSCRIPT_VERSION=['\"]?probe" "$out" \
   && grep -q "STAGE_FAIL preflight" "$out"; then
  ok "--transcript parsed + exported (trace); preflight stops offline (rc=$rc)"
else
  fail "T7 wiring trace (rc=$rc)"
fi
# refuter-2 hardening: a caller-inherited E7_TRANSCRIPT_VERSION must NOT leak to a run that named
# nothing — the script unsets it when --transcript is absent.
out7b="$T/t7b"
E7_TRANSCRIPT_VERSION=leak E61_WT="$T/no-such-worktree" bash -x "$ROOT/studies/2026-09-24-e7-fullday/e7-rescore.sh" \
  2026-09-23 --check >"$out7b" 2>&1
if grep -q "unset E7_TRANSCRIPT_VERSION" "$out7b"; then
  ok "inherited E7_TRANSCRIPT_VERSION unset when --transcript absent"
else
  fail "T7b inherited-env unwind"
fi

echo "== T8 stage_db.ts / arm_d.py carry the field (ring check, the real write runs only inside a replay)"
grep -q "E7_TRANSCRIPT_VERSION" "$ROOT/studies/2026-09-24-e7-fullday/stage_db.ts" \
  && grep -q "E7_TRANSCRIPT_VERSION" "$ROOT/studies/2026-09-24-e7-fullday/arm_d.py" \
  && ok "stage_db.ts + arm_d.py reference E7_TRANSCRIPT_VERSION" \
  || fail "T8 field reference"

if [ "$FAIL" = 0 ]; then echo "SELFTEST_PASS"; else echo "SELFTEST_FAIL"; exit 1; fi
