"""Tests for the local commit step of the two-phase scored write (ADDENDUM-21/22). Uses isolated tmp_path roots
only - never touches the real /home/eta/eta-data/reb store."""
import json
import os
import subprocess

import pytest

from commit_scored_tracks import (
    commit_all, iter_downloaded_tracks, commit_run_manifests, _track_body_sha256,
    verify_kit_reb_pin, PINNED_REB_COMMIT, refuse_skip_verify_against_production,
)
from pinned_configs import PINNED_CONFIGS, PINNED_HASHES, config_hash as real_config_hash

REPO_DIR = os.path.dirname(os.path.abspath(__file__))

MEDASR_CONFIG = PINNED_CONFIGS["medasr"]
MEDASR_HASH = PINNED_HASHES["medasr"]


def _make_track(engine="medasr", layer="terms", config=None, window_id="clin_en_1", text="hello"):
    config = config if config is not None else MEDASR_CONFIG
    return {
        "schema": "reb.track.v1", "window_id": window_id, "layer": layer, "engine": engine,
        "model": "google/medasr", "version": "v1",
        "config": config, "config_hash": real_config_hash(config),
        "machine": "hf-job-test", "status": "ok",
        "segments": [{"t0_ms": 0, "t1_ms": 1000, "text": text}],
    }


def _write_downloaded_track(download_root, ist_date, room_id, window_id, track, filename=None):
    filename = filename or f"{track['layer']}.{track['engine']}__{track['version']}__{track['config_hash']}.json"
    track_dir = os.path.join(download_root, "terms-scored", ist_date, room_id, window_id, "tracks")
    os.makedirs(track_dir, exist_ok=True)
    with open(os.path.join(track_dir, filename), "w") as f:
        json.dump(track, f)
    return track


def _seed_existing_manifest(reb_root, ist_date, room_id, window_id, tracks=None):
    """Simulates dev-ingest already having written this window's manifest, matching reb's real
    suite-clinical1 shape closely enough for write_track's read-modify-write path."""
    window_dir = os.path.join(reb_root, ist_date, room_id, window_id)
    os.makedirs(window_dir, exist_ok=True)
    manifest = {
        "window_id": window_id, "room_id": room_id, "room_slug": room_id, "ist_date": ist_date,
        "t0_ms": 0, "t1_ms": 24144,
        "audio": {"r2_key": f"local:{window_id}.wav", "sha256": "x" * 64, "sample_rate": 16000, "duration_ms": 24144},
        "source_kind": "suite_synthetic", "clock": "clip_local", "tracks": tracks or [],
    }
    with open(os.path.join(window_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)


def test_commits_into_existing_manifest(tmp_path):
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())

    result = commit_all(download_root, reb_root)

    assert len(result["committed"]) == 1
    assert result["already_present"] == result["rejected"] == result["conflicts"] == []
    manifest_path = os.path.join(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1", "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    assert len(manifest["tracks"]) == 1
    assert manifest["tracks"][0]["engine"] == "medasr"


def test_rerun_skips_genuinely_already_committed_not_raises(tmp_path):
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())

    commit_all(download_root, reb_root)  # first run: commits
    result = commit_all(download_root, reb_root)  # second run: same track file, same window

    assert result["committed"] == []
    assert result["conflicts"] == []
    assert len(result["already_present"]) == 1
    assert result["already_present"][0][0] == "clin_en_1"


def test_missing_manifest_raises_not_silently_skipped(tmp_path):
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    # deliberately do NOT seed a manifest - this window has never been written to before
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())

    with pytest.raises(ValueError):
        commit_all(download_root, reb_root)


def test_missing_manifest_refuses_the_whole_batch_all_or_nothing(tmp_path):
    """refuter-3 #5289 S2: for set (c), the manifest is created by run_setc_baselines.py, which must run BEFORE
    this commit step. One window with no manifest.json yet (e.g. run_setc_baselines hasn't reached it, or hasn't
    finished) must refuse the ENTIRE commit - never partially commit some of set (c)'s windows and leave others
    silently uncommitted, which would corrupt STEP 3's per-comparison exclusion bookkeeping."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-22", "suite-a", "w1")  # this one IS ready
    _write_downloaded_track(download_root, "2026-09-22", "suite-a", "w1", _make_track(window_id="w1"))
    _write_downloaded_track(download_root, "2026-09-22", "suite-b", "w2", _make_track(window_id="w2"))  # not ready

    with pytest.raises(ValueError, match="suite-b/w2"):
        commit_all(download_root, reb_root)

    # nothing was committed for w1 either - all-or-nothing, not a partial commit
    manifest_path = os.path.join(reb_root, "2026-09-22", "suite-a", "w1", "manifest.json")
    with open(manifest_path) as f:
        manifest = json.load(f)
    assert manifest["tracks"] == []


def test_all_manifests_present_lets_commit_proceed_normally(tmp_path):
    """Sanity check that the new precondition doesn't false-fire on the ordinary (set (b)-shaped, or a fully
    baseline-completed set (c)) case where every window's manifest already exists."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-22", "suite-a", "w1")
    _seed_existing_manifest(reb_root, "2026-09-22", "suite-b", "w2")
    _write_downloaded_track(download_root, "2026-09-22", "suite-a", "w1", _make_track(window_id="w1"))
    _write_downloaded_track(download_root, "2026-09-22", "suite-b", "w2", _make_track(window_id="w2"))

    result = commit_all(download_root, reb_root)

    assert len(result["committed"]) == 2
    assert result["rejected"] == result["conflicts"] == []


