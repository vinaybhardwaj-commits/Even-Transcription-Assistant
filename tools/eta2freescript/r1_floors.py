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
import re
import unicodedata

from .guard import numerals
from .mapper import iso
from .medication_safety import BRANDS, GENERICS, instruction_only, molecules
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
        art.setdefault(_MOVED, []).append(guard_names(m, (owner or {}).get("names")))  # before the demote empties the owner's names
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
         "suspension", "solution", "the", "for", "kit", "respules", "powder", "dt", "md"}
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
_TOK = re.compile(r"[^\W\d_]+|\d+(?:\.\d+)?")


def _toks(text: str) -> list[str]:
    """Lowercase NFKC tokens: letter runs and digit runs apart ("Dolo-650" and "dolo650" -> dolo, 650)."""
    return [t.lower() for t in _TOK.findall(unicodedata.normalize("NFKC", text or ""))]


def _alnum(text: str) -> list[str]:
    """Words with a glued letter-digit word kept whole ("D3", "B12"), for the qualifier test."""
    return [t.lower() for t in re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text or ""))]


_STRENGTH = re.compile(r"\d+(?:\.\d+)?(?:mg|mcg|ml|g|iu)?")


def _name_toks(text: str) -> list[str]:
    """The words of `text` that can be part of a name: a standalone strength ("650", "500mg") and unit / form / pack words
    out; the rest split into letter and digit runs ("dolo650" -> dolo, 650; "D3" -> d, 3)."""
    return [t for w in _alnum(text) if not _STRENGTH.fullmatch(w) and w not in _FORM for t in _toks(w)]


def name_phrases(name: str) -> list[tuple[str, ...]]:
    """The phrases a name must show on tape, one per component of a combination; [] when it has no usable component.
    A component is its words without digits, unit / form / pack words. Its base is that minus the QUALIFIERS (salt, vitamin,
    pack). A component with a base needs the base phrase ("pantoprazole sodium" -> pantoprazole, "Augmentin 625 Duo" ->
    augmentin, "folic acid" -> folic). A component that is all qualifiers needs its whole phrase, of 2+ words ("vitamin D3",
    "potassium chloride"); a lone qualifier ("calcium") never counts."""
    out: list[tuple[str, ...]] = []
    comp: list[str] = []
    words = [w for w in _alnum(name) if not _STRENGTH.fullmatch(w) and w not in _FORM]
    for w in words + ["and"]:
        if w in _JOIN:
            if comp:
                base = tuple(x for x in comp if x not in QUALIFIERS)
                if base:
                    out.append(tuple(t for x in base for t in _toks(x)))
                elif len(comp) >= 2:
                    out.append(tuple(t for x in comp for t in _toks(x)))
                else:
                    return []
            comp = []
        else:
            comp.append(w)
    return out


def _has_phrase(phrase: tuple[str, ...], toks: list[str]) -> bool:
    n = len(phrase)
    return n > 0 and any(tuple(toks[i:i + n]) == phrase for i in range(len(toks) - n + 1))


def name_in_text(name: str, text: str) -> bool:
    """`name` is said in `text`: every component phrase of name_phrases appears as whole, contiguous words (digits and unit /
    form words in the text skipped). Exact only: no prefix, no fuzzy spelling (fable ruling L2)."""
    phrases = name_phrases(name)
    toks = _name_toks(text)
    return bool(phrases) and all(_has_phrase(p, toks) for p in phrases)


