import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import link3_t9 as T9


def _w(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f)


def _sha(t):
    import hashlib
    return hashlib.sha256(t.encode("utf-8")).hexdigest()


class T9ScreenTests(unittest.TestCase):
    def test_screen_marks_uncovered_when_no_kept_turns(self):
        with tempfile.TemporaryDirectory() as d:
            old = T9.MT
            try:
                T9.MT = d + "/"
                _w(d + "/translated.json", [{"item": "c004", "room": "l3-c004-r0", "i": 0, "lang": "hi", "at": "2026-09-24T10:00:00+05:30", "q": "garbled", "drop_reason": "garbled"}])
                _w(d + "/deid.json", [{"item": "c004", "room": "l3-c004-r0", "i": 0, "en_deid": "x", "at": "2026-09-24T10:00:00+05:30"}])
                T9.cmd_screen()
                with open(d + "/screen_report.json") as f:
                    report = json.load(f)
                self.assertEqual(report["status"], "OK")
                self.assertEqual(report["total"]["uncovered_items"], 1)
                self.assertTrue(os.path.exists(d + "/score_input.json"))
            finally:
                T9.MT = old

    def test_screen_blocks_without_deid(self):
        with tempfile.TemporaryDirectory() as d:
            old = T9.MT
            try:
                T9.MT = d + "/"
                _w(d + "/translated.json", [{"item": "c004", "room": "l3-c004-r0", "i": 0, "lang": "hi", "at": "2026-09-24T10:00:00+05:30", "q": "ok", "en": "x"}])
                _w(d + "/deid.json", [])
                T9.cmd_screen()
                with open(d + "/screen_report.json") as f:
                    report = json.load(f)
                self.assertEqual(report["status"], "BLOCKED_NO_DEID")
                self.assertEqual(report["kept_without_deid"], 1)
                self.assertFalse(os.path.exists(d + "/score_input.json"))
            finally:
                T9.MT = old

    def test_screen_uncovered_needs_kept_indic_not_english(self):
        """Review F1: an item whose only kept turns are native English is UNCOVERED for T9."""
        with tempfile.TemporaryDirectory() as d:
            old = T9.MT
            try:
                T9.MT = d + "/"
                _w(d + "/translated.json", [
                    {"item": "c004", "room": "l3-c004-r0", "i": 0, "lang": "en", "at": "2026-09-24T10:00:00+05:30", "q": "ok", "en": "e", "src": "native"},
                    {"item": "c004", "room": "l3-c004-r0", "i": 1, "lang": "hi", "at": "2026-09-24T10:00:10+05:30", "q": "ok", "en": "h", "src": "337b"},
                    {"item": "c006", "room": "l3-c006-r0", "i": 0, "lang": "en", "at": "2026-09-24T10:00:00+05:30", "q": "ok", "en": "e", "src": "native"},
                ])
                _w(d + "/deid.json", [
                    {"item": "c004", "room": "l3-c004-r0", "i": 0, "en_deid": "e", "at": "2026-09-24T10:00:00+05:30"},
                    {"item": "c004", "room": "l3-c004-r0", "i": 1, "en_deid": "h", "at": "2026-09-24T10:00:10+05:30"},
                    {"item": "c006", "room": "l3-c006-r0", "i": 0, "en_deid": "e", "at": "2026-09-24T10:00:00+05:30"},
                ])
                T9.cmd_screen()
                with open(d + "/screen_report.json") as f:
                    report = json.load(f)
                self.assertEqual(report["status"], "OK")
                self.assertEqual(report["items"]["c004"]["status"], "OK")
                self.assertEqual(report["items"]["c004"]["kept_indic"], 1)
                self.assertEqual(report["items"]["c006"]["status"], "UNCOVERED")
                self.assertEqual(report["items"]["c006"]["kept"], 1)
                self.assertEqual(report["total"]["uncovered_items"], 1)
            finally:
                T9.MT = old


