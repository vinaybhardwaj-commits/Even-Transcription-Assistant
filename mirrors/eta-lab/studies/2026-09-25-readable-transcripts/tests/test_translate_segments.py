"""Tests for translate_segments.py on INVENTED data only (fake transport). No real text, no network, no key."""
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import translate_segments as T
L = T.L
L._sleep = lambda s: None

KN, HI, UND, PA, EN = "KN-line-", "HI-line-", "UND-line-", "PA-line-", "EN-line-"           # invented stand-ins for native lines
NOW = datetime(2026, 9, 25, 4, 0, tzinfo=timezone.utc)                                          # 09:30 IST
LATER = datetime(2026, 9, 25, 5, 0, tzinfo=timezone.utc)


def tr(l):
    return "EN:" + l[::-1]                                                                      # a stand-in translation that does not contain its source


def user_lines(body):
    user = body["messages"][1]["content"]
    return [l.split(". ", 1)[1] for l in user.split("\n\n", 1)[1].split("\n")]


def jload(p):
    with open(p) as f:
        return json.load(f)


def jdump(p, o):
    with open(p, "w") as f:
        json.dump(o, f)


def sha(p):
    with open(p, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class Fake:
    """mode: 'ok'; 'malformed' (every reply lacks line 1); 'poison' (a reply holding POISON is malformed); 'flipprov' (provider changes on call 2); 'badmodel'; 'http500'; 'garbled' (q garbled)."""
    def __init__(self, mode="ok"):
        self.mode, self.calls, self.sent = mode, 0, []

    def __call__(self, body):
        self.calls += 1
        lines = user_lines(body); self.sent += lines
        if self.mode == "http500":
            return 500, None
        prov = "Google" if not (self.mode == "flipprov" and self.calls >= 2) else "Other"
        model = L.MODEL if self.mode != "badmodel" else "some/other-model"
        if self.mode == "malformed" or (self.mode == "poison" and any("POISON" in l for l in lines)):
            content = json.dumps({str(k + 2): {"t": "x", "q": "ok"} for k in range(len(lines))})
        else:
            q = "garbled" if self.mode == "garbled" else "ok"
            content = json.dumps({str(k + 1): {"t": tr(l), "q": q} for k, l in enumerate(lines)})
        return 200, dict(model=model, provider=prov, choices=[dict(message=dict(content=content))])


def make_world(tmp, spec):
    """spec: {key: (date, start, [(lang, text)], 'payload'|'top', room)}. Returns (index path, roots)."""
    root = os.path.join(tmp, "root") + "/"
    rows = []
    for key, (date, start, segs, shape, room) in spec.items():
        os.makedirs(os.path.dirname(root + key), exist_ok=True)
        ss = [dict(lang=l, text=t, start_s=i, end_s=i + 1, engine="e", refused=False, refused_reason=None, confidence=0.9) for i, (l, t) in enumerate(segs)]
        jdump(root + key, dict(payload=dict(segments=ss)) if shape == "payload" else dict(segments=ss))
        rows.append(dict(key=key, ist_date=date, start=start, room_id=room))
    rows.append(dict(key="runs/gone/none.json", ist_date="2026-09-24", start="x", room_id="room_x"))          # unresolved
    idx = os.path.join(tmp, "windows.jsonl")
    with open(idx, "w") as f:
        for r in rows: f.write(json.dumps(r) + "\n")
    return idx, (root,)


def spec_basic():
    return {
        "runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-22/w1.json": ("2026-09-22", "2026-09-22T09:00", [("en", EN + "0"), ("kn", KN + "1"), ("und", UND + "2"), ("hi", HI + "3"), ("pa", PA + "4"), ("kn", "   ")], "payload", "room_1"),
        "runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w2.json": ("2026-09-24", "2026-09-24T10:00", [("hi", HI + "5"), ("en", EN + "6")], "top", "room_1"),
        "runs/hist-bulk-20260924T0000-abc1234/room_2/2026-09-24/w3.json": ("2026-09-24", "2026-09-24T08:00", [("kn", KN + "7")], "payload", "room_2"),
        "runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-10/w4.json": ("2026-09-10", "2026-09-10T12:00", [("en", EN + "8")], "payload", "room_1"),          # no in-scope segment
        "runs/hist-bulk-20260924T0000-abc1234/room_3/2026-09-23/w5.json": ("2026-09-23", "2026-09-23T07:00", [("mr", "MR-line-9")], "payload", "room_3"),
        "runs/hist-bulk-20260924T0000-abc1234/none/2026-09-23/w6.json": ("2026-09-23", "2026-09-23T06:00", [("ta", "TA-line-10")], "payload", None),           # a parity-style window without a room id
    }


K = {"w1": "hist-bulk-20260924T0000-abc1234/room_1/2026-09-22/w1", "w2": "hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w2", "w3": "hist-bulk-20260924T0000-abc1234/room_2/2026-09-24/w3", "w5": "hist-bulk-20260924T0000-abc1234/room_3/2026-09-23/w5"}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.ann = os.path.join(self.tmp, "ann") + "/"; self.ops = os.path.join(self.tmp, "ops") + "/"
        self.idx, self.roots = make_world(self.tmp, spec_basic())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def jobs(self):
        return T.select(self.idx, self.roots)

    def go(self, mode="ok", now=NOW, **kw):
        jobs, _s, _l = self.jobs(); f = Fake(mode)
        return T.run(jobs, f, "SCRIPTSHA", self.ann, self.ops, now=now, index_name="view-TEST.jsonl", **kw), f

    def files(self):
        return sorted(os.path.relpath(os.path.join(d, n), self.ann) for d, _s, ns in os.walk(self.ann) for n in ns)

    def items(self):
        return [it for p in self.files() for it in jload(self.ann + p)["items"]]

    def edit_source(self, name, text):
        rec = self.roots[0] + {"w3": "runs/hist-bulk-20260924T0000-abc1234/room_2/2026-09-24/w3.json"}[name]
        d = jload(rec); T.segments_of(d)[0]["text"] = text; jdump(rec, d)

    def one_window_world(self, name, segs, room="room_1"):
        d = os.path.join(self.tmp, name); os.makedirs(d)
        idx, roots = make_world(d, {f"runs/hist-bulk-20260924T0000-abc1234/{room}/2026-09-24/{name}.json": ("2026-09-24", "s", segs, "payload", room)})
        return T.select(idx, roots)[0]


class Select(Base):
    def test_only_the_eight_languages_room_ids_and_counts(self):
        jobs, st, lang = self.jobs()
        self.assertEqual(st["in_scope_segments"], 5)                     # kn, hi, hi, kn, mr (the blank kn, und, pa, en are out)
        self.assertEqual(st["unresolved"], 1); self.assertEqual(st["no_scope_segments"], 1); self.assertEqual(st["in_scope_windows"], 4)
        self.assertEqual(st["no_room_id"], 1); self.assertEqual(st["no_room_id_segments"], 1)
        self.assertEqual(lang["und"], 1); self.assertEqual(lang["pa"], 1)

    def test_order_newest_date_first_then_start(self):
        jobs, _s, _l = self.jobs()
        self.assertEqual([j["key"].split("/")[-1] for j in jobs], ["w3.json", "w2.json", "w5.json", "w1.json"])      # 24 (08:00, 10:00), 23, 22

    def test_both_document_shapes_and_the_wkey(self):
        jobs, _s, _l = self.jobs()
        self.assertEqual(sorted(len(j["todo"]) for j in jobs), [1, 1, 1, 2])
        self.assertEqual(sorted(j["k"] for j in jobs), sorted(K.values()))
        with self.assertRaises(ValueError): T.wkey("hist/x.json")


class Workers(Base):
    def items_by_key(self):
        return {(it["k"], it["i"]): it for it in self.items()}

    def test_four_workers_give_exactly_the_same_items_as_one(self):
        self.go(); one = self.items_by_key(); shutil.rmtree(self.ann)
        c, _f = self.go(workers=4); four = self.items_by_key()
        self.assertEqual(one, four); self.assertEqual(c["done"], 4)

    def test_no_segment_is_written_twice_and_no_two_files_share_a_key(self):
        big = {f"runs/hist-bulk-20260924T0000-abc1234/room_{r}/2026-09-24/w{n}.json": ("2026-09-24", f"2026-09-24T{n:02d}:00", [("kn", KN + f"{r}-{n}-{i}") for i in range(3)], "payload", f"room_{r}")
               for r in (1, 2) for n in range(1, 13)}
        d = os.path.join(self.tmp, "par"); os.makedirs(d); idx, roots = make_world(d, big)
        jobs = T.select(idx, roots)[0]
        for fe in (1, 5, 100):
            shutil.rmtree(self.ann, ignore_errors=True)
            T.run(jobs, Fake(), "S", self.ann, self.ops, now=NOW, workers=8, flush_every=fe)
            pairs = [(it["k"], it["i"]) for it in self.items()]
            self.assertEqual(len(pairs), 24 * 3); self.assertEqual(len(pairs), len(set(pairs)))          # each (k, i) exactly once across all files
            self.assertEqual(len(self.files()), len(set(self.files())))                                      # no key twice
            for f in self.files():                                                                            # every file's items belong to its own room and date, and its sources are exactly its k
                b = jload(self.ann + f); self.assertEqual({it["k"] for it in b["items"]}, set(b["sources"]))

    def test_two_windows_are_really_in_flight_at_once(self):
        barrier = threading.Barrier(2, timeout=5); base = Fake()

        def send(body):
            barrier.wait()                       # a sequential implementation never gets a second party here and times out
            return base(body)
        jobs = self.jobs()[0][:2]
        c = T.run(jobs, send, "S", self.ann, self.ops, now=NOW, workers=2)
        self.assertEqual(c["done"], 2)

    def test_max_windows_is_respected_with_workers(self):
        c, f = self.go(workers=3, max_windows=2)
        self.assertEqual((c["done"], c["left_for_later"]), (2, 2)); self.assertEqual(sorted(set(it["k"] for it in self.items())), sorted([K["w3"], K["w2"]]))

    def test_a_failing_window_does_not_stop_the_others(self):
        base = Fake()

        def send(body):
            if any(l == KN + "7" for l in user_lines(body)):
                return 500, None
            return base(body)
        jobs = self.jobs()[0]
        c = T.run(jobs, send, "S", self.ann, self.ops, now=NOW, workers=3)
        self.assertEqual((c["failed"], c["done"]), (1, 3))

    def test_an_unexpected_exception_is_raised_and_collected_results_are_kept(self):
        base = Fake()

        def send(body):
            if any(l == "MR-line-9" for l in user_lines(body)):
                raise RuntimeError("boom")
            return base(body)
        with self.assertRaises(RuntimeError):
            T.run(self.jobs()[0], send, "S", self.ann, self.ops, now=NOW, workers=3, flush_every=100)
        self.assertTrue(self.files())                                # what was already collected is on disk

    def test_resume_after_a_parallel_run_skips_everything(self):
        self.go(workers=4); c, f = self.go(workers=4, now=LATER)
        self.assertEqual(c["skipped_done"], 4); self.assertEqual(f.calls, 0)

    def test_workers_outside_the_range_are_refused(self):
        for bad in (0, -1, T.MAX_WORKERS + 1, 2.5, True, "4"):
            with self.assertRaises(SystemExit): self.go(workers=bad)
        self.assertEqual(T.MAX_WORKERS, 16)

    def test_a_name_taken_between_check_and_create_moves_to_the_next_minute(self):
        orig = os.path.exists; taken = []

        def sneaky(p):
            r = orig(p)
            if p.endswith("202609250930-linker.json") and not r and not taken:                 # report "free", but create it first, as a second writer would
                taken.append(p); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").write("{}")
            return r
        os.path.exists = sneaky
        try:
            self.go()
        finally:
            os.path.exists = orig
        self.assertTrue(taken); self.assertTrue(any(f.endswith("202609250931-linker.json") for f in self.files()))
        self.assertEqual(open(taken[0]).read(), "{}")                                           # the other writer's file was not overwritten


class Sources(Base):
    def test_sources_is_the_sha_of_every_distinct_record_and_records_is_gone(self):
        self.go()
        for p in self.files():
            b = jload(self.ann + p)
            self.assertNotIn("records", b)
            self.assertEqual(set(b["sources"]), {it["k"] for it in b["items"]})
            for k, h in b["sources"].items():
                room, date = T.k_parts(k)
                self.assertEqual(h, sha(self.roots[0] + "runs/" + k + ".json"))                     # the sha256 of runs/<k>.json as read
                self.assertEqual(p.split("/")[:2], [room, date])

    def test_a_group_over_the_limit_is_split_and_every_window_is_in_one_file(self):
        orig = T.MAX_K; T.MAX_K = 2
        try:
            d = os.path.join(self.tmp, "many"); os.makedirs(d)
            idx, roots = make_world(d, {f"runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w{n}.json": ("2026-09-24", f"2026-09-24T0{n}:00", [("kn", KN + str(n))], "payload", "room_1") for n in range(1, 6)})
            T.run(T.select(idx, roots)[0], Fake(), "S", self.ann, self.ops, now=NOW)
        finally:
            T.MAX_K = orig
        bodies = [jload(self.ann + p) for p in self.files()]
        self.assertEqual(sorted(len(b["sources"]) for b in bodies), [1, 2, 2]); self.assertEqual(len(self.files()), 3)
        ks = [k for b in bodies for k in b["sources"]]; self.assertEqual(sorted(ks), sorted(set(ks)))          # each window in exactly one file
        self.assertEqual(sum(len(b["items"]) for b in bodies), 5)
        for b in bodies: self.assertEqual({it["k"] for it in b["items"]}, set(b["sources"]))

    def test_the_limit_is_400(self):
        self.assertEqual(T.MAX_K, 400)

    def test_the_file_path_follows_k_and_a_mismatch_is_counted(self):
        d = os.path.join(self.tmp, "mm"); os.makedirs(d)
        idx, roots = make_world(d, {"runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w.json": ("2026-09-25", "s", [("kn", KN + "z")], "payload", "room_OTHER")})
        jobs, st, _l = T.select(idx, roots)
        self.assertEqual(st["k_mismatch"], 1); self.assertEqual((jobs[0]["room"], jobs[0]["date"]), ("room_1", "2026-09-24"))
        T.run(jobs, Fake(), "S", self.ann, self.ops, now=NOW)
        self.assertEqual(self.files(), ["room_1/2026-09-24/202609250930-linker.json"])

    def test_k_parts(self):
        self.assertEqual(T.k_parts("run-1/room_a/2026-09-24/win"), ("room_a", "2026-09-24"))
        with self.assertRaises(ValueError): T.k_parts("a/b/c")


class LiveIndex(Base):
    def test_the_newest_view_index_is_chosen(self):
        d = os.path.join(self.tmp, "ix"); os.makedirs(d)
        for n in ("view-202609250728.jsonl", "view-202609250812.jsonl", "view-202609250731.jsonl", "windows-20260925.jsonl", "search-20260925.jsonl"):
            open(d + "/" + n, "w").close()
        self.assertEqual(os.path.basename(T.latest_index(d + "/")), "view-202609250812.jsonl")
        with self.assertRaises(SystemExit): T.latest_index(self.tmp + "/nothing/")

    def test_a_window_only_in_the_newer_index_is_selected(self):
        old_jobs = self.jobs()[0]
        spec = spec_basic(); spec["runs/hist-bulk-20260924T0000-abc1234/room_9/2026-09-24/new.json"] = ("2026-09-24", "2026-09-24T11:00", [("ml", "ML-line-11")], "payload", "room_9")
        d = os.path.join(self.tmp, "newer"); os.makedirs(d); idx, roots = make_world(d, spec)
        jobs = T.select(idx, roots)[0]
        self.assertEqual(len(jobs), len(old_jobs) + 1); self.assertIn("hist-bulk-20260924T0000-abc1234/room_9/2026-09-24/new", [j["k"] for j in jobs])

    def test_roots_are_tried_in_order(self):
        a, b = os.path.join(self.tmp, "ra") + "/", os.path.join(self.tmp, "rb") + "/"
        for r, txt in ((a, KN + "FIRST"), (b, KN + "SECOND")):
            os.makedirs(r + "runs/x", exist_ok=True); jdump(r + "runs/x/w.json", dict(segments=[dict(lang="kn", text=txt)]))
        self.assertEqual(T.resolve("runs/x/w.json", (a, b)), a + "runs/x/w.json"); self.assertEqual(T.resolve("runs/x/w.json", (b, a)), b + "runs/x/w.json")
        self.assertIsNone(T.resolve("runs/none.json", (a, b)))
        self.assertEqual(T.ROOTS[0].rstrip("/").split("/")[-1], "hist-mining"); self.assertEqual([r.rstrip("/").split("/")[-1] for r in T.ROOTS], ["hist-mining", "hist", "staged"])


class Output(Base):
    def test_only_in_scope_lines_are_sent(self):
        c, f = self.go()
        self.assertEqual(sorted(f.sent), sorted([KN + "1", HI + "3", HI + "5", KN + "7", "MR-line-9"]))
        self.assertFalse(any(UND in l or PA in l or EN in l or "TA-line" in l or l.strip() == "" for l in f.sent))
        self.assertEqual(c["done"], 4)

    def test_records_and_index_never_written(self):
        paths = [self.idx] + [os.path.join(d, n) for d, _s, ns in os.walk(self.roots[0]) for n in ns]
        before = {p: sha(p) for p in paths}
        self.go()
        self.assertEqual(before, {p: sha(p) for p in paths})

    def test_file_names_and_schema(self):
        self.go()
        self.assertEqual(self.files(), ["room_1/2026-09-22/202609250930-linker.json", "room_1/2026-09-24/202609250930-linker.json",
                                        "room_2/2026-09-24/202609250930-linker.json", "room_3/2026-09-23/202609250930-linker.json"])
        b = jload(self.ann + "room_1/2026-09-22/202609250930-linker.json")
        self.assertEqual(set(b), {"schema", "kind", "provenance", "sources", "items"})
        self.assertEqual((b["schema"], b["kind"]), ("eta-lab-annotation/1", "translation"))
        self.assertEqual(b["provenance"], dict(producer="linker", model=L.MODEL, provider="Google", zdr=True, created_at="2026-09-25T09:30:00+05:30",
                                               prompt_sha256=L.prompt_sha256(), script_commit="SCRIPTSHA", index_file="view-TEST.jsonl"))
        job = [j for j in self.jobs()[0] if j["k"] == K["w1"]][0]
        self.assertEqual(b["sources"], {K["w1"]: job["rec_sha"]})
        self.assertEqual(b["items"], [dict(k=K["w1"], i=1, src_sha256=T.sha256_text(KN + "1"), q="ok", en=tr(KN + "1")),
                                      dict(k=K["w1"], i=3, src_sha256=T.sha256_text(HI + "3"), q="ok", en=tr(HI + "3"))])          # i = index in the record's segments list

    def test_native_text_is_not_in_the_files(self):
        self.go()
        blob = ""
        for p in self.files():
            with open(self.ann + p) as f: blob += f.read()
        for s in (KN, HI, "MR-line"): self.assertNotIn(s, blob)

    def test_garbled_text_is_kept_with_its_flag(self):
        self.go("garbled")
        its = self.items()
        self.assertEqual(len(its), 5); self.assertTrue(all(it["q"] == "garbled" and it["en"].startswith("EN:") for it in its))

    def test_private_modes(self):
        self.go()
        for d, _ds, fs in os.walk(self.ann):
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700, d)
            for n in fs: self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, n)).st_mode), 0o600, n)

    def test_call_log_holds_no_text(self):
        self.go()
        with open(self.ops + "calls.jsonl") as f: log = f.read()
        for s in (KN, HI, "MR-line", "EN:"): self.assertNotIn(s, log)
        self.assertIn(L.MODEL, log)

    def test_files_are_write_once_and_the_minute_is_bumped(self):
        self.go(); first = {p: sha(self.ann + p) for p in self.files()}
        self.edit_source("w3", KN + "CHANGED")
        c, _f = self.go(); self.assertEqual(c["done"], 1)                                     # same minute again
        self.assertIn("room_2/2026-09-24/202609250930-linker.json", self.files()); self.assertIn("room_2/2026-09-24/202609250931-linker.json", self.files())
        for p, h in first.items(): self.assertEqual(sha(self.ann + p), h)                     # nothing written before was touched

    def test_one_file_per_room_day_per_flush(self):
        d = os.path.join(self.tmp, "g"); os.makedirs(d)
        idx, roots = make_world(d, {f"runs/hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w{n}.json": ("2026-09-24", f"2026-09-24T0{n}:00", [("kn", KN + str(n))], "payload", "room_1") for n in range(1, 4)})
        T.run(T.select(idx, roots)[0], Fake(), "S", self.ann, self.ops, now=NOW)
        self.assertEqual(len(self.files()), 1); self.assertEqual(len(self.items()), 3)
        self.assertEqual(len(jload(self.ann + self.files()[0])["sources"]), 3)


