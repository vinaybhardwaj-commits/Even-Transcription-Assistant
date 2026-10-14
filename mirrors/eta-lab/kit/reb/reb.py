"""REB-SPEC-v1.md section 5 — the consumer-facing reader API.
load_window(window_id) -> Window; Window.tracks(layer, engine=None, latest_ok=True); Window.segments_between(t0_ms, t1_ms, ...).
Read-only: this module never creates or edits anything under the REB root (see writer.py for that).
"""
import glob
import json
import os

from .schema import DEFAULT_CLOCK, DEFAULT_SOURCE_KIND

DEFAULT_ROOT = os.environ.get("REB_ROOT", os.path.expanduser("~/eta-data/reb"))


class WindowNotFoundError(LookupError):
    pass


class Track:
    """One track file plus the manifest's bookkeeping entry for it (status/reason/machine/timestamps).

    superseded_by is set only when this Track is the latest OK run for its (layer, engine), but a
    LATER, non-ok run of the same engine exists too (a re-run that failed after a previous success).
    It's the newer entry's own bookkeeping dict {status, reason, machine, finished_at, config_hash,
    ...} — never hidden, never silently dropped (see tracks()'s docstring, router-fix/lid-debug
    #4751/#4752)."""

    def __init__(self, entry, body, path, superseded_by=None):
        self.entry = entry
        self.body = body
        self.path = path
        self.superseded_by = superseded_by

    def __getattr__(self, name):
        # schema/window_id/layer/engine/model/version/config/config_hash/machine/status/reason/segments
        if name in self.body:
            return self.body[name]
        raise AttributeError(name)

    @property
    def segments(self):
        return self.body.get("segments") or []

    def __repr__(self):
        return f"<Track {self.entry.get('layer')}.{self.entry.get('engine')} status={self.entry.get('status')} {self.path}>"


class Window:
    def __init__(self, root, manifest, manifest_path):
        self.root = root
        self.manifest = manifest
        self.manifest_path = manifest_path
        self.window_id = manifest["window_id"]
        self.room_id = manifest["room_id"]
        self.room_slug = manifest.get("room_slug")
        self.ist_date = manifest["ist_date"]
        self.t0_ms = manifest["t0_ms"]
        self.t1_ms = manifest["t1_ms"]
        self.audio = manifest.get("audio")
        # source_kind (room_tape | suite_synthetic | dev_clip) and clock (tape_utc | approx |
        # clip_local) default to the "every window before this field existed" values (bus #4783/#4784).
        # Anything that aggregates real rooms (day record, viewer rollups, S2) must filter
        # source_kind == "room_tape"; DEV/eval tooling filters the others explicitly.
        self.source_kind = manifest.get("source_kind") or DEFAULT_SOURCE_KIND
        self.clock = manifest.get("clock") or DEFAULT_CLOCK

    def _matching_entries(self, layer=None, engine=None):
        for e in self.manifest.get("tracks", []):
            if layer is not None and e.get("layer") != layer:
                continue
            if engine is not None and e.get("engine") != engine:
                continue
            yield e

    def tracks(self, layer=None, engine=None, latest_ok=True):
        """Return Track objects for this window.

        With latest_ok=True (default): for each distinct (layer, engine) matching layer/engine,
        return exactly one Track — never silently omitted, even if every run failed (L4: a reader
        must be able to tell "this engine failed" apart from "REB never wrote anything here").
        Picked as: the latest status=="ok" run if one exists (that's the evidence a consumer should
        read); if a LATER run of the same engine is not ok, it's attached as `.superseded_by` on the
        returned Track rather than replacing it or being dropped — a good run doesn't stop being good
        evidence just because a later retry failed. If NO run is ever ok, the latest run (whatever its
        status) is returned so the failure/skip itself is visible.

        With latest_ok=False: return every entry ever written (every re-run, every status), oldest
        first, for callers that want the full history (e.g. a fuser scoring engine drift over runs)."""
        entries = list(self._matching_entries(layer, engine))
        if not latest_ok:
            out = []
            for e in entries:
                path = os.path.join(self.root, e["path"])
                with open(path) as f:
                    body = json.load(f)
                out.append(Track(e, body, path))
            return out

        groups = {}
        for e in entries:
            groups.setdefault((e.get("layer"), e.get("engine")), []).append(e)

        out = []
        for group in groups.values():
            group_sorted = sorted(group, key=lambda e: e.get("finished_at") or "")
            latest_overall = group_sorted[-1]
            ok_entries = [e for e in group_sorted if e.get("status") == "ok"]
            if ok_entries:
                chosen = ok_entries[-1]
                superseded_by = latest_overall if latest_overall is not chosen else None
            else:
                chosen = latest_overall
                superseded_by = None
            path = os.path.join(self.root, chosen["path"])
            with open(path) as f:
                body = json.load(f)
            out.append(Track(chosen, body, path, superseded_by=superseded_by))
        return out

    def segments_between(self, t0_ms, t1_ms, layer=None, engine=None, latest_ok=True):
        """Segments (from any matching track) whose span overlaps [t0_ms, t1_ms). Each segment dict
        comes back annotated with '_track' provenance {layer, engine, version, config_hash} so a
        caller (or a fuser) can tell which engine a segment came from."""
        out = []
        for tr in self.tracks(layer=layer, engine=engine, latest_ok=latest_ok):
            prov = {"layer": tr.entry.get("layer"), "engine": tr.entry.get("engine"),
                    "version": tr.entry.get("version"), "config_hash": tr.entry.get("config_hash")}
            for seg in tr.segments:
                s0, s1 = seg.get("t0_ms"), seg.get("t1_ms")
                if s0 is None or s1 is None:
                    continue
                if s1 > t0_ms and s0 < t1_ms:
                    out.append({**seg, "_track": prov})
        out.sort(key=lambda s: s["t0_ms"])
        return out


def _find_manifest_path(root, window_id, ist_date=None, room_id=None):
    if ist_date and room_id:
        p = os.path.join(root, ist_date, room_id, window_id, "manifest.json")
        return p if os.path.exists(p) else None
    if ist_date:
        for p in glob.glob(os.path.join(root, ist_date, "*", window_id, "manifest.json")):
            return p
        return None
    # No date hint: fall back to scanning every date's index.jsonl (newest date first), since
    # window_id alone doesn't encode a date. Callers on a hot path should pass ist_date/room_id.
    for index_path in sorted(glob.glob(os.path.join(root, "*", "index.jsonl")), reverse=True):
        date_dir = os.path.dirname(index_path)
        with open(index_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                if rec.get("window_id") == window_id:
                    p = os.path.join(date_dir, rec["room_id"], window_id, "manifest.json")
                    if os.path.exists(p):
                        return p
    return None


def load_window(window_id, ist_date=None, room_id=None, root=None):
    """Load a Window by id. Pass ist_date (and room_id) when known — it's an O(1) path lookup instead
    of a scan over every date's index.jsonl."""
    root = root or DEFAULT_ROOT
    manifest_path = _find_manifest_path(root, window_id, ist_date, room_id)
    if manifest_path is None:
        raise WindowNotFoundError(f"no manifest.json found for window_id={window_id!r} under {root}")
    with open(manifest_path) as f:
        manifest = json.load(f)
    return Window(root, manifest, manifest_path)
