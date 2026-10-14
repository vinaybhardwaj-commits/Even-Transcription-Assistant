#!/usr/bin/env bash
# Regression tests for the PARITY-389 post-guard harness (refuter-2 #3145; eta-refuter #3144 item 1).
# Invented text only, no network. Usage:
#   test_guard_harness.sh <app-export-dir> <MINI-STT-MANIFEST.v2.json> <GOLDEN-389.json>
# Cases: selftest | identical sides PASS(0) | dropped-set divergence FAIL(1) |
#        probe mismatch w/o controlled pair -> HARNESS ERROR(4) | mismatch w/ ctrl -> window FAIL(1).
set -u
set -o pipefail
APP=${1:?usage: test_guard_harness.sh <a92ebae export dir> <manifest> <golden>}
MANIFEST=${2:?manifest path required}
GOLDEN_REAL=${3:?real golden path required}
DIR=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d /tmp/guard-harness-test.XXXXXX)
FAIL=0

run() { # run <golden> <expect-sha-or-""> -> echoes rc
  local g=$1 sha=$2 rc=0 extra=()
  [ -n "$sha" ] && extra=(--expect-golden-sha "$sha")
  ( cd "$APP" && TSX_TSCONFIG_PATH="$APP/tsconfig.json" \
    npx --yes tsx@4.23.15 "$DIR/run_guard_harness.ts" --app-worktree "$APP" --golden "$g" \
    --manifest "$MANIFEST" --io "$T" --report "$T/report.json" "${extra[@]}" >/dev/null 2>&1 ) || rc=$?
  echo $rc
}
mkwin() { # mkwin <wid> <probe: en|kn|MISMATCH> <hf_drop_idx: -1|0|1|2> <ctrl: 0|1>
  local wid=$1 plang=$2 dropidx=$3 ctrl=$4 side d lang ptext
  for side in mini hf; do
    d="$T/$side"; mkdir -p "$d/router" "$d/whisper"
    lang=en; [ "$plang" = "MISMATCH" ] && [ "$side" = hf ] && lang=kn
    printf '{"status":"text","transcript_native":"hello there invented words","transcript_english":null,"segments":[{"start_s":0,"end_s":2,"text":"hello there","lang":"en","engine":"whisper","refused":false}]}' > "$d/router/$wid.json"
    printf '{"audio_sha256":"1111111111111111111111111111111111111111111111111111111111111111","stack_sha":"c85d1e6ec0a3ab5caa3f9f1e5abb2bf7242ea399d5819257bdd02bf80bb79bf0","eta_env_names":["ETA_DEFAULT_CANDIDATES","ETA_INDICTRANS2_URL","ETA_MAX_INFLIGHT","ETA_OPENROUTER_KEY_FILE","ETA_SRAVAANI_URL","ETA_TRANSLATE_ENGINE","ETA_TRANSLATE_FALLBACK"]}' > "$d/router/$wid.meta.json"
    ptext='{"text":"hello","language":"en","duration":2,"segments":[{"start":0,"end":2,"text":"hello there","no_speech_prob":0.1,"avg_logprob":-0.3}]}'
    [ "$lang" = kn ] && ptext='{"text":"hello","language":"kn","duration":2,"segments":[{"start":0,"end":2,"text":"hello there","no_speech_prob":0.1,"avg_logprob":-0.3}]}'
    printf '%s' "$ptext" > "$d/whisper/$wid.probe.json"
    { printf '{"text":"full","language":"en","duration":6,"segments":[{"start":0,"end":2,"text":"s0","no_speech_prob":0.1,"avg_logprob":-0.3},'
      if [ "$side" = hf ] && [ "$dropidx" = 2 ]; then printf '{"start":2,"end":4,"text":"s1","no_speech_prob":0.9,"avg_logprob":-1.4},'
      else printf '{"start":2,"end":4,"text":"s1","no_speech_prob":0.1,"avg_logprob":-0.3},'; fi
      printf '{"start":4,"end":6,"text":"s2","no_speech_prob":0.1,"avg_logprob":-0.3}]}'
    } > "$d/whisper/$wid.full.json"
    if [ "$ctrl" = 1 ]; then printf '{"text":"ctrl","language":"en","duration":6,"segments":[{"start":0,"end":2,"text":"s0","no_speech_prob":0.1,"avg_logprob":-0.3},{"start":2,"end":4,"text":"s1","no_speech_prob":0.1,"avg_logprob":-0.3},{"start":4,"end":6,"text":"s2","no_speech_prob":0.1,"avg_logprob":-0.3}]}' > "$d/whisper/$wid.full.ctrl.json"; fi
  done
  printf '{"windows":{"english":[{"window_id":"%s"}],"loop":[],"refused":[],"indic":[],"silence":[]}}' "$wid" > "$T/g.json"
}
golden_clean() { for s in mini hf; do rm -f "$T/$s/whisper/"*.json 2>/dev/null; done; }
report() { echo "TEST $1: $2"; [ "$2" = PASS ] || FAIL=1; }

