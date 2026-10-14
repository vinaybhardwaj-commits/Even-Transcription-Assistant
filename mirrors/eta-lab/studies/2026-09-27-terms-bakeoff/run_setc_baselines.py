"""W50 set (c): whisper-auto/whisper-cap2/sravaani-chunked baselines, run BOX-LOCAL (not HF Jobs) against the
already-staged set (c) audio (~/eta-data/terms/setc-stage/audio/<consult_id>.wav), writing directly against the
real production REB store in ONE step (no scratch/commit split needed - this script runs on the same box, so the
real manifest is already locally visible, unlike an ephemeral HF Job container).

Per Fable's ruling and RUNNER_LABELS (pinned_configs.py): whisper-auto/whisper-cap2 use kit/reb_runner at
main@1ee3b4a4 (same commit ADDENDUM-9 pins for kit/reb itself), sravaani-chunked uses main@a5def748 (the reviewed
chunked box_twin fix, PASSed at bus #4929/#4931/#4935). kit/reb/writer.py itself is BYTE-IDENTICAL between these
two commits (verified: `git diff 1ee3b4a4 a5def748 -- kit/reb` is empty) - a5def748 works as KIT_ROOT for both
engines' reb_runner code AND satisfies ADDENDUM-9's kit/reb pin.

B1-B4 (refuter-2 #5273, refuter-3 #5274) fixed, then G1-G4/R1-R3 (refuter-2 #5277, refuter-3 #5278) fixed:
B1/unchanged: verify_kit_reb_pin() before any write; assert_pinned() on each engine's actual live-built config.
B2/unchanged: service identity checked before the run and re-checked after EVERY consult.
B3/unchanged: writes a visible status="failed" track on any engine exception (does not reuse dev_ingest's own
    run_dev_ingest.py driver, which discloses a known silently-absent-failure bug in its own docstring).
B4/unchanged: writes a run record to ~/eta-data/terms/runs/.
G1/R1 (required): _write_ok_or_empty/_write_failed no longer treat TrackExistsError as automatically "already
    present" (the K2 class, #5145/#5147, that refuter-3's original B3 note didn't cover for THIS script). On a
    collision: the manifest must list a matching entry (else "orphan" conflict) and its recorded sha256 must
    match this track's own re-serialization (else "sha_mismatch" conflict) - reusing commit_scored_tracks.py's
    own _existing_manifest_entry/_track_body_sha256 rather than a hand-rolled duplicate. Exits 1 on any conflict.
    --reb-root is now a required CLI argument (no default), matching commit_scored_tracks.py's own pattern.
G2: the run record's reb_runner_commit was a hard-coded "a5def748" string - now MEASURED via
    verify_kit_reb_pin(..., subpath="reb_runner/engines") (that function generalized to take a subpath, reused
    rather than duplicated) before any write, and the verified value (not the label) is what's recorded.
G3/R2: service_identity.py no longer hashes a hard-coded model path - it parses "-m <path>" from the live
    process's cmdline and hashes THAT file, and also resolves+hashes the actual running executable
    (/proc/<pid>/exe). Cmdline is now in IDENTITY_COMPARE_KEYS too, so a flag change (e.g. a different
    --no-speech-thold) is caught, not just a PID/model-hash change.
G4/R3: asserts every identity-relevant file's mtime predates its process's start time (assert_files_predate_process)
    before trusting that file's hash as representative of the running process - a file edited after the process
    started proves nothing about what code is actually loaded.
Should-fix: the run record is now written incrementally (rewritten after every consult, not only at the end), so
    an identity-change refusal mid-run doesn't lose identity_before or the tally accumulated so far.

Second review round (reb #5279, refuter-3 #5280 unifying #5277/#5278/#5279), fixed:
Item 2 (reb #5279, required): _write_ok_or_empty's write_track() call only caught TrackExistsError - any OTHER
    exception (ValidationError/PathComponentError from write_track's own validation, MirrorPendingError from a
    failed R2 mirror) propagated out of the per-window loop uncaught, crashing the ENTIRE remaining batch. This
    is the exact shape that crashed reb's own DEV ingest tonight at window 193/222 (a source_windows validation
    gap, fixed for that driver by 6788c930). Fixed: MirrorPendingError is now handled like
    commit_scored_tracks.py's own handling (local write IS durable and correct, only the mirror failed - counted,
    not a per-window failure); ValidationError/PathComponentError (both ValueError subclasses in kit/reb) are now
    caught, recorded as a "write_error" conflict entry, and the run moves on to the next engine/window. Exits 1
    at the end if any conflicts (including write_errors) were seen. PinnedConfigMismatch and ServiceIdentityError
    are deliberately left fatal (reb's own assessment, #5279): a config/pin drift or a service restart/change
    invalidates every subsequent window identically, so stopping the whole run immediately is correct there.
Item 7 (refuter-3 #5280, this box IS eta-lab-t4, a shared T4 GPU, confirmed via LANES.md - not a hypothetical):
    added _refuse_if_gpu_lock_held(), a non-blocking check of ~/gpu.lock before starting and before every
    per-window identity re-check. Deliberately REFUSES rather than blocks-and-waits: this script's whole
    philosophy (identity checks, config pins) is to refuse loudly on any ambiguity rather than guess or hang
    indefinitely inside an unattended run; a human (Fable) can retry once diar-lab's nightly job (bus #5143,
    ~23:00-05:59 IST, flock ~/gpu.lock on this exact box per training/diar-lab/*.sh) releases the lock.
Item 8 (refuter-3 #5280, documented, no code change): if a consult needs re-running after a genuine code/behavior
    fix (not a transient error), the correct move is to bump the engine's `version` field in pinned_configs.py -
    NEVER just re-run the same version/config_hash and hope it overwrites. A rerun under an unchanged (layer,
    engine, version, config_hash) identity that produces different track content is caught by the G1 fix above
    as a sha256_mismatch conflict (working as intended, the #4917/K1 class this whole bake-off guards against) -
    that conflict is the signal to bump version, not something to bypass or silence.

Not yet run against production - posted for reb (owns reb_runner) and both checkers' review first, matching the
gate on every other scored write this bake-off.
"""
import argparse
import fcntl
import json
import os
import socket
import sys
from datetime import datetime

