"""Local half of the two-phase scored write (ADDENDUM-20/21): the HF Job computes and validates track JSON into
a scratch/bucket-backed root (same shape `write_track` produces, via `build_track` - see hf-jobs/run_*_scored.py),
and THIS script - run locally, where the real REB store's live manifests are actually visible - reads each track
file back and calls `write_track()` for real against the production root.

Why two phases, not one write_track() call inside the ephemeral container: the container can't see
`/home/eta/eta-data/reb`'s live manifest.json (it isn't an HF resource that can be bucket-mounted), so it has no
way to safely read-modify-write the REAL manifest. `write_track()` only needs `manifest_stub` the FIRST time a
window is written - reb's `suite-clinical1` windows already have one (dev-ingest wrote it), so calling
`write_track()` here with `manifest_stub=None` correctly appends under the existing lock (kit/reb/writer.py,
confirmed by reading it - ADDENDUM-20).

This always calls write_track() with manifest_stub=None - correct for suite-clinical1's windows (dev-ingest
already seeded every manifest) AND for set (c)'s windows, but ONLY once run_setc_baselines.py has already run
for that window (it's the one that creates set (c)'s manifest.json via its own manifest_stub, since it runs
before any candidate commit - refuter-3 #5289 S2). `_assert_all_manifests_exist()` below refuses the WHOLE
commit up front if any downloaded track's window has no manifest.json yet, rather than let write_track() raise
ValueError mid-batch (uncaught here) and crash partway through.

refuter-3 review (#5145) fixes, both applied:
K1 - this writes into PRODUCTION REB, so every track is validated BEFORE write_track is even called: engine must
     be one of the 2 W50 candidates actually being scored, layer must be "terms", and config_hash must equal both
     sha256(config) (internal consistency) AND the CURRENTLY pinned hash for that engine (pinned_configs.py) - a
     stale smoke file, a parakeet-med file, or a drifted/superseded config hash in the synced bucket is refused
     loudly (a `rejected` entry with a reason), never silently written.
K2 - TrackExistsError is no longer treated as automatically fine. On a collision: (a) the window's manifest must
     actually list an entry for this exact (layer, engine, version, config_hash) - if it doesn't, the track file is
     an orphan (writer.py's B1 class: a file with no manifest entry) and this is reported as a `conflict`, not
     silently skipped; (b) the manifest entry's recorded sha256 must match this track's own re-serialization
     (byte-identical to how writer.py hashes it) - a mismatch means non-determinism or something wrote a different
     body under the same hash, also reported as a `conflict`, never counted as already_present.
Notes also applied: each job's resolved-dependency-versions record (written by the scored launcher next to its
tracks) is copied into a durable local location; MirrorPendingError (R2 mirror off by default, but the code must
not crash the whole batch if it's ever on and one mirror call fails) is caught and reported, not left to propagate.

refuter-2 review (#5146) fixes, both applied:
K1 (refuter-2's own, distinct ask from refuter-3's) - the pin check now calls `pinned_configs.assert_pinned()`
    itself (the same function every engine's own write path uses, via build_track/run_engine_for_track) rather
    than reimplementing the comparison, so this and the engine code can never quietly drift apart. Per-engine and
    per-status counts are now printed in the summary.
K2 - WRONG when first written, corrected below (see the ADDENDUM-9 pin section): this used to claim the branch's
     kit/reb (commit `18c52b9f`) WAS the correct pin, dismissing `main@1ee3b4a4` as unrelated. That was wrong - I
     checked what my branch's vendored copy matched, but never checked it against the actual pre-registered
     commitment. Both checkers caught it (#5152/#5155/#5157/#5158).
K3 - already satisfied: both scored launchers already print `claimed {len(windows)} windows` at job start.

ADDENDUM-9 pin, enforced here (refuter-2/refuter-3, #5152-#5160): ADDENDUM-9 (witnessed) pre-registered `kit/reb`
at `main@1ee3b4a4` for BOTH STEP 2 writing and STEP 3 reading - `18c52b9f` (this branch's vendored copy) is an
older ancestor of it, missing `source_kind` on index.jsonl lines and `tracks()`'s config_hash-based grouping
(which the per-comparison exclusion rule in the entry rule depends on for STEP 3). The HF Job's own scratch
`write_track()` call is unaffected in practice (its output is discarded down to just the track JSON body, which
this script re-validates independently - refuter-2 #5160's harm analysis), but THIS script - the one that commits
into the real production store - must run with `kit/reb` verified to match `1ee3b4a4` exactly. `verify_kit_reb_pin()`
below checks this by CONTENT (via `git show`), not by trusting whatever commit label a `KIT_ROOT` claims to be at,
and refuses to run at all if it doesn't match.
"""
import argparse
import json
import os
import subprocess
import sys

