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

## Annotations (rulings 341, 342): additive overlays on the immutable records

    annotations/<kind>/<room_id>/<ist_date>/<YYYYMMDDHHMM>-<producer>.json     kind = translation | readability | retranscription | correction | selftest | speaker

One key kind for every overlay; there is no separate `corrections/`. Write-once (a change is a NEW file with a later stamp; for the same
`(k, i)` the later stamp wins). `<producer>` is `[a-z][a-z0-9-]{1,39}` and must equal `provenance.producer` in the body.

    { "schema": "eta-lab-annotation/1", "kind": "<same as the key>",
      "provenance": { "producer": "<same as the key>", "created_at": "<ISO>", ... },
      "sources": { "<k>": "<sha256 (64 lower-case hex) of the run record runs/<k>.json>" },     # EVERY distinct k below
      "items": [ { "k": "<run_id>/<room_id>/<ist_date>/<window>", "i": <segment index>, ... } ] }

* **Bound to the source record sha.** `k` is the run key without the `runs/` prefix and `.json`, in the SAME room and IST date as the file's
  key. `sources` must name the sha256 of each such record; the Worker heads `runs/<k>.json` and answers 422 if it is missing or the sha differs
  (so an annotation can never point at a record that is not in the vault, or at a different version of it). At most 400 distinct `k` per
  file (split by room/day already keeps files under this); at most 500,000 items.
* translation items: `{k, i, en}` or `{k, i, err}` (+ optional `q` = quality flag); readability: `{k, i, ok, score, why, collapse}`;
  retranscription: `{k, i, text2, engine2, lang2, better}`.
* **kind=correction** (window level): `{k, status, reason?}` with `status` in `near_silence | undetermined | transcribed_unconfirmed`,
  `i` optional. It corrects a NO_SIGNAL (exact-zero) mark: the window is then indexed and shown as "not transcribed / not confirmed silent",
  never as "no sound". A correction file overrides the addendum carriers of the same fact; a later correction file overrides an earlier one.
  The two spent addendum carriers (`near_silence_full_chunk_window_ids`, `short_chunk_off_band_window_ids`,
  `transcribed_unconfirmed_window_ids`) are frozen: their contents are re-issued as correction files and the carriers are superseded.
* **kind=speaker** (r375, diar-lab's 337e labels): `{k, i, speaker, conf?, seq?, mixed?, speech_s?}`; `speaker` is `A`..`Z`, `S<n>` or `?` (= unlabeled,
  under 1.0 s of diarized speech; then no conf/seq/mixed); `conf` = purity 0..1; `mixed` boolean; `seq` = the speaker letters in time order inside the
  segment, 1..6, only when `mixed` is true; `speech_s` >= 0. Nothing else, no text. **Letters are window-local**: `A` in one window is not `A` in
  another, so no consumer may join letters across windows. Bound to the run record sha through `sources` like every k-based kind.
* **kind=selftest** (r375; r369 item 4, the mic self-test spans that must never reach a patient record): `{run_id, t0, t1, note?}` with `t0`/`t1` ISO
  times WITH an offset, `t0 < t1`, at most one hour apart, `t0`'s IST date equal to the key's date. Not tied to a run record (an interval is in tape
  time), so there is no `k`/`sources`; the binding is a top-level `source_sha256` = sha256 of the self-test run log the intervals come from. That log is NOT in
  the vault, so the Worker checks only the FORMAT of the hash: it is a claim, not a verified binding (unlike `sources`). Never
  holds the canary text. Consumers must drop any segment overlapping an interval (plus their named margin) and fail closed.
* Producers: `python3 kit/lab-vault/tools/make_annotation.py --help` builds the file (computes `sources` from the local run files) and
  writes it into `~/eta-data/lab-vault/staged/annotations/...`; the uploader carries it (HOLD-annotations gate applies).

## Tapes (r373): a second, durable copy of the room tape chunks

    tapes/<room_id>/<ist_date>/<name>.webm | .opus     audio/webm (or audio/ogg, audio/opus for .opus); at most 32 MB

Patient audio. Write-once like the JSON kinds (same bytes = 200, different bytes = 409). The client sends `x-content-sha256` (64 hex) and the Worker must
reproduce it from the body (422 otherwise); the body must start with a WebM/EBML header (`.webm`) or an Ogg/WebM header (`.opus`). The viewer has no route
for this prefix. The originals stay in eta-audio; there is no bucket lock rule on `tapes/` (an indefinite lock on patient audio is a policy call for Fable).

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
   `provenance_complete` must be `true`, or `false` WITH a non-empty string `provenance.incomplete_reason` (e.g. a live
   stack-drift cross-check): the file is then saved and shown as "partial provenance" instead of being left unsaved.
   Required fields are enforced either way. Otherwise the PUT is rejected 422 (nothing stored).
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