# 0. selftest (real golden + real manifest, pinned sha path)
( cd "$APP" && TSX_TSCONFIG_PATH="$APP/tsconfig.json" npx --yes tsx@4.23.15 "$DIR/run_guard_harness.ts" --app-worktree "$APP" --golden "$GOLDEN_REAL" --manifest "$MANIFEST" --report "$T/r0.json" --selftest >/dev/null 2>&1 )
[ $? -eq 0 ] && report selftest PASS || report selftest FAIL

# 1. identical sides -> 0
mkwin W-IDENT en -1 0
[ "$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")" = 0 ] && report identical-sides PASS || report identical-sides FAIL

# 2. hf drops a different segment -> dropped-set mismatch -> 1
golden_clean; mkwin W-SETDIFF en 2 0
[ "$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")" = 1 ] && report dropped-set-differs PASS || report dropped-set-differs FAIL

# 3. probe mismatch, no ctrl -> 4 + named harness error
golden_clean; mkwin W-NOCTRL MISMATCH -1 0
RC=$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")
[ "$RC" = 4 ] && grep -q probe_language_mismatch_without_controlled_pair "$T/report.json" && report mismatch-no-ctrl-exit4 PASS || report mismatch-no-ctrl-exit4 "FAIL rc=$RC"

# 3b. probe mismatch, ctrl on ONE side only -> 4 (one-sided record cannot pass; eta-refuter T6)
golden_clean; mkwin W-ONESIDE MISMATCH -1 1; rm -f "$T/hf/whisper/W-ONESIDE.full.ctrl.json"
RC=$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")
[ "$RC" = 4 ] && report mismatch-ctrl-one-side-exit4 PASS || report mismatch-ctrl-one-side-exit4 "FAIL rc=$RC"

# 3c. hf string timestamps (incl. the comma form "00:00:02,000") vs numeric mini -> PASS row
golden_clean; mkwin W-STRTS en -1 0
python3 - "$T" <<'PYEOF' || { report string-timestamps "FAIL setup: mutation step errored"; }
import json, sys
p = sys.argv[1] + "/hf/whisper/W-STRTS.full.json"
d = json.load(open(p))
d["segments"][0] = {"start": "00:00:00,000", "end": "00:00:02,000", "text": "s0", "no_speech_prob": 0.1, "avg_logprob": -0.3}
d["segments"][1] = {"start": "2", "end": "4.0", "text": "s1", "no_speech_prob": 0.1, "avg_logprob": -0.3}
d["segments"][2] = {"start": "00:00:04.000", "end": "00:00:06,000", "text": "s2", "no_speech_prob": 0.1, "avg_logprob": -0.3}
json.dump(d, open(p, "w"))
PYEOF
grep -q "00:00:02,000" "$T/hf/whisper/W-STRTS.full.json" || { report string-timestamps "FAIL setup: mutation did not land"; }
grep -q "00:00:02,000" "$T/hf/whisper/W-STRTS.full.json" || { report string-timestamps "FAIL setup: mutation did not land"; }
[ "$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")" = 0 ] && report string-timestamps PASS || report string-timestamps FAIL

# 4. probe mismatch, ctrl on both sides -> window FAIL (probe rule), 1, controlled_pair.present=true
golden_clean; mkwin W-CTRL MISMATCH -1 1
RC=$(run "$T/g.json" "$(sha256sum "$T/g.json" | cut -d' ' -f1)")
[ "$RC" = 1 ] && python3 -c "import json;w=json.load(open('$T/report.json'))['windows'][0];exit(0 if w['controlled_pair']['present'] and w['pass'] is False else 1)" && report mismatch-with-ctrl PASS || report mismatch-with-ctrl "FAIL rc=$RC"

echo "OVERALL: $([ $FAIL -eq 0 ] && echo PASS || echo FAIL)"
exit $FAIL