KIT_ROOT = os.environ.get("KIT_ROOT", os.path.join(os.path.dirname(__file__), "..", "..", "kit"))
sys.path.insert(0, KIT_ROOT)

from reb import write_track, TrackExistsError, MirrorPendingError  # noqa: E402
from pinned_configs import PinnedConfigMismatch, assert_pinned, config_hash as recompute_config_hash  # noqa: E402

SCORABLE_ENGINES = {"medasr", "whisper-med-merged"}  # the 2 surviving W50 candidates - never baselines/parakeet
EXPECTED_LAYER = "terms"
PINNED_REB_COMMIT = "1ee3b4a4"  # ADDENDUM-9 (witnessed): kit/reb for BOTH STEP 2 writing and STEP 3 reading


def verify_kit_reb_pin(kit_root, repo_dir=None, pinned_commit=PINNED_REB_COMMIT, subpath="reb"):
    """Asserts kit_root/<subpath>'s content is byte-identical to `pinned_commit`'s kit/<subpath>/, file by file,
    via `git show` against repo_dir (defaults to this file's own repo checkout - git worktrees share one object
    database, so this works from ANY worktree/clone of eta-lab, not just the one that happens to have that commit
    checked out). Compares CONTENT, not a commit label some KIT_ROOT claims to be at - a mislabeled or stale
    bucket snapshot is caught the same as an honestly different one. Checks BOTH directions (refuter-3 #5168
    nit): every pinned file must be present and byte-identical, AND kit_root/<subpath> must have no extra .py
    file the pinned commit doesn't (an extra file could carry a real behavioral change nothing else here would
    catch) - `__pycache__` is ignored (a build artifact, not a code difference). Raises RuntimeError (never
    silently proceeds) if anything doesn't match; -> pinned_commit on success.

    `subpath` (refuter-2 #5277 G2, generalizing this function rather than duplicating it): defaults to "reb" for
    this module's own ADDENDUM-9 use; run_setc_baselines.py reuses this SAME function with
    subpath="reb_runner/engines" to verify kit/reb_runner's engine code against its own pinned commit (a5def748),
    by the identical content-check logic, not a hand-rolled duplicate."""
    repo_dir = repo_dir or os.path.dirname(os.path.abspath(__file__))
    git_subpath = f"kit/{subpath}"
    listing = subprocess.run(
        ["git", "-C", repo_dir, "ls-tree", "-r", "--full-tree", "--name-only", pinned_commit, "--", git_subpath],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    if not listing:
        raise RuntimeError(f"git ls-tree found no {git_subpath} files at {pinned_commit} in {repo_dir} - can't verify")
    expected_rel_paths = {repo_path[len(git_subpath) + 1:] for repo_path in listing}
    mismatches = []
    for repo_path in listing:
        rel = repo_path[len(git_subpath) + 1:]
        expected = subprocess.run(
            ["git", "-C", repo_dir, "show", f"{pinned_commit}:{repo_path}"],
            check=True, capture_output=True,
        ).stdout
        actual_path = os.path.join(kit_root, subpath, rel)
        try:
            with open(actual_path, "rb") as f:
                actual = f.read()
        except FileNotFoundError:
            mismatches.append(f"{rel}: missing at {actual_path}")
            continue
        if actual != expected:
            mismatches.append(rel)
    subpath_dir = os.path.join(kit_root, subpath)
    for dirpath, dirnames, filenames in os.walk(subpath_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for name in filenames:
            if name.endswith(".pyc"):
                continue
            actual_rel = os.path.relpath(os.path.join(dirpath, name), subpath_dir)
            if actual_rel not in expected_rel_paths:
                mismatches.append(f"{actual_rel}: EXTRA file not present at {pinned_commit}")
    if mismatches:
        raise RuntimeError(
            f"kit/{subpath} at {kit_root!r} does NOT match the pinned commit {pinned_commit!r} "
            f"(mismatched/missing/extra: {mismatches}) - refusing to run. Point KIT_ROOT at a tree whose "
            f"kit/{subpath} matches {pinned_commit} exactly."
        )
    return pinned_commit


def iter_downloaded_tracks(download_root):
    """download_root: the local sync target of the job's output bucket, e.g.
    <download_root>/<out_prefix>/<ist_date>/<room_id>/<window_id>/tracks/<layer>.<engine>__<version>__<hash>.json
    Yields (track_path, track_dict, ist_date, room_id, window_id) for every track file found, in sorted (window_id,
    filename) order - deterministic, so a partial/interrupted commit run resumes in the same order."""
    for dirpath, _dirnames, filenames in sorted(os.walk(download_root)):
        track_names = sorted(f for f in filenames if f.endswith(".json") and "__" in f)
        if not track_names:
            continue
        # dirpath ends .../<ist_date>/<room_id>/<window_id>/tracks
        window_id = os.path.basename(os.path.dirname(dirpath))
        room_id = os.path.basename(os.path.dirname(os.path.dirname(dirpath)))
        ist_date = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(dirpath))))
        for name in track_names:
            track_path = os.path.join(dirpath, name)
            with open(track_path) as f:
                track = json.load(f)
            yield track_path, track, ist_date, room_id, window_id


