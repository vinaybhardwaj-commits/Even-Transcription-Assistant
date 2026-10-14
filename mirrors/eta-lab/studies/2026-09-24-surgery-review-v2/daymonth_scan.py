#!/usr/bin/env python3
"""daymonth_scan.py — day + month-name shape ("12th March", "March 12", "the twelfth of March") in the de-identified text of every surgery-path set; prints KEYS and COUNTS only (item#turn), never text.
Why: the frozen deid.py has no rule for a day-month date without a year (eta-refuter-2 #1651: c028|l3-c028-r2|2 reached Jev). SENT = a turn of an item that has a Jev output, in the encounter (no phase), or any turn of a pool/deid item scored by scan_pool;
the regenerated <set>/deid files were NOT sent (only <set>/deid_r1 were). A hit is a SHAPE, not a birthday: a human decides which are dates of birth. Run from ~/eta-data/surgery-review-v3 (cwd). Not covered: numeric dd/mm without a year, month-only ("born in October").
"""
import json,os,re,glob,sys
MON_FULL=r"(?:january|february|march|april|june|july|august|september|october|november|december)"  # 'may' handled capitalised only (the verb)
MON_ABB=r"(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|May)"  # capitalised abbreviations plus capital May
DAYN=r"(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?"
ORD=r"(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[- ]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirtieth|thirty[- ]?first)"
DAY=rf"(?:{DAYN}|{ORD})"
P1=re.compile(rf"(?i:\b{DAY}(?:\s+of(?:\s+the)?)?\s+{MON_FULL}\b)|\b{DAYN}(?:\s+of)?\s+{MON_ABB}\b|(?i:\b{ORD})(?:\s+of)?\s+May\b")
P2=re.compile(rf"(?i:\b{MON_FULL}\b\.?\s+(?:the\s+)?{DAY}\b)|\b{MON_ABB}\b\.?\s+(?:the\s+)?{DAYN}\b")
def shape(t): return bool(P1.search(t) or P2.search(t))
def selftest():
    for s,e in (("Daily birthday. 12th March.",1),("born on 12 March",1),("March 12 is fine",1),("the twelfth of March",1),("12th of March",1),("he may 5 times",0),("take 2 tablets in the morning",0),("Mar 9",1),("in march we will operate",0),("I was born in October",0),("1 May",1),("May 12th",1),("you may take 3 tablets",0),("the second of may we start",0)):
        assert shape(s)==bool(e),(s,shape(s))
    print("shape self-test OK on 14 invented strings (incl. the verb 'may')")
if __name__=="__main__":
    selftest()
    E=os.getcwd(); RES={}
    dirs=sorted(glob.glob(f"{E}/*/deid")+glob.glob(f"{E}/*/deid_r1")+glob.glob(f"{E}/pool/deid"))
    for d in dirs:
        par=os.path.dirname(d); name=os.path.relpath(d,E); hasjev=os.path.isdir(f"{par}/jev")
        sent_items=set(os.path.basename(f)[:-5] for f in glob.glob(f"{par}/jev/*.json")) if hasjev else set()
        if name=="pool/deid" and os.path.exists(f"{par}/scan.json"):
            sc=json.load(open(f"{par}/scan.json")); sent_items={k for k,v in sc.items() if "recall_p" in v}
        files=[f for f in glob.glob(f"{d}/*.json") if not os.path.basename(f).startswith("_")]
        ids={os.path.basename(f)[:-5] for f in files}; hs=[];hu=[];turns=0
        for f in files:
            q=os.path.basename(f)[:-5]
            try: doc=json.load(open(f))
            except Exception: continue
            for t in doc.get("turns",[]):
                turns+=1
                if shape(t.get("en") or "") or shape(t.get("orig") or ""):
                    insent=(q in sent_items) and ("phase" not in t or name=="pool/deid")
                    (hs if insent else hu).append(f"{q}#{t.get('i')}")
        RES[name]={"files":len(files),"turns":turns,"items_with_jev_output":len(ids&sent_items),"sent_turn_hits":hs,"unsent_turn_hits":hu}
        print(f"{name}: files {len(files)} turns {turns} | items with a Jev output {len(ids&sent_items)} | SENT-turn hits {len(hs)} {hs[:12]} | UNSENT-turn hits {len(hu)} {hu[:10]}")
    if "--out" in sys.argv:  # all hit KEYS (item#turn) per set, no text; 0600; for the human who classifies them
        out=sys.argv[sys.argv.index("--out")+1]; json.dump(RES,open(out,"w"),indent=1); os.chmod(out,0o600); print("keys written to",out)
