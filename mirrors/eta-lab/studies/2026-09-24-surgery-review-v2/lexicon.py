#!/usr/bin/env python3
"""lexicon.py — booked procedure name -> SPECIFIC spoken terms (SURGERY-REVIEW-V3, truth anchor step 2).

"Keep the anchored consult only if the transcript contains the booked procedure or a spoken synonym." The words surgery / operation / procedure / package NEVER count by
themselves (Fable: "Do not use the words surgery/operation as a selection filter by themselves"): they are GENERIC and are removed before matching. A term is SPECIFIC when it
names a procedure, an organ/structure operated on, an implant, or a distinctive technique. Matching is on word PREFIXES (hysterectom-> hysterectomy/hysterectomies),
case-insensitive, over ASR text that spells drift ("laproscopic", "circumcission"); the alias map adds the colloquial and spoken variants (English, Hindi and Kannada in Latin
script as ASR writes them). Script terms (Devanagari / Kannada) are NOT covered: the pilot text was English. Coverage is measured, not assumed: see lexicon_stats().
"""
import re

GENERIC = set("""surgery surgical operation operations procedure procedures package packages unilateral bilateral lap laparoscopic laproscopic laser assisted under plus with and
of for the left right type total complex full minor sur gastro ortho redo ra ga eua unilateral insertion removal excision drainage incision repair release
reconstruction augmentation application infiltration concentrate multiple synthetic patch mesh stapler""".split())

# stem -> extra spoken terms (word prefixes). Keys are matched as substrings of the lowercase booked name.
ALIAS = {
    "knee replacement": ["knee replacement", "tkr", "knee implant", "knee prosthesis"], "megaprosthesis": ["prosthesis", "megaprosthesis"],
    "angiogram": ["angiogram", "angiography", "angio", "cath lab", "catheter"], "angioplasty": ["angioplasty", "stent", "ptca", "pta"],
    "hernia": ["hernia", "hernioplasty", "herniorrhaphy", "rupture"], "cholecystectomy": ["gallbladder", "gall bladder", "cholecystectomy", "gallstone", "gall stone", "gall stones"],
    "hysterectomy": ["hysterectomy", "uterus", "womb", "tlh"], "salping": ["salpingectomy", "fallopian", "tubes"],
    "septoplasty": ["septoplasty", "septum", "deviated", "turbinoplasty", "turbinate"], "turbinoplasty": ["turbinoplasty", "turbinate", "septoplasty"],
    "circumcis": ["circumcision", "circumcission", "foreskin"], "tympanoplasty": ["tympanoplasty", "eardrum", "ear drum", "tympanic", "perforation"],
    "fistula": ["fistula", "fistulectomy", "fistulotomy"], "haemorrhoid": ["piles", "haemorrhoid", "hemorrhoid", "haemorrhoidectomy"], "sphincterotomy": ["fissure", "sphincter", "sphincterotomy"],
    "pilonidal": ["pilonidal", "sinus"], "carpal tunnel": ["carpal tunnel", "carpal"], "varicose": ["varicose", "evla", "sclerotherapy", "varicose veins"],
    "arthroscop": ["arthroscopy", "arthroscopic", "acl", "pcl", "meniscus", "rotator", "supraspinatus", "shoulder scope"], "acl": ["acl", "cruciate", "ligament reconstruction"],
    "colonoscopy": ["colonoscopy", "scope"], "endoscopy": ["endoscopy", "gastroscopy", "scope", "upper gi"], "biopsy": ["biopsy", "fnac", "fna"],
    "tonsillectomy": ["tonsil", "tonsils", "tonsillectomy"], "adenoidectomy": ["adenoid", "adenoids"], "myomectomy": ["fibroid", "myomectomy", "fibroids"],
    "cystectomy": ["ovarian cyst", "cystectomy", "cyst"], "prp": ["prp", "platelet rich", "platelet-rich"], "craniotomy": ["craniotomy", "cranio", "brain"],
    "rirs": ["rirs", "dj stent", "stent", "ureteroscopy", "kidney stone", "stones"], "dj stent": ["dj stent", "stent"], "hydrocele": ["hydrocele"], "varicocele": ["varicocele"],
    "parotidectomy": ["parotid", "parotidectomy"], "thyroidectomy": ["thyroid", "thyroidectomy"], "orif": ["orif", "fracture", "plate", "plating", "screws"],
    "fracture": ["fracture", "orif", "plate", "plating"], "endometriosis": ["endometriosis", "chocolate cyst"], "cystoscopy": ["cystoscopy", "cystoscope"],
    "mirena": ["mirena", "iud", "coil"], "ablation": ["ablation", "rf ablation", "radiofrequency"], "microwave": ["microwave ablation"], "implant removal": ["implant", "plate removal", "screw removal"],
    "suture": ["suture", "stitches", "stitch"], "skin tags": ["skin tag", "skin tags"], "gangrenous": ["gangrene", "gangrenous"], "bone marrow": ["bone marrow", "marrow"],
    "lymph node": ["lymph node", "lymph nodes", "gland"], "penile": ["penile", "penis"], "inguinal": ["inguinal", "groin"], "umbilical": ["umbilical", "navel", "umbilicus"],
}


