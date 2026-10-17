"""FreeScript R1: notes-only restart floors (V, 16 Oct). Pure functions over an eta.freescript artifact dict.

FreeScript restarts for notes only. Medicines are never presented as the Rx: a drug posts only when its NAME is on tape in a
doctor-attributed span, and every other drug becomes a doctor-confirm pick_drug prompt. Repair at the source: a field is
withheld whole, or a drug moves to pick_drug. No character inside a posted string is ever deleted.

  R1-1 posted-field check   every gp_extraction string matching WITHHOLD (placeholders, dict reprs, missing-value words,
                            FRX-N1 d1/d4/d5) is withheld whole, with one provenance item flagged field_withheld.
  R1-2 medicine floor       a medicine stays only if heard_in_room and a doctor evidence quote names it (see name_on_tape).
                            A posted string that names a moved drug is withheld too, so no note can show it (R2, D3).
  R1-3 dose floor           every digit run in frequency / duration / strength / instructions must be in that medicine's quotes.
  R1-4 notes_only           the Medication section is the deterministic one (pipeline.run_consult and notes_only_note).
  R1-5 red-flag carry       a doctor's emergency / return instruction not already in the advice becomes one advice line.

apply_r1(art, turns) runs offline on a stored artifact.json too; the lead replays it on production artifacts.
"""
from __future__ import annotations

import copy
import json
import re
import unicodedata
from pathlib import Path

from .guard import numerals
from .mapper import iso
from .medication_safety import BRANDS, GENERICS, molecules
from .note import combination_groups, flags_by_pointer, medication_floor, scrub_identity
from .recover import _demote_medicine, _kept_out
from .note import MEDICATION_LABEL
from .validate import _D1, _D4_ADD, _D4_FIELDS, _D4_MED_NOT, _D4_MED_PENDING, _D4_MISSING, _D4_NO, _D5, _d4, printable_errors

FLAG = "field_withheld"
PICK_PROMPT = "Name this drug"  # the mapper's pick_drug prompt (mapper.Builder.slot); no new wording
SPEAKERS = {"doctor", "patient", "attendant", "staff", "other", "unknown"}
SPEAKER_SOURCES = {"role_track", "diarisation", "model_inferred"}

# --- R1-1 -----------------------------------------------------------------------------------------------------
_BRACE = re.compile(r"[{}\[\]]")
_REPR = re.compile(r"""(['"])[^'"\n]{1,80}\1\s*:\s*\S|\{\s*['"]""")  # 'key': value, "key": value, {'...
_ANGLE = re.compile(r"<\s*[A-Za-z][^<>\n]{0,60}>")
_BLANK = re.compile(r"__|\b[Tt][Bb][Dd]\b|\bX{2,}\b")  # XX as written: capitals ("xx" is not the slot)
_MISSING = re.compile(r"\b(?:not\s+specified|unspecified|to\s+be\s+(?:decided|confirmed|determined))\b", re.I)
# The note heading whose FRX-N1 d4 rules apply to a gp_extraction section (_d4 widens only for Medication).
_D4_SEC = {"medicines": "Medication"}


# F2 (FRX-R1b clinical ruling): a missing-value word withholds a field only when the value IS a missing-value statement: the
# whole value, a sentence of it (split on ; . newline), or a comma clause that has its own subject ("BP not specified"). A
# clinical qualifier posts unchanged: "fever of unknown origin", "hypertension, unspecified", "pain of unclear aetiology".
_SENTENCE = re.compile(r"[;\n]|\.(?:\s|$)")
_LABEL = re.compile(r"^\s*[A-Za-z][\w /-]{0,30}:\s*")
_NEGATED = re.compile(r"^(?:not|is|was|isn|wasn|to|no)\b", re.I)  # "not specified", "is not known", "to be decided", "no dose given"
_FILLER = {"is", "was", "are", "yet", "still", "currently", "as", "of", "the"}
_QUALIFIER = {"of", "with", "for", "in", "on", "due", "from", "and", "or"}


def _missing_kind(t: str, section: str) -> str | None:
    if _MISSING.search(t):
        return "missing"
    if _D1.search(t):
        return "d1"
    if _d4(t, _D4_SEC.get(section, "")):
        return "d4"
    return None


def _is_missing_statement(clause: str, own: bool, section: str) -> str | None:
    """The detector name when `clause` is a missing-value statement, else None. `own`: the clause is the whole value or a
    sentence of it, so a bare missing phrase ("not specified", "unknown") is a statement; a bare phrase after a comma
    qualifies the item before it ("hypertension, unspecified") and posts."""
    kind = _missing_kind(clause, section)
    if kind is None:
        return None
    body = _LABEL.sub("", clause, count=1)
    labelled = body != clause
    phrases = [_MISSING, _D1, _D4_NO, _D4_ADD] + ([_D4_MED_NOT, _D4_MED_PENDING] if section == "medicines" else [])
    negated = False
    for rx in phrases:
        negated |= any(_NEGATED.match(m.group(0)) for m in rx.finditer(body))
        body = rx.sub(" ", body)
    words = [w for w in re.findall(r"\w+(?:/\w+)?", body.lower()) if w not in _D4_MISSING and w not in _FILLER]
    if not words:
        return kind if (own or labelled) else None
    if all(w in _D4_FIELDS for w in words):  # "dose unknown", "frequency not stated"
        return kind
    if negated and len(words) <= 3 and not _QUALIFIER & set(words):  # "BP not specified"
        return kind
    return None


def withhold_reason(s: str, section: str = "") -> str | None:
    """Why the posted string `s` must be withheld, or None. NFKC first, as printable_errors does. Placeholders (brackets,
    reprs, slots, blanks, d5 markers) withhold anywhere in the value. The missing-value words (_MISSING and validate.py's own
    _D1 / _d4) withhold only a missing-value statement (F2 above)."""
    if not isinstance(s, str) or not s:
        return None
    t = unicodedata.normalize("NFKC", s)
    if _BRACE.search(t) or any(unicodedata.category(c) in ("Ps", "Pe") and c not in "()" for c in t):
        return "bracket"
    if _REPR.search(t):
        return "repr"
    if _ANGLE.search(t):
        return "angle"
    if _BLANK.search(t):
        return "blank"
    if _missing_kind(t, section):
        for sentence in _SENTENCE.split(t):
            why = _is_missing_statement(sentence, True, section)
            parts = sentence.split(",")
            if not why and len(parts) > 1:
                why = next((w for p in parts if (w := _is_missing_statement(p, False, section))), None)
            if why:
                return why
    if _D5.search(t):
        return "d5"
    return None


def posted_hits(gx) -> list[tuple]:
    """Paths (tuples of keys / indices) of every string under gp_extraction, nested dicts and lists included, that withhold_reason
    rejects."""
    out: list[tuple] = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, path + (k,))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, path + (i,))
        elif isinstance(node, str) and withhold_reason(node, str(path[0]) if path else ""):
            out.append(path)

    walk(gx, ())
    return out


# gp_extraction list -> (provenance kind, fields an entry cannot lose)
LISTS = {
    ("medicines",): ("medicine", {"name", "raw_name"}),
    ("further_investigations",): ("investigation", {"name", "raw_name"}),
    ("comorbidities",): ("comorbidity", {"name", "raw_name"}),
    ("referrals",): ("referral", {"speciality"}),
    ("presenting_complaints", "diagnoses"): ("diagnosis", {"diagnosis_or_impression", "raw_name"}),
    ("plan_of_management", "surgery_or_procedure_recommendations"): ("procedure", {"name", "raw_name"}),
}
# Scalar field -> (provenance kind, the pointer its owner carries)
SCALARS = {
    ("examination",): ("examination", "/examination"),
    ("general_advice",): ("advice", "/general_advice"),
    ("presenting_complaints", "symptoms"): ("symptoms", "/presenting_complaints/symptoms"),
    ("plan_of_management", "management_plan"): ("management_plan", "/plan_of_management/management_plan"),
}
_TOP_KIND = {"examination": "examination", "general_advice": "advice", "presenting_complaints": "symptoms",
             "plan_of_management": "management_plan", "follow_up": "follow_up", "medicines": "medicine",
             "further_investigations": "investigation", "comorbidities": "comorbidity", "referrals": "referral"}


