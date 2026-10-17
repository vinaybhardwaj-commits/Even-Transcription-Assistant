#!/usr/bin/env python3
"""FUSER v1 B3: the deterministic validator (design section 4). This is the real safety net -- the
model is NEVER trusted on its own word; every item, entity and clause it wrote is re-checked here
against the actual REB tokens and the same deterministic parsers/lexicon the pre-pass used, and
anything that doesn't check out is dropped (or the whole slice falls back to fused.v0). Nothing
unvalidated is ever written to the fused track -- callers must use validate_slice's output, never the
model's raw reply, downstream.

V1 refs exist, belong to the slice, one track per item (the item grammar in prompt.py: "adjacent tokens
   from ONE track"), monotone in time within that track, and no source token is used by more than one
   item/conflict-option in the whole response.
V2 copy: materialised word (code-derived, by concatenating cited tokens) == NFKC-normalised item.w when
   the model supplied one (it is informational only -- code always renders from refs, never item.w -- but
   a mismatch means the model doesn't actually agree with what it cited, which is itself disqualifying).
   norm: re-run the named rule on the cited tokens' own materialised text and require the same output.
V3 clinical classes (numbers, units, drug names) can only come from copy/norm/conflict, never gen: a gen
   item whose own word parses as a number, is a unit-cue word, or skeleton-matches a lexicon drug is
   rejected outright (this is the one V-check that is never REPAIRed away quietly -- see G4).
V4 Whisper tokens in a slice with p(en) < 0.9 may be cited (copy or norm) only if the cited text is a
   number+unit/day count with a cue-anchored match in some Indic track (ETR's own find_value_anchor), or
   a lexicon drug name backed by a real two-witness match (drug_candidates) -- otherwise rejected.
V5 English entities: dose/duration values must equal the parsed value of their cited native items; drug
   entities must match the cited native item's lexicon_generic rewrite; an entity with no valid native
   link is dropped from the entity list (counted, not fatal on its own).
V6 English clause coverage: a clause with no valid item citation is dropped (counted); native items with
   no covering clause are counted as omissions (reported only -- V6 does not itself drop or fall back).

Outcome: PASS (nothing dropped) or REPAIR (drop failing items/entities/clauses; emit if dropped item
share <= 5% AND no clinical item was among the dropped) or FALLBACK (to fused.v0, status="fallback",
reasons attached) otherwise. See validate_slice.
"""
import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import drug_match as dm  # noqa: E402
import number_parse as npm  # noqa: E402
import tokenize_tracks as tt  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import router_server as rs  # noqa: E402

CLINICAL_DROP_SHARE_MAX = 0.05


def _nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "")


def flatten_tokens(tokens_by_engine: dict[str, list[dict]]) -> dict[str, dict]:
    """{token_id: {**token, "engine": engine_name}} across every track in the slice -- what V1's
    "refs exist / belong to the slice" check resolves against. Ids are unique across engines by
    construction (tokenize_tracks assigns a distinct track index k per engine)."""
    flat = {}
    for engine, toks in tokens_by_engine.items():
        for tok in toks:
            flat[tok["id"]] = {**tok, "engine": engine}
    return flat


def _is_whisper(engine: str) -> bool:
    return engine.startswith("whisper")


def materialize(refs: list[str], flat: dict[str, dict]) -> str:
    """Code's own rendering of cited tokens -- concatenation of adjacent tokens of one track, per the
    item grammar. Space-joined: every token in this codebase is a whole word (tokenize_tracks), never a
    subword piece, so word-boundary spacing is always correct here."""
    return " ".join(flat[r]["text"] for r in refs if r in flat)


def check_v1_refs(refs: list[str], flat: dict[str, dict]) -> tuple[bool, str]:
    """Refs exist (fabricated-ref check), all belong to the slice (same, since flat IS the slice's
    tokens), all cite the SAME track (the cross-track-merge adversarial case: two tracks' tokens spliced
    together and presented as one adjacent word), are monotone in time within that track, and are all
    CITABLE (eta-refuter-2 #4811 F1, BLOCKING): a token outside the slice's core span (the +-5s read-only
    context) is marked citable=False by prepass._mark_citable and never shown to the model in the payload
    (payload.build_payload drops non-citable tokens entirely) -- but "k:s:i" ids are sequential and
    therefore guessable, so nothing stopped a model from citing one anyway. Left unchecked, a context
    token's words could be emitted by TWO adjacent slices (the one it's context in, and the one it's core
    in), double-counting a drug or dose. flat must carry each token's real "citable" flag (flatten_tokens
    does this by construction) for this check to mean anything -- a caller that strips it before calling
    validate_slice would silently defeat this guard, so never do that."""
    if not refs:
        return False, "empty_refs"
    for r in refs:
        if r not in flat:
            return False, f"fabricated_ref:{r}"
    for r in refs:
        if not flat[r].get("citable", False):
            return False, f"cites_noncitable_token:{r}"
    engines = {flat[r]["engine"] for r in refs}
    if len(engines) > 1:
        return False, "cross_track_merge"
    if not tt.is_monotone(refs, flat):
        return False, "non_monotone_refs"
    return True, ""