KIT_ROOT = os.environ.get("KIT_ROOT")
if not KIT_ROOT:
    raise SystemExit(
        "KIT_ROOT is required - point it at an explicit worktree of a5def748 "
        "(e.g. `git worktree add /tmp/reb-runner-a5def748 a5def748`), never a bare 'main' checkout that could "
        "have moved past the pinned commit."
    )
sys.path.insert(0, KIT_ROOT)

from reb import write_track, TrackExistsError, MirrorPendingError  # noqa: E402
from reb_runner.engines import whisper, box_twin  # noqa: E402

from commit_scored_tracks import (  # noqa: E402
    verify_kit_reb_pin, _existing_manifest_entry, _track_body_sha256,
)
from pinned_configs import assert_pinned, PinnedConfigMismatch, config_hash as recompute_config_hash  # noqa: E402
from build_windows_set_c import build_windows_set_c  # noqa: E402
from r3_exclusion import is_excluded, filter_excluded  # noqa: E402
from service_identity import (  # noqa: E402
    whisper_server_identity, sravaani_server_identity, assert_predates, assert_unchanged,
    assert_files_predate_process, ServiceIdentityError,
)

REB_RUNNER_PINNED_COMMIT = "a5def748"
STAGE_AUDIO_DIR = os.path.expanduser("~/eta-data/terms/setc-stage/audio")
DEV_INGEST_CUTOFF = datetime(2026, 9, 27, 16, 35, 0)  # set (b)'s dev-ingest start, IST (box's own timezone)
LAYER = "stt"  # matches set (b)'s existing baseline convention, distinct from candidates' "terms" layer

GPU_LOCK_PATH = os.path.expanduser("~/gpu.lock")  # this box is eta-lab-t4 (LANES.md); diar-lab's nightly job
# (bus #5143, ~23:00-05:59 IST) holds this via flock during GPU training

