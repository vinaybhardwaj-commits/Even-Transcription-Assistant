#!/usr/bin/env python3
"""ct_cues.py — plain-CT PROPOSAL cues for the HIST candidate filter (ruling 164; owner hist-miner; eta-refuter-2 checks precision on 20 samples).
V: a plain CT the doctor advises/orders now counts as a procedure proposal. Ruling 171 (Fable 18:35): CONTRAST CT (non-angio) is IN too (imaging done in-house), so 'plain_ct' below means 'an explicit CT cue', contrast or not; contrast_mentioned stays as an annotation.
STILL OUT: MRI, X-ray, echo, treadmill, calcium score. CT angiography is reported as its own kind (ct_angio), not as plain CT (ruling 163: referred out, so its done-evidence differs).
A cue says only that CT is TALKED ABOUT; whether it is proposed NOW for THIS patient (vs history / already done) is the downstream status question (fleet's Jev stage b), never decided here.
  scan(text) -> {"hits", "plain_ct" (STRONG explicit CT cue), "weak_scan" (only 'scan'+body part, modality unknown), "candidate" (plain_ct and not history-only), "proposal_hint", "ct_angio", "contrast_mentioned", "excluded"}
  strong = an explicit CT cue (ct scan / ct + body part / ncct / hrct / plain ct / computed tomography / city-scan mishearing / Devanagari-Kannada 'ct scan');
  weak   = 'scan' + a body part with NO other modality within 4 tokens. NOT a candidate: eta-refuter-2 measured ~40% cue precision (ultrasound scans slip through when the word is not nearby).
  proposal_hint (per sentence holding a strong cue): "advice" (advice cue, no history cue) | "history_only" (history cue, no advice cue) | "mixed" | "unclear". The candidate filter is RECALL-FIRST: it drops only history_only.
Text is lower-cased; no text is returned except the matched cue phrase (2-4 words). Run: python3 ct_cues.py --selftest"""
import re, sys
BODY = r"(?:head|brain|skull|neck|sinus|sinuses|pns|orbit|orbits|face|chest|thorax|lung|lungs|abdomen|abdominal|pelvis|kub|kidney|kidneys|liver|spine|cervical|lumbar|dorsal|knee|shoulder|ankle|wrist|hip|hand|foot|leg|whole body|temporal bone|hrct)"
SEP = r"(?:\W+\w+){0,3}?\W+"             # up to 3 words between cue and body part
CT = r"(?:c\.?\s?t\.?|city|cee\s?tee|see\s?tee|sitee|cat)"      # 'city scan' / 'see tee scan' are ASR mishearings of 'CT scan'
STRONG = [
    ("ct_scan", re.compile(rf"\b{CT}[\s\-]?scans?\b")),
    ("ct_body", re.compile(rf"\bc\.?\s?t\.?\s?(?:of\s+(?:the\s+)?)?{BODY}\b")),
    ("body_ct", re.compile(rf"\b{BODY}\s+(?:c\.?\s?t\.?|city)\b(?!\s*(?:ratio|surgery|surgeon|value))")),
    ("ncct_plain", re.compile(r"\b(?:ncct|non[\s\-]?contrast\s+(?:c\.?\s?t\.?|scan)|plain\s+(?:c\.?\s?t\.?|scan)|hrct|computed\s+tomography|ct\s+kub)\b")),
    ("ct_script", re.compile(r"(?:सी\s?टी|सिटी|ಸಿ\s?ಟಿ|ಸಿಟಿ)\s*(?:स्कैन|स्केन|ಸ್ಕ್ಯಾನ್?|ಸ್ಕ್ಯಾನ|ಸ್ಕೆನ್)")),
]
MEDIUM = re.compile(rf"\b(?:{BODY}{SEP}scan|scan{SEP}(?:of\s+)?(?:the\s+|your\s+)?{BODY})\b")
NEGATIVE = re.compile(r"\b(?:mri|m\.?r\.?i\.?|x[\s\-]?rays?|xrays?|echo(?:cardiogram)?|2d\s?echo|ultrasound|ultra\s?sound|usg|sonography|doppler|pet|dexa|treadmill|tmt|calcium\s+scor\w*|bone\s+scan|thyroid\s+scan|mammogra\w*)\b")
ANGIO = re.compile(r"\b(?:ct|c\.?\s?t\.?)\s*[\-\s]?(?:angio\w*|coronary|pulmonary\s+angio\w*)\b|\bcta\b")
CONTRAST = re.compile(r"\bcontrast\w*|\bdye\b|\bcect\b")      # a FLAG only, deliberately loose: any contrast/dye mention (v1 matched only 'with contrast' style phrasing and missed a real case, eta-refuter-2 #599)
HISTORY = re.compile(r"\b(?:(?:ct|scan)\s+(?:was|were|has\s+been|had\s+been)\s+done|already\s+(?:done|had|did)|(?:you|he|she|they)\s+(?:had|did|have\s+done)|got\s+(?:it|a\s+ct|the\s+ct)\s+done|(?:the|your)\s+(?:ct|scan)\s+(?:show(?:s|ed)|report|film|result|is\s+normal|was\s+normal)|report\s+(?:of|from)|reviewed|film|films|cd|last\s+(?:week|month|year|time)|earlier|previous(?:ly)?|came\s+back|showed)\b")
ADVICE = re.compile(r"\b(?:(?:do|get|take|have|book|order|arrange|repeat|redo)\s+(?:a|an|the|one|another)?\s*(?:\w+\s+){0,2}?(?:ct|c\.?\s?t\.?|scan|city)|need(?:s|ed)?\s+(?:a|an|to)|advis(?:e|ed|ing)|suggest(?:ed|ing)?|recommend(?:ed)?|we\s+(?:will|shall|can|should|need|have\s+to)|you\s+(?:have\s+to|need\s+to|should|must)|let'?s|i'?ll|i\s+will|go\s+for|to\s+be\s+sure|just\s+to\s+be)\b")
DECLINE = re.compile(r"\b(?:(?:do(?:es)?n'?t|do\s+not|does\s+not|won'?t|will\s+not|no\s+need|not\s+(?:needed|necessary|required|advisable)|unnecessary|not\s+going\s+to)\b)")
NOT_CT = re.compile(r"\bct\s+(?:ratio|surgery|surgeon|value)\b|\bctvs\b|\bctg\b|\bcycle\s+threshold\b")

