"""CAP-1: write the CAP INPUT BUNDLE for cap (scorer) from links + items + transcripts. Run after cap_extract.py and cap_link.py.
Bundle dir ~/eta-data/cap/2026-09-25/ (dir 0750, files 0640, group eta: the named exception, Fable 430 item 110). Contents (all box-only, patient text present in consult_transcripts.jsonl):
  links.jsonl              one row per consult: status (confirmed|probable|none), basis (TC|TCD|TCDM), room, score fractions, span; NO patient identity (opaque PQM token uid)
  items.jsonl              Pulse items with stable ids, class, alternatives (brand/generic), used_for_link (set here from the link basis), link_basis, link_status
  consult_transcripts.jsonl per LINKED consult: the room's segments overlapping the padded span: abs times, lang, engine, refused (+reason), native text, 337b English (+q), window ids
  gaps.jsonl               per window used: chunk coverage gaps (absolute intervals) from cut.chunks_used, covered_fraction, gap_s
  brand_generic_map.json   brand -> generic and generic -> brands from the Pulse drug master for the drug ids on these prescriptions
  README.md                schema + manifest; MANIFEST.sha256
"""
import collections, datetime as dt, hashlib, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cap_link as L
OUT = L.OUT
PAD_TRANSCRIPT_S = 60.0


def chunk_gaps(rec):
    t0, t1 = L.parse_t(rec["start"]), L.parse_t(rec["end"])
    iv = sorted((L.parse_t(c["started_at"]), L.parse_t(c["ended_at"])) for c in (rec.get("cut") or {}).get("chunks_used", []))
    gaps, cur = [], t0
    for a, b in iv:
        if a > cur + dt.timedelta(seconds=1):
            gaps.append((cur, min(a, t1)))
        cur = max(cur, b)
    if cur < t1 - dt.timedelta(seconds=1):
        gaps.append((cur, t1))
    return [(g0.isoformat(), g1.isoformat(), round((g1 - g0).total_seconds(), 1)) for g0, g1 in gaps if g1 > g0]