class Resume(Base):
    def test_done_windows_are_skipped(self):
        c1, _f1 = self.go(); self.assertEqual(c1["done"], 4)
        c2, f2 = self.go(); self.assertEqual(c2.get("skipped_done"), 4); self.assertEqual(f2.calls, 0); self.assertNotIn("attempted", c2)

    def test_a_changed_source_text_is_redone(self):
        self.go(); self.edit_source("w3", KN + "CHANGED")
        c, fk = self.go(now=LATER); self.assertEqual(c["done"], 1); self.assertEqual(fk.sent, [KN + "CHANGED"])

    def test_a_missing_item_is_redone_and_only_that_one_is_sent(self):
        self.go()
        p = self.ann + "room_1/2026-09-22/202609250930-linker.json"; b = jload(p); b["items"] = [it for it in b["items"] if it["i"] != 3]; jdump(p, b)
        c, fk = self.go(now=LATER); self.assertEqual(c["done"], 1); self.assertEqual(fk.sent, [HI + "3"])

    def test_latest_file_wins_per_segment(self):
        self.go(); k = K["w3"]
        self.assertEqual(T.last_items(self.ann)[(k, 0)]["en"], tr(KN + "7"))
        jdump(self.ann + "room_2/2026-09-24/202609250959-linker.json", dict(items=[dict(k=k, i=0, src_sha256=T.sha256_text(KN + "7"), q="mt_failed", err="http_failed")]))
        self.assertEqual(T.last_items(self.ann)[(k, 0)]["err"], "http_failed")                # a later failure item wins, so the segment is not done
        c, _f = self.go(now=datetime(2026, 9, 25, 6, 0, tzinfo=timezone.utc)); self.assertEqual(c["done"], 1)

    def test_max_windows_newest_first(self):
        c, _f = self.go(max_windows=2)
        self.assertEqual(c["done"], 2); self.assertEqual(c["left_for_later"], 2)
        self.assertEqual(sorted(set(it["k"] for it in self.items())), sorted([K["w3"], K["w2"]]))          # 24 Sep first


