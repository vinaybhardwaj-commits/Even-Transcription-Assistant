import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.dont_write_bytecode = True
import gen_index as G
from test_gen_index import Base, row


class TestLengthFlags(Base):
    def page(self, **kw):
        r = row("u1", **kw); self.make_files(r)
        return self.render([r])

    def test_long_chip_red_with_close_reason(self):
        h = self.page(minutes=122.0, close_reason="idle_timeout")
        self.assertIn('<span class="chip no">long: 122 min, likely not one consult (window closed by idle_timeout)</span>', h)
        self.assertIn('data-long="1"', h)
        self.assertNotIn("very short", h)

    def test_long_boundary_is_30_min_inclusive(self):
        self.assertIn("long: 30 min", self.page(minutes=30.0, close_reason="url_clear"))
        h = self.page(minutes=29.9)
        self.assertNotIn("long:", h)
        self.assertNotIn('data-long="1"', h)

    def test_long_chip_unknown_close_reason(self):
        self.assertIn("(window closed by unknown)", self.page(minutes=45))

    def test_very_short_chip_amber(self):
        h = self.page(minutes=1.21)
        self.assertIn('<span class="chip warn">very short</span>', h)
        self.assertNotIn("long:", h)
        self.assertNotIn("very short", self.page(minutes=2.0))  # 2.0 is not < 2

    def test_normal_and_missing_minutes_get_no_length_chip(self):
        for kw in ({"minutes": 12}, {"minutes": None}, {"minutes": "x"}):
            h = self.page(**kw)
            self.assertNotIn("long:", h)
            self.assertNotIn("very short", h)

    def test_close_reason_is_escaped(self):
        self.assertIn("&lt;b&gt;", self.page(minutes=60, close_reason="<b>"))

    def test_hide_checkbox_per_doctor_page_and_header_note(self):
        r1, r2 = row("a", doctor_uid="A", doctor_name="Dr A"), row("b", doctor_uid="B", doctor_name="Dr B")
        h = self.render([r1, r2])
        self.assertEqual(h.count('<input type="checkbox" class="hidelong">'), 2)
        self.assertEqual(h.count("hide consults over 30 min"), 2)
        self.assertIn("Boundaries come from the Pulse page open/close; long ones usually mean the patient page was left open.", h)
        self.assertNotIn("hidelong\" checked", h)  # default unchecked
        self.assertNotIn("localStorage", h)

    def test_hide_js_hooks_present(self):
        self.assertIn("hidelong", G.JS)
        self.assertIn(".c[data-long]", G.JS)


if __name__ == "__main__":
    unittest.main()
