"""build_seed.py: refuses a file with no redaction tags at all (a defense-in-depth check against the RAW, non-de-identified
file being pointed at by mistake), refuses the raw file's exact name, requires+verifies per-consult de-id provenance against
the raw file (eta-refuter-2 #4809/#4822, surg-link's add_deid_provenance.py), writes 0700/0600, matches consult_id across the
source files. Synthetic data only. Run: python3 tools/pitch-review/test_build_seed.py"""
import importlib.util, json, os, stat, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEID_VERSION = {"deid_py_sha256": "test-sha", "gliner_version": "0.2.29", "transformers_version": "4.51.3",
                "model_commit": "test-model", "backbone_commit": "test-backbone"}


def load():
    spec = importlib.util.spec_from_file_location("build_seed", HERE / "build_seed.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def modes(root):
    bad = []
    for p in [Path(root), *Path(root).rglob("*")]:
        mode = stat.S_IMODE(p.stat().st_mode)
        if mode & 0o077:
            bad.append((str(p), oct(mode)))
    return bad


def mk_pair(m, cid, raw_turns, deid_turns, day="2026-09-25", link_status="confirmed", jev_proposals=None, provenance=None):
    """A raw consult and its correctly-provenanced de-identified counterpart, matched by construction."""
    raw_c = {"consult_id": cid, "day": day, "turns": raw_turns}
    deid_c = {"consult_id": cid, "day": day, "link_status": link_status, "turns": deid_turns, "jev_proposals": jev_proposals or {},
              **(provenance if provenance is not None else {"deid_version": DEID_VERSION, "raw_sha256": m.fingerprint(raw_turns), "turns_processed": len(deid_turns)})}
    return raw_c, deid_c


class BuildSeed(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp())

    def write(self, detail, reasons, raw):
        df = self.t / "detail.json"; df.write_text(json.dumps(detail))
        rf = self.t / "reasons.jsonl"; rf.write_text("\n".join(json.dumps(r) for r in reasons) + ("\n" if reasons else ""))
        raf = self.t / "raw.json"; raf.write_text(json.dumps(raw))
        return df, rf, raf

    def test_refuses_a_file_with_no_redaction_tags_at_all(self):
        m = load()
        detail = [{"consult_id": "c1", "day": "2026-09-25", "link_status": "confirmed",
                   "turns": [{"lang": "en", "text_en": "plain invented text, nothing redacted"}],
                   "jev_proposals": {}, "deid_version": DEID_VERSION, "raw_sha256": "irrelevant", "turns_processed": 1}]
        df, rf, raf = self.write(detail, [{"consult_id": "c1", "reason": "keyword hit"}], [])
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_builds_and_writes_private_when_redaction_tags_present(self):
        m = load()
        raw1 = [{"lang": "en", "text_native": "hello Priya, take this medicine"}, {"lang": "kn", "text_native": "invented native line"}]
        deid1 = [{"lang": "en", "text_en": "hello [PATIENT_NAME], take this medicine"}, {"lang": "kn", "text_native": "invented native line"}]
        raw_c1, deid_c1 = mk_pair(m, "c1", raw1, deid1, jev_proposals={"pitched_surgery": {"value": "no", "p_yes": 0.03}, "procedure_family": {"value": "none", "p_yes": None}})
        raw2 = [{"lang": "en", "text_native": "call 9876543210 to confirm"}]
        deid2 = [{"lang": "en", "text_en": "call [PHONE] to confirm"}]
        raw_c2, deid_c2 = mk_pair(m, "c2", raw2, deid2, link_status="probable")
        df, rf, raf = self.write([deid_c1, deid_c2], [{"consult_id": "c1", "reason": "keyword hit (surgery_general)"}, {"consult_id": "c2", "reason": "keyword hit (injection)"}], [raw_c1, raw_c2])
        m.build(str(df), str(rf), str(raf), str(self.t / "out"))
        doc = json.loads((self.t / "out" / "seed_docs.json").read_text())
        self.assertEqual(len(doc["rows"]), 2)
        r1 = next(r for r in doc["rows"] if r["id"] == "c1")
        self.assertEqual(r1["reason"], "keyword hit (surgery_general)")
        self.assertEqual(r1["link_status"], "confirmed")
        self.assertEqual(len(r1["turns"]), 2)
        self.assertEqual(r1["jev"]["pitched_surgery"], {"value": "no", "p_yes": 0.03})
        self.assertEqual(r1["jev"]["patient_agreed"], {"value": "", "p_yes": None})   # a field Jev didn't return still has a slot
        self.assertNotIn("deid_version", r1); self.assertNotIn("raw_sha256", r1); self.assertNotIn("turns_processed", r1)   # provenance never reaches the rater
        self.assertEqual(modes(self.t / "out"), [])

    def test_duplicate_consult_id_refused(self):
        m = load()
        raw_c, deid_c = mk_pair(m, "c1", [{"text_native": "same content"}], [{"text_en": "[ID] noted"}])
        df, rf, raf = self.write([deid_c, deid_c], [], [raw_c])
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_refuses_the_raw_filename_outright(self):
        """eta-refuter-2 #4809 (D2): even with redaction tags present (e.g. a mixed/partially-processed file), the exact
        raw basename is refused - a cheap, content-independent check the whole-file tag scan alone can't provide."""
        m = load()
        detail = [{"consult_id": "c1", "day": "2026-09-25",
                   "turns": [{"lang": "en", "text_en": "hello [PATIENT_NAME], take this medicine"}]}]
        rf = self.t / "reasons.jsonl"; rf.write_text("")
        df = self.t / "review-list-detail.json"; df.write_text(json.dumps(detail))   # the raw file's OWN name
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(self.t / "raw.json"), str(self.t / "out"))

    def test_refuses_a_consult_missing_provenance(self):
        """eta-refuter-2 #4809 (D1): every consult must prove de-id ran over it - a missing field is not waved through."""
        m = load()
        raw_c, deid_c = mk_pair(m, "c1", [{"text_native": "hello Priya"}], [{"text_en": "hello [PATIENT_NAME]"}])
        del deid_c["raw_sha256"]
        df, rf, raf = self.write([deid_c], [], [raw_c])
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_refuses_turns_processed_mismatch(self):
        m = load()
        raw_c, deid_c = mk_pair(m, "c1", [{"text_native": "hello Priya"}], [{"text_en": "hello [PATIENT_NAME]"}])
        deid_c["turns_processed"] = 2   # claims 2, file has 1 turn
        df, rf, raf = self.write([deid_c], [], [raw_c])
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_refuses_raw_sha256_mismatch(self):
        """The de-identified turns must be a transform of THIS raw file's turns, not a stale copy or a substitute."""
        m = load()
        raw_c, deid_c = mk_pair(m, "c1", [{"text_native": "hello Priya"}], [{"text_en": "hello [PATIENT_NAME]"}])
        deid_c["raw_sha256"] = "0" * 64   # tampered / stale
        df, rf, raf = self.write([deid_c], [], [raw_c])
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_refuses_missing_raw_counterpart(self):
        m = load()
        raw_c, deid_c = mk_pair(m, "c1", [{"text_native": "hello Priya"}], [{"text_en": "hello [PATIENT_NAME]"}])
        df, rf, raf = self.write([deid_c], [], [])   # raw file has no c1 at all
        with self.assertRaises(SystemExit):
            m.build(str(df), str(rf), str(raf), str(self.t / "out"))

    def test_fingerprint_matches_surg_links_spec(self):
        """Locked to the exact rule in surg-link's pitch/add_deid_provenance.py (eta-refuter-2 #4822 verified it against
        the real raw file) - a silent drift here would make every future consult refuse for the wrong reason."""
        import hashlib
        m = load()
        turns = [{"text_native": "a", "text_en": "b"}, {"text_native": None, "text_en": "c"}]
        want = hashlib.sha256(("a\x00b" + "\x1e" + "\x00c").encode("utf-8")).hexdigest()
        self.assertEqual(m.fingerprint(turns), want)


if __name__ == "__main__":
    unittest.main()
