#!/usr/bin/env python3
"""Run the clinical1/label200 DEV ingest (Fable ruling 27 Sep 16:20): whisper (box, 3 variants) +
SraVaani + IndicConformer-CTC kn/hi/ta/te/ml (box twins) for each of the 222 catalog windows.
diar/acoustics are deliberately not written for these windows (Fable's instruction: "not_present") —
a reader doing tracks(layer="diar") on a DEV window correctly gets [] (never-attempted), which is a
distinct, honest signal from a written "failed" track.

    python3 run_dev_ingest.py /tmp/dev_ingest_catalog.json [--limit N] [--start-at IDX]
                              [--retry-failed-as VERSION]

If an individual engine call raises (network error, decode failure), this driver writes a visible
status="failed" track for that engine (reason=the exception, config known ahead of time via
whisper.expected_config / box_twin.expected_*_config so no successful call is needed to build a valid
config_hash) and does NOT mark the window done — it's released back to the queue instead. Fixed per
eta-refuter-3's N2 (#4929) and eta-refuter-2's #4930: previously a raised exception left the engine
silently absent (tracks(...) == []), indistinguishable from "never attempted" — breaking FUSER's L4
not-attempted/failed distinction and preventing retry, since the window was still marked done.

Retry (--retry-failed-as VERSION): a track file is keyed by (layer, engine, version, config_hash) with
no status component, so once a config has ANY recorded outcome, that's the permanent fact for that
exact (engine, version, config) — a later run can't silently replace a "failed" with an "ok" under the
SAME version (that would mean two different real outcomes claiming one append-only slot, exactly the
"hash-hides-a-change" trap #4917 already named), and deleting the stale failed file to free the slot
breaks the lab's mark-never-delete rule (eta-refuter-2/3, #4945/#4946). Instead, --retry-failed-as
writes any still-failed engine's retry under a BUMPED version string (e.g. "v1-r2") — new file, same
config_hash, original failed track kept forever as history. reb.py's tracks(latest_ok=True) already
groups by (layer, engine, config_hash) — not version — so it picks the new ok/empty result and the
failure surfaces as superseded history, not as a silently vanished record. Every engine call is still
preceded by an _already_written check (same shape as run_box_whisper.py's, eta-refuter-2 #4807),
checked again at the bumped version too, so nothing is ever re-attempted once IT has a recorded
outcome.

The bump is ONLY ever used to retry an engine whose current outcome is "failed" -- an engine
that's already "ok" or "empty" is always skipped regardless of --retry-failed-as (eta-refuter-2
#4948: two real results claiming one config would be exactly the append-only violation this
whole mechanism exists to avoid).
"""
import argparse
import json
import os
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from reb.writer import TrackExistsError, config_hash, track_filename, write_track
from reb_runner import task_queue
from reb_runner.engines import box_twin, whisper

QUEUE_NAME = "dev-ingest"


def default_owner():
    return f"{socket.gethostname()}:{os.getpid()}"


def _already_written(root, ist_date, room_id, window_id, layer, engine, version, cfg_hash):
    """status string if a track already exists on disk AND is listed in the manifest for this exact
    (layer, engine, version, cfg_hash), else None. Checked BEFORE calling the engine (eta-refuter-2
    #4807's "check before running" pattern, generalized from run_box_whisper.py's whisper-only
    _already_written): a config that already has ANY outcome recorded — including "failed" — must
    never be re-attempted, since a second write for the same config_hash would either be a wasted call
    (ok/empty) or, worse, would raise TrackExistsError on write and get silently swallowed, discarding
    a real new result behind a stale failed one."""
    window_dir = os.path.join(root, ist_date, room_id, window_id)
    expected_path = os.path.join(window_dir, "tracks", track_filename(layer, engine, version, cfg_hash))
    if not os.path.exists(expected_path):
        return None
    manifest_path = os.path.join(window_dir, "manifest.json")
    rel = os.path.relpath(expected_path, root)
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        for entry in manifest.get("tracks", []):
            if entry.get("path") == rel:
                return entry.get("status")
    raise RuntimeError(
        f"{expected_path} exists on disk but is NOT listed in {manifest_path} — an orphaned track "
        "(eta-refuter-3 #4799 B3). Needs manual repair; refusing to treat this engine as attempted."
    )


