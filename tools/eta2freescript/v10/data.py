"""FRX-V10 versioned data files and their provenance (C7, rule 28).

Every list the number layer reads lives in a versioned file under tools/eta2freescript/data/ (or the contract bundle, or the repo's catalogue
export) and is loaded here once. Only a refuted change may edit them (rule 3). `provenance()` returns the sha256 of each, which every artifact
records next to profile_version and the served model id."""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

PKG = Path(__file__).resolve().parents[1]
DATA = PKG / "data"
CONTRACT = PKG / "contract_v1" / "data"
REPO = PKG.parents[1]
CATALOGUE_FILE = REPO / "data" / "drug-lexicon.json"

NUMBER_LEXICON = DATA / "number_lexicon.v1.json"
THRESHOLDS = DATA / "detector_thresholds.v1.json"
DOSING_WORDS = DATA / "dosing_words.v1.json"
WHITELIST = DATA / "clinical_whitelist.v1.json"
WHITELIST_EXTRA = DATA / "whitelist_extra.v1.json"
WHITELIST_ABBREV = DATA / "whitelist_abbrev.v1.json"
SUPPORT_HEDGES = DATA / "support_hedges.v1.json"
NUMBER_HOMOGRAPHS = DATA / "number_homographs.v1.json"
ANALYTES = DATA / "slots" / "analytes.v1.json"
SLOT_BOUNDS = DATA / "slots" / "slot_bounds.v1.json"
DICTIONARY_FILES = (CONTRACT / "scowl_words.json", CONTRACT / "english_words_min.json",
                    CONTRACT / "clinical_vocab_extra.json", CONTRACT / "clinical_abbreviations.json")


@lru_cache(maxsize=None)
def load(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def file_sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def files_sha(paths) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(file_sha(p).encode())
    return h.hexdigest()


def thresholds() -> dict:
    return load(THRESHOLDS)


def provenance() -> dict:
    """C7 + rule 28: the sha of the dictionary, clinical whitelist, catalogue snapshot (with its date), dosing-word list and analytes.v1.json,
    plus the number lexicon and the detector thresholds."""
    cat = load(CATALOGUE_FILE)
    return {
        "dictionary_sha256": files_sha(DICTIONARY_FILES),
        "clinical_whitelist_sha256": file_sha(WHITELIST),
        "whitelist_extra_sha256": file_sha(WHITELIST_EXTRA),
        "whitelist_abbrev_sha256": file_sha(WHITELIST_ABBREV),
        "support_hedges_sha256": file_sha(SUPPORT_HEDGES),
        "number_homographs_sha256": file_sha(NUMBER_HOMOGRAPHS),
        "catalogue_snapshot_sha256": file_sha(CATALOGUE_FILE),
        "catalogue_snapshot_date": str(cat.get("version") or ""),
        "dosing_words_sha256": file_sha(DOSING_WORDS),
        "analytes_sha256": file_sha(ANALYTES),
        "number_lexicon_sha256": file_sha(NUMBER_LEXICON),
        "detector_thresholds_sha256": file_sha(THRESHOLDS),
        "slot_bounds_sha256": file_sha(SLOT_BOUNDS),
    }