def check_v2_copy(item: dict, flat: dict[str, dict]) -> tuple[bool, str, str]:
    ok, reason = check_v1_refs(item.get("refs", []), flat)
    if not ok:
        return False, reason, ""
    text = materialize(item["refs"], flat)
    w = item.get("w")
    if w and _nfkc(w) != _nfkc(text):
        return False, "materialization_mismatch", text
    return True, "", text


def check_v2_norm(item: dict, flat: dict[str, dict], reverse_index: dict[str, int],
                  drug_candidates: dict[str, list[dict]]) -> tuple[bool, str, str]:
    """Re-runs the named rule on the cited tokens' own materialised text and requires the model's word
    to match what the deterministic rule actually produces -- the model never gets to assert a norm
    rewrite the rule itself doesn't back."""
    ok, reason = check_v1_refs(item.get("refs", []), flat)
    if not ok:
        return False, reason, ""
    refs = item["refs"]
    text = materialize(refs, flat)
    rule = item.get("rule")
    w = item.get("w", "")
    if rule == "number_digits":
        parses = npm.parse_numbers(text, reverse_index)
        if len(parses) != 1:
            return False, "number_digits_no_single_parse", text
        p = parses[0]
        if p["token_span"] != [0, len(text.split())]:
            return False, "number_digits_partial_span", text
        if p["role"] != "value":
            return False, "number_digits_frequency_role", text
        if w != str(p["value"]):
            return False, "number_digits_value_mismatch", text
        return True, "", text
    if rule == "lexicon_generic":
        engine = flat[refs[0]]["engine"]
        ref_set = set(refs)
        # drug_candidates is keyed by the ALIGNED INDIC engine (prepass.py runs find_drug_candidates
        # once per indic engine against the SAME whisper span), never by the whisper engine itself -- a
        # whisper-track citation is searched across every indic engine's candidate list for the one
        # whose whisper_span is exactly these tokens; an indic-track citation is searched only under its
        # own engine's list (that list's indic_window is specific to that engine's alignment).
        engine_lists = (drug_candidates.values() if _is_whisper(engine) else [drug_candidates.get(engine, [])])
        for cands_list in engine_lists:
            for cands in cands_list:
                match = cands.get("match") or {}
                if match.get("name") != w:
                    continue
                if _is_whisper(engine):
                    if {t["id"] for t in cands["whisper_span"]["tokens"]} == ref_set:
                        return True, "", w
                # Indic-track citation: EXACT id-set match against drug_candidates' own aligned tokens
                # (eta-refuter-2 #4811 F3), same posture as the Whisper side -- a substring test against
                # indic_window's rendered text (the earlier version of this check) let ANY fragment
                # inside the aligned window ride in on someone else's real two-witness match, including a
                # fragment that isn't even part of what was actually matched.
                elif {t["id"] for t in cands.get("indic_tokens", [])} == ref_set:
                    return True, "", w
        return False, "lexicon_generic_no_two_witness_backing", text
    if rule == "split":
        if len(refs) != 1:
            return False, "split_not_single_token", text
        if "".join(w.split()) != flat[refs[0]]["text"] and _nfkc("".join(w.split())) != _nfkc(flat[refs[0]]["text"]):
            return False, "split_concatenation_mismatch", text
        return True, "", w
    return False, f"unknown_rule:{rule}", text


