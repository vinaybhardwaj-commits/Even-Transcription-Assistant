#!/usr/bin/env python3
"""score_v1.py — score Jev U9 (wording v2.1) against V's 18 labels (human truth for L8, RULINGS-FABLE-0920 #36).
Stimulus = the exact excerpts V saw (parsed from the v1 page), so the comparison is like for like. Prints aggregates and S-ids only;
writes per-consult detail (ids + values, no text) to ~/eta-data/surgery-review-v2/score-v1.json. Patient text stays in the page file."""
import html, json, os, re, sys
from collections import Counter, defaultdict
import u9

HOME = os.path.expanduser("~")
PAGE, LABELS = f"{HOME}/eta-data/surgery-30/index.html", f"{HOME}/eta-data/surgery-30/v-labels-2026-09-24.json"
OUT = f"{HOME}/eta-data/surgery-review-v2"
FIELDS = ["recommended", "firmness", "patient_response", "urgency", "cost", "second_opinion"]
CTX_EXTRA = {"S12": "history", "S10": "referral", "S09": "staff_talk"}  # from V's own procedure/notes text; S03 and S16 excluded (V: unclear)


def ctx_truth(sid, lab):
    if sid in CTX_EXTRA:
        return CTX_EXTRA[sid]
    if sid in ("S03", "S16"):
        return None
    return {"yes": "recommendation_now", "no": "no_surgical_talk"}.get(lab[sid]["recommended"])


def stimulus_by_consult():
    h = open(PAGE, encoding="utf-8").read()
    out = {}
    for sid, body in re.findall(r"<div class=card id=(S\d+)>(.*?)(?=<div class=card id=S|<script>)", h, re.S):
        lines = []
        for m in re.finditer(r"<div class=tx>(?:<span class=sp>(.*?)</span>)?(.*?)</div>", body, re.S):
            sp, tx = html.unescape(m.group(1) or ""), html.unescape(re.sub(r"</?mark>", "", m.group(2)))
            lines.append(f"[{len(lines) + 1}] {sp + ': ' if sp else ''}{tx}")
        out[sid] = "Excerpt of a doctor-patient consultation (lines may be out of order at breaks marked …; speaker labels are diarization tags):\n" + "\n".join(lines)
    return out


def main():
    stim, labels = stimulus_by_consult(), json.load(open(LABELS))
    detail, hits, n = {}, defaultdict(int), defaultdict(int)
    conf = defaultdict(list)
    for sid in sorted(stim):
        res = u9.ask(stim[sid], u9.QUESTIONS_V21 if "--v21" in sys.argv else u9.QUESTIONS)
        j = {}
        for f in FIELDS + ["procedure_named"] + ([] if "--v21" in sys.argv else ["context", "discussed"]):
            j[f] = u9.answer_value(res["answers"][f])
        detail[sid] = {"jev": {k: list(v) for k, v in j.items()}, "v": {f: labels[sid].get(f) for f in FIELDS}, "v_procedure_filled": bool((labels[sid].get("procedure") or "").strip())}
        for f in FIELDS:
            v = labels[sid].get(f)
            if v is None:
                continue
            n[f] += 1
            ok = j[f][0] == v
            hits[f] += ok
            conf[f].append((j[f][1], ok))
    os.makedirs(OUT, exist_ok=True)
    p = f"{OUT}/score-v1{'-v21' if '--v21' in sys.argv else '-v22'}.json"; json.dump(detail, open(p, "w"), indent=1); os.chmod(p, 0o600)
    print("consults scored:", len(detail), "| prompt", u9.PROMPT_VERSION)
    for f in FIELDS:
        hi = [ok for c, ok in conf[f] if c is not None and c >= 0.9]
        print(f"{f:17s} {hits[f]}/{n[f]} = {hits[f] / n[f]:.0%} | conf>=0.9: {sum(hi)}/{len(hi)} right | conf<0.9: {sum(ok for c, ok in conf[f] if c is not None and c < 0.9)}/{sum(1 for c, ok in conf[f] if c is not None and c < 0.9)} right")
    if "--v21" not in sys.argv:
        ok = [(sid, ctx_truth(sid, labels), detail[sid]["jev"]["context"]) for sid in sorted(detail) if ctx_truth(sid, labels)]
        print(f"context {sum(1 for _, v, jv in ok if jv[0] == v)}/{len(ok)} | confusion (V -> Jev):", dict(Counter((v, jv[0]) for _, v, jv in ok)))
        print("  context misses:", [(sid, v, jv[0], round(jv[1], 2)) for sid, v, jv in ok if jv[0] != v])
    tot_h, tot_n = sum(hits.values()), sum(n.values())
    print(f"ALL cells {tot_h}/{tot_n} = {tot_h / tot_n:.0%}")
    print("recommended confusion (V -> Jev):", dict(Counter((detail[s]['v']['recommended'], detail[s]['jev']['recommended'][0]) for s in detail)))
    print("firmness confusion (V -> Jev):", dict(Counter((detail[s]['v']['firmness'], detail[s]['jev']['firmness'][0]) for s in detail)))
    named_v = {s for s in detail if detail[s]["v_procedure_filled"]}
    print("procedure: V filled a procedure field for", len(named_v), "of", len(detail), "| Jev procedure_named>=0.5 on", sum(1 for s in detail if detail[s]['jev']['procedure_named'][0] == 'yes'))
    print("mismatch cells (id: field V->Jev@conf):")
    for s in sorted(detail):
        bad = [f"{f} {detail[s]['v'][f]}->{detail[s]['jev'][f][0]}@{detail[s]['jev'][f][1]:.2f}" for f in FIELDS if detail[s]["v"][f] is not None and detail[s]["jev"][f][0] != detail[s]["v"][f]]
        if bad:
            print(" ", s + ":", "; ".join(bad))


if __name__ == "__main__":
    main()
