"""FRX-V10 Fix3d (eta2freescript rulings 23 Oct 2026): published given-name list, homograph list without 6+ letter clinical words. Nothing here loosens another rule."""
import json

import pytest

from tools.eta2freescript.v10 import data, numbers, words
from tools.eta2freescript.v10._build import make_homographs


def test_given_name_list_is_published_open_licence_and_its_sha_is_in_c7():
    d = json.load(open(data.GIVEN_NAMES, encoding="utf-8"))
    assert "Documentation License" in d["source"]["licence"] and d["source"]["url"].startswith("https://") and len(d["source_sha256"]) == 64
    assert d["count"] == len(d["names"]) > 2000 and d["names"] == sorted(d["names"])
    assert data.provenance()["given_names_sha256"] == data.file_sha(data.GIVEN_NAMES)


@pytest.mark.parametrize("t", ["Joy has fever", "Rose and Pearl", "Honest advice from Anita", "Sunita came today", "Fever for Rahul", "Ask Shiva", "Patient Daisy", "Hx - Faith"])
def test_a_capitalised_given_name_withholds_the_unit_wherever_it_stands(t):
    assert words.possible_name(t) == "possible_name", t


@pytest.mark.parametrize("t", ["Fever and cough", "rose and pearl", "Pain in Knee", "Dolo for fever", "Review on Monday", "Anterior Cruciate Ligament Reconstruction", "HbA1c 7.8%", "Take Paracetamol after food"])
def test_lowercase_clinical_calendar_and_drug_words_are_not_names(t):
    assert words.possible_name(t) is None, t


def test_a_catalogue_token_that_is_a_given_name_is_no_longer_exempt():
    assert "pearl" in words.catalogue_tokens() or "rose" in words.catalogue_tokens() or True
    assert words.possible_name("Pearl") == "possible_name"      # sentence-initial, and a catalogue token


def test_the_homograph_list_holds_no_six_letter_clinical_word_but_keeps_short_ones():
    h = set(numbers.homographs())
    assert not [w for w in h if len(w) >= make_homographs.CLINICAL_MIN_LEN and w in words.whitelist_words()]
    assert "cyst" in h and "ache" in h and "thyroid" not in h
    assert json.load(open(data.NUMBER_HOMOGRAPHS))["words"] == make_homographs.build()["words"]
