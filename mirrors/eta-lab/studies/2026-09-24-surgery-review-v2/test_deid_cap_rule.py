"""Tests for deid.py --cap-rule and the "-in-law" trim fix, on INVENTED text with an invented roster and a stub model (no model, no box files).
Run: python3 -m unittest test_deid_cap_rule -v"""
import json, os, subprocess, sys, tempfile, unittest

import deid

HERE = os.path.dirname(os.path.abspath(__file__))
ROSTER = ["Dr Testa Doctorov"]


class Stub:
    """A model that returns fixed person entities for one phrase, or none."""
    def __init__(self, phrase=None, score=0.94):
        self.phrase, self.score = phrase, score

    def predict_entities(self, text, labels, threshold=0.5):
        if self.phrase and self.phrase in text:
            i = text.index(self.phrase)
            return [{"label": "person", "start": i, "end": i + len(self.phrase), "score": self.score}]
        return []


def make(cap=True, phrase=None, own=None):
    d = deid.Deid(roster=deid.Roster(ROSTER), model=Stub(phrase), cap_rule=cap)
    d.own_doctor = own or []
    return d


def out(text, **kw):
    return make(**kw).redact(text)


class TestCapRule(unittest.TestCase):
    def test_lone_capitalised_unknown_word_is_tagged_and_labelled_cap_rule(self):
        o, tags = out("She has been looking at Zorbak since morning.")
        self.assertEqual(o, "She has been looking at [PATIENT_NAME] since morning.")
        self.assertEqual(tags, [("PATIENT_NAME", "cap_rule")])

    def test_the_library_default_is_off(self):  # fails if the default flips to on
        d = deid.Deid(roster=deid.Roster(ROSTER), model=Stub())
        self.assertFalse(d.cap_rule)
        self.assertEqual(d.redact("She has been looking at Zorbak since morning.")[0], "She has been looking at Zorbak since morning.")

    def test_a_kept_own_doctor_surname_next_to_a_garble_stays_kept(self):  # the model returns "<surname> <garble>": the surname is kept, only the garble is tagged
        o, _ = out("But Zorbakov Troll said so.", own=["zorba", "zorbakov"], phrase="Zorbakov Troll")
        self.assertEqual(o, "But Zorbakov [PATIENT_NAME] said so.")

    def test_the_model_keeps_only_the_own_doctor_surname_and_a_garble_follows(self):  # kept span is narrower than the capitalised run
        o, _ = out("But Zorbakov Troll said so.", own=["zorba", "zorbakov"], phrase="Zorbakov")
        self.assertEqual(o, "But Zorbakov [PATIENT_NAME] said so.")

    def test_the_model_keeps_only_a_roster_doctor_token_and_a_stranger_follows(self):
        o, _ = out("Ask Dr Testa Troll about it.", phrase="Testa")
        self.assertEqual(o, "Ask Dr Testa [PATIENT_NAME] about it.")

    def test_off_by_default(self):
        self.assertEqual(out("She has been looking at Zorbak since morning.", cap=False)[0], "She has been looking at Zorbak since morning.")

    def test_sentence_initial_word_is_left_to_the_model(self):
        self.assertEqual(out("Zorbak is here today.")[0], "Zorbak is here today.")
        self.assertEqual(out("It is late. Zorbak is here.")[0], "It is late. Zorbak is here.")

    def test_days_months_and_procedure_words_are_allowed(self):
        for t in ("Please come on Tuesday in March.", "We plan a Hernioplasty next week.", "Then Angiography on Friday."):
            self.assertEqual(out(t)[0], t, t)

    def test_abbreviations_are_not_allowlisted_because_they_are_also_names(self):
        for word in ("Jan", "Sun", "Sat", "Dec"):
            self.assertEqual(out(f"Then ask {word} about it.")[0], "Then ask [PATIENT_NAME] about it.", word)

    def test_plural_day_names_are_allowed_too(self):
        t = "We open on Fridays and Saturdays only."
        self.assertEqual(out(t)[0], t)

    def test_all_caps_and_short_words_are_not_matched(self):
        t = "Then the CT and MRI are done, Ok."
        self.assertEqual(out(t)[0], t)

    def test_never_a_name_words_are_allowed(self):
        t = "Thank you Sir, and Doctor please come."
        self.assertEqual(out(t)[0], t)

    def test_adjacent_capitalised_words_become_one_span(self):
        self.assertEqual(out("Then Marla Quinn called us.")[0], "Then [PATIENT_NAME] called us.")

    def test_an_allowlisted_word_splits_a_run(self):
        self.assertEqual(out("See Marla Tuesday Quinn now.")[0], "See [PATIENT_NAME] Tuesday [PATIENT_NAME] now.")

    def test_roster_doctor_is_kept_with_and_without_the_honorific(self):
        self.assertEqual(out("Ask Dr Testa about it.")[0], "Ask Dr Testa about it.")
        self.assertEqual(out("Then Testa Doctorov called us.")[0], "Then Testa Doctorov called us.")

    def test_a_patient_next_to_a_doctor_is_still_tagged(self):
        self.assertEqual(out("Then Marla Quinn and Testa Doctorov called.")[0], "Then [PATIENT_NAME] and Testa Doctorov called.")

    def test_own_doctor_surname_is_kept(self):
        self.assertEqual(out("But Zorbakov said so.", own=["zorba", "zorbakov"])[0], "But Zorbakov said so.")

    def test_bracket_artefacts_and_existing_tags_are_untouched(self):
        self.assertEqual(out("He said [Unclear] twice.")[0], "He said [Unclear] twice.")
        self.assertEqual(out("Then [Inaudible Speech] and [Background Noise Here] came.")[0], "Then [Inaudible Speech] and [Background Noise Here] came.")  # the WHOLE span
        self.assertEqual(out("See [Inaudible] Zorbak now.")[0], "See [Inaudible] [PATIENT_NAME] now.")  # text after the bracket is still covered
        o, _ = out("Then call me on 9845012345 and Zorbak.")
        self.assertEqual(o, "Then call me on [PHONE] and [PATIENT_NAME].")

    def test_a_span_the_model_already_tagged_is_not_double_tagged(self):
        o, tags = out("Then Marla Quinn came.", phrase="Marla Quinn")
        self.assertEqual(o, "Then [PATIENT_NAME] came.")
        self.assertEqual(tags, [("PATIENT_NAME", "model")])

    def test_default_output_is_unchanged_by_the_flag_existing(self):
        for t in ("My name is Marla Quinn.", "Take it twice a day, ok.", "We will do the scan on Tuesday."):
            self.assertEqual(out(t, cap=False)[0], deid.Deid(roster=deid.Roster(ROSTER), model=Stub(), cap_rule=False).redact(t)[0])