def test_iter_downloaded_tracks_parses_path_components(tmp_path):
    download_root = str(tmp_path / "download")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())
    found = list(iter_downloaded_tracks(download_root))
    assert len(found) == 1
    _path, track, ist_date, room_id, window_id = found[0]
    assert (ist_date, room_id, window_id) == ("2026-09-27", "suite-clinical1", "clin_en_1")
    assert track["engine"] == "medasr"


# --- K1 (refuter-3 #5145): reject anything that isn't a currently-pinned scored candidate track ---

def test_k1_rejects_non_candidate_engine(tmp_path):
    """A parakeet-med (withdrawn) or baseline-engine file in the synced bucket must never reach production."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    bad_track = _make_track(engine="parakeet-med", config=PINNED_CONFIGS["parakeet-med"])
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", bad_track)

    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert len(result["rejected"]) == 1
    assert "parakeet-med" in result["rejected"][0]["reason"]


def test_k1_rejects_wrong_layer(tmp_path):
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    bad_track = _make_track(layer="stt")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", bad_track,
                             filename="stt.medasr__v1__" + bad_track["config_hash"] + ".json")

    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert len(result["rejected"]) == 1
    assert "layer" in result["rejected"][0]["reason"]


def test_k1_rejects_stale_config_hash(tmp_path):
    """A drifted/superseded config (e.g. an old whisper-med-merged hash before the fp32 fix) must be refused even
    though it's internally self-consistent (config_hash == sha256(its own config))."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    stale_config = dict(MEDASR_CONFIG, chunk_s=999)  # NOT the pinned config -> different (but self-consistent) hash
    bad_track = _make_track(config=stale_config)
    assert bad_track["config_hash"] != MEDASR_HASH  # sanity: this really is a different hash
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", bad_track)

    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert len(result["rejected"]) == 1
    assert "pre-registered" in result["rejected"][0]["reason"]  # pinned_configs.assert_pinned's own wording


def test_k1_rejects_internally_inconsistent_hash(tmp_path):
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    bad_track = _make_track()
    bad_track["config_hash"] = "deadbeef"
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", bad_track,
                             filename="terms.medasr__v1__deadbeef.json")

    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert len(result["rejected"]) == 1
    assert "inconsistent" in result["rejected"][0]["reason"]


# --- K2 (refuter-3 #5145): TrackExistsError is never blindly treated as "fine" ---

