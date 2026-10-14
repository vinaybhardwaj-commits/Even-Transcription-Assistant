"""Synthetic fixtures only (no patient text). Probes: exact hit, one-mishearing fuzzy hit, unrelated gibberish not
flagged, wrong-drug substitution flagged, multi-word brand name, word-count gating, and the two regressions
refuter-2 (D1) / refuter-3 (X1) found in v1 (uid-space instead of drug-identity comparison)."""
from detect_drug_mentions import (
    build_groups, truth_group, detect_drug_groups, hit_group_ids, false_drug_groups, chance_hit_groups,
)

# d1a/d1b: SAME generic (paracetamol) at two strengths -> two uids, one identity group (models "Dolo 650"/"Dolo 500").
# d2: different drug (azithromycin/Azithral).
# d3: a supplement-style row with NO generic_name -> falls back to brand_name as its own identity.
LEX = [
    {"uid": "u-1a", "brand_name": "BrandA 650", "generic_name": "Paracetamol"},
    {"uid": "u-1b", "brand_name": "BrandA 500", "generic_name": "Paracetamol"},
    {"uid": "u-2", "brand_name": "Azithral", "generic_name": "Azithromycin"},
    {"uid": "u-3", "brand_name": "Omega Daily Tab", "generic_name": ""},
]


def test_exact_hit():
    groups, _ = build_groups(LEX)
    assert "paracetamol" in detect_drug_groups("please take paracetamol twice a day", LEX)


def test_mishearing_fuzzy_hit():
    # W50's own example shape: a real drug misheard by the ASR.
    assert "azithromycin" in detect_drug_groups("please take azithromicin for five days", LEX)


def test_gibberish_not_flagged():
    assert not detect_drug_groups("please take blah blah nothing here", LEX)


def test_multiword_brand_digit_form():
    # ASR engines emit numbers as digits ("650"), not spelled out ("six fifty") - see LIMITS note in the module docstring.
    assert "paracetamol" in detect_drug_groups("take branda 650 for fever", LEX)


def test_wordcount_gating_no_coincidence():
    assert not detect_drug_groups("metaphor collector unrelated", LEX)


def test_supplement_row_no_generic_falls_back_to_brand():
    groups, name_to_group = build_groups(LEX)
    assert name_to_group[__import__("detect_drug_mentions").identity_key("Omega Daily Tab")] == \
        __import__("detect_drug_mentions").identity_key("Omega Daily Tab")


# --- regressions: refuter-2 D1 / refuter-3 X1 (v1 compared uid, not drug identity) ---

def test_truth_brand_engine_says_generic_is_not_false():
    """truth = BrandA 650 (u-1a); engine correctly says the generic 'paracetamol' -> must be a HIT, never false."""
    _, name_to_group = build_groups(LEX)
    truth = {truth_group(["BrandA 650"], name_to_group)}
    text = "continue paracetamol as before"
    assert false_drug_groups(text, LEX, truth) == set()
    assert hit_group_ids(text, LEX, truth) == truth


def test_truth_sibling_strength_is_not_false():
    """truth = BrandA 650 (u-1a, paracetamol); engine says the OTHER strength's brand name 'BrandA 500' (u-1b, same
    generic) -> same identity group, must not be counted as a false drug (this is exactly v1's bug: two different uids
    of the same drug, each firing a separate false hit)."""
    _, name_to_group = build_groups(LEX)
    truth = {truth_group(["BrandA 650"], name_to_group)}
    text = "switched to branda 500 instead"
    assert false_drug_groups(text, LEX, truth) == set()


def test_wrong_drug_is_still_false():
    """truth = BrandA 650 (paracetamol) only; engine adds azithral (a genuinely different drug) -> that IS false."""
    _, name_to_group = build_groups(LEX)
    truth = {truth_group(["BrandA 650"], name_to_group)}
    text = "continue paracetamol and start azithral"
    assert false_drug_groups(text, LEX, truth) == {name_to_group[__import__("detect_drug_mentions").identity_key("Azithral")]}


