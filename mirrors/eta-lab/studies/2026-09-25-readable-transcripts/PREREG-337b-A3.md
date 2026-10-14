# READABLE TRANSCRIPTS 337b: addendum A3 (linker, 25 Sep 2026; the git commit time is the timestamp): the vault's `sources` rule (ruling 341, lab-viewer #2007); frozen BEFORE the code change and before any real call

Addendum to `PREREG-337b.md` (e3f921b), A1 (20dec29) and A2 (3c70a84). Reason: lab-viewer's live grammar (ingest 3fd98452, `kit/lab-vault/SCHEMA.md` "Annotations") requires that every annotation file carry `sources`, the sha256 of each run record it points at, and the Worker answers 422 otherwise. **Only the file body's binding field, the split rule and where a file is filed change; scope, route, items, resume and checks stand.**

## A3.1 Changes to A1.1
- **`records` is replaced by `sources`:** `{ "<k>": "<sha256, 64 lower-case hex, of the run record runs/<k>.json>" }` for EVERY distinct `k` in the file's items (the same value as before: the sha256 of the record file the script read and resolved). The per-item `src_sha256` (the exact native segment text) stays as an extra field, which the Worker accepts.
- **Filing comes from `k`:** the file's room and date are the second and third parts of `k` (`<run_id>/<room>/<date>/<window>`), because the Worker requires `k` to be in the same room and IST date as the file's key. The index's `room_id` and `ist_date` are still what decides whether a window is in scope (a window without a `room_id` is skipped and counted); if they ever differ from `k`'s parts, `k` decides the file path and the window is counted in `k_mismatch`.
- **At most 400 distinct `k` per file:** a room-day group with more is split into files of at most 400 windows each (the minute in the name is bumped as for any second file of the same group).
- Item fields for a translation stay `{k, i, en}` or `{k, i, err}` plus `q`, `src_sha256` (SCHEMA.md: `q` optional, extra fields accepted).
- The uploader carries the files; the Worker checks that `runs/<k>.json` is already in the vault with the same sha. A file the Worker rejects is a fact about the upload, not about this script; failures are reported from the uploader's log and re-uploaded, never edited.

## A3.2 Checks
Tests on invented data for: `sources` present and equal to the sha256 of every distinct `k`'s record; no `records` key; a group of more than 400 windows is split into files of at most 400 with every window in exactly one file; the file path follows `k`; `k_mismatch` is counted. Mutants with a control run. eta-refuter-2's PASS on the new commit before the first real call (the run is held by the permission layer in any case; see the bus).
