import json,sys,collections
O=__import__("os").path.expanduser("~/dev/eta-lab/studies/2026-09-24-e7-fullday/out-2026-09-24")
S=sys.argv[1]
rows=json.load(open(f"{S}/p1-rows2.json"))
hyp=json.load(open(f"{O}/hyp-acoustic.json"))["room_days"]
summ=json.load(open(f"{O}/replay-summary.json"))["room_days"]
pr=collections.defaultdict(dict)   # rd -> start_ms -> {u1:(choice,conf), u6:(choice,conf)}
for r in rows:
    _,_,rd,ms=r["subject_id"].split("_"); rd="rd_"+rd
    pr[rd].setdefault(int(ms),{})["u1" if r["question_id"]=="u1_phase" else "u6"]=(r["choice"],float(r["confidence"]))
def band(c): return "act" if c>=0.9 else "caution" if c>=0.5 else "review"
NONE={"not_a_consultation"}
def clinical(j):
    if "u6" not in j: return None   # not judged
    ch,c=j["u6"]; says= ch=="clinical_consultation" and band(c)!="review"
    u1=j.get("u1"); conf_none = u1 is not None and u1[0] in NONE and band(u1[1])=="act"
    return says and not conf_none
out={}
for rd,x in hyp.items():
    enc=x["encounters"]; ps=pr[rd]
    print(rd, "rows judged(u6):", sum(1 for j in ps.values() if "u6" in j), "summary judged:", summ[rd]["probes"]["judged"], "encounters", len(enc))
    res=[]
    for e in enc:
        js=[clinical(j) for st,j in ps.items() if e["start_ms"]<=st<e["end_ms"]]
        judged=[v for v in js if v is not None]
        res.append({"id":e["id"],"start_ms":e["start_ms"],"end_ms":e["end_ms"],"probes":len(js),"judged":len(judged),"clinical":sum(judged)})
    keep1=[r for r in res if r["clinical"]>=1]
    print("  rule >=1 clinical keeps",len(keep1),"| stored confirm",summ[rd]["fusion"]["confirm"])
    out[rd]={"room":x["room"],"date":x["date"],"energy_gap":False,"encounters":res}
json.dump(out,open(f"{S}/p1-encounters.json","w"))