class AssembleBase(unittest.TestCase):
    """Invented-data harness for cmd_assemble: a fake manifest, a fake window index over temp record
    files written under a path containing /runs/ (so _k_from_entry parses), and a snapshot list."""

    SEG_AT = "2026-09-24T10:00:00+05:30"

    def build(self, segs, ann_items, manifest_items=None, extra_snap=None):
        tmp = tempfile.TemporaryDirectory(prefix="t9-")
        self.addCleanup(tmp.cleanup)
        self.d = tmp.name
        wid = "l3-c004-r0"
        rec_path = os.path.join(self.d, "hist", "runs", "r1", wid, "2026-09-24", wid + ".json")
        _w(rec_path, {"window_id": wid, "ok": True, "state": "done", "start": "2026-09-24T10:00:00+05:30", "segments": segs})
        ann_path = os.path.join(self.d, "ann", "202609251200-linker.json")
        _w(ann_path, {"items": ann_items})
        snap = [{"path": ann_path, "sha256": "x", "name": os.path.basename(ann_path)}]
        for name, items in (extra_snap or []):
            p = os.path.join(self.d, "ann", name)
            _w(p, {"items": items})
            snap.append({"path": p, "sha256": "x", "name": name})
        snap.sort(key=lambda x: x["name"])
        k = "r1/%s/2026-09-24/%s" % (wid, wid)
        man = {"c004": {"rooms": [{"id": wid, "turns": len(segs), "non_english_share": 0.9, "non_english": 1}]}}
        for it in (manifest_items or []):
            man.setdefault(it, {"rooms": [{"id": "l3-%s-r0" % it, "turns": 1, "non_english_share": 0.9, "non_english": 1}]})
        return dict(man=man, index={wid: {"path": rec_path, "run_id": "r1", "attempt": False}}, snapshot=snap, mt_dir=self.d + "/mt/", k=k, wid=wid, rec_path=rec_path)

    def run_assemble(self, h):
        T9.cmd_assemble(man=h["man"], index=h["index"], snapshot=h["snapshot"], mt_dir=h["mt_dir"])
        with open(self.d + "/mt/translated.json") as f:
            translated = json.load(f)
        with open(self.d + "/mt/provenance.json") as f:
            prov = json.load(f)
        with open(self.d + "/mt/assemble_report.json") as f:
            report = json.load(f)
        return translated, prov, report

    def seg(self, text, lang, start_s=0.0):
        return {"text": text, "lang": lang, "start_s": start_s}

    def ann(self, k, i, text, q="ok", en="some english", err=None, src_sha256=None):
        a = {"k": k, "i": i, "src_sha256": src_sha256 if src_sha256 is not None else _sha(text), "q": q}
        if en is not None:
            a["en"] = en
        if err is not None:
            a["err"] = err
        return a

    def rows(self, translated):
        return {(r["i"]): r for r in translated}


