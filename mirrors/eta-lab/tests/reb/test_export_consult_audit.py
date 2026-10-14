import contextlib
import csv
import io
import json
import os
import stat
import tempfile
import unittest

from kit.reb import export_consult_audit as ex
from kit.reb import sarvam_lane as sl

IST = sl.IST


def ist_str(ms):
    import datetime
    return datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


class Store:
    def __init__(self, tmp):
        self.tmp = tmp
        self.root = os.path.join(tmp, "reb")
        self.index = os.path.join(tmp, "index.jsonl")
        self.caa = os.path.join(tmp, "caa.csv")
        self.rows, self.caa_rows = [], []

    def scope(self, uid, date="2026-10-10", room="room_aaaaaaaa", t0=1000, t1=2000):
        d = os.path.join(self.root, date, room, "_consults", uid)
        os.makedirs(os.path.join(d, "tracks"))
        self._man = {"window_id": "consult-" + uid, "room_id": room, "room_slug": "OPD", "ist_date": date, "t0_ms": t0, "t1_ms": t1, "tracks": []}
        json.dump(self._man, open(os.path.join(d, "manifest.json"), "w"))
        return d

    def track(self, d, layer, engine, version, segs, extras=None, status="ok", fin="2026-10-10T10:00:00Z"):
        self._n = getattr(self, "_n", 0) + 1
        rel = f"{d[len(self.root) + 1:]}/tracks/{layer}.{engine}__{version}__{self._n}.json"
        body = {"schema": "reb.track.v1", "layer": layer, "engine": engine, "version": version, "status": status, "segments": segs, "extras": extras or {}}
        json.dump(body, open(os.path.join(self.root, rel), "w"))
        m = json.load(open(os.path.join(d, "manifest.json")))
        m["tracks"].append({"layer": layer, "engine": engine, "version": version, "status": status, "path": rel, "finished_at": fin, "config_hash": f"c{self._n}"})
        json.dump(m, open(os.path.join(d, "manifest.json"), "w"))

    def cut_row(self, uid, t0, t1, flags=(), status="cut", doctor="DOC1", room="room_aaaaaaaa", date="2026-10-10"):
        self.rows.append({"consult_uid": uid, "ist_date": date, "room_id": room, "doctor_uid": doctor, "status": status, "flags": list(flags), "span_start": ist_str(t0), "span_end": ist_str(t1)})

    def flush(self):
        with open(self.index, "w") as f:
            for r in self.rows:
                f.write(json.dumps(r) + "\n")
        with open(self.caa, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["consult_uid", "room", "doctor_uid", "t0_utc_ms", "t1_utc_ms", "boundary_source", "sarvam_done", "clip_path", "clip_status", "date"])
            w.writeheader()
            for r in self.caa_rows:
                w.writerow(r)

    def run(self, uids, rx=None, smap=None, out=None):
        self.flush()
        out = out or os.path.join(self.tmp, "out.jsonl")
        uf = os.path.join(self.tmp, "uids.txt")
        open(uf, "w").write("\n".join(uids) + "\n")
        rxp = None
        if rx is not None:
            rxp = os.path.join(self.tmp, "rx.jsonl")
            open(rxp, "w").write("".join(json.dumps(r) + "\n" for r in rx))
        res = ex.export(ex.read_uids(uf), out, rx_path=rxp, smap_path=smap, root=self.root, index_path=self.index, caa_path=self.caa)
        lines = [json.loads(l) for l in open(out)] if os.path.exists(out) else []
        return res, lines, out


def seg(t0, t1, text, lang="hi-IN", sp="0"):
    return {"t0_ms": t0, "t1_ms": t1, "text": text, "lang": lang, "speaker": sp}