def test_k2_orphan_track_file_is_a_conflict_not_a_skip(tmp_path):
    """A track file exists on disk but the manifest has no entry for it (writer.py's B1 orphan class) - must be
    reported as a conflict, never silently treated as already_present."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    track = _make_track()
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")  # tracks=[] - no entry
    # place the track FILE directly, bypassing write_track, simulating an orphan
    tracks_dir = os.path.join(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1", "tracks")
    os.makedirs(tracks_dir, exist_ok=True)
    fname = f"terms.medasr__v1__{track['config_hash']}.json"
    with open(os.path.join(tracks_dir, fname), "w") as f:
        json.dump(track, f, indent=1, sort_keys=True)

    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", track)
    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert result["already_present"] == []
    assert len(result["conflicts"]) == 1
    assert result["conflicts"][0]["kind"] == "orphan_track_file_no_manifest_entry"


def test_k2_sha256_mismatch_is_a_conflict_not_a_skip(tmp_path):
    """The manifest DOES list an entry for this (layer, engine, version, config_hash), but its recorded sha256
    doesn't match this track's body - must be reported, never counted as already_present."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    track = _make_track()

    entry = {
        "layer": track["layer"], "engine": track["engine"], "version": track["version"],
        "config_hash": track["config_hash"], "sha256": "0" * 64,  # deliberately wrong
        "model": track["model"], "status": track["status"], "reason": None, "machine": track["machine"],
        "started_at": "2026-09-27T00:00:00Z", "finished_at": "2026-09-27T00:00:00Z",
        "path": f"2026-09-27/suite-clinical1/clin_en_1/tracks/terms.medasr__v1__{track['config_hash']}.json",
    }
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1", tracks=[entry])
    tracks_dir = os.path.join(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1", "tracks")
    os.makedirs(tracks_dir, exist_ok=True)
    with open(os.path.join(tracks_dir, f"terms.medasr__v1__{track['config_hash']}.json"), "w") as f:
        json.dump(track, f, indent=1, sort_keys=True)

    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", track)
    result = commit_all(download_root, reb_root)

    assert result["committed"] == []
    assert result["already_present"] == []
    assert len(result["conflicts"]) == 1
    assert result["conflicts"][0]["kind"] == "sha256_mismatch"


def test_k2_matching_sha256_is_genuinely_already_present(tmp_path):
    """The manifest entry's sha256 DOES match - this is the real, safe already-committed case."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())

    commit_all(download_root, reb_root)  # first run commits for real, computing the real manifest entry/sha
    result = commit_all(download_root, reb_root)  # second run: identical track file

    assert result["conflicts"] == []
    assert len(result["already_present"]) == 1


# --- run-manifest copy (refuter-3 #5145 note 1) ---

def test_commit_run_manifests_copies_records(tmp_path):
    download_root = str(tmp_path / "download")
    runs_dir = str(tmp_path / "runs")
    runs_src = os.path.join(download_root, "terms-scored", "_runs")
    os.makedirs(runs_src, exist_ok=True)
    record = {"job_id": "hf-job-abc", "engine": "medasr", "dep_versions": {"torch": "2.14.0"}}
    with open(os.path.join(runs_src, "hf-job-abc.json"), "w") as f:
        json.dump(record, f)

    copied = commit_run_manifests(download_root, runs_dir)

    assert len(copied) == 1
    with open(copied[0]) as f:
        assert json.load(f) == record


def test_commit_run_manifests_adds_committed_kit_reb_commit(tmp_path):
    """The verified commit used for the REAL production write must be recorded distinctly from the job's own
    (harmless, scratch-only) reb_lib_commit field."""
    download_root = str(tmp_path / "download")
    runs_dir = str(tmp_path / "runs")
    runs_src = os.path.join(download_root, "terms-scored", "_runs")
    os.makedirs(runs_src, exist_ok=True)
    record = {"job_id": "hf-job-abc", "engine": "medasr", "reb_lib_commit": "18c52b9f"}
    with open(os.path.join(runs_src, "hf-job-abc.json"), "w") as f:
        json.dump(record, f)

    copied = commit_run_manifests(download_root, runs_dir, committed_kit_reb_commit=PINNED_REB_COMMIT)

    with open(copied[0]) as f:
        saved = json.load(f)
    assert saved["reb_lib_commit"] == "18c52b9f"
    assert saved["committed_kit_reb_commit"] == PINNED_REB_COMMIT


def test_by_engine_status_tallies_committed_and_rejected(tmp_path):
    """refuter-2 #5146: per-engine/per-status counts, so a batch's outcome is legible without counting lines."""
    download_root = str(tmp_path / "download")
    reb_root = str(tmp_path / "reb")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_1")
    _seed_existing_manifest(reb_root, "2026-09-27", "suite-clinical1", "clin_en_2")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_1", _make_track())
    bad_track = _make_track(engine="parakeet-med", config=PINNED_CONFIGS["parakeet-med"], window_id="clin_en_2")
    _write_downloaded_track(download_root, "2026-09-27", "suite-clinical1", "clin_en_2", bad_track)

    result = commit_all(download_root, reb_root)

    assert result["by_engine_status"]["medasr"] == {"committed_status=ok": 1}
    assert result["by_engine_status"]["parakeet-med"] == {"rejected": 1}


# --- ADDENDUM-9 kit/reb pin verification (both checkers, #5152-#5160) ---

def _checkout_pinned_kit_reb(dest_reb_dir, commit=PINNED_REB_COMMIT):
    """Materializes `commit`'s real kit/reb/ tree into dest_reb_dir file-by-file via `git ls-tree`/`git show` -
    dynamic, not a hand-copied fixture, so this stays correct even though the commit's content is immutable.
    (Not `git archive`: that requires CWD to map onto a tracked path in the target tree, which fails here since
    this study directory didn't exist yet at the pinned commit.)"""
    listing = subprocess.run(
        ["git", "-C", REPO_DIR, "ls-tree", "-r", "--full-tree", "--name-only", commit, "--", "kit/reb"],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    for repo_path in listing:
        rel = repo_path[len("kit/reb/"):]
        content = subprocess.run(
            ["git", "-C", REPO_DIR, "show", f"{commit}:{repo_path}"], check=True, capture_output=True,
        ).stdout
        dest_path = os.path.join(dest_reb_dir, rel)
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        with open(dest_path, "wb") as f:
            f.write(content)


def test_verify_kit_reb_pin_passes_on_real_pinned_content(tmp_path):
    kit_root = str(tmp_path / "kit")
    _checkout_pinned_kit_reb(os.path.join(kit_root, "reb"))
    assert verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR) == PINNED_REB_COMMIT


def test_verify_kit_reb_pin_fails_on_this_branchs_older_kit_reb(tmp_path):
    """This branch's own kit/reb (18c52b9f, an ancestor of the pin) must be REJECTED - this is the exact real bug
    both checkers caught (#5152/#5155)."""
    kit_root = os.path.join(REPO_DIR, "..", "..", "kit")  # this branch's real, older kit/reb
    with pytest.raises(RuntimeError, match="does NOT match"):
        verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR)


