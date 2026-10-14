"""REB-SPEC-v1.md section 5 — the consumer-facing reader API.
load_window(window_id) -> Window; Window.tracks(layer, engine=None, latest_ok=True); Window.segments_between(t0_ms, t1_ms, ...).
Read-only: this module never creates or edits anything under the REB root (see writer.py for that).
"""
import glob
import json
import os
import re
from datetime import datetime, timezone

from .schema import DEFAULT_CLOCK, DEFAULT_SOURCE_KIND

DEFAULT_ROOT = os.environ.get("REB_ROOT", os.path.expanduser("~/eta-data/reb"))


def _parse_finished_at(v):
    """finished_at as a comparable value. eta-refuter-3 (#4796): a raw string compare breaks across
    timezones/formats (an ok run logged "15:00+05:30" sorts AFTER a later failure logged "09:40Z" even
    though 09:40Z is the later moment in absolute time). Parse to a UTC-aware datetime; anything that
    won't parse sorts as the oldest possible value rather than crashing or silently winning ties."""
    if not v:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


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

    def _resolve_entry(self, e):
        """-> (Track) for one manifest entry. A file present at its path loads normally. The manifest is append-only, so an entry
        whose file was moved into tracks/_quarantine-*/ (same name) comes back as a Track with status "quarantined" and
        extras.quarantine_dir, its body NOT loaded. Missing from tracks/ AND every quarantine dir is an integrity alarm: raises
        FileNotFoundError naming the path."""
        path = os.path.join(self.root, e["path"])
        if os.path.exists(path):
            with open(path) as f:
                return Track(e, json.load(f), path)
        qhits = sorted(glob.glob(os.path.join(os.path.dirname(path), "_quarantine-*", os.path.basename(path))))
        if not qhits:
            raise FileNotFoundError(f"manifest entry points at a missing track file (not in any tracks/_quarantine-*/ either): {path}")
        qdir = os.path.dirname(qhits[0])
        qentry = dict(e, status="quarantined", original_status=e.get("status"), quarantine_dir=qdir)
        body = {"schema": "reb.track.v1", "window_id": self.window_id, "layer": e.get("layer"), "engine": e.get("engine"),
                "model": e.get("model"), "version": e.get("version"), "config_hash": e.get("config_hash"),
                "machine": e.get("machine"), "status": "quarantined", "reason": "file moved to a quarantine dir; body not loaded",
                "segments": [], "extras": {"quarantine_dir": qdir}}
        return Track(qentry, body, qhits[0])

    def tracks(self, layer=None, engine=None, latest_ok=True):
        """Return Track objects for this window.

        With latest_ok=True (default): for each distinct (layer, engine, config_hash) matching
        layer/engine, return exactly one Track — never silently omitted, even if every run failed
        (L4: a reader must be able to tell "this engine failed" apart from "REB never wrote anything
        here"). Grouping includes config_hash (eta-refuter-2, #4803): two configs of the SAME engine
        (e.g. a fuser's v0 and v0-noETR arms) are different evidence, not reruns of each other — a
        later-finished config must never make an earlier DIFFERENT config's track disappear. Within
        one (layer, engine, config_hash) group, the pick is: the latest status=="ok" run if one
        exists (the evidence a consumer should read); if a LATER run of that exact config is not ok,
        it's attached as `.superseded_by` rather than replacing or hiding the good evidence. If NO run
        of that config is ever ok, the latest run (whatever its status) is returned so the failure/
        skip itself is visible. A consumer that wants "collapse across configs too, best available"
        can post-filter this method's result itself; the default never merges configs together.

        With latest_ok=False: return every entry ever written (every re-run, every status), oldest
        first, for callers that want the full history (e.g. a fuser scoring engine drift over runs).

        A manifest entry whose file now lives under tracks/_quarantine-*/ has status "quarantined" (extras.quarantine_dir; body not
        loaded): excluded from latest_ok=True results, listed with latest_ok=False. An entry missing everywhere still raises."""
        entries = list(self._matching_entries(layer, engine))
        if not latest_ok:
            return [self._resolve_entry(e) for e in entries]

        groups = {}
        for e in entries:
            if not os.path.exists(os.path.join(self.root, e["path"])):
                self._resolve_entry(e)   # quarantined => excluded below; missing everywhere => raises here
                continue
            groups.setdefault((e.get("layer"), e.get("engine"), e.get("config_hash")), []).append(e)

        out = []
        for group in groups.values():
            group_sorted = sorted(group, key=lambda e: _parse_finished_at(e.get("finished_at")))
            latest_overall = group_sorted[-1]
            ok_entries = [e for e in group_sorted if e.get("status") == "ok"]
            if ok_entries:
                chosen = ok_entries[-1]
                superseded_by = latest_overall if latest_overall is not chosen else None
            else:
                chosen = latest_overall
                superseded_by = None
            tr = self._resolve_entry(chosen)
            tr.superseded_by = superseded_by
            out.append(tr)
        return out

    def encounters(self):
        """The window's current encounter-layer track: among encounter tracks that are not quarantined, the one with the latest
        finished_at (ties: the later manifest entry), whatever its status; None if there is none. Unlike tracks(), this does NOT
        keep one track per config_hash: an encounter source change makes a new cfg8, and the newest read supersedes the older one.
        Other layers are unchanged. A quarantined-only window returns None; an entry missing everywhere still raises."""
        live = []
        for i, e in enumerate(self._matching_entries("encounter", None)):
            if not os.path.exists(os.path.join(self.root, e["path"])):
                self._resolve_entry(e)   # quarantined => skipped; missing everywhere => raises
                continue
            live.append((_parse_finished_at(e.get("finished_at")), i, e))
        if not live:
            return None
        return self._resolve_entry(max(live, key=lambda x: (x[0], x[1]))[2])

    def segments_between(self, t0_ms, t1_ms, layer=None, engine=None, latest_ok=True):
        """Segments (from any matching status=="ok" track) whose span overlaps [t0_ms, t1_ms). Each
        segment dict comes back annotated with '_track' provenance {layer, engine, version,
        config_hash} so a caller (or a fuser) can tell which engine a segment came from.

        A failed/skipped track's segments (if the writer put any there — the schema allows it, e.g.
        a partial result before the engine errored) are NEVER read as evidence here (eta-refuter-3,
        #4796): tracks(latest_ok=True) must surface a failure so a caller can SEE it happened, but
        segments_between must not silently hand back that failure's content as if it were real
        transcript. Use tracks() directly (and check .status) if you need to inspect a failed run."""
        out = []
        for tr in self.tracks(layer=layer, engine=engine, latest_ok=latest_ok):
            if tr.status != "ok":
                continue
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