def main():
    windows = L.load_windows(); ann = L.load_english(); segs = L.segments(windows, ann)
    by_room = collections.defaultdict(list)
    for s in segs:
        by_room[s["room"]].append(s)
    links = [json.loads(l) for l in open(OUT + "links.jsonl")]
    items = [json.loads(l) for l in open(OUT + "items.jsonl")]
    lk = {l["consult_id"]: l for l in links}
    terms = json.load(open(L.RAW + "link_terms.json")) if os.path.exists(L.RAW + "link_terms.json") else {}
    IND = {"kn", "hi", "ta", "ml", "bn", "gu", "te", "mr"}
    for it in items:
        l = lk.get(it["consult_id"]); it["link_status"] = l["status"] if l else "none"; it["link_basis"] = l["basis"] if l else None
        # used_for_link (eta-refuter-2 #3491.3): ANY item whose words hit the term set that MADE its consult's link (matched complaint, name, diagnosis and drug words)
        made = terms.get(it["consult_id"], []) if l and l["status"] != "none" else []
        words = set(L.toks(it["text"])) | {t for a in it.get("alt", []) for t in L.toks(a)}
        it["used_for_link"] = bool(made and any(t in words or L.fuzzy_hit(t, sorted(words)) for t in made))
    used_windows = set()
    with open(OUT + "consult_transcripts.jsonl", "w") as f:
        for l in links:
            if l["status"] == "none":
                continue
            a = L.parse_t(l["span"][0]) - dt.timedelta(seconds=PAD_TRANSCRIPT_S - L.PAD_S); b = L.parse_t(l["span"][1]) + dt.timedelta(seconds=PAD_TRANSCRIPT_S - L.PAD_S)
            rows = []; ind = miss = 0
            for s in by_room[l["room"]]:
                if s["t1"] < a or s["t0"] > b:
                    continue
                used_windows.add(s["window_id"])
                if s["lang"] in IND:
                    ind += 1; miss += 1 if s["en"] is None else 0
                rows.append(dict(window_id=s["window_id"], seg_index=s["i"], t0=s["t0"].isoformat(), t1=s["t1"].isoformat(), lang=s["lang"], engine=s["engine"], refused=s["refused"],
                                 refused_reason=s["refused_reason"], text_native=s["text"], text_en=s["en"], en_q=s["q"]))
            l["n_indic_segments"] = ind; l["n_indic_without_english"] = miss; l["translation_missing"] = miss > 0
            f.write(json.dumps(dict(consult_id=l["consult_id"], room=l["room"], status=l["status"], basis=l["basis"], span=[a.isoformat(), b.isoformat()], segments=rows), ensure_ascii=False) + "\n")
    with open(OUT + "links.jsonl", "w") as f:
        for l in links:
            f.write(json.dumps(l) + "\n")
    with open(OUT + "gaps.jsonl", "w") as f:
        for wid in sorted(used_windows):
            rec = windows[wid]["rec"]
            f.write(json.dumps(dict(window_id=wid, room=rec["room_id"], start=rec["start"], end=rec["end"], covered_fraction=(rec.get("cut") or {}).get("covered_fraction"),
                                    gap_s=(rec.get("cut") or {}).get("gap_s"), chunk_gaps=chunk_gaps(rec), note="chunk coverage only: no VAD gap data in the record")) + "\n")
    with open(OUT + "items.jsonl", "w") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    m = json.load(open(L.HOME + "cap/raw/drug_master.json")); c = m["cols"]
    b2g, g2b = collections.defaultdict(set), collections.defaultdict(set)
    for r in m["rows"]:
        d = dict(zip(c, r))
        if d.get("brand_name") and d.get("generic_name"):
            b2g[d["brand_name"].strip().lower()].add(d["generic_name"].strip().lower()); g2b[d["generic_name"].strip().lower()].add(d["brand_name"].strip().lower())
    json.dump(dict(brand_to_generic={k: sorted(v) for k, v in b2g.items()}, generic_to_brands={k: sorted(v) for k, v in g2b.items()}, source="Pulse medicines master, ids on the day's prescriptions"), open(OUT + "brand_generic_map.json", "w"))
    cnt = collections.Counter((l["status"], l["basis"]) for l in links)
    open(OUT + "README.md", "w").write(
        "CAP-1 input bundle (linker, 26 Sep 2026) for the 25 Sep audit. Box only. Patient text is in consult_transcripts.jsonl only.\n"
        "links.jsonl: one row per completed PQM consult; status confirmed|probable|none; basis TC|TCD|TCDM (see cap_link.py in studies/2026-09-26-clinical-capture); scores are matched-idf fractions.\n"
        "items.jsonl: item_id (12 hex, stable), consult_id, rx_uid, cls (drug|dose|diagnosis|investigation|advice|followup|referral), text, alt (brand/generic names), used_for_link, link_status, link_basis.\n"
        "consult_transcripts.jsonl: per linked consult, the room's segments overlapping [called-60s, completed+60s]: window_id, seg_index, t0/t1 (ISO), lang, engine, refused(+reason), text_native, text_en (337b gloss where it exists), en_q (ok|garbled|untranslatable|mt_failed|null).\n"
        "gaps.jsonl: chunk coverage gaps per window (absolute intervals; there is no VAD gap data in the records). brand_generic_map.json: Pulse master pairs.\n"
        "RULES: prescription content is used ONLY to score; never in any prompt, glossary or correction for 25-26 Sep. English = 337b gloss (gemini-3.8-flash); a term missing in English may be lost by 337b, not by STT.\n"
        f"link counts: {dict((str(k), v) for k, v in cnt.items())}\n")
    files = sorted(fn for fn in os.listdir(OUT) if fn not in ("MANIFEST.sha256",) and os.path.isfile(OUT + fn))
    with open(OUT + "MANIFEST.sha256", "w") as f:
        for fn in files:
            f.write(hashlib.sha256(open(OUT + fn, "rb").read()).hexdigest() + "  " + fn + "\n")
    os.chmod(OUT, 0o750)
    for fn in os.listdir(OUT):
        os.chmod(OUT + fn, 0o640)
    print("bundle written:", files, "| linked consults", sum(1 for l in links if l["status"] != "none"), "| windows used", len(used_windows))


if __name__ == "__main__":
    main()
