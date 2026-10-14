"""Collector (step 4a part 1): fake in-memory R2 + fake index endpoint; no network, no real credentials, nothing under ~/eta-data."""
import hashlib
import json
import os
import threading
import time

import pytest

from kit.reb import collector as C

DATE = "2026-10-01"
ROOM = "room_aaaaaaaa"


class FakeR2:
    """Thread-safe. `delay` maps a key substring to seconds slept inside PUT (to force out-of-order completion); `inflight` records
    the peak number of PUTs running at once."""
    def __init__(self, log):
        self.objects, self.log, self.fail_put, self.delay = {}, log, set(), {}
        self.heads = self.puts = 0
        self._l = threading.Lock()
        self._now = self.peak = 0

    def head(self, key):
        with self._l:
            self.heads += 1
            o = self.objects.get(key)
        return None if o is None else {"sha256": o["sha256"], "size": len(o["body"])}

    def put(self, key, path, sha256):
        with self._l:
            self._now += 1
            self.peak = max(self.peak, self._now)
        try:
            for sub, d in self.delay.items():
                if sub in key:
                    time.sleep(d)
            if key in self.fail_put:
                raise C.CollectorError("R2 PUT failed (Boom)")
            body = open(path, "rb").read()
            with self._l:
                self.puts += 1
                self.objects[key] = {"sha256": sha256, "body": body}
                self.log.append(("put", key))
        finally:
            with self._l:
                self._now -= 1


class FakeIndex:
    """Refuses (AssertionError) any row whose object is not in R2 with the same sha at post time: that is the ordering contract."""
    def __init__(self, r2, log):
        self.r2, self.log, self.posts, self.stored = r2, log, [], {}
        self.script = []   # statuses to answer with, in order; default 200

    def post(self, rows):
        for r in rows:
            assert r["r2_key"] in self.r2.objects, f"row posted before its object: {r['r2_key']}"
            assert self.r2.objects[r["r2_key"]]["sha256"] == r["sha256"]
        self.log.append(("post", len(rows)))
        self.posts.append(rows)
        st = self.script.pop(0) if self.script else 200
        if st not in (200, 409):
            raise C.CollectorError(f"index POST failed (HTTP {st})")
        ins = ex = 0
        conflicts = []
        for r in rows:
            k = (r["window_id"], r["layer"], r["engine"], r["version"], r["config_hash"], r["shadow"])
            if k not in self.stored:
                self.stored[k] = r["sha256"]; ins += 1
            elif self.stored[k] == r["sha256"]:
                ex += 1
            else:
                conflicts.append({"key": "/".join(k[:2]), "stored_sha": self.stored[k], "sent_sha": r["sha256"]})
        return (409 if conflicts else 200), {"inserted": ins, "existing": ex, "conflicts": conflicts}


def add_track(root, win, engine="e1", room=ROOM, date=DATE, body=None, index=True, write_file=True, line_sha=None, t0=1787000000000):
    wdir = os.path.join(root, date, room, win)
    os.makedirs(os.path.join(wdir, "tracks"), exist_ok=True)
    rel = f"{date}/{room}/{win}/tracks/stt.{engine}__v1__cfg00000.json"
    body = body if body is not None else json.dumps({"engine": engine, "win": win}).encode()
    sha = hashlib.sha256(body).hexdigest()
    if write_file:
        open(os.path.join(root, rel), "wb").write(body)
    mp = os.path.join(wdir, "manifest.json")
    m = json.load(open(mp)) if os.path.exists(mp) else {"window_id": win, "room_id": room, "ist_date": date, "t0_ms": t0, "t1_ms": t0 + 900000, "tracks": []}
    m["tracks"].append({"path": rel, "sha256": sha, "model": "mod", "machine": "box1", "reason": None, "started_at": "2026-10-01T10:00:00Z", "finished_at": "2026-10-01T10:01:00+05:30"})
    json.dump(m, open(mp, "w"))
    if index:
        with open(os.path.join(root, date, "index.jsonl"), "ab") as f:
            f.write((json.dumps({"window_id": win, "room_id": room, "path": rel, "layer": "stt", "engine": engine, "version": "v1",
                                 "config_hash": "cfg00000", "status": "ok", "sha256": line_sha or sha}) + "\n").encode())
    return rel, sha