def _sentences(t):
    return [x for x in re.split(r"(?<=[.?!])\s+|\n+", t) if x.strip()]

def scan(text):
    t = (text or "").lower()
    empty = {"hits": [], "plain_ct": False, "weak_scan": False, "candidate": False, "proposal_hint": None, "declined_cue": False, "ct_angio": False, "contrast_mentioned": False, "excluded": []}
    if not t.strip(): return empty
    t_clean = NOT_CT.sub(" ", t)
    hits, hints, declined = [], [], False
    for sent in _sentences(t_clean):
        sh = [{"kind": k, "strength": "strong", "cue": m.group(0)[:40]} for k, rx in STRONG for m in rx.finditer(sent)]
        if not sh: continue
        hits += sh; declined = declined or bool(DECLINE.search(sent))
        adv, his = bool(ADVICE.search(sent)), bool(HISTORY.search(sent))
        hints.append("mixed" if adv and his else "advice" if adv else "history_only" if his else "unclear")
    excluded, words = [], t_clean.split()
    for m in MEDIUM.finditer(t_clean):
        pre = len(t_clean[:m.start()].split()); span = m.group(0).split()
        ctx = " ".join(words[max(0, pre - 4):min(len(words), pre + len(span) + 4)]); neg = NEGATIVE.search(ctx)
        if neg: excluded.append(neg.group(0)); continue
        hits.append({"kind": "scan_body", "strength": "weak", "cue": m.group(0)[:40]})
    strong = any(h["strength"] == "strong" for h in hits)
    # one hint for the passage: any sentence that is not history-only keeps it a candidate (recall-first)
    hint = None if not hints else ("advice" if "advice" in hints else "mixed" if "mixed" in hints else "unclear" if "unclear" in hints else "history_only")
    return {"hits": hits, "plain_ct": strong, "weak_scan": (not strong) and any(h["strength"] == "weak" for h in hits), "candidate": strong and hint != "history_only", "proposal_hint": hint, "declined_cue": declined,
            "ct_angio": bool(ANGIO.search(t_clean)), "contrast_mentioned": bool(CONTRAST.search(t_clean)), "excluded": sorted(set(excluded))}

