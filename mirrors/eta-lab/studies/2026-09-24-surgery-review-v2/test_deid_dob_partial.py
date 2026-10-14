"""Tests for the partial-DOB rules (a day and a month name next to a birth cue), on INVENTED text with an injected roster, regex layers only (no model, no box files).
Run: python3 -m unittest test_deid_dob_partial -v"""
import unittest

import deid

POSITIVE = ["Daily birthday. 6th July.", "her birthday is 6 July", "July 6 is his birthday", "born on the 6th of July", "DOB 6th July please",
            "his bday is 14 Sept", "It is my b'day on March 3rd", "Birthdate: 6th of July, thank you", "born in July", "she was born around October",
            "date of birth 12 March", "D.O.B. 12 March", "birthday is on the twelfth of March", "Birthday: March the 12th", "born on 12-Mar", "birthday 12/3", "dob 12-3",
            "twenty-first of June is her birthday"]
NEGATIVE = ["come on 6th July for the surgery", "the birthday party was fun", "She may come in 6 days", "Surgery on July 6 and discharge on July 9.",
            "Born prematurely, she is fine now.", "The 6th floor is closed in July.", "We meet in July and again in March.",
            "born 2-3 weeks early", "operate on 12th March", "you may take 2 tablets on your birthday", "the second may be late", "Surgery is on 12-Mar."]


def redact(text):
    d = deid.Deid(roster=deid.Roster(["Dr Testa Doctorov"]), use_model=False)
    return d.redact(text)


LONG_REPEAT = ("Her birthday. 12th March. Hello. What is the date? Please tell me a little more about it, thank you very much. 12th March. 12th March. Okay. 12th March.")


class TestPartialDob(unittest.TestCase):
    def test_every_repeat_of_the_anchored_date_is_tagged_even_far_from_the_cue(self):  # the real b3 shape (refuter-2 #1655): only the first date was within 30 chars of the cue
        out, _ = redact(LONG_REPEAT)
        self.assertEqual(out.count("[DOB]"), 4)
        self.assertNotIn("12th", out); self.assertNotIn("March", out)
        self.assertGreater(LONG_REPEAT.rfind("12th March") - LONG_REPEAT.find("birthday"), 30)

    def test_a_repeat_in_another_written_form_is_tagged_too(self):
        out, _ = redact("Her birthday is the twelfth of March, and I said it again: 12 March. Yes, March 12.")
        self.assertEqual(out.count("[DOB]"), 3); self.assertNotRegex(out, r"(?i)march")

    def test_a_different_date_in_the_same_turn_is_left_alone(self):
        out, _ = redact("Her birthday is 12th March and the review is on 20th April.")
        self.assertIn("20th April", out); self.assertNotIn("12th", out)

    def test_the_same_day_month_as_an_operation_date_is_tagged_when_a_cue_anchors_it(self):  # documented over-redaction
        out, _ = redact("Her birthday is 12th March and the operation is 12th March at ten.")
        self.assertEqual(out.count("[DOB]"), 2)

    def test_no_cue_in_the_turn_means_no_repeat_tagging(self):
        t = "Operate on 12th March, and review on 12th March again."
        self.assertEqual(redact(t)[0], t)

    def test_parse_daymon(self):
        for text, want in (("twenty-first of June", (21, 6)), ("March the 12th", (12, 3)), ("12-Mar", (12, 3)), ("6th July", (6, 7)), ("thirty first of Dec", (31, 12)),
                           ("Sept 14", (14, 9))):
            self.assertEqual(deid._parse_daymon(text), want, text)

    def test_partial_dates_next_to_a_birth_cue_are_tagged(self):
        for t in POSITIVE:
            out, tags = redact(t)
            self.assertIn("[DOB]", out, t)
            self.assertTrue(all(tag == "DOB" for tag, _ in tags), (t, tags))

    def test_the_month_and_day_do_not_survive(self):
        for t in POSITIVE:
            out, _ = redact(t)
            self.assertNotRegex(out, r"(?i)\b(?:jul(?:y)?|sept?|march|october)\b", t)
            self.assertNotRegex(out, r"12/3|12-3|12-Mar|twenty-first", t)

    def test_a_date_with_no_birth_cue_is_left_alone(self):
        for t in NEGATIVE:
            self.assertEqual(redact(t)[0], t, t)

    def test_the_verify_gate_sees_the_shape(self):  # finalize.residual_identifiers reuses REGEX_RULES: the raw text must hit, the redacted text must not
        for t in POSITIVE:
            self.assertTrue(any(tag == "DOB" and rx.search(t) for tag, rx in deid.REGEX_RULES), t)
            out, _ = redact(t)
            self.assertFalse(any(rx.search(out) for tag, rx in deid.REGEX_RULES if tag == "DOB"), out)

    def test_existing_dob_shapes_still_work(self):
        self.assertIn("[DOB]", redact("born 06/07/1985 in Mysore")[0])
        self.assertIn("[DOB]", redact("Date of birth 03-11-1948, please confirm.")[0])
        self.assertIn("[DOB]", redact("She was born in March 1950 in Mysore.")[0])

    def test_the_model_dob_filter_accepts_birthday_as_a_cue(self):  # \bbirth\b did not match "birthday"
        self.assertTrue(deid.DOB_CUE.search("her birthday is"))
        self.assertTrue(deid.DOB_CUE.search("his bday"))
        self.assertFalse(deid.DOB_CUE.search("the party was fun"))

    def test_the_window_is_bounded(self):  # a cue far from the date does not tag it
        far = "born " + "x" * 60 + " 6th July"
        self.assertNotIn("[DOB]", redact(far)[0].replace("born", ""))

    def test_may_the_verb_is_not_a_month_only_hit(self):
        self.assertEqual(redact("She was born, and may come in May")[0].count("[DOB]"), 0)


if __name__ == "__main__":
    unittest.main()