@pytest.fixture(params=[1, 4, 8], ids=lambda n: f"workers={n}")
def env(tmp_path, request):
    root = str(tmp_path / "reb")
    os.makedirs(os.path.join(root, DATE))
    log = []
    r2 = FakeR2(log)
    ix = FakeIndex(r2, log)
    out = str(tmp_path / "out")
    held = lambda day, room: room == "room_blindblind"   # noqa: E731
    return dict(root=root, log=log, r2=r2, ix=ix, out=out, held=held, alarms=os.path.join(out, "alarms.jsonl"), workers=request.param)


def make(env, write=True, **kw):
    kw.setdefault("workers", env["workers"])
    return C.Collector(env["root"], env["held"], r2=env["r2"], index=env["ix"], write=write, alarms_path=env["alarms"], **kw)


def alarms(env):
    return [json.loads(l) for l in open(env["alarms"])] if os.path.exists(env["alarms"]) else []


def offset(env):
    return json.load(open(os.path.join(env["root"], "_collector", "state.json")))["dates"][DATE]["offset"]


def size(env):
    return os.path.getsize(os.path.join(env["root"], DATE, "index.jsonl"))


def test_dry_run_counts_and_touches_nothing(env):
    add_track(env["root"], "w1")
    add_track(env["root"], "w2", write_file=False)                      # quarantined: file missing
    add_track(env["root"], "w3", line_sha="0" * 64)                     # superseded: sha differs
    add_track(env["root"], "w4", room="room_blindblind")                # blind
    open(os.path.join(env["root"], DATE, "index.jsonl"), "ab").write(b"not json\n")
    c = make(env, write=False).run_date(DATE)
    assert (c["lines"], c["live"], c["stale_missing"], c["stale_sha"], c["blind"], c["bad_lines"]) == (5, 1, 1, 1, 1, 1)
    assert (c["would_put"], c["would_index"], c["put"], c["indexed"]) == (1, 1, 0, 0)
    assert env["r2"].heads == env["r2"].puts == 0 and env["ix"].posts == []
    assert not os.path.exists(os.path.join(env["root"], "_collector"))


def test_blind_window_never_leaves_the_box(env):
    add_track(env["root"], "wb", room="room_blindblind")
    c = make(env).run_date(DATE)
    assert c["blind"] == 1 and c["put"] == c["manifest_put"] == 0 and env["r2"].objects == {} and env["ix"].posts == []
    assert offset(env) == size(env)       # resolved, not retried forever


def test_blind_when_the_window_straddles_into_a_blind_day(env):
    add_track(env["root"], "wx")
    held = lambda day, room: day == "2026-10-02"    # noqa: E731
    env["held"] = held
    # t0 on 10-01 IST, but t1-1s falls on 10-02 IST => blind
    t1 = 1790899200000   # 2026-10-02 05:30 IST
    mp = os.path.join(env["root"], DATE, ROOM, "wx", "manifest.json")
    m = json.load(open(mp)); m["t0_ms"] = t1 - 600000; m["t1_ms"] = t1 + 300000; json.dump(m, open(mp, "w"))
    assert make(env).run_date(DATE)["blind"] == 1


def test_put_then_index_in_order_with_manifest(env):
    rel, sha = add_track(env["root"], "w1")
    add_track(env["root"], "w1", engine="e2")
    c = make(env).run_date(DATE)
    assert (c["put"], c["manifest_put"], c["indexed"]) == (2, 1, 2)       # manifest pushed once per window
    assert env["log"][-1] == ("post", 2) and all(e[0] == "put" for e in env["log"][:-1])
    assert f"reb/{DATE}/{ROOM}/w1/manifest.json" in env["r2"].objects
    row = env["ix"].posts[0][0]
    assert row["r2_key"] == "reb/" + rel and row["sha256"] == sha and row["shadow"] is False and row["ist_date"] == DATE
    assert row["machine"] == "box1" and row["t0_ms"] == 1787000000000 and row["finished_at"] == "2026-10-01T10:01:00+05:30" and row["bytes"] > 0
    assert offset(env) == size(env)