SRAVAANI_MODEL = "ARTPARK-IISc/SraVaani-1.0"
SRAVAANI_VERSION = "v1"
SRAVAANI_RETRY_VERSION = "v2"  # only ever used via --retry-sravaani-window (eta-refuter-2 #7070)
SRAVAANI_CHUNK_S = 30

IDENTITY_COMPARE_KEYS = {
    "whisper-server": ["pid", "started_at", "cmdline", "model_sha256", "exe_sha256"],
    "sravaani-twin": ["pid", "started_at", "cmdline", "script_sha256", "exe_sha256"],
}
IDENTITY_MTIME_KEYS = {
    "whisper-server": ["model_mtime", "exe_mtime"],
    "sravaani-twin": ["script_mtime", "exe_mtime"],
}


def _serialize_identity(identity):
    out = dict(identity)
    for key in ("started_at", "model_mtime", "exe_mtime", "script_mtime"):
        if key in out and out[key] is not None:
            out[key] = out[key].isoformat()
    return out


def _write_ok_or_empty(reb_root, track, stub, label):
    """-> "written_<status>" / "already_present" / conflict dict. G1/R1: a TrackExistsError is no longer
    automatically "already present" - it's only that if the manifest actually lists a matching entry AND its
    recorded sha256 matches this track's own re-serialization; otherwise it's a real conflict, returned as a
    dict for the caller to collect and refuse the run over."""
    try:
        write_track(reb_root, stub["ist_date"], stub["room_id"], stub["window_id"], track, manifest_stub=stub)
        print(f"  [{label}] wrote status={track['status']}", flush=True)
        return f"written_{track['status']}"
    except TrackExistsError:
        entry = _existing_manifest_entry(reb_root, stub["ist_date"], stub["room_id"], stub["window_id"], track)
        if entry is None:
            print(f"  [{label}] CONFLICT: orphan track file, no matching manifest entry", flush=True)
            return {"kind": "orphan", "label": label, "window_id": stub["window_id"]}
        incoming_sha = _track_body_sha256(track)
        if entry.get("sha256") != incoming_sha:
            print(f"  [{label}] CONFLICT: sha256 mismatch (committed={entry.get('sha256')} "
                  f"incoming={incoming_sha})", flush=True)
            return {"kind": "sha256_mismatch", "label": label, "window_id": stub["window_id"]}
        print(f"  [{label}] already written (verified identical), skipped", flush=True)
        return "already_present"
    except MirrorPendingError as e:
        # reb #5279: local write IS durable and correct (see MirrorPendingError's own docstring) - only the R2
        # mirror (off by default) failed. Matches commit_scored_tracks.py's own handling: report, don't treat
        # as a per-window failure, never re-run write_track for this.
        print(f"  [{label}] MIRROR PENDING (local write OK): {e}", flush=True)
        return f"written_{track['status']}_mirror_pending"
    except ValueError as e:
        # reb #5279: write_track's own validation (ValidationError) or path-safety (PathComponentError) checks
        # raised - both are ValueError subclasses in kit/reb. A per-window failure, not a whole-batch crash (the
        # exact shape that crashed dev-ingest tonight at window 193/222) - record it and move on.
        print(f"  [{label}] WRITE FAILED (not written): {type(e).__name__}: {e}", flush=True)
        return {"kind": "write_error", "label": label, "window_id": stub["window_id"],
                "error": f"{type(e).__name__}: {e}"}


def _write_failed(reb_root, track_template, exc, stub, label):
    track = {**track_template, "status": "failed", "reason": f"{type(exc).__name__}: {exc}"[:500], "segments": []}
    outcome = _write_ok_or_empty(reb_root, track, stub, label)
    if isinstance(outcome, dict):
        return outcome
    return "failed"  # "written_failed" or "already_present" (this exact failure recorded before) both -> "failed"


_is_excluded = is_excluded


def _engine_recorded(reb_root, stub, engine, cfg_hash, version):
    """True iff the window's manifest already lists this stt engine at this exact config_hash+version. Checked
    BEFORE running the engine so a resume never re-runs (or risks a sha_mismatch conflict on) finished work."""
    probe = {"layer": LAYER, "engine": engine, "version": version, "config_hash": cfg_hash}
    try:
        return _existing_manifest_entry(reb_root, stub["ist_date"], stub["room_id"], stub["window_id"], probe) is not None
    except FileNotFoundError:
        return False