class T9AssembleTests(AssembleBase):
    def test_keeps_ok_indic_turn(self):
        h = self.build([self.seg("indic line one", "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, "indic line one")])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(len(translated), 1)
        r = translated[0]
        self.assertEqual((r["src"], r["q"], r["lang"]), ("337b", "ok", "hi"))
        self.assertFalse(r.get("dropped", False))
        self.assertEqual(report["items"]["c004"]["status"], "OK")
        self.assertEqual(report["items"]["c004"]["kept_indic"], 1)
        self.assertEqual(prov["items"]["c004"]["status"], "MT_OK")
        # the total is over all 19 ITEMS_T9 by kept-indic (fail-closed): the fake manifest defines only c004,
        # whose kept indic turn covers it, so the other 18 count as uncovered here
        self.assertEqual(report["total"]["uncovered_items"], 18)

    def test_keeps_english_but_item_is_uncovered(self):
        """Review F1: kept English alone never covers an item for T9."""
        h = self.build([self.seg("some english words", "en")], [])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(translated[0]["src"], "native")
        self.assertEqual(report["items"]["c004"]["kept"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)
        self.assertEqual(report["items"]["c004"]["status"], "UNCOVERED")
        self.assertEqual(prov["items"]["c004"]["status"], "UNCOVERED")
        self.assertEqual(report["total"]["uncovered_items"], 19)

    def test_drops_garbled(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, q="garbled", en=None)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["garbled"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)
        self.assertEqual(prov["items"]["c004"]["status"], "UNCOVERED")
        self.assertTrue(translated[0].get("dropped"))

    def test_drops_untranslatable(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, q="untranslatable", en=None)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["untranslatable"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_err_as_mt_failed(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, err="boom", en=None)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["mt_failed"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_other_q_as_mt_failed(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, q="weird", en=None)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["mt_failed"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_stale(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, src_sha256="0" * 64)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["stale"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_empty_en(self):
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, en="   ")])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["empty_en"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_missing_337b(self):
        h = self.build([self.seg("indic line one", "hi")], [])   # no annotation item at all
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["dropped"]["missing_337b"], 1)
        self.assertEqual(report["items"]["c004"]["kept_indic"], 0)

    def test_drops_out_of_scope_lang(self):
        """v7.18a (review F2): lang neither English-by-the-pinned-rule nor one of the 8 Indic tags is dropped and counted."""
        for lang in ("und", "pa", "", "fr"):
            with self.subTest(lang=lang):
                h = self.build([self.seg("mystery words", lang)], [])
                translated, prov, report = self.run_assemble(h)
                self.assertEqual(report["items"]["c004"]["dropped"]["out_of_scope_lang"], 1)
                self.assertEqual(report["items"]["c004"]["kept_indic"], 0)
                self.assertEqual(report["items"]["c004"]["kept"], 0)
                self.assertTrue(translated[0].get("dropped"))

    def test_snapshot_last_wins_by_file_name(self):
        """v7.18 R2.2: per (k, i) the last item by file name wins."""
        t = "indic line one"
        k = "r1/l3-c004-r0/2026-09-24/l3-c004-r0"
        first = self.ann(k, 0, t, en="earlier english")
        second = self.ann(k, 0, t, en="later english")
        # base snapshot file is named 202609251200-linker.json; an extra file sorting before it must lose to it
        h = self.build([self.seg(t, "hi")], [first], extra_snap=[("0000-early-linker.json", [second])])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(translated[0]["en"], "earlier english")
        # an extra file sorting after it must win
        h2 = self.build([self.seg(t, "hi")], [first], extra_snap=[("zzzz-late-linker.json", [second])])
        translated2, prov2, report2 = self.run_assemble(h2)
        self.assertEqual(translated2[0]["en"], "later english")

    def test_counts_unresolved_rooms(self):
        """Review F4: a room missing from the index is counted and reported, never dropped silently."""
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t)])
        h["index"] = {}          # the room does not resolve
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["total"]["unresolved_rooms"], 1)
        self.assertEqual(report["total"]["unresolved_room_ids"], ["l3-c004-r0"])
        self.assertEqual(translated, [])

    def test_window_uncovered_room_count(self):
        """v7.18 R3: a window with Indic turns and none kept counts as an uncovered room."""
        t = "indic line one"
        h = self.build([self.seg(t, "hi")], [self.ann("r1/l3-c004-r0/2026-09-24/l3-c004-r0", 0, t, q="garbled", en=None)])
        translated, prov, report = self.run_assemble(h)
        self.assertEqual(report["items"]["c004"]["uncov_rooms"], 1)
        self.assertEqual(report["items"]["c004"]["rooms"], 1)

    def test_seg_index_walk_agrees_with_hist_turns(self):
        """Review F3: rows come from the pinned hist_turns; the segment-index walk must agree turn by turn."""
        segs = [self.seg("first", "en"), {"text": "   ", "lang": "hi", "start_s": 1}, self.seg("second", "hi", 2), self.seg("third", "kn", 3)]
        h = self.build(segs, [])
        translated, prov, report = self.run_assemble(h)
        en_rows = [r for r in translated if r["i"] == 0]
        self.assertEqual(en_rows[0]["lang"], "en")
        self.assertEqual(len(translated), 3)   # three non-empty segments -> three turns
        self.assertEqual(report["total"]["unresolved_rooms"], 0)

    def test_seg_index_walk_refuses_misaligned_hist_turns(self):
        """Refuter-2 #2583 should-fix: a count-equal but text-misaligned pairing must be refused, never scored."""
        segs = [self.seg("alpha words", "en"), self.seg("beta words", "hi")]
        h = self.build(segs, [])
        import link3_run as R
        real = R.hist_turns

        def shifted(path):
            rows = real(path)
            rows[0], rows[1] = rows[1], rows[0]          # same count, wrong pairing
            return rows

        R.hist_turns = shifted
        try:
            with self.assertRaises(SystemExit):
                T9.cmd_assemble(man=h["man"], index=h["index"], snapshot=h["snapshot"], mt_dir=h["mt_dir"])
        finally:
            R.hist_turns = real


if __name__ == "__main__":
    unittest.main()