def name_on_tape(m: dict, owner: dict | None) -> bool:
    """R1-2. Medicine `m` stays posted only if BOTH:
      (a) its provenance owner (json_pointer /medicines/<i>) has evidence_state heard_in_room; and
      (b) at least one evidence entry with speaker == "doctor" has a quote_en or quote that says the drug's name, raw_name or
          one of its listed aliases (name_in_text).
    Matching (R2, fable rulings D5 and L2): case-insensitive, whole words, EXACT on the normalised name. The normalised name is
    the name without strength digits, unit / form / pack words and salt / qualifier words (QUALIFIERS); a combination needs
    every component in the one quote. There is no prefix rule and no fuzzy rule: prednisolone never matches prednisone,
    amoxicillin never matches amoxiclav, unless that word is itself a listed alias. A salt, qualifier or vitamin word alone
    ("acid", "sodium", "calcium", "vitamin", "Duo") never counts. Any other speaker, or no owner, and the drug does not post."""
    if not owner or owner.get("evidence_state") != "heard_in_room":
        return False
    names = [n for n in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or []) if isinstance(n, str) and n.strip()]
    for ev in owner.get("evidence") or []:
        if not isinstance(ev, dict) or ev.get("speaker") != "doctor":
            continue
        for k in ("quote_en", "quote"):
            if any(name_in_text(n, ev.get(k) or "") for n in names):
                return True
    return False


# --- R1-2b (R2, fable ruling D3): a moved drug is never visible ---------------------------------------------------
_MOVED = "_r1_moved"  # scratch key on the working copy: the guard names of every moved drug; apply_r1 pops it


_NOT_A_NAME = {"this", "that", "these", "those", "it", "same", "one", "other", "another", "name", "unnamed", "drug", "medicine",
               "new", "old", "your", "my", "his", "her", "their", "white", "pink", "yellow", "small", "big"}


# Guard-only short forms and brands the existing alias data (medication_safety.BRANDS) does not hold. They only make the
# moved-drug guard wider (a note or posted field naming them is withheld); they never let a drug post.
GUARD_ALIASES: dict[str, tuple[str, ...]] = {"paracetamol": ("calpol", "pcm", "crocin", "dolo")}
_GUARD_REVERSE = {a: g for g, al in GUARD_ALIASES.items() for a in al}


def guard_names(m: dict, owner_names: list | None = None) -> list[str]:
    """Every name a moved medicine can be written under: its name, raw_name and aliases, its provenance owner's names, plus,
    through the alias data (medication_safety.BRANDS and GENERICS, and GUARD_ALIASES), each brand and the generic of the same
    molecule set (Dolo 650 -> paracetamol, crocin, dolo, calpol, pcm)."""
    names = [n for n in [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or []) + list(owner_names or [])
             if isinstance(n, str) and n.strip()]
    mols = {x for x in (molecules(n) for n in names) if x}
    mols |= {frozenset({_GUARD_REVERSE[w]}) for n in names for w in _toks(n) if w in _GUARD_REVERSE}
    names += [b for b, ms in BRANDS.items() if ms in mols]
    names += [g for g in GENERICS if frozenset({g}) in mols]
    names += [a for ms in mols if len(ms) == 1 for a in GUARD_ALIASES.get(next(iter(ms)), ())]
    out: list[str] = []
    for n in names:
        # a placeholder or a bare pointing word ("this tablet") is not a name to look for
        if n in out or withhold_reason(n, "medicines") or instruction_only(n):
            continue
        phrases = name_phrases(n)
        if phrases and not all(set(ph) <= _NOT_A_NAME for ph in phrases):
            out.append(n)
    return out


def moved_in_text(moved: list[list[str]], text: str) -> bool:
    """`text` names a drug R1 moved to pick_drug (`moved`: guard_names of each moved drug; whole words, line by line)."""
    return any(name_in_text(n, line) for names in moved or [] for n in names for line in (text or "").split("\n"))


def r1_moved_mentions(art: dict, c: dict) -> None:
    """Withhold, whole, every posted gp_extraction string that names a moved drug (as R1-1 does, flag field_withheld). A posted
    medicine whose name is that drug moves to pick_drug too, which adds its names: repeat until nothing names a moved drug."""
    for _ in range(20):
        gx = art.get("gp_extraction")
        if not isinstance(gx, dict) or not art.get(_MOVED):
            return
        hits: list[tuple] = []

        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    walk(v, path + (k,))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, path + (i,))
            elif isinstance(node, str) and moved_in_text(art[_MOVED], node):
                hits.append(path)

        walk(gx, ())
        if not hits:
            return
        r1_posted_fields(art, c, hits, "unconfirmed drug", "r1_2b")


