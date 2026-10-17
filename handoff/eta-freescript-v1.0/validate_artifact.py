#!/usr/bin/env python3
"""Validate eta.freescript.v1.0 artifacts: JSON Schema (draft-07) plus the cross-field guarantees V1-V16 the schema
cannot express. Usage: validate_artifact.py FILE... ; exit 1 on any failure. Every failure line names its rule
(V0 = schema). Stdlib plus jsonschema only; curated lists are read from data/.

Every name match folds text first (fold): NFKD, accents and zero-width characters removed, casefold, Cyrillic and
Greek lookalikes mapped to Latin. Tokens split on anything that is not a letter or digit (hyphens, dots, spaces), and
three or more single letters in a row are joined ("g l i m" -> "glim"). note_text is also rendered from its sources
(render_note) and must match that rendering line for line."""
import difflib, json, os, re, sys, unicodedata
from datetime import datetime
import jsonschema

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = json.load(open(os.path.join(HERE, "eta-freescript-artifact.v1.0.schema.json"), encoding="utf-8"))


def _data(name):
    return json.load(open(os.path.join(HERE, "data", name), encoding="utf-8"))


# ---------- folding and tokens ----------
_HOMO = str.maketrans({
    # Cyrillic
    "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
    "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w",
    "ɡ": "g", "ь": "b", "п": "n", "г": "r", "з": "3",
    # Greek
    "α": "a", "β": "b", "γ": "y", "ε": "e", "ζ": "z", "η": "n", "ι": "i", "κ": "k", "μ": "u", "ν": "v", "ο": "o",
    "ρ": "p", "σ": "o", "ς": "c", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
    # Latin lookalikes
    "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŀ": "l",
})


def fold(text):
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(c for c in t if not unicodedata.combining(c) and unicodedata.category(c) != "Cf")
    return t.casefold().translate(_HOMO)


_TOK = re.compile(r"[^\W\d_]+|\d+(?:\.\d+)?")


def toks(text):
    """Folded tokens: letter runs and digit runs apart ("Dolo-650" -> dolo, 650); 3+ single letters joined."""
    out, buf = [], []
    for t in _TOK.findall(fold(text)):
        if len(t) == 1 and t.isalpha():
            buf.append(t)
            continue
        out += ["".join(buf)] if len(buf) >= 3 else buf
        buf = []
        out.append(t)
    out += ["".join(buf)] if len(buf) >= 3 else buf
    return out


LASA_PAIRS = [tuple(p) for p in _data("lasa_pairs.json")["pairs"]]
_QW = _data("qualifier_words.json")
QUALIFIERS, FORM_WORDS, UNIT_WORDS = set(_QW["words"]), set(_QW["form_words"]), set(_QW["unit_words"])
BRAND_MAP = _data("brand_generic_min.json")["entries"]
_MN = _data("medicine_names_min.json")
CONDITION_CONTEXT = set(_MN["condition_context"])
SALT_PHRASES = sorted({tuple(toks(s)) for s in _data("salt_drugs.json")["drugs"]}, key=len, reverse=True)
_N1 = _data("frx_n1_phrases.json")
N1_ANY = [(p["id"], re.compile(p["regex"])) for p in _N1["anywhere"]]
N1_ORDER = [(p["id"], re.compile(p["regex"])) for p in _N1["order_sections_only"]]
N1_MED = [(p["id"], re.compile(p["regex"])) for p in _N1["d4_medication_only"]]
N1_SECTIONS = set(_N1["order_sections"])
D4_FIELDS, D4_MISSING = set(_N1["d4_fields"]), set(_N1["d4_missing"])
FILLER = re.compile(_N1["filler_line"])
EN_WORDS = set(_data("english_words_min.json")["words"])
_DP = _data("dose_patterns.json")
DOSE_RX = [(p["id"], re.compile(p["regex"].replace("{N}", _DP["number"])), p.get("history_exempt", False)) for p in _DP["patterns"]]
HISTORY_PATHS = re.compile(_DP["history_paths"])
ORDER_VERBS, SKIP_WORDS = set(_DP["order_verbs"]), set(_DP["skip_words"])
_CR = _data("copy_rules.json")
NEGATORS, NEG_SUFFIX, ACTION_WORDS = set(_CR["negators"]), _CR["negator_suffix"], set(_CR["action_words"])

HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
            "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"]
LISTS = {  # gp_extraction list path -> provenance kind
    "/medicines": "medicine", "/further_investigations": "investigation", "/comorbidities": "comorbidity",
    "/referrals": "referral", "/presenting_complaints/diagnoses": "diagnosis",
    "/plan_of_management/surgery_or_procedure_recommendations": "procedure"}
SCALARS = {"/examination": "examination", "/general_advice": "advice", "/presenting_complaints/symptoms": "symptoms",
           "/plan_of_management/management_plan": "management_plan", "/follow_up": "follow_up"}
ORDER_LISTS = {  # provenance kind -> (gp_extraction list, note heading)
    "medicine": ("/medicines", "Medication"),
    "investigation": ("/further_investigations", "Further Investigation"),
    "procedure": ("/plan_of_management/surgery_or_procedure_recommendations", "Surgery or Procedure"),
    "referral": ("/referrals", "Refer to"),
}
ORDER_KINDS = set(ORDER_LISTS)
CONDITION_PATHS = re.compile(r"^/(presenting_complaints/diagnoses/\d+/(diagnosis_or_impression|raw_name|aliases/\d+)"
                             r"|comorbidities/\d+/(name|raw_name|notes|aliases/\d+))$")
DRAFT_LINE = "Draft list, not a prescription; the treating doctor checks each drug."
PLAN_LINE = "Medication changes discussed: see the confirm list."
CONFIRM_TAIL = " — confirm"
CHANGE_TAIL = " — dose change discussed"
HELD_ACTIONS = {"stop", "hold", "not_given"}
LISTED_ACTIONS = {"start", "continue", "change_dose"}
TD = "treating_doctor"
DOCTOR_ROLES = {TD, "other_clinician"}
NEVER_CAPABLE = {"translator", "staff", "attender", "patient"}
ADVICE_CATS = {"lifestyle", "diet", "warning", "counselling", "test_prep", "other"}
SEG_COS = 0.65
FUZZY = 0.85
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,}$")
BAD_MODEL_IDS = {"none", "null", "unknown", "n/a", "na", "tbd", "default", "model", "auto", "latest", "placeholder", "any"}