# V3 gen ALLOWLIST (lid-debug #4774): a blocklist-shaped check (does this word look like a number/unit/
# drug) was tried first and had a real safety hole -- reverse_index only recognises numbers by their
# English-by-ear/digit spellings (L6/number_parse.py's own documented scope), so a model gen-ing a
# genuinely NATIVE number word ("पचास", "ಐವತ್ತು", "ஐம்பது", "50" in no script the parser knows) sailed
# straight through uncaught. That is a FABRICATION hole, not ETR's accepted recall gap: an invented dose
# could reach the output text with no citation at all. Inverted per lid-debug's own fix: gen is accepted
# ONLY for a word in this closed, curated connecting-word/filler list, with NO digit (any script -- str.
# isdigit() covers Devanagari/Kannada/Tamil/Telugu/Malayalam digits, not just ASCII) and NO Latin letter
# anywhere in it. Recall cost is small (the prompt already restricts gen to ordinary connecting words);
# every rejection is returned in validate_items' dropped list, so DEV runs show directly if this list is
# too tight and needs widening -- widen it, never loosen the digit/Latin-letter bar itself.
# AFFIRMATIONS/NEGATIONS ARE DELIBERATELY EXCLUDED (lid-debug #4801, eta-refuter-2 #4811 F2): a
# gen'd "no"/"yes"/"haan"/etc. with no citation FLIPS a clinical fact ("take X" <-> "don't take X",
# "allergy? no" <-> "allergy? yes") -- the same harm class as an invented dose, not a lesser one. They
# may only ever reach output as a copy/norm item citing a real track token. This also reaches every
# per-language near-synonym of "okay/fine/correct" (अच्छा, ठीक, ಸರಿ, சரி, సరే, ശരി): lid-debug called
# "okay"/"ok" themselves borderline ("can mean consent") and said to drop them too -- the same
# consent-ambiguity applies identically to their exact equivalent in every other language, so all of
# them are removed here for consistency, not just the two English spellings that happened to be named.
GEN_ALLOWLIST = {
    # Hindi/Devanagari-script connecting words and fillers (grammatical/temporal only, no yes/no/consent)
    "और", "है", "हैं", "था", "थी", "तो", "का", "की", "के", "तब", "फिर", "बस", "हम्म", "जी",
    # Kannada
    "ಮತ್ತು", "ಇದೆ", "ಆಗ",
    # Tamil
    "மற்றும்", "இருக்கு",
    # Telugu
    "మరియు", "ఉంది",
    # Malayalam
    "ഉം", "ആണ്", "ഉണ്ട്",
    # English/mixed fillers -- see the DECISION note below: these are the one deliberate, closed
    # exception to the "no Latin letter" rule, matched EXACTLY, never by prefix or fuzzy similarity.
    # "and"/"so" per lid-debug's own #4778 example list -- common hi-en code-switch connectors.
    # NO yes/no/haan/ok/okay -- see the affirmation/negation note above.
    "hmm", "uh", "um", "and", "so",
}
_GEN_ALLOWLIST_NFC = {unicodedata.normalize("NFC", w) for w in GEN_ALLOWLIST}
_GEN_ALLOWLIST_CASEFOLD = {w.casefold() for w in _GEN_ALLOWLIST_NFC if w.isascii()}


def check_v3_gen(item: dict) -> tuple[bool, str]:
    """Allowlist, not a shape-guess: gen is accepted only for a word in GEN_ALLOWLIST (a closed set of
    ordinary connecting words/fillers across hi/kn/ta/te/ml + a few English fillers), containing no digit
    in any script and no Latin letter, with ONE explicit exception.

    DECISION (lid-debug #4778, pinning this down after they flagged the allowlist and the Latin-letter
    bar as looking like they could contradict each other): the allowlist wins. An EXACT, casefolded match
    against the small closed English-filler set above is checked and accepted BEFORE the Latin-letter bar
    runs -- so "okay"/"hmm"/etc. pass despite being plain Latin words, while anything NOT an exact hit on
    that tiny list (a drug name, an actual English word, anything) falls through to the bar and is
    rejected. This is never prefix or fuzzy matching -- widening it to that would reopen exactly the hole
    #4774 just closed. If DEV shows real English fillers missing, the fix is adding them to the literal
    set above, never loosening the match itself."""
    w = item.get("w", "")
    if any(ch.isdigit() for ch in w):
        return False, "gen_has_digit"
    norm = unicodedata.normalize("NFC", w.strip())
    if norm.casefold() in _GEN_ALLOWLIST_CASEFOLD:
        return True, ""  # exact allowlist hit: bypasses the Latin-letter bar below, deliberately
    if any("a" <= ch.casefold() <= "z" for ch in w):
        return False, "gen_has_latin_letters"
    if norm not in _GEN_ALLOWLIST_NFC:
        return False, "gen_not_in_allowlist"
    return True, ""


def _whisper_anchor_ok(text: str, indic_texts: dict[str, str]) -> bool:
    """V4's number/unit case: text (the cited Whisper span, verbatim) must contain a digit+unit or
    day-count candidate (extract_numeral_candidates -- ETR's own recognizer) that finds a cue-anchored
    match (find_value_anchor -- ETR's own anchor rule) in AT LEAST ONE Indic track's text."""
    candidates = rs.extract_numeral_candidates(text)
    if not candidates:
        return False
    for c in candidates:
        anchored = any(rs.find_value_anchor(itext, c["value"], kind=c["kind"]) for itext in indic_texts.values())
        if not anchored:
            return False
    return True


def _whisper_drug_ok(refs: list[str], drug_candidates: dict[str, list[dict]]) -> bool:
    """V4's drug case: the exact cited Whisper tokens must be the span of a REAL two-witness match
    (drug_candidates, computed independently by the pre-pass) -- not merely lexicon-shaped. Searched
    across every indic engine's candidate list (drug_candidates is keyed by the ALIGNED INDIC engine,
    never by the whisper engine the citation actually comes from -- see check_v2_norm's own note)."""
    ref_set = set(refs)
    for cands_list in drug_candidates.values():
        for cands in cands_list:
            match = cands.get("match") or {}
            if not match.get("name"):
                continue
            if {t["id"] for t in cands["whisper_span"]["tokens"]} == ref_set:
                return True
    return False


