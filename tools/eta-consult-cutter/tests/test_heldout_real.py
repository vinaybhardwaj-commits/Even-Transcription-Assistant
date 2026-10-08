"""R12: the REAL heldout.py (union sha pinned inside it) and its room-label mapping, not the FakeHO of the fixtures. Derives its cases from the file itself (no room ids or room-days in this repo)."""
import importlib.util, os, unittest
from cutter import config as C

@unittest.skipUnless(os.path.exists(C.HELDOUT), "heldout.py not on this machine")
class RealHeldout(unittest.TestCase):
    def test_union_pins_and_every_cutter_room_is_mapped(self):
        s = importlib.util.spec_from_file_location("heldout", C.HELDOUT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); union, sha = m.load_union()
        self.assertEqual(sha[:8], "f07171dc"); self.assertEqual(len(union), 14); self.assertGreaterEqual(len(m.LABEL), 7)
        by_label = {v: k for k, v in m.LABEL.items()}
        for entry in union:                                   # "<day> <label>"
            day, label = entry.split(" ", 1)
            self.assertIn(label, by_label, entry)             # every union entry maps to a room id
            self.assertTrue(m.is_held_out(union, day, by_label[label]), entry)
            others = [r for r, l in m.LABEL.items() if l != label and f"{day} {l}" not in union]
            for r in others: self.assertFalse(m.is_held_out(union, day, r), (day, r))      # same day, another room: not blind
            self.assertFalse(m.is_held_out(union, "2099-01-01", by_label[label]))           # a day outside the union: not blind
if __name__ == "__main__": unittest.main()