def terms_for(name):
    """Specific spoken terms for a booked procedure name. Returns a sorted list; may be empty (then the consult cannot be lexicon-checked)."""
    n = (name or "").lower()
    out = set()
    for key, al in ALIAS.items():
        if key in n:
            out.update(al)
    for w in re.findall(r"[a-z]{5,}", n):
        if w in GENERIC:
            continue
        if re.search(r"(ectomy|otomy|plasty|oscopy|ostomy|pexy|rrhaphy|desis|lysis|graphy|ectomies)$", w) or w in {"hernia", "fistula", "biopsy", "implant", "stenting"}:
            out.add(w)
    return sorted(out - GENERIC)


def _rx(term):
    term = term.lower()
    if len(term) >= 5 and term.endswith("y"):  # -y / -ies plurals: hysterectomy ~ hysterectomies
        return re.compile(r"(?<![a-z])" + re.escape(term[:-1]) + r"(?:y|ies)[a-z]{0,2}")
    t = re.escape(term)
    return re.compile(r"(?<![a-z])" + t + (r"[a-z]{0,4}" if len(term) >= 5 else r"(?![a-z])"))  # prefix match for long terms, exact for short ones (tkr, prp, acl, pta)


def hits(text, terms):
    """The specific terms present in the text (word-prefix match). Generic words are impossible here: terms_for never returns them."""
    t = (text or "").lower()
    return sorted({term for term in terms if _rx(term).search(t)})


def selftest():
    assert terms_for("total knee replacement -bilateral") and "tkr" in terms_for("total knee replacement -bilateral") and "surgery" not in terms_for("laparoscopic surgery for endometriosis")
    assert "surgery" not in terms_for("laparoscopic surgery for endometriosis") and "endometriosis" in terms_for("laparoscopic surgery for endometriosis")
    for n in ("surgery", "operation", "package", "laparoscopic surgery", "unilateral surgery package"):
        assert terms_for(n) == [], f"generic-only name must yield no terms: {n}"
    assert hits("we will do the knee replacement next month", terms_for("total knee replacement")) == ["knee replacement"]
    assert hits("it is a big operation and surgery", terms_for("total knee replacement")) == [], "generic words never match"
    assert hits("book a tkr", terms_for("total knee replacement")) == ["tkr"] and hits("stkrs", terms_for("total knee replacement")) == [], "short terms need a word boundary"
    assert hits("tkrishna is here", terms_for("total knee replacement")) == [], "a short term must not match as the START of another word"
    assert hits("the gall bladder has stones", terms_for("laparoscopic cholecystectomy")) == ["gall bladder"]
    assert hits("hysterectomies are common", terms_for("total laparoscopic hysterectomy")) == ["hysterectomy"], "-y / -ies plural"
    assert hits("we do the operation tomorrow", terms_for("hysterectomy")) == []
    print("selftest OK: generic words never count, specific terms and aliases match, short terms need a word boundary, prefix match on long terms")


if __name__ == "__main__":
    selftest()