def alpha_toks(text):
    return [t for t in toks(text) if not t[0].isdigit() and t not in FORM_WORDS and t not in UNIT_WORDS]


def base_of(text):
    """Base molecule: a salt drug keeps its whole phrase ("folic acid"); otherwise letters only with form, unit and
    qualifier words removed. A phrase that is all qualifiers keeps its whole phrase."""
    a = alpha_toks(text)
    for ph in SALT_PHRASES:
        for i in range(len(a) - len(ph) + 1):
            if tuple(a[i:i + len(ph)]) == ph:
                return " ".join(ph)
    base = [t for t in a if t not in QUALIFIERS]
    return " ".join(base or a)


strip_qualifiers = base_of


def name_key(text):
    """Joined base form: 'Hydroxy Chloroquine Sulphate 200' -> 'hydroxychloroquine'; 'Folic acid 5' -> 'folicacid'."""
    return base_of(text).replace(" ", "")


def runs(text, max_len=6):
    """Every run of 1..max_len consecutive letter tokens joined without spaces: the split-spelling normalisation.
    Whole-word by construction: a run never starts or ends inside a word."""
    a = alpha_toks(text)
    return {"".join(a[i:j]) for i in range(len(a)) for j in range(i + 1, min(len(a), i + max_len) + 1)}


def edit1(a, b):
    """Levenshtein distance <= 1."""
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = 0
    while i < len(a) and a[i] == b[i]:
        i += 1
    return a[i:] == b[i + 1:] or (len(a) == len(b) and a[i + 1:] == b[i + 1:])


def fuzzy_hit(key, rs):
    """Close misspelling of a held name: ratio >= 0.85 for keys of 6+ letters, edit distance 1 for keys of 4-5 letters.
    A common English word is never a misspelling ('and' is not 'pand')."""
    rs = [r for r in rs if r not in EN_WORDS]
    if len(key) >= 6:
        return any(abs(len(r) - len(key)) <= 3 and difflib.SequenceMatcher(None, key, r).ratio() >= FUZZY for r in rs)
    if len(key) >= 4:
        return any(r != key and edit1(key, r) for r in rs)
    return False


def brand_entry(name):
    k = name_key(name or "")
    for e in BRAND_MAP:
        if k and (k == e["key"] or k == name_key(e["brand"])):
            return e
    return None


def shown_value(p):
    """The value a Medication line may show, supported on the treating doctor's span (V8 checks the support).
    change_dose shows only the NEW dose (the dose attribute), never the old strength; unsupported means no number."""
    at = p["attributes"]
    if p["action"] == "change_dose":
        return at["dose"]["value"] if at["dose"]["support"] == "supported" else None
    return at["strength"]["value"] if at["strength"]["support"] == "supported" else None


def med_line(p):
    """One Medication line: GENERIC (Brand as spoken) supported-strength — confirm; change_dose adds
    ' — dose change discussed' before ' — confirm'."""
    d = p["drug"]
    parts = [d["generic"] or d["spoken"]]
    if d["brand_recognised"] and d["generic"]:
        parts.append("(%s)" % d["brand_recognised"])
    s = shown_value(p)
    if s and not (d["brand_recognised"] and set(toks(s)) <= set(toks(d["brand_recognised"]))):
        parts.append(s)
    return " ".join(parts) + (CHANGE_TAIL if p["action"] == "change_dose" else "") + CONFIRM_TAIL


def render_sections(a):
    g, s = a.get("gp_extraction") or {}, {h: [] for h in HEADINGS}
    for m in g.get("comorbidities", []):
        du = m.get("duration")
        s["Co-morbidities"].append(m["name"] + (" for %d %s" % (du["value"], du["unit"].lower()) if du else ""))
    pc = g.get("presenting_complaints", {})
    if pc.get("symptoms"):
        s["Presenting Complaint"].append(pc["symptoms"])
    if g.get("examination"):
        s["Examination"].append(g["examination"])
    for d in pc.get("diagnoses", []):
        s["Diagnoses"].append(("?" if d.get("is_differential_diagnosis") else "") + d["diagnosis_or_impression"])
    pm = g.get("plan_of_management", {})
    if pm.get("management_plan"):
        s["Plan of Management"].append(pm["management_plan"])
    for x in pm.get("surgery_or_procedure_recommendations", []):
        s["Surgery or Procedure"].append(x["name"])
    listed = [p for p in a.get("confirm_prompts", []) if p["kind"] == "medicine" and p["action"] in LISTED_ACTIONS and p.get("drug")]
    if listed:
        s["Medication"] = [DRAFT_LINE] + [med_line(p) for p in listed]
    for x in g.get("further_investigations", []):
        s["Further Investigation"].append(x["name"])
    if g.get("follow_up", {}).get("follow_up_instructions"):
        s["Follow up"].append(g["follow_up"]["follow_up_instructions"])
    for x in g.get("referrals", []):
        s["Refer to"].append(x["speciality"])
    if g.get("general_advice"):
        s["General Advice"].append(g["general_advice"])
    return s


def render_note(a):
    """The only note_text a valid artifact may carry: the 11 headings rendered from gp_extraction and confirm_prompts."""
    out = []
    for h, body in render_sections(a).items():
        out.append(("%s: %s" % (h, body[0])) if body else "%s:" % h)
        out += body[1:]
    return "\n".join(out)


def raw_sections(note):
    out, cur = {}, None
    for line in (note or "").split("\n"):
        head, sep, body = line.partition(":")
        if sep and head in HEADINGS:
            cur = head
            out.setdefault(cur, []).append(body[1:] if body.startswith(" ") else body)
        elif cur:
            out[cur].append(line)
    return {k: [x for x in v if x] for k, v in out.items()}