def test_truth_group_resolves_from_alt_list():
    _, name_to_group = build_groups(LEX)
    # alt list may contain a mix of known aliases; only one needs to match.
    assert truth_group(["Some Other Alias", "Paracetamol"], name_to_group) == "paracetamol"
    assert truth_group(["totally unknown name"], name_to_group) is None


# --- refuter-3 Y1: the matcher must actually catch W50's own headline mishearing example, and multi-word names must
# survive junk-stripping to become reachable at all (v2 required an exact word-count match, so any name with an
# embedded strength/form word, e.g. "TELMA BETA 50MG TAB", was structurally unreachable) ---

LEX_METFORMIN = [{"uid": "u-m", "brand_name": "Metformin", "generic_name": "Metformin"}]
LEX_MULTIWORD = [{"uid": "u-tb", "brand_name": "Telma Beta 50mg Tab", "generic_name": "Telmisartan Metoprolol"}]
LEX_JUNK_ONLY = [{"uid": "u-junk", "brand_name": "50mg Tablet", "generic_name": ""}]


def test_w50_headline_example_not_caught_documents_the_limit():
    # W50.txt's own motivating example ("Metformin" -> "medphomi") is NOT detected at the calibrated budget - a looser,
    # length-relative budget WAS tried and rejected (decoy false-positive rate 2.20% -> 46.89%, see _max_dist's
    # docstring and ADDENDUM-4). This test documents the limit so a future change to _max_dist has to look at it,
    # not silently regress the decoy rate again.
    assert "metformin" not in detect_drug_groups("please continue medphomi as before", LEX_METFORMIN)


def test_multiword_name_survives_junk_stripping():
    # "Telma Beta 50mg Tab" strips to "Telma Beta" (2 words) - now reachable at width 2, was unreachable (4 != 2) in v2.
    _, name_to_group = build_groups(LEX_MULTIWORD)
    key = name_to_group[__import__("detect_drug_mentions").identity_key("Telma Beta 50mg Tab")]
    assert key in detect_drug_groups("start telma beta today", LEX_MULTIWORD)


def test_junk_only_entry_detects_nothing():
    # refuter-2 E2: doctors say "... mg tablet" constantly; a lexicon entry with no real drug word must never fire.
    assert not detect_drug_groups("take one 40 mg tablet after food", LEX_JUNK_ONLY)
    assert not detect_drug_groups("please take a mg tablet", LEX_JUNK_ONLY)


# --- refuter-3 C1 (bus #4887): the chance-hit guard must exclude groups the consult and its chance partner both
# genuinely have (5/49 real cases on the actual 22/23/24 Sep data) - otherwise a correct recall of a SHARED drug also
# counts as a "chance" hit and gets wrongly subtracted, penalising the engines that recall correctly. ---

def test_chance_hit_excludes_shared_truth_group():
    """C's own truth = {paracetamol}; partner's truth = {paracetamol, azithromycin} (shares paracetamol with C).
    Engine correctly says paracetamol -> must NOT count as a chance hit (it's real recall of C's own drug, and also
    happens to be true of the partner - excluding it is exactly what stops the guard penalising real recall)."""
    own_truth = {"paracetamol"}
    partner_truth = {"paracetamol", "azithromycin"}
    text = "continue paracetamol as advised"
    assert chance_hit_groups(text, LEX, own_truth, partner_truth) == set()


def test_chance_hit_still_catches_a_real_chance_match():
    """Partner's truth has azithromycin (NOT in C's own truth) - a spurious mention of it is a genuine chance hit."""
    own_truth = {"paracetamol"}
    partner_truth = {"paracetamol", "azithromycin"}
    text = "started azithral for this"
    assert chance_hit_groups(text, LEX, own_truth, partner_truth) == {"azithromycin"}
