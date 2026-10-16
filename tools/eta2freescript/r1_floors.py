"""FreeScript R1: notes-only restart floors (V, 16 Oct). Pure functions over an eta.freescript artifact dict.

FreeScript restarts for notes only. Medicines are never presented as the Rx: a drug posts only when its NAME is on tape in a
doctor-attributed span, and every other drug becomes a doctor-confirm pick_drug prompt. Repair at the source: a field is
withheld whole, or a drug moves to pick_drug. No character inside a posted string is ever deleted.

  R1-1 posted-field check   every gp_extraction string matching WITHHOLD (placeholders, dict reprs, missing-value words,
                            FRX-N1 d1/d4/d5) is withheld whole, with one provenance item flagged field_withheld.
  R1-2 medicine floor       a medicine stays only if heard_in_room and a doctor evidence quote names it (see name_on_tape).
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
from .note import combination_groups, flags_by_pointer, medication_floor, scrub_identity
from .recover import _demote_medicine, _kept_out
from .validate import _D1, _D5, _d4, V, check, printable_errors

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


def withhold_reason(s: str, section: str = "") -> str | None:
    """Why the posted string `s` must be withheld, or None. NFKC first, as printable_errors does. The d1 / d4 / d5 patterns
    are validate.py's own (_D1, _d4, _D5), applied to every gp_extraction section."""
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
    if _MISSING.search(t):
        return "missing"
    if _D1.search(t):
        return "d1"
    if _d4(t, _D4_SEC.get(section, "")):
        return "d4"
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


def _withheld_item(art: dict, kind: str, section: str, owner: dict | None) -> dict:
    """The ONE provenance item for a withheld field. It carries the owner's evidence when there is one."""
    src = ((art.get("encounter") or {}).get("transcript") or {}).get("speaker_source")
    ev = copy.deepcopy(owner.get("evidence") or []) if owner else []
    item = {
        "item_id": _new_id(art, "r1w"), "kind": kind, "text": f"{section} withheld (placeholder)",
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
        _demote_medicine(art, i)
        if owner is None:
            owner = _kept_out(art, "medicine", f"{label} (not on tape)")
        if idxs[i]:
            owner["text"] = idxs[i][:300]
        art.setdefault("completion_required", []).append(
            {"kind": "pick_drug", "item_id": owner["item_id"], "prompt": PICK_PROMPT, "detail": label[:200]})
        moved += 1
    return moved


def r1_posted_fields(art: dict, c: dict) -> None:
    """R1-1. Withhold every posted string that matches the set. An optional field is removed; a required field (a list row's
    name / raw_name / diagnosis / speciality) takes the whole row out (a medicine to pick_drug); a scalar section is removed and
    its owner kept out. One provenance item flagged field_withheld per withheld field."""
    gx = art.get("gp_extraction")
    if not isinstance(gx, dict):
        return
    hits = posted_hits(gx)
    rows: dict[tuple, set[int]] = {}
    pops: list[tuple] = []
    for path in hits:
        lp = next((k for k in LISTS if path[:len(k)] == k and len(path) > len(k)), None)
        if lp is not None:
            kind, required = LISTS[lp]
            idx = path[len(lp)]
            owner = (_owners(art, _ptr(lp + (idx,))) or [None])[0]
            _withheld_item(art, kind, lp[-1], owner)
            c["r1_1_withheld"] += 1
            if len(path) == len(lp) + 1 or path[len(lp) + 1] in required:
                rows.setdefault(lp, set()).add(idx)
            else:
                pops.append(path)
            continue
        kind, ptr = SCALARS.get(path, (_TOP_KIND.get(str(path[0]), "management_plan"), None))
        owner = (_owners(art, ptr) or [None])[0] if ptr else (_owners(art, "/" + str(path[0])) or [None])[0]
        _withheld_item(art, kind, str(path[-1]) if path in SCALARS else str(path[0]), owner)
        c["r1_1_withheld"] += 1
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
            c["r1_1_rows_removed"] += _to_pick_drug(art, {i: None for i in drop})
        else:
            _drop_rows(art, lp, drop)
            c["r1_1_rows_removed"] += len(drop)


# --- R1-2 -----------------------------------------------------------------------------------------------------
_NAME_STOP = {"mg", "mcg", "ml", "gm", "iu", "unit", "units", "tab", "tabs", "tablet", "tablets", "cap", "caps", "capsule",
              "capsules", "syp", "syrup", "inj", "injection", "cream", "gel", "drops", "drop", "ointment", "lotion", "spray",
              "and", "plus", "with", "oral", "suspension", "solution", "the", "for"}
_WORD = re.compile(r"[^\W\d_]+")


def _words(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text or "")]