class TestInLaw(unittest.TestCase):
    def test_daughter_in_law_is_not_tagged(self):  # the model tags "your daughter-in-law" at 0.94; the trim used to leave "in-law" behind
        for cap in (False, True):
            self.assertEqual(out("Since morning your daughter-in-law has been looking.", cap=cap, phrase="your daughter-in-law")[0],
                             "Since morning your daughter-in-law has been looking.")

    def test_a_name_before_in_law_is_still_tagged(self):
        o, _ = out("This is Marla Quinn-in-law today.", cap=False, phrase="Marla Quinn-in-law")
        self.assertIn("[PATIENT_NAME]", o)


class TestCli(unittest.TestCase):
    def run_cli(self, *args):
        d = tempfile.mkdtemp(prefix="cap_rule_test_")
        inp, outp = os.path.join(d, "in.json"), os.path.join(d, "out.json")
        with open(inp, "w") as fh:
            json.dump([{"item": "a", "room": "r", "i": 0, "en": "She was looking at Zorbak yesterday."}], fh)
        p = subprocess.run([sys.executable, os.path.join(HERE, "deid.py"), "--no-model", "--fields", "en", "--to-field", "en_deid", *args, inp, outp],
                           capture_output=True, text=True)
        with open(outp) as fh:
            return p, json.load(fh)[0]

    def test_flag_turns_the_rule_on_and_counts_it(self):
        p, rec = self.run_cli("--cap-rule")
        self.assertEqual(rec["en_deid"], "She was looking at [PATIENT_NAME] yesterday.")
        self.assertEqual(rec["en"], "She was looking at Zorbak yesterday.")
        self.assertIn("PATIENT_NAME/cap_rule", json.loads(p.stdout)["redactions"])

    def test_without_the_flag_nothing_changes(self):
        _, rec = self.run_cli()
        self.assertEqual(rec["en_deid"], rec["en"])


if __name__ == "__main__":
    unittest.main()
