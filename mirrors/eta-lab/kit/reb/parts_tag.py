"""parts_tag.py: conversation-part tagger for one consult clip (palimpsest lane candidate).

tag_clip(audio, segments) -> [{"part","t0","t1","score","source"}]   (ids and times only, no text)
  audio:    path to the clip audio (consult.flac) or None (Jev-only)
  segments: [{"t0": seconds from clip start, "text": str, "speaker": str}]  (English translate track preferred)
  part in history|exam|order|medicine|followup|advice; t0/t1 clip-relative seconds of a 30 s bin; score 0..1 (rule score, 1.0 = at threshold, capped);
  source in "clef"|"jev"|"clef+jev" = which signal crossed its threshold.
Rule per part (tuned on 27 consults, see REPORT-parts-tagger-12oct.md): mark if clef>=tc OR jev>=tj, on the aligned 30 s CLEF window.
Degrades to Jev-only (rule: jev>=tj_only) when CLEF fails (3 failed windows in a row, or any window error rate >50%, or no audio).
Call caps (per clip): CLEF one call per 30 s window, hop 30 s (aligned to bins) = ceil(dur/30); Jev one call per non-empty bin. estimate_calls() gives both.
If the CLEF estimate exceeds max_clef_calls, windows are thinned evenly and un-windowed bins use Jev-only. Jev calls are capped by max_jev_calls the same way (bins left unscored by Jev use CLEF only).
Keys: CLEF via /opt/clef (group clef); Jev via ~/.config/even-jev/key inside the process. Nothing is logged or printed here.
"""
import io,json,math,os,subprocess,sys,wave,collections
BIN=30
RULES={
 "history": {
  "tc": 0.7,
  "tj": 0.7,
  "tj_only": 0.7
 },
 "exam": {
  "tc": 0.2,
  "tj": 0.5,
  "tj_only": 0.6
 },
 "order": {
  "tc": 0.7,
  "tj": 0.5,
  "tj_only": 0.6
 },
 "medicine": {
  "tc": 0.7,
  "tj": 0.9,
  "tj_only": 0.8
 },
 "followup": {
  "tc": 0.7,
  "tj": 0.5,
  "tj_only": 0.5
 },
 "advice": {
  "tc": 0.7,
  "tj": 0.7,
  "tj_only": 0.7
 }
}