def _ptr(path) -> str:
    return "/" + "/".join(str(p) for p in path)


def _owners(art: dict, ptr: str) -> list[dict]:
    return [p for p in art.get("provenance") or [] if isinstance(p, dict) and p.get("json_pointer") == ptr]


def _new_id(art: dict, stem: str) -> str:
    ids = {p.get("item_id") for p in art.get("provenance") or [] if isinstance(p, dict)}
    n = 1
    while f"{stem}{n}" in ids:
        n += 1
    return f"{stem}{n}"


def _withheld_item(art: dict, kind: str, section: str, owner: dict | None, why: str = "placeholder") -> dict:
    """The ONE provenance item for a withheld field. It carries the owner's evidence when there is one."""
    src = ((art.get("encounter") or {}).get("transcript") or {}).get("speaker_source")
    ev = copy.deepcopy(owner.get("evidence") or []) if owner else []
    item = {
        "item_id": _new_id(art, "r1w"), "kind": kind, "text": f"{section} withheld ({why})",
        "evidence_state": "heard_in_room" if ev and owner and owner.get("evidence_state") == "heard_in_room" else "not_said_in_room",
        "status": "discussed_only", "negated": False,
        "speaker": (owner or {}).get("speaker") if (owner or {}).get("speaker") in SPEAKERS else "unknown",
        "speaker_source": (owner or {}).get("speaker_source") or (src if src in SPEAKER_SOURCES else "model_inferred"),
        "evidence": ev if (owner and owner.get("evidence_state") == "heard_in_room") else [],
        # 0.6: the schema asks low_confidence below 0.6, and this item carries the one flag field_withheld
        "confidence": 0.6, "json_pointer": None, "flags": [FLAG], "decision": None,
    }
    art.setdefault("provenance", []).append(item)
    return item


def _get(gx, path):
    cur = gx
    for p in path:
        cur = cur[p]
    return cur


def _drop_rows(art: dict, lpath: tuple, drop: set[int]) -> None:
    """Remove rows `drop` of a non-medicine list and renumber its pointers, as recover._demote_medicine does for medicines:
    the removed row's owner is kept out (json_pointer null, discussed_only, names emptied); later rows move up."""
    gx = art["gp_extraction"]
    rows = _get(gx, lpath)
    base = _ptr(lpath)
    new_at, n = {}, 0
    for i in range(len(rows)):
        if i in drop:
            new_at[i] = None
        else:
            new_at[i] = n
            n += 1
    for p in art.get("provenance") or []:
        if not isinstance(p, dict):
            continue
        m = re.fullmatch(re.escape(base) + r"/(\d+)", str(p.get("json_pointer") or ""))
        if not m:
            continue
        nxt = new_at.get(int(m.group(1)))
        if nxt is None:
            p["json_pointer"] = None
            p["status"] = "discussed_only"
            p["names"] = []
        else:
            p["json_pointer"] = f"{base}/{nxt}"
    rows[:] = [r for i, r in enumerate(rows) if i not in drop]
    if not rows:
        parent = _get(gx, lpath[:-1])
        parent.pop(lpath[-1], None)
        if lpath == ("plan_of_management", "surgery_or_procedure_recommendations") and parent.get("requires_surgery_or_procedure") is True:
            parent["requires_surgery_or_procedure"] = False


def _med_label(m: dict) -> str:
    """pick_drug detail: the name, else raw_name, whichever is itself postable; never a placeholder."""
    for k in ("name", "raw_name"):
        v = m.get(k) if isinstance(m, dict) else None
        if isinstance(v, str) and v.strip() and not withhold_reason(v, "medicines"):
            return v.strip()
    return "unnamed drug"


def _to_pick_drug(art: dict, idxs: dict[int, str | None]) -> int:
    """Move medicines `idxs` (index -> new owner text, or None to keep it) to pick_drug. Highest index first through
    recover._demote_medicine, so later pointers renumber exactly as there. Returns the count moved."""
    meds = art["gp_extraction"].get("medicines") or []
    moved = 0
    for i in sorted(idxs, reverse=True):
        if i >= len(meds):
            continue
        m = meds[i]
        owner = (_owners(art, f"/medicines/{i}") or [None])[0]
        label = _med_label(m)
        art.setdefault(_KNOWN, []).extend(  # before the demote empties the owner's names
            n for n in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or []) + list((owner or {}).get("names") or [])
            if isinstance(n, str))
        _demote_medicine(art, i)
        if owner is None:
            owner = _kept_out(art, "medicine", f"{label} (not on tape)")
        if idxs[i]:
            owner["text"] = idxs[i][:300]
        art.setdefault("completion_required", []).append(
            {"kind": "pick_drug", "item_id": owner["item_id"], "prompt": PICK_PROMPT, "detail": label[:200]})
        moved += 1
    return moved


def r1_posted_fields(art: dict, c: dict, hits: list[tuple] | None = None, why: str = "placeholder", key: str = "r1_1") -> None:
    """R1-1. Withhold every posted string that matches the set. An optional field is removed; a required field (a list row's
    name / raw_name / diagnosis / speciality) takes the whole row out (a medicine to pick_drug); a scalar section is removed and
    its owner kept out. One provenance item flagged field_withheld per withheld field. `hits` / `why` / `key`: the same
    withholding for other paths (r1_moved_mentions), counted under `key`."""
    gx = art.get("gp_extraction")
    if not isinstance(gx, dict):
        return
    hits = posted_hits(gx) if hits is None else hits
    rows: dict[tuple, set[int]] = {}
    pops: list[tuple] = []
    for path in hits:
        lp = next((k for k in LISTS if path[:len(k)] == k and len(path) > len(k)), None)
        if lp is not None:
            kind, required = LISTS[lp]
            idx = path[len(lp)]
            owner = (_owners(art, _ptr(lp + (idx,))) or [None])[0]
            _withheld_item(art, kind, lp[-1], owner, why)
            c[f"{key}_withheld"] += 1
            if len(path) == len(lp) + 1 or path[len(lp) + 1] in required:
                rows.setdefault(lp, set()).add(idx)
            else:
                pops.append(path)
            continue
        kind, ptr = SCALARS.get(path, (_TOP_KIND.get(str(path[0]), "management_plan"), None))
        owner = (_owners(art, ptr) or [None])[0] if ptr else (_owners(art, "/" + str(path[0])) or [None])[0]
        _withheld_item(art, kind, str(path[-1]) if path in SCALARS else str(path[0]), owner, why)
        c[f"{key}_withheld"] += 1
        pops.append(path)
    # optional fields and list elements (aliases), deepest and highest index first so earlier paths stay valid
    for path in sorted(pops, key=lambda p: (len(p), [x if isinstance(x, int) else -1 for x in p]), reverse=True):
        lp = next((k for k in LISTS if path[:len(k)] == k), None)
        if lp is not None and path[len(lp)] in rows.get(lp, set()):
            continue  # the whole row goes
        try:
            parent = _get(gx, path[:-1])
        except (KeyError, IndexError, TypeError):
            continue
        if isinstance(parent, list):
            parent.pop(path[-1])
            if not parent and len(path) >= 2:
                _get(gx, path[:-2]).pop(path[-2], None)
            continue
        parent.pop(path[-1], None)
        ptr = SCALARS.get(path, (None, None))[1]
        for p in _owners(art, ptr) if ptr else []:
            p["json_pointer"] = None
            p["status"] = "discussed_only"
        if path[0] == "follow_up" and len(path) == 2 and not gx.get("follow_up"):
            gx.pop("follow_up", None)
            for p in _owners(art, "/follow_up"):
                p["json_pointer"] = None
                p["status"] = "discussed_only"
    for lp, drop in rows.items():
        if lp == ("medicines",):
            c[f"{key}_rows_removed"] += _to_pick_drug(art, {i: None for i in drop})
        else:
            _drop_rows(art, lp, drop)
            c[f"{key}_rows_removed"] += len(drop)