def r1_medicine_floor(art: dict, c: dict) -> None:
    meds = (art.get("gp_extraction") or {}).get("medicines") or []
    move = {i: None for i, m in enumerate(meds) if not name_on_tape(m, (_owners(art, f"/medicines/{i}") or [None])[0])}
    c["r1_2_moved"] += _to_pick_drug(art, move) if move else 0


# --- R1-3 -----------------------------------------------------------------------------------------------------
DOSE_FIELDS_R1 = ("frequency", "duration", "strength", "instructions")


def _runs(text: str, lang: str = "en") -> set[str]:
    """Digit runs after guard.numerals (the existing number-word helper: "two" -> "2", Hindi words on non-English turns)."""
    return set(re.findall(r"\d+", numerals(text or "", lang)))


def dose_on_tape(m: dict, owner: dict | None) -> list[str]:
    """R1-3. The dose fields of `m` holding a digit run (or English number word) that no evidence quote of its owner holds."""
    have: set[str] = set()
    for ev in (owner or {}).get("evidence") or []:
        if isinstance(ev, dict):
            have |= _runs(ev.get("quote_en") or "", "en") | _runs(ev.get("quote") or "", ev.get("lang") or "en")
    return [f for f in DOSE_FIELDS_R1 if isinstance(m.get(f), str) and not _runs(m[f], "en") <= have]


def r1_dose_floor(art: dict, c: dict) -> None:
    meds = (art.get("gp_extraction") or {}).get("medicines") or []
    move = {}
    for i, m in enumerate(meds):
        bad = dose_on_tape(m, (_owners(art, f"/medicines/{i}") or [None])[0])
        if bad:
            for f in bad:
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
          r"seizures?|convulsions?|high\s+fever|black\s+stools?)")
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
))
# A worsening or red-flag cue in the sentence itself, the emergency words included.
RED_FLAG_CUE = re.compile(r"\b" + _WORSE + r"|\b(?:emergency|casualty|er|a\s*&\s*e|immediately|at\s+once|straight\s*away|"
                          r"right\s+away|urgently|rush)\b", re.I)
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


