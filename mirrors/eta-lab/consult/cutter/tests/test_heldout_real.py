"""R12: the REAL heldout.py (union f07171dc) and its room-label mapping, not the FakeHO of the fixtures."""
import importlib.util, os, unittest
from cutter import config as C

@unittest.skipUnless(os.path.exists(C.HELDOUT), "heldout.py not on this machine")
class RealHeldout(unittest.TestCase):
    def test_union_pins_and_every_cutter_room_is_mapped(self):
        s = importlib.util.spec_from_file_location("heldout", C.HELDOUT); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); union, sha = m.load_union()
        self.assertEqual(sha[:8], "f07171dc"); self.assertEqual(len(union), 14)
        for room in ("room_yh3etjpf", "room_87frpus9", "room_ux92qpws", "room_4ggnkg5x", "room_pnyc9u49", "room_qyzghzaf", "room_bh6jtq4t"): self.assertIn(room, m.LABEL, room)       # the 7 OPD rooms of the export
        self.assertTrue(m.is_held_out(union, "2026-09-28", "room_qyzghzaf")); self.assertTrue(m.is_held_out(union, "2026-09-23", "room_4ggnkg5x")); self.assertFalse(m.is_held_out(union, "2026-10-07", "room_qyzghzaf"))
        self.assertFalse(m.is_held_out(union, "2026-09-28", "room_yh3etjpf"))                       # same day, another room: not blind
if __name__ == "__main__": unittest.main()