def drug_words(m: dict) -> set[str]:
    """The words of a medicine's name, raw_name and aliases that identify it: letters only, 3+ letters, no unit / form / joiner."""
    names = [m.get("name"), m.get("raw_name")] + list(m.get("aliases") or [])
    return {w for n in names if isinstance(n, str) for w in _words(n) if len(w) >= 3 and w not in _NAME_STOP}


def word_matches(w: str, q: str) -> bool:
    """Exact (case-insensitive, whole word), or both words 6+ letters with the same first 5 letters."""
    return w == q or (len(w) >= 6 and len(q) >= 6 and w[:5] == q[:5])


def name_on_tape(m: dict, owner: dict | None) -> bool:
    """R1-2. Medicine `m` stays posted only if BOTH:
      (a) its provenance owner (json_pointer /medicines/<i>) has evidence_state heard_in_room; and
      (b) at least one evidence entry with speaker == "doctor" has a quote_en or quote containing a drug word of the name,
          raw_name or an alias (drug_words).
    Matching is case-insensitive on whole words (a word is a run of letters, so "Amoxicillin," and "AMOXICILLIN" match
    "amoxicillin"). Fallback for words of 6 or more letters: a drug word and a quote word that are BOTH 6+ letters match when
    their first 5 letters agree ("amoxicillin" / "amoxil", "cetirizine" / "cetiriz"), in either direction.
    Any other speaker, or no owner, and the drug does not post."""
    if not owner or owner.get("evidence_state") != "heard_in_room":
        return False
    want = drug_words(m)
    if not want:
        return False
    for ev in owner.get("evidence") or []:
        if not isinstance(ev, dict) or ev.get("speaker") != "doctor":
            continue
        for k in ("quote_en", "quote"):
            qw = set(_words(ev.get(k) or ""))
            if any(word_matches(w, q) for w in want for q in qw):
                return True
    return False


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
_WORSE = (r"(?:worse|worsens?|worsening|increases?|increasing|goes\s+up|severe|unbearable|persists?|continues|"
          r"does\s*n[o']?t\s+(?:settle|stop|improve|reduce|go)|not\s+(?:settl|stopp|improv|reduc)\w*|keeps?\s+(?:coming|going)|"
          r"start\s+\w+ing|bleed\w*|faint\w*|breathless\w*|unconscious|fits?)")
_PLACE = r"(?:the\s+)?(?:emergency(?:\s+room|\s+department)?|casualty|er|a\s*&\s*e|hospital)"
RED_FLAG_PATTERNS = tuple(re.compile(p, re.I) for p in (
    # come (back) immediately / at once / straight away / right away
    r"\bcome\s+(?:back\s+)?(?:here\s+|to\s+" + _PLACE + r"\s+)?(?:immediately|at\s+once|straight\s*away|right\s+away|urgently)\b",
    # go / come / run / report to (the) emergency / casualty / ER
    r"\b(?:go|come|run|report|head)\s+(?:back\s+)?(?:straight\s+|directly\s+)?to\s+(?:the\s+)?(?:emergency|casualty|er|a\s*&\s*e)\b",
    # if <it gets worse | symptom increases / does not settle> ... come back / return / go to hospital
    _IF + _WORSE + r"[^.?!]{0,100}?\b(?:come\s+back|return|come\s+(?:again|to\s+" + _PLACE + r")|go\s+to\s+" + _PLACE
    + r"|rush\s+to\s+" + _PLACE + r"|see\s+(?:me|us|a\s+doctor)\s+(?:immediately|at\s+once|urgently))\b",
    # rush (him / her) to hospital
    r"\brush\s+(?:\w+\s+){0,2}?to\s+" + _PLACE + r"\b",
))
_SENT = re.compile(r"(?<=[.!?])\s+")
_TOK_STOP = {"the", "a", "an", "and", "or", "of", "to", "you", "your", "if", "it", "is", "be", "for", "in", "on", "at", "come",
             "back", "please", "do", "not", "then", "there", "any", "this", "that", "with", "start", "get", "gets"}