def _v4_gated(tok: dict) -> bool:
    """ADDENDUM-6: the p(en) gate applies to English-decoded whisper tokens: whisper-forced-en and
    whisper-cap2 always, and whisper-auto only where its own segment detected English (or detected
    nothing -- unknown is treated as the gated case). A whisper-auto token in a segment whose detected
    language is Indic is an INDIC track token under the ordinary V1/V2/V3/V5 checks, not gated here."""
    eng = tok["engine"]
    if not _is_whisper(eng):
        return False
    if eng == "whisper-auto":
        detected = tok.get("lid_detected")
        return detected is None or detected == "en"
    return True


def check_v4_whisper_gate(item: dict, flat: dict[str, dict], text: str, p_en: float | None,
                          indic_texts: dict[str, str], drug_candidates: dict[str, list[dict]]) -> tuple[bool, str]:
    refs = item.get("refs", [])
    if not refs or not any(_v4_gated(flat[r]) for r in refs if r in flat):
        return True, ""  # no gated whisper-track citation: V4 doesn't apply
    if p_en is not None and p_en >= 0.9:
        return True, ""  # whisper text is trusted at this p(en); ETR-style anchoring is not required
    if _whisper_anchor_ok(text, indic_texts) or _whisper_drug_ok(refs, drug_candidates):
        return True, ""
    return False, "whisper_low_pen_unanchored"


def _item_is_clinical(item: dict, reason: str) -> bool:
    """Whether a DROPPED item carried clinical content -- decides REPAIR (quietly drop) vs FALLBACK
    (discard the whole slice) in the outcome rule, never whether the item is dropped (a failing item is
    always dropped regardless of this flag, so misclassifying here costs coverage, not safety).
    norm/number_digits and norm/lexicon_generic ARE clinical rewrites by definition, whether or not they
    passed. Any V3 gen rejection also counts: V3 is now an ALLOWLIST (lid-debug #4774) of known-ordinary
    connecting words, so EVERY rejection reason it produces (a digit, a Latin letter, or simply "not on
    the list") means the model tried to gen something that is NOT a recognised safe filler -- exactly the
    fabrication risk this flag exists to catch, whether or not it happens to also look like a specific
    number/unit/drug. A copy/norm rejected specifically for failing the low-p(en) Whisper anchor gate
    (V4 -- exactly the class of content V4 exists to protect) also counts. Every other rejection reason
    (fabricated ref, cross-track merge, non-monotone refs, a materialisation mismatch, a reused ref, an
    unrecognised kind/rule) can't be classified without a reliably materialised text, so it defaults to
    non-clinical -- an approximation, not a leak."""
    if item.get("kind") == "norm" and item.get("rule") in ("number_digits", "lexicon_generic"):
        return True
    if reason == "whisper_low_pen_unanchored":
        return True
    if reason in ("gen_has_digit", "gen_has_latin_letters", "gen_not_in_allowlist"):
        return True
    return False


def validate_items(native_items: list[dict], flat: dict[str, dict], reverse_index: dict[str, int],
                   p_en: float | None, indic_texts: dict[str, str],
                   drug_candidates: dict[str, list[dict]]) -> dict:
    """Runs V1-V4 over every item. Returns {kept: [{index, item, text}], dropped: [{index, item, reason,
    clinical}]} -- conflict items are validated for V1 per option (never materialised into text: design
    section 3, "the model must not choose") but never dropped by V3/V4 (a conflict is itself the safe
    outcome; nothing in it is ever emitted as fact)."""
    kept, dropped = [], []
    used_refs: set[str] = set()

    def _claim(refs: list[str]) -> str | None:
        for r in refs:
            if r in used_refs:
                return r
        used_refs.update(refs)
        return None

    for idx, item in enumerate(native_items):
        kind = item.get("kind")
        if kind == "conflict":
            options = item.get("options", [])
            if len(options) < 2:
                dropped.append({"index": idx, "item": item, "reason": "conflict_needs_two_options", "clinical": False})
                continue
            ok_all, reason = True, ""
            for opt in options:
                ok, reason = check_v1_refs(opt.get("refs", []), flat)
                if not ok:
                    ok_all = False
                    break
                if _claim(opt["refs"]) is not None:
                    ok_all, reason = False, "ref_reused"
                    break
            if ok_all:
                kept.append({"index": idx, "item": item, "text": None})
            else:
                dropped.append({"index": idx, "item": item, "reason": reason, "clinical": False})
            continue
        if kind == "copy":
            ok, reason, text = check_v2_copy(item, flat)
        elif kind == "norm":
            ok, reason, text = check_v2_norm(item, flat, reverse_index, drug_candidates)
        elif kind == "gen":
            ok, reason = check_v3_gen(item)
            text = item.get("w", "")
        else:
            ok, reason, text = False, f"unknown_kind:{kind}", ""
        if ok and kind in ("copy", "norm"):
            reused = _claim(item["refs"])
            if reused is not None:
                ok, reason = False, "ref_reused"
        if ok and kind in ("copy", "norm"):
            ok, reason = check_v4_whisper_gate(item, flat, text, p_en, indic_texts, drug_candidates)
        if ok:
            kept.append({"index": idx, "item": item, "text": text})
        else:
            dropped.append({"index": idx, "item": item, "reason": reason, "clinical": _item_is_clinical(item, reason)})
    return {"kept": kept, "dropped": dropped}


