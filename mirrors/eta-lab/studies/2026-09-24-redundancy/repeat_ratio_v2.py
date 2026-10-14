#!/usr/bin/env python3
"""The canonical repeat-ratio measures (Fable ruling 109: "eta-repeat-ratio definition v2"), implemented from the repo's own sources:
  docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-CC-KICKOFF-14-SEP-2026.md  section 1  (measures A and B)
  docs/handoff/ETA-M4-WHISPER-VS-ROUTE-QUALITY-14-SEP-2026.md  "Choices the kickoff did not settle" 1-3
The memory note `eta-repeat-ratio-definition-14-sep` those briefs cite does not exist (ETA-Refuter, 19 Sep) and the M4 script
(scratch/M4-MEASURE-14-SEP-2026.py.txt) is not in any branch, so this follows the DOCUMENTED rules; where they are silent the
choice is listed under AMBIGUITIES and must be read with the numbers.

Normalise (per token): lowercase; strip punctuation except . ? ! ; tokens are split on whitespace and KEEP their . ? ! so
`you.` != `you`. A token that normalises to nothing is dropped.

A. PHRASE LOOP (primary). A loop is a maximal run in which ONE n-gram of n = 3..12 words repeats 3+ times back to back with no
   tokens between. At each token, scanning left to right, the SMALLEST n with 3+ repeats wins; scanning resumes after the run.
     redundant_words = (repeats - 1) * n
     redundant_chars = raw characters from the first char of the SECOND occurrence to the last char of the loop (inner spaces count)
     repeat_ratio    = sum(redundant_chars) / len(raw joined text)
B. REPEATED SENTENCE (supplementary). Split on . ? ! ; normalise; runs of 2+ consecutive identical sentences; count of runs and
   raw characters beyond the first occurrence.

AMBIGUITIES (choices made here, not in the docs): "punctuation" = Unicode category P* only (symbols such as $ + = are kept; the
Devanagari danda is P and is stripped); character spans are measured on the RAW text by keeping each token's raw offsets; a 2-word
phrase repeated ("thank you. thank you. thank you.") is NOT an A loop (n starts at 3) and shows up in B instead.

Text is only ever handled in memory: nothing here prints, logs or writes text. Counts and ratios only.
"""
import re
import unicodedata

_KEEP = frozenset(".?!")
_WORD = re.compile(r"\S+")
MIN_N, MAX_N, MIN_REPS = 3, 12, 3


def _norm(chunk):
    return "".join(c for c in chunk.lower() if c in _KEEP or not unicodedata.category(c).startswith("P"))


def _tokens(raw):
    out = []
    for m in _WORD.finditer(raw):
        n = _norm(m.group())
        if n:
            out.append((n, m.start(), m.end()))
    return out


def phrase_loops(raw):
    """Measure A. Returns the list of loops: {n, reps, redundant_words, redundant_chars}."""
    t = _tokens(raw)
    toks = [x[0] for x in t]
    N, i, runs = len(toks), 0, []
    while i < N:
        found = None
        for n in range(MIN_N, MAX_N + 1):
            if i + MIN_REPS * n > N:
                break
            g = toks[i:i + n]
            reps = 1
            while i + (reps + 1) * n <= N and toks[i + reps * n:i + (reps + 1) * n] == g:
                reps += 1
            if reps >= MIN_REPS:
                found = (n, reps)
                break
        if found:
            n, reps = found
            runs.append({"n": n, "reps": reps, "redundant_words": (reps - 1) * n,
                         "redundant_chars": t[i + reps * n - 1][2] - t[i + n][1],
                         # where the loop sits in the RAW text, and the repeated unit (normalised tokens): for classifying
                         # WHY a downstream guard did or did not remove it. Additive: nothing above depends on them.
                         "span": (t[i][1], t[i + reps * n - 1][2]), "unit": tuple(toks[i:i + n])})
            i += reps * n
        else:
            i += 1
    return runs


def repeat_ratio(raw):
    """Measure A's repeat_ratio: redundant chars / total chars of the raw joined text (0.0 for empty text)."""
    return sum(r["redundant_chars"] for r in phrase_loops(raw)) / len(raw) if raw else 0.0


def repeated_sentences(raw):
    """Measure B. Returns {runs, redundant_chars}: runs of 2+ consecutive identical normalised sentences."""
    parts = []
    for m in re.finditer(r"[^.?!]+", raw):
        s = " ".join(_norm(m.group()).replace(".", "").replace("?", "").replace("!", "").split())
        if s:
            parts.append((s, len(m.group().strip())))
    runs = chars = 0
    i = 0
    while i < len(parts):
        j = i + 1
        while j < len(parts) and parts[j][0] == parts[i][0]:
            j += 1
        if j - i >= 2:
            runs += 1
            chars += sum(p[1] for p in parts[i + 1:j])
        i = j
    return {"runs": runs, "redundant_chars": chars}


def _selftest():
    assert phrase_loops("") == [] and repeat_ratio("") == 0.0
    assert phrase_loops("one two three four five six") == []
    # exactly two repeats is ordinary speech, not a loop
    assert phrase_loops("go to the shop go to the shop") == []
    r = phrase_loops("so a b c a b c a b c then")
    assert len(r) == 1 and (r[0]["n"], r[0]["reps"], r[0]["redundant_words"]) == (3, 3, 6), r
    # redundant chars: from the 2nd occurrence's first char to the loop's last char
    raw = "x a b c a b c a b c"
    assert phrase_loops(raw)[0]["redundant_chars"] == len("a b c a b c"), phrase_loops(raw)
    assert abs(repeat_ratio(raw) - len("a b c a b c") / len(raw)) < 1e-9
    # span = first char of the FIRST occurrence to the last char of the loop; unit = the repeated normalised tokens
    assert phrase_loops(raw)[0]["span"] == (2, len(raw)) and phrase_loops(raw)[0]["unit"] == ("a", "b", "c")
    # the SMALLEST n wins: 6 reps of a 3-gram is one n=3 loop, not two n=6
    assert [(x["n"], x["reps"]) for x in phrase_loops(" ".join(["a b c"] * 6))] == [(3, 6)]
    # `you.` != `you`: differing end punctuation breaks the run
    assert phrase_loops("i see you. i see you i see you.") == []
    assert len(phrase_loops("i see you. i see you. i see you.")) == 1
    # case and inner punctuation are ignored, . ? ! are not
    assert len(phrase_loops("It is, ok It is ok IT IS OK")) == 1
    # a 2-word phrase repeated is NOT an A loop (n starts at 3)
    assert phrase_loops("thank you. thank you. thank you. thank you.") == []
    # B: 2+ consecutive identical normalised sentences
    assert repeated_sentences("Thank you. Thank you. Thank you.") == {"runs": 1, "redundant_chars": 18}
    assert repeated_sentences("Yes. No. Yes. No.")["runs"] == 0
    # B needs only TWO consecutive identical sentences (a run of exactly two counts; one does not)
    assert repeated_sentences("Okay. Okay.") == {"runs": 1, "redundant_chars": 4}
    assert repeated_sentences("Okay. Fine.")["runs"] == 0
    # the n range is 3..12 inclusive: a 12-word phrase x3 IS a loop, a 13-word phrase x3 is NOT
    twelve = " ".join(f"w{k}" for k in range(12))
    assert [(x["n"], x["reps"]) for x in phrase_loops(" ".join([twelve] * 3))] == [(12, 3)]
    thirteen = " ".join(f"w{k}" for k in range(13))
    assert phrase_loops(" ".join([thirteen] * 3)) == []
    assert repeated_sentences("")["runs"] == 0
    return True


_selftest()
