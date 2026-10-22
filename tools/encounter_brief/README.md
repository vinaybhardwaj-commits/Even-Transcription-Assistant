# encounter_brief: `role_votes.v1` (phase 0a)

Record-only stored layer for the Encounter Brief (spec v2 §5.3, §5.6, §6.3, with the 17 Oct OQ rulings).
`role_votes.py` ports the off-repo arm (c) and role-vote code (newcat `merge_c.py` / `merge_b.py`) and writes one
`role_votes.v1.json` (mode 0600) per consult, beside the palimpsest bundle's `manifest.json`
(fallback `~/eta-data/role-votes/<relative path>`). Nothing is posted, committed or sent: no HTTP or DB client is
imported and `POSTING_ENABLED` is False and asserted.

Per bundle `diar_nemotron` label it records voter 1 (role track), Jev (recorded doctor-cue probabilities), Clef-omni
(`doctor` on the doctor_slot only, M3), the voiceprint (cos to the logged-in doctor's enrolled centroid,
`margin_next_label`, `margin_runner_up_centroid`), arm (c) under both margins (OQ-4), `armc_old` (merge_c's one
margin, for reproduction), the independent `voiceprint_match_label` (N1), the mapping status (OQ-3) and the §6.3
order-capable labels.

```
# build (recomputes ECAPA vectors on the box; needs torch + speechbrain, weights from the local cache only)
HF_HUB_OFFLINE=1 ~/.venvs/spkmerge/bin/python role_votes.py run --consults <consult-set.json> \
    --clef-votes <clef-votes.jsonl> --jev-slot-votes <jev-slot-votes.jsonl>
# score the written layers (counts only)
python3 role_votes.py repro --consults <consult-set.json>
# synthetic false-doctor gate (merge_c prereg vectors)
python3 role_votes.py prereg --vecs-glob '<merge/c>/*/vecs.json'
# tests (numpy + pytest only)
python3 -m pytest -q tests
```

Thresholds are the preregistered production values (cos 0.65, margin 0.05) and are not tuned here.
Consult uids and per-consult rows never leave the box.
