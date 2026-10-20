"""ft-lexical: counsellor first name per call from the summary ('Ms. <name> from Even Hospitals') or the transcript ('this is / I am <name> ... from Even').
Names stay in memory; only C1..Cn ids (ordered by episode count) are written. Doctor-titled names (Dr.) are not counsellors and are skipped."""
import re, collections
SUM = re.compile(r"\b(?:(Mr|Ms|Mrs|Miss|Dr)\.? )?([A-Z][a-z]{2,})(?: [A-Z][a-z]+)? (?:from|of|representing) (?:the )?Even\b")
TR = re.compile(r"\b(?:this is|i am|i'm|my name is) ([a-z]{3,})\b[^.?!]{0,30}\b(?:from|calling from) (?:the )?even\b", re.I)
STOP = {'doctor', 'dr', 'sir', 'madam', 'maam', 'sister', 'nurse', 'patient', 'the', 'calling', 'speaking', 'call', 'someone', 'staff', 'person', 'agent', 'executive', 'caller', 'representative', 'even', 'hospital', 'team', 'here', 'just', 'actually', 'not', 'from'}


def name_of(text, corpus):
    if corpus == 'S':
        for m in SUM.finditer(text or ''):
            if m.group(1) == 'Dr': continue
            n = m.group(2).lower()
            if n not in STOP: return n
    else:
        m = TR.search(text or '')
        if m and m.group(1).lower() not in STOP: return m.group(1).lower()
    return None