class Failure(Base):
    def test_failed_windows_are_failure_items_with_a_closed_reason_and_no_text(self):
        c, _f = self.go("http500")
        self.assertEqual(c["failed"], 4); self.assertNotIn("done", c)
        its = self.items(); self.assertEqual(len(its), 5)
        for it in its:
            self.assertEqual(set(it), {"k", "i", "src_sha256", "q", "err"}); self.assertEqual(it["q"], "mt_failed"); self.assertIn(it["err"], T.ERRS)
        self.assertIsNone(jload(self.ann + self.files()[0])["provenance"]["provider"])
        c2, _f2 = self.go(now=LATER); self.assertEqual(c2["done"], 4)                              # retried
        self.assertTrue(all("en" in it for it in T.last_items(self.ann).values()))

    def test_model_mismatch_is_a_route_failure(self):
        c, _f = self.go("badmodel"); self.assertEqual(c["failed"], 4); self.assertEqual({it["err"] for it in self.items()}, {"route_mismatch"})

    def test_provider_change_inside_a_window_fails_it(self):
        jobs = self.one_window_world("big", [("kn", KN + str(i)) for i in range(60)])          # 3 calls: the provider flips on the 2nd
        c = T.run(jobs, Fake("flipprov"), "S", self.ann, self.ops, now=NOW)
        self.assertEqual(c["failed"], 1); self.assertNotIn("done", c); self.assertEqual({it["err"] for it in self.items()}, {"route_mismatch"})

    def test_malformed_twice_isolates_lines_and_keeps_the_rest(self):
        jobs = self.one_window_world("w", [("kn", KN + "a"), ("kn", "POISON"), ("hi", HI + "c")])
        c = T.run(jobs, Fake("poison"), "S", self.ann, self.ops, now=NOW)
        self.assertEqual((c["done"], c["isolated_failed_lines"], c["seg_mt_failed"], c["seg_ok"]), (1, 1, 1, 2))
        by = {it["i"]: it for it in self.items()}
        self.assertEqual(by[1], dict(k="hist-bulk-20260924T0000-abc1234/room_1/2026-09-24/w", i=1, src_sha256=T.sha256_text("POISON"), q="mt_failed", err="isolated_line_failed"))          # no text kept
        self.assertEqual(by[0]["en"], tr(KN + "a"))

    def test_every_line_malformed_fails_the_window(self):
        c, _f = self.go("malformed"); self.assertEqual(c["failed"], 4)
        self.assertEqual({it["err"] for it in self.items()}, {"all_lines_failed"})

    def test_batches_of_25(self):
        jobs = self.one_window_world("b", [("kn", KN + str(i)) for i in range(60)]); f = Fake()
        T.run(jobs, f, "S", self.ann, self.ops, now=NOW); self.assertEqual(f.calls, 3)

    def test_status_to_err_is_closed(self):
        for st in ("MT_FAILED(http 500)", "MT_ROUTE_MISMATCH", "MT_ROUTE_MISMATCH(provider changed within the item)", L.MALFORMED_TWICE, "MT_FAILED(retries exhausted)",
                   "MT_FAILED(every line isolated-failed)", "anything else"):
            self.assertIn(T.status_to_err(st), T.ERRS)
        self.assertEqual(T.status_to_err(L.MALFORMED_TWICE), "malformed_twice"); self.assertEqual(T.status_to_err("MT_FAILED(every line isolated-failed)"), "all_lines_failed")