def test_head_present_same_sha_skips_put_but_still_indexes(env):
    rel, sha = add_track(env["root"], "w1")
    env["r2"].objects["reb/" + rel] = {"sha256": sha, "body": b"x"}
    c = make(env).run_date(DATE)
    assert c["r2_present"] >= 1 and c["put"] == 0 and c["indexed"] == 1


def test_head_present_different_sha_alarms_and_is_not_indexed(env):
    rel, sha = add_track(env["root"], "w1")
    add_track(env["root"], "w2")
    env["r2"].objects["reb/" + rel] = {"sha256": "f" * 64, "body": b"theirs"}
    c = make(env).run_date(DATE)
    assert c["r2_conflict"] == 1 and c["put"] == 1 and c["indexed"] == 1
    assert env["r2"].objects["reb/" + rel]["body"] == b"theirs"                        # never overwritten
    assert [r["r2_key"] for p in env["ix"].posts for r in p] == [f"reb/{DATE}/{ROOM}/w2/tracks/stt.e1__v1__cfg00000.json"]
    a = alarms(env)
    assert a[0]["kind"] == "r2_conflict" and a[0]["stored_sha"] == "f" * 64 and a[0]["local_sha"] == sha
    assert offset(env) == size(env)


def test_object_without_sha_metadata_is_a_conflict_not_an_overwrite(env):
    rel, _ = add_track(env["root"], "w1")
    env["r2"].objects["reb/" + rel] = {"sha256": None, "body": b"?"}
    c = make(env).run_date(DATE)
    assert c["r2_conflict"] == 1 and c["indexed"] == 0 and alarms(env)[0]["reason"] == "no_sha_metadata"


def test_manifest_overwrite_allowed(env):
    add_track(env["root"], "w1")
    env["r2"].objects[f"reb/{DATE}/{ROOM}/w1/manifest.json"] = {"sha256": "0" * 64, "body": b"old"}
    c = make(env).run_date(DATE)
    assert c["manifest_put"] == 1 and env["r2"].objects[f"reb/{DATE}/{ROOM}/w1/manifest.json"]["body"] != b"old"


def test_r2_put_failure_means_no_row_for_that_line_and_state_stops_before_it(env):
    add_track(env["root"], "w1")
    rel2, _ = add_track(env["root"], "w2")
    add_track(env["root"], "w3")
    env["r2"].fail_put.add("reb/" + rel2)
    c = make(env).run_date(DATE)
    assert c["errors"] == 1 and c["indexed"] == 1
    assert [r["window_id"] for p in env["ix"].posts for r in p] == ["w1"]       # w2 and w3 never indexed
    first_line_end = len(open(os.path.join(env["root"], DATE, "index.jsonl"), "rb").readline())
    assert offset(env) == first_line_end
    env["r2"].fail_put.clear()
    c2 = make(env).run_date(DATE)           # resumes at w2
    assert c2["lines"] == 2 and c2["indexed"] == 2 and offset(env) == size(env)


def test_409_is_alarmed_counted_and_never_retried(env):
    add_track(env["root"], "w1")
    env["ix"].stored[("w1", "stt", "e1", "v1", "cfg00000", False)] = "9" * 64      # someone already indexed another sha
    c = make(env).run_date(DATE)
    assert c["index_conflicts"] == 1 and len(env["ix"].posts) == 1 and c["errors"] == 0
    assert alarms(env)[0]["kind"] == "index_conflict" and offset(env) == size(env)


def test_batches_of_500(env):
    for i in range(1201):
        add_track(env["root"], f"w{i:04d}")
    c = make(env).run_date(DATE)
    assert [len(p) for p in env["ix"].posts] == [500, 500, 201] and c["indexed"] == 1201
    assert max(len(p) for p in env["ix"].posts) <= C.BATCH == 500


def test_state_advances_only_past_fully_successful_batches(env):
    for i in range(5):
        add_track(env["root"], f"w{i}")
    env["ix"].script = [200, 503]
    c = make(env, batch=2).run_date(DATE)
    assert c["errors"] == 1 and c["indexed"] == 2
    lines = open(os.path.join(env["root"], DATE, "index.jsonl"), "rb").readlines()
    assert offset(env) == len(lines[0]) + len(lines[1])
    c2 = make(env, batch=2).run_date(DATE)
    assert c2["lines"] == 3 and offset(env) == size(env)


