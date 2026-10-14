"""Append-only writer for REB track files (REB-SPEC-v1.md sections 1-2).
Principle 2: "Append-only. A re-run adds a new track file (new config hash); nothing is overwritten."
This module is the one place that is allowed to create/modify files under the REB root; every other
caller in the repo should go through it rather than open(..., "w") directly.

eta-refuter-2 review of 20f47579 (#4595) found 4 real bugs, all fixed here:
B1 a failed first write (no manifest_stub, or any crash between the track file and the manifest)
   left an orphaned track file with no manifest entry, and TrackExistsError then made the window
   permanently unwritable. Fixed: manifest_stub is checked BEFORE any file is created; the track body
   is written to a temp file and moved into place with os.link (atomic create-if-absent, but only
   AFTER the content is fully on disk), and a failure writing the manifest entry unlinks the track
   file to roll back to the pre-call state.
B2 ist_date/room_id/window_id/layer/engine/version/config_hash went into path components unchecked
   (e.g. ist_date="../../outside" escaped root). Fixed: every component is whitelisted, and the
   final path is asserted to resolve under root.
B3 manifest.json was truncated-and-rewritten in place under a lock on the file itself; a reader with
   no lock (reb.py) could see a torn/empty file mid-write, and renaming a locked file breaks flock
   for anyone opening the new path. Fixed: a separate manifest.lock is what gets flocked; manifest.json
   itself is only ever replaced atomically (temp file + os.replace), so a plain read never tears.
B4 the R2 mirror ran after the lock was released, so two concurrent writers could mirror out of
   order and leave R2 with a stale manifest. Fixed: the mirror of manifest.json/index.jsonl happens
   while still holding the same lock that serializes the write.
(also: os.write on a large buffer isn't guaranteed to write everything in one call — now looped.)

Follow-up review of b5a85d6a (#4619) found a 5th bug: the mirror call was still INSIDE the same
try/except as the manifest commit, so a mirror failure (network/wrangler) looked identical to a
manifest-write failure to write_track's caller — which then rolled back (unlinked) the track file
even though the manifest had ALREADY been durably committed pointing at it. Fixed: once
_replace_file_atomic / the index append itself has succeeded, a mirror failure is caught locally and
returned (not raised) from _write_manifest_entry/_append_index_line; write_track only rolls the track
file back for a failure that happened BEFORE the local commit. If mirroring failed, write_track still
returns the path (the local write is correct and durable) but raises MirrorPendingError at the very
end so the caller knows R2 needs a separate retry — never re-run write_track itself for that, it
would just hit TrackExistsError.
"""
import fcntl
import hashlib
import json
import os
import re
import time
import uuid

from . import r2_mirror
from .schema import REQUIRED_MANIFEST_FIELDS, DEFAULT_SOURCE_KIND
from .validate import validate_track, validate_manifest


class TrackExistsError(FileExistsError):
    """A track file with this exact (layer, engine, version, config_hash) already exists for this
    window. Re-running with a different config produces a different config_hash and a new file;
    this error means the caller is trying to overwrite, which REB never allows."""


class MirrorPendingError(RuntimeError):
    """The track file, manifest entry, and index line are all written and durable on local disk —
    this is NOT a failed write. Only the R2 mirror of one or more of them failed. Never retry
    write_track() for this: it will raise TrackExistsError. Re-mirror the returned path (and this
    window's manifest.json / that date's index.jsonl) separately instead."""


_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")


class PathComponentError(ValueError):
    pass


def _check_component(name, value):
    if not isinstance(value, str) or not _COMPONENT_RE.match(value) or ".." in value:
        raise PathComponentError(f"{name}={value!r} is not a safe path component (must match {_COMPONENT_RE.pattern!r}, no '..')")
    return value


def _assert_under_root(path, root):
    real_root = os.path.realpath(root)
    real_path = os.path.realpath(path)
    if real_path != real_root and not real_path.startswith(real_root + os.sep):
        raise PathComponentError(f"resolved path {real_path!r} escapes root {real_root!r}")
    return real_path