class Gate(Base):
    PROV = dict(script_sha="a", route_sha="b", prereg_sha="c", prereg_sha1="d", prereg_sha2="e", prereg_sha3="f", prereg_sha4="g")

    def test_run_refused_without_preflight(self):
        with self.assertRaises(SystemExit): T.cmd_run(send=Fake(), ann=self.ann, ops=self.ops, index=self.idx, roots=self.roots, prov=self.PROV)

    def test_preflight_binds_all_commits(self):
        T.cmd_preflight(send=Fake(), ops=self.ops, prov=self.PROV)
        T.cmd_run(send=Fake(), ann=self.ann, ops=self.ops, index=self.idx, roots=self.roots, prov=self.PROV)
        for k in self.PROV:
            with self.assertRaises(SystemExit): T.require_preflight(self.ops, dict(self.PROV, **{k: "changed"}))

    def test_preflight_with_wrong_model_fails(self):
        with self.assertRaises(SystemExit): T.cmd_preflight(send=Fake("badmodel"), ops=self.ops, prov=self.PROV)
        with self.assertRaises(SystemExit): T.require_preflight(self.ops, self.PROV)

    def test_a_preflight_file_with_another_model_is_refused(self):
        T.cmd_preflight(send=Fake(), ops=self.ops, prov=self.PROV)
        pf = jload(self.ops + "preflight.json"); pf["model_returned"] = "some/other-model"; jdump(self.ops + "preflight.json", pf)
        with self.assertRaises(SystemExit): T.require_preflight(self.ops, self.PROV)

    def test_provenance_binds_the_script_the_route_and_all_three_preregistrations(self):
        seen = []
        orig = L.committed_sha
        L.committed_sha = lambda path, cwd=None: seen.append(os.path.basename(path)) or "sha:" + os.path.basename(path)
        try:
            p = T.provenance()
        finally:
            L.committed_sha = orig
        self.assertEqual(sorted(seen), sorted(["translate_segments.py", "link3_translate.py", "PREREG-337b.md", "PREREG-337b-A1.md", "PREREG-337b-A2.md", "PREREG-337b-A3.md", "PREREG-337b-A4.md"]))
        self.assertEqual(set(p), {"script_sha", "route_sha", "prereg_sha", "prereg_sha1", "prereg_sha2", "prereg_sha3", "prereg_sha4"})

    def test_the_preflight_line_is_invented(self):
        f = Fake(); T.cmd_preflight(send=f, ops=self.ops, prov=self.PROV); self.assertEqual(f.sent, [T.PREFLIGHT_LINE])


class Report(Base):
    def test_counts_by_date(self):
        self.go(max_windows=2)
        r = T.report(self.jobs()[0], self.ann)
        self.assertEqual(r["2026-09-24"]["windows_done"], 2); self.assertEqual(r["2026-09-23"]["windows_todo"], 1); self.assertEqual(r["2026-09-22"]["segments_not_done"], 2)
        self.assertEqual(r["2026-09-24"]["items_ok"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