def test_rerun_is_idempotent_even_without_state(env):
    for i in range(3):
        add_track(env["root"], f"w{i}")
    make(env).run_date(DATE)
    puts = env["r2"].puts
    c = make(env).run_date(DATE)
    assert c["lines"] == 0 and env["r2"].puts == puts
    os.unlink(os.path.join(env["root"], "_collector", "state.json"))
    c = make(env).run_date(DATE)
    assert c["lines"] == 3 and c["put"] == c["manifest_put"] == 0 and c["indexed"] == 0 and c["index_existing"] == 3 and env["r2"].puts == puts


def test_partial_last_line_is_not_read(env):
    add_track(env["root"], "w1")
    open(os.path.join(env["root"], DATE, "index.jsonl"), "ab").write(b'{"window_id": "w2", "pa')
    c = make(env, write=False).run_date(DATE)
    assert c["lines"] == 1 and c["bad_lines"] == 0


def test_limit(env):
    for i in range(4):
        add_track(env["root"], f"w{i}")
    c = make(env, limit=3).run_date(DATE)
    assert c["lines"] == 3 and c["indexed"] == 3


def test_no_r2_with_index_is_refused(env):
    with pytest.raises(C.CollectorError):
        make(env, use_r2=False)
    assert C.main(["--all", "--no-r2"], root=env["root"], out_dir=env["out"], is_held=env["held"]) == 2
    assert C.main(["--all", "--write", "--no-r2"], root=env["root"], out_dir=env["out"], is_held=env["held"]) == 2


def test_r2_only_mode_posts_nothing_and_leaves_state_alone(env):
    add_track(env["root"], "w1")
    c = make(env, use_index=False).run_date(DATE)
    assert c["put"] == 1 and env["ix"].posts == [] and not os.path.exists(os.path.join(env["root"], "_collector", "state.json"))


def test_write_without_credential_files_is_a_dry_run(env, capsys, monkeypatch):
    add_track(env["root"], "w1")
    rc = C.main(["--all", "--write"], root=env["root"], out_dir=env["out"], is_held=env["held"], r2=env["r2"], index=env["ix"], env={})
    assert rc == 0
    cap = capsys.readouterr()
    assert "DRY RUN regardless" in cap.err and "REB_R2_WRITE_KEY_FILE" in cap.err and cap.out.startswith("DRY-RUN")
    assert env["r2"].puts == 0 and env["ix"].posts == [] and not os.path.exists(os.path.join(env["root"], "_collector"))


def test_main_dry_run_default_and_log_is_counts_only(env):
    rel, _ = add_track(env["root"], "w1")
    rc = C.main(["--all"], root=env["root"], out_dir=env["out"], is_held=env["held"], r2=env["r2"], index=env["ix"], env={})
    assert rc == 0
    log = [f for f in os.listdir(env["out"]) if f.startswith("collector-") and f.endswith(".log")]
    text = open(os.path.join(env["out"], log[0])).read()
    assert "TOTAL" in text and "would_put=1" in text and rel not in text and "w1" not in text


def test_write_mode_end_to_end_with_credential_files_and_lock(env, tmp_path):
    add_track(env["root"], "w1")
    k, t = tmp_path / "k", tmp_path / "t"
    k.write_text("id\nsecret\nhttps://x\n"); t.write_text("tok\n")
    e = {"REB_R2_WRITE_KEY_FILE": str(k), "REB_INDEX_TOKEN_FILE": str(t), "REB_INDEX_BASE_URL": "https://eta.example"}
    import fcntl
    rc = C.main(["--all", "--write"], root=env["root"], out_dir=env["out"], is_held=env["held"], r2=env["r2"], index=env["ix"], env=e)
    assert rc == 0 and env["ix"].posts and offset(env) == size(env)
    # a second collector cannot take the lock
    lk = os.open(os.path.join(env["root"], "_collector", "collector.lock"), os.O_RDWR)
    fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        assert C.main(["--all", "--write"], root=env["root"], out_dir=env["out"], is_held=env["held"], r2=env["r2"], index=env["ix"], env=e) == 3
    finally:
        os.close(lk)


