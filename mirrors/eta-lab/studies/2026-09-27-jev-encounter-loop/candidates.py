"""Regex candidate generators (README §C): run on `orig` (pre-translation, any-script-safe for the
transliterated phrase lists) so a chunk with no English translation still gets a code-only signal.
Pure function, no I/O, per skill rule 10 (counting/keyword matching stays in code, not Jev)."""
import re
import jev_loop_constants as K

_OPEN_RE = re.compile("|".join(K.OPENING_PHRASES), re.I)
_CLOSE_RE = re.compile("|".join(K.CLOSING_PHRASES), re.I)


def hits(chunk):
    orig = (chunk.get("orig") or "").lower()
    return {"opening": bool(_OPEN_RE.search(orig)), "closing": bool(_CLOSE_RE.search(orig))}