def selftest():
    strong = ["we will do a ct scan of your head", "please get an ncct abdomen done", "ct brain tomorrow", "book a hrct chest", "get a city scan of the abdomen", "we need a plain ct kub", "cat scan is needed",
              "abdomen ct once and come back", "सीटी स्कैन करवा लीजिए", "ಸಿಟಿ ಸ್ಕ್ಯಾನ್ ಮಾಡಿಸಿ", "do a ct of the chest", "non contrast ct head"]
    weak = ["get a scan of the abdomen done", "head scan tomorrow morning", "we should do a brain scan", "scrotal scan of the abdomen"]
    neg = ["get an mri scan of the brain", "we did an x ray of the chest", "echo of the heart looks fine", "ultrasound scan of the abdomen", "the ct ratio is normal", "he needs ct surgery opinion",
           "ctg is normal", "scan the qr code", "take the tablet after food", "usg abdomen and pelvis", "treadmill test and calcium score", "pet scan of the whole body", "mri of the knee and ct", ""]
    for x in strong:
        r = scan(x); assert r["plain_ct"] and not r["weak_scan"], (x, r)
    for x in weak:
        r = scan(x); assert r["weak_scan"] and not r["plain_ct"] and not r["candidate"], (x, r)      # weak is never a candidate
    for x in neg:
        r = scan(x); assert not r["plain_ct"] and not r["candidate"], (x, r)
    h = scan("the ct scan was done last week and the report was normal"); assert h["plain_ct"] and h["proposal_hint"] == "history_only" and not h["candidate"], h     # eta-refuter-2: history is not a proposal
    h = scan("your earlier ct showed a stone so let's do another ct scan of the abdomen"); assert h["candidate"] and h["proposal_hint"] in ("advice", "mixed"), h        # history AND advice stays a candidate
    h = scan("i suggest a ct scan of the brain to be sure"); assert h["candidate"] and h["proposal_hint"] == "advice", h
    h = scan("we don't need to do a ct scan here"); assert h["plain_ct"] and h["declined_cue"], h        # annotated, NOT auto-vetoed ('no need for mri, do a ct' must survive): declining is the downstream status question
    h = scan("no need for an mri, we will do a ct head"); assert h["candidate"], h
    h = scan("thank you. the ct scan was done last week. we will do a ct head tomorrow"); assert h["candidate"], h                # per-sentence: one advice sentence is enough
    a = scan("we will do a ct angiography of the heart"); assert a["ct_angio"] and not a["plain_ct"], a
    a = scan("ct angiography of the head"); assert a["ct_angio"] and not a["plain_ct"], a
    a = scan("a ct scan first and then ct angiography"); assert a["plain_ct"] and a["ct_angio"], a
    a = scan("ct abdomen with contrast is needed"); assert a["plain_ct"] and a["contrast_mentioned"], a
    for x in ("ct abdomen with contrast is needed", "we do the ct contrast one", "contrast enhanced ct scan of the chest", "ct scan with dye"):
        assert scan(x)["contrast_mentioned"], x
    assert not scan("ct scan of the head")["contrast_mentioned"]
    a = scan("mri scan of the brain"); assert a["excluded"] == ["mri"] and not a["plain_ct"] and not a["weak_scan"], a
    print(f"selftest OK: {len(strong)} strong; {len(weak)} weak-only (never candidates); {len(neg)} look-alikes rejected; history-only ('scan was done last week') dropped, history+advice kept; declined-CT wording still carries the cue")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: print(__doc__)