class T(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.s = Store(self._td.name)

    def basic(self, uid="u1", **kw):
        d = self.s.scope(uid)
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1000, 1500, "namaste", "hi-IN", "0"), seg(1500, 1800, "hello there", "en-IN", "1"), seg(1800, 1900, "   ", "hi-IN", "0")])
        self.s.track(d, "translate", "sarvam-saaras-v3", "v1", [{**seg(1000, 1500, "greetings", "en-IN", "0")}])
        self.s.track(d, "role", "llm-roles", "v1", [], {"map": {"0": "doctor", "1": "attender"}})
        self.s.cut_row(uid, 5000, 9000, **kw)
        return d

    def test_cutter_line(self):
        self.basic()
        res, lines, _ = self.s.run(["u1"])
        (l,) = lines
        self.assertEqual((l["encounter_id"], l["source"], l["doctor_uid"], l["room"]), ("u1", "cutter", "DOC1", "room_aaaaaaaa"))
        self.assertEqual(l["window"], {"t0": 5000, "t1": 9000, "complete": True})
        self.assertEqual([t["turn_id"] for t in l["turns"]], ["t0000", "t0001"])
        t = l["turns"]
        self.assertEqual((t[0]["role"], t[0]["text_en"], t[0]["text_native"], t[0]["lang"]), ("doctor", "greetings", "namaste", "hi-IN"))
        self.assertEqual((t[1]["role"], t[1]["text_en"], t[1]["text_native"]), ("attendant", "hello there", "hello there"))
        self.assertIsNone(l["rx"])
        self.assertEqual(res["by_source"], {"cutter": 1})

    def test_window_complete_flags(self):
        self.basic("t1", flags=["tape_truncated"])
        d = self.s.scope("t2")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "x")])
        self.s.cut_row("t2", 1, 2, status="deferred_long")
        res, lines, _ = self.s.run(["t1", "t2"])
        self.assertEqual([l["window"]["complete"] for l in lines], [False, False])
        self.assertEqual(res["by_window_complete"], {"false": 2})

    def test_native_without_translate_is_null_not_copied(self):
        d = self.s.scope("u2")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "text", "ta-IN")])
        self.s.cut_row("u2", 1, 2)
        _, lines, _ = self.s.run(["u2"])
        self.assertIsNone(lines[0]["turns"][0]["text_en"])
        self.assertEqual(lines[0]["turns"][0]["role"], "unknown")

    def test_role_fallback_order(self):
        d = self.s.scope("u3")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "a", "en-IN", "0"), seg(2, 3, "b", "en-IN", "1")])
        self.s.track(d, "role", "text-judge", "v1", [], {"map": {"0": {"role": "patient"}, "1": {"role": "staff"}}})
        self.s.track(d, "role", "caa-labels", "caa", [], {"map": {"0": {"role": "doctor"}}})
        self.s.cut_row("u3", 1, 3)
        _, lines, _ = self.s.run(["u3"])
        self.assertEqual([t["role"] for t in lines[0]["turns"]], ["patient", "unknown"])

    def test_per_turn_role_from_llm_segments(self):
        d = self.s.scope("p1")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "a", "en-IN", "0"), seg(100, 200, "b", "en-IN", "0"), seg(300, 400, "c", "en-IN", "1")])
        # utterance 2 carries a fix (speaker 0 is doctor in the map, patient in the segment); the third turn overlaps two segments, the larger wins
        self.s.track(d, "role", "llm-roles", "v1", [{"t0_ms": 0, "t1_ms": 100, "speaker": "0", "role": "doctor"}, {"t0_ms": 100, "t1_ms": 200, "speaker": "0", "role": "patient"},
                                                      {"t0_ms": 290, "t1_ms": 310, "speaker": "1", "role": "staff"}, {"t0_ms": 310, "t1_ms": 400, "speaker": "1", "role": "attender"}],
                     {"map": {"0": "doctor", "1": "patient"}})
        self.s.track(d, "role", "text-judge", "v1", [], {"map": {"0": {"role": "patient"}}})
        self.s.cut_row("p1", 0, 400)
        res, lines, _ = self.s.run(["p1"])
        self.assertEqual([t["role"] for t in lines[0]["turns"]], ["doctor", "patient", "attendant"])
        self.assertEqual(res["turns_by_role_source"], {"llm_segment": 3})

    def test_fallthrough_sources_counted(self):
        d = self.s.scope("p2")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "a", "en-IN", "0"), seg(100, 200, "b", "en-IN", "1"), seg(200, 300, "c", "en-IN", "2"), seg(300, 400, "d", "en-IN", "3")])
        # llm segments cover only the first turn; the llm map knows speaker 1; the judge knows 2; caa has a segment
        self.s.track(d, "role", "llm-roles", "v1", [{"t0_ms": 0, "t1_ms": 100, "speaker": "0", "role": "doctor"}], {"map": {"1": "patient"}})
        self.s.track(d, "role", "text-judge", "v1", [], {"map": {"2": {"role": "attender"}}})
        self.s.track(d, "role", "caa-labels", "caa", [{"t0_ms": 300, "t1_ms": 400, "speaker": "3", "role": "doctor"}], {"map": {"9": {"role": "patient"}}})
        self.s.cut_row("p2", 0, 400)
        res, lines, _ = self.s.run(["p2"])
        self.assertEqual([t["role"] for t in lines[0]["turns"]], ["doctor", "patient", "attendant", "doctor"])
        self.assertEqual(res["turns_by_role_source"], {"llm_segment": 1, "llm_map": 1, "judge_map": 1, "caa_segment": 1})

    def test_caa_map_and_none(self):
        d = self.s.scope("p3")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "a", "en-IN", "0"), seg(500, 600, "b", "en-IN", "7")])
        self.s.track(d, "role", "caa-labels", "caa", [{"t0_ms": 0, "t1_ms": 50, "speaker": "0", "role": "patient"}], {"map": {"7": {"role": "doctor"}}})
        self.s.cut_row("p3", 0, 600)
        res, lines, _ = self.s.run(["p3"])
        self.assertEqual([t["role"] for t in lines[0]["turns"]], ["patient", "doctor"])
        self.assertEqual(res["turns_by_role_source"], {"caa_segment": 1, "caa_map": 1})

    def test_latest_ok_stt_wins_and_failed_ignored(self):
        d = self.s.scope("u4")
        # ordering is extras.created_at (finished_at is NOT consulted): the "new" track has the OLDER finished_at
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "old", "en-IN")], {"created_at": "2026-10-10T08:00:00Z"}, fin="2026-10-10T10:00:00Z")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "new", "en-IN")], {"created_at": "2026-10-10T09:00:00Z"}, fin="2026-10-10T01:00:00Z")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "bad", "en-IN")], {"created_at": "2026-10-10T12:00:00Z"}, status="failed", fin="2026-10-10T12:00:00Z")
        self.s.cut_row("u4", 1, 2)
        _, lines, _ = self.s.run(["u4"])
        self.assertEqual(lines[0]["turns"][0]["text_native"], "new")

    def test_ordering_falls_back_to_mtime(self):
        d = self.s.scope("mt")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "newer file", "en-IN")], fin="2026-10-10T01:00:00Z")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v2", [seg(1, 2, "older file", "en-IN")], fin="2026-10-10T23:00:00Z")
        for name, t in (("v1", 1791900000), ("v2", 1791800000)):
            for f in os.listdir(os.path.join(d, "tracks")):
                if f"__{name}__" in f:
                    os.utime(os.path.join(d, "tracks", f), (t, t))
        self.s.cut_row("mt", 1, 2)
        _, lines, _ = self.s.run(["mt"])
        self.assertEqual(lines[0]["turns"][0]["text_native"], "newer file")

    def test_unparseable_track_skipped_and_counted(self):
        d = self.s.scope("bj")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "good", "en-IN")], {"created_at": "2026-10-10T08:00:00Z"})
        self.s.track(d, "stt", "sarvam-saaras-v3", "v2", [seg(1, 2, "newer but damaged", "en-IN")], {"created_at": "2026-10-10T09:00:00Z"})
        self.s.track(d, "role", "llm-roles", "v1", [], {"map": {"0": "doctor"}})
        for f in os.listdir(os.path.join(d, "tracks")):
            if f.startswith("stt.") and "__v2__" in f or f.startswith("role."):
                open(os.path.join(d, "tracks", f), "w").write("{not json")
        self.s.cut_row("bj", 1, 2)
        res, lines, _ = self.s.run(["bj"])
        self.assertEqual(lines[0]["turns"][0]["text_native"], "good")
        self.assertEqual(lines[0]["turns"][0]["role"], "unknown")
        self.assertEqual(res["counts"]["unparseable_tracks"], 2)

    def test_cutter_never_reads_caa_version_stt(self):
        d = self.s.scope("u5")
        self.s.track(d, "stt", "sarvam-saaras-v3", "caa", [seg(1, 2, "caa text", "en-IN")])
        self.s.cut_row("u5", 1, 2)
        res, lines, _ = self.s.run(["u5"])
        self.assertEqual(lines, [])
        self.assertEqual(res["skipped_by_reason"], {"no_stt": 1})

    def test_caa_source(self):
        d = self.s.scope("c1", date="2026-09-10", t0=111, t1=222)
        self.s.track(d, "stt", "sarvam-saaras-v3", "caa", [seg(111, 150, "n", "hi-IN", "doctor")])
        self.s.track(d, "translate", "sarvam-mayura-v1", "caa", [seg(111, 150, "en text", "en-IN", "doctor")])
        self.s.track(d, "role", "caa-labels", "caa", [], {"map": {"doctor": {"role": "doctor"}}})
        self.s.caa_rows += [{"consult_uid": "c1", "room": "OPD 1", "doctor_uid": "OTHER", "t0_utc_ms": "9", "t1_utc_ms": "10", "sarvam_done": "n"},
                            {"consult_uid": "c1", "room": "OPD 7", "doctor_uid": "CAADOC", "t0_utc_ms": "111", "t1_utc_ms": "222", "sarvam_done": "y"}]
        res, lines, _ = self.s.run(["c1"])
        l = lines[0]
        self.assertEqual((l["source"], l["doctor_uid"], l["room"], l["window"]), ("caa", "CAADOC", "room_aaaaaaaa", {"t0": 111, "t1": 222, "complete": None}))
        self.assertEqual((l["turns"][0]["role"], l["turns"][0]["text_en"]), ("doctor", "en text"))
        self.assertEqual(res["counts"]["caa_multi_row"], 1)
        self.assertEqual(res["by_window_complete"], {"null": 1})

    def test_skips_counted(self):
        self.basic("ok1")
        self.s.scope("dup", date="2026-10-10")
        self.s.scope("dup", date="2026-10-11")  # same uid in two scopes
        self.s.cut_row("dup", 1, 2, date="2026-10-12")
        self.s.cut_row("nodir", 1, 2)
        res, lines, _ = self.s.run(["ok1", "ghost", "dup", "nodir"])
        self.assertEqual(len(lines), 1)
        self.assertEqual(res["skipped_by_reason"], {"not_found": 1, "ambiguous_scope": 1, "no_scope": 1})
        self.assertEqual(res["counts"]["skipped"], 3)

    def test_surrogate_stable_and_private(self):
        uid = "abc12345678xyz"
        self.basic(uid)
        sm = os.path.join(self._td.name, "smap.json")
        _, l1, out = self.s.run([uid], smap=sm)
        eid = l1[0]["encounter_id"]
        self.assertNotEqual(eid, uid)
        self.assertTrue(eid.startswith("enc-"))
        self.assertNotIn(uid, open(out).read())
        self.assertEqual(stat.S_IMODE(os.stat(sm).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o600)
        _, l2, _ = self.s.run([uid], smap=sm)
        self.assertEqual(l2[0]["encounter_id"], eid)
        self.assertEqual(json.load(open(sm)), {uid: eid})

    def test_refuses_without_surrogate_map(self):
        self.basic("abc12345678xyz")
        self.basic("plain")
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write("plain\nabc12345678xyz\n")
        out = os.path.join(self._td.name, "o.jsonl")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = ex.main(["--uids", uf, "--out", out, "--root", self.s.root, "--index", self.s.index, "--caa-manifest", self.s.caa])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(out))
        self.assertNotIn("abc12345678xyz", err.getvalue())
        with self.assertRaises(ex.SurrogateMapRequired):
            ex.export(["abc12345678xyz"], out, root=self.s.root, index_path=self.s.index, caa_path=self.s.caa)
        self.assertFalse(os.path.exists(out))

    def test_scope_room_mismatch_counted(self):
        d = self.s.scope("mm", room="room_bbbbbbbb")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "x", "en-IN")])
        self.s.cut_row("mm", 1, 2, room="room_aaaaaaaa")
        res, lines, _ = self.s.run(["mm"])
        self.assertEqual(len(lines), 1)
        self.assertEqual(res["counts"]["scope_room_mismatch"], 1)

    def test_surrogates_never_have_digit_runs(self):
        from unittest import mock
        seq = iter(["ab" * 8, "12345678" * 2, "cd" * 8])   # token_hex: the 2nd has 16 digits in a row and must be rejected
        with mock.patch.object(ex.secrets, "token_hex", lambda n: next(seq)):
            used = set()
            a = ex.new_surrogate(used)
            used.add(a)
            b = ex.new_surrogate(used)
        self.assertEqual((a, b), ("enc-" + "ab" * 8, "enc-" + "cd" * 8))
        for _ in range(200):
            self.assertIsNone(ex.LONG_DIGITS.search(ex.new_surrogate(set())))

    def test_existing_digit_surrogates_are_reissued_and_counted(self):
        uid = "abc12345678xyz"
        self.basic(uid)
        sm = os.path.join(self._td.name, "smap.json")
        json.dump({uid: "enc-1234567890123456", "keep": "enc-aaaa1111bbbb2222"}, open(sm, "w"))
        res, lines, out = self.s.run([uid], smap=sm)
        self.assertEqual(res["counts"]["surrogates_reissued"], 1)
        m = json.load(open(sm))
        self.assertIsNone(ex.LONG_DIGITS.search(m[uid]))
        self.assertEqual(m["keep"], "enc-aaaa1111bbbb2222")   # untouched
        self.assertEqual(lines[0]["encounter_id"], m[uid])
        self.assertEqual(stat.S_IMODE(os.stat(sm).st_mode), 0o600)
        res2, l2, _ = self.s.run([uid], smap=sm)   # stable now
        self.assertEqual((res2["counts"]["surrogates_reissued"], l2[0]["encounter_id"]), (0, m[uid]))

    def test_text_en_strict_overlap_and_counts(self):
        d = self.s.scope("ov")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "n1", "hi-IN"), seg(100, 200, "n2", "hi-IN"), seg(200, 300, "n3", "hi-IN"), seg(300, 400, "n4", "en-IN"),
                                                           seg(400, 500, "n5", "hi-IN"), seg(480, 620, "n7", "hi-IN"), seg(500, 600, "n6", "hi-IN")])
        # e1 / own5 / x match stt turns exactly (index); mid has 95/105 inside n2 -> accepted; late has 50/110 inside n2 (refused) and 60/110 inside n3 (accepted);
        # n4 is English: its own text, whatever overlaps; x overlaps n6 by 71% but belongs to n7 -> refused, so n6 stays null
        self.s.track(d, "translate", "sarvam-saaras-v3", "v1", [seg(0, 100, "e1", "en-IN"), seg(90, 195, "mid", "en-IN"), seg(150, 260, "late", "en-IN"), seg(300, 400, "nb", "en-IN"),
                                                                 seg(400, 500, "own5", "en-IN"), seg(480, 620, "x", "en-IN")])
        self.s.cut_row("ov", 0, 620)
        res, lines, _ = self.s.run(["ov"])
        by = {x["text_native"]: x["text_en"] for x in lines[0]["turns"]}
        self.assertEqual(by, {"n1": "e1", "n2": "mid", "n3": "late", "n4": "nb", "n5": "own5", "n7": "x", "n6": None})
        self.assertEqual(res["text_en_by"], {"index": 4, "stt_en": 0, "gapfill": 0, "overlap": 2, "null": 1, "overlap_rejected": 2})
        self.assertEqual(res["null_text_en"], {"null_turns_no_translate_track": 0, "null_turns_no_overlap": 1, "null_consults_no_translate_track": 0, "null_consults_no_overlap": 1})

    def test_drop_untranslated(self):
        d = self.s.scope("dr")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "a", "hi-IN", "0"), seg(100, 200, "b", "hi-IN", "1"), seg(200, 300, "c", "en-IN", "0"), seg(300, 400, "d", "hi-IN", "2")])
        self.s.track(d, "translate", "sarvam-saaras-v3", "v1", [seg(0, 100, "A", "en-IN", "0")])
        self.s.track(d, "role", "llm-roles", "v1", [], {"map": {"0": "doctor", "1": "patient", "2": "staff"}})
        d2 = self.s.scope("dr2")   # every turn untranslated: the line stays, with no turns
        self.s.track(d2, "stt", "sarvam-saaras-v3", "v1", [seg(0, 10, "x", "hi-IN", "0")])
        d3 = self.s.scope("dr3")   # nothing dropped
        self.s.track(d3, "stt", "sarvam-saaras-v3", "v1", [seg(0, 10, "y", "en-IN", "0")])
        for u in ("dr", "dr2", "dr3"):
            self.s.cut_row(u, 0, 400)
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write("dr\ndr2\ndr3\n")
        out = os.path.join(self._td.name, "o.jsonl")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ex.main(["--uids", uf, "--out", out, "--drop-untranslated", "--root", self.s.root, "--index", self.s.index, "--caa-manifest", self.s.caa])
        self.assertEqual(rc, 0)
        res = json.loads(buf.getvalue())
        lines = [json.loads(l) for l in open(out)]
        self.assertEqual([(t["turn_id"], t["text_en"]) for t in lines[0]["turns"]], [("t0000", "A"), ("t0002", "c")])
        self.assertEqual(lines[1]["turns"], [])
        self.assertEqual(len(lines[2]["turns"]), 1)
        self.assertEqual(res["dropped_turns_by_role"], {"doctor": 0, "patient": 1, "attendant": 0, "unknown": 2})
        self.assertEqual((res["dropped_consults"], res["consults_emptied"]), (2, 1))
        self.assertEqual(res["counts"]["lines"], 3)
        # without the flag the nulls stay in the line and no drop keys are printed
        res2, l2, _ = self.s.run(["dr", "dr2", "dr3"])
        self.assertNotIn("dropped_turns_by_role", res2)
        self.assertEqual(len(l2[0]["turns"]), 4)

    def test_english_turn_keeps_own_text_over_overlap(self):
        d = self.s.scope("en")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 100, "own english", "en-IN")])
        self.s.track(d, "translate", "sarvam-saaras-v3", "v1", [seg(10, 90, "stranger", "en-IN")])   # fully inside the turn, but not its translation
        self.s.cut_row("en", 0, 100)
        res, lines, _ = self.s.run(["en"])
        self.assertEqual(lines[0]["turns"][0]["text_en"], "own english")
        self.assertEqual(res["text_en_by"]["stt_en"], 1)

    def test_null_causes_no_translate_track_vs_no_overlap(self):
        for uid, with_tr in (("n1", False), ("n2", False), ("n3", True)):
            d = self.s.scope(uid)
            self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(0, 10, "a", "hi-IN"), seg(10, 20, "b", "hi-IN")])
            if with_tr:
                self.s.track(d, "translate", "sarvam-saaras-v3", "v1", [seg(500, 600, "far", "en-IN")])
            self.s.cut_row(uid, 0, 20)
        res, lines, _ = self.s.run(["n1", "n2", "n3"])
        self.assertEqual(res["null_text_en"], {"null_turns_no_translate_track": 4, "null_turns_no_overlap": 2, "null_consults_no_translate_track": 2, "null_consults_no_overlap": 1})
        self.assertEqual(res["text_en_by"]["null"], 6)

    def test_dry_writes_nothing(self):
        uid = "abc12345678xyz"
        self.basic(uid)
        sm = os.path.join(self._td.name, "smap.json")
        json.dump({uid: "enc-1234567890123456"}, open(sm, "w"))
        before = open(sm).read()
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write(uid + "\n")
        out = os.path.join(self._td.name, "o.jsonl")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ex.main(["--uids", uf, "--dry", "--surrogate-map", sm, "--root", self.s.root, "--index", self.s.index, "--caa-manifest", self.s.caa])
        self.assertEqual(rc, 0)
        self.assertEqual(open(sm).read(), before)
        self.assertFalse(os.path.exists(out))
        self.assertEqual(json.loads(buf.getvalue())["counts"]["surrogates_reissued"], 1)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            ex.main(["--uids", uf, "--surrogate-map", sm])   # no --out and no --dry

    def test_short_digit_runs_keep_uid(self):
        self.basic("ab1234567z")
        _, lines, _ = self.s.run(["ab1234567z"])
        self.assertEqual(lines[0]["encounter_id"], "ab1234567z")

    def test_rx_join_and_counts(self):
        self.basic("r1")
        d = self.s.scope("r2")
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", [seg(1, 2, "x", "en-IN")])
        self.s.cut_row("r2", 1, 2)
        res, lines, _ = self.s.run(["r1", "r2"], rx=[{"consult_uid": "r1", "match_confidence": "high", "meds": ["m"]}])
        self.assertEqual(lines[0]["rx"], {"match_confidence": "high", "meds": ["m"]})
        self.assertIsNone(lines[1]["rx"])
        self.assertEqual(res["by_rx_match_confidence"], {"high": 1, "none": 1})

    def test_output_is_valid_jsonl_and_no_text_on_stdout(self):
        self.basic("m1")
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write("m1\n")
        out = os.path.join(self._td.name, "o.jsonl")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = ex.main(["--uids", uf, "--out", out, "--root", self.s.root, "--index", self.s.index, "--caa-manifest", self.s.caa])
        self.assertEqual(rc, 0)
        shown = buf.getvalue()
        for needle in ("namaste", "greetings", "m1", "DOC1"):
            self.assertNotIn(needle, shown)
        self.assertEqual(json.loads(shown)["counts"]["lines"], 1)

    def test_read_only_on_store(self):
        self.basic("ro")
        self.s.flush()
        def snap():
            return sorted((p, os.stat(p).st_mtime_ns, os.stat(p).st_size) for base in (self.s.root,) for p, _, fs in [(r, d, f) for r, d, f in os.walk(base)] for p in [os.path.join(p, f) for f in fs])
        a = snap()
        i0 = (os.stat(self.s.index).st_mtime_ns, os.stat(self.s.caa).st_mtime_ns)
        self.s.run(["ro"])
        self.assertEqual(a, snap())
        self.assertEqual(i0, (os.stat(self.s.index).st_mtime_ns, os.stat(self.s.caa).st_mtime_ns))


if __name__ == "__main__":
    unittest.main()
