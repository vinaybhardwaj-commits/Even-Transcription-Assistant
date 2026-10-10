"""Synthetic fixtures only: every vector here is generated, none is a real embedding."""
import json, math, os, subprocess, sys, tempfile, unittest
import load

UID_A, UID_B = "A" * 20, "b1" * 10
def unit(seed):
    v = [math.sin(seed * (i + 1)) for i in range(load.DIM)]
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v]
def doc(uid=UID_A, **kw):
    d = {"doctor_ref": uid, "embedding_model": load.MODEL, "revision": "rev1", "dim": 192, "embedding": unit(1),
         "n_segments": 12, "source": {"room_id": "room_fake1", "window_ids": ["bw_f1", "bw_f2", "bw_f1"]}}
    d.update(kw)
    return d

class Validate(unittest.TestCase):
    def ok(self, d): return load.validate(d, "f.json")
    def bad(self, d, frag):
        with self.assertRaises(load.PackError) as c: load.validate(d, "f.json")
        self.assertIn(frag, str(c.exception))
    def test_good(self):
        r = self.ok(doc()); self.assertEqual(r["uid"], UID_A); self.assertEqual(len(r["embedding"]), 192)
        self.assertEqual((r["n_windows"], r["windows_offered"], r["n_days"], r["support"], r["n_segments"]), (2, 2, 1, 1.0, 12))
        self.assertEqual(r["defaulted"], ["n_days", "support"])
    def test_exact_shape(self):
        d = doc(); d["extra"] = 1; self.bad(d, "unknown ['extra']")
        for k in ("revision", "dim", "n_segments", "source"):
            d = doc(); del d[k]; self.bad(d, f"missing ['{k}']")
    def test_dim_field(self):
        self.bad(doc(dim=191), "dim"); self.bad(doc(dim="192"), "dim")
    def test_revision_segments_source(self):
        self.bad(doc(revision=" "), "revision"); self.bad(doc(n_segments=0), "n_segments"); self.bad(doc(n_segments=True), "n_segments")
        self.bad(doc(source={"room_id": "r"}), "source"); self.bad(doc(source={"room_id": "r", "window_ids": []}), "window_ids")
        self.bad(doc(source={"room_id": "r", "window_ids": ["a"], "x": 1}), "source")
    def test_dim(self):
        self.bad(doc(embedding=unit(1)[:191]), "192"); self.bad(doc(embedding=unit(1) + [0.0]), "192")
    def test_non_finite(self):
        e = unit(1); e[3] = float("nan"); self.bad(doc(embedding=e), "non-finite")
        e[3] = float("inf"); self.bad(doc(embedding=e), "non-finite")
        e[3] = "x"; self.bad(doc(embedding=e), "non-finite")
        e[3] = True; self.bad(doc(embedding=e), "non-finite")
    def test_norm(self):
        self.bad(doc(embedding=[x * 1.02 for x in unit(1)]), "norm"); self.bad(doc(embedding=[0.0] * 192), "norm")
        self.ok(doc(embedding=[x * 1.005 for x in unit(1)]))
    def test_model_exact(self):
        self.bad(doc(embedding_model=load.MODEL + " "), "exactly"); self.bad(doc(embedding_model="speechbrain/spkrec-ecapa"), "exactly")
        self.bad(doc(embedding_model="pyannote/embedding"), "exactly")
    def test_uid_shape(self):
        for u in ("A" * 19, "A" * 21, "A" * 19 + "-", "", None, 7): self.bad(doc(uid=u), "20-char")
    def test_name_fields(self):
        for k in ("name", "doctor_name", "full_name", "email", "phone", "speaker_label"): self.bad(doc(**{k: "x"}), "name-like")
        self.bad(doc(source={"room_id": "r", "window_ids": ["a"], "Display_Name": "x"}), "name-like")

class Build(unittest.TestCase):
    def pack(self, docs):
        d = tempfile.mkdtemp()
        for i, x in enumerate(docs):
            with open(os.path.join(d, f"{i}.json"), "w") as f: json.dump(x, f)
        return d
    def test_sql_shape(self):
        sql = load.build(self.pack([doc(UID_A), doc(UID_B)]))
        self.assertTrue(sql.startswith("-- ")); self.assertEqual(sql.count("BEGIN;"), 1); self.assertTrue(sql.rstrip().endswith("COMMIT;"))
        self.assertEqual(sql.count("INSERT INTO pulse_doctor_voice\n"), 2)
        self.assertEqual(sql.count("UPDATE pulse_doctor_voice\n"), 2)
        self.assertIn("\"revision\": \"rev1\"", sql); self.assertIn("\"window_ids\": [\"bw_f1\", \"bw_f2\"]", sql); self.assertIn("retired_by = 'room_mic_pack'", sql); self.assertIn("\"source\": \"room_mic_pack\"", sql)
        self.assertIn("retired_at IS NULL", sql); self.assertNotIn("DELETE", sql)
        self.assertEqual(sql.count("ARRAY["), 2)
    def test_one_bad_refuses_all(self):
        with self.assertRaises(load.PackError): load.build(self.pack([doc(UID_A), doc(UID_B, embedding=unit(1)[:5])]))
    def test_duplicate_uid(self):
        with self.assertRaises(load.PackError) as c: load.build(self.pack([doc(UID_A), doc(UID_A, embedding=unit(2))]))
        self.assertIn("repeats", str(c.exception))
    def test_empty_dir(self):
        with self.assertRaises(load.PackError): load.build(tempfile.mkdtemp())
    def test_refusal_never_prints_the_vector(self):
        e = unit(1); e[0] = float("nan")
        with self.assertRaises(load.PackError) as c: load.build(self.pack([doc(embedding=e)]))
        self.assertNotIn(repr(unit(1)[1]), str(c.exception))
    def test_never_connects(self):
        with open(load.__file__.replace(".pyc", ".py")) as fh: src = fh.read()
        imports = {l.split()[1] for l in src.splitlines() if l.startswith(("import ", "from "))}
        self.assertEqual(imports, {"hashlib", "json", "math", "os", "re", "sys"})
    def test_cli(self):
        d = self.pack([doc(UID_A)])
        r = subprocess.run([sys.executable, load.__file__, d], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0); self.assertIn("BEGIN;", r.stdout); self.assertEqual(r.stderr, "")
        r = subprocess.run([sys.executable, load.__file__, self.pack([doc(uid="short")])], capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout), (1, ""))

if __name__ == "__main__": unittest.main()