# --- R1-2 -----------------------------------------------------------------------------------------------------
# Unit, form and pack words: never part of a name.
_FORM = {"mg", "mcg", "ml", "gm", "g", "iu", "unit", "units", "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule",
         "capsules", "syp", "syrup", "inj", "injection", "cream", "gel", "drops", "drop", "ointment", "lotion", "spray", "oral",
         "suspension", "solution", "the", "for", "kit", "respules", "powder", "dt", "md", "sachet", "inhaler"}
# The dosage forms and units that, next to a word, make it a drug name ("tab Pan", "Pan 40", "fever tablet").
_ADJ_FORM = _FORM - {"the", "for", "oral", "kit", "powder"}
_TIME = {"day", "days", "week", "weeks", "month", "months", "hour", "hours", "hr", "hrs", "year", "years", "yr", "yrs",
         "times", "time", "x", "min", "mins", "minutes", "am", "pm", "o", "clock"}


def _adjacent(raw: list[tuple[str, str]], x: int) -> bool:
    """raw[x] makes the word next to it a drug name: a dosage form or unit ("tab", "mg"), or a strength that is not a duration
    or a count ("Pan 40" yes; "Fever (2 days)", "BP 3 times" no)."""
    if not 0 <= x < len(raw):
        return False
    t, k = raw[x]
    if t in _ADJ_FORM:
        return True
    return k in ("num", "gnum") and not (x + 1 < len(raw) and raw[x + 1][0] in _TIME)


# Joiners split a combination into its components ("amoxicillin and clavulanic acid", "calcium + vitamin D3").
_JOIN = {"and", "plus", "with"}
# Salt, qualifier, vitamin and pack words (fable ruling D5): they never count alone as the name on tape.
QUALIFIERS = {"acid", "sodium", "potassium", "calcium", "magnesium", "zinc", "iron", "chloride", "carbonate", "bicarbonate",
              "citrate", "phosphate", "sulphate", "sulfate", "acetate", "gluconate", "hydrochloride", "hcl", "hydrobromide",
              "maleate", "mesylate", "besylate", "fumarate", "succinate", "tartrate", "oxide", "hydroxide", "trihydrate",
              "dihydrate", "monohydrate", "anhydrous", "vitamin", "vit", "d3", "d", "b12", "b", "c", "e", "k", "duo", "pack",
              "forte", "plus", "sr", "xr", "er", "cr", "la", "od", "mr", "pr", "ds", "dsr", "xl", "cv", "gold", "junior",
              "kid", "kids", "paediatric", "pediatric", "adult", "extra", "max", "fast", "new", "advance", "advanced", "lc",
              "mini", "total", "ultra", "strong"}
# F3 (R3): a word before a name that makes it another molecule ("hydroxy chloroquine", "levo cetirizine", "es omeprazole").
PREFIXES = {"hydroxy", "methyl", "levo", "es", "dex", "des", "nor", "chlor", "s", "r"}  # s / r: isomers ("s amlodipine", R4 G1)
# Non-prescription products (R4 G4): a mention passes the scan, and they never post to the structured Rx.
NON_RX = {"ors", "electral", "calamine"}
# F4 (R3): a mention in a stop / avoid / negated clause is not a drug-use mention for posting.
_NOT_USE = {"stop", "stopped", "stopping", "avoid", "avoided", "no", "not", "don", "dont", "never", "without", "allergic",
            "allergy", "nahi", "mat", "band", "discontinue", "withhold", "skip"}
_TOK = re.compile(r"[^\W\d_]+|\d+(?:\.\d+)?")
_STRENGTH = re.compile(r"\d+(?:\.\d+)?(?:mg|mcg|ml|g|iu)?")
_DATA = Path(__file__).resolve().parents[2] / "data"


def _toks(text: str) -> list[str]:
    """Lowercase NFKC tokens: letter runs and digit runs apart ("Dolo-650" and "dolo650" -> dolo, 650)."""
    return [t.lower() for t in _TOK.findall(unicodedata.normalize("NFKC", text or ""))]


def _alnum(text: str) -> list[str]:
    """Words with a glued letter-digit word kept whole ("D3", "B12"), for the qualifier test. "+", "&" and "/" join."""
    t = re.sub(r"[+&/]", " and ", unicodedata.normalize("NFKC", text or ""))
    return [w.lower() for w in re.findall(r"[^\W_]+", t)]


def _raw(text: str) -> list[tuple[str, str]]:
    """(token, kind) for the name matcher: kind "num" (a standalone strength), "form" (unit / form / pack word), "word", or
    "gnum" (the digits of a glued word: "D3" -> d, 3; "pan40" -> pan, 40). A gnum is part of the word sequence (so "vitamin
    D3" matches) and also counts as a strength next to a name (F6)."""
    out = []
    for w in _alnum(text):
        if _STRENGTH.fullmatch(w):
            out.append((w, "num"))
        elif w in _FORM:
            out.append((w, "form"))
        else:
            out += [(t, "gnum" if t[0].isdigit() else "word") for t in _toks(w)]
    return out


def name_phrases(name: str) -> list[tuple[str, ...]]:
    """The phrases a name must show on tape, one per component of a combination; [] when it has no usable component.
    A component is its words without digits, unit / form / pack words. Its base is that minus the QUALIFIERS (salt, vitamin,
    pack). A component with a base needs the base phrase ("pantoprazole sodium" -> pantoprazole, "Augmentin 625 Duo" ->
    augmentin, "folic acid" -> folic). A component that is all qualifiers needs its whole phrase ("vitamin D3", "potassium
    chloride"). A lone qualifier ("calcium") never counts on its own; inside a combination of 2+ components it is that
    component's phrase ("Calcium + Vitamin D3" needs calcium AND vitamin d3, R3 L1)."""
    comps: list[list[str]] = [[]]
    for w in _alnum(name):
        if w in _JOIN:
            comps.append([])
        elif not _STRENGTH.fullmatch(w) and w not in _FORM:
            comps[-1].append(w)
    comps = [c for c in comps if c]
    out: list[tuple[str, ...]] = []
    for comp in comps:
        base = tuple(x for x in comp if x not in QUALIFIERS)
        if base:
            out.append(tuple(t for x in base for t in _toks(x)))
        elif len(comp) >= 2 or len(comps) >= 2:
            out.append(tuple(t for x in comp for t in _toks(x)))
        else:
            return []
    return out


