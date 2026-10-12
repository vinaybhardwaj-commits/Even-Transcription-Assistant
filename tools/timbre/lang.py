"""Script and code-mix detection for clinic speech. Deterministic. No model.

Kannada, Hindi (Devanagari), Tamil, Telugu, and Latin are counted by letter.
A window is ``code_mixed`` when two of those families each hold at least 15%
of the letters. Romanised markers (``avare``, ``garu``, ``nange``, ``hai``, …)
mark a Latin string as that language, and as code-mixed when an English
function word is in the same string. ``ji`` is not a language marker: it is
only an honorific the masker knows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Second family must be at least this share of letters before the window is code-mixed.
MIX_SHARE = 0.15

_SCRIPTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("hi", re.compile(r"[\u0900-\u097F]")),
    ("kn", re.compile(r"[\u0C80-\u0CFF]")),
    ("ta", re.compile(r"[\u0B80-\u0BFF]")),
    ("te", re.compile(r"[\u0C00-\u0C7F]")),
    ("en", re.compile(r"[A-Za-z]")),
)

# Closed romanised cues. Not a lexicon of the language — just enough to tell
# a romanised patient line from English. ``ji`` is deliberately absent.
_ROMAN: dict[str, frozenset[str]] = {
    "kn": frozenset({"avare", "nange", "ide", "illa", "nodi", "swalpa", "bekku"}),
    "hi": frozenset({"hai", "nahi", "nahin", "kya", "mujhe", "mera", "bahut"}),
    "ta": frozenset({"irukku", "illai", "nalla", "ennaku", "romba"}),
    "te": frozenset({"garu", "undi", "ledu", "naku", "emiti", "chaala"}),
}
_ENGLISH_FUNCTION = frozenset(
    {
        "the", "is", "are", "was", "were", "pain", "doctor", "please", "and",
        "my", "have", "has", "had", "not", "worse", "better", "sleep", "cough",
    }
)
_WORD = re.compile(r"[A-Za-z]+")


@dataclass(frozen=True)
class LanguageHit:
    language: str
    code_mixed: bool
    counts: dict[str, int]

    @property
    def basis_script(self) -> str:
        return self.language


def detect_language(text: str) -> LanguageHit:
    """``language`` is ``kn|hi|ta|te|en|code_mixed|other|unknown``."""
    if not isinstance(text, str) or not text.strip():
        return LanguageHit("unknown", False, {})
    counts = {code: len(pattern.findall(text)) for code, pattern in _SCRIPTS}
    total = sum(counts.values())
    if total == 0:
        return LanguageHit("unknown", False, counts)
    shares = {code: counts[code] / total for code in counts}
    substantial = [code for code, share in shares.items() if share >= MIX_SHARE]
    if len(substantial) >= 2:
        return LanguageHit("code_mixed", True, counts)
    dominant = max(shares, key=lambda code: (shares[code], code))
    if shares[dominant] >= 0.5 and counts["en"] == total:
        roman = _romanised(text)
        if roman is not None:
            return roman
    if shares[dominant] >= 0.5:
        return LanguageHit(dominant, False, counts)
    return LanguageHit("other", False, counts)


def _romanised(text: str) -> LanguageHit | None:
    tokens = [m.group(0).lower() for m in _WORD.finditer(text)]
    if not tokens:
        return None
    hits = {
        code: sum(1 for tok in tokens if tok in words)
        for code, words in _ROMAN.items()
    }
    present = [code for code, n in hits.items() if n > 0]
    if not present:
        return None
    english = any(tok in _ENGLISH_FUNCTION for tok in tokens)
    counts = {"en": len(tokens)}
    if len(present) >= 2 or english:
        return LanguageHit("code_mixed", True, counts)
    return LanguageHit(present[0], False, counts)