def test_no_secret_in_exception_text(tmp_path, monkeypatch):
    t = tmp_path / "t"; t.write_text("SECRET-TOKEN-VALUE\n")

    def boom(req, timeout=0):
        raise OSError("connect failed for header Bearer SECRET-TOKEN-VALUE")
    monkeypatch.setattr(C.urllib.request, "urlopen", boom)
    with pytest.raises(C.CollectorError) as ei:
        C.HttpIndex("https://eta.example", str(t)).post([{}])
    assert "SECRET-TOKEN-VALUE" not in str(ei.value) and "Bearer" not in str(ei.value)


def test_path_must_stay_under_its_date(env):
    add_track(env["root"], "w1")
    with open(os.path.join(env["root"], DATE, "index.jsonl"), "ab") as f:
        f.write((json.dumps({"window_id": "w", "room_id": ROOM, "path": "../../etc/passwd", "layer": "stt", "engine": "e", "version": "v",
                             "config_hash": "c", "status": "ok", "sha256": "0" * 64}) + "\n").encode())
    c = make(env, write=False).run_date(DATE)
    assert c["bad_lines"] == 1 and c["live"] == 1


def test_row_uses_the_manifest_entry_whose_sha_is_the_live_sha(env):
    rel, sha = add_track(env["root"], "w1")
    mp = os.path.join(env["root"], DATE, ROOM, "w1", "manifest.json")
    m = json.load(open(mp))
    live = m["tracks"][0]
    live.update(reason="pull_failed", machine="live-box", started_at="2026-10-01T12:00:00Z", finished_at="2026-10-01T12:05:00Z")
    stale = dict(live, sha256="e" * 64, reason="push_rc_255", machine="stale-box", started_at="2026-09-15T01:00:00Z", finished_at="2026-09-15T01:01:00Z")
    m["tracks"] = [stale, live]          # the stale entry comes FIRST, as in the store
    json.dump(m, open(mp, "w"))
    make(env).run_date(DATE)
    row = env["ix"].posts[0][0]
    assert (row["reason"], row["machine"], row["started_at"]) == ("pull_failed", "live-box", "2026-10-01T12:00:00Z")
    # reversed order gives the same answer
    m["tracks"] = [live, stale]
    json.dump(m, open(mp, "w"))
    c = make(env, write=False)
    assert c._row(DATE, json.loads(open(os.path.join(env["root"], DATE, "index.jsonl")).readline()), m, os.path.join(env["root"], rel), sha, 1)["reason"] == "pull_failed"


def test_row_with_no_entry_for_the_live_sha_falls_back_to_the_track_body(env):
    rel, sha = add_track(env["root"], "w1", body=json.dumps({"model": "from-body", "machine": "body-box", "reason": "r"}).encode())
    mp = os.path.join(env["root"], DATE, ROOM, "w1", "manifest.json")
    m = json.load(open(mp))
    m["tracks"][0]["sha256"] = "d" * 64          # the only entry on this path is for some other body
    json.dump(m, open(mp, "w"))
    make(env).run_date(DATE)
    row = env["ix"].posts[0][0]
    assert (row["model"], row["machine"], row["reason"], row["started_at"], row["finished_at"]) == ("from-body", "body-box", "r", None, None)


# ------------------------------------------------------------------ concurrency (run at workers 1/4/8 by the env fixture; these pin 8)
@pytest.fixture
def env8(env):
    env["workers"] = 8
    return env


def window_key(win):
    return f"reb/{DATE}/{ROOM}/{win}/tracks/stt.e1__v1__cfg00000.json"


def test_concurrency_really_overlaps(env8):
    for i in range(16):
        add_track(env8["root"], f"w{i:02d}")
    env8["r2"].delay = {"/tracks/": 0.05}
    c = make(env8).run_date(DATE)
    assert c["put"] == 16 and c["manifest_put"] == 16 and c["indexed"] == 16
    assert env8["r2"].peak > 1


def test_out_of_order_completion_still_posts_rows_in_file_order_after_their_objects(env8):
    for i in range(8):
        add_track(env8["root"], f"w{i}")
    env8["r2"].delay = {"/w0/tracks/": 0.2, "/w1/tracks/": 0.1}    # the first lines finish LAST
    c = make(env8).run_date(DATE)
    assert c["indexed"] == 8 and len(env8["ix"].posts) == 1           # the index fake asserts every object was already in R2
    assert [r["window_id"] for r in env8["ix"].posts[0]] == [f"w{i}" for i in range(8)]
    assert offset(env8) == size(env8)


