#!/usr/bin/env bash
# Even-ELO smoke matrix.
# Run after every push. Grows with each sprint that adds endpoints.

set -e

BASE_URL="${BASE_URL:-https://even-elo.vercel.app}"
PASS=0
FAIL=0

# /api/admin/** ops routes (migrate, wipe, db-fresh, ...) need a super_admin session or
# `Authorization: Bearer $ADMIN_OPS_TOKEN`. Export ADMIN_OPS_TOKEN to run the authenticated checks;
# without it the matrix asserts the gate instead (401).
AUTH_ARGS=()
if [ -n "${ADMIN_OPS_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${ADMIN_OPS_TOKEN}")
  MIGRATE_EXPECT=200
else
  MIGRATE_EXPECT=401
fi

check() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local method="${4:-GET}"

  local code
  if [ "$method" = "POST" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH_ARGS[@]}" -X POST -H "Content-Type: application/json" -d '{}' "$url")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH_ARGS[@]}" "$url")
  fi
  if [ "$code" = "$expected" ]; then
    echo "  ✓ $label  [$code]"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label  [got $code, expected $expected]  $url"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Even-ELO smoke matrix · $BASE_URL"
echo "─────────────────────────────────────"

# ELO.0 — public surface
check "GET /"                                 "$BASE_URL/"

# ELO.1 — admin + DB-backed routes
check "GET /admin"                            "$BASE_URL/admin"
check "GET /admin/vcs"                        "$BASE_URL/admin/vcs"
check "GET /admin/positions"                  "$BASE_URL/admin/positions"
check "GET /api/admin/migrate (state)"        "$BASE_URL/api/admin/migrate" "$MIGRATE_EXPECT"
check "GET /api/vcs"                          "$BASE_URL/api/vcs"
check "GET /api/vcs?status=all"               "$BASE_URL/api/vcs?status=all"
check "GET /api/positions"                    "$BASE_URL/api/positions"
check "GET /api/vcs/[invalid] (400)"          "$BASE_URL/api/vcs/not-a-uuid" 400

# ELO.2 — case lifecycle + position picker
check "GET /input/cases"                      "$BASE_URL/input/cases"
check "GET /input/cases/upload"               "$BASE_URL/input/cases/upload"
check "GET /admin/cases"                      "$BASE_URL/admin/cases"
check "GET /api/cases"                        "$BASE_URL/api/cases"
check "GET /api/cases?status=all"             "$BASE_URL/api/cases?status=all"
check "GET /api/cases/[invalid] (400)"        "$BASE_URL/api/cases/not-a-uuid" 400
check "POST /api/recompute/[invalid] (400)"   "$BASE_URL/api/recompute/not-a-uuid" 400 POST

# ELO.3b — engine API + batch recompute
check "POST /api/admin/recompute (no args)"   "$BASE_URL/api/admin/recompute" 400 POST
check "POST /api/admin/recompute?vc=invalid"  "$BASE_URL/api/admin/recompute?vc=not-a-uuid" 400 POST
check "POST /api/admin/recompute?all=true"    "$BASE_URL/api/admin/recompute?all=true" 200 POST

# ELO.4a — first per-team forms + observations API
check "GET /input/anesthesia"                 "$BASE_URL/input/anesthesia"
check "GET /input/ot"                         "$BASE_URL/input/ot"
check "GET /api/streams"                      "$BASE_URL/api/streams"
check "GET /api/streams?team=Anesthesia"      "$BASE_URL/api/streams?team=Anesthesia"
check "GET /api/streams?team=OT"              "$BASE_URL/api/streams?team=OT"
check "GET /api/observations (no args)"       "$BASE_URL/api/observations" 400
check "POST /api/observations (no body)"      "$BASE_URL/api/observations" 400 POST

# ELO.4b — Med Sup form
check "GET /input/ms"                         "$BASE_URL/input/ms"
check "GET /api/streams?team=MS"              "$BASE_URL/api/streams?team=MS"

# ELO.5a — single-stream forms
check "GET /input/icn"                        "$BASE_URL/input/icn"
check "GET /input/pharmacy"                   "$BASE_URL/input/pharmacy"
check "GET /input/billing"                    "$BASE_URL/input/billing"
check "GET /input/unit-head"                  "$BASE_URL/input/unit-head"
check "GET /api/streams?team=ICN"             "$BASE_URL/api/streams?team=ICN"
check "GET /api/streams?team=Pharmacy"        "$BASE_URL/api/streams?team=Pharmacy"
check "GET /api/streams?team=Billing"         "$BASE_URL/api/streams?team=Billing"
check "GET /api/streams?team=UnitHead"        "$BASE_URL/api/streams?team=UnitHead"

# ELO.5b — Customer Care form (last input form)
check "GET /input/cc"                         "$BASE_URL/input/cc"
check "GET /api/streams?team=CC"              "$BASE_URL/api/streams?team=CC"

# ELO.6a — leaderboard + per-VC stub
check "GET /api/leaderboard"                  "$BASE_URL/api/leaderboard"
check "GET /api/leaderboard?status=all"       "$BASE_URL/api/leaderboard?status=all"
check "GET /vc/[invalid] (200, page renders error)" "$BASE_URL/vc/not-a-uuid"

# ELO.6b — per-VC dashboard
check "GET /api/vcs/[invalid]/detail (400)"   "$BASE_URL/api/vcs/not-a-uuid/detail" 400
check "GET /api/vcs/[invalid]/audit (400)"    "$BASE_URL/api/vcs/not-a-uuid/audit" 400

# ELO.7 — admin polish
check "GET /admin/weights"                    "$BASE_URL/admin/weights"
check "GET /admin/streams"                    "$BASE_URL/admin/streams"
check "GET /admin/audit"                      "$BASE_URL/admin/audit"
check "GET /api/weights"                      "$BASE_URL/api/weights"
check "GET /api/audit"                        "$BASE_URL/api/audit"
check "GET /api/audit?action=recompute"       "$BASE_URL/api/audit?action=recompute"
check "POST /api/weights (no body)"           "$BASE_URL/api/weights" 400 POST
check "PATCH /api/streams/[id] (GET)"         "$BASE_URL/api/streams/pac_done" 405

echo "─────────────────────────────────────"
echo "  $PASS passed · $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