# --- drug vocabulary (R3): the lexicon, the generics and brands, and the plain words that are not drugs -------------
def _wordlist(name: str, key: str = "words") -> set[str]:
    try:
        d = json.loads((_DATA / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    return {w.lower() for k in ([key] if isinstance(key, str) else key) for x in d.get(k) or [] for w in re.findall(r"[a-z]+", str(x).lower())}


# Hindi-romanised everyday words heard in an Indian OPD (they are not English, and some are brand names too).
HINDI_WORDS = {"pan", "paan", "dawa", "dawai", "goli", "chai", "dard", "bukhar", "khana", "pani", "dahi", "doodh", "nimbu",
               "haldi", "tulsi", "neem", "amla", "jeera", "ajwain", "saunf", "gud", "namak", "cheeni", "roti", "dal", "chawal",
               "subah", "shaam", "raat", "din", "abhi", "kal", "aaj", "thoda", "zyada", "bas", "theek", "accha", "haan", "nahi",
               "mat", "band", "masala", "gutka", "beedi", "desi", "ghee", "tel", "sona", "chandan", "shanti", "raja", "rani"}
# Drug abbreviations and common OTC brands an Indian OPD writes that no lexicon row carries ("PCM" is paracetamol; Vicks and
# Eno, R4 addendum 7). They only widen the scan.
DRUG_ABBREVIATIONS = {"pcm"}
OTC_BRANDS = {"vicks", "eno"}
# Short brands that are everyday words (F6): such a brand posts only with its strength or a form word next to it on tape.
SHORT_BRAND_SEED = {"pan", "mox", "dolo", "azee", "zinc", "sumo", "moov", "eno", "vicks"}  # + name-like OTC brands (addendum 7)
# Clinical abbreviations and plain words that a lexicon row may carry but that are never a drug mention by themselves.
_NOT_DRUG = {"sitz", "sunscreen", "saline", "bp", "hr", "rr", "spo", "cbc", "ecg", "ekg", "tsh", "esr", "crp", "lft", "kft", "rft", "rbs", "fbs", "ppbs",
             "usg", "mri", "ent", "opd", "ipd", "icu", "hba", "urine", "blood", "test", "day", "days", "week", "weeks", "month",
             "dose", "doses", "once", "twice", "thrice", "daily", "night", "morning", "after", "before", "food", "sos", "bd",
             "tds", "qid", "hs", "stat", "doctor", "dr", "patient", "drug", "drugs", "medicine", "medicines", "other",
             "advised", "continue", "review", "if", "required", "follow", "up", "x", "one", "two", "three", "four", "five", "six",
             "seven", "eight", "nine", "ten", "half", "times"} | _FORM | QUALIFIERS | _JOIN


_MOLECULE = re.compile(r"(?:ol|ine|ide|ate|azole|mycin|cillin|sartan|pril|olol|statin|oxacin|tidine|vir|one|ium|ane|ene|cin|xib|"
                       r"fen|pam|lam|mab|ast|gliptin|flozin|parin|dipine|zine|xone|sone|lone|tide|amine|ase|ose|in)$")
_CLINICAL = re.compile(r"(?:itis|osis|algia|a?emia|pathy|ectomy|scopy|graphy|ache|ness|ity|ency|ing|tion|ful|less|ous|ive)$")
_CLINICAL_WORDS = {"hyperpigmentation", "amorphous", "hydrous", "prostrate", "glide", "reactivate", "intrauterine", "methane",
                   "dioxide", "sol", "sone", "klin", "monodose", "neoprene", "deficiency", "acidity", "backache", "bloating",
                   "heartburn", "indigestion", "flatulence", "dandruff", "ulcer", "cramps", "spasms", "menopause", "gerd", "ibs",
                   "encephalitis", "influenzae", "polio", "pertussis", "hairfall", "hairloss", "warts", "corns", "melasma"}


class _Vocab:
    def __init__(self) -> None:
        from .medication_safety import _INSTRUCTION_WORDS, _PACK_WORDS
        self.plain = (_wordlist("common-english-words.json") | _wordlist("clinical-english-words.json")
                      | _wordlist("clinical-terms.json", ("terms", "analytes")) | HINDI_WORDS | _NOT_DRUG
                      | _INSTRUCTION_WORDS | _PACK_WORDS)
        names: list[str] = []
        try:
            lx = json.loads((_DATA / "drug-lexicon.json").read_text(encoding="utf-8"))
            names = [n for n in lx.get("names") or [] if isinstance(n, str)]
            invest = {w for n in lx.get("investigations") or [] for w in re.findall(r"[a-z]+", str(n).lower())}
        except (OSError, ValueError):
            invest = set()
        first = {(_toks(n) or [""])[0] for n in names}  # a lexicon row's first word: the brand, or the molecule
        known = {t for n in sorted(GENERICS) + sorted(BRANDS) for t in _toks(n) if t.isalpha()}
        later = {t for n in names for t in _toks(n)[1:] if t.isalpha()}
        # A strong drug word: a brand / first word, a generic or brand of medication_safety, or a later lexicon word that looks
        # like a molecule (its suffix). Never a plain word, an investigation word, or a clinical-looking word ("deficiency",
        # "heartburn", "ulcer" sit in lexicon rows as descriptions).
        cand = first | known | {t for t in later if _MOLECULE.search(t)}
        self.strong = ({t for t in cand if t.isalpha() and len(t) >= 3 and t not in self.plain and t not in invest
                        and t not in _CLINICAL_WORDS and (t in known or not _CLINICAL.search(t))} | DRUG_ABBREVIATIONS
                       | OTC_BRANDS)
        self.everyday = SHORT_BRAND_SEED | {t for t in first if t.isalpha() and 3 <= len(t) <= 6 and t in self.plain - _NOT_DRUG}
        self.fuzzy: dict[str, set[str]] = {}
        for w in self.strong:
            if len(w) >= 6:
                for d in {w} | {w[:i] + w[i + 1:] for i in range(len(w))}:
                    self.fuzzy.setdefault(d, set()).add(w)

    def fuzzy_hit(self, t: str) -> str | None:
        """The strong drug word within one edit of `t` (6+ letters, `t` not a plain word): "paracetemol" -> paracetamol."""
        if len(t) < 6 or t in self.plain:
            return None
        if any(t.endswith(x) and t[:-len(x)] in self.plain for x in ("s", "es", "ed", "d", "ing", "ly")):
            return None  # an inflected plain word ("patches", "swelled") is not a misspelt drug
        cands = set()
        for d in {t} | {t[:i] + t[i + 1:] for i in range(len(t))}:
            cands |= self.fuzzy.get(d, set())
        return min((w for w in cands if _edit1(t, w)), default=None)


def _edit1(a: str, b: str) -> bool:
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    return any(b[:i] + b[i + 1:] == a for i in range(len(b)))


_VOCAB: _Vocab | None = None


def vocab() -> _Vocab:
    global _VOCAB
    if _VOCAB is None:
        _VOCAB = _Vocab()
    return _VOCAB


# --- R1-2: the name on tape -------------------------------------------------------------------------------------
def _clauses(text: str) -> list[str]:
    return [x for x in re.split(r"[.;,!?\n]+", text or "") if x.strip()]


def name_in_text(name: str, text: str, own: set[str] | None = None, use: bool = False, others: set[str] | None = None) -> bool:
    """`name` is said in `text`: every component phrase of name_phrases appears as whole, contiguous words (digits and unit /
    form words in the text skipped). Exact only: no prefix, no fuzzy spelling (fable ruling L2). With `use` (posting, R1-2)
    a phrase also must not be:
      - joined to the word before it into another drug, or follow a molecule prefix (PREFIXES: "hydroxy chloroquine",
        "methyl prednisolone", "levo cetirizine", "es omeprazole") (F3);
      - followed by another drug word that is not this medicine's own (`own`): "amoxicillin clavulanate" (F3), with a joiner
        between them skipped ("amoxicillin plus clavulanic acid", R4 G1) unless that drug is another medicine of this consult
        (`others`: "paracetamol and ibuprofen" names two medicines);
      - in a stop / avoid / negated clause ("Stop pan masala", "avoid ibuprofen") (F4);
      - a short brand that is an everyday word (vocab().everyday: Pan, Mox, Dolo, Azee, Zinc ...) without its strength or a
        form word next to it on tape ("Pan 40", "tab Pan") (F6)."""
    phrases = name_phrases(name)
    if not phrases:
        return False
    v = vocab() if use else None
    for clause in (_clauses(text) if use else [text]):
        raw = _raw(clause)
        words = [(i, t) for i, (t, k) in enumerate(raw) if k in ("word", "gnum")]
        seq = [t for _, t in words]
        ok = True
        for ph in phrases:
            n = len(ph)
            hit = False
            for j in range(len(seq) - n + 1):
                if tuple(seq[j:j + n]) != ph:
                    continue
                if use:
                    prev = seq[j - 1] if j else ""
                    k = j + n
                    while k < len(seq) and seq[k] in _JOIN:  # "+", "&" and "/" are "and" already (_alnum)
                        k += 1
                    nxt = seq[k] if k < len(seq) else ""
                    if k > j + n and nxt in (others or set()):
                        nxt = ""
                    if prev in PREFIXES or (prev and prev + ph[0] in v.strong):
                        continue
                    if nxt and (nxt in v.strong or ph[-1] + nxt in v.strong) and nxt not in (own or set()):
                        continue
                    if _NOT_USE & set(seq[max(0, j - 3):j]) or {"not", "no", "stop", "avoid"} & set(seq[j + n:j + n + 3]):
                        continue  # "stop Pan 40", "avoid ibuprofen", "Pan 40 not needed"
                    if n == 1 and ph[0] in v.everyday:
                        a, b = words[j][0], words[j + n - 1][0]
                        full = [t for x in _alnum(name) if not _STRENGTH.fullmatch(x) and x not in _FORM for t in _toks(x)]
                        whole = len(full) >= 2 and tuple(seq[j:j + len(full)]) == tuple(full)  # "Pan D": the brand's own full name
                        near_ok = _adjacent(raw, a - 1) or _adjacent(raw, b + 1)
                        if not near_ok and not whole:
                            continue
                hit = True
                break
            if not hit:
                ok = False
                break
        if ok:
            return True
    return False


def _own_words(m: dict) -> set[str]:
    """The words that name medicine `m` itself: its names' words, its molecules, and the same-molecule brands."""
    names = [n for n in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or []) if isinstance(n, str) and n.strip()]
    mols = {x for x in (molecules(n) for n in names) if x}
    names += [b for b, ms in BRANDS.items() if ms in mols] + [g for ms in mols for g in ms]
    return {t for n in names for t in _toks(n) if t.isalpha()} | {"".join(t for t in _toks(n) if t.isalpha()) for n in names}


def name_on_tape(m: dict, owner: dict | None, others: set[str] | None = None) -> bool:
    """R1-2. Medicine `m` stays posted only if BOTH:
      (a) its provenance owner (json_pointer /medicines/<i>) has evidence_state heard_in_room; and
      (b) at least one evidence entry with speaker == "doctor" has a quote_en or quote that says the drug's name, raw_name or
          one of its listed aliases (name_in_text with use=True).
    Matching (R2 D5 / L2, R3 F3 / F4 / F6 / L1): case-insensitive, whole words, EXACT on the normalised name. The normalised
    name is the name without strength digits, unit / form / pack words and salt / qualifier words (QUALIFIERS); a combination
    needs every component in the one clause. There is no prefix rule and no fuzzy rule. A salt, qualifier or vitamin word alone
    never counts. A molecule prefix or a joined drug word before the name, another drug word after it, a stop / avoid / negated
    clause, and an everyday-word brand without its strength or form word, all refuse the match. Any other speaker, or no owner,
    and the drug does not post."""
    if not owner or owner.get("evidence_state") != "heard_in_room":
        return False
    names = [n for n in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or []) if isinstance(n, str) and n.strip()]
    if names and all(set(t for ph in name_phrases(n) for t in ph) <= NON_RX for n in names if name_phrases(n)):
        return False  # ORS, Electral, calamine: never in the structured Rx (R4 G4)
    own = _own_words(m)
    for ev in owner.get("evidence") or []:
        if not isinstance(ev, dict) or ev.get("speaker") != "doctor":
            continue
        for k in ("quote_en", "quote"):
            if any(name_in_text(n, ev.get(k) or "", own, use=True, others=(others or set()) - own) for n in names):
                return True
    return False


