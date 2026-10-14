import contextlib
import io
import json
import os
import tempfile
import unittest

from kit.reb import export_consult_audit as eca
from kit.reb import sarvam_lane as sl
from kit.reb import translate_gapfill as tg
from tests.reb.test_export_consult_audit import Store, seg


class FakeGw:
    def __init__(self, fail_texts=(), throttle_on=None, blank_on=(), raise_exc=None, bad_response=None):
        self.throttled, self.sent, self.fail_texts, self.throttle_on, self.blank_on = 0, [], set(fail_texts), throttle_on, set(blank_on)
        self.raise_exc, self.bad_response = raise_exc, bad_response

    def call(self, method, path, payload=None, **k):
        self.sent.append((method, path, payload))
        if self.throttle_on is not None and len(self.sent) == self.throttle_on:
            self.throttled += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        if self.bad_response is not None:
            return self.bad_response
        if payload["input"] in self.fail_texts:
            raise sl.GatewayError("http 400", 400)
        if payload["input"] in self.blank_on:
            return {"request_id": "rq", "translated_text": "  "}
        return {"request_id": f"rq{len(self.sent)}", "translated_text": "EN(" + payload["input"] + ")"}


class T(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.s = Store(self._td.name)
        self.sink = sl.UsageSink(local_dir=os.path.join(self._td.name, "ledger"))
        self.held = lambda day, room: False

    def consult(self, uid, stt, translate=None, cut=True):
        d = self.s.scope(uid)
        m = json.load(open(os.path.join(d, "manifest.json")))
        m["audio"] = {"r2_key": "x", "sha256": "0" * 64, "sample_rate": 16000, "duration_ms": 1000}
        m["source_kind"] = "consult_clip"
        json.dump(m, open(os.path.join(d, "manifest.json"), "w"))
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", stt, {"created_at": "2026-10-10T08:00:00Z"})
        if translate is not None:
            self.s.track(d, "translate", "sarvam-saaras-v3", "v1", translate, {"created_at": "2026-10-10T08:05:00Z"})
        if cut:
            self.s.cut_row(uid, 0, 1000)
        return d

    def go(self, uids, write=False, gw=None, **kw):
        self.s.flush()
        return tg.run(uids, root=self.s.root, write=write, gw=gw, sink=self.sink if write else None, is_held=self.held, index_path=self.s.index, **kw)

    def gaps(self):
        # t0 english (own text), t1 translated by index, t2 and t3 are gaps (hi / kn), t4 blank
        return [seg(0, 10, "english words", "en-IN", "0"), seg(10, 20, "hindi one", "hi-IN", "0"), seg(20, 30, "hindi two", "hi-IN", "1"), seg(30, 40, "kannada", "kn-IN", "1"), seg(40, 50, "  ", "hi-IN", "0")], \
            [seg(10, 20, "translated one", "en-IN", "0")]

    def test_dry_run_counts_and_sends_nothing(self):
        stt, tr = self.gaps()
        d = self.consult("g1", stt, tr)
        self.consult("g2", [seg(0, 10, "all english", "en-IN")])
        res = self.go(["g1", "g2", "ghost"])
        self.assertEqual((res["consults"], res["consults_with_gaps"], res["turns_needed"], res["would_send_consults"], res["nothing_to_fill"], res["skipped_not_cutter"]), (3, 1, 2, 1, 1, 1))
        self.assertEqual(res["chars_needed"], len("hindi two") + len("kannada"))
        self.assertEqual(res["calls"], 0)
        self.assertFalse([f for f in os.listdir(os.path.join(d, "tracks")) if "gapfill" in f])

    def test_dry_run_with_a_gateway_given_makes_no_call(self):
        stt, tr = self.gaps()
        self.consult("g1", stt, tr)
        gw = FakeGw()
        res = self.go(["g1"], write=False, gw=gw)
        self.assertEqual((res["would_send_consults"], res["calls"], gw.sent), (1, 0, []))
        self.assertEqual([f for f in os.listdir(self.sink.dir) if f.endswith(".jsonl")], [])   # no ledger either

    def ledger(self):
        return [json.loads(l) for fn in os.listdir(self.sink.dir) if fn.endswith(".jsonl") for l in open(os.path.join(self.sink.dir, fn))]

    def test_any_exception_is_ledgered_as_failed_and_counts_toward_the_stop(self):
        import requests
        for exc in (requests.exceptions.ReadTimeout("secret-looking text"), ConnectionError("x"), ValueError("bad json"), RuntimeError("token")):
            ledger_before = len(self.ledger())
            self.consult("e" + type(exc).__name__, [seg(0, 10, "some words", "hi-IN")])
            res = self.go(["e" + type(exc).__name__], write=True, gw=FakeGw(raise_exc=exc))
            self.assertEqual((res["written"], res["call_failures"], res["failed_consults"], res["calls"]), (0, 1, 1, 1))
            self.assertEqual(res["call_errors_" + type(exc).__name__], 1)
            new = self.ledger()[ledger_before:]
            self.assertEqual([(r["status"], r["task"], r["use"], r["chars"], r["http_status"]) for r in new], [("failed", "text_translate", "research", len("some words"), None)])
            self.assertNotIn("secret-looking", json.dumps(res))
            self.assertNotIn("some words", json.dumps(new))
        # a non-dict answer (bad shape) is a failed call too
        self.consult("shape", [seg(0, 10, "more words", "hi-IN")])
        res = self.go(["shape"], write=True, gw=FakeGw(bad_response=["not", "a", "dict"]))
        self.assertEqual((res["written"], res["call_failures"]), (0, 1))
        # exceptions count toward "more than 5 failed calls"
        for i in range(8):
            self.consult(f"x{i}", [seg(0, 10, "w", "hi-IN")])
        gw = FakeGw(raise_exc=ConnectionError("down"))
        res = self.go([f"x{i}" for i in range(8)], write=True, gw=gw)
        self.assertEqual((res["stopped_failed"], res["calls"], len(gw.sent)), (1, 6, 6))

    def test_lane_begin_end_around_each_call(self):
        self.consult("ln", [seg(0, 10, "w", "hi-IN")])
        seen = []
        orig = self.sink.begin
        def begin(*a, **k):
            seen.append(("begin", a[1], k.get("mode"), k.get("model")))
            return orig(*a, **k)
        self.sink.begin = begin
        self.go(["ln"], write=True, gw=FakeGw())
        self.assertEqual(seen, [("begin", "text_translate", "sync", "mayura:v1")])
        self.assertEqual(self.sink.active, {})   # ended

    def test_main_closes_the_sink_even_when_the_run_raises(self):
        from unittest import mock
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write("g1\n")
        sink = mock.Mock()
        with mock.patch.object(tg, "load_heldout", lambda: self.held), mock.patch.object(tg.sl, "UsageSink", return_value=sink), mock.patch.object(tg.sl, "Gateway"), \
                mock.patch.object(tg.r2_mirror, "enabled", return_value=False), mock.patch.object(tg, "run", side_effect=RuntimeError("boom")), \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(RuntimeError):
                tg.main(["--uids", uf, "--write", "--root", self.s.root, "--index", self.s.index])
        sink.close.assert_called_once()

    def test_write_track_payload_ledger_and_export_roundtrip(self):
        stt, tr = self.gaps()
        d = self.consult("g1", stt, tr)
        gw = FakeGw()
        res = self.go(["g1"], write=True, gw=gw)
        self.assertEqual((res["written"], res["sent_consults"], res["calls"], res["call_failures"]), (1, 1, 2, 0))
        # only the gap turns were sent, with the turn's own language, target en-IN, model mayura:v1, on the gateway /translate path
        self.assertEqual([(m, p, pl) for m, p, pl in gw.sent], [("POST", "/translate", {"input": "hindi two", "source_language_code": "hi-IN", "target_language_code": "en-IN", "model": "mayura:v1"}),
                                                                 ("POST", "/translate", {"input": "kannada", "source_language_code": "kn-IN", "target_language_code": "en-IN", "model": "mayura:v1"})])
        (f,) = [x for x in os.listdir(os.path.join(d, "tracks")) if "gapfill" in x]
        t = json.load(open(os.path.join(d, "tracks", f)))
        self.assertEqual((t["layer"], t["engine"], t["version"], t["model"], t["status"]), ("translate", "sarvam-mayura-v1", "gapfill-v1", "mayura:v1", "ok"))
        self.assertEqual([(g["t0_ms"], g["t1_ms"], g["speaker"], g["lang"], g["text"], g["extras"]) for g in t["segments"]],
                         [(20, 30, "1", "en-IN", "EN(hindi two)", {"source_turn_index": 2, "source_language_code": "hi-IN"}), (30, 40, "1", "en-IN", "EN(kannada)", {"source_turn_index": 3, "source_language_code": "kn-IN"})])
        self.assertEqual(t["config"]["turns"], [[20, 30, "hi-IN"], [30, 40, "kn-IN"]])
        self.assertIn(t["config_hash"], f)
        # ledger: one line per call, no text, usage contract v1.2 fields
        rows = [json.loads(l) for fn in os.listdir(self.sink.dir) if fn.endswith(".jsonl") for l in open(os.path.join(self.sink.dir, fn))]
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertEqual((r["caller"], r["task"], r["mode"], r["model"], r["audio_s"], r["scope"], r["use"], r["ref"], r["status"]), ("palimpsest", "text_translate", "sync", "mayura:v1", 0, "consult_clip", "research", "g1", "ok"))
        self.assertEqual(sorted(r["chars"] for r in rows), sorted([len("hindi two"), len("kannada")]))
        self.assertNotIn("hindi", json.dumps(rows))
        # the exporter now takes them as gapfill, and nothing is left for a second pass
        self.s.flush()
        res2 = eca.export(["g1"], os.path.join(self._td.name, "o.jsonl"), root=self.s.root, index_path=self.s.index, caa_path=self.s.caa)
        line = json.loads(open(os.path.join(self._td.name, "o.jsonl")).read())
        self.assertEqual([x["text_en"] for x in line["turns"]], ["english words", "translated one", "EN(hindi two)", "EN(kannada)"])
        self.assertEqual(res2["text_en_by"]["gapfill"], 2)
        gw2 = FakeGw()
        res3 = self.go(["g1"], write=True, gw=gw2)
        self.assertEqual((res3["nothing_to_fill"], res3["calls"], len(gw2.sent)), (1, 0, 0))

    def test_drop_untranslated_applies_after_gapfill(self):
        stt, tr = self.gaps()
        stt = stt + [seg(60, 70, "never filled", "hi-IN", "0")]   # filled below only for the two gap turns; this one is added after the fill
        stt0 = stt[:5]
        d = self.consult("dg", stt0, tr)
        self.go(["dg"], write=True, gw=FakeGw())   # gap-fills the two turns
        # a later stt run (new turn) the gap-fill does not cover
        self.s.track(d, "stt", "sarvam-saaras-v3", "v1", stt, {"created_at": "2026-10-10T09:00:00Z"})
        self.s.flush()
        out = os.path.join(self._td.name, "o.jsonl")
        res = eca.export(["dg"], out, root=self.s.root, index_path=self.s.index, caa_path=self.s.caa, drop_untranslated=True)
        line = json.loads(open(out).read())
        self.assertEqual([t["text_en"] for t in line["turns"]], ["english words", "translated one", "EN(hindi two)", "EN(kannada)"])   # gap-filled kept, the unfilled one dropped
        self.assertEqual(res["dropped_turns_by_role"], {"doctor": 0, "patient": 0, "attendant": 0, "unknown": 1})   # no role tracks in this fixture
        self.assertEqual((res["dropped_consults"], res["text_en_by"]["gapfill"]), (1, 2))

    def test_same_cfg8_is_skipped_existing(self):
        stt, tr = self.gaps()
        d = self.consult("g1", stt, tr)
        self.go(["g1"], write=True, gw=FakeGw())
        # hide the gap-fill from the need computation but keep the file: the same needs now hit the existing cfg8
        m = json.load(open(os.path.join(d, "manifest.json")))
        m["tracks"] = [e for e in m["tracks"] if e["version"] != "gapfill-v1"]
        json.dump(m, open(os.path.join(d, "manifest.json"), "w"))
        gw = FakeGw()
        res = self.go(["g1"], write=True, gw=gw)
        self.assertEqual((res["skipped_existing"], res["calls"], res["written"]), (1, 0, 0))

    def test_long_text_is_split_and_joined(self):
        long = ("Sentence one is here. " * 60).strip()
        self.assertGreater(len(long), tg.MAX_CHARS)
        parts = tg.chunks(long)
        self.assertTrue(all(len(p) <= tg.MAX_CHARS for p in parts) and len(parts) >= 2)
        self.assertEqual(" ".join(parts), long)
        self.assertEqual(tg.chunks("x" * 2000)[0], "x" * tg.MAX_CHARS)
        stt = [seg(0, 10, long, "hi-IN")]
        self.consult("lg", stt)
        gw = FakeGw()
        res = self.go(["lg"], write=True, gw=gw)
        self.assertEqual((res["written"], res["calls"]), (1, len(parts)))
        self.assertTrue(all(len(p[2]["input"]) <= tg.MAX_CHARS for p in gw.sent))

    def test_one_failed_turn_writes_nothing_and_counts(self):
        stt, tr = self.gaps()
        d = self.consult("g1", stt, tr)
        res = self.go(["g1"], write=True, gw=FakeGw(fail_texts=["kannada"]))
        self.assertEqual((res["written"], res["failed_consults"], res["call_failures"]), (0, 1, 1))
        self.assertFalse([f for f in os.listdir(os.path.join(d, "tracks")) if "gapfill" in f])
        res = self.go(["g1"], write=True, gw=FakeGw(blank_on=["hindi two"]))   # a blank answer is a failure too
        self.assertEqual((res["written"], res["call_failures"]), (0, 1))
        rows = [json.loads(l) for fn in os.listdir(self.sink.dir) if fn.endswith(".jsonl") for l in open(os.path.join(self.sink.dir, fn))]
        self.assertIn("failed", {r["status"] for r in rows})

    def test_stops_after_more_than_five_failures(self):
        for i in range(8):
            self.consult(f"f{i}", [seg(0, 10, "bad text", "hi-IN")])
        gw = FakeGw(fail_texts=["bad text"])
        res = self.go([f"f{i}" for i in range(8)], write=True, gw=gw)
        self.assertEqual((res["stopped_failed"], res["call_failures"], res["calls"], res["written"]), (1, 6, 6, 0))
        self.assertEqual(len(gw.sent), 6)

    def test_stops_on_throttle(self):
        for i in range(3):
            self.consult(f"t{i}", [seg(0, 10, f"text {i}", "hi-IN")])
        gw = FakeGw(throttle_on=2)
        res = self.go(["t0", "t1", "t2"], write=True, gw=gw)
        self.assertEqual((res["stopped_throttled"], res["calls"], res["written"], res["failed_consults"]), (1, 2, 1, 1))
        self.assertEqual(len(gw.sent), 2)

    def test_limit_counts_consults_sent(self):
        for i in range(3):
            self.consult(f"l{i}", [seg(0, 10, f"text {i}", "hi-IN")])
        res = self.go(["l0", "l1", "l2"], write=True, gw=FakeGw(), limit=2)
        self.assertEqual((res["sent_consults"], res["written"], res["limit_reached"]), (2, 2, 1))

    def test_heldout_refused_before_any_send(self):
        self.consult("h1", [seg(0, 10, "text", "hi-IN")])
        self.held = lambda day, room: True
        gw = FakeGw()
        res = self.go(["h1"], write=True, gw=gw)
        self.assertEqual((res["blind_refused"], res["calls"], len(gw.sent)), (1, 0, 0))

    def test_caa_version_and_non_cutter_never_sent(self):
        d = self.s.scope("cc")
        self.s.track(d, "stt", "sarvam-saaras-v3", "caa", [seg(0, 10, "caa text", "hi-IN")])
        self.s.cut_row("cc", 0, 10)
        gw = FakeGw()
        res = self.go(["cc"], write=True, gw=gw)
        self.assertEqual((res["no_stt"], len(gw.sent)), (1, 0))

    def test_cli_dry_run_prints_counts_only(self):
        stt, tr = self.gaps()
        self.consult("g1", stt, tr)
        self.s.flush()
        uf = os.path.join(self._td.name, "u.txt")
        open(uf, "w").write("g1\n")
        buf = io.StringIO()
        from unittest import mock
        with mock.patch.object(tg, "load_heldout", lambda: self.held), contextlib.redirect_stdout(buf):
            rc = tg.main(["--uids", uf, "--root", self.s.root, "--index", self.s.index])
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertEqual((out["mode"], out["turns_needed"], out["calls"]), ("dry-run", 2, 0))
        for needle in ("hindi", "kannada", "g1"):
            self.assertNotIn(needle, buf.getvalue())


class Bundle(unittest.TestCase):
    def test_bundle_keeps_gapfill_out_of_translate_slot(self):
        from kit.reb import consult_bundle as cb
        from tests.reb.test_consult_bundle import put
        with tempfile.TemporaryDirectory() as td:
            s = Store(td)
            d = s.scope("b1")
            main = put(s, d, "translate", "sarvam-saaras-v3", "v1", extras={"created_at": "2026-10-10T08:00:00Z"})
            gf = put(s, d, "translate", "sarvam-mayura-v1", "gapfill-v1", extras={"created_at": "2026-10-10T20:00:00Z"})   # newer, but not THE translate track
            s.cut_row("b1", 1, 2)
            s.flush()
            b = cb.bundle("b1", root=s.root, index=s.index, caa_path=s.caa)
            self.assertEqual((b["tracks"]["translate"]["path"], b["tracks"]["translate_gapfill"]["path"]), (main, gf))


if __name__ == "__main__":
    unittest.main()
