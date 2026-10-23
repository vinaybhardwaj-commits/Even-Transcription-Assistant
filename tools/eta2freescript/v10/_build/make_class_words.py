"""Fix3h ruling 4: drug-class words from the WHO ATC classification (levels 2-4 English names) and dose-form nouns from the EDQM Standard Terms.

ATC source: the public CSV copy of the WHO ATC/DDD index (fabkury/atcd, "WHO ATC-DDD 2021-12-03.csv").
EDQM source: the EDQM Standard Terms code system (version "5 February 2025"), read from the FHIR terminology server tx.fhir.org (CodeSystem tx-edqm).
Both inputs are downloaded by hand into a directory given as argv[1] (atc.csv, edqm.json); their sha256 go in the output and in C7 through the data file.
Output: data/class_forms.v1.json (class_words_atc, dose_form_nouns_edqm, sources). usage: make_class_words.py SRC_DIR
"""
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "data" / "class_forms.v1.json"

# words of an ATC / EDQM name that say nothing about the class or the form by themselves
GENERIC = set("""other various combination combinations complexes compounds agents drugs drug preparations preparation products product medicines used use systemic local treatment
diseases disease disorders disorder excl excluding incl including plain derivatives derivative group groups substances substance therapy therapeutic preparations agent analogues
analogs with without and the for in of to by or on at from not oral topical general and its their other,""".replace(",", " ").split())
# ordinary words (not a medicine class on their own); the ATC names several body parts, signs and foods as headings
ORDINARY = set("""blood water fluids fluid solutions solution salts salt acids acid oils oil vitamins vitamin minerals mineral hormones hormone enzymes enzyme proteins protein sugars sugar
amino fats fat food foods calcium iron potassium sodium magnesium zinc iodine phosphorus nutrients nutrient tea vaccines vaccine sera serum immune heart lung liver kidney skin eye eyes ear ears
nose throat mouth teeth bone bones muscle muscles joint joints brain nerve nerves gas air pain cold cough fever thyroid diabetes cancer tumour tumor infection infections weight gain loss
sleep stomach bowel bowels gut uterus bladder prostate vein veins artery arteries lipid lipids glucose cell cells tissue tissues wound wounds burns burn scar scars hair nail nails
radiotherapy test tests contrast diagnostic diagnostics dressings dressing surgical chemicals cosmetics colloids carbohydrates constipation tract tests transfusion substitutes factors
extracts extract structure system stimulants ulcers hemorrhoids particles esters ethers plasters reagents concentrates protectives propulsives digestives solvents sensitizers softeners
repellents hemofiltrates gangliosides amoebiasis leishmaniasis fissures homeostasis effects effect formulations formulation formulas disturbances diets gases injuries bandages adhesives surfactants
electrolytes modulators particles dermatologicals gynecologicals ophthalmologicals otologicals urologicals""".split())