def validate_entities(entities: list[dict], kept_items_by_index: dict[int, dict],
                      reverse_index: dict[str, int]) -> dict:
    """V5. kept_items_by_index: {native_item_index: kept-record (has "text")} -- an entity citing a
    DROPPED item's index has no valid link by construction (the index isn't in this map)."""
    kept, dropped = [], []
    for ent in entities:
        idxs = ent.get("native_items", [])
        if not idxs or any(i not in kept_items_by_index for i in idxs):
            dropped.append({"entity": ent, "reason": "unlinked_native_item"})
            continue
        kind = ent.get("kind")
        if kind in ("dose", "duration"):
            ok = False
            for i in idxs:
                text = kept_items_by_index[i]["text"] or ""
                parses = npm.parse_numbers(text, reverse_index)
                if len(parses) == 1 and parses[0]["role"] == "value" and str(parses[0]["value"]) == ent.get("value"):
                    ok = True
                    break
            if not ok:
                dropped.append({"entity": ent, "reason": "value_mismatch"})
                continue
        elif kind == "drug":
            texts = {kept_items_by_index[i]["text"] for i in idxs}
            if ent.get("value") not in texts:
                dropped.append({"entity": ent, "reason": "drug_name_mismatch"})
                continue
        kept.append(ent)
    return {"kept": kept, "dropped": dropped}


def validate_clauses(clauses: list[dict], kept_items_by_index: dict[int, dict], n_items: int) -> dict:
    """V6. A clause with no valid item citation is dropped; native items with no covering clause are
    reported as omissions (never dropped or fallback-triggering on their own)."""
    kept, dropped = [], []
    covered: set[int] = set()
    for clause in clauses:
        idxs = [i for i in clause.get("native_idx", []) if i in kept_items_by_index]
        if not idxs:
            dropped.append({"clause": clause, "reason": "no_valid_citation"})
            continue
        covered.update(idxs)
        kept.append(clause)
    omissions = sorted(set(kept_items_by_index) - covered)
    return {"kept": kept, "dropped": dropped, "omissions": omissions}


# ---- V7 (ADDENDUM-8): clinical content inside English clause TEXT must be supported ----------------
import re
from decimal import Decimal

_EN_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_EN_TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
_EN_NUM_WORDS = set(_EN_UNITS) | set(_EN_TENS) | {"hundred", "thousand"}
_V7_FREQ_NEXT = {"times", "time"}  # "three times a day" is a frequency, not a number (N1 rule)
_V7_UNIT_WORDS = {"mg", "mcg", "g", "gm", "gms", "ml", "iu", "unit", "units", "tab", "tabs", "tablet", "tablets",
                  "cap", "caps", "capsule", "capsules", "drop", "drops", "puff", "puffs", "day", "days", "week",
                  "weeks", "month", "months", "hour", "hours", "hr", "hrs", "kg", "mmol", "meq", "%", "percent"}
_DIGIT_RE = re.compile(r"\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")
V7_MIN_SKELETON = 3  # Latin words whose consonant skeleton is shorter are not drug-checked (declared limit)


def _to_ascii_digits(text: str) -> str:
    return "".join(str(unicodedata.decimal(ch)) if ch.isdecimal() and not ch.isascii() else ch for ch in text)


def _canon_num(s: str) -> str:
    return format(Decimal(s.replace(",", "")).normalize(), "f")


def _words_in_segment(toks: list[str], out: list[dict]) -> None:
    i = 0
    while i < len(toks):
        if toks[i] not in _EN_NUM_WORDS:
            i += 1
            continue
        total = cur = 0
        j = i
        while j < len(toks):
            w = toks[j]
            if w in _EN_UNITS or w in _EN_TENS:
                cur += _EN_UNITS.get(w, _EN_TENS.get(w))
            elif w == "hundred":
                cur = max(cur, 1) * 100
            elif w == "thousand":
                total += max(cur, 1) * 1000
                cur = 0
            elif w == "and" and toks[j - 1] in ("hundred", "thousand") and j + 1 < len(toks) \
                    and toks[j + 1] in _EN_NUM_WORDS:
                pass
            else:
                break
            j += 1
        nxt = toks[j] if j < len(toks) else ""
        if nxt not in _V7_FREQ_NEXT:
            out.append({"value": str(total + cur), "unit": nxt if nxt in _V7_UNIT_WORDS else None,
                        "form": "words"})
        i = max(j, i + 1)