# --- R1-2b (R3, fable F1 / F2 / F7 / L2): an ALLOWLIST. A drug in a posted string or the note must be a posted drug ---
_KNOWN = "_r1_known"  # scratch key on the working copy: names of the medicines R1 moved; apply_r1_ex pops it
_PX = re.compile(r"\b([A-Za-z]{1,3})[-\s]?(125|250|325|400|500|625|650|1000)\b")  # a letter-strength code: "P-650", "PCM 500"
_NOT_A_NAME = {"this", "that", "these", "those", "it", "same", "one", "other", "another", "name", "unnamed", "drug", "medicine",
               "new", "old", "your", "my", "his", "her", "their", "white", "pink", "yellow", "small", "big"}


def known_names(art: dict, extra: list[str] | None = None) -> list[str]:
    """Drug names this consult knows that the lexicon may not: `extra` (the Stage A rx rows' generic / brand_as_said /
    _heard_name, drug history, and the names of medicines R1 moved), and every medicine provenance item's names (the
    mapper's own held and pick_drug medicines included, F2). A mapper pick_drug detail is regimen text, not a name."""
    out = [n for n in extra or [] if isinstance(n, str)]
    for p in art.get("provenance") or []:
        if isinstance(p, dict) and p.get("kind") == "medicine":
            out += [n for n in p.get("names") or [] if isinstance(n, str)]
    return [n for n in dict.fromkeys(n.strip() for n in out) if n and not withhold_reason(n, "medicines")]


def drug_mentions(text: str, known: list[str] | None = None) -> list[tuple[str, ...]]:
    """Every drug mention in `text`, as the words that name it:
      - a strong drug word (the lexicon, GENERICS, BRANDS: not a plain English / clinical / Hindi word), or one edit from one
        (6+ letters: "paracetemol"), or two adjacent words that join into one ("para cetamol", "para-cetamol");
      - a letter-strength code ("P-650");
      - a known name (known_names): its strong words, or its whole phrase when it is all qualifiers ("calcium", F7), or an
        everyday / plain word of it with a strength or form word next to it ("Pan 40");
      - a SHORT_BRAND_SEED brand with a strength or form word next to it. (The wider vocab().everyday list is for posting
        only: in the scan it would withhold "reduce salt to 5 g".)"""
    v = vocab()
    out: list[tuple[str, ...]] = []
    for line in (text or "").split("\n"):
        raw = _raw(line)
        seq = [t for t, k in raw if k in ("word", "gnum")]  # "vitamin D3" keeps its 3
        pos = [i for i, (t, k) in enumerate(raw) if k in ("word", "gnum")]
        near = lambda j: _adjacent(raw, pos[j] - 1) or _adjacent(raw, pos[j] + 1)
        seq_all = [t for t, k in raw if k != "num"]  # the form words kept, for a known name that carries one ("fever tablet")
        known_strong, known_phr = set(), []
        for n in known or []:
            for t in _toks(n):
                if t.isalpha() and len(t) >= 3 and t not in _NOT_A_NAME and t not in _FORM and t not in v.plain:
                    known_strong.add(t)
            # R4 G2: a known name counts bare, as its whole phrase ("Met", "Pause", "calcium", "vitamin D3", "B complex"); a
            # name with a form word needs that word too ("fever tablet", "BP tablet"). The strength / form rule is for posting.
            ph = tuple(t for x in _alnum(n) if not _STRENGTH.fullmatch(x) and x not in _FORM - _ADJ_FORM for t in _toks(x))
            if ph and any(t.isalpha() for t in ph) and not set(t for t in ph if t not in _FORM) <= _NOT_A_NAME | NON_RX:
                known_phr.append(ph)
        j = 0
        while j < len(seq):
            t = seq[j]
            two = t + seq[j + 1] if j + 1 < len(seq) else ""
            if two and t not in v.strong and (two in v.strong or v.fuzzy_hit(two)):  # "para cetamol", "para-cetamol"
                out.append((two if two in v.strong else v.fuzzy_hit(two),))
                j += 1
            elif two and two in v.strong:
                out.append((two,))
                j += 1
            elif two and t in v.strong and seq[j + 1] not in v.strong and v.fuzzy_hit(two):  # "para cetemol": a half is a word
                out.append((v.fuzzy_hit(two),))
                j += 1
            elif t in v.strong or t in known_strong:
                out.append((t,))
            elif v.fuzzy_hit(t):
                out.append((v.fuzzy_hit(t),))
            elif t in SHORT_BRAND_SEED and near(j):
                out.append((t,))
            j += 1
        for ph in known_phr:
            n = len(ph)
            if any(tuple(seq_all[j:j + n]) == ph for j in range(len(seq_all) - n + 1)):
                out.append(ph)
        out += [(m.group(1).lower() + m.group(2),) for m in _PX.finditer(line) if m.group(1).lower() not in _NOT_DRUG
                and m.group(1).lower() not in v.plain]
    return [m for m in out if not set(m) <= NON_RX]