def _pending_engines(reb_root, stub):
    """-> subset of ("whisper-auto","whisper-cap2","sravaani") not yet recorded for this window."""
    sr_cfg = {"backend": "box-twin-cpu", "chunk_s": SRAVAANI_CHUNK_S}
    checks = [(v, whisper.expected_config(v)[1], whisper.VERSION) for v in ("whisper-auto", "whisper-cap2")]
    checks.append(("sravaani", recompute_config_hash(sr_cfg), SRAVAANI_VERSION))
    return [e for e, h, ver in checks if not _engine_recorded(reb_root, stub, e, h, ver)]


def run_whisper_variant(reb_root, variant, window_id, wav_path, duration_ms, stub):
    config, cfg_hash = whisper.expected_config(variant)
    try:
        assert_pinned(variant, config)
    except PinnedConfigMismatch as e:
        raise PinnedConfigMismatch(f"{variant}: {e}") from e
    try:
        track = whisper.build_track(window_id, wav_path, duration_ms, variant, machine="box")
    except Exception as e:
        return _write_failed(
            reb_root,
            {"schema": "reb.track.v1", "window_id": window_id, "layer": LAYER, "engine": variant,
             "model": whisper.MODEL, "version": whisper.VERSION, "config": config, "config_hash": cfg_hash,
             "machine": "box"},
            e, stub, variant,
        )
    return _write_ok_or_empty(reb_root, track, stub, variant)


def _probe_entry(reb_root, stub, engine, cfg_hash, version):
    probe = {"layer": LAYER, "engine": engine, "version": version, "config_hash": cfg_hash}
    try:
        return _existing_manifest_entry(reb_root, stub["ist_date"], stub["room_id"], stub["window_id"], probe)
    except FileNotFoundError:
        return None


def _retry_windows(reb_root, kept_windows, window_id):
    """-> [the one window] iff a v2 retry of its sravaani track is allowed. kept_windows is the R3-filtered
    set (c) list, so an unknown id or one of the 11 R3 clips is refused by construction. Only a failed (or
    absent) v1 record at the set (c) config may be retried; an ok/empty record never is, and a v2 record that
    already exists is never rewritten."""
    matches = [w for w in kept_windows if w["window_id"] == window_id]
    if not matches:
        raise RuntimeError(f"--retry-sravaani-window {window_id}: not in the set (c) primary windows "
                           f"(unknown id, or one of the excluded R3 clips) - refusing")
    stub = matches[0]["manifest_stub"]
    cfg_hash = recompute_config_hash({"backend": "box-twin-cpu", "chunk_s": SRAVAANI_CHUNK_S})
    if _probe_entry(reb_root, stub, "sravaani", cfg_hash, SRAVAANI_RETRY_VERSION) is not None:
        raise RuntimeError(f"{window_id}: a sravaani {SRAVAANI_RETRY_VERSION} record already exists - refusing")
    old = _probe_entry(reb_root, stub, "sravaani", cfg_hash, SRAVAANI_VERSION)
    if old is not None and old.get("status") != "failed":
        raise RuntimeError(f"{window_id}: existing sravaani {SRAVAANI_VERSION} record has status "
                           f"{old.get('status')!r}, not failed - refusing to re-run a non-failed window")
    return matches


def run_sravaani(reb_root, window_id, wav_path, duration_ms, stub, version=None):
    version = version or SRAVAANI_VERSION
    config = {"backend": "box-twin-cpu", "chunk_s": SRAVAANI_CHUNK_S}
    cfg_hash = recompute_config_hash(config)
    try:
        assert_pinned("sravaani", config, dataset_set="c")
    except PinnedConfigMismatch as e:
        raise PinnedConfigMismatch(f"sravaani: {e}") from e
    try:
        track = box_twin.build_sravaani_track(window_id, wav_path, machine="box-twin", chunk_s=SRAVAANI_CHUNK_S)
    except Exception as e:
        return _write_failed(
            reb_root,
            {"schema": "reb.track.v1", "window_id": window_id, "layer": LAYER, "engine": "sravaani",
             "model": SRAVAANI_MODEL, "version": version, "config": config, "config_hash": cfg_hash,
             "machine": "box-twin"},
            e, stub, "sravaani",
        )
    track["version"] = version  # the pinned engine hardcodes "v1"; config/config_hash are untouched
    return _write_ok_or_empty(reb_root, track, stub, "sravaani")


