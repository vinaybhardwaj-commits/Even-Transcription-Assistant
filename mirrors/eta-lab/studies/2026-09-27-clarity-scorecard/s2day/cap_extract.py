"""CAP-1 step 2 (EXTRACT): structured items from the Pulse prescriptions (dpipe_prescription_pipeline and its child tables) of the PQM consults of one day.
Read-only Metabase (via studies/2026-09-24-surgery-30/mb.py; the key is never printed). Output (box only, 0600): ~/eta-data/cap/raw/ (pulls) and ~/eta-data/cap/2026-09-25/items.jsonl
(stable item ids; class in drug | dose | diagnosis | investigation | advice | referral | followup). Patient identity is not pulled: a consult is its opaque PQM token uid.
Prescription text is used ONLY to score (CAP-1 hard rule); nothing here feeds a transcript, prompt, glossary or correction.
"""
import csv, hashlib, json, os, re, sys, collections
HOME = os.path.expanduser("~/eta-data/")
DAY = os.environ.get("CAP_DAY", "2026-09-25"); TAG = os.environ.get("CAP_TAG", "")     # W33.4b: the day is a parameter; 25 Sep with no tag is exactly CAP-1
if DAY == "2026-09-25" and not TAG:
    RAW, OUT, ROWS = HOME + "cap/raw/", HOME + "cap/2026-09-25/", HOME + "encounter-truth/rows.csv"
else:
    RAW, OUT, ROWS = HOME + f"cap/raw-{DAY}{TAG}/", HOME + f"cap/{DAY}{TAG}/", HOME + f"cap/{DAY}{TAG}/rows.csv"
if not TAG and os.path.exists(OUT + "MANIFEST.sha256"):                                # eta-refuter-2 #4680: generic, not hardcoded to 25 Sep - any bundled+frozen day refuses an untagged overwrite
    raise SystemExit(f"refused: {OUT} already has a MANIFEST.sha256 (a frozen bundle); set CAP_TAG for a check run")


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def item_id(consult, cls, text):
    return hashlib.sha1(f"{consult}|{cls}|{norm(text).lower()}".encode()).hexdigest()[:12]


def load(name):
    d = json.load(open(RAW + name + ".json")); c = d["cols"]
    return [dict(zip(c, r)) for r in d["rows"]]


def advice_atoms(text):
    """Split an advice or plan text into short atoms (sentence or bullet level), keeping only atoms with at least 3 characters of letters."""
    out = []
    for part in re.split(r"[\n\r]+|(?<=[.;])\s+|\s*[•\-\*]\s+", text or ""):
        p = norm(part.strip(" .;-*•"))
        if len(re.sub(r"[^A-Za-z]", "", p)) >= 3:
            out.append(p)
    return out


def build():
    rows = [r for r in csv.DictReader(open(ROWS)) if r["day"] == DAY]
    consult_of_rx = {}
    for r in rows:
        for u in re.split(r"[;|, ]+", r["rx_uids"]):
            if u:
                consult_of_rx[u] = r["token_uid"]
    main = {m["_id"]: m for m in load("dpipe_main")}
    by_rx = {m["presc_uid"]: m for m in main.values()}
    meds = collections.defaultdict(list); dgs = collections.defaultdict(list); inv = collections.defaultdict(list); ref = collections.defaultdict(list); plan = collections.defaultdict(list)
    for x in load("dpipe_prescription_pipeline__medicines"): meds[x["_parent_id"]].append(x)
    for x in load("dpipe_prescription_pipeline__diagnosis"): dgs[x["_parent_id"]].append(x)
    for x in load("dpipe_prescription_pipeline__further_investigation"): inv[x["_parent_id"]].append(x)
    for x in load("dpipe_prescription_pipeline__referral"): ref[x["_parent_id"]].append(x)
    for x in load("dpipe_prescription_pipeline__plan_of_management"): plan[x["_parent_id"]].append(x)
    master = {}
    if os.path.exists(RAW + "drug_master.json"):
        d = json.load(open(RAW + "drug_master.json")); c = d["cols"]
        master = {r[0]: dict(zip(c, r)) for r in d["rows"]}
    items, seen = [], set()

    def add(consult, rx, cls, text, **kw):
        text = norm(text)
        if not text:
            return
        iid = item_id(consult, cls, text)
        if iid in seen:
            return
        seen.add(iid)
        items.append(dict(item_id=iid, consult_id=consult, rx_uid=rx, cls=cls, text=text, used_for_link=False, **kw))
    for rx_uid, m in by_rx.items():
        if m.get("presc_is_draft"):
            continue
        consult = consult_of_rx.get(rx_uid)
        if not consult:
            continue
        pid = m["_id"]
        for x in meds[pid]:
            mm = master.get(x.get("uid") or "", {})
            names = [n for n in (x.get("name"), mm.get("brand_name"), mm.get("generic_name")) if n]
            add(consult, rx_uid, "drug", x.get("name"), alt=sorted({norm(n) for n in names}), strength=x.get("strength"))
            dose = " ".join(str(v) for v in (x.get("strength"), x.get("dosage"), x.get("frequency"), x.get("duration")) if v)
            if dose:
                add(consult, rx_uid, "dose", f"{x.get('name')}: {dose}", drug=norm(x.get("name")), dosage=x.get("dosage"), frequency=x.get("frequency"), duration=x.get("duration"))
        for x in dgs[pid]:
            add(consult, rx_uid, "diagnosis", x.get("diagnosis"), icd=x.get("icd_code"))
        for x in plan[pid]:
            if x.get("diagnosis__diagnosis_or_impression"):
                add(consult, rx_uid, "diagnosis", x["diagnosis__diagnosis_or_impression"], icd=x.get("diagnosis__icd_code"))
            for f in ("diagnosis__general_advice", "diagnosis__treatment_plan", "management_plan"):
                for a in advice_atoms(x.get(f)):
                    add(consult, rx_uid, "advice", a, field=f)
        for x in inv[pid]:
            add(consult, rx_uid, "investigation", x.get("name"), lab_type=x.get("lab_type"))
        for x in ref[pid]:
            add(consult, rx_uid, "referral", x.get("referral_specialist"))
        if m.get("follow_up_type") or m.get("follow_up_date"):
            add(consult, rx_uid, "followup", f"{m.get('follow_up_type') or ''} {m.get('follow_up_date') or ''}")
    return rows, items, main


def main():
    rows, items, main_ = build()
    os.makedirs(OUT, exist_ok=True)
    with open(OUT + "items.jsonl", "w") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    os.chmod(OUT + "items.jsonl", 0o600)
    c = collections.Counter(i["cls"] for i in items)
    print("consults", len(rows), "rx", len(main_), "items", len(items), dict(c), "consults with items", len({i['consult_id'] for i in items}))


if __name__ == "__main__":
    main()