# dose-form heads of an EDQM term that are routes, adjectives or ordinary words, not a form
EDQM_NOT_FORM = set("""oral nasal ear eye cutaneous vaginal rectal urethral dental gingival oromucosal buccal sublingual ocular auricular intravenous intramuscular subcutaneous intradermal intravesical
intrauterine intraocular intravitreal intra-articular epidural intrathecal parenteral inhalation inhaled transdermal topical periodontal endotracheopulmonary laryngopharyngeal oropharyngeal
for in use and with the of to by or modified-release prolonged-release delayed-release gastro-resistant immediate-release extended-release soluble dispersible effervescent chewable coated film-coated
sugar-coated medicated pre-filled prefilled single-dose multidose multi-dose sterile herbal instant dry concentrated concentrate dilute diluted liquid water oil gas tea gum bar stick
product products preparation preparations system systems form forms dose type kit medicinal vehicle diluent solvent
absorbable additive animal animals bait bee bee-hive bladder block chain compressed continuous-release delivery denture device dip endocervical endosinusial epilesional equivalent fibrin frozen
gastroenteral hard impregnated intestinal intracameral intramammary intraperitoneal intraruminal intravaginal larvae leech lick live living liquefied material matrix mucosal muco-adhesive nail nose
oculonasal ophthalmic orodispersible paper pendant plug pour-on precursor premix pressurised pulsatile-release radionuclide radiopharmaceutical ring scalp smoke spot-on stomach tag teat thread tissue
unknown wound pad generator collar anticoagulant
dressing plaster cement bath irrigation instillation scrub sponge swab sealant sealant-powder implantation dispersion chewing-gum""".split())  # anatomy, adjectives, veterinary items, and clinical procedure materials that are not a medicine form


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def atc_words(path: Path) -> tuple[list[str], list[str]]:
    singles: set[str] = set()
    phrases: set[str] = set()
    for r in csv.DictReader(path.open(encoding="utf-8")):
        code = r["atc_code"]
        if not 3 <= len(code) <= 5:
            continue
        name = re.sub(r"\([^)]*\)", " ", r["atc_name"]).lower()
        for frag in re.split(r",|;|\band\b|\bwith\b|\bfor\b|\bin\b|\bused\b|\bexcl\b|\bexcl\.|\bother\b|\bof\b", name):
            toks = [w for w in re.findall(r"[a-z][a-z0-9\-]*", frag) if w not in GENERIC]
            if not toks or len(toks) > 3:
                continue
            if len(toks) == 1:
                w = toks[0]
                if len(w) >= 6 and w.endswith("s") and not w.endswith(("ss", "is", "us")) and w not in ORDINARY and not re.search(r"\d|-$", w):  # an ATC class heading is a plural noun (Antacids, Corticosteroids, Penicillins)
                    singles.add(w)
            elif toks[-1].endswith("s") and len(toks[-1]) >= 5 and toks[-1] not in ORDINARY and not any(re.search(r"\d", w) for w in toks):
                phrases.add(" ".join(toks))
    out_s: set[str] = set()
    for w in singles:
        out_s.add(w)
        out_s.add(w[:-1])
        m = re.fullmatch(r"anti([a-z]{4,})", w.replace("-", ""))
        if m:  # "antiinflammatory" is also said "anti-inflammatory" / "anti inflammatory"
            out_s.add("anti-" + m.group(1))
            out_s.add("anti " + m.group(1))
    out_p: set[str] = set()
    for p in phrases:
        out_p.add(p)
        out_p.add(p[:-1])  # "ace inhibitors" -> "ace inhibitor"
        m = re.fullmatch(r"(.+?) blocking", p)
        if m:  # "beta blocking agents" -> "beta blocker(s)"
            out_p.update({m.group(1) + " blocker", m.group(1) + " blockers"})
    return sorted(out_s), sorted(out_p)


def edqm_nouns(path: Path) -> list[str]:
    d = json.loads(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for c in d["concept"]:
        cls = next((p["valueCode"] for p in c.get("property", []) if p["code"] == "class"), None)
        if cls not in ("PDF", "CDF", "BDF"):
            continue
        head = re.split(r",|\bfor\b|\bin\b|\bwith\b|\band\b|\bto be\b", c["display"].lower())[0]
        head = re.sub(r"\([^)]*\)", " ", head)
        for w in re.findall(r"[a-z][a-z\-]*", head):
            if w in EDQM_NOT_FORM or len(w) < 3:
                continue
            out.add(w)
            out.add(w[:-1] if w.endswith("s") and len(w) > 4 else w + "s")
    return sorted(out)


if __name__ == "__main__":
    src = Path(sys.argv[1])
    cw, cp = atc_words(src / "atc.csv")
    nouns = edqm_nouns(src / "edqm.json")
    OUT.write_text(json.dumps({"version": "1", "sources": {"atc_csv_sha256": sha(src / "atc.csv"), "atc": "WHO ATC/DDD index 2021-12-03, public CSV copy (fabkury/atcd), levels 2-4 English names",
                                                           "edqm_json_sha256": sha(src / "edqm.json"), "edqm": "EDQM Standard Terms, version 5 February 2025, classes PDF/CDF/BDF, via tx.fhir.org CodeSystem tx-edqm"},
                               "class_words_atc": cw, "class_phrases_atc": cp, "dose_form_nouns_edqm": nouns}, indent=0, ensure_ascii=False) + "\n", encoding="utf-8")
    print(len(cw), len(cp), len(nouns))
