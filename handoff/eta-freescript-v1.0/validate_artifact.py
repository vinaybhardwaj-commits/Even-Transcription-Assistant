#!/usr/bin/env python3
"""Validate eta.freescript.v1.0 artifacts: JSON Schema (draft-07) plus the cross-field guarantees V1-V16 the schema
cannot express. Usage: validate_artifact.py FILE... ; exit 1 on any failure. Every failure line names its rule
(V0 = schema). Stdlib plus jsonschema only; curated lists are read from data/."""
import difflib, json, os, re, sys, unicodedata
from datetime import datetime
import jsonschema

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = json.load(open(os.path.join(HERE, "eta-freescript-artifact.v1.0.schema.json"), encoding="utf-8"))


def _data(name):
    return json.load(open(os.path.join(HERE, "data", name), encoding="utf-8"))


LASA_PAIRS = [tuple(p) for p in _data("lasa_pairs.json")["pairs"]]
_QW = _data("qualifier_words.json")
QUALIFIERS, FORM_WORDS, UNIT_WORDS = set(_QW["words"]), set(_QW["form_words"]), set(_QW["unit_words"])
BRAND_MAP = _data("brand_generic_min.json")["entries"]
_N1 = _data("frx_n1_phrases.json")
N1_ANY = [(p["id"], re.compile(p["regex"])) for p in _N1["anywhere"]]
N1_ORDER = [(p["id"], re.compile(p["regex"])) for p in _N1["order_sections_only"]]
N1_SECTIONS = set(_N1["order_sections"])
FILLER = re.compile(_N1["filler_line"])

HEADINGS = ["Co-morbidities", "Presenting Complaint", "Examination", "Diagnoses", "Plan of Management",
            "Surgery or Procedure", "Medication", "Further Investigation", "Follow up", "Refer to", "General Advice"]
LISTS = {  # gp_extraction list path -> provenance kind
    "/medicines": "medicine", "/further_investigations": "investigation", "/comorbidities": "comorbidity",
    "/referrals": "referral", "/presenting_complaints/diagnoses": "diagnosis",
    "/plan_of_management/surgery_or_procedure_recommendations": "procedure"}
ORDER_LISTS = {  # provenance kind -> (gp_extraction list, note heading)
    "medicine": ("/medicines", "Medication"),
    "investigation": ("/further_investigations", "Further Investigation"),
    "procedure": ("/plan_of_management/surgery_or_procedure_recommendations", "Surgery or Procedure"),
    "referral": ("/referrals", "Refer to"),
}
ORDER_KINDS = set(ORDER_LISTS)
DRAFT_LINE = "Draft list, not a prescription; the treating doctor checks each drug."
PLAN_LINE = "Medication changes discussed: see the confirm list."
HELD_ACTIONS = {"stop", "hold", "not_given"}
LISTED_ACTIONS = {"start", "continue"}
DOCTOR_ROLES = {"treating_doctor", "other_clinician"}
NEVER_CAPABLE = {"translator", "staff", "attender", "patient"}
SEG_COS = 0.65
BAD_MODEL_IDS = {"", "none", "unknown", "n/a", "na", "tbd", "null"}


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
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split())


_TOK = re.compile(r"[^\W\d_]+|\d+(?:\.\d+)?")


def toks(text):
    """Lowercase NFKC tokens: letter runs and digit runs apart ("Dolo-650" -> dolo, 650)."""
    return _TOK.findall(unicodedata.normalize("NFKC", text or "").lower())


def alpha_toks(text):
    return [t for t in toks(text) if not t[0].isdigit() and t not in FORM_WORDS and t not in UNIT_WORDS]


def strip_qualifiers(text):
    """Base form: letters only, form/unit/qualifier words removed. A phrase that is all qualifiers keeps its whole
    phrase ("vitamin d3"), which then only matches as that whole phrase."""
    a = alpha_toks(text)
    base = [t for t in a if t not in QUALIFIERS]
    return " ".join(base) if base else " ".join(t for t in toks(text) if t not in FORM_WORDS and t not in UNIT_WORDS)


def name_key(text):
    """Joined base form: 'Hydroxy Chloroquine Sulphate 200' -> 'hydroxychloroquine'."""
    return strip_qualifiers(text).replace(" ", "")


def runs(text, max_len=4):
    """Every run of 1..max_len consecutive letter tokens joined without spaces: the split-spelling normalisation.
    Whole-word by construction: a run never starts or ends inside a word."""
    a = alpha_toks(text)
    out = set()
    for i in range(len(a)):
        for j in range(i + 1, min(len(a), i + max_len) + 1):
            out.add("".join(a[i:j]))
    return out