def v7_extract_numbers(text: str) -> list[dict]:
    """[{value(str canonical), unit(str|None), form('digits'|'words')}]: ASCII/Indic digits and English
    number words (compounds read greedily as one value). A number word run followed by 'times'/'time' is
    a frequency and skipped."""
    out = []
    t = _to_ascii_digits(unicodedata.normalize("NFKC", text))
    for m in _DIGIT_RE.finditer(t):
        um = re.match(r"\s*([A-Za-z%]+)", t[m.end():])
        unit = um.group(1).lower() if um and um.group(1).lower() in _V7_UNIT_WORDS else None
        out.append({"value": _canon_num(m.group(0)), "unit": unit, "form": "digits"})
    for seg in re.split(r"[,;:.()]", t.lower()):
        _words_in_segment(re.findall(r"[A-Za-z]+|%", seg.replace("-", " ")), out)
    return out


_LEX_SKEL_CACHE: dict[int, list] = {}


def _lex_skeletons(lexicon: dict) -> list:
    key = id(lexicon)
    if key not in _LEX_SKEL_CACHE:
        _LEX_SKEL_CACHE[key] = [(n, dm._english_skeleton(n)) for n in lexicon]
    return _LEX_SKEL_CACHE[key]


_SHORT_GENERICS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "v7_short_generics.json")
with open(_SHORT_GENERICS_PATH) as _f:
    V7_SHORT_GENERICS = frozenset(json.load(_f)["names"])  # ADDENDUM-8a: exact-match list, lexicon cd012faed4bc597a


def v7_drug_names(text: str, lexicon: dict, policy: str = "built", stats: dict | None = None) -> set[str]:
    """Lexicon entries named in Latin text: every word and adjacent word pair, full-word skeleton
    similarity >= T_WHISPER (0.9), unique by >= T_MARGIN (0.1) over the runner-up (else ambiguous: not a
    hit). Words with a consonant skeleton shorter than V7_MIN_SKELETON are skipped; under policy "8a" they
    are instead checked by EXACT casefolded match against V7_SHORT_GENERICS and the skip count is kept
    in stats["skipped_short"]."""
    words = re.findall(r"[A-Za-z]+", text.lower())
    cands = set(words) | {f"{a} {b}" for a, b in zip(words, words[1:])}
    lex = _lex_skeletons(lexicon)
    found = set()
    for c in cands:
        sk = dm._english_skeleton(c)
        if len(sk) < V7_MIN_SKELETON:
            if policy == "8a":
                if c in V7_SHORT_GENERICS:
                    found.add(c)
                elif stats is not None and " " not in c:
                    stats["skipped_short"] = stats.get("skipped_short", 0) + 1
            continue
        scored = []
        for name, nsk in lex:
            if abs(len(sk) - len(nsk)) > 0.1 * max(len(sk), len(nsk)):
                continue
            sim = dm._sim(sk, nsk)
            if sim >= dm.T_WHISPER:
                scored.append((sim, name))
        if not scored:
            continue
        scored.sort(reverse=True)
        if len(scored) > 1 and scored[0][0] - scored[1][0] < dm.T_MARGIN:
            continue
        found.add(scored[0][1])
    return found


def v7_indic_drug_names(text: str, lexicon: dict) -> set[str]:
    """ADDENDUM-8a Change 2: the Indic-side witness of drug_match ALONE. A non-ASCII item text maps to a
    lexicon entry if its coarse phonetic skeleton (drug_match._indic_skeleton) vs the entry's English
    skeleton is >= T_INDIC (0.8) and beats the runner-up entry by >= T_MARGIN (0.1). Skeletons shorter
    than V7_MIN_SKELETON never match."""
    if not any(ch.isalpha() and not ch.isascii() for ch in text):
        return set()
    sk = dm._indic_skeleton(text)
    if len(sk) < V7_MIN_SKELETON:
        return set()
    scored = []
    for name, nsk in _lex_skeletons(lexicon):
        if abs(len(sk) - len(nsk)) > 0.2 * max(len(sk), len(nsk)):
            continue
        sim = dm._sim(sk, nsk)
        if sim >= dm.T_INDIC:
            scored.append((sim, name))
    if not scored:
        return set()
    scored.sort(reverse=True)
    if len(scored) > 1 and scored[0][0] - scored[1][0] < dm.T_MARGIN:
        return set()
    return {scored[0][1]}