def posted_words(art: dict) -> set[str]:
    """The words a POSTED medicine may be written under: its own words (_own_words) and its provenance owner's names."""
    gx = art.get("gp_extraction") or {}
    out: set[str] = set()
    for i, m in enumerate(gx.get("medicines") or []):
        if not isinstance(m, dict):
            continue
        out |= _own_words(m)
        for p in _owners(art, f"/medicines/{i}"):
            out |= {t for n in p.get("names") or [] if isinstance(n, str) for t in _toks(n) if t.isalpha()}
    return out


_ITEM = re.compile(r"(;\s*|\n|(?<=[.!?])\s+)")
# R4 G3: a stop / avoid / do-not-take / allergy / reaction warning names a drug without prescribing it.
_WARNING = re.compile(r"\b(?:stop|stopped|avoid|do\s*n[o']?t\s+(?:take|use|stop|give|repeat|skip)|never\s+(?:take|use|give)|"
                      r"not\s+to\s+(?:take|use)|allerg\w*|had\s+(?:a\s+)?(?:rash|reaction)|reaction\s+to|discontinue\w*)\b", re.I)
_USE = re.compile(r"\b(?:start|take|continue|give|prescribe|use)\b", re.I)


def is_warning(item: str) -> bool:
    """`item` is a warning about a drug, not a use of it: a _WARNING cue, and no use cue outside the warning itself ("Avoid
    ibuprofen because of the ulcer", "Do not take amoxicillin again", "Stop metformin before the CT scan"; not "Stop
    amlodipine and start telmisartan")."""
    return bool(_WARNING.search(item)) and not _USE.search(_WARNING.sub(" ", item))


def items(text: str) -> list[str]:
    """`text` split into its items: on "; ", newlines and sentence ends."""
    return [x for x in _ITEM.split(text or "")[::2] if x.strip()]


def unposted(art: dict, text: str, known: list[str] | None = None) -> list[tuple[str, ...]]:
    """The drug mentions in `text` that do not resolve to a posted, tape-supported medicine (posted_words). Each one is
    treated as a moved drug. A warning item (is_warning) passes: it names a drug without prescribing it (R4 G3)."""
    pw = posted_words(art)
    return [m for it in items(text) if not is_warning(it) for m in drug_mentions(it, known) if not set(m) <= pw]


def _withhold_items(art: dict, path: tuple, known: list[str], c: dict) -> bool:
    """R4 G3: withhold only the items of the string at `path` that name an unresolved drug, keeping every other item and its
    separator byte for byte. One field_withheld item per withheld item. False (nothing done) when every item goes, or the
    string is a list row's required name: then the whole field is withheld as before."""
    gx = art["gp_extraction"]
    lp = next((k for k in LISTS if path[:len(k)] == k and len(path) > len(k)), None)
    if lp is not None and (len(path) == len(lp) + 1 or path[len(lp) + 1] in LISTS[lp][1] or len(path) > len(lp) + 2):
        return False
    parts = _ITEM.split(_get(gx, path))
    bad = [i for i in range(0, len(parts), 2) if parts[i].strip() and unposted(art, parts[i], known)]
    keep = [i for i in range(0, len(parts), 2) if parts[i].strip() and i not in bad]
    if not bad or not keep:
        return False
    out = "".join(parts[i] + (parts[i + 1] if i + 1 < len(parts) and i != keep[-1] else "") for i in keep)
    _get(gx, path[:-1])[path[-1]] = out
    if lp is not None:
        kind, section, owner = LISTS[lp][0], lp[-1], (_owners(art, _ptr(lp + (path[len(lp)],))) or [None])[0]
    else:
        kind, ptr = SCALARS.get(path, (_TOP_KIND.get(str(path[0]), "management_plan"), None))
        section = str(path[-1]) if path in SCALARS else str(path[0])
        owner = (_owners(art, ptr) or [None])[0] if ptr else (_owners(art, "/" + str(path[0])) or [None])[0]
    for _ in bad:
        _withheld_item(art, kind, section, owner, "unconfirmed drug")
        c["r1_2b_withheld"] += 1
    return True


def r1_allowlist(art: dict, c: dict, known: list[str] | None = None) -> None:
    """R1-2b. Every posted gp_extraction string with a drug mention that is not a posted medicine: only the items that name it
    are withheld (R4 G3, _withhold_items), or the whole field when every item does or it is a required name (as R1-1 does,
    flag field_withheld, "<section> withheld (unconfirmed drug)"). A medicine's own name fields always resolve to it."""
    gx = art.get("gp_extraction")
    if not isinstance(gx, dict):
        return
    known = known_names(art, known)
    hits: list[tuple] = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, path + (k,))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, path + (i,))
        elif isinstance(node, str) and unposted(art, node, known):
            hits.append(path)

    walk(gx, ())
    hits = [h for h in hits if not _withhold_items(art, h, known, c)]
    if hits:
        r1_posted_fields(art, c, hits, "unconfirmed drug", "r1_2b")


def r1_medicine_floor(art: dict, c: dict) -> None:
    meds = (art.get("gp_extraction") or {}).get("medicines") or []
    words = [_own_words(m) if isinstance(m, dict) else set() for m in meds]
    move = {i: None for i, m in enumerate(meds) if not name_on_tape(m, (_owners(art, f"/medicines/{i}") or [None])[0],
                                                                    set().union(*(w for x, w in enumerate(words) if x != i)))}
    c["r1_2_moved"] += _to_pick_drug(art, move) if move else 0


# --- R1-3 -----------------------------------------------------------------------------------------------------
DOSE_FIELDS_R1 = ("frequency", "duration", "strength", "instructions")


def _runs(text: str, lang: str = "en") -> set[str]:
    """Digit runs after guard.numerals (the existing number-word helper: "two" -> "2", Hindi words on non-English turns)."""
    return set(re.findall(r"\d+", numerals(text or "", lang)))


# R4 addendum 8: a spoken self-correction. A number said before the last cue and not again after it is retracted.
CORRECTION = re.compile(r"\b(?:no,?\s+wait|wait,?\s+no|sorry|i\s+mean|make\s+it|actually|no,?\s+no|rather|scratch\s+that|"
                        r"change\s+(?:it|that)\s+to|correction)\b", re.I)


def retracted(text: str, lang: str = "en") -> set[str]:
    """The digit runs `text` takes back: said before its last CORRECTION cue and not said after it ("from 500 to 1000, no
    wait, keep 500" -> {"1000"}; "500, make it 1000" -> {"500"})."""
    cues = list(CORRECTION.finditer(text or ""))
    if not cues:
        return set()
    cut = cues[-1].end()
    return _runs(text[:cues[-1].start()], lang) - _runs(text[cut:], lang)


