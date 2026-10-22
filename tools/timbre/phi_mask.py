"""Conservative PHI masking for Timbre text.

This repo has no general de-identification step (the surgery-review masker lives in eta-lab
and is pilot-only). This module is the local stand-in for the text lane. It over-masks
phones, emails, and id numbers, and it masks a name only when a cue introduces it
(Mr/Mrs/Ms/Shri/Smt, a native-script honorific, or "my name is", or a suffix
-avare / -ji / -garu). Doctor names after "Dr" are left in place.

Devanagari, Kannada, Tamil, and Telugu digits are folded to ASCII before phone,
Aadhaar, PAN, age, and labeled-id matches. The fold is one code point to one
code point, so the span replaced in the original text is the span that matched.

Tags match the programme's de-id vocabulary: [PATIENT_NAME] [PHONE] [ID] [ADDRESS]
[DOB] [EMAIL] [AGE]. A span that is already one of those tags is not rewritten.

`residual_kinds` is the send gate. After masking, a phone, email, Aadhaar, or PAN still
visible means the window is not sent to Jev.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from dataclasses import dataclass, field

TAG_PATIENT_NAME = "[PATIENT_NAME]"
TAG_PHONE = "[PHONE]"
TAG_ID = "[ID]"
TAG_ADDRESS = "[ADDRESS]"
TAG_DOB = "[DOB]"
TAG_EMAIL = "[EMAIL]"
TAG_AGE = "[AGE]"

TAGS = (
    TAG_PATIENT_NAME,
    TAG_PHONE,
    TAG_ID,
    TAG_ADDRESS,
    TAG_DOB,
    TAG_EMAIL,
    TAG_AGE,
)

_TAG_RE = re.compile(r"\[(?:PATIENT_NAME|PHONE|ID|ADDRESS|DOB|EMAIL|AGE)\]")

# Devanagari ०-९, Kannada ೦-೯, Tamil ௦-௯, Telugu ౦-౯. One char in, one char out.
_DIGIT_FOLD = str.maketrans(
    {chr(base + i): str(i) for base in (0x0966, 0x0CE6, 0x0BE6, 0x0C66) for i in range(10)}
)

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_AADHAAR = re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)")
_PAN = re.compile(r"\b[A-Za-z]{5}\d{4}[A-Za-z]\b")
# 10-digit Indian mobile, optional +91 / 91 / leading 0, optional separators.
_PHONE = re.compile(
    r"(?<!\d)(?:\+?\s*91[\s-]?)?(?:0)?(?:[6-9]\d{4}[\s-]?\d{5}|[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}|[6-9]\d{9})(?!\d)"
)
_LABELED_ID = re.compile(
    r"(?i)(?<!\w)(uhid|mrn|abha|aadhaar|aadhar|pan|patient\s*id|id\s*(?:no\.?|number|#)"
    r"|ಆಧಾರ್|आधार|ஆதார்|ఆధార్)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/\-]{3,})"
)
_DOB = re.compile(
    r"(?i)\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|born\s+on)\b\s*[:\-]?\s*\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}"
)
_AGE = re.compile(
    r"(?i)(?:\b(?:age[d]?|aged)\s*[:=]?\s*(?:9[0-9]|[1-9]\d{2})\b"
    r"|\b(?:9[0-9]|[1-9]\d{2})\s*(?:years?|yrs?)\s*old\b"
    r"|(?<!\d)(?:9[0-9]|[1-9]\d{2})\s*(?:ವರ್ಷ(?:ಗಳ)?|ವಯಸ್ಸು|वर्ष|साल|வயது|ఏళ్లు|ఏళ్ళు|సంవత్సరాలు))"
)
_PIN = re.compile(r"(?i)\b(?:pin\s*code|pincode)\b\s*[:#-]?\s*[1-9]\d{5}\b")
_HOUSE = re.compile(
    r"(?i)\b(?:h\.?\s*no\.?|house\s+no\.?|flat\s+no\.?|plot\s+no\.?)\s*[A-Za-z0-9][A-Za-z0-9/\-]{0,16}"
)
_STREET = re.compile(
    r"(?i)\b\d{1,4}\s+(?:[A-Za-z]+\s+){0,3}(?:street|st\.?|road|rd\.?|nagar|colony|lane|marg)\b"
)
# A letter in Latin or in the four clinic scripts, plus the vowel signs and
# viramas in those blocks. Those marks are not `\w`, so a Kannada or Tamil
# name would otherwise split in the middle and only the last consonant would
# be eligible for a cue. Digits are not a name. A period is not part of a
# token: it was gluing the previous word ("slept. Lakshmi-garu") into the name.
_INDIC_MARK = (
    r"\u0900-\u0903\u093A-\u094F\u0951-\u0957\u0962-\u0963"
    r"\u0B82-\u0B83\u0BBE-\u0BCD\u0BD7"
    r"\u0C00-\u0C04\u0C3E-\u0C56\u0C62-\u0C63"
    r"\u0C81-\u0C84\u0CBC-\u0CCD\u0CD5-\u0CD6\u0CE2-\u0CE3"
)
_LETTER = rf"(?:[^\W\d_]|[{_INDIC_MARK}])"
_NAME_TOK = rf"{_LETTER}(?:{_LETTER}|['\-]){{0,40}}"
_NAME_GRP = rf"({_NAME_TOK}(?:\s+{_NAME_TOK}){{0,2}})"
_HONORIFIC = re.compile(
    rf"(?i)\b(?:mr|mrs|ms|miss|shri|shrimati|smt|sri|thiru|thirumathi)\.?\s+{_NAME_GRP}"
)
# Longer native titles first so ಶ್ರೀಮತಿ is not read as ಶ್ರೀ + ಮತಿ.
_HONORIFIC_NATIVE = re.compile(
    r"(?:ಶ್ರೀಮತಿ|శ్రీమతి|श्रीमती|திருமதி|ಶ್ರೀ|శ్రీ|श्री|திரு)\s+" + _NAME_GRP
)
_NAME_CUE = re.compile(
    rf"(?i)\b(?:my name is|i am called|patient(?:'s)? name is|name is|ಹೆಸರು|नाम|பெயர்|పేరు)\s+{_NAME_GRP}"
)
# The token immediately before the honorific, plus one more token for a surname.
_SUFFIX_HONORIFIC = re.compile(
    rf"(?i)(?<!\w)({_NAME_TOK}(?:\s+{_NAME_TOK})?)"
    rf"[\s\-]+(?:avare|garu|ji|ಅವರೆ|గారు|जी|ஜி)(?!\w)"
)

# Words that are not a person's name. A cue followed by one of these is left alone
# ("the patient slept", "Mr said" does not occur, "name is pain" must not be masked).
_STOP = frozenset(
    {
        "a", "an", "the", "and", "or", "to", "of", "my", "is", "was", "were", "be",
        "been", "being", "said", "told", "asked", "says", "doctor", "patient", "sir",
        "madam", "please", "today", "yesterday", "pain", "have", "has", "had", "it",
        "this", "that", "for", "with", "from", "your", "you", "i", "we", "they", "he",
        "she", "not", "no", "yes", "ok", "okay", "fine", "good", "bad", "worse",
        "better", "here", "there", "now", "then", "in", "on", "at", "his", "her",
        "their", "our", "me", "him", "them",         "cough", "fever", "sleep", "slept",
        "avare", "garu", "ji",
        "ನೋವು", "ಜ್ವರ", "ಇದೆ", "ಇಲ್ಲ", "ನಿದ್ದೆ",
        "दर्द", "बुखार", "है", "नहीं",
        "வலி", "காய்ச்சல்",
        "నొప్పి", "జ్వరం",
    }
)


@dataclass
class MaskResult:
    text: str
    counts: dict[str, int] = field(default_factory=dict)
    residual: tuple[str, ...] = ()

    @property
    def n_replacements(self) -> int:
        return int(sum(self.counts.values()))


def fold_digits(text: str) -> str:
    """Map clinic-script digits to ASCII. Length in code points is unchanged."""
    return text.translate(_DIGIT_FOLD)


def residual_kinds(text: str) -> tuple[str, ...]:
    """High-confidence identifiers still visible. Names are not in this list."""
    folded = fold_digits(text)
    found: list[str] = []
    if _EMAIL.search(folded):
        found.append("email")
    if _AADHAAR.search(folded):
        found.append("aadhaar")
    if _PAN.search(folded):
        found.append("pan")
    if _PHONE.search(folded):
        found.append("phone")
    return tuple(found)


def mask_phi(text: str) -> MaskResult:
    """Return masked text and per-tag counts. Does not log the input."""
    if not isinstance(text, str):
        raise TypeError("mask_phi expects a str")
    counts: dict[str, int] = {}
    out = text
    out = _sub(out, _EMAIL, TAG_EMAIL, counts)
    # Digit-bearing patterns match the folded copy and replace that span in the
    # original, so a Kannada or Devanagari phone is masked and the surrounding
    # letters stay in their own script.
    out = _sub_folded(out, _AADHAAR, TAG_ID, counts)
    out = _sub_folded(out, _PAN, TAG_ID, counts)
    out = _sub_folded(out, _PHONE, TAG_PHONE, counts)
    out = _sub_labeled_id(out, counts)
    out = _sub_folded(out, _DOB, TAG_DOB, counts)
    out = _sub_folded(out, _AGE, TAG_AGE, counts)
    out = _sub_folded(out, _PIN, TAG_ADDRESS, counts)
    out = _sub_folded(out, _HOUSE, TAG_ADDRESS, counts)
    out = _sub_folded(out, _STREET, TAG_ADDRESS, counts)
    out = _sub_name(out, _HONORIFIC, counts)
    out = _sub_name(out, _HONORIFIC_NATIVE, counts)
    out = _sub_name(out, _NAME_CUE, counts)
    out = _sub_name(out, _SUFFIX_HONORIFIC, counts)
    return MaskResult(text=out, counts=counts, residual=residual_kinds(out))


def _outside(text: str, fn) -> str:
    parts: list[str] = []
    pos = 0
    for m in _TAG_RE.finditer(text):
        parts.append(fn(text[pos : m.start()]))
        parts.append(m.group(0))
        pos = m.end()
    parts.append(fn(text[pos:]))
    return "".join(parts)


def _sub(text: str, pattern: re.Pattern[str], tag: str, counts: dict[str, int]) -> str:
    def apply(chunk: str) -> str:
        def repl(_m: re.Match[str]) -> str:
            counts[tag] = counts.get(tag, 0) + 1
            return tag

        return pattern.sub(repl, chunk)

    return _outside(text, apply)


def _sub_folded(text: str, pattern: re.Pattern[str], tag: str, counts: dict[str, int]) -> str:
    """Match ``pattern`` on digit-folded text and splice ``tag`` into the original."""

    def apply(chunk: str) -> str:
        folded = fold_digits(chunk)
        matches = list(pattern.finditer(folded))
        if not matches:
            return chunk
        parts: list[str] = []
        pos = 0
        for m in matches:
            parts.append(chunk[pos : m.start()])
            parts.append(tag)
            counts[tag] = counts.get(tag, 0) + 1
            pos = m.end()
        parts.append(chunk[pos:])
        return "".join(parts)

    return _outside(text, apply)


def _sub_labeled_id(text: str, counts: dict[str, int]) -> str:
    def apply(chunk: str) -> str:
        folded = fold_digits(chunk)
        parts: list[str] = []
        pos = 0
        for m in _LABELED_ID.finditer(folded):
            if not re.search(r"\d", m.group(2)):
                continue
            parts.append(chunk[pos : m.start()])
            label = chunk[m.start(1) : m.end(1)]
            parts.append(f"{label} {TAG_ID}")
            counts[TAG_ID] = counts.get(TAG_ID, 0) + 1
            pos = m.end()
        parts.append(chunk[pos:])
        return "".join(parts)

    return _outside(text, apply)


@lru_cache(maxsize=1)
def _drug_names() -> frozenset[str]:
    """Drug names a name cue must never mask (Addendum A F5, case ahpierb3: a painkiller brand became [name]): the first word of every Pulse catalogue name
    (data/drug-lexicon.json) and the combination brands of eta2freescript. A missing file leaves the set empty, never an error."""
    out: set[str] = set()
    try:
        names = json.loads((Path(__file__).resolve().parents[2] / "data" / "drug-lexicon.json").read_text(encoding="utf-8")).get("names", [])
        for n in names:
            m = re.match(r"\s*([A-Za-z]{3,})", str(n))
            if m:
                out.add(m.group(1).lower())
    except (OSError, ValueError):
        pass
    try:
        from tools.eta2freescript.combinations import CATALOGUE
        out.update(CATALOGUE)
    except Exception:  # noqa: BLE001 - the allowlist is an addition; the masker must work without it
        pass
    return frozenset(out)


def _trim_name(raw: str) -> str | None:
    kept: list[str] = []
    for tok in raw.split():
        bare = tok.strip(".").lower()
        if bare in _STOP or (not kept and re.sub(r"[^a-z]", "", bare) in _drug_names()):
            break
        kept.append(tok)
        if len(kept) == 3:
            break
    if not kept:
        return None
    if len(kept) == 1 and len(kept[0].strip(".")) < 2:
        return None
    return " ".join(kept)


def _sub_name(text: str, pattern: re.Pattern[str], counts: dict[str, int]) -> str:
    def apply(chunk: str) -> str:
        out: list[str] = []
        pos = 0
        for m in pattern.finditer(chunk):
            raw = m.group(1)
            trimmed = _trim_name(raw)
            out.append(chunk[pos : m.start(1)])
            if trimmed is None or not raw.startswith(trimmed):
                out.append(raw)
            else:
                counts[TAG_PATIENT_NAME] = counts.get(TAG_PATIENT_NAME, 0) + 1
                out.append(TAG_PATIENT_NAME)
                out.append(raw[len(trimmed) :])
            pos = m.end(1)
        out.append(chunk[pos:])
        return "".join(out)

    return _outside(text, apply)