# CONFIG: per-part tuned rules from parts_config.json (judge-consensus tuning, 12 Oct). Override path with PARTS_CONFIG; missing or bad file -> built-in RULES above.
def _load_config():
    for f in (os.environ.get("PARTS_CONFIG"), os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","parts_config.json"), os.path.join(os.path.dirname(os.path.abspath(__file__)),"parts_config.json")):
        if f and os.path.exists(f):
            try:
                d=json.load(open(f))["parts"]
                return {p:{"rule":v["rule"],"tj_only":float(v["tj_only"]),"confidence":v.get("confidence")} for p,v in d.items() if p in RULES}
            except Exception: return {}
    return {}
CONFIG=_load_config()
def _apply(rule,tj_only,c,j,degraded):
    """-> (mark, score, source). Missing signal counts as absent. Degraded (no CLEF) uses the Jev-only threshold."""
    if degraded or c is None:
        if j is not None and j>=tj_only: return True,j,"jev"
        return False,0.0,""
    t=rule["type"]
    if t=="clef": return c>=rule["tc"],c,"clef"
    if j is None: j=0.0
    if t=="jev": return j>=rule["tj"],j,"jev"
    hc=c>=rule["tc"] if "tc" in rule else False; hj=j>=rule["tj"] if "tj" in rule else False
    if t=="or":
        if not (hc or hj): return False,0.0,""
        return True,max(c if hc else 0.0,j if hj else 0.0),"clef+jev" if hc and hj else ("clef" if hc else "jev")
    if t=="and": return (hc and hj),min(c,j),"clef+jev"
    if t=="w":
        v=rule["w"]*c+(1-rule["w"])*j
        return v>=rule["t"],v,"clef+jev"
    return False,0.0,""
TYPES={"history":"the doctor asks the patient about symptoms or medical history, or the patient describes complaints",
 "exam":"the doctor physically examines the patient or gives examination instructions such as breathe in or lie down",
 "order":"the doctor orders or advises a test, scan, blood investigation or a procedure",
 "medicine":"the doctor prescribes or explains a medicine or dosage",
 "followup":"the doctor asks the patient to come back for a follow-up visit or review",
 "advice":"the doctor gives advice on diet, lifestyle, precautions or explains the diagnosis"}
CLEF_STATE="Outpatient clinic room recording. The clip may contain a consultation between a doctor and a patient, or silence or talk between consultations."
def _noul(q): return {"type":"noul","instructions":q}
CLEF_Q={ # same wording as tuning
 "history":_noul("Is the doctor asking the patient about symptoms or medical history, or the patient describing complaints?"),
 "exam":_noul("Is the doctor physically examining the patient, for example giving instructions such as breathe in, lie down, or open your mouth?"),
 "order":_noul("Does the doctor order or advise a test, scan, blood investigation, or procedure?"),
 "medicine":_noul("Does the doctor prescribe or explain a medicine or its dosage?"),
 "followup":_noul("Does the doctor ask the patient to come back for a follow-up visit or review after some days or weeks?"),
 "advice":_noul("Is the doctor giving the patient advice about diet, lifestyle, precautions or explaining the diagnosis?")}
def estimate_calls(duration_s, n_text_bins=None):
    nb=int(duration_s//BIN)+1
    return {"clef":max(1,math.ceil(max(duration_s-25,1)/BIN)),"jev":(n_text_bins if n_text_bins is not None else nb),"bins":nb}
def _decode(path):
    import numpy as np
    p=subprocess.run(["ffmpeg","-v","error","-i",path,"-ar","16000","-ac","1","-f","s16le","-"],capture_output=True,check=True)
    return np.frombuffer(p.stdout,dtype="<i2")
def _wav(x):
    b=io.BytesIO()
    with wave.open(b,"wb") as o: o.setnchannels(1);o.setsampwidth(2);o.setframerate(16000);o.writeframes(x.tobytes())
    return b.getvalue()
def _default_clef(wav_bytes):
    sys.path.insert(0,"/opt/clef"); import clef
    r=clef.run(state=CLEF_STATE,questions=CLEF_Q,audio=[wav_bytes])
    a=(r.get("result") or r)["answers"]
    return {k:a[k]["noul"] for k in CLEF_Q}
def _default_jev(prev,cur):
    sys.path.insert(0,os.path.expanduser("~/oc/diar-lab-wt/kit/reb")); from jev_client import JevClient
    jc=_default_jev.jc if hasattr(_default_jev,"jc") else JevClient(); _default_jev.jc=jc
    state="Excerpt from a doctor-patient consultation in an outpatient clinic.\n"+("[Earlier] "+" / ".join(prev)+"\n" if prev else "")+"[Now] "+" / ".join(cur)
    qs={ty:{"type":"noul","instructions":"In the [Now] part: "+d+"?","criteria":{"true":"Yes","false":"No"}} for ty,d in TYPES.items()}
    r=jc._post({"state":state,"model":jc.model,"questions":qs})
    return {ty:((r.get("answers") or {}).get(ty,{}).get("noul") or 0.0) for ty in TYPES}
def tag_clip(audio, segments, max_clef_calls=60, max_jev_calls=60, clef_fn=None, jev_fn=None, duration_s=None, stats=None):
    """clef_fn(wav_bytes)->{part:p}; jev_fn(prev_lines,cur_lines)->{part:p}. Both injectable for tests. stats (dict) receives call counts."""
    st=stats if stats is not None else {}
    st.update({"clef_calls":0,"clef_errors":0,"jev_calls":0,"jev_errors":0,"degraded":False})
    clef_fn=clef_fn or _default_clef; jev_fn=jev_fn or _default_jev
    bins=collections.defaultdict(list)
    for s in segments:
        t=s.get("t0"); tx=(s.get("text") or "").strip()
        if t is None or t<0 or not tx: continue
        bins[int(t//BIN)].append(f"{s.get('speaker','')}: {tx[:200]}")
    x=None
    if audio:
        try: x=_decode(audio)
        except Exception: x=None
    dur=duration_s if duration_s is not None else (len(x)/16000 if x is not None else (max(bins)+1)*BIN if bins else 0)
    nb=int(dur//BIN)+1
    # CLEF windows
    clef={}
    if x is not None:
        ks=[k for k in range(nb) if 30*k*16000+16000*25<=len(x)]
        if len(ks)>max_clef_calls: ks=[ks[int(i*len(ks)/max_clef_calls)] for i in range(max_clef_calls)]
        fails=0
        for k in ks:
            st["clef_calls"]+=1
            try: clef[k]=clef_fn(_wav(x[30*k*16000:(30*k+30)*16000])); fails=0
            except Exception:
                st["clef_errors"]+=1; fails+=1
                if fails>=3 or st["clef_errors"]>0.5*max(st["clef_calls"],1) and st["clef_calls"]>=4: st["degraded"]=True; break
        if st["degraded"]: clef={}   # a flaky CLEF is dropped for the whole clip: same rule on every bin
    else: st["degraded"]=True
    # Jev bins
    jk=sorted(k for k in bins if k<nb)
    if len(jk)>max_jev_calls: jk=[jk[int(i*len(jk)/max_jev_calls)] for i in range(max_jev_calls)]
    jev={}
    for k in jk:
        st["jev_calls"]+=1
        try: jev[k]=jev_fn(bins.get(k-1),bins[k])
        except Exception: st["jev_errors"]+=1
    out=[]
    for k in range(nb):
        for part,r in RULES.items():
            c=(clef.get(k) or {}).get(part); j=(jev.get(k) or {}).get(part)
            cfg=CONFIG.get(part)
            if cfg:
                hit,sc,src=_apply(cfg["rule"],cfg["tj_only"],c,j,st["degraded"])
                if not hit: continue
                out.append({"part":part,"t0":k*BIN,"t1":(k+1)*BIN,"score":round(float(sc),3),"source":src}); continue
            hc=c is not None and c>=r["tc"]; hj=j is not None and j>=(r["tj"] if not st["degraded"] else r["tj_only"])
            if not (hc or hj): continue
            sc=max(c if hc else 0.0, j if hj else 0.0)   # probability of the signal that crossed
            out.append({"part":part,"t0":k*BIN,"t1":(k+1)*BIN,"score":round(float(sc),3),"source":"clef+jev" if hc and hj else ("clef" if hc else "jev")})
    return out