def _capture_and_verify_identity(cutoff=None):
    identity = {"whisper-server": whisper_server_identity(), "sravaani-twin": sravaani_server_identity()}
    for name, ident in identity.items():
        assert_files_predate_process(ident, name, IDENTITY_MTIME_KEYS[name])
        if cutoff is not None:
            assert_predates(ident, cutoff, name)
    return identity


def _refuse_if_gpu_lock_held(lock_path=GPU_LOCK_PATH):
    """refuter-3 #5280 item 7: this box is eta-lab-t4, a single shared T4 GPU (LANES.md) - diar-lab's nightly
    job (bus #5143, ~23:00-05:59 IST) holds `flock ~/gpu.lock` while training on it. A non-blocking check, not
    an indefinite wait: this script refuses loudly on any ambiguity elsewhere (config drift, service identity),
    so it refuses here too rather than hang inside an unattended run - a human can retry once the lock clears.
    No-op if the lock file doesn't exist on this box."""
    try:
        fd = os.open(lock_path, os.O_RDONLY)
    except FileNotFoundError:
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
    except BlockingIOError:
        raise RuntimeError(
            f"{lock_path} is currently held (likely diar-lab's nightly GPU job, bus #5143) - refusing to "
            f"start/continue rather than compete for the GPU or hang waiting; retry once it releases the lock."
        )
    finally:
        os.close(fd)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--reb-root", required=True, help="the REAL REB root to write into (e.g. "
                     "/home/eta/eta-data/reb) - required, no default, so this never runs against production by "
                     "accident")
    ap.add_argument("--runs-dir", default=os.path.expanduser("~/eta-data/terms/runs"),
                     help="durable local location for the run record")
    ap.add_argument("--retry-sravaani-window", default=None, metavar="WINDOW_ID",
                     help="retry ONE window's failed sravaani track as version v2 (same config); runs nothing else")
    ap.add_argument("--limit", type=int, default=None, help="only process the first N windows (smoke-testing)")
    args = ap.parse_args()

    print(f"[baselines] verifying kit/reb pin at KIT_ROOT={KIT_ROOT} ...", flush=True)
    verified_reb_commit = verify_kit_reb_pin(KIT_ROOT)
    print(f"[baselines] kit/reb VERIFIED against ADDENDUM-9's pinned commit {verified_reb_commit}", flush=True)

    print(f"[baselines] verifying kit/reb_runner/engines pin (expected {REB_RUNNER_PINNED_COMMIT}) ...", flush=True)
    verified_runner_commit = verify_kit_reb_pin(
        KIT_ROOT, pinned_commit=REB_RUNNER_PINNED_COMMIT, subpath="reb_runner/engines",
    )
    print(f"[baselines] kit/reb_runner/engines VERIFIED against {verified_runner_commit}", flush=True)

    print(f"[baselines] checking {GPU_LOCK_PATH} is not held (diar-lab nightly)...", flush=True)
    _refuse_if_gpu_lock_held()

    print("[baselines] checking service identity...", flush=True)
    identity_before = _capture_and_verify_identity(cutoff=DEV_INGEST_CUTOFF)
    for name, identity in identity_before.items():
        print(f"[baselines] {name}: pid={identity['pid']} started={identity['started_at']} "
              f"health={identity.get('health')!r}", flush=True)

    windows = build_windows_set_c()
    windows, n_excluded = filter_excluded(windows)
    print(f"[baselines] EXCLUDED {n_excluded} R3 room-day windows (ruling #6688); {len(windows)} remain", flush=True)
    retry = args.retry_sravaani_window
    if retry:
        windows = _retry_windows(args.reb_root, windows, retry)
    else:
        windows = [w for w in windows if _pending_engines(args.reb_root, w["manifest_stub"])]  # resume: skip finished
    if args.limit:
        windows = windows[: args.limit]
    print(f"[baselines] {len(windows)} set (c) windows to process", flush=True)

    tally = {}
    conflicts = []
    os.makedirs(args.runs_dir, exist_ok=True)
    run_record_path = os.path.join(args.runs_dir, f"setc-baselines-{datetime.now().strftime('%Y%m%dT%H%M%S')}.json")

    def _write_run_record(identity_after=None, completed=False):
        record = {
            "kit_reb_commit": verified_reb_commit, "reb_runner_commit": verified_runner_commit,
            "n_windows": len(windows), "tally": tally, "conflicts": conflicts, "completed": completed,
            "identity_before": {k: _serialize_identity(v) for k, v in identity_before.items()},
            "host": socket.gethostname(), "written_at": datetime.now().isoformat(),
        }
        if identity_after is not None:
            record["identity_after"] = {k: _serialize_identity(v) for k, v in identity_after.items()}
        with open(run_record_path, "w") as f:
            json.dump(record, f, indent=2, sort_keys=True)

    _write_run_record()  # initial record, before any writes, so a crash on window 1 still leaves identity_before
    try:
        for i, w in enumerate(windows):
            window_id = w["window_id"]
            stub = w["manifest_stub"]
            wav_path = os.path.join(STAGE_AUDIO_DIR, f"{window_id}.wav")
            if not os.path.exists(wav_path):
                raise FileNotFoundError(f"{wav_path} not found - staged audio missing for {window_id}, refusing")
            duration_ms = stub["t1_ms"] - stub["t0_ms"]
            if _is_excluded(stub):
                raise RuntimeError(f"{window_id} is on an excluded R3 room-day - refusing to transcribe")

            print(f"[baselines] === {i + 1}/{len(windows)} {window_id} ===", flush=True)
            pending = ["sravaani"] if retry else _pending_engines(args.reb_root, stub)
            for variant in ("whisper-auto", "whisper-cap2"):
                if variant not in pending:
                    continue
                outcome = run_whisper_variant(args.reb_root, variant, window_id, wav_path, duration_ms, stub)
                if isinstance(outcome, dict):
                    conflicts.append(outcome)
                else:
                    tally.setdefault(variant, {}).setdefault(outcome, 0)
                    tally[variant][outcome] += 1

            if "sravaani" in pending:
                outcome = run_sravaani(args.reb_root, window_id, wav_path, duration_ms, stub,
                                       version=SRAVAANI_RETRY_VERSION if retry else None)
                if isinstance(outcome, dict):
                    conflicts.append(outcome)
                else:
                    tally.setdefault("sravaani", {}).setdefault(outcome, 0)
                    tally["sravaani"][outcome] += 1

            # B2/G4: re-check per consult - refuse if either service's identity changed mid-run, or if any
            # identity-relevant file no longer predates its process's start (should never flip mid-run, but
            # checked every time rather than assumed stable once).
            identity_now = _capture_and_verify_identity()
            for name, identity in identity_now.items():
                assert_unchanged(identity_before[name], identity, name, IDENTITY_COMPARE_KEYS[name])

            # refuter-3 #5280 item 7: also re-check the GPU lock per consult - a long batch could still be
            # running when diar-lab's nightly job starts.
            _refuse_if_gpu_lock_held()

            _write_run_record()  # incremental - a later crash/refusal doesn't lose this progress
    finally:
        identity_after = _capture_and_verify_identity()
        _write_run_record(identity_after=identity_after, completed=not conflicts)

    print(f"[baselines] === SUMMARY === {json.dumps(tally, indent=2)}", flush=True)
    print(f"[baselines] run record: {run_record_path}", flush=True)
    if conflicts:
        print(f"[baselines] *** {len(conflicts)} CONFLICTS NEED HUMAN REVIEW *** {json.dumps(conflicts, indent=2)}",
              flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
