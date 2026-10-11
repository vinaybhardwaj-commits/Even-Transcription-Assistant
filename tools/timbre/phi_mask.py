"""Conservative PHI masking for Timbre text.

This repo has no general de-identification step (the surgery-review masker lives in eta-lab
and is pilot-only). This module is the local stand-in for the text lane. It over-masks
phones, emails, and id numbers, and it masks a name only when a cue introduces it
(Mr/Mrs/Ms/Shri/Smt, or "my name is"). Doctor names after "Dr" are left in place.

Tags match the programme's de-id vocabulary: [PATIENT_NAME] [PHONE] [ID] [ADDRESS]
[DOB] [EMAIL] [AGE]. A span that is already one of those tags is not rewritten.

`residual_kinds` is the send gate. After masking, a phone, email, Aadhaar, or PAN still
visible means the window is not sent to Jev.
"""

from __future__ import annotations

import re
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

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_AADHAAR = re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)")
_PAN = re.compile(r"\b[A-Za-z]{5}\d{4}[A-Za-z]\b")
# 10-digit Indian mobile, optional +91 / 91 / leading 0, optional separators.
_PHONE = re.compile(
    r"(?<!\d)(?:\+?\s*91[\s-]?)?(?:0)?(?:[6-9]\d{4}[\s-]?\d{5}|[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}|[6-9]\d{9})(?!\d)"
)
_LABELED_ID = re.compile(
    r"(?i)\b(uhid|mrn|abha|aadhaar|aadhar|pan|patient\s*id|id\s*(?:no\.?|number|#))\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9/\-]{3,})"
)
_DOB = re.compile(
    r"(?i)\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|born\s+on)\b\s*[:\-]?\s*\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}"
)
_AGE = re.compile(
    r"(?i)\b(?:(?:age[d]?|aged)\s*[:=]?\s*(?:9[0-9]|[1-9]\d{2})|(?:9[0-9]|[1-9]\d{2})\s*(?:years?|yrs?)\s*old)\b"
)
_PIN = re.compile(r"(?i)\b(?:pin\s*code|pincode)\b\s*[:#-]?\s*[1-9]\d{5}\b")
_HOUSE = re.compile(
    r"(?i)\b(?:h\.?\s*no\.?|house\s+no\.?|flat\s+no\.?|plot\s+no\.?)\s*[A-Za-z0-9][A-Za-z0-9/\-]{0,16}"
)
_STREET = re.compile(
    r"(?i)\b\d{1,4}\s+(?:[A-Za-z]+\s+){0,3}(?:street|st\.?|road|rd\.?|nagar|colony|lane|marg)\b"
)
_HONORIFIC = re.compile(
    r"(?i)\b(?:mr|mrs|ms|miss|shri|shrimati|smt|sri)\.?\s+"
    r"([A-Za-z][A-Za-z.'\-]{0,40}(?:\s+[A-Za-z][A-Za-z.'\-]{0,40}){0,2})"
)
_NAME_CUE = re.compile(
    r"(?i)\b(?:my name is|i am called|patient(?:'s)? name is|name is)\s+"
    r"([A-Za-z][A-Za-z.'\-]{0,40}(?:\s+[A-Za-z][A-Za-z.'\-]{0,40}){0,2})"
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
        "their", "our", "me", "him", "them", "cough", "fever", "sleep", "slept",
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


def residual_kinds(text: str) -> tuple[str, ...]:
    """High-confidence identifiers still visible. Names are not in this list."""
    found: list[str] = []
    if _EMAIL.search(text):
        found.append("email")
    if _AADHAAR.search(text):
        found.append("aadhaar")
    if _PAN.search(text):
        found.append("pan")
    if _PHONE.search(text):
        found.append("phone")
    return tuple(found)


def mask_phi(text: str) -> MaskResult:
    """Return masked text and per-tag counts. Does not log the input."""
    if not isinstance(text, str):
        raise TypeError("mask_phi expects a str")
    counts: dict[str, int] = {}
    out = text
    out = _sub(out, _EMAIL, TAG_EMAIL, counts)
    # Bare Aadhaar / PAN / phone before the labeled-id pass. A labeled value stops at
    # the first space, so "Aadhaar 2345 6789 0123" would otherwise leave the tail.
    out = _sub(out, _AADHAAR, TAG_ID, counts)
    out = _sub(out, _PAN, TAG_ID, counts)
    out = _sub(out, _PHONE, TAG_PHONE, counts)
    out = _sub_labeled_id(out, counts)
    out = _sub(out, _DOB, TAG_DOB, counts)
    out = _sub(out, _AGE, TAG_AGE, counts)
    out = _sub(out, _PIN, TAG_ADDRESS, counts)
    out = _sub(out, _HOUSE, TAG_ADDRESS, counts)
    out = _sub(out, _STREET, TAG_ADDRESS, counts)
    out = _sub_name(out, _HONORIFIC, counts)
    out = _sub_name(out, _NAME_CUE, counts)
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


def _sub_labeled_id(text: str, counts: dict[str, int]) -> str:
    def apply(chunk: str) -> str:
        def repl(m: re.Match[str]) -> str:
            if not re.search(r"\d", m.group(2)):
                return m.group(0)
            counts[TAG_ID] = counts.get(TAG_ID, 0) + 1
            return f"{m.group(1)} {TAG_ID}"

        return _LABELED_ID.sub(repl, chunk)

    return _outside(text, apply)


def _trim_name(raw: str) -> str | None:
    kept: list[str] = []
    for tok in raw.split():
        bare = tok.strip(".").lower()
        if bare in _STOP:
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