def brand_entry(name):
    k = name_key(name)
    for e in BRAND_MAP:
        if k and (k == e["key"] or k == name_key(e["brand"])):
            return e
    return None


def med_line(d):
    """The one Medication line for a start/continue prompt: GENERIC (Brand as spoken) strength-if-heard — confirm."""
    head = d["generic"] or d["spoken"]
    parts = [head]
    if d["brand_recognised"] and d["generic"]:
        parts.append("(%s)" % d["brand_recognised"])
    s = d["strength_heard"]
    if s and not (d["brand_recognised"] and set(toks(s)) <= set(toks(d["brand_recognised"]))):
        parts.append(s)
    return " ".join(parts) + " — confirm"


def note_sections(note):
    out, cur = {}, None
    for line in (note or "").split("\n"):
        head = line.split(":", 1)[0]
        if head in HEADINGS and ":" in line:
            cur = head
            out[cur] = [line.split(":", 1)[1].strip()]
        elif cur:
            out[cur].append(line.strip())
    return {k: [x for x in v if x] for k, v in out.items()}


def advice_items(s):
    return [x for x in re.split(r"(?<=[.!])\s+", (s or "").strip()) if x]


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
    """v0.1 G3 match, unchanged: normalised substring either way, or any significant name-token pair at
    SequenceMatcher ratio >= 0.85 (names only, never free text)."""
    na = [norm(x) for x in list(names_a) + list(text_a) if x and x.strip()]
    nb = [norm(x) for x in names_b if x and x.strip()]
    if any(x and y and (x in y or y in x) for x in na for y in nb):
        return True
    ta, tb = name_tokens(names_a), name_tokens(names_b)
    return any(difflib.SequenceMatcher(None, x, y).ratio() >= ratio for x in ta for y in tb)


def entry_names(m):
    return [x for x in [m.get("name", ""), m.get("raw_name", ""), m.get("speciality", "")] + list(m.get("aliases") or []) if x]


def held_names(prov_item, prompt):
    """Every name a held (stop / hold / not_given) order can be written under."""
    names = list(prov_item.get("names") or []) + [prov_item.get("text", "")] if prov_item else []
    if prompt:
        if prompt.get("name"):
            names.append(prompt["name"])
        d = prompt.get("drug")
        if d:
            names += [d["spoken"], d["brand_recognised"], d["generic"]] + list(d["components"]) + d["base_molecule"].split("+")
    generics = set()
    for n in list(names):
        e = brand_entry(n or "")
        if e:
            generics.add(e["generic"])
    if prompt and prompt.get("drug") and prompt["drug"]["generic"]:
        generics.add(prompt["drug"]["generic"])
    for e in BRAND_MAP:  # every brand of the same molecule set, attested or guard-only
        if e["generic"] in generics:
            names += [e["brand"], e["key"]]
    return [n for n in names if n and n.strip()]


def parse_dt(v):
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