_PLAIN_WINDOW_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")   # every window id in the store (c-.., o-.., l3-c003-r1, L041) is of this form; none starts with a dot or contains a path part


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
    # 13A: a window registered with writer.write_manifest (the orphan tape windows) has a manifest but no track, so no index.jsonl line yet: look for its dir directly
    # (the id must be a plain window-id token, so no glob metacharacter or path part can widen the match; the id is also glob-escaped; newest date first)
    if window_id and _PLAIN_WINDOW_ID.match(window_id):
        for p in sorted(glob.glob(os.path.join(root, "20*", "*", glob.escape(window_id), "manifest.json")), reverse=True):
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


def _consult_manifest_paths(root, ist_date=None, room_id=None, consult_uid=None):
    d, r, u = ist_date or "*", room_id or "*", consult_uid or "*"
    return sorted(glob.glob(os.path.join(root, d, r, "_consults", u, "manifest.json")))


def consults(ist_date, room_id=None, root=None):
    """Consult-scope (CONSULT-cutter clip) manifests of a day as Windows (ORDERS-6S3): reb/<date>/<room>/_consults/<uid>/. Each
    Window's .tracks() / .encounters() work as for a window; its manifest carries the cutter provenance and `window_ids`."""
    root = root or DEFAULT_ROOT
    out = []
    for p in _consult_manifest_paths(root, ist_date, room_id):
        with open(p) as f:
            out.append(Window(root, json.load(f), p))
    return out


def consult(consult_uid, ist_date=None, room_id=None, root=None):
    """One consult-scope Window by consult_uid (its latest tracks via .tracks()). Raises WindowNotFoundError if absent."""
    root = root or DEFAULT_ROOT
    ps = _consult_manifest_paths(root, ist_date, room_id, consult_uid)
    if not ps:
        raise WindowNotFoundError(f"no consult manifest for consult_uid={consult_uid!r} under {root}")
    with open(ps[0]) as f:
        return Window(root, json.load(f), ps[0])


def windows_for(consult_uid, ist_date=None, room_id=None, root=None):
    """window_ids of the REB windows the consult's span overlaps (recorded in the consult manifest when it was first written)."""
    return list(consult(consult_uid, ist_date, room_id, root).manifest.get("window_ids") or [])


def encounters(window_id, ist_date=None, room_id=None, root=None):
    """load_window(window_id).encounters(): the latest-finished_at non-quarantined encounter Track, or None."""
    return load_window(window_id, ist_date=ist_date, room_id=room_id, root=root).encounters()


def real_room_windows(windows):
    """Filter to windows that are actual real-room recordings (eta-refuter-2, #4805 S3): dev_clip rows
    carry a real room_id too (they genuinely are real-room audio) but are NOT part of the continuous
    day record, so anything that aggregates real rooms — the day record, viewer rollups, S2 — must use
    this filter (or check .source_kind == "room_tape" itself) rather than just "has a real room_id"."""
    return [w for w in windows if w.source_kind == DEFAULT_SOURCE_KIND]