def _track_body_sha256(track):
    """Byte-identical to kit/reb/writer.py's own serialization (json.dumps(..., ensure_ascii=False, indent=1,
    sort_keys=True)) - the ONLY way a hash comparison against writer.py's committed sha256 is meaningful."""
    import hashlib
    body = json.dumps(track, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def validate_scored_track(track, track_path):
    """K1 (refuter-3 #5145, refuter-2 #5146): raises ValueError with a clear reason if this track must not be
    committed to production - never silently coerced or dropped without a reason. The pin check itself calls
    pinned_configs.assert_pinned() - the same function every engine's own write path uses - rather than
    reimplementing the comparison (refuter-2's ask), so this can never quietly drift from the engine code's own
    guard."""
    engine = track.get("engine")
    if engine not in SCORABLE_ENGINES:
        raise ValueError(f"engine {engine!r} is not one of the scored candidates {sorted(SCORABLE_ENGINES)} - "
                          f"refusing to write ({track_path})")
    layer = track.get("layer")
    if layer != EXPECTED_LAYER:
        raise ValueError(f"layer {layer!r} != {EXPECTED_LAYER!r} - refusing to write ({track_path})")
    config = track.get("config") or {}
    actual_hash = recompute_config_hash(config)
    if track.get("config_hash") != actual_hash:
        raise ValueError(f"track['config_hash']={track.get('config_hash')!r} != sha256(config)[:8]={actual_hash!r} "
                          f"- internally inconsistent, refusing to write ({track_path})")
    try:
        assert_pinned(engine, config)
    except PinnedConfigMismatch as e:
        raise ValueError(f"{engine}: {e} - refusing to write ({track_path})") from e


def _assert_all_manifests_exist(download_root, reb_root):
    """refuter-3 #5289 S2: write_track() below is always called with manifest_stub=None, correct for set (b)
    (dev-ingest already seeded every suite-clinical1 manifest) but NOT for set (c), whose manifest.json is
    created by run_setc_baselines.py's own manifest_stub - which must finish running BEFORE this commit step.
    A missing manifest.json would make write_track() raise ValueError, which nothing in commit_all() catches
    around write_track - crashing the whole batch instead of failing closed up front. Checked for every
    downloaded track BEFORE any of them are written, all-or-nothing (never a partial set (c) commit)."""
    missing = sorted({
        f"{ist_date}/{room_id}/{window_id}"
        for _track_path, _track, ist_date, room_id, window_id in iter_downloaded_tracks(download_root)
        if not os.path.exists(os.path.join(reb_root, ist_date, room_id, window_id, "manifest.json"))
    })
    if missing:
        # ValueError, matching write_track()'s own exception class for this exact condition (missing manifest,
        # no manifest_stub) - the pre-existing test_missing_manifest_raises_not_silently_skipped contract.
        raise ValueError(
            f"{len(missing)} window(s) have no manifest.json in {reb_root} yet - refusing to commit ANY track "
            f"from {download_root}. For set (c), run_setc_baselines.py must finish first (it creates each "
            f"window's manifest via its manifest_stub). Missing (up to 20 shown): "
            f"{missing[:20]}{'...' if len(missing) > 20 else ''}"
        )


def _existing_manifest_entry(reb_root, ist_date, room_id, window_id, track):
    """-> the matching entry in the window's manifest["tracks"] (by layer/engine/version/config_hash), or None."""
    manifest_path = os.path.join(reb_root, ist_date, room_id, window_id, "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    for entry in manifest.get("tracks", []):
        if (entry.get("layer"), entry.get("engine"), entry.get("version"), entry.get("config_hash")) == (
            track["layer"], track["engine"], track["version"], track["config_hash"],
        ):
            return entry
    return None


def commit_all(download_root, reb_root):
    """-> dict with committed / already_present / rejected / conflicts / mirror_pending lists, plus
    by_engine_status: {engine: {status: count}} across every track this run looked at (refuter-2 #5146's ask for
    per-engine/per-status counts). Only `committed` and genuine `already_present` are "fine"; `rejected` (K1) and
    `conflicts` (K2) are real problems that must be surfaced to a human, never silently absorbed."""
    _assert_all_manifests_exist(download_root, reb_root)
    committed, already_present, rejected, conflicts, mirror_pending = [], [], [], [], []
    by_engine_status = {}

    def _tally(engine, outcome):
        by_engine_status.setdefault(engine or "unknown", {}).setdefault(outcome, 0)
        by_engine_status[engine or "unknown"][outcome] += 1

    for track_path, track, ist_date, room_id, window_id in iter_downloaded_tracks(download_root):
        engine = track.get("engine")
        try:
            validate_scored_track(track, track_path)
        except ValueError as e:
            rejected.append({"track_path": track_path, "window_id": window_id, "reason": str(e)})
            print(f"[commit] REJECTED {track_path}: {e}", flush=True)
            _tally(engine, "rejected")
            continue

        try:
            written_path = write_track(reb_root, ist_date, room_id, window_id, track)
        except TrackExistsError:
            entry = _existing_manifest_entry(reb_root, ist_date, room_id, window_id, track)
            if entry is None:
                conflicts.append({"window_id": window_id, "engine": engine,
                                   "kind": "orphan_track_file_no_manifest_entry"})
                print(f"[commit] CONFLICT (orphan): {ist_date}/{room_id}/{window_id} engine={engine} "
                      f"- a track file exists but the manifest has no matching entry", flush=True)
                _tally(engine, "conflict")
                continue
            incoming_sha = _track_body_sha256(track)
            if entry.get("sha256") != incoming_sha:
                conflicts.append({"window_id": window_id, "engine": engine,
                                   "kind": "sha256_mismatch", "committed_sha256": entry.get("sha256"),
                                   "incoming_sha256": incoming_sha})
                print(f"[commit] CONFLICT (sha256 mismatch): {ist_date}/{room_id}/{window_id} "
                      f"engine={engine} committed={entry.get('sha256')} incoming={incoming_sha}",
                      flush=True)
                _tally(engine, "conflict")
                continue
            already_present.append((window_id, engine, track.get("config_hash")))
            _tally(engine, "already_present")
            continue
        except MirrorPendingError as e:
            # local write IS durable and correct (see MirrorPendingError's own docstring) - only the R2 mirror
            # (off by default; REB_R2_MIRROR) failed. Report it, don't crash the rest of the batch over it.
            mirror_pending.append({"window_id": window_id, "engine": engine, "error": str(e)})
            print(f"[commit] MIRROR PENDING (local write OK): {window_id} engine={engine}: {e}", flush=True)
            committed.append(None)  # counted as committed (it is), just without a returned path
            _tally(engine, "committed_mirror_pending")
            continue
        committed.append(written_path)
        print(f"[commit] {ist_date}/{room_id}/{window_id}: wrote {written_path}", flush=True)
        _tally(engine, f"committed_status={track.get('status')}")
    return {
        "committed": committed, "already_present": already_present,
        "rejected": rejected, "conflicts": conflicts, "mirror_pending": mirror_pending,
        "by_engine_status": by_engine_status,
    }


def commit_run_manifests(download_root, runs_dir, committed_kit_reb_commit=None):
    """Copies each job's `_runs/<machine>.json` record (written by the scored launcher: dep versions, job id,
    engine, model dtype where applicable) into a durable local location, so which exact dependency versions
    produced a given scored track is on record after the HF Job's own logs eventually age out.

    `committed_kit_reb_commit`: when given (the value verify_kit_reb_pin() just confirmed), it's added to the
    copied record as `committed_kit_reb_commit` - the job's own `reb_lib_commit` field only describes what its
    ephemeral SCRATCH write_track() call used (harmless per ADDENDUM-9's harm analysis, #5153/#5160); this field
    is the separate, distinct fact of what actually ran for the real production write, verified not assumed."""
    os.makedirs(runs_dir, exist_ok=True)
    copied = []
    for dirpath, dirnames, filenames in os.walk(download_root):
        if os.path.basename(dirpath) != "_runs":
            continue
        for name in filenames:
            if not name.endswith(".json"):
                continue
            src = os.path.join(dirpath, name)
            with open(src) as f:
                record = json.load(f)
            if committed_kit_reb_commit is not None:
                record["committed_kit_reb_commit"] = committed_kit_reb_commit
            job_id = record.get("job_id") or os.path.splitext(name)[0]
            engine = record.get("engine", "unknown-engine")
            dst = os.path.join(runs_dir, f"{job_id}-{engine}.json")
            with open(dst, "w") as f:
                json.dump(record, f, indent=2, sort_keys=True)
            copied.append(dst)
            print(f"[commit] run manifest: {src} -> {dst}", flush=True)
    return copied


PRODUCTION_REB_ROOT = os.path.expanduser("~/eta-data/reb")


def refuse_skip_verify_against_production(reb_root, skip_flag, production_reb_root=PRODUCTION_REB_ROOT):
    """refuter-2 #5167 / refuter-3 #5173: --skip-kit-reb-verify must not be usable against production - a
    forgotten flag left over from local testing must never silently bypass the ADDENDUM-9 pin on a real commit.
    Raises SystemExit if `skip_flag` is set and `reb_root` resolves (realpath) to the production REB store."""
    if not skip_flag:
        return
    real_reb_root = os.path.realpath(reb_root)
    real_production_root = os.path.realpath(production_reb_root)
    if real_reb_root == real_production_root:
        raise SystemExit(
            f"--skip-kit-reb-verify is refused: --reb-root resolves to the real production REB store "
            f"({real_production_root}). This flag exists for isolated-root testing only, never a real commit."
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("download_root", help="local sync target of the job's output bucket")
    ap.add_argument("--reb-root", required=True, help="the REAL REB root to commit into "
                     "(e.g. /home/eta/eta-data/reb) - required, no default, so this never runs against "
                     "production by accident")
    ap.add_argument("--runs-dir", default=os.path.expanduser("~/eta-data/terms/runs"),
                     help="durable local location for each job's resolved-dependency-versions record")
    ap.add_argument("--skip-kit-reb-verify", action="store_true",
                     help="DANGEROUS, tests/debugging only: skip the ADDENDUM-9 kit/reb pin check. Refused "
                          "outright when --reb-root resolves to the real production REB store.")
    args = ap.parse_args()

    refuse_skip_verify_against_production(args.reb_root, args.skip_kit_reb_verify)

    verified_commit = None
    if not args.skip_kit_reb_verify:
        verified_commit = verify_kit_reb_pin(KIT_ROOT)
        print(f"[commit] kit/reb VERIFIED against ADDENDUM-9's pinned commit {verified_commit} (KIT_ROOT={KIT_ROOT})",
              flush=True)

    result = commit_all(args.download_root, args.reb_root)
    commit_run_manifests(args.download_root, args.runs_dir, committed_kit_reb_commit=verified_commit)

    print(f"[commit] === SUMMARY === committed={len(result['committed'])} "
          f"already_present={len(result['already_present'])} rejected={len(result['rejected'])} "
          f"conflicts={len(result['conflicts'])} mirror_pending={len(result['mirror_pending'])}", flush=True)
    for engine, counts in sorted(result["by_engine_status"].items()):
        print(f"[commit]   {engine}: {json.dumps(counts, sort_keys=True)}", flush=True)
    for window_id, engine, cfg_hash in result["already_present"]:
        print(f"[commit]   already present, skipped: {window_id} engine={engine} config_hash={cfg_hash}", flush=True)
    if result["rejected"] or result["conflicts"]:
        print("[commit] *** REJECTIONS/CONFLICTS NEED HUMAN REVIEW - see lines above ***", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