def _write(root, w, track, stub, label):
    try:
        write_track(root, w["ist_date"], w["room_id"], w["window_id"], track, manifest_stub=stub)
        print(f"    [{label}] {track['status']}", flush=True)
    except TrackExistsError:
        print(f"    [{label}] already written, skipped", flush=True)


def _write_failed(root, w, stub, layer, engine, model, version, machine, config, exc, label):
    """Record a raised exception as a visible status="failed" track instead of leaving the engine
    silently absent (eta-refuter-3 N2 / eta-refuter-2 #4930). `machine` must match whatever the
    engine's own successful-path writer uses (eta-refuter-3 #4945 R2: box_twin engines write
    machine="box-twin" on success, so their failed tracks must say the same, not "box")."""
    track = {
        "schema": "reb.track.v1", "window_id": w["window_id"], "layer": layer, "engine": engine,
        "model": model, "version": version, "config": config, "config_hash": config_hash(config),
        "machine": machine, "status": "failed", "reason": f"{type(exc).__name__}: {exc}"[:500],
        "segments": [],
    }
    try:
        write_track(root, w["ist_date"], w["room_id"], w["window_id"], track, manifest_stub=stub)
    except TrackExistsError:
        pass  # this exact (engine, version, config) failure was already recorded by an earlier attempt
    print(f"    [{label}] FAILED, recorded as status=failed: {track['reason']}", flush=True)


def _run_engine(root, w, stub, layer, engine, model, version, config, machine, label, run_fn, retry_failed_as=None):
    """Shared per-engine flow: skip if this exact (version, config) already has a recorded outcome,
    else run it and write ok/empty (via run_fn) or a failed track (on exception). If the existing
    outcome is "failed" and retry_failed_as is given, retries under that bumped version instead of
    the original one (new append-only slot, same config_hash -- see module docstring). Returns True
    iff this engine's outcome for the window is now a non-failure (ok/empty)."""
    cfg_hash = config_hash(config)
    existing = _already_written(root, w["ist_date"], w["room_id"], w["window_id"], layer, engine, version, cfg_hash)
    if existing is not None and existing != "failed":
        print(f"    [{label}] already attempted (status={existing}), skipped", flush=True)
        return True
    if existing == "failed":
        if not retry_failed_as:
            print(f"    [{label}] already attempted (status=failed), skipped "
                  f"(pass --retry-failed-as VERSION to retry)", flush=True)
            return False
        version = retry_failed_as
        retried = _already_written(root, w["ist_date"], w["room_id"], w["window_id"], layer, engine, version, cfg_hash)
        if retried is not None:
            print(f"    [{label}] retry-as-{version} already attempted (status={retried}), skipped", flush=True)
            return retried != "failed"
        print(f"    [{label}] retrying previously-failed engine as version={version}", flush=True)
    try:
        track = run_fn()
        track["version"] = version  # bumped version on a retry -- new slot, same config_hash
        _write(root, w, track, stub, label)
        return True
    except Exception as e:
        _write_failed(root, w, stub, layer, engine, model, version, machine, config, e, label)
        return False