def r1_red_flags(art: dict, turns, c: dict) -> None:
    """R1-5. Each doctor emergency / return clause not already covered by the advice (token overlap >= 0.6 with general_advice
    or any advice provenance text, or an advice item citing the same segment_ref) becomes one advice line, built from the
    doctor's own clause through scrub_identity and trimmed to 200 characters. A line that fails R1-1, printable_errors or the
    FRX-A1 limits is not added and is counted. English doctor turns only; quarantined turns are another patient's."""
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
            prov_adv = [p for p in art.get("provenance") or [] if isinstance(p, dict) and p.get("kind") == "advice"]
            texts = [x for x in advice.split("; ") if x] + [re.sub(r"^\[[^\]]*\]\s*", "", str(p.get("text") or "")) for p in prov_adv]
            cited = any(str((ev or {}).get("segment_ref")) == ref for p in prov_adv for ev in p.get("evidence") or [])
            if cited or any(overlap(clause, x) >= 0.6 for x in texts):
                c["r1_5_covered"] += 1
                continue
            line = _trim(scrub_identity(clause))
            new = f"{advice}; {line}" if advice else line
            if (not line or withhold_reason(line, "general_advice") or printable_errors(f"General Advice: {line}", [])
                    or len(new) > 300 or len([x for x in new.split("; ") if x]) > 5):
                c["r1_5_blocked"] += 1
                continue
            t0 = t["t0"] or (iso(t["t0_ms"]) if isinstance(t["t0_ms"], int) else None)
            t1 = t["t1"] or (iso(t["t1_ms"]) if isinstance(t["t1_ms"], int) else None)
            ss = "role_track" if t["role_source"] == "role_track" else (src if src in SPEAKER_SOURCES else "model_inferred")
            ev = {"segment_ref": ref, "t0": t0, "t1": t1, "quote_en": t["text"], "quote": t["text"], "lang": t["lang"],
                  "speaker": "doctor", "speaker_source": ss}
            gx["general_advice"] = new
            art.setdefault("provenance", []).append({
                "item_id": _new_id(art, "advr1_"), "kind": "advice", "text": line[:300], "evidence_state": "heard_in_room",
                "status": "prescribed", "negated": False, "speaker": "doctor", "speaker_source": ss, "evidence": [ev],
                "confidence": 0.8, "json_pointer": "/general_advice", "flags": [],
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


def moved_in_note(moved: list[list[str]], note: str) -> bool:
    """A drug R1 moved to pick_drug (`moved`, from apply_r1_ex) is named in `note`: by its name, raw_name, an alias, its
    owner's names, or a brand / generic of the same molecule (guard_names). Such a note is never kept (R2, fable ruling D3)."""
    return moved_in_text(moved, note)


# --- entry point ----------------------------------------------------------------------------------------------
COUNTERS = ("r1_1_withheld", "r1_1_rows_removed", "r1_2_moved", "r1_2b_withheld", "r1_2b_rows_removed", "r1_3_fields_removed",
            "r1_3_moved", "r1_4_note_rewritten", "r1_4_label_kept", "r1_4_pick_drug_in_note", "r1_5_detected", "r1_5_covered", "r1_5_added", "r1_5_blocked", "r1_5_non_english_skipped",
            "r1_5_no_turns")


def apply_r1(art: dict, turns: list | None = None, notes_only: bool = True) -> tuple[dict, dict]:
    """R1-1, R1-2 (with R1-2b), R1-3 and R1-5 on a copy of `art` (the input is never mutated), then R1-4 on its note_text when
    it has one (a stored artifact). `turns`: the consult's turns (ingest.Turn or dicts with role / text or quote_en / lang /
    idx / t0_ms / t1_ms); None skips R1-5. notes_only False returns an unchanged copy: R1 off is the base behaviour.
    Returns (new artifact, counters) with every key of COUNTERS, plus "notes_only"."""
    out, c, _ = apply_r1_ex(art, turns, notes_only)
    return out, c


def apply_r1_ex(art: dict, turns: list | None = None, notes_only: bool = True) -> tuple[dict, dict, list[list[str]]]:
    """apply_r1, plus the guard_names of every drug it moved to pick_drug (for moved_in_note). A stored note_text that still
    names a moved drug after R1-4 is replaced by the deterministic note (R2, fable ruling D3)."""
    out = copy.deepcopy(art)
    c = {k: 0 for k in COUNTERS}
    c["notes_only"] = bool(notes_only)
    if not notes_only:
        return out, c, []
    out[_MOVED] = []
    r1_posted_fields(out, c)
    r1_medicine_floor(out, c)
    r1_dose_floor(out, c)
    r1_red_flags(out, turns, c)
    r1_moved_mentions(out, c)  # last: an R1-5 line, or a row moved by R1-1 / R1-3, can name a moved drug too
    moved = out.pop(_MOVED)
    if isinstance(out.get("note_text"), str) and out["note_text"].strip():
        note, kept = notes_only_note(out, out["note_text"])
        if moved_in_note(moved, note):
            from .pipeline import _fallback_note_ex
            banned = [n for p in out.get("provenance") or [] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
            note, kept = notes_only_note(out, _fallback_note_ex(out, flags_by_pointer(out), banned)[0])
        c["r1_4_note_rewritten"] = int(note != out["note_text"])
        c["r1_4_label_kept"] = int(kept)
        c["r1_4_pick_drug_in_note"] = int(moved_in_note(moved, note))
        out["note_text"] = note
    return out, c, moved
