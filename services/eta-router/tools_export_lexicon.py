#!/usr/bin/env python3
"""Generate eta_number_words.py — the router's number lexicon as a plain frozenset another service can
drop in. Deterministic: sorted, one source (router_server.NUMBER_WORDS). Run from this checkout:

    ETA_JOBS_DIR=$(mktemp -d) ./.venv/bin/python tools_export_lexicon.py            # writes ./eta_number_words.py
    ETA_JOBS_DIR=$(mktemp -d) ./.venv/bin/python tools_export_lexicon.py OUT.py     # writes OUT.py instead

The output path is explicit so a CHECK can generate into a scratch location and compare, instead of
regenerating over the committed file — which caught a hand-edit once and then erased it, so the next run
was green and the evidence was gone (ETA-Refuter on ffbe1c7, 23 Sep).

The export is data, not logic. is_number_token's behaviour (hyphen/slash splitting, unicodedata.numeric)
is NOT in it — the header says so, because a caller that takes the words and keeps a `.isdigit()` test
gets the words without the reason they work.
"""
import os, sys, tempfile

os.environ.setdefault("ETA_JOBS_DIR", tempfile.mkdtemp())
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import router_server as R

DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "eta_number_words.py")


def lexicon_sha(words) -> str:
    """PURE — sha256 of the sorted words, newline-joined. Recomputable from the export itself."""
    import hashlib
    return hashlib.sha256("\n".join(sorted(words)).encode("utf-8")).hexdigest()[:16]
HEADER = '''"""ETA number-word lexicon — GENERATED, do not hand-edit.

Source: eta-router router_server.py (NUMBER_WORDS), {n} words, lexicon sha256 {lexsha}.
Regenerate with tools_export_lexicon.py in the eta-router checkout; a parity test
(test_lexicon_export.py) fails if this file and the router disagree.

THE HASH IS OF THE WORDS, NOT OF THE CHECKOUT, and it is self-verifying: sha256 of the sorted words
joined by newlines, which anyone can recompute from this file and compare. A commit sha was tried first
and was worse in two ways — it made the file unreproducible (generating it at one HEAD and committing it
moves HEAD, so the byte comparison failed forever after, ETA-Refuter 23 Sep), and it named the wrong
thing: two commits can carry the same lexicon, and one commit can change it.

WHAT THIS IS: every cardinal 0-100 in English, Hindi and Kannada, romanised and in native script, plus
the spoken fractions (dedh, dhai, sawa, saade, paune; kaalu, mukkalu, onduvare), ordinals and
magnitudes. The Hindi cardinals are a table (the numbers are irregular); the Kannada 21-99 are built by
sandhi from 0-20 and the tens, so the two scripts cover the same numbers by construction.

WHY IT EXISTS: a repeated number must never be collapsed as a Whisper loop. "one one one" is a 1-1-1
regimen and "pachas milligram" three times is three doses read out; a missing word can change a dose.
Over-inclusion is the safe direction — it only leaves a loop in place.

WHAT IT DOES NOT CARRY: the rest of the rule. A caller also needs
  * a token holding ANY character with a Unicode numeric value to count as a number
    (unicodedata.numeric(c, None) is not None) — this catches the vulgar fractions and every script's
    digits, which str.isdigit() misses for U+00BD and friends; and
  * a hyphen- or slash-joined token to count if ANY part does ("ek-ek", "1-0-1", "one/two"), while
    "follow-up" and "and/or" do not.
Words alone, with a `.isdigit()` test beside them, is a partial fix.
"""
'''


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    out = os.path.abspath(args[0]) if args else os.environ.get("ETA_LEXICON_OUT") or DEFAULT_OUT
    words = sorted(R.NUMBER_WORDS)
    lexsha = lexicon_sha(words)
    lines = [HEADER.format(lexsha=lexsha, n=len(words)), "", "NUMBER_WORDS = frozenset({"]
    cur = "    "
    for w in words:
        item = repr(w) + ", "
        if len(cur) + len(item) > 100:
            lines.append(cur.rstrip())
            cur = "    "
        cur += item
    lines.append(cur.rstrip())
    lines.append("})")
    lines.append("")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {out}: {len(words)} words, lexicon sha256 {lexsha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