def process_window(root, w, owner=None, retry_failed_as=None):
    owner = owner or default_owner()
    window_id = w["window_id"]
    token = task_queue.claim(root, QUEUE_NAME, window_id, owner)
    if not token:
        return False
    try:
        stub = w["manifest_stub"]
        duration_ms = stub["t1_ms"] - stub["t0_ms"]
        wav_path = w["wav_path"]
        print(f"[{window_id}] room={w['room_id']} dur={duration_ms}ms source_kind={stub['source_kind']}", flush=True)

        any_failed = False

        for variant in whisper.VARIANTS:
            config, _ = whisper.expected_config(variant)
            ok = _run_engine(
                root, w, stub, "stt", variant, whisper.MODEL, whisper.VERSION, config, "box", variant,
                lambda variant=variant: whisper.build_track(window_id, wav_path, duration_ms, variant, machine="box"),
                retry_failed_as=retry_failed_as,
            )
            any_failed = any_failed or not ok

        sravaani_config = box_twin.expected_sravaani_config()
        ok = _run_engine(
            root, w, stub, "stt", "sravaani", box_twin.SRAVAANI_MODEL, box_twin.SRAVAANI_VERSION, sravaani_config,
            "box-twin", "sravaani",
            lambda: box_twin.finalize_single_span(box_twin.build_sravaani_track(window_id, wav_path), duration_ms),
            retry_failed_as=retry_failed_as,
        )
        any_failed = any_failed or not ok

        indic_config = box_twin.expected_indic_ctc_config()
        for lang in box_twin.INDIC_LANGS:
            ok = _run_engine(
                root, w, stub, "stt", f"indic-ctc-{lang}", box_twin.INDIC_MODEL, box_twin.INDIC_VERSION, indic_config,
                "box-twin", f"indic-ctc-{lang}",
                lambda lang=lang: box_twin.finalize_single_span(
                    box_twin.build_indic_ctc_track(window_id, wav_path, lang), duration_ms
                ),
                retry_failed_as=retry_failed_as,
            )
            any_failed = any_failed or not ok

        if any_failed:
            task_queue.mark_failed(root, QUEUE_NAME, window_id, token,
                                    "one or more engines failed; see per-engine status=failed tracks")
            task_queue.release(root, QUEUE_NAME, window_id, token)
            print(f"[{window_id}] one or more engines failed -- NOT marked done, remains retryable", flush=True)
            return True

        task_queue.mark_done(root, QUEUE_NAME, window_id, token)
        return True
    except Exception as e:
        # Something outside the normal per-engine failure path went wrong (e.g. an invalid
        # manifest_stub -- a real 27 Sep incident: 30 dev_clip windows missing the required
        # source_windows field made EVERY track write for those windows raise, including the
        # _write_failed attempt inside _run_engine, which isn't itself guarded). Release the claim
        # so a fixed re-run doesn't have to wait out the 30-minute lease, log it at the queue level,
        # and re-raise so the caller (main()'s per-window try/except) can skip just this window
        # instead of losing the rest of the batch to one bad window -- same shape as
        # run_box_whisper.py's own process_window/main() error handling.
        task_queue.mark_failed(root, QUEUE_NAME, window_id, token, e)
        task_queue.release(root, QUEUE_NAME, window_id, token)
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("catalog_json")
    ap.add_argument("--root", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--start-at", type=int, default=0)
    ap.add_argument("--retry-failed-as", default=None,
                     help="Bumped version string (e.g. v1-r2) to retry any still-failed engine under. "
                          "Never retries under the original version -- see module docstring.")
    args = ap.parse_args()

    import reb as reb_pkg
    root = args.root or reb_pkg.reb.DEFAULT_ROOT
    windows = json.load(open(args.catalog_json))[args.start_at:]
    if args.limit:
        windows = windows[: args.limit]
    owner = default_owner()

    t0 = time.time()
    done = skipped = 0
    crashed_ids = []
    for i, w in enumerate(windows):
        try:
            did = process_window(root, w, owner=owner, retry_failed_as=args.retry_failed_as)
            done += did
            skipped += not did
        except Exception as e:
            crashed_ids.append(w["window_id"])
            print(f"[{w['window_id']}] CRASHED, window skipped, batch continues: {type(e).__name__}: {e}",
                  flush=True)
        elapsed = time.time() - t0
        print(f"=== {i+1}/{len(windows)} done={done} skipped={skipped} crashed={len(crashed_ids)} "
              f"elapsed={elapsed:.0f}s ===", flush=True)
    # eta-refuter-2 #4963: a completion line that doesn't name the crashed windows (or exits 0 anyway)
    # is easy for a downstream reader (router-fix's B4, terms) to mistake for a fully clean run.
    print(f"INGEST COMPLETE: {done} processed, {skipped} skipped (already claimed/done), "
          f"CRASHED: {len(crashed_ids)} {crashed_ids}, {time.time()-t0:.0f}s total", flush=True)
    return 1 if crashed_ids else 0


if __name__ == "__main__":
    sys.exit(main())
