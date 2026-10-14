import hashlib, json, subprocess, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import g3_seed


def mk(items, clips=None, extra=None):
    d = Path(tempfile.mkdtemp()); (d / "audio").mkdir()
    raw = json.dumps({"items": items}).encode(); (d / "items.json").write_bytes(raw)
    for i in (clips if clips is not None else [x["item_id"] for x in items]):
        (d / "audio" / f"{i}.m4a").write_bytes(b"x")
    (d / "key.json").write_text('{"i1": {"A": "v1"}}')
    return d, hashlib.sha256(raw).hexdigest()


I = lambda i, **k: {"item_id": i, "consult_id": "c", "A": "Paracetamol 500 mg", "B": "(nothing)", **k}


class G3Seed(unittest.TestCase):
    def test_ok_and_key_never_listed(self):
        d, sha = mk([I("i1"), I("i2")])
        raw, ids = g3_seed.check(d, sha[:12])
        self.assertEqual(ids, ["i1", "i2"])
        self.assertNotIn("key", "".join(ids))
    def fails(self, *a):
        with self.assertRaises(SystemExit): g3_seed.check(*a)
    def test_refusals(self):
        d, sha = mk([I("i1")]); self.fails(d, "0" * 12)                                   # wrong sha
        self.fails(d, "abc")                                                                # too-short sha
        d, sha = mk([I("i1", system="v1")]); self.fails(d, sha)                            # side label
        d, sha = mk([I("i1"), I("i1")], clips=["i1"]); self.fails(d, sha)                  # duplicate ids
        d, sha = mk([I("i1")], clips=[]); self.fails(d, sha)                               # missing clip
        d, sha = mk([I("i1")], clips=["i1", "stray"]); self.fails(d, sha)                  # clip without item
        d, sha = mk([I("../x")]); self.fails(d, sha)                                       # bad id
        d, sha = mk([I("i1", A="x" * 201)]); self.fails(d, sha)                            # long string

    def test_absent_fails_closed(self):
        R = lambda rc, err: subprocess.CompletedProcess([], rc, "", err)
        self.assertTrue(g3_seed.absent(R(1, "The specified key does not exist. [code: 10007]")))
        self.assertFalse(g3_seed.absent(R(1, "Authentication error [code: 10000]")))     # auth/network failure is NOT absence
        self.assertFalse(g3_seed.absent(R(1, "fetch failed")))
        self.assertFalse(g3_seed.absent(R(0, "")))


if __name__ == "__main__":
    unittest.main()