def v7_eval_clause(clause: dict, kept_by_index: dict[int, dict], entities: list[dict], lexicon: dict,
                   reverse_index: dict[str, int], policy: str = "built") -> tuple[dict | None, dict]:
    """(drop, info). drop is None if every number and lexicon drug in the clause text is supported by the
    clause's own cited kept items / kept entities (whose native_items are all among the clause's
    citations); else {reason, unsupported_numbers, unsupported_drugs, collateral_non_dose}. info carries
    "only_indic_drugs" (drugs supported ONLY by ADDENDUM-8a Change 2) and "skipped_short" (policy 8a)."""
    cited = [i for i in clause.get("native_idx", []) if i in kept_by_index]
    cite_all = set(clause.get("native_idx", []))
    texts = []
    for i in cited:
        rec = kept_by_index[i]
        texts.append(rec["text"] or "")
        if rec["item"].get("kind") == "norm" and rec["item"].get("w"):
            texts.append(rec["item"]["w"])
    joined = " ".join(t for t in texts if t)
    ents = [e for e in entities if set(e.get("native_items", [])) <= cite_all and e.get("native_items")]
    info: dict = {"only_indic_drugs": [], "skipped_short": 0}
    stats: dict = {}

    sup_nums = set()
    for t in texts + [joined]:
        sup_nums.update(n["value"] for n in v7_extract_numbers(t))
        sup_nums.update(str(p["value"]) for p in npm.parse_numbers(t, reverse_index) if p["role"] == "value")
    sup_nums.update(_canon_num(e["value"]) for e in ents
                    if e.get("kind") in ("dose", "duration") and re.fullmatch(r"\d+(\.\d+)?", str(e.get("value", ""))))
    sup_drugs = set()
    for t in texts + [joined]:
        sup_drugs |= v7_drug_names(t, lexicon, policy)
    for e in ents:
        if e.get("kind") == "drug":
            sup_drugs |= v7_drug_names(str(e.get("value", "")), lexicon, policy)
    indic_only = set()
    if policy == "8a":
        indic = set()
        for t in texts + [joined]:
            indic |= v7_indic_drug_names(t, lexicon)
        indic_only = indic - sup_drugs
        sup_drugs |= indic

    bad_nums = [n for n in v7_extract_numbers(clause.get("text", "")) if n["value"] not in sup_nums]
    clause_drugs = v7_drug_names(clause.get("text", ""), lexicon, policy, stats)
    bad_drugs = sorted(clause_drugs - sup_drugs)
    info["skipped_short"] = stats.get("skipped_short", 0)
    info["only_indic_drugs"] = sorted((clause_drugs & indic_only) - set(bad_drugs))
    if not bad_nums and not bad_drugs:
        return None, info
    return {"reason": "clause_unsupported_number" if bad_nums else "clause_unsupported_drug",
            "unsupported_numbers": bad_nums, "unsupported_drugs": bad_drugs,
            "collateral_non_dose": bool(bad_nums) and not any(n["unit"] for n in bad_nums) and not bad_drugs}, info


def v7_check_clause(clause: dict, kept_by_index: dict[int, dict], entities: list[dict], lexicon: dict,
                    reverse_index: dict[str, int], policy: str = "built") -> dict | None:
    return v7_eval_clause(clause, kept_by_index, entities, lexicon, reverse_index, policy)[0]


def v7_filter_clauses(clauses: list[dict], kept_by_index: dict[int, dict], entities: list[dict],
                      lexicon: dict, reverse_index: dict[str, int], policy: str = "built"
                      ) -> tuple[list[dict], list[dict], dict]:
    """(kept, dropped, info). info: only_indic (clause positions kept ONLY thanks to 8a Change 2, with the
    drug names) and skipped_short (short-skeleton Latin words not exact-matched, policy 8a)."""
    kept, dropped = [], []
    info = {"only_indic": [], "skipped_short": 0}
    for ci, cl in enumerate(clauses):
        bad, ci_info = v7_eval_clause(cl, kept_by_index, entities, lexicon, reverse_index, policy)
        info["skipped_short"] += ci_info["skipped_short"]
        if bad is None:
            kept.append(cl)
            if ci_info["only_indic_drugs"]:
                info["only_indic"].append({"clause_pos": ci, "drugs": ci_info["only_indic_drugs"]})
        else:
            dropped.append({"clause": cl, **bad, "clinical": policy != "8a", "omission": policy == "8a"})
    return kept, dropped, info


