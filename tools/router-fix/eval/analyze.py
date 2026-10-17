#!/usr/bin/env python3
"""W31.1 analysis per PREREG-W31-eval.md (sha 2de38c9e7fe4). Prints a report; patient text never printed."""
import json, os, sys, collections, re
OUT = "/home/eta/oc/router-fix/eval-out"
LD = "/home/eta/oc/lid-debug/work"
ST = "/home/eta/eta-data/diag-rig/stimuli"
load = lambda f: {json.loads(l)["id"]: json.loads(l) for l in open(f)} if os.path.exists(f) else {}
INDIC = re.compile(r"[ऀ-෿]")

def path_of(row):
    """(lang, engine) of the clip's dominant segment by emitted characters; None = no segment."""
    segs = [s for s in row.get("segments", []) if s.get("text")]
    if not segs:
        return None
    w = collections.Counter()
    for s in segs:
        w[(s["lang"], s["engine"])] += len(s["text"])
    return w.most_common(1)[0][0]

def on_en(p):
    return p is not None and p == ("en", "whisper")

def indic_share(row):
    t = "".join(s.get("text", "") for s in row.get("segments", []))
    return len(INDIC.findall(t)), len(t)

def norm(t):  # map Indic blocks to Devanagari by offset; lowercase, drop punctuation/space
    o = []
    for ch in t.lower():
        c = ord(ch)
        if 0x0900 <= c <= 0x0DFF:
            c = 0x0900 + (c & 0x7F)
            o.append(chr(c))
        elif ch.isalnum():
            o.append(ch)
    return "".join(o)

def lev(a, b):
    p = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        q = [i]
        for j, y in enumerate(b, 1):
            q.append(min(p[j] + 1, q[j - 1] + 1, p[j - 1] + (x != y)))
        p = q
    return p[-1]

def script(t):
    ind = len(INDIC.findall(t)); lat = len(re.findall(r"[a-z]", t.lower()))
    return "indic" if ind > lat else "latin"

def hit(hyp, ref):
    h, r = norm(hyp), norm(ref)
    if not r:
        return None
    if script(hyp) != script(ref):
        return 0.0
    return max(0.0, 1 - lev(h, r) / len(r))

def main():
    old = {**load(f"{OUT}/old-label200-r.jsonl"), **load(f"{OUT}/old-label200.jsonl")}
    new = load(f"{OUT}/new-label200.jsonl")
    old = {k: v for k, v in old.items() if "error" not in v}  # errored clips (engine fault) are listed below, not scored
    print("errored old clips:", sorted(k for k, v in load(f"{OUT}/old-label200.jsonl").items() if "error" in v))
    rows = {r[0]: r for r in json.load(open(f"{LD}/rows.json"))}
    t1 = json.load(open(f"{LD}/lidbug_labels_en_tagged.json"))
    ids = sorted(set(old) & set(new))
    print(f"## label200: {len(ids)} clips with both routers ({len(old)} old, {len(new)} new)")
    ch = collections.Counter(); tot = collections.Counter(); ic = {"old": [0, 0], "new": [0, 0]}
    for i in ids:
        po, pn = path_of(old[i]), path_of(new[i])
        tag = rows[i][1]; est = "SV-" + rows[i][4] + ("/p<0.9" if rows[i][3] < 0.9 else "/p>=0.9")
        for k in (("tag", tag), ("est", est)):
            tot[k] += 1
            if po != pn:
                ch[k] += 1
        for w, r in (("old", old[i]), ("new", new[i])):
            a, b = indic_share(r); ic[w][0] += a; ic[w][1] += b
    print("# windows whose dominant path changes, per OLD router tag / per T2 estimate")
    for k in sorted(tot):
        print(f"  {k[0]} {k[1]}: {ch[k]}/{tot[k]}")
    for w in ic:
        print(f"# Indic-script share of emitted chars {w}: {ic[w][0]}/{ic[w][1]} = {ic[w][0] / max(1, ic[w][1]):.3f}")
    # M5: english windows whose emitted text was not the judged text (old): whisper en segments vs judged whisper call
    print("# T1 (lid-debug hand labels, en-tagged)")
    tab = collections.defaultdict(collections.Counter)
    for i, lab in t1.items():
        if i in old and i in new:
            tab[lab][(("EN" if on_en(path_of(old[i])) else "INDIC/other"), ("EN" if on_en(path_of(new[i])) else "INDIC/other"))] += 1
    for lab, c in sorted(tab.items()):
        print(f"  {lab}: " + ", ".join(f"old {a}->new {b}: {n}" for (a, b), n in sorted(c.items())))
    ind = tab.get("indic", collections.Counter()); eng = tab.get("en", collections.Counter())
    moved = sum(n for (a, b), n in ind.items() if b != "EN")
    print(f"  P1 Indic-speech clips on Indic path in NEW: {moved}/{sum(ind.values())} (need >=14); OLD: {sum(n for (a,b),n in ind.items() if a!='EN')}")
    kept = sum(n for (a, b), n in eng.items() if b == "EN")
    print(f"  P2 true-English kept on English path in NEW: {kept}/{sum(eng.values())} (need >=27); OLD: {sum(n for (a,b),n in eng.items() if a=='EN')}")
    # engine calls per English-path segment
    for w, d in (("old", old), ("new", new)):
        c = [len([x for x in r["calls"] if x["eng"] == "indic"]) / max(1, len(r.get("segments", []))) for r in d.values() if on_en(path_of(r))]
        print(f"  P6 {w}: mean indic-conformer calls per segment on English-path clips = {sum(c)/max(1,len(c)):.2f} (n={len(c)})")
    # SELFTEST
    so, sn = load(f"{OUT}/old-selftest.jsonl"), load(f"{OUT}/new-selftest.jsonl")
    print(f"## SELFTEST: {len(so)} old, {len(sn)} new")
    res = collections.defaultdict(lambda: {"old": [], "new": [], "otag": [], "ntag": []})
    for i in sorted(set(so) & set(sn)):
        suite, name = i.split("/")
        tp = f"{ST}/{suite}/{name}.truth.json"
        tr = json.load(open(tp))
        turns = [e for e in tr["events"] if e.get("type") == "turn" and e.get("text")]
        if not turns:
            continue
        ref = " ".join(e["text"] for e in turns)
        langs = set()
        for e in turns:
            langs |= set(e["lang"].split("-"))
        for w, d in (("old", so), ("new", sn)):
            segs = d[i].get("segments", [])
            hyp = " ".join(s.get("text", "") for s in segs)
            h = hit(hyp, ref)
            tagok = sum(len(s["text"]) for s in segs if s["lang"] in langs) / max(1, sum(len(s["text"]) for s in segs))
            res[(name.split("__")[0].replace("dlg_", "").rsplit("_", 1)[0], suite, "noisy" if "__" in name else "clean")][w].append(h if h is not None else 0)
            res[(name.split("__")[0].replace("dlg_", "").rsplit("_", 1)[0], suite, "noisy" if "__" in name else "clean")]["o" + "tag" if w == "old" else "ntag"].append(tagok)
    for k in sorted(res):
        v = res[k]; m = lambda x: sum(x) / max(1, len(x))
        print(f"  {k}: text-hit old {m(v['old']):.2f} new {m(v['new']):.2f} | tag-share old {m(v['otag']):.2f} new {m(v['ntag']):.2f} (n={len(v['old'])})")
    for w, d in (("old", so), ("new", sn)):
        c = d.get("digital1/canary")
        if c:
            print(f"  canary {w}: {[s['text'][:40] for s in c.get('segments', [])]}")
main()
