"""proc_match stage 1, rule v5 (P1-PREREG-v5.md): patient-side comparison of an advised procedure name with a done-evidence name.
No transcript, no patient identity, no link score. Returns 'match', 'technique_changed', 'mismatch' or 'unknown'.
Conservative: doubt -> 'unknown'. 'technique_changed' = same indication, different technique (its own stratum, never a positive until ruled).

  python3 procmatch.py        runs the self-test
"""
import re

# generic words carrying no procedure identity (v1 list, refuter #590 additions, v5: scar/tissue/lesion/mass/growth)
STOP = set("""laparoscopic laproscopic laparoscopy laproscopy surgery surgical unilateral bilateral package procedure under with without
local general anaesthesia anesthesia spinal complete partial total left right clinic session and for the of in by to operation
endoscopic arthroscopic robotic open closed primary revision diagnostic internal day care minor major single double
scar tissue lesion mass growth operative assisted""".split())
# action nouns: carry the kind of act but no anatomy; if both names carry one they must share it (v5: + ablation, closure)
ACT = set("replacement fixation reduction implant excision incision drainage repair release removal insertion ligation decompression reconstruction resection ablation".split())
BODY = set("""knee hip shoulder ankle elbow wrist radius ulna femur tibia fibula humerus spine lumbar cervical thoracic hand foot finger toe kidney ureter
              bladder prostate uterus ovary breast thyroid gallbladder appendix colon rectum anal skin scalp eye lens cornea retina vagina vaginal vault
              nasal septum tonsil adenoid ear sinus perineal pelvic""".split())
TYPE = set("inguinal umbilical ventral incisional femoral hiatal".split())
SITES = BODY | TYPE
# modality prefixes that are how a procedure is done, not what it is
MODALITY_ROOTS = {"lapar", "lapro", "endos"}
KEY = re.compile(r"^(.{3,}?)(ectom|otom|ostom|plast|o?scop|pex|rrhaph|desis|lysis|centes)(y|ies)$")


def _norm(name):
    n = (name or "").lower()
    n = re.sub(r"\bc\.?\s*t\.?\b", "ct", n)
    n = re.sub(r"\blap\b", "laparoscopic", n)
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return n.replace("ae", "e").replace("oe", "e")


def _features(name):
    keys, sites, acts, content = set(), set(), set(), set()
    for w in _norm(name).split():
        m = KEY.match(w)
        if m and m.group(1)[:5] not in MODALITY_ROOTS:
            cls = "scop" if m.group(2) in ("scop", "oscop") else m.group(2)
            keys.add((m.group(1)[:5], cls))
            continue
        if m:
            continue                       # laparoscopy / endoscopy: modality, ignored
        if w in SITES:
            sites.add(w)
        elif w in ACT:
            acts.add(w)
        elif len(w) >= 4 and w not in STOP and not w.isdigit():
            content.add(w[:5])
    return keys, sites, acts, content


def proc_match(advised, done):
    ka, sa, aa, ca = _features(advised)
    kd, sd, ad, cd = _features(done)
    if not (ka or sa or aa or ca) or not (kd or sd or ad or cd):
        return "unknown"
    if sa and sd and not (sa & sd):                       # both name a site and share none
        return "mismatch"
    if ka and kd:                                         # both suffix-keyed: same root and class, else different procedure
        return "match" if (ka & kd) else "mismatch"
    if ka or kd:                                          # v5: one side keyed, the other not: the head root must appear on the other side
        roots = {k[0] for k in (ka or kd)}
        other = cd if ka else ca
        if not (roots & other):
            return "unknown"
    shared = ca & cd
    if aa and ad and not (aa & ad):                       # different action nouns
        return "technique_changed" if shared else "mismatch"
    if shared:
        return "match"
    if not ca and not cd and aa & ad and (sa & sd or (not sa and not sd)):
        return "match"
    return "unknown"


TESTS = [
    # refuter #590: five false pairs of v3 must not match
    ("knee arthroscopy", "hip arthroplasty", "mismatch"),
    ("hysteroscopy", "hysterectomy", "mismatch"),
    ("radius internal fixation", "femur internal fixation", "mismatch"),
    ("knee replacement", "hip replacement", "mismatch"),
    ("endoscopic sinus surgery", "ERCP", "unknown"),
    ("inguinal hernia repair", "umbilical hernia repair", "mismatch"),
    ("tympanoplasty", "tympanotomy", "mismatch"),
    ("fistulotomy", "fistulectomy", "mismatch"),
    ("hemorrhoidopexy", "haemorrhoidectomy", "mismatch"),
    # refuter #605: the two v4 false matches
    ("non-descent vaginal hysterectomy - (package )", "re exploration of the vaginal vault", "unknown"),
    ("scar revision - minor", "knee scar tissue revision", "unknown"),
    # technique policy: same indication, different technique is its own stratum
    ("laser assisted pilonidal sinus ablation", "excision of pilonidal sinus with primary closure - (package)", "technique_changed"),
    # pairs the refuter graded correct in #605 must stay matches
    ("wide local excision", "wide local excision", "match"),
    ("hysteroscopy + d&c + polypectomy - (package )", "hysteroscopic polypectomy +d and c under ga on 7/9/26", "match"),
    ("colonoscopy full", "colonoscopy (limited) - gastro", "match"),
    ("arthroscopic labral repair - supra (eg bankart - slap repair", "1. left shoulder arthroscopic slap repair using one suture a", "match"),
    ("cpe and laser oiu", "laser oiu and cpe", "match"),
    ("operative lap for endometriosis", "operative hystero-laparoscopy for endometriosis with b/l end", "match"),
    ("total knee replacement", "total knee replacement", "match"),
    ("operative lap for endometriosis", "radical excision of endometriosis", "match"),
    ("laparoscopic surgery for endometriosis", "radical excision of endometriosis", "match"),
    ("eua+ hemorrhoidectomy+ lateral sphincterotomy", "fistulectomy + miligan morgan hemorrhoidectomy grade 4", "match"),
    ("stapler circumcission under ra", "circumcision ( day care) - -package", "match"),
    ("laparoscopic umbilical hernia reapir with mesh", "umblical hernioplasty (mesh upto 7000 included in package)", "match"),
    ("laparoscopic myomectomy", "laparoscopic myomectomy (as additional procedure) - obg", "match"),
    ("total laproscopic hysterectomy (tlh) - (package )", "laparoscopic hysterectomy", "match"),
    ("dj stent removal", "dj stent removal", "match"),
    ("hysteroscopy + d&c + polypectomy - (package )", "hysteroscopy + d&c + polypectomy - (package )", "match"),
    # other true matches and doubts
    ("laparoscopic cholecystectomy", "Cholecystectomy", "match"),
    ("haemorrhoidectomy", "hemorrhoidectomy", "match"),
    ("total knee replacement", "knee replacement bilateral", "match"),
    ("knee arthroscopy", "arthroscopy knee", "match"),
    ("knee arthroscopic acl reconstruction", "knee replacement", "mismatch"),
    ("", "cholecystectomy", "unknown"),
    ("hernia repair", "hernioplasty", "unknown"),
]

if __name__ == "__main__":
    bad = 0
    for a, d, want in TESTS:
        got = proc_match(a, d)
        bad += got != want
        if got != want:
            print(f"FAIL {a!r:50s} vs {d!r:40s} -> {got} (want {want})")
    print(f"{len(TESTS)-bad}/{len(TESTS)} self-tests ok")
    raise SystemExit(bad)