def dose_on_tape(m: dict, owner: dict | None) -> list[str]:
    """R1-3. The dose fields of `m` holding a digit run (or English number word) that no evidence quote of its owner holds, or
    that a quote took back (retracted). Such a field is withheld whole and the drug goes to pick_drug: never the dose the
    doctor corrected away (R4 addendum 8)."""
    have: set[str] = set()
    gone: set[str] = set()
    for ev in (owner or {}).get("evidence") or []:
        if isinstance(ev, dict):
            have |= _runs(ev.get("quote_en") or "", "en") | _runs(ev.get("quote") or "", ev.get("lang") or "en")
            gone |= retracted(ev.get("quote_en") or "", "en") | retracted(ev.get("quote") or "", ev.get("lang") or "en")
    bad = [f for f in DOSE_FIELDS_R1 if isinstance(m.get(f), str)
           and (not _runs(m[f], "en") <= have or _runs(m[f], "en") & gone)]
    # the mapper can carry the strength in the name ("paracetamol 1000 mg"): a corrected-away number there moves the drug
    return bad + [f for f in ("name", "raw_name") if isinstance(m.get(f), str) and _runs(m[f], "en") & gone]


def r1_dose_floor(art: dict, c: dict) -> None:
    meds = (art.get("gp_extraction") or {}).get("medicines") or []
    move = {}
    for i, m in enumerate(meds):
        bad = dose_on_tape(m, (_owners(art, f"/medicines/{i}") or [None])[0])
        if bad:
            for f in bad:
                if f not in ("name", "raw_name"):  # a name is never popped: the whole drug moves to pick_drug below
                    m.pop(f, None)  # the whole field, never the digit
            c["r1_3_fields_removed"] += len(bad)
            move[i] = f"{_med_label(m)} (dose not on tape)"
    c["r1_3_moved"] += _to_pick_drug(art, move) if move else 0


# --- R1-5 -----------------------------------------------------------------------------------------------------
_IF = r"\bif\b[^.?!]{0,140}?"
# Worsening and red-flag cues (R2, fable ruling L1): "start ...ing", "continues" and a bare "return" are not cues.
_WORSE = (r"(?:worse|worsens?|worsening|increases?|increasing|goes\s+up|severe|unbearable|persists?|"
          r"does\s*n[o']?t\s+(?:settle|stop|improve|reduce|go\s+down)|not\s+(?:settl|stopp|improv|reduc)\w*|"
          r"keeps?\s+(?:coming|going|vomiting|bleeding)|bleed\w*|blood\s+in\b|vomit\w*|faint\w*|breathless\w*|"
          r"breathing\s+(?:difficulty|problem)|difficulty\s+(?:in\s+)?breathing|chest\s+pain|unconscious|drows\w*|fits?|"
          r"seizures?|convulsions?|high\s+fever|black\s+stools?|"
          # R3 L3: "not better in two days", "if the fever continues", "if it continues"
          r"not\s+(?:better|improving|improved)|(?:it|fever|pain|vomiting|bleeding|swelling|symptoms?)\s+(?:continues|persists))")
_PLACE = r"(?:the\s+)?(?:emergency(?:\s+room|\s+department)?|casualty|er|a\s*&\s*e|hospital)"
RED_FLAG_PATTERNS = tuple(re.compile(p, re.I) for p in (
    # come (back) immediately / at once / straight away / right away
    r"\bcome\s+(?:back\s+)?(?:here\s+|to\s+" + _PLACE + r"\s+)?(?:immediately|at\s+once|straight\s*away|right\s+away|urgently)\b",
    # go / come / run / report to (the) emergency / casualty / ER
    r"\b(?:go|come|run|report|head)\s+(?:back\s+)?(?:straight\s+|directly\s+)?to\s+(?:the\s+)?(?:emergency|casualty|er|a\s*&\s*e)\b",
    # if <it gets worse | symptom increases / does not settle> ... come back / return / go to hospital
    _IF + _WORSE + r"[^.?!]{0,100}?\b(?:come\s+back|come\s+(?:again|here|to\s+" + _PLACE + r")|return\s+(?:here|to\s+(?:us|me|"
    + _PLACE + r"|the\s+clinic|clinic))|go\s+to\s+" + _PLACE
    + r"|rush\s+to\s+" + _PLACE + r"|see\s+(?:me|us|a\s+doctor)\s+(?:immediately|at\s+once|urgently))\b",
    # rush (him / her) to hospital
    r"\brush\s+(?:\w+\s+){0,2}?to\s+" + _PLACE + r"\b",
    # bring / take him to casualty (R3 L3)
    r"\b(?:bring|take|carry)\s+(?:\w+\s+){0,2}?to\s+" + _PLACE + r"\b",
))
# A worsening or red-flag cue in the sentence itself, the emergency words included.
RED_FLAG_CUE = re.compile(r"\b" + _WORSE + r"|\b(?:emergency|casualty|er|a\s*&\s*e|immediately|at\s+once|straight\s*away|"
                          r"right\s+away|urgently|rush|drowsy)\b", re.I)
# Negated or "not needed" instructions never fire ("No need to go to the emergency", "You don't need to come back"). Only a
# negation of the instruction itself: "Don't worry, but if it gets worse come back immediately" still fires.
NEGATION = re.compile(r"\b(?:no\s+need|(?:do|does)\s*n[o']?t\s+(?:need|have\s+to|go|come|rush)|need\s*n[o']?t|"
                      r"not\s+(?:needed|necessary|required|an\s+emergency)|unnecessary)\b", re.I)
_SENT = re.compile(r"(?<=[.!?])\s+")
_TOK_STOP = {"the", "a", "an", "and", "or", "of", "to", "you", "your", "if", "it", "is", "be", "for", "in", "on", "at", "come",
             "back", "please", "do", "not", "then", "there", "any", "this", "that", "with", "start", "get", "gets"}


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in _TOK_STOP}


def overlap(clause: str, text: str) -> float:
    """Normalised token overlap: share of the clause's tokens (lowercase alphanumerics, stop words out) present in `text`."""
    a, b = _tokens(clause), _tokens(text)
    return len(a & b) / len(a) if a else 1.0


def is_red_flag(sentence: str) -> bool:
    """One sentence carries an emergency or return-if-worse instruction: a RED_FLAG_PATTERNS match, a RED_FLAG_CUE, and no
    NEGATION."""
    return (any(p.search(sentence) for p in RED_FLAG_PATTERNS) and bool(RED_FLAG_CUE.search(sentence))
            and not NEGATION.search(sentence))


def red_flag_clauses(text: str) -> list[str]:
    """Sentences of `text` that carry an emergency or return instruction (is_red_flag). A question is not an instruction
    ("Go to ER? No, not needed.")."""
    return [s.strip() for s in _SENT.split(text or "") if s.strip() and not s.strip().endswith("?") and is_red_flag(s)]


def _turn(t, i: int) -> dict:
    """An ingest.Turn or a dict (offline replay) as one view."""
    g = (lambda k: t.get(k)) if isinstance(t, dict) else (lambda k: getattr(t, k, None))
    role = g("role")
    if role not in SPEAKERS:
        role = g("speaker") if g("speaker") in SPEAKERS else "unknown"
    idx = g("idx")
    return {"idx": idx if isinstance(idx, int) else i, "role": role, "text": g("quote_en") or g("text") or "",
            "lang": g("lang") or "en", "t0_ms": g("t0_ms"), "t1_ms": g("t1_ms"), "t0": g("t0"), "t1": g("t1"),
            "role_source": g("role_source") or g("speaker_source")}


def _english(lang: str) -> bool:
    return str(lang or "").lower().split("-")[0] == "en"


def _trim(s: str, n: int = 200) -> str:
    if len(s) <= n:
        return s
    cut = s[:n]
    return (cut.rsplit(" ", 1)[0] if " " in cut else cut).rstrip(" ,;")