def value_heard(value, quotes):
    """Every digit token and every letter token of 3+ letters in the attribute value occurs in the given quotes."""
    want = [t for t in toks(value) if t[0].isdigit() or len(t) >= 3]
    have = set(t for q in quotes for t in toks(q))
    return bool(want) and all(t in have for t in want)


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
    sec = note_sections(note) if isinstance(note, str) else {}
    qa = a["qa"]
    notes_only = a["policy"]["medicine_policy"] == "notes_only"

    def role_of(sid):
        s = spans.get(sid)
        return roster[s["label"]]["role"] if s and s["label"] in roster else None

    def capable(sid):
        return sid in spans and spans[sid]["order_capable"]

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
    ids = [p["item_id"] for p in prov]
    if len(ids) != len(set(ids)):
        E("V2 duplicate provenance item_id")
    for path, kind in LISTS.items():
        for i, _ in enumerate(list_at(gx, path)):
            ptr = "%s/%d" % (path, i)
            if ptr not in pointed:
                E("V2 gp_extraction%s has no provenance item" % ptr)
            else:
                k = next(p["kind"] for p in prov if p["json_pointer"] == ptr)
                if k != kind:
                    E("V2 %s kind %s != expected %s" % (ptr, k, kind))
    for path in ["/examination", "/general_advice", "/presenting_complaints/symptoms", "/plan_of_management/management_plan", "/follow_up"]:
        try:
            v = pointer_get(gx, path)
        except (KeyError, IndexError):
            continue
        if has_content(v) and path not in pointed:
            E("V2 gp_extraction%s has no provenance item" % path)
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

    # V3 held-out orders never in their gp_extraction list under any held name (v0.1 G3)
    held = []
    for p in prov:
        pr = pr_by_id.get(p["prompt_id"]) if p["prompt_id"] else None
        if p["kind"] in ORDER_KINDS and (p["status"] in ("stopped", "not_given") or (pr and pr["action"] in HELD_ACTIONS)):
            held.append((p, pr))
    for p, pr in held:
        path = ORDER_LISTS[p["kind"]][0]
        for i, m in enumerate(list_at(gx, path)):
            if same_drug(held_names(p, pr), entry_names(m), text_a=[p["text"]]):
                E("V3 %s: %s %s matches gp_extraction%s/%d" % (p["item_id"], p["status"], p["kind"], path, i))

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

    # V6 one line per order entry; Medication holds only the draft line and one line per start/continue prompt
    if isinstance(note, str):
        for kind, (path, heading) in ORDER_LISTS.items():
            if kind == "medicine":
                continue
            entries, lines_h = list_at(gx, path), sec.get(heading, [])
            if len(lines_h) != len(entries):
                E("V6 note %s has %d lines but gp_extraction%s has %d entries" % (heading, len(lines_h), path, len(entries)))
            else:
                for i, (line, m) in enumerate(zip(lines_h, entries)):
                    if not same_drug(entry_names(m), [line]):
                        E("V6 note %s line %d does not name gp_extraction%s/%d" % (heading, i, path, i))
        listed = [p for p in prompts if p["kind"] == "medicine" and p["action"] in LISTED_ACTIONS]
        want_lines = ([DRAFT_LINE] + [med_line(p["drug"]) for p in listed]) if listed else []
        got = sec.get("Medication", [])
        if got != want_lines:
            E("V6 note Medication lines %r != expected %r" % (got, want_lines))

    # V7 notes_only: no posted medicine; every medicine provenance has a prompt
    if list_at(gx, "/medicines"):
        E("V7 gp_extraction.medicines is not empty under medicine_policy=%s" % a["policy"]["medicine_policy"]
          + ("" if notes_only else " (taped_draft posting is not enabled in v1.0)"))
    for p in prov:
        if p["kind"] == "medicine" and not p["prompt_id"]:
            E("V7 %s: medicine provenance has no prompt_id" % p["item_id"])
    for pr in prompts:
        if pr["kind"] == "medicine" and notes_only and "notes_only" not in pr["doctor_confirm_reason"]:
            E("V7 %s: medicine prompt lacks the notes_only reason" % pr["prompt_id"])

    # V8 support: posted items and supported attributes stand on order-capable (orders) or doctor (notes) spans
    for p in prov:
        if p["json_pointer"] is None:
            continue
        if p["support"] != "supported":
            E("V8 %s: posted with support=%s" % (p["item_id"], p["support"]))
        if p["kind"] in ORDER_KINDS:
            if not any(capable(s) for s in p["cited_spans"]):
                E("V8 %s: posted %s cites no order-capable span" % (p["item_id"], p["kind"]))
        elif not any(capable(s) or role_of(s) in DOCTOR_ROLES for s in p["cited_spans"]):
            E("V8 %s: posted %s cites no doctor span" % (p["item_id"], p["kind"]))
    for pr in prompts:
        for name, at in pr["attributes"].items():
            if at["support"] == "supported":
                caps = [spans[s]["quote_en"] for s in at["cited_spans"] if capable(s)]
                if not caps:
                    E("V8 %s.%s: supported but cites no order-capable span" % (pr["prompt_id"], name))
                elif at["value"] is None or not value_heard(at["value"], caps):
                    E("V8 %s.%s: supported value is not heard on an order-capable span" % (pr["prompt_id"], name))
            if at["support"] == "not_stated" and at["value"] is not None:
                E("V8 %s.%s: value present but support=not_stated" % (pr["prompt_id"], name))
        if pr["who_said"]["role"] == "translator" and any(at["support"] == "supported" for at in pr["attributes"].values()):
            E("V8 %s: a translator-originated order has supported attributes" % pr["prompt_id"])
    for w in a["doctor_words"]:
        if not any(capable(s) for s in w["cited_spans"]):
            E("V8 %s: doctor_words cites no order-capable span" % w["instruction_id"])
    for sid, s in spans.items():
        if s["relay_of"] is not None:
            if s["label"] not in roster or roster[s["label"]]["role"] != "translator":
                E("V8 %s: relay_of set on a non-translator span" % sid)
            elif not capable(s["relay_of"]):
                E("V8 %s: relays %s, which is not an order-capable span" % (sid, s["relay_of"]))
    for f in ("untaped_drugs", "invented_doses", "dose_precedence_errors"):
        if qa["floors"][f] != 0:
            E("V8 qa.floors.%s=%d, floor is 0" % (f, qa["floors"][f]))

    # V9 no held order named anywhere in note_text (base molecule, brand, generic, alias, split spelling)
    if isinstance(note, str):
        note_runs = runs(note)
        for p, pr in held:
            for n in held_names(p, pr):
                k = name_key(n)
                if len(k) >= 3 and k in note_runs:
                    E("V9 %s: held %s named in note_text as '%s'" % (p["item_id"], p["kind"], n))
                    break
        if any(pr["kind"] == "medicine" and pr["action"] in HELD_ACTIONS for pr in prompts) and PLAN_LINE not in " ".join(sec.get("Plan of Management", [])):
            E("V9 Plan of Management lacks '%s'" % PLAN_LINE)

    # V10 red flags first in General Advice, never trimmed; the rest within budget
    items = advice_items(gx.get("general_advice", ""))
    rfs = a["red_flags"]
    for i, f in enumerate(rfs):
        if i >= len(items) or items[i] != f["text_en"]:
            E("V10 red flag %d is not at position %d of general_advice" % (i, i))
        if not any(role_of(s) in DOCTOR_ROLES for s in f["cited_spans"]):
            E("V10 red flag %d cites no doctor span" % i)
    rest = items[len(rfs):]
    bud = a["policy"]["advice_budget"]
    if len(rest) > bud["items"] or len(" ".join(rest)) > bud["chars"]:
        E("V10 general_advice beyond red flags has %d items / %d chars, budget %d / %d" % (len(rest), len(" ".join(rest)), bud["items"], bud["chars"]))
    if isinstance(note, str) and " ".join(sec.get("General Advice", [])) != gx.get("general_advice", ""):
        E("V10 note General Advice differs from gp_extraction.general_advice")
    if qa["floors"]["red_flags_missing"] != 0:
        E("V10 qa.floors.red_flags_missing=%d, floor is 0" % qa["floors"]["red_flags_missing"])

    # V11 no placeholder, bracket, repr, missing-value-only value or FRX-N1 phrase
    for path, v in walk_strings(gx):
        if FILLER.match(v):
            E("V11 gp_extraction%s is a missing-value-only value" % path)
        for rid, rx in N1_ANY:
            if rx.search(v):
                E("V11 gp_extraction%s carries FRX-N1 %s" % (path, rid))
    if isinstance(note, str):
        nfkc = unicodedata.normalize("NFKC", note)
        if any(unicodedata.category(c) in ("Ps", "Pe") and c not in "()" for c in nfkc):
            E("V11 note_text contains a bracket")
        cur = None
        for line in nfkc.split("\n"):
            head, sep, body = line.partition(":")
            if sep and head in HEADINGS:
                cur = head
            else:
                body = line
            where = cur or "un-headed line"
            if body.strip() and FILLER.match(body):
                E("V11 note %s: filler line body" % where)
            t = body.strip()
            if cur == "Diagnoses" and t.startswith("?"):
                t = t[1:]
            if "?" in t:
                E("V11 note %s: '?' outside the Diagnoses differential prefix" % where)
            for rid, rx in N1_ANY:
                if rx.search(body):
                    E("V11 note %s: FRX-N1 %s" % (where, rid))
            if cur in N1_SECTIONS:
                for rid, rx in N1_ORDER:
                    if rx.search(body):
                        E("V11 note %s: FRX-N1 %s" % (where, rid))
    if qa["floors"]["placeholders"] != 0:
        E("V11 qa.floors.placeholders=%d, floor is 0" % qa["floors"]["placeholders"])

    # V12 span ids resolve; cited spans inside the window and not boundary-quarantined
    w0, w1 = parse_dt(a["encounter"]["window_start"]), parse_dt(a["encounter"]["window_end"])
    cited = [(p["item_id"], s) for p in prov for s in p["cited_spans"]]
    cited += [("%s.%s" % (pr["prompt_id"], n), s) for pr in prompts for n, at in pr["attributes"].items() for s in at["cited_spans"]]
    cited += [(w["instruction_id"], s) for w in a["doctor_words"] for s in w["cited_spans"]]
    cited += [("red_flag", s) for f in rfs for s in f["cited_spans"]]
    for w in a["doctor_words"]:
        if w["superseded_by"] is not None and w["superseded_by"] not in {x["instruction_id"] for x in a["doctor_words"]}:
            E("V12 %s: superseded_by %s does not resolve" % (w["instruction_id"], w["superseded_by"]))
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

    # V13 roster consistency (design section 2)
    gate, case7 = qa["inputs"]["armc_gate"], qa["inputs"]["case7"]
    armc_on = gate == "on" and not case7
    for r in a["roster"]:
        v = r["role_votes"]
        if r["armc"]["gate_flag"] != gate:
            E("V13 %s: armc.gate_flag %s != qa.inputs.armc_gate %s" % (r["label"], r["armc"]["gate_flag"], gate))
        if r["three_of_three"] != (v["role_track"] == v["clef"] == v["jev"] == "treating_doctor"):
            E("V13 %s: three_of_three does not match the role votes" % r["label"])
        if r["armc"]["state"] == "pass" and not r["voiceprint_match"]:
            E("V13 %s: armc pass without a voiceprint match" % r["label"])
        if case7 and (r["voiceprint_match"] or r["armc"]["state"] != "off"):
            E("V13 %s: case7 (no voiceprint) but arm (c) is not off" % r["label"])
        if r["order_capable"] and r["role"] in NEVER_CAPABLE:
            E("V13 %s: %s label is order-capable" % (r["label"], r["role"]))
        if r["translator_of"] is not None and r["role"] != "translator":
            E("V13 %s: translator_of set on a %s label" % (r["label"], r["role"]))
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
    exp = {l for l in exp if roster[l]["role"] not in NEVER_CAPABLE}
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
    lasa_names = {x for pair in LASA_PAIRS for x in pair}
    for pr in prompts:
        d = pr.get("drug")
        if not d:
            continue
        pid = pr["prompt_id"]
        if d["generic"]:
            want_base = " + ".join(strip_qualifiers(c) for c in d["components"]) if d["components"] else strip_qualifiers(d["generic"])
            if d["base_molecule"] != want_base:
                E("V14 %s: base_molecule '%s' != '%s' (generic with salt and qualifier words stripped)" % (pid, d["base_molecule"], want_base))
            if not any(t not in QUALIFIERS for t in alpha_toks(d["generic"])):
                E("V14 %s: generic is qualifier words only" % pid)
            keys = {name_key(c) for c in d["base_molecule"].split("+")}
            if d["brand_recognised"]:
                keys.add(name_key(d["brand_recognised"]))
            e = brand_entry(d["brand_recognised"] or "") or brand_entry(d["spoken"])
            if e and e["generic"] == d["generic"]:
                keys |= {e["key"], name_key(e["brand"])}
            spoken = {r_ for r_ in runs(d["spoken"]) if r_ not in QUALIFIERS}
            if not (keys - {""}) & spoken:
                E("V14 %s: spoken '%s' shares no non-qualifier word with %s" % (pid, d["spoken"], d["generic"]))
        e = brand_entry(d["brand_recognised"] or d["spoken"])
        if d["components"]:
            if not e or e["status"] != "attested" or e["components"] != d["components"]:
                E("V14 %s: combination expanded without an attested entry in the curated map" % pid)
        elif e and e["components"] and e["status"] != "attested":
            if d["generic"] is not None or "combination_unexpanded" not in pr["doctor_confirm_reason"]:
                E("V14 %s: unattested combination brand must stay combination_unexpanded with no generic" % pid)
        if d["generic"] is None and "combination_unexpanded" not in pr["doctor_confirm_reason"]:
            E("V14 %s: generic is null without combination_unexpanded" % pid)
        hit = (runs(d["generic"] or "") | runs(d["base_molecule"]) | runs(d["spoken"])) & lasa_names
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

    # V16 models read back
    served = qa["models_served"]
    if not served:
        E("V16 qa.models_served is empty")
    for m in served:
        if m.strip().lower() in BAD_MODEL_IDS:
            E("V16 qa.models_served entry '%s' is not a served model id" % m)
    gen = [m["served_model_id"] for m in a["generator"]["models"]]
    if any(m.strip().lower() in BAD_MODEL_IDS for m in gen):
        E("V16 generator.models has an entry without a served model id")
    if set(served) != set(gen):
        E("V16 qa.models_served %s != generator.models %s" % (sorted(set(served)), sorted(set(gen))))
    if qa["inputs"]["mode"] != a["policy"]["inputs_mode"]:
        E("V16 qa.inputs.mode %s != policy.inputs_mode %s" % (qa["inputs"]["mode"], a["policy"]["inputs_mode"]))
    if not qa["floors"]["validator_pass"]:
        E("V16 qa.floors.validator_pass is false")
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