def v7_replay(val: dict, lexicon: dict, reverse_index: dict[str, int], policy: str) -> dict:
    """Re-apply V7 to a STORED slice validation (RUN 3 record) under `policy` ("built" = drop forces
    fallback; "8a" = ADDENDUM-8a: a dropped clause is an English omission, native side kept, no fallback).
    The stored record is pre-V7 itself (val["pre_v7"] when V7 forced fallback, else val). Returns
    {outcome, en_clauses (kept), v7_dropped_clauses, only_indic, skipped_short, n_clauses_pre}.
    Kept item indices are rebuilt as range(n) minus the validator-dropped indices (pre-drops carry
    index None and are not in that space)."""
    pre = val.get("pre_v7") or val
    if "en_clauses" not in pre:  # V1-V3 fallback before clauses were ever built: nothing for V7 to act on
        return {"outcome": pre["outcome"], "en_clauses": [], "v7_dropped_clauses": [], "only_indic": [],
                "skipped_short": 0, "n_clauses_pre": 0}
    dropped_idx = {d["index"] for d in pre["dropped_items"] if d.get("index") is not None}
    n_orig = len(pre["native_items"]) + len(dropped_idx)
    kept_idx = [i for i in range(n_orig) if i not in dropped_idx]
    mat = {int(k): v for k, v in pre["materialized"].items()}
    kept_by_index = {i: {"index": i, "item": it, "text": mat.get(i)}
                     for i, it in zip(kept_idx, pre["native_items"])}
    kept, dropped, info = v7_filter_clauses(pre["en_clauses"], kept_by_index, pre["entities"], lexicon,
                                            reverse_index, policy)
    outcome = pre["outcome"]
    if dropped and policy == "built":
        outcome = "fallback"
    return {"outcome": outcome, "en_clauses": kept, "v7_dropped_clauses": dropped,
            "only_indic": info["only_indic"], "skipped_short": info["skipped_short"],
            "n_clauses_pre": len(pre["en_clauses"])}


def validate_slice(response: dict, flat: dict[str, dict], reverse_index: dict[str, int],
                   p_en: float | None, indic_texts: dict[str, str],
                   drug_candidates: dict[str, list[dict]], pre_dropped: list[dict] | None = None,
                   v7_lexicon: dict | None = None, v7_policy: str = "built") -> dict:
    """The orchestrator: PASS / REPAIR / FALLBACK per design section 4's outcome rule. `response` is a
    reply that has already passed schema.check_shape -- this is the SEMANTIC layer on top of that."""
    items_result = validate_items(response["native_items"], flat, reverse_index, p_en,
                                   indic_texts, drug_candidates)
    pre_dropped = pre_dropped or []  # items schema.normalise_items already dropped per-item (ADDENDUM-7)
    items_result["dropped"] = pre_dropped + items_result["dropped"]
    n_items = len(response["native_items"]) + len(pre_dropped)
    dropped_share = (len(items_result["dropped"]) / n_items) if n_items else 0.0
    clinical_dropped = any(d.get("clinical") for d in items_result["dropped"])

    if dropped_share > CLINICAL_DROP_SHARE_MAX or clinical_dropped:
        return {"outcome": "fallback", "reasons": [d["reason"] for d in items_result["dropped"]],
               "dropped_items": items_result["dropped"], "dropped_share": dropped_share,
               "clinical_dropped": clinical_dropped}

    kept_by_index = {r["index"]: r for r in items_result["kept"]}
    ent_result = validate_entities(response.get("entities", []), kept_by_index, reverse_index)
    clause_result = validate_clauses(response.get("en_clauses", []), kept_by_index, n_items)

    outcome = "pass" if not items_result["dropped"] and not ent_result["dropped"] \
        and not clause_result["dropped"] else "repair"
    res = {
        "outcome": outcome,
        "native_items": [r["item"] for r in items_result["kept"]],
        "materialized": {r["index"]: r["text"] for r in items_result["kept"] if r["text"] is not None},
        "entities": ent_result["kept"],
        "en_clauses": clause_result["kept"],
        "dropped_items": items_result["dropped"],
        "dropped_entities": ent_result["dropped"],
        "dropped_clauses": clause_result["dropped"],
        "omissions": clause_result["omissions"],
        "dropped_share": dropped_share,
    }
    if v7_lexicon is None:
        return res
    kept_cl, v7_dropped, v7_info = v7_filter_clauses(res["en_clauses"], kept_by_index, res["entities"],
                                                     v7_lexicon, reverse_index, v7_policy)
    res["outcome_no_v7"] = outcome
    res["v7_dropped_clauses"] = v7_dropped
    if v7_policy == "8a":
        res["v7_only_indic"] = v7_info["only_indic"]
        res["v7_skipped_short"] = v7_info["skipped_short"]
        res["en_clauses"] = kept_cl
        return res
    if not v7_dropped:
        return res
    return {"outcome": "fallback", "reasons": [d["reason"] for d in v7_dropped],
            "dropped_items": items_result["dropped"], "dropped_share": dropped_share,
            "clinical_dropped": True, "outcome_no_v7": outcome, "v7_dropped_clauses": v7_dropped,
            "pre_v7": res}
