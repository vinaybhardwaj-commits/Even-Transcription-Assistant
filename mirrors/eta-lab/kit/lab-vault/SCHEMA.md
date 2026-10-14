# Lab vault: key layout and provenance schema (ruling 184, v1)

Everything under `eta-lab-results` is **write-once**. Nothing is ever updated in place.

## Keys (the Worker refuses anything else)

    runs/<run_id>/<room_id>/<ist_date>/<unit_id>.json            one file per window/chunk
    runs/<run_id>/<room_id>/<ist_date>/<unit_id>.attempt<N>.json a failed earlier attempt (N>=1)
    manifests/<run_id>.start.json                                written once, at run start
    manifests/<run_id>.json                                      written once, at run end (final counts)
    index/windows-<YYYYMMDD>.jsonl / .parquet                    nightly, one file per day, never rewritten

* run_id = `<producer>-<YYYYMMDDTHHMM>-<shortsha>`; producer is one of
  `hist-bulk | hist-miner | vj | production-export | stt-parity`. Backfill run_ids are
  `<producer>-backfill-20260924`.
* segments match `[A-Za-z0-9._-]+`, no `..`; `ist_date` is `YYYY-MM-DD`.
* A rerun is a NEW run_id (new directory). To "update" a manifest, write the `.json` (end) one once.
  (The order says `index/windows.jsonl`; a single mutable file cannot be write-once, so the index is
  one immutable file per day. The viewer reads the newest.)

## File body

Every transcript file and both manifests are JSON objects with these top-level keys, plus the
producer's own payload (whatever `run_window` writes today stays as it is):

    "schema": "eta-lab-result/1",
    "provenance": {
      "run_id": "hist-bulk-20260924T1912-ab12cd3",     // MUST equal the run_id in the key
      "producer": "hist-bulk",                          // MUST equal the key's producer
      "created_at": "2026-09-24T19:12:03+05:30",
      "provenance_complete": true,
      "not_run": ["diarizer"],                          // fields intentionally absent (see below)
      "stack": {
        "whisper":         {"model": "...", "flags": {"vad": false, "temperature_inc": ..., "no_speech_thold": ..., "suppress_nst": ..., "max_context": ...}},
        "indic_conformer": {"model_id": "...", "git_head": "..."},
        "sravaani":        {"version": "..."},
        "router":          {"commit": "...", "config_sha256": "..."}   // sha256 of the config file the process loaded
      },
      "guards": {
        "shim_anti_loop": "...", "english_hallucination_guard": "...",
        "transcript_guard": "...", "loop_guard_number_rule": "..."     // version string or sha
      },
      "diarizer": null,                                 // or {"name": "...", "version": "..."}
      "stack_versions_sha256": "...",                   // sha256 of the stack_versions.json you embedded
      "source_audio_keys": ["<eta-audio object key>", ...],  // the chunks actually used
      "source_chunks": [{"r2_key": "...", "started_at": "...", "ended_at": "...", "duration_ms": 0}]   // optional but wanted: lets the viewer map window time -> chunk + offset
    }

Rules the Worker enforces on every `runs/` and `manifests/` body:

1. The body is valid JSON with `schema` and `provenance` present, and `provenance.run_id` / `producer`
   equal to the ones in the key.
2. For a run_id **without** `-backfill-`: all of `created_at, stack, guards, diarizer,
   stack_versions_sha256, source_audio_keys` must be present; every leaf under `stack` and `guards` must be
   non-null unless its top-level name (`stack`, `guards`, `diarizer`) is listed in `not_run`;
   `provenance_complete` must be `true`. Otherwise the PUT is rejected 422 (nothing stored).
3. For a `-backfill-` run_id: any field may be missing; `provenance_complete` must be `false`
   unless every field above is present. The backfiller stamps it.
4. `index/` bodies are not validated beyond size.

Ruling 196 (whisper temperature fallback is active): every run records `provenance.temperature_fallback = "on"`
(hist-miner writes it at the top of `provenance`; hist-bulk writes it there and as `stack.whisper.flags.temperature_fallback`).
The Worker accepts unknown extra keys in `provenance`, so both placements pass today; it becomes REQUIRED for new runs once both
producers confirm they write it. Runs started before 19:04 IST on 24 Sep (hist-bulk-20260924T1846-29412b2, hist-miner-20260924T1845/1856)
and the backfills do not carry it.

Manifest extra keys (suggested, not enforced): `counts {planned, ok, failed}`, `queue {tier, window_list_sha256}`,
`stop_rules`, `ended_at`.

## Uploader call syntax

    python3 kit/vault-push.py --path <file-or-dir> [--path ...]   # push these now (call at end of each unit)
    python3 kit/vault-push.py --scan                              # catch-up: every configured root (the 15-min timer)
    python3 kit/vault-push.py --status                            # ledger vs pending, no network

The key is derived from the path under the root: `~/eta-data/hist/runs/<run_id>/...` maps to
`runs/<run_id>/...` as-is, so producers should write in that layout. Exit 0 = every named file is in
the vault (2xx) or already identical; non-zero = something is still pending (the timer retries).
