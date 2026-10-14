#!/usr/bin/env python3
"""Build the seed_docs.json for the "pitch25" rating set (W46/W49, surg-link's PITCH-SCHEMA-SPEC.md) from surg-link's own files.

  build_seed.py --detail ~/eta-data/surg-link/review-list-detail-deid.json --reasons ~/eta-data/surg-link/review-list.jsonl \
                --raw ~/eta-data/surg-link/review-list-detail.json --out ~/eta-data/surg-link/pitch25

  --detail   MUST be the DE-IDENTIFIED file (review-list-detail-deid.json), never review-list-detail.json (the raw file with real
             patient identifiers). Checks, per eta-refuter-2 #4809/#4822 (D1+D2, both closed):
             (1) refuses the exact filename review-list-detail.json outright.
             (2) refuses if NO turn anywhere in the whole file carries a redaction tag (whole-file, coarse - kept as a cheap
                 first check, superseded by (3) for anything (2) alone would have missed).
             (3) requires EVERY consult to carry deid_version/raw_sha256/turns_processed (surg-link's add_deid_provenance.py),
                 recomputes raw_sha256 from --raw using the exact fingerprint rule (per turn: (text_native or "")+"\x00"+
                 (text_en or ""), joined "\x1e", utf8, sha256) and refuses on any mismatch, missing raw counterpart, or
                 turns_processed != len(turns). This is what actually proves the de-identified turns are a transform of the
                 raw content, not a substitute or a stale copy - not just "some turn somewhere has a tag".
  --reasons  review-list.jsonl (keyword-hit reason per consult_id; matched by consult_id).
  --raw      review-list-detail.json (the raw file) - required to verify (3) above.
  --out      writes seed_docs.json ({"rows": [...]}), 0700 dir / 0600 file.

Then load it the normal way: kit/lab-viewer/tools/rate_seed.py load --set pitch25 --file <out>/seed_docs.json
(refuses to replace an existing rate-seed/pitch25.json - a new batch needs a new set name and a ruling, same as every set).
Prints only counts, never row content."""
import argparse, hashlib, json, os, sys
from pathlib import Path

REDACTION_TAGS = ("[PATIENT_NAME]", "[PHONE]", "[ID]", "[ADDRESS]", "[DOB]", "[EMAIL]")
RAW_BASENAME = "review-list-detail.json"   # the raw file's own name - eta-refuter-2 #4809 (D2): cheap, explicit, no reliance on file content
FIELDS = ["pitched_surgery", "pitched_intervention", "procedure_family", "doctor_recommended", "patient_agreed", "patient_deferred"]


def fingerprint(turns):
    """Exact match to surg-link's pitch/add_deid_provenance.py - do not change without changing that file too (eta-refuter-2 #4822 verified this rule)."""
    parts = [(t.get("text_native") or "") + "\x00" + (t.get("text_en") or "") for t in (turns or [])]
    return hashlib.sha256("\x1e".join(parts).encode("utf-8")).hexdigest()


def build(detail_path, reasons_path, raw_path, out_dir):
    if Path(detail_path).name == RAW_BASENAME:
        sys.exit(f"{detail_path}: refusing - this filename is the RAW file's own name ({RAW_BASENAME}), not the de-identified one "
                 "(review-list-detail-deid.json expected). eta-refuter-2 #4809 (D2).")
    detail = json.loads(Path(detail_path).read_text())
    if not isinstance(detail, list) or not detail:
        sys.exit(f"{detail_path}: expected a non-empty JSON list")
    reasons = {}
    for line in Path(reasons_path).read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        reasons[r["consult_id"]] = r.get("reason", "")

    all_text = "\n".join(t.get("text_en") or t.get("text_native") or "" for c in detail for t in (c.get("turns") or []))
    if all_text and not any(tag in all_text for tag in REDACTION_TAGS):
        sys.exit(f"{detail_path}: no redaction tags ({', '.join(REDACTION_TAGS)}) found anywhere in the transcripts - "
                 "refusing, in case this is the RAW (non-de-identified) file, not review-list-detail-deid.json. "
                 "If every one of these consults genuinely has nothing to redact, override this check by hand; do not silence it blindly.")

    # eta-refuter-2 #4809/#4822 (D1): the whole-file tag scan above can't tell "de-id ran and found nothing to redact in
    # this turn" from "de-id never touched this turn" - require every consult to PROVE it, against the actual raw file.
    raw_by_id = {}
    for c in json.loads(Path(raw_path).read_text()):
        cid = c.get("consult_id")
        if cid:
            raw_by_id[cid] = c
    for c in detail:
        cid = c.get("consult_id")
        dv, rsha, tp = c.get("deid_version"), c.get("raw_sha256"), c.get("turns_processed")
        if not isinstance(dv, dict) or not dv or not isinstance(rsha, str) or not rsha or not isinstance(tp, int):
            sys.exit(f"{cid}: missing deid_version/raw_sha256/turns_processed - refusing (eta-refuter-2 #4809 D1: "
                     "every consult must prove de-id ran over it, not just some turn somewhere in the file having a tag)")
        n_turns = len(c.get("turns") or [])
        if tp != n_turns:
            sys.exit(f"{cid}: turns_processed={tp} != {n_turns} turns in the de-identified file - refusing (a turn may have been silently dropped or added since de-id ran)")
        raw_c = raw_by_id.get(cid)
        if raw_c is None:
            sys.exit(f"{cid}: no matching consult in the raw file ({raw_path}) - cannot verify raw_sha256, refusing")
        want = fingerprint(raw_c.get("turns"))
        if want != rsha:
            sys.exit(f"{cid}: raw_sha256 mismatch (recomputed {want[:12]}... != claimed {rsha[:12]}...) - the de-identified "
                     "turns do not match this raw file's turns, refusing")

    rows = []
    for c in detail:
        cid = c.get("consult_id")
        if not cid:
            continue
        turns = [{"i": i, "lang": t.get("lang") or "und", "text": t.get("text_en") or t.get("text_native") or ""} for i, t in enumerate(c.get("turns") or [])]
        jev_src = c.get("jev_proposals") or {}
        jev = {}
        for k in FIELDS:
            f = jev_src.get(k) or {}
            jev[k] = {"value": f.get("value", ""), "p_yes": f.get("p_yes")}
        rows.append({
            "id": str(cid)[:40], "day": str(c.get("day", ""))[:12], "reason": reasons.get(cid, "")[:240],
            "link_status": c.get("link_status") if c.get("link_status") in ("confirmed", "probable") else "",
            "turns": turns, "jev": jev,
        })
    if len({r["id"] for r in rows}) != len(rows):
        sys.exit("duplicate consult_id across rows")

    os.umask(0o077)
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True); out.chmod(0o700)
    p = out / "seed_docs.json"
    p.write_text(json.dumps({"rows": rows}, ensure_ascii=False)); p.chmod(0o600)
    print(f"built {len(rows)} rows -> {p}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--detail", required=True); ap.add_argument("--reasons", required=True); ap.add_argument("--raw", required=True); ap.add_argument("--out", required=True)
    a = ap.parse_args()
    build(a.detail, a.reasons, a.raw, a.out)