def test_failure_in_the_middle_of_a_batch_posts_only_the_prefix_and_stops_the_offset_there(env8):
    for i in range(20):
        add_track(env8["root"], f"w{i:02d}")
    env8["r2"].fail_put.add(window_key("w07"))
    env8["r2"].delay = {"/w07/tracks/": 0.1}      # lines 8..20 are confirmed in R2 before line 7 fails
    c = make(env8).run_date(DATE)
    assert c["errors"] == 1
    assert [r["window_id"] for p in env8["ix"].posts for r in p] == [f"w{i:02d}" for i in range(7)]    # w00..w06 only
    lines = open(os.path.join(env8["root"], DATE, "index.jsonl"), "rb").readlines()
    assert offset(env8) == sum(len(l) for l in lines[:7])
    assert window_key("w15") in env8["r2"].objects                      # confirmed, but NOT indexed in this pass
    assert ("w15", "stt", "e1", "v1", "cfg00000", False) not in env8["ix"].stored
    env8["r2"].fail_put.clear()
    c2 = make(env8).run_date(DATE)                                      # resumes at line 8; idempotent for the objects already there
    assert c2["lines"] == 13 and c2["indexed"] == 13 and offset(env8) == size(env8)
    assert len(env8["ix"].stored) == 20


def test_index_500_on_a_later_batch_stops_the_offset_at_the_end_of_the_last_accepted_batch(env8):
    for i in range(12):
        add_track(env8["root"], f"w{i:02d}")
    env8["ix"].script = [200, 503]
    c = make(env8, batch=5).run_date(DATE)
    assert c["errors"] == 1 and c["indexed"] == 5 and len(env8["ix"].posts) == 2          # the failed batch is not retried in this pass
    lines = open(os.path.join(env8["root"], DATE, "index.jsonl"), "rb").readlines()
    assert offset(env8) == sum(len(l) for l in lines[:5])
    c2 = make(env8, batch=5).run_date(DATE)
    assert c2["lines"] == 7 and offset(env8) == size(env8) and len(env8["ix"].stored) == 12


def test_conflict_in_the_middle_is_resolved_alarmed_and_does_not_block_later_rows(env8):
    for i in range(10):
        add_track(env8["root"], f"w{i}")
    env8["r2"].objects[window_key("w3")] = {"sha256": "f" * 64, "body": b"theirs"}
    c = make(env8).run_date(DATE)
    assert c["r2_conflict"] == 1 and c["indexed"] == 9 and c["errors"] == 0
    assert env8["r2"].objects[window_key("w3")]["body"] == b"theirs"
    assert [a["kind"] for a in alarms(env8)] == ["r2_conflict"] and offset(env8) == size(env8)


def test_manifest_failure_withholds_every_row_of_that_window_only(env8):
    add_track(env8["root"], "wa")
    add_track(env8["root"], "wa", engine="e2")
    add_track(env8["root"], "wb")
    env8["r2"].fail_put.add(f"reb/{DATE}/{ROOM}/wa/manifest.json")
    c = make(env8).run_date(DATE)
    assert c["errors"] == 1 and env8["ix"].posts == [] and offset(env8) == 0       # wa is line 1: nothing before it is resolved
    env8["r2"].fail_put.clear()
    c2 = make(env8).run_date(DATE)
    assert c2["indexed"] == 3 and offset(env8) == size(env8)


def test_counters_are_exact_under_threads(env8):
    for i in range(60):
        add_track(env8["root"], f"w{i:02d}")
    c = make(env8).run_date(DATE)
    assert (c["live"], c["put"], c["manifest_put"], c["indexed"]) == (60, 60, 60, 60) and env8["r2"].puts == 120


def test_workers_flag_is_bounded(env):
    for bad in ("0", "17", "-1"):
        assert C.main(["--all", "--workers", bad], root=env["root"], out_dir=env["out"], is_held=env["held"]) == 2
    with pytest.raises(C.CollectorError):
        C.Collector(env["root"], env["held"], workers=17)