def _tokens(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in _TOK_STOP}


def overlap(clause: str, text: str) -> float:
    """Normalised token overlap: share of the clause's tokens (lowercase alphanumerics, stop words out) present in `text`."""
    a, b = _tokens(clause), _tokens(text)
    return len(a & b) / len(a) if a else 1.0


def red_flag_clauses(text: str) -> list[str]:
    """Sentences of `text` that carry an emergency or return instruction (RED_FLAG_PATTERNS)."""
    return [s.strip() for s in _SENT.split(text or "") if s.strip() and any(p.search(s) for p in RED_FLAG_PATTERNS)]


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
    """The note with its Medication section made deterministic (note.medication_floor). The label line is kept only when the
    artifact raises no error with it that it does not raise without it; returns (note, label_kept)."""
    flags = flags_by_pointer(art)
    banned = [n for p in art.get("provenance") or [] if not p.get("json_pointer") for n in (p.get("names") or []) if n]
    gx, groups = art.get("gp_extraction") or {}, combination_groups(art)
    bare = medication_floor(note, gx, flags, banned, groups, label=False)
    labelled = medication_floor(note, gx, flags, banned, groups, label=True)
    if labelled == bare:
        return bare, False
    a, b = dict(art), dict(art)
    a["note_text"], b["note_text"] = labelled, bare
    without = set(check(b))
    if any(e not in without for e in check(a)):
        return bare, False
    return labelled, True


def r1_pick_drug_names(art: dict) -> list[str]:
    """pick_drug details that name an R1-moved drug (their item_id is a provenance item, not a mapper slot)."""
    slots = {s.get("slot_id") for s in art.get("slots") or [] if isinstance(s, dict)}
    return [str(x.get("detail")) for x in art.get("completion_required") or []
            if isinstance(x, dict) and x.get("kind") == "pick_drug" and x.get("item_id") not in slots
            and x.get("detail") and x.get("detail") != "unnamed drug"]


def pick_drug_in_note(art: dict, note: str) -> bool:
    names = r1_pick_drug_names(art)
    return any(V.same_drug([n], [line]) for n in names for line in (note or "").split("\n") if line.strip())


# --- entry point ----------------------------------------------------------------------------------------------
COUNTERS = ("r1_1_withheld", "r1_1_rows_removed", "r1_2_moved", "r1_3_fields_removed", "r1_3_moved", "r1_4_note_rewritten",
            "r1_4_label_kept", "r1_5_detected", "r1_5_covered", "r1_5_added", "r1_5_blocked", "r1_5_non_english_skipped",
            "r1_5_no_turns")


def apply_r1(art: dict, turns: list | None = None, notes_only: bool = True) -> tuple[dict, dict]:
    """R1-1, R1-2, R1-3 and R1-5 on a copy of `art` (the input is never mutated), then R1-4 on its note_text when it has one
    (a stored artifact). `turns`: the consult's turns (ingest.Turn or dicts with role / text or quote_en / lang / idx /
    t0_ms / t1_ms); None skips R1-5. notes_only False returns an unchanged copy: R1 off is the base behaviour.
    Returns (new artifact, counters) with every key of COUNTERS, plus "notes_only"."""
    out = copy.deepcopy(art)
    c = {k: 0 for k in COUNTERS}
    c["notes_only"] = bool(notes_only)
    if not notes_only:
        return out, c
    r1_posted_fields(out, c)
    r1_medicine_floor(out, c)
    r1_dose_floor(out, c)
    r1_red_flags(out, turns, c)
    if isinstance(out.get("note_text"), str) and out["note_text"].strip():
        note, kept = notes_only_note(out, out["note_text"])
        c["r1_4_note_rewritten"] = int(note != out["note_text"])
        c["r1_4_label_kept"] = int(kept)
        out["note_text"] = note
    return out, c
