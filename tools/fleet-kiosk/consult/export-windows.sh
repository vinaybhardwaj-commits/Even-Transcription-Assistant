#!/bin/zsh
# Daily: export eta_encounter_windows since 2 Oct to the lab box for CONSULT voiceprint work. Read-only DB query.
set -euo pipefail
D=$(TZ=Asia/Kolkata date +%Y%m%d)
T=$(mktemp)
/opt/homebrew/bin/psql "$(cat ~/.claude/secrets/eta_database_url)" -At -c "copy (select row_to_json(w) from (select consult_uid, machine, room_slug, consulting_doctor_uid, consulting_doctor_name, extract(epoch from t_open) t_open, extract(epoch from t_close) t_close, close_reason, quality from eta_encounter_windows where t_open >= '2026-10-01T18:30Z' order by t_open) w) to stdout" > "$T"
N=$(wc -l < "$T" | tr -d ' ')
scp -q "$T" mini:/tmp/ew-$D.jsonl
ssh mini "scp -q /tmp/ew-$D.jsonl 'eta@164.52.211.13:eta-data/consult/encounter-windows-to-$D.jsonl' && rm -f /tmp/ew-$D.jsonl && ssh eta@164.52.211.13 'chmod 600 ~/eta-data/consult/*.jsonl'"
rm -f "$T"
echo "$(date) exported $N rows as encounter-windows-to-$D.jsonl" >> ~/eta-deploy/consult/export.log