def r1_red_flags(art: dict, turns, c: dict, known: list[str] | None = None) -> None:
    """R1-5. Each doctor emergency / return clause not already covered by the POSTED advice (token overlap >= 0.6 with
    general_advice or a posted advice item's text, or a posted advice item citing the same segment_ref) becomes one advice line,
    built from the doctor's own clause through scrub_identity and trimmed to 200 characters. It runs after R1-2b (R3 F4), so a
    withheld advice field never hides a red flag. Its provenance item is a new advice item with json_pointer null (R3 F5): it
    claims nothing, so it never clashes with the advice owner. A line that fails R1-1, printable_errors, the FRX-A1 limits or
    the allowlist (it names a drug that is not posted) is not added and is counted. English doctor turns only; quarantined
    turns are another patient's."""
    if turns is None:
        c["r1_5_no_turns"] += 1
        return
    gx = art.setdefault("gp_extraction", {})
    uid = str((art.get("encounter") or {}).get("eta_encounter_id") or "")
    quarantined = set(((art.get("clip_boundary") or {}).get("quarantined_turns")) or [])
    src = ((art.get("encounter") or {}).get("transcript") or {}).get("speaker_source")
    for i, raw in enumerate(turns):
        t = _turn(raw, i)
        if t["role"] != "doctor":
            continue
        if not _english(t["lang"]):
            c["r1_5_non_english_skipped"] += 1
            continue
        if t["idx"] in quarantined:
            continue
        for clause in red_flag_clauses(t["text"]):
            c["r1_5_detected"] += 1
            ref = f"{uid}:{t['idx']}"
            advice = gx.get("general_advice") if isinstance(gx.get("general_advice"), str) else ""
            prov_adv = [p for p in art.get("provenance") or [] if isinstance(p, dict) and p.get("kind") == "advice"
                        and (p.get("json_pointer") or str(p.get("item_id") or "").startswith("advr1_"))]
            texts = [x for x in advice.split("; ") if x] + [re.sub(r"^\[[^\]]*\]\s*", "", str(p.get("text") or "")) for p in prov_adv]
            cited = any(str((ev or {}).get("segment_ref")) == ref for p in prov_adv for ev in p.get("evidence") or [])
            if cited or any(overlap(clause, x) >= 0.6 for x in texts):
                c["r1_5_covered"] += 1
                continue
            line = _trim(scrub_identity(clause))
            new = f"{advice}; {line}" if advice else line
            if (not line or withhold_reason(line, "general_advice") or printable_errors(f"General Advice: {line}", [])
                    or unposted(art, line, known_names(art, known))
                    or len(new) > 300 or len([x for x in new.split("; ") if x]) > 5):
                c["r1_5_blocked"] += 1
                continue
            t0 = t["t0"] or (iso(t["t0_ms"]) if isinstance(t["t0_ms"], int) else None)
            t1 = t["t1"] or (iso(t["t1_ms"]) if isinstance(t["t1_ms"], int) else None)
            ss = "role_track" if t["role_source"] == "role_track" else (src if src in SPEAKER_SOURCES else "model_inferred")
            ev = {"segment_ref": ref, "t0": t0, "t1": t1, "quote_en": t["text"], "quote": t["text"], "lang": t["lang"],
                  "speaker": "doctor", "speaker_source": ss}
            gx["general_advice"] = new
            # F5: one owner per pointer. With an advice owner already, this is a new item that claims nothing (json_pointer
            # null, which the schema allows only with a non-posting status: "conditional", an if-then instruction). With none,
            # it is the owner (FRX-A1 needs one), so it cannot clash either.
            owned = bool(_owners(art, "/general_advice"))
            art.setdefault("provenance", []).append({
                "item_id": _new_id(art, "advr1_"), "kind": "advice", "text": line[:300], "evidence_state": "heard_in_room",
                "status": "conditional" if owned else "prescribed", "negated": False, "speaker": "doctor", "speaker_source": ss,
                "evidence": [ev], "confidence": 0.8, "json_pointer": None if owned else "/general_advice", "flags": [],
                "decision": {"turn": t["idx"], "speaker": "doctor", "quote": t["text"][:400]}})
            c["r1_5_added"] += 1


# --- R1-4 -----------------------------------------------------------------------------------------------------
def notes_only_note(art: dict, note: str) -> tuple[str, bool]:
    """The note with its Medication section made deterministic (note.medication_floor), MEDICATION_LABEL its first line whenever
    a drug posts (FRX-R1b B2 / B3: the label passes printable_errors, and validate._unlabelled skips it for G6 / C4 / FRX-C2).
    Returns (note, label_kept)."""
    flags = flags_by_pointer(art)
    banned = [n for p in art.get("provenance") or [] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
    out = medication_floor(note, art.get("gp_extraction") or {}, flags, banned, combination_groups(art), label=True)
    return out, f"Medication: {MEDICATION_LABEL}" in out.split("\n")


def unposted_in_note(art: dict, note: str, known: list[str] | None = None) -> list[tuple[str, ...]]:
    """The drug mentions in `note` that are not a posted medicine (unposted, R3 allowlist). A note with any is never kept."""
    return unposted(art, note, known_names(art, known))


# --- entry point ----------------------------------------------------------------------------------------------
COUNTERS = ("r1_1_withheld", "r1_1_rows_removed", "r1_2_moved", "r1_2b_withheld", "r1_2b_rows_removed", "r1_3_fields_removed",
            "r1_3_moved", "r1_4_note_rewritten", "r1_4_label_kept", "r1_4_pick_drug_in_note", "r1_5_detected", "r1_5_covered", "r1_5_added", "r1_5_blocked", "r1_5_non_english_skipped",
            "r1_5_no_turns")


def apply_r1(art: dict, turns: list | None = None, notes_only: bool = True) -> tuple[dict, dict]:
    """R1-1, R1-2, R1-3, R1-2b (the allowlist) and R1-5 on a copy of `art` (the input is never mutated), then R1-4 on its note_text when
    it has one (a stored artifact). `turns`: the consult's turns (ingest.Turn or dicts with role / text or quote_en / lang /
    idx / t0_ms / t1_ms); None skips R1-5. notes_only False returns an unchanged copy: R1 off is the base behaviour.
    Returns (new artifact, counters) with every key of COUNTERS, plus "notes_only"."""
    out, c, _ = apply_r1_ex(art, turns, notes_only)
    return out, c


def apply_r1_ex(art: dict, turns: list | None = None, notes_only: bool = True,
                known: list[str] | None = None) -> tuple[dict, dict, list[str]]:
    """apply_r1, plus the known drug names (for unposted_in_note): `known` (the Stage A rx rows' generic / brand_as_said /
    _heard_name and drug history, when the caller has them) and the names of every medicine R1 moved. Order: R1-1, R1-2,
    R1-3, R1-2b (the allowlist), then R1-5 (R3 F4). A stored note_text that still names a drug that is not posted after R1-4
    is replaced by the deterministic note."""
    out = copy.deepcopy(art)
    c = {k: 0 for k in COUNTERS}
    c["notes_only"] = bool(notes_only)
    if not notes_only:
        return out, c, []
    out[_KNOWN] = []
    r1_posted_fields(out, c)
    r1_medicine_floor(out, c)
    r1_dose_floor(out, c)
    names = list(known or []) + out[_KNOWN]
    r1_allowlist(out, c, names)
    r1_red_flags(out, turns, c, names + out[_KNOWN])
    names = list(dict.fromkeys(names + out.pop(_KNOWN)))
    if isinstance(out.get("note_text"), str) and out["note_text"].strip():
        note, kept = notes_only_note(out, out["note_text"])
        if unposted_in_note(out, note, names):
            from .pipeline import _fallback_note_ex
            banned = [n for p in out.get("provenance") or [] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
            note, kept = notes_only_note(out, _fallback_note_ex(out, flags_by_pointer(out), banned)[0])
        c["r1_4_note_rewritten"] = int(note != out["note_text"])
        c["r1_4_label_kept"] = int(kept)
        c["r1_4_pick_drug_in_note"] = int(bool(unposted_in_note(out, note, names)))
        out["note_text"] = note
    return out, c, names
