#!/usr/bin/env python3
"""ship_v3.py — assemble the FINAL v3 set for Fable to seed: ~/eta-data/surgery-review-v3/ship/{consults/<id>.json, audio/<id>/...} with NEUTRAL ids (V3-01.. in a seeded shuffle, so an id says nothing about
source, bucket or placement), audio paths rewritten, and a PRIVATE key (ship-key.json, 0600, never shared) that maps each id back to the working id, token and room-day. Nothing is seeded here.
usage: ship_v3.py <dir:id> [<dir:id> ...]   e.g. final:Q06 final-trim:Q29     (dir is under ~/eta-data/surgery-review-v3)"""
import hashlib, json, os, random, shutil, subprocess, sys

V3 = os.path.expanduser("~/eta-data/surgery-review-v3"); OUT = f"{V3}/ship"


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def main(specs):
    shutil.rmtree(OUT, ignore_errors=True)
    for d in (OUT, f"{OUT}/consults", f"{OUT}/audio"):
        os.makedirs(d, mode=0o700, exist_ok=True)
    order = list(specs); random.Random(24092026).shuffle(order)
    key, files = {}, {}
    sel = {}
    for f in ("selected.json", "selected_cand.json", "selected_cand2.json", "selected_trim.json"):
        if os.path.exists(f"{V3}/{f}"):
            sel.update(json.load(open(f"{V3}/{f}")))
    for n, spec in enumerate(order, 1):
        d, q = spec.split(":"); nid = f"V3-{n:02d}"
        doc = json.load(open(f"{V3}/{d}/consults/{q}.json"))
        doc["id"] = nid
        for t in doc["turns"]:
            t["audio"] = [a.replace(f"audio/{q}/", f"audio/{nid}/") for a in t["audio"]]
        doc["audio_full"]["src"] = doc["audio_full"]["src"].replace(f"audio/{q}/", f"audio/{nid}/")
        doc.pop("meta", None)  # working facts (recall, probe counts) stay out of the shipped file
        os.makedirs(f"{OUT}/audio/{nid}", mode=0o700)
        wanted = {"full.mp3"} | {os.path.basename(a) for t in doc["turns"] for a in t["audio"]}  # ONLY files the doc references (clips of an earlier scoring must not ride along)
        for fn in sorted(wanted):
            shutil.copy(f"{V3}/{d}/audio/{q}/{fn}", f"{OUT}/audio/{nid}/{fn}"); os.chmod(f"{OUT}/audio/{nid}/{fn}", 0o600)
        p = f"{OUT}/consults/{nid}.json"; json.dump(doc, open(p, "w"), ensure_ascii=False, indent=1); os.chmod(p, 0o600)
        key[nid] = {"working_id": q, "dir": d, "token_uid": sel.get(q, {}).get("token_uid"), "room_day_id": sel.get(q, {}).get("room_day_id")}
        raw = open(p).read()
        assert not any(v and v in raw for v in (key[nid]["token_uid"], key[nid]["room_day_id"])), "a private id leaked into a shipped file"
        for t in doc["turns"]:
            for a in t["audio"]:
                assert os.path.exists(f"{OUT}/{a}"), a
        assert os.path.exists(f"{OUT}/{doc['audio_full']['src']}")
        on_disk = set(os.listdir(f"{OUT}/audio/{nid}")); assert on_disk == wanted, f"{nid}: files on disk differ from the doc's references: {sorted(on_disk ^ wanted)[:5]}"
        files[nid] = {"consult_sha256": sha(p), "full_audio_sha256": sha(f"{OUT}/{doc['audio_full']['src']}"), "clips": sum(1 for t in doc["turns"] if t["audio"])}
    json.dump(key, open(f"{V3}/ship-key.json", "w"), indent=1); os.chmod(f"{V3}/ship-key.json", 0o600)
    json.dump(files, open(f"{OUT}/manifest.json", "w"), indent=1); os.chmod(f"{OUT}/manifest.json", 0o600)
    mb = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs) / 1e6
    print("shipped", len(order), "consults ->", OUT, "|", round(mb, 1), "MB | ids", ", ".join(sorted(files)))


if __name__ == "__main__":
    main(sys.argv[1:])
