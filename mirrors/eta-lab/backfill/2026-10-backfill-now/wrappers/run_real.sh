#!/bin/bash
# tone's real-patient-data entrypoint (Fable 13:00 permission: `bash /home/eta/oc/tone/run_real.sh`, no other args -
# rewritten in place per real run, not parameterised, so the allowed command stays exactly this string).
# Every call here sends real patient audio/text to an external ZDR vendor (OpenRouter/Gemini here), covered by
# /home/eta/oc/RULINGS-2026-09-27.md (12:55 V ruling: OpenRouter/Gemini ZDR, no de-id needed).
#
# STATUS 27 Sep ~13:25: W45.3 pilot on 24 Sep (Fable 13:22: option b - 24 Sep now via room_diarize_window's
# 289 diarize-ok windows, switch to 26 Sep once hist-bulk reaches it).
# Pilot window: bw_ayd5y9w5_1790228700000_primary (126 role-attributed speaker turns of 371 raw micro-segments,
# the most role-attributed 24 Sep window checked). Pipeline: extract_turns.py (R2 read-only, boto3 venv, deletes
# the window clip immediately after cutting per-turn wavs) -> turn_translate.py turns (Gemini 3.8 Flash ZDR route,
# per-turn English) -> results land under ~/eta-data/tone/sentiment-pilot/, never in git, never on the bus.
set -euo pipefail
STUDY=/tmp/wt-tone-emotion/studies/2026-09-27-tone-sentiment
WINDOW=bw_ayd5y9w5_1790228700000_primary
OUT=/home/eta/eta-data/tone/sentiment-pilot/24sep/$WINDOW
mkdir -p -m 700 "$OUT/turns"

echo "[run_real] extracting turns for $WINDOW (R2 read-only, deletes window clip after)" >&2
~/.venv-r2/bin/python3 "$STUDY/extract_turns.py" --window "$WINDOW" --out "$OUT/turns"

echo "[run_real] translating turns via Gemini 3.8 Flash ZDR route" >&2
python3 "$STUDY/turn_translate.py" turns --manifest "$OUT/turns/manifest.jsonl" --out "$OUT/translated"

echo "[run_real] done: $OUT" >&2
