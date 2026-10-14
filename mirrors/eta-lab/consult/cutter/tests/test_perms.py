import os, stat, tempfile, unittest
from cutter import config as C, store as SO

class Perms(unittest.TestCase):
    def test_root_and_every_dir_0700_including_an_existing_0775_root(self):
        root = tempfile.mkdtemp(); C.CLIPS = f"{root}/clips"; C.INDEX = f"{C.CLIPS}/index.jsonl"
        os.makedirs(C.CLIPS); os.chmod(C.CLIPS, 0o775)                                  # the state found on the box
        d = f"{C.CLIPS}/2026-10-07/opd-7/c1"; SO.ensure_dir(d)
        for p in (C.CLIPS, f"{C.CLIPS}/2026-10-07", f"{C.CLIPS}/2026-10-07/opd-7", d): self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o700, p)
        SO.append_index(dict(consult_uid="c1"))
        self.assertEqual(stat.S_IMODE(os.stat(C.INDEX).st_mode), 0o600)
if __name__ == "__main__": unittest.main()