# ---------- shared helpers ----------
def pointer_get(doc, ptr):
    cur = doc
    for part in ptr.lstrip("/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        cur = cur[int(part)] if isinstance(cur, list) else cur[part]
    return cur


def list_at(gx, path):
    try:
        return pointer_get(gx, path)
    except (KeyError, IndexError):
        return []


def norm(s):
    return " ".join(toks(s))


def split_items(s):
    return [x.strip() for x in re.split(r"(?<=[.!;])\s+|\n", (s or "").strip()) if x.strip()]


def has_content(node):
    if isinstance(node, dict):
        return any(has_content(v) for v in node.values())
    if isinstance(node, list):
        return any(has_content(v) for v in node)
    if isinstance(node, str):
        return bool(node.strip())
    return node is not None and node is not False and node != 0


def walk_strings(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk_strings(v, "%s/%s" % (path, k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_strings(v, "%s/%d" % (path, i))
    elif isinstance(node, str):
        yield path, node


GENERIC_WORDS = set("tablet tablets capsule capsules syrup injection cream ointment powder drops spray solution suspension "
                    "once twice daily weekly night morning after before food with from this that take stop stopped".split())


def name_tokens(names):
    return {t for n in names for t in norm(n or "").split() if len(t) >= 4 and not t.isdigit() and t not in GENERIC_WORDS}


def same_drug(names_a, names_b, text_a=(), ratio=0.85):
    """v0.1 G3 match on folded text: normalised substring either way, or any significant name-token pair at
    SequenceMatcher ratio >= 0.85 (names only, never free text)."""
    na = [norm(x) for x in list(names_a) + list(text_a) if x and x.strip()]
    nb = [norm(x) for x in names_b if x and x.strip()]
    if any(x and y and (x in y or y in x) for x in na for y in nb):
        return True
    ta, tb = name_tokens(names_a), name_tokens(names_b)
    return any(difflib.SequenceMatcher(None, x, y).ratio() >= ratio for x in ta for y in tb)


def entry_names(m):
    return [x for x in [m.get("name", ""), m.get("raw_name", ""), m.get("speciality", "")] + list(m.get("aliases") or []) if x]


def drug_names(d):
    """Every name a drug block holds, with each '+' part and each component of its brand map entry."""
    names = [d["spoken"], d["brand_recognised"], d["generic"]] + list(d["components"]) + d["base_molecule"].split("+")
    names += (d["generic"] or "").split("+")
    for n in (d["spoken"], d["brand_recognised"]):
        e = brand_entry(n)
        if e:
            names += [e["brand"], e["key"], e["generic"]] + list(e["components"]) + e["generic"].split("+")
    return [n for n in names if n and n.strip()]


def held_names(prov_item, prompt):
    """Every name a held (stop / hold / not_given) order can be written under: its own names, every component and
    '+' part, every brand of the same molecule set, and every brand that contains a held molecule."""
    names = (list(prov_item.get("names") or []) + [prov_item.get("text", "")]) if prov_item else []
    if prompt:
        if prompt.get("name"):
            names.append(prompt["name"])
        if prompt.get("drug"):
            names += drug_names(prompt["drug"])
    gens = set()
    for n in list(names):
        e = brand_entry(n)
        if e:
            gens.add(name_key(e["generic"]))
            names += [e["brand"], e["key"], e["generic"]] + list(e["components"])
        gens.add(name_key(n))
    for e in BRAND_MAP:
        comps = {name_key(c) for c in e["components"]} | {name_key(e["generic"])}
        if comps & gens:
            names += [e["brand"], e["key"]]
    return [n for n in names if n and n.strip()]


def qualified_by_condition(text, key):
    """Every occurrence of the drug key sits next to a condition word that qualifies it ('insulin resistance',
    'metformin-induced', 'allergy to penicillin'); the rest of the string earns no exemption."""
    a = alpha_toks(text)
    occ = [(i, j) for i in range(len(a)) for j in range(i + 1, min(len(a), i + 6) + 1) if "".join(a[i:j]) == key]
    if not occ:
        return False
    for i, j in occ:
        after = a[j] if j < len(a) else ""
        before = a[i - 1] if i >= 1 else ""
        before2 = a[i - 2] if i >= 2 else ""
        if not (after in CONDITION_CONTEXT or before in CONDITION_CONTEXT or (before in ("to", "of") and before2 in CONDITION_CONTEXT)):
            return False
    return True


def parse_dt(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def value_heard(value, quote):
    """Every digit token and every letter token of 3+ letters in the value occurs in this one quote."""
    want = [t for t in toks(value) if t[0].isdigit() or len(t) >= 3]
    have = set(toks(quote))
    return bool(want) and all(t in have for t in want)


def _norm_ws(s):
    return " ".join(unicodedata.normalize("NFKC", s or "").replace("\u2019", "'").replace("\u2018", "'").casefold().split())


_WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")


def _negators(s):
    return [m.span() for m in _WORD.finditer(s) if m.group(0) in NEGATORS or m.group(0).endswith(NEG_SUFFIX)]


def copied_from(text, quotes, whole_sentences=False):
    """None when text is a contiguous, word-aligned substring of one quote (whitespace and case normalised; one final
    '.' or '!' may be added) and no negator of that quote falls outside the copied part; else the reason it is not.
    whole_sentences: the copied part must also start and end on sentence boundaries of the quote (no truncation)."""
    t = _norm_ws(text)
    t = t[:-1] if t[-1:] in ".!" else t
    if not t:
        return "empty text"
    why = "not a contiguous substring of any cited quote"
    for q in quotes:
        qn = _norm_ws(q)
        i = qn.find(t)
        while i >= 0:
            j = i + len(t)
            if (i == 0 or not qn[i - 1].isalnum()) and (j == len(qn) or not qn[j].isalnum()):
                outside = [s for s in _negators(qn) if s[1] <= i or s[0] >= j]
                cut = whole_sentences and not ((i == 0 or re.search(r"[.;!?]\s*$", qn[:i])) and (j == len(qn) or re.match(r"\s*[.;!?]", qn[j:])))
                if not outside and not cut:
                    return None
                why = "drops the negator '%s' of its quote" % qn[outside[0][0]:outside[0][1]] if outside else "truncates a sentence of its quote"
            i = qn.find(t, i + 1)
    return why


def dose_hits(text, history=False):
    t = unicodedata.normalize("NFKC", text or "")
    return [pid for pid, rx, hist in DOSE_RX if not (history and hist) and rx.search(t)]


def unresolved_after_verbs(text):
    """Words that follow an order verb ('start X', 'take X') and are neither English nor clinical vocabulary."""
    a = [w for w in re.findall(r"[a-z]+", fold(text))]
    out = []
    for i, w in enumerate(a):
        if w in ORDER_VERBS:
            for x in a[i + 1:i + 6]:
                if x in SKIP_WORDS:
                    continue
                if x not in EN_WORDS:
                    out.append((w, x))
                break
    return out


def d4(text, med=False):
    if med and any(rx.search(text) for _, rx in N1_MED):
        return True
    raw = re.findall(r"\w+(?:/\w+)?|\?", text.lower())
    ents = []
    for k, t in enumerate(raw):
        if t == "n/a":
            ents.append(("n/a", "n/a"))
        elif "/" in t:
            ents.extend((f, None) for f in t.split("/"))
        elif t == "na" or (t == "nil" and raw[k + 1:k + 2] == ["by"]):
            ents.append((t, None))
        else:
            ents.append((t, t))
    return any(f in D4_FIELDS and any(m in D4_MISSING for _, m in ents[max(0, i - 3):i] + ents[i + 1:i + 4]) for i, (f, _) in enumerate(ents))


def printable(text, order=False, med=False, ascii_letters=True):
    """FRX-N1 and placeholder checks on one NFKC-normalised string; returns the ids that fire."""
    t = unicodedata.normalize("NFKC", text)
    hits = []
    if "\n" in t or "\r" in t:
        hits.append("line_break")
    if any(unicodedata.category(c) == "Cf" for c in t):
        hits.append("invisible_character")
    if any(unicodedata.category(c) == "Cc" and c not in "\n\r" for c in t):
        hits.append("control_character")
    if any(unicodedata.category(c) in ("Ps", "Pe", "Pi", "Pf") and c not in "()" for c in t):
        hits.append("bracket")
    if ascii_letters and any(c.isalpha() and ord(c) > 127 for c in t):
        hits.append("non_ascii_letter")
    if t.strip() and FILLER.match(t):
        hits.append("missing_value_only")
    hits += [rid for rid, rx in N1_ANY if rx.search(t)]
    if order:
        hits += [rid for rid, rx in N1_ORDER if rx.search(t)]
        if d4(t, med):
            hits.append("d4")
    return hits


# ---------- the checks ----------
def check(a):
    errs = []
    fc = jsonschema.FormatChecker()

    @fc.checks("date-time", raises=ValueError)
    def _dt(v):
        parse_dt(v)
        return True

    for e in jsonschema.Draft7Validator(SCHEMA, format_checker=fc).iter_errors(a):
        errs.append("V0 schema: %s at /%s" % (e.message[:160], "/".join(map(str, e.path))))
    if errs:
        return errs

    E = errs.append
    gx, prov, prompts = a["gp_extraction"], a["provenance"], a["confirm_prompts"]
    spans = {s["span_id"]: s for s in a["spans"]}
    roster = {r["label"]: r for r in a["roster"]}
    pr_by_id = {p["prompt_id"]: p for p in prompts}
    withheld = a["emission"]["state"] == "withheld"
    note = a.get("note_text")
    qa = a["qa"]
    notes_only = a["policy"]["medicine_policy"] == "notes_only"
    order = sorted(a["spans"], key=lambda s: (parse_dt(s["t0"]), a["spans"].index(s)))
    gx_strings = list(walk_strings(gx))

    def role_of(sid):
        s = spans.get(sid)
        return roster[s["label"]]["role"] if s and s["label"] in roster else None

    def cap_td(sid):
        """An order may stand only on an order-capable span of the treating doctor's label."""
        return sid in spans and spans[sid]["order_capable"] and role_of(sid) == TD

    def names_in_turn(sid, keys):
        """The span, or an earlier span of the same speaker turn, names one of keys."""
        i = next(k for k, s in enumerate(order) if s["span_id"] == sid)
        lab = order[i]["label"]
        while i >= 0 and order[i]["label"] == lab:
            if keys & runs(order[i]["quote_en"]):
                return True
            i -= 1
        return False

    # V1 pointers resolve, each claimed once
    pointed = {}
    for p in prov:
        ptr = p["json_pointer"]
        if ptr is None:
            continue
        try:
            pointer_get(gx, ptr)
        except (KeyError, IndexError, ValueError, TypeError):
            E("V1 %s: json_pointer %s does not resolve in gp_extraction" % (p["item_id"], ptr))
            continue
        if ptr in pointed:
            E("V1 %s: json_pointer %s already claimed by %s" % (p["item_id"], ptr, pointed[ptr]))
        pointed[ptr] = p["item_id"]

    # V2 exactly one provenance per posted entry, prompt and item; qa.counts match
    for what, ids in (("provenance item_id", [p["item_id"] for p in prov]), ("prompt_id", [p["prompt_id"] for p in prompts]),
                      ("instruction_id", [w["instruction_id"] for w in a["doctor_words"]])):
        if len(ids) != len(set(ids)):
            E("V2 duplicate %s" % what)
    kind_at = {p["json_pointer"]: p["kind"] for p in prov if p["json_pointer"]}
    for path, kind in LISTS.items():
        for i, _ in enumerate(list_at(gx, path)):
            ptr = "%s/%d" % (path, i)
            if ptr not in pointed:
                E("V2 gp_extraction%s has no provenance item" % ptr)
            elif kind_at[ptr] != kind:
                E("V2 %s kind %s != expected %s" % (ptr, kind_at[ptr], kind))
    for path, kind in SCALARS.items():
        try:
            v = pointer_get(gx, path)
        except (KeyError, IndexError):
            continue
        if has_content(v) and path not in pointed:
            E("V2 gp_extraction%s has no provenance item" % path)
        elif path in kind_at and kind_at[path] != kind:
            E("V2 %s kind %s != expected %s" % (path, kind_at[path], kind))
    owners = {}
    for p in prov:
        if p["prompt_id"] is not None:
            if p["prompt_id"] not in pr_by_id:
                E("V2 %s: prompt_id %s does not resolve" % (p["item_id"], p["prompt_id"]))
            elif p["prompt_id"] in owners:
                E("V2 prompt %s has two provenance records" % p["prompt_id"])
            elif pr_by_id[p["prompt_id"]]["kind"] != p["kind"]:
                E("V2 %s kind %s != prompt kind %s" % (p["item_id"], p["kind"], pr_by_id[p["prompt_id"]]["kind"]))
            owners[p["prompt_id"]] = p
    for pid in pr_by_id:
        if pid not in owners:
            E("V2 prompt %s has no provenance record" % pid)
    want = dict(posted=sum(p["json_pointer"] is not None for p in prov), prompts=len(prompts),
                withheld=sum(p["withheld_reason"] is not None for p in prov),
                h_unattrib=sum(p["support"] == "h_unattrib" for p in prov),
                unaligned=sum(p["alignment"] == "unaligned" for p in prov),
                affirmed_from_patient=sum(p["support"] == "affirmed_from_patient" for p in prov))
    for k, v in want.items():
        if qa["counts"][k] != v:
            E("V2 qa.counts.%s=%d but the artifact holds %d" % (k, qa["counts"][k], v))

    # V3 held-out orders never in their gp_extraction list under any held name (v0.1 G3, on folded text)
    held = []
    for p in prov:
        pr = pr_by_id.get(p["prompt_id"]) if p["prompt_id"] else None
        if p["kind"] in ORDER_KINDS and (p["status"] in ("stopped", "not_given") or (pr and pr["action"] in HELD_ACTIONS)):
            held.append((p, pr))
    for pr in prompts:
        if pr["action"] in HELD_ACTIONS and pr["prompt_id"] not in owners:
            held.append(({}, pr))
    for p, pr in held:
        path = ORDER_LISTS[p.get("kind") or pr["kind"]][0]
        for i, m in enumerate(list_at(gx, path)):
            if same_drug(held_names(p, pr), entry_names(m), text_a=[p.get("text", "")]):
                E("V3 %s: held %s matches gp_extraction%s/%d" % (p.get("item_id") or pr["prompt_id"], p.get("kind") or pr["kind"], path, i))

    # V4 posted items carry cited spans or the no_evidence flag
    for p in prov:
        if p["json_pointer"] and not p["cited_spans"] and "no_evidence" not in p["flags"]:
            E("V4 %s: in gp_extraction without cited spans and without no_evidence flag" % p["item_id"])

    # V5 headings exactly once each, in order
    if isinstance(note, str):
        heads = [l.split(":", 1)[0] for l in note.split("\n") if re.match(r"^[A-Z][A-Za-z -]+:", l)]
        heads = [h for h in heads if h in HEADINGS or re.match(r"^[A-Z][a-z]+([ -][A-Za-z]+)*$", h)]
        if [h for h in heads if h in HEADINGS] != HEADINGS or any(h not in HEADINGS for h in heads):
            E("V5 note_text headings %s != the 11 FreeScript headings in order" % heads)

    # V6 note_text equals its rendering from gp_extraction and confirm_prompts, section by section, line by line
    if isinstance(note, str):
        want_s, got_s = render_sections(a), raw_sections(note)
        bad = [h for h in HEADINGS if got_s.get(h, []) != want_s[h]]
        for h in bad:
            E("V6 note %s lines %r differ from their source %r" % (h, got_s.get(h, [])[:4], want_s[h][:4]))
        if not bad and note != render_note(a):
            E("V6 note_text differs from its rendering outside the section bodies")

    # V7 notes_only: no posted medicine, no medicine name in any gp_extraction string; prompts only for decided drugs
    if list_at(gx, "/medicines"):
        E("V7 gp_extraction.medicines is not empty under medicine_policy=%s" % a["policy"]["medicine_policy"]
          + ("" if notes_only else " (taped_draft posting is not enabled in v1.0)"))
    for p in prov:
        if p["kind"] != "medicine":
            continue
        if p["status"] == "discussed_only":
            if p["prompt_id"]:
                E("V7 %s: a discussed_only medicine has a prompt (it lives only in provenance)" % p["item_id"])
        elif not p["prompt_id"]:
            E("V7 %s: medicine provenance has no prompt_id" % p["item_id"])
    for pr in prompts:
        if pr["kind"] == "medicine" and notes_only and "notes_only" not in pr["doctor_confirm_reason"]:
            E("V7 %s: medicine prompt lacks the notes_only reason" % pr["prompt_id"])
    med_names = list(_MN["generics"]) + [x for e in BRAND_MAP for x in [e["brand"], e["key"], e["generic"]] + e["components"]]
    med_names += [" ".join(ph) for ph in SALT_PHRASES] + [x for pair in LASA_PAIRS for x in pair]
    med_names += [n for pr in prompts if pr.get("drug") for n in drug_names(pr["drug"])]
    med_names += [n for p in prov if p["kind"] == "medicine" for n in (p.get("names") or [])]
    med_keys = {k for n in med_names for k in (name_key(x) for x in n.split("+")) if len(k) >= 3}
    if notes_only:
        for path, s in gx_strings:
            hits = med_keys & runs(s)
            if hits and CONDITION_PATHS.match(path):
                hits = {k for k in hits if not qualified_by_condition(s, k)}
            for k in sorted(hits):
                E("V7 gp_extraction%s names the medicine '%s' under notes_only" % (path, k))

    # V8 support: orders stand on the treating doctor's order-capable spans; values heard there, naming the drug
    for p in prov:
        if p["json_pointer"] is None:
            continue
        if p["support"] != "supported":
            E("V8 %s: posted with support=%s" % (p["item_id"], p["support"]))
        if p["kind"] in ORDER_KINDS:
            if not any(cap_td(s) for s in p["cited_spans"]):
                E("V8 %s: posted %s cites no order-capable span of the treating doctor" % (p["item_id"], p["kind"]))
            try:
                entry = pointer_get(gx, p["json_pointer"])
            except (KeyError, IndexError, ValueError, TypeError):
                entry = None
            if isinstance(entry, dict):
                keys = {name_key(n) for n in entry_names(entry)} - {""}
                if not any(cap_td(s) and keys & runs(spans[s]["quote_en"]) for s in p["cited_spans"]):
                    E("V8 %s: no cited order-capable span names the posted %s or an alias" % (p["item_id"], p["kind"]))
        elif not any(role_of(s) in DOCTOR_ROLES for s in p["cited_spans"]):
            E("V8 %s: posted %s cites no doctor span" % (p["item_id"], p["kind"]))
    for pr in prompts:
        who = roster.get(pr["who_said"]["label"])
        who_ok = bool(who and who["order_capable"] and who["role"] == TD)
        keys = {name_key(n) for n in (drug_names(pr["drug"]) if pr.get("drug") else [pr.get("name", "")])} - {""}
        for name, at in pr["attributes"].items():
            if at["support"] == "supported":
                if not who_ok:
                    E("V8 %s.%s: supported but who_said (%s) is not the order-capable treating doctor" % (pr["prompt_id"], name, pr["who_said"]["label"]))
                if "affirmed_from_patient" in pr["doctor_confirm_reason"]:
                    E("V8 %s.%s: supported on a patient-affirmed prompt" % (pr["prompt_id"], name))
                if at["value"] is None or not any(cap_td(s) and value_heard(at["value"], spans[s]["quote_en"]) and names_in_turn(s, keys)
                                                  for s in at["cited_spans"] if s in spans):
                    E("V8 %s.%s: value is not heard on an order-capable doctor span that names the drug" % (pr["prompt_id"], name))
            if at["support"] == "not_stated" and at["value"] is not None:
                E("V8 %s.%s: value present but support=not_stated" % (pr["prompt_id"], name))
    for w in a["doctor_words"]:
        if not any(cap_td(s) for s in w["cited_spans"]):
            E("V8 %s: doctor_words cites no order-capable span of the treating doctor" % w["instruction_id"])
    for sid, s in spans.items():
        if s["relay_of"] is not None:
            if s["label"] not in roster or roster[s["label"]]["role"] != "translator":
                E("V8 %s: relay_of set on a non-translator span" % sid)
            elif not cap_td(s["relay_of"]):
                E("V8 %s: relays %s, which is not an order-capable doctor span" % (sid, s["relay_of"]))
    for f in ("untaped_drugs", "invented_doses", "dose_precedence_errors"):
        if qa["floors"][f] != 0:
            E("V8 qa.floors.%s=%d, floor is 0" % (f, qa["floors"][f]))

    # V9 no held order named in note_text or in any gp_extraction string (folded, split, spaced, fuzzy on drugs)
    targets = ([("note_text", note)] if isinstance(note, str) else []) + [("gp_extraction" + p_, s) for p_, s in gx_strings]
    for where, text in targets:
        rs = runs(text)
        for p, pr in held:
            names = held_names(p, pr)
            keys = {name_key(n) for n in names} - {""}
            hit = sorted(k for k in keys if len(k) >= 3 and k in rs)
            is_drug = (p.get("kind") or pr["kind"]) == "medicine"
            if not hit and is_drug:
                hit = sorted(k for k in keys if len(k) >= 4 and fuzzy_hit(k, rs))
            if hit:
                E("V9 %s: held %s named in %s as '%s'" % (p.get("item_id") or pr["prompt_id"], p.get("kind") or pr["kind"], where, hit[0]))
    if isinstance(note, str) and any(pr["kind"] == "medicine" and pr["action"] in HELD_ACTIONS for pr in prompts):
        if PLAN_LINE not in " ".join(raw_sections(note).get("Plan of Management", [])):
            E("V9 Plan of Management lacks '%s'" % PLAN_LINE)

    # V10 red flags first in General Advice, never trimmed, never missing; the rest is the doctor's words within budget
    adv = gx.get("general_advice", "")
    rfs = a["red_flags"]
    prefix = " ".join(f["text_en"] for f in rfs)
    if rfs and not (adv == prefix or adv.startswith(prefix + " ")):
        E("V10 general_advice does not start with the %d red flag(s) in order" % len(rfs))
    for i, f in enumerate(rfs):
        if not any(role_of(s) in DOCTOR_ROLES for s in f["cited_spans"]):
            E("V10 red flag %d cites no doctor span" % i)
    rest = split_items(adv[len(prefix):] if rfs and adv.startswith(prefix) else adv)
    bud = a["policy"]["advice_budget"]
    if len(rest) > bud["items"] or len(" ".join(rest)) > bud["chars"]:
        E("V10 general_advice beyond red flags has %d items / %d chars, budget %d / %d" % (len(rest), len(" ".join(rest)), bud["items"], bud["chars"]))
    eligible = {fold(x) for w in a["doctor_words"] if w["final_position"] and w["category"] in ADVICE_CATS for x in split_items(w["text_en"])}
    for x in rest:
        if fold(x) not in eligible:
            E("V10 advice item '%s' is not a final doctor_words instruction" % x[:60])
    rf_texts = {fold(f["text_en"]) for f in rfs}
    missing = [w["instruction_id"] for w in a["doctor_words"] if (w["category"] == "warning" or w.get("red_flag")) and fold(w["text_en"]) not in rf_texts]
    for wid in missing:
        E("V10 %s is a warning / red flag with no red_flags entry" % wid)
    if qa["floors"]["red_flags_missing"] != len(missing):
        E("V10 qa.floors.red_flags_missing=%d but %d recomputed" % (qa["floors"]["red_flags_missing"], len(missing)))

    # V11 no placeholder, bracket, repr, missing-value-only value, FRX-N1 phrase, invisible or non-ASCII letter
    for path, v in gx_strings:
        for rid in printable(v):
            E("V11 gp_extraction%s: %s" % (path, rid))
    for pr in prompts:
        d = pr.get("drug")
        fields = ([("drug.%s" % k, d[k]) for k in ("spoken", "brand_recognised", "generic", "form", "strength_heard", "base_molecule") if d[k]]
                  + [("drug.components", c) for c in d["components"]]) if d else []
        fields += [("name", pr["name"])] if pr.get("name") else []
        fields += [("attributes.%s" % n, at["value"]) for n, at in pr["attributes"].items() if at["value"]]
        rendered = {"drug.generic", "drug.brand_recognised", "drug.strength_heard"} | ({"drug.spoken"} if d and not d["generic"] else set())
        for k, v in fields:
            for rid in printable(v, order=True, med=True, ascii_letters=k in rendered):
                E("V11 %s.%s: %s" % (pr["prompt_id"], k, rid))
    if isinstance(note, str):
        if note != unicodedata.normalize("NFKC", note):
            E("V11 note_text is not NFKC-normal")
        for h, lines in raw_sections(note).items():
            for j, body in enumerate(lines):
                is_med = h == "Medication"
                if is_med and j == 0 and body == DRAFT_LINE:
                    continue
                if is_med and body.endswith(CONFIRM_TAIL):
                    body = body[:-len(CONFIRM_TAIL)]
                t = body.strip()
                if h == "Diagnoses" and t.startswith("?"):
                    t = t[1:]
                if "?" in t:
                    E("V11 note %s: '?' outside the Diagnoses differential prefix" % h)
                for rid in printable(body, order=h in N1_SECTIONS, med=is_med):
                    E("V11 note %s: %s" % (h, rid))
    if qa["floors"]["placeholders"] != 0:
        E("V11 qa.floors.placeholders=%d, floor is 0" % qa["floors"]["placeholders"])

    # V12 span ids resolve; cited spans inside the window and not boundary-quarantined
    w0, w1 = parse_dt(a["encounter"]["window_start"]), parse_dt(a["encounter"]["window_end"])
    if len(spans) != len(a["spans"]):
        E("V12 duplicate span_id")
    cited = [(p["item_id"], s) for p in prov for s in p["cited_spans"]]
    cited += [("%s.%s" % (pr["prompt_id"], n), s) for pr in prompts for n, at in pr["attributes"].items() for s in at["cited_spans"]]
    cited += [(w["instruction_id"], s) for w in a["doctor_words"] for s in w["cited_spans"]]
    cited += [("red_flag", s) for f in rfs for s in f["cited_spans"]]
    for w in a["doctor_words"]:
        if w["superseded_by"] is not None and w["superseded_by"] not in {x["instruction_id"] for x in a["doctor_words"]}:
            E("V12 %s: superseded_by %s does not resolve" % (w["instruction_id"], w["superseded_by"]))
    for pr in prompts:
        if pr["who_said"]["label"] not in roster or roster[pr["who_said"]["label"]]["role"] != pr["who_said"]["role"]:
            E("V12 %s: who_said %s does not match the roster" % (pr["prompt_id"], pr["who_said"]["label"]))
    for sid, s in spans.items():
        if s["relay_of"] is not None and s["relay_of"] not in spans:
            E("V12 %s: relay_of %s does not resolve" % (sid, s["relay_of"]))
        if s["label"] not in roster:
            E("V12 %s: label %s is not in the roster" % (sid, s["label"]))
        if parse_dt(s["t0"]) > parse_dt(s["t1"]):
            E("V12 %s: t0 after t1" % sid)
    seen = set()
    for owner, sid in cited:
        if sid not in spans:
            E("V12 %s: cited span %s does not resolve" % (owner, sid))
            continue
        if sid in seen:
            continue
        seen.add(sid)
        s = spans[sid]
        if parse_dt(s["t0"]) < w0 or parse_dt(s["t1"]) > w1:
            E("V12 cited span %s lies outside the consult window" % sid)
        if s["boundary_quarantined"]:
            E("V12 cited span %s is boundary-quarantined" % sid)
    if qa["floors"]["clip_leakage"] != 0:
        E("V12 qa.floors.clip_leakage=%d, floor is 0" % qa["floors"]["clip_leakage"])

    # V13 roster consistency (design section 2); only the treating doctor's label may order
    gate, case7 = qa["inputs"]["armc_gate"], qa["inputs"]["case7"]
    armc_on = gate == "on" and not case7
    for r in a["roster"]:
        v = r["role_votes"]
        if r["armc"]["gate_flag"] != gate:
            E("V13 %s: armc.gate_flag %s != qa.inputs.armc_gate %s" % (r["label"], r["armc"]["gate_flag"], gate))
        if r["three_of_three"] != (v["role_track"] == v["clef"] == v["jev"] == TD):
            E("V13 %s: three_of_three does not match the role votes" % r["label"])
        if r["armc"]["state"] == "pass" and not r["voiceprint_match"]:
            E("V13 %s: armc pass without a voiceprint match" % r["label"])
        if case7 and (r["voiceprint_match"] or r["armc"]["state"] != "off"):
            E("V13 %s: case7 (no voiceprint) but arm (c) is not off" % r["label"])
        if r["order_capable"] and r["role"] != TD:
            E("V13 %s: %s label is order-capable" % (r["label"], r["role"]))
        if r["translator_of"] is not None and r["role"] != "translator":
            E("V13 %s: translator_of set on a %s label" % (r["label"], r["role"]))
    if len(roster) != len(a["roster"]):
        E("V13 duplicate roster label")
    t33 = [r for r in a["roster"] if r["three_of_three"]]
    vp = [r["label"] for r in a["roster"] if r["voiceprint_match"]]
    names = lambda r: r["armc"]["state"] == "pass"
    if not armc_on:
        exp = {t33[0]["label"]} if len(t33) == 1 else set()
    elif len(t33) == 1:
        exp = set() if any(l != t33[0]["label"] for l in vp) else {t33[0]["label"]}
    elif len(t33) >= 2:
        named = [r["label"] for r in t33 if names(r)]
        exp = {named[0]} if len(named) == 1 and all(l in {r["label"] for r in t33} for l in vp) else set()
    else:
        named = [r["label"] for r in a["roster"] if names(r)]
        exp = {named[0]} if len(named) == 1 and len(vp) <= 1 else set()
    exp = {l for l in exp if roster[l]["role"] == TD}
    actual = {r["label"] for r in a["roster"] if r["order_capable"]}
    if len(actual) > 1:
        E("V13 %d labels are order-capable: %s" % (len(actual), sorted(actual)))
    elif actual != exp:
        E("V13 order-capable labels %s != %s required by the section 2 rules" % (sorted(actual), sorted(exp)))
    for sid, s in spans.items():
        r = roster.get(s["label"])
        if not r:
            continue
        a_contrib = armc_on and names(r)
        want_src = "both" if r["three_of_three"] and a_contrib else "3of3" if r["three_of_three"] else "armc" if a_contrib else "none"
        if s["span_source"] != want_src:
            E("V13 %s: span_source %s, roster gives %s%s" % (sid, s["span_source"], want_src, "" if armc_on else " (arm (c) off)"))
        if s["order_capable"] and not r["order_capable"]:
            E("V13 %s: order-capable span on a label that is not order-capable" % sid)
        if s["order_capable"] and want_src == "armc":
            sc = s.get("segcheck")
            if not sc or sc["cos"] < SEG_COS or not sc["rank_first"]:
                E("V13 %s: armc-only span is order-capable without passing the segment check" % sid)

    # V14 drug naming: no match on a qualifier word alone; base molecule; attested combinations; LASA flagged
    lasa_names = {name_key(x) for pair in LASA_PAIRS for x in pair}
    for pr in prompts:
        d = pr.get("drug")
        if not d:
            continue
        pid = pr["prompt_id"]
        e = brand_entry(d["brand_recognised"] or "") or brand_entry(d["spoken"])
        if d["generic"]:
            parts = d["components"] or d["generic"].split("+")
            want_base = " + ".join(base_of(c) for c in parts)
            if d["base_molecule"] != want_base:
                E("V14 %s: base_molecule '%s' != '%s' (generic with salt and qualifier words stripped)" % (pid, d["base_molecule"], want_base))
            if not any(t not in QUALIFIERS for t in alpha_toks(d["generic"])) and not any(set(ph) <= set(alpha_toks(d["generic"])) for ph in SALT_PHRASES):
                E("V14 %s: generic is qualifier words only" % pid)
            keys = {name_key(c) for c in parts}
            if d["brand_recognised"]:
                keys.add(name_key(d["brand_recognised"]))
            if e and name_key(e["generic"]) == name_key(d["generic"]):
                keys |= {e["key"], name_key(e["brand"])}
            spoken = {r_ for r_ in runs(d["spoken"]) if r_ not in QUALIFIERS}
            if not (keys - {""} - QUALIFIERS) & spoken:
                E("V14 %s: spoken '%s' shares no non-qualifier word with %s" % (pid, d["spoken"], d["generic"]))
        if d["components"]:
            if not e or e["status"] != "attested" or e["components"] != d["components"]:
                E("V14 %s: combination expanded without an attested entry in the curated map" % pid)
        elif e and e["components"] and e["status"] != "attested":
            if d["generic"] is not None or "combination_unexpanded" not in pr["doctor_confirm_reason"]:
                E("V14 %s: unattested combination brand must stay combination_unexpanded with no generic" % pid)
        if d["generic"] is None and "combination_unexpanded" not in pr["doctor_confirm_reason"]:
            E("V14 %s: generic is null without combination_unexpanded" % pid)
        if d["generic"] is None and (d["lasa_risk"]["pair_with"] is None or "lasa" not in pr["doctor_confirm_reason"]):
            E("V14 %s: generic is null, so the drug must carry lasa_risk and the lasa reason" % pid)
        mapped = [e["generic"]] + e["components"] if e else []
        hit = set()
        for n in [d["generic"] or "", d["base_molecule"], d["spoken"], d["brand_recognised"] or ""] + d["components"] + mapped:
            hit |= runs(n) & lasa_names
        if d["generic"] is None and e and any(runs(x) & lasa_names for x in mapped):
            E("V14 %s: brand maps to a LASA generic, so generic may not be null" % pid)
        if hit and (d["lasa_risk"]["pair_with"] is None or "lasa" not in pr["doctor_confirm_reason"]):
            E("V14 %s: LASA-listed name %s without lasa_risk and the lasa reason" % (pid, sorted(hit)))

    # V15 emission record
    reasons = a["emission"]["reasons"]
    if withheld:
        if not reasons:
            E("V15 emission=withheld without a reason code")
        if "note_text" in a:
            E("V15 emission=withheld but note_text is present")
        if has_content(gx):
            E("V15 emission=withheld but gp_extraction is not empty")
    else:
        if reasons:
            E("V15 emission=full carries withheld reasons %s" % reasons)
        if not isinstance(note, str):
            E("V15 emission=full but note_text is absent")

    # V16 model ids: present and well-shaped (read-back from calls is a generator guarantee, not checked here)
    served = qa["models_served"]
    if not served:
        E("V16 qa.models_served is empty")
    gen = [m["served_model_id"] for m in a["generator"]["models"]]
    if not gen:
        E("V16 generator.models is empty")
    for m in served + gen:
        if not MODEL_ID.match(m) or m.strip().lower() in BAD_MODEL_IDS:
            E("V16 model id '%s' is not a served model id" % m)
    if set(served) != set(gen):
        E("V16 qa.models_served %s != generator.models %s" % (sorted(set(served)), sorted(set(gen))))
    if qa["inputs"]["mode"] != a["policy"]["inputs_mode"]:
        E("V16 qa.inputs.mode %s != policy.inputs_mode %s" % (qa["inputs"]["mode"], a["policy"]["inputs_mode"]))
    if not qa["floors"]["validator_pass"]:
        E("V16 qa.floors.validator_pass is false")

    # V17 copied text: doctor_words, advice items and red flags are contiguous substrings of a cited quote, negators kept
    for w in a["doctor_words"]:
        why = copied_from(w["text_en"], [spans[s]["quote_en"] for s in w["cited_spans"] if s in spans])
        if why:
            E("V17 %s: text_en %s" % (w["instruction_id"], why))
    for i, f in enumerate(rfs):
        why = copied_from(f["text_en"], [spans[s]["quote_en"] for s in f["cited_spans"] if s in spans], whole_sentences=True)
        if why:
            E("V17 red flag %d: %s" % (i, why))
        if not ACTION_WORDS & set(re.findall(r"[a-z]+", fold(f["text_en"]))):
            E("V17 red flag %d has no action clause (go, come, call, return ...)" % i)
    adv_quotes = [spans[s]["quote_en"] for w in a["doctor_words"] if w["final_position"] and w["category"] in ADVICE_CATS
                  for s in w["cited_spans"] if s in spans]
    for x in rest:
        why = copied_from(x.rstrip(";"), adv_quotes)
        if why:
            E("V17 advice item '%s': %s" % (x[:50], why))

    # V18 dose patterns and medicine-like mentions: no regimen text and no unresolved drug-like word in posted text
    for path, s in gx_strings:
        if path.startswith("/medicines/"):
            continue
        for pid in dose_hits(s, history=bool(HISTORY_PATHS.match(path))):
            E("V18 gp_extraction%s carries a dose pattern (%s) where no medicine may stand" % (path, pid))
        if notes_only and FORM_WORDS & set(re.findall(r"[a-z]+", fold(s))) - {"inhaler"}:
            E("V18 gp_extraction%s names a dosage form (tablet, syrup ...): a medicine-like mention" % path)
        if path in ("/plan_of_management/management_plan", "/general_advice", "/follow_up/follow_up_instructions"):
            for verb, word in unresolved_after_verbs(s):
                E("V18 gp_extraction%s: '%s %s' is a medicine-like word that resolves to no listed prompt" % (path, verb, word))
    if isinstance(note, str):
        for h, lines in raw_sections(note).items():
            if h == "Medication":
                for line in lines[1:]:
                    head = line.split(" (")[0].split(" — ")[0]
                    if not any(len(x) >= 3 for x in alpha_toks(head)):
                        E("V18 note Medication line '%s' carries no drug name" % line[:40])
                continue
            hist = h in ("Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses")
            for line in lines:
                for pid in dose_hits(line, history=hist):
                    E("V18 note %s line carries a dose pattern (%s)" % (h, pid))
    return errs


def main(paths):
    bad = 0
    for path in paths:
        errs = check(json.load(open(path, encoding="utf-8")))
        print(("OK   " if not errs else "FAIL ") + path)
        for e in errs:
            print("     " + e)
        bad += bool(errs)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