def config_hash(config):
    """8 hex chars of sha256 over the config's canonical JSON. Same config -> same hash, always
    (used both to name the track file and to detect an accidental config_hash mismatch on write)."""
    body = json.dumps(config or {}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()[:8]


_default_config_hash = config_hash   # write_track's `config_hash=` parameter shadows the function name inside it


def track_filename(layer, engine, version, cfg_hash):
    return f"{layer}.{engine}__{version}__{cfg_hash}.json"


def _window_dir(root, ist_date, room_id, window_id):
    return os.path.join(root, ist_date, room_id, window_id)


def _sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def _write_all(fd, body):
    view = memoryview(body)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def _write_file_atomic_create(final_path, body, mode=0o640):
    """Create final_path with exactly `body`, or raise FileExistsError if it already exists —
    WITHOUT ever leaving a partially-written file at final_path (B1). Writes to a private temp name
    first, then os.link()s it into place (link fails if final_path exists, same atomicity as
    O_CREAT|O_EXCL, but the content is already complete before the atomic step)."""
    directory = os.path.dirname(final_path)
    tmp_path = os.path.join(directory, f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    fd = os.open(tmp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        _write_all(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(tmp_path, final_path)
    except FileExistsError:
        raise TrackExistsError(
            f"{final_path} already exists — REB is append-only; re-run with a different config "
            "(new config_hash) instead of overwriting"
        )
    finally:
        os.unlink(tmp_path)
    os.chmod(final_path, mode)


def _replace_file_atomic(final_path, body, mode=0o640):
    """Overwrite final_path with `body` such that any reader ALWAYS sees either the fully-old or
    fully-new content, never a torn read (B3) — used for manifest.json and index mirrors, which are
    the only files this module ever updates in place."""
    directory = os.path.dirname(final_path)
    os.makedirs(directory, exist_ok=True)
    tmp_path = os.path.join(directory, f".tmp-{os.getpid()}-{uuid.uuid4().hex}")
    fd = os.open(tmp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        _write_all(fd, body)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chmod(tmp_path, mode)
    os.replace(tmp_path, final_path)  # atomic on the same filesystem


def _lock(lock_path):
    """Flock a dedicated lock file (never itself replaced/renamed — B3's other half: locking the
    file you're about to os.replace() loses the lock for anyone opening the new inode by path)."""
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o640)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


def _check_manifest_stub_required(manifest_stub, window_id):
    """Called only when we already know manifest.json doesn't exist yet — raises before any file is
    touched (B1) rather than after the track file is already on disk."""
    if manifest_stub is None:
        raise ValueError(
            f"manifest.json does not exist yet for {window_id} and no manifest_stub was given; "
            "pass manifest_stub={{window_id, room_id, room_slug, ist_date, t0_ms, t1_ms, audio}} "
            "on the first write_track() call for a window."
        )
    missing = [k for k in REQUIRED_MANIFEST_FIELDS if k not in manifest_stub]
    if missing:
        raise ValueError(f"manifest_stub missing required fields: {missing}")


def _write_manifest_entry(root, ist_date, room_id, window_id, manifest_stub, entry, track_path):
    """Read-modify-write manifest.json under manifest.lock; the file itself is only ever replaced
    atomically (never truncated in place). Mirrors to R2 (if enabled) while still holding the lock,
    so a slower concurrent writer can never push a stale manifest after a faster one (B4).

    Returns the mirror's exception if the mirror failed, or None. Raises ONLY for a failure that
    happened before the manifest was durably committed (validation, missing stub, disk error) — those
    are the cases write_track's caller should roll the track file back for. A mirror failure after a
    successful commit is never raised from here (see MirrorPendingError in the module docstring)."""
    window_dir = _window_dir(root, ist_date, room_id, window_id)
    manifest_path = os.path.join(window_dir, "manifest.json")
    lock_path = os.path.join(window_dir, "manifest.lock")
    os.makedirs(window_dir, exist_ok=True)
    lock_fd = _lock(lock_path)
    try:
        if os.path.exists(manifest_path):
            with open(manifest_path) as f:
                manifest = json.load(f)
        else:
            if manifest_stub is None:
                raise ValueError(
                    f"manifest.json does not exist yet for {window_id} and no manifest_stub was given; "
                    "pass manifest_stub={{window_id, room_id, room_slug, ist_date, t0_ms, t1_ms, audio}} "
                    "on the first write_track() call for a window."
                )
            manifest = dict(manifest_stub)
            manifest.setdefault("tracks", [])
        manifest.setdefault("tracks", [])
        manifest["tracks"].append(entry)
        validate_manifest(manifest)
        body = (json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True) + "\n").encode("utf-8")
        _replace_file_atomic(manifest_path, body)
        # manifest is now durably committed — a mirror failure past this point must NOT look like a
        # write failure to the caller (#4619): catch it here, never let it trigger a rollback.
        if r2_mirror.enabled():
            try:
                r2_mirror.mirror_window_files(root, ist_date, room_id, window_id, [track_path, manifest_path])
            except Exception as e:
                return e
        return None
    finally:
        _unlock(lock_fd)


def _append_index_line(root, ist_date, line_obj):
    """Append one line to the date's index.jsonl under its own lock, mirroring (if enabled) while
    still holding that lock so concurrent appends (from different windows the same date) can't mirror
    out of order either. Returns the mirror's exception if the mirror failed, or None (same contract
    as _write_manifest_entry — a mirror failure here never invalidates the already-appended line)."""
    date_dir = os.path.join(root, ist_date)
    index_path = os.path.join(date_dir, "index.jsonl")
    lock_path = os.path.join(date_dir, "index.lock")
    os.makedirs(date_dir, exist_ok=True)
    lock_fd = _lock(lock_path)
    try:
        line = json.dumps(line_obj, ensure_ascii=False, sort_keys=True)
        fd = os.open(index_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
        try:
            _write_all(fd, (line + "\n").encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        if r2_mirror.enabled():
            try:
                r2_mirror.mirror_index(root, ist_date)
            except Exception as e:
                return e
        return None
    finally:
        _unlock(lock_fd)


def write_track(root, ist_date, room_id, window_id, track, manifest_stub=None,
                 started_at=None, finished_at=None, config_hash=None):
    """Write one track file, append its entry to the window's manifest.json, and append one line to
    that date's index.jsonl. Raises ValidationError if `track` doesn't match the schema,
    PathComponentError if any identifier isn't a safe path component, TrackExistsError if this
    exact (layer, engine, version, config_hash) was already written for this window (append-only:
    re-run with a changed config to get a new file instead), or MirrorPendingError if everything
    local succeeded but the R2 mirror (when REB_R2_MIRROR is on) failed — that one is not a write
    failure; see its docstring.

    manifest_stub is only required the FIRST time a window is written to (it seeds manifest.json);
    later calls for the same window ignore it and read the existing manifest. If it's required and
    missing, that's checked BEFORE anything is written to disk, so a failed call never leaves an
    orphaned track file behind (see B1 in the module docstring).

    Note: if the process crashes or raises between the manifest write succeeding and the index.jsonl
    append, the track is already durably correct (visible via the manifest, which is what reb.py
    reads) but missing from that line in index.jsonl; retrying write_track with the same track will
    now raise TrackExistsError rather than repair the index. A separate index-rebuild-from-manifests
    tool would be the fix for that narrow case; not needed at this scale.

    config_hash (optional, default None = unchanged behavior): the expected value of track["config_hash"] when the
    producer's hash is NOT sha256(canonical config)[:8] (e.g. from_hist's per-run cfg8). When given it replaces the
    recomputed hash in the equality check; the hash is still whitelisted as a path component.

    Returns the absolute path of the written track file.
    """
    validate_track(track)
    if track["window_id"] != window_id:
        raise ValueError(f"track['window_id']={track['window_id']!r} != window_id argument {window_id!r}")

    config = track.get("config") or {}
    expected_hash = config_hash if config_hash is not None else _default_config_hash(config)
    if track["config_hash"] != expected_hash:
        raise ValueError(
            f"track['config_hash']={track['config_hash']!r} does not match sha256(config)[:8]="
            f"{expected_hash!r} for config={config!r} — recompute with reb.writer.config_hash(config)"
        )

    for name, value in (("ist_date", ist_date), ("room_id", room_id), ("window_id", window_id),
                        ("layer", track["layer"]), ("engine", track["engine"]),
                        ("version", track["version"]), ("config_hash", track["config_hash"])):
        _check_component(name, value)

    # eta-refuter-3 (#4799 B1): a manifest_stub whose own room_id/ist_date/window_id disagree with
    # this call's arguments used to be accepted silently — the file then lands under the ARGUMENT's
    # path/index (which is what every path-safety and source_kind check above validates), while the
    # STUB's mismatched values just sit unused inside manifest.json, defeating any check that only
    # looked at the stub. Refuse the mismatch outright instead of picking one side to trust.
    if manifest_stub is not None:
        for field, arg_value in (("room_id", room_id), ("ist_date", ist_date), ("window_id", window_id)):
            stub_value = manifest_stub.get(field)
            if stub_value is not None and stub_value != arg_value:
                raise ValueError(
                    f"manifest_stub[{field!r}]={stub_value!r} does not match the {field} argument "
                    f"{arg_value!r} — write_track refuses a mismatched stub rather than silently "
                    "trusting one side (eta-refuter-3 #4799 B1)"
                )

    # B1: fail before touching disk if the manifest step is guaranteed to fail.
    window_dir = _window_dir(root, ist_date, room_id, window_id)
    _assert_under_root(window_dir, root)
    manifest_path = os.path.join(window_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        _check_manifest_stub_required(manifest_stub, window_id)

    tracks_dir = os.path.join(window_dir, "tracks")
    _assert_under_root(tracks_dir, root)
    os.makedirs(tracks_dir, exist_ok=True)

    fname = track_filename(track["layer"], track["engine"], track["version"], track["config_hash"])
    path = os.path.join(tracks_dir, fname)
    _assert_under_root(path, root)

    body = json.dumps(track, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")
    sha256 = _sha256_bytes(body)

    _write_file_atomic_create(path, body)  # raises TrackExistsError, leaves nothing behind, if it does

    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = {
        "layer": track["layer"], "engine": track["engine"], "model": track.get("model"),
        "version": track["version"], "config_hash": track["config_hash"],
        "status": track["status"], "reason": track.get("reason"), "machine": track.get("machine"),
        "started_at": started_at or now, "finished_at": finished_at or now,
        "path": os.path.relpath(path, root), "sha256": sha256,
    }
    try:
        mirror_err_1 = _write_manifest_entry(root, ist_date, room_id, window_id, manifest_stub, entry, path)
    except Exception:
        # this only happens for a failure BEFORE the manifest was committed (see docstring above) —
        # the track file is not yet referenced by anything durable, so it's safe (and correct) to undo.
        try:
            os.unlink(path)  # roll back to the pre-call state (B1) — a retry can then succeed cleanly
        except OSError:
            pass
        raise

    # eta-refuter-3 (#4799 N3): carry source_kind on the index line too, so a consumer can filter
    # room_tape vs suite_synthetic/dev_clip without opening every window's manifest.json. Read it back
    # from the manifest we just committed (cheap: it's a single small file, and this is the one place
    # that reliably knows the manifest's FINAL resolved value regardless of whether this call supplied
    # a stub or not).
    with open(manifest_path) as f:
        source_kind = json.load(f).get("source_kind") or DEFAULT_SOURCE_KIND

    mirror_err_2 = _append_index_line(root, ist_date, {
        "window_id": window_id, "room_id": room_id, "path": os.path.relpath(path, root),
        "layer": track["layer"], "engine": track["engine"], "version": track["version"],
        "config_hash": track["config_hash"], "status": track["status"], "sha256": sha256,
        "source_kind": source_kind,
    })

    # Local state (track file + manifest entry + index line) is durable and correct at this point,
    # regardless of what follows. A mirror failure is real and must be surfaced, but never by
    # rolling back or looking like the write itself failed (#4619).
    mirror_errs = [e for e in (mirror_err_1, mirror_err_2) if e is not None]
    if mirror_errs:
        raise MirrorPendingError(
            f"{path} is written and durable locally, but the R2 mirror failed: "
            f"{'; '.join(str(e) for e in mirror_errs)} — re-mirror separately, do not re-run write_track()"
        ) from mirror_errs[0]

    return path
