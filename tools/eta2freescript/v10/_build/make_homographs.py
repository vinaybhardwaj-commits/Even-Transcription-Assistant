"""FRX-V10 Fix3c ruling 1: data/number_homographs.v1.json, GENERATED (never hand-picked). Every word of the English dictionary we ship (words.dictionary(): scowl_words + english_words_min + the clinical whitelist) whose phonetic key
(the drug detector's own phonetic key, v10.drugs._skeleton) or whose one-edit form equals that of a number word of the lexicon (any language we carry, collision and unconditional words
included). Inside a drug-tagged or drug-flagged unit a token of this list withholds the unit (reason `collision`); outside drug units it does nothing.
Deterministic: sorted input, no randomness. Run: python -m tools.eta2freescript.v10._build.make_homographs   (idempotent; the sha is in the C7 provenance as number_homographs_sha256)."""
import hashlib
import json
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / "data"
EDIT1_MIN_LEN = 4       # a lexicon word shorter than this gives no one-edit form (too many English words)
WORD_MIN, WORD_MAX = 3, 12


_AZ = "abcdefghijklmnopqrstuvwxyz"


def neighbours(b: str) -> set[str]:
    """Every string one edit (delete, insert, substitute) away from `b`."""
    out = set()
    for i in range(len(b) + 1):
        for c in _AZ:
            out.add(b[:i] + c + b[i:])
    for i in range(len(b)):
        out.add(b[:i] + b[i + 1:])
        for c in _AZ:
            out.add(b[:i] + c + b[i + 1:])
    out.discard(b)
    return out


def build() -> dict:
    from tools.eta2freescript.v10 import drugs, numbers, words
    lex = sorted(w for w in (numbers.lexicon_set() | numbers.collision_words() | numbers._STAYS_A_NUMBER) if w.isascii() and w.isalpha() and len(w) >= 3)
    keys = {k for k in (drugs._skeleton(w) for w in lex) if len(k) >= 2}
    near: set[str] = set()
    for w in lex:
        if len(w) >= EDIT1_MIN_LEN and w not in numbers._ENGLISH_NUMERALS:
            near |= neighbours(w)
    out = []
    for w in sorted(words.dictionary() | words.catalogue_tokens()):  # the dictionary T2 allows: English + clinical + catalogue name tokens
        if not (w.isascii() and w.isalpha() and WORD_MIN <= len(w) <= WORD_MAX) or w in numbers._ENGLISH_NUMERALS or w in lex:
            continue
        if drugs._skeleton(w) in keys or w in near:
            out.append(w)
    lex_sha = hashlib.sha256((DATA / "number_lexicon.v1.json").read_bytes()).hexdigest()
    return {"version": "number-homographs.v1", "generator": "v10/_build/make_homographs.py", "lexicon_sha256": lex_sha, "count": len(out), "words": out}


def main() -> None:
    d = build()
    (DATA / "number_homographs.v1.json").write_text(json.dumps(d, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(d["count"], "homographs from a lexicon sha", d["lexicon_sha256"][:12])


if __name__ == "__main__":
    main()