def test_verify_kit_reb_pin_fails_on_missing_file(tmp_path):
    kit_root = str(tmp_path / "kit")
    _checkout_pinned_kit_reb(os.path.join(kit_root, "reb"))
    os.remove(os.path.join(kit_root, "reb", "writer.py"))
    with pytest.raises(RuntimeError, match="missing"):
        verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR)


def test_verify_kit_reb_pin_fails_on_corrupted_file(tmp_path):
    kit_root = str(tmp_path / "kit")
    _checkout_pinned_kit_reb(os.path.join(kit_root, "reb"))
    with open(os.path.join(kit_root, "reb", "writer.py"), "a") as f:
        f.write("\n# tampered\n")
    with pytest.raises(RuntimeError, match="does NOT match"):
        verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR)


def test_verify_kit_reb_pin_fails_on_extra_file(tmp_path):
    """refuter-3 #5168 nit: an EXTRA .py file in kit_root/reb that the pinned commit doesn't have must be
    rejected too - it could carry a real behavioral change nothing else here would catch."""
    kit_root = str(tmp_path / "kit")
    _checkout_pinned_kit_reb(os.path.join(kit_root, "reb"))
    with open(os.path.join(kit_root, "reb", "sneaky_extra.py"), "w") as f:
        f.write("# not part of the pinned commit\n")
    with pytest.raises(RuntimeError, match="EXTRA file"):
        verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR)


def test_verify_kit_reb_pin_ignores_pycache(tmp_path):
    """__pycache__ is a build artifact, not a code difference - must not trip the extra-file check."""
    kit_root = str(tmp_path / "kit")
    _checkout_pinned_kit_reb(os.path.join(kit_root, "reb"))
    pycache_dir = os.path.join(kit_root, "reb", "__pycache__")
    os.makedirs(pycache_dir, exist_ok=True)
    with open(os.path.join(pycache_dir, "writer.cpython-312.pyc"), "wb") as f:
        f.write(b"\x00\x01\x02")
    assert verify_kit_reb_pin(kit_root, repo_dir=REPO_DIR) == PINNED_REB_COMMIT


# --- --skip-kit-reb-verify must not be usable against production (refuter-2 #5167, refuter-3 #5173) ---

def test_skip_verify_refused_against_production(tmp_path):
    fake_production = str(tmp_path / "reb")
    os.makedirs(fake_production, exist_ok=True)
    with pytest.raises(SystemExit, match="refused"):
        refuse_skip_verify_against_production(fake_production, skip_flag=True, production_reb_root=fake_production)


def test_skip_verify_refused_via_symlink_realpath(tmp_path):
    """realpath, not a literal string compare - a symlink or relative path pointing at production must be caught
    too, not just an exact string match."""
    fake_production = tmp_path / "reb"
    os.makedirs(fake_production, exist_ok=True)
    symlink_path = tmp_path / "reb-symlink"
    symlink_path.symlink_to(fake_production)
    with pytest.raises(SystemExit, match="refused"):
        refuse_skip_verify_against_production(str(symlink_path), skip_flag=True,
                                               production_reb_root=str(fake_production))


def test_skip_verify_allowed_against_non_production_root(tmp_path):
    other_root = str(tmp_path / "test-reb")
    production_root = str(tmp_path / "reb")
    os.makedirs(other_root, exist_ok=True)
    os.makedirs(production_root, exist_ok=True)
    refuse_skip_verify_against_production(other_root, skip_flag=True, production_reb_root=production_root)  # no raise


def test_skip_verify_not_checked_when_flag_is_false(tmp_path):
    production_root = str(tmp_path / "reb")
    os.makedirs(production_root, exist_ok=True)
    refuse_skip_verify_against_production(production_root, skip_flag=False,
                                           production_reb_root=production_root)  # no raise - flag isn't set


def test_track_body_sha256_matches_writer_serialization(tmp_path):
    """Sanity check: _track_body_sha256 must use writer.py's exact serialization (indent=1, sort_keys=True) or a
    K2 sha comparison would be comparing apples to oranges."""
    import hashlib
    track = _make_track()
    expected = hashlib.sha256(
        json.dumps(track, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")
    ).hexdigest()
    assert _track_body_sha256(track) == expected
