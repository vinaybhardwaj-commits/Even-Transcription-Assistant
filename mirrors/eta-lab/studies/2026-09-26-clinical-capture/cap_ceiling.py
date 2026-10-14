"""CAP-1 step 4 (CEILING CHECK). For a random 60 ABSENT items, ask Gemini to LISTEN to the consult's audio: 'was <term> said aloud?', with DECOY terms in the same call
(real drug, diagnosis, investigation and advice terms that are NOT on that consult's prescription, matched in class and frequency; question order shuffled; Gemini is blind to which is which).
Both rates are reported: yes on targets ('said but we lost it') and yes on decoys (the false-yes rate that the first rate must be read against).
Scoring-only: outputs stay in ~/eta-data/cap/ceiling/ (0700) and are never written where a transcript, prompt, glossary or correction reads (CAP-1 hard rule).
The Gemini call sends patient AUDIO out: run `run` from V's terminal (the Claude pane guard blocks external sends of patient data), after eta-refuter-2 has reviewed this file.
Targets are drawn from CONFIRMED links only; the draw and the score STATE the held-out confirmed false-link rate (eta-refuter-2 #3532: 1.0-3.6%, shifts NOT used to tune; the in-sample 0.9% is withdrawn for reporting).

  commit  --list-sha S --salt-file F      make a private salt and print C = sha256(salt || S): post C BEFORE drawing
  draw    --absent-ids FILE --list-sha S --salt-file F --commit C     verify C, draw 60 ABSENT items, build decoys, rebuild audio (local, from the box tape), write jobs.jsonl + key.jsonl
  run     --route openrouter|cmd:<command>   ask the model per job; writes answers.jsonl        (patient audio leaves the box)
  score                                     join answers with the key: yes/no/unclear on targets and on decoys, by class
  selftest                                  invented data only, no network
"""
import argparse, base64, collections, hashlib, json, os, random, re, subprocess, sys, tempfile
HOME = os.path.expanduser("~/eta-data/")
BUNDLE, CEIL = HOME + "cap/2026-09-25/", HOME + "cap/ceiling/"
TAPES = HOME + "tapes/"
N_TARGETS = 60
PIN_CUT = "0fb0eed981de2a48"; PIN_FULL = "cf06ca69f8075e60"          # sha256 prefixes of the frozen cut_window.py and full_audio.py (PARITY-389 pins)
HARNESS = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-hist-mining/harness/cut_window.py")
FULLAUDIO = os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2/full_audio.py")
PAD_S = 60.0
HELDOUT_CONFIRMED_FALSE = (0.010, 0.036)   # held-out wrong-time control, confirmed false-link (eta-refuter-2 #3532, shifts NOT used to tune); the in-sample 0.9% is withdrawn for reporting
PROMPT = ("You are given the audio of a doctor-patient consultation in an Indian clinic (English, Kannada, Hindi, Tamil, Malayalam, Telugu or a mix). For each numbered term below, decide whether the "
          "term was said aloud in the consultation: the same word, a brand or generic equivalent, or a clear translation or transliteration counts. Do not guess from context: answer \"no\" if it was not spoken "
          "and \"unclear\" if you cannot tell. Reply with JSON only: {\"<number>\": {\"said\": \"yes\"|\"no\"|\"unclear\", \"at_s\": <seconds from the start of the audio or null>}, ...} for every number.\n\nTerms:\n")


def norm(s): return re.sub(r"\s+", " ", (s or "").strip().lower())
def sha(b): return hashlib.sha256(b).hexdigest()
def list_sha(ids): return sha(json.dumps(sorted(set(ids))).encode())           # THE definition of the ABSENT-list sha: sha256 of the sorted JSON list of unique item ids
def manifest_sha(): return sha(open(BUNDLE + "MANIFEST.sha256", "rb").read())


def commit_value(salt_hex, list_sha): return sha((salt_hex + list_sha).encode())


def seed_of(salt_hex, list_sha): return int(sha(("seed|" + salt_hex + list_sha).encode()), 16)


def bucket(n): return 1 if n <= 1 else (2 if n <= 3 else 3)


def draw_targets(absent_ids, salt_hex, list_sha, n=N_TARGETS):
    ids = sorted(set(absent_ids))
    rng = random.Random(seed_of(salt_hex, list_sha))
    return sorted(rng.sample(ids, min(n, len(ids))))


def build_questions(target_ids, items, salt_hex, list_sha):
    """Per consult: its targets + one matched decoy per target, shuffled. Returns (jobs {consult: [(qid_text, term, alts)]}, key rows)."""
    rng = random.Random(seed_of(salt_hex, list_sha) ^ 0xC0FFEE)
    by_id = {i["item_id"]: i for i in items}
    consult_terms = collections.defaultdict(set)
    freq = collections.Counter()
    for i in items:
        consult_terms[i["consult_id"]].add(norm(i["text"]))
        for a in i.get("alt", []): consult_terms[i["consult_id"]].add(norm(a))
    for (cls, txt), cs in collections.Counter((i["cls"], norm(i["text"])) for i in items).items(): freq[(cls, txt)] = cs
    pool = collections.defaultdict(list)
    for i in items:
        pool[i["cls"]].append(i)
    per = collections.defaultdict(list); key = []
    for tid in target_ids:
        t = by_id[tid]; c = t["consult_id"]
        per[c].append(dict(role="target", item=t))
        cand = [d for d in pool[t["cls"]] if d["consult_id"] != c and norm(d["text"]) not in consult_terms[c] and not (set(norm(a) for a in d.get("alt", [])) & consult_terms[c])]
        same = [d for d in cand if bucket(freq[(d["cls"], norm(d["text"]))]) == bucket(freq[(t["cls"], norm(t["text"]))])] or cand
        if same:
            per[c].append(dict(role="decoy", item=rng.choice(sorted(same, key=lambda d: d["item_id"])), matched=tid))
    jobs = {}
    for c, qs in per.items():
        rng.shuffle(qs)
        jobs[c] = []
        for n, q in enumerate(qs, 1):
            it = q["item"]; alts = [a for a in it.get("alt", []) if norm(a) != norm(it["text"])]
            term = it["text"] + (f" (also: {', '.join(alts)})" if alts else "")
            jobs[c].append((str(n), term))
            key.append(dict(consult_id=c, qid=str(n), role=q["role"], item_id=it["item_id"], cls=it["cls"], matched_target=q.get("matched")))
    return jobs, key


def parse_answers(content, qids):
    try:
        j = json.loads(content)
    except Exception:
        return {q: dict(said="unparsed", at_s=None) for q in qids}
    out = {}
    for q in qids:
        v = j.get(q) if isinstance(j, dict) else None
        s = (v or {}).get("said") if isinstance(v, dict) else None
        out[q] = dict(said=s if s in ("yes", "no", "unclear") else "unparsed", at_s=(v or {}).get("at_s") if isinstance(v, dict) else None)
    return out


def score(key, answers):
    """key rows + answers {(consult, qid): said} -> counts by role and class."""
    c = collections.defaultdict(collections.Counter)
    for k in key:
        s = answers.get((k["consult_id"], k["qid"]), "missing")
        c[k["role"]][s] += 1; c[k["role"] + ":" + k["cls"]][s] += 1
    rate = lambda cn, v: (cn[v] / max(sum(cn.values()), 1))
    tgt, dec = c["target"], c["decoy"]
    return dict(counts={r: dict(v) for r, v in c.items()}, target_yes=round(rate(tgt, "yes"), 3), decoy_yes=round(rate(dec, "yes"), 3), target_no=round(rate(tgt, "no"), 3),
                target_unclear=round(rate(tgt, "unclear"), 3), decoy_no=round(rate(dec, "no"), 3), excess_yes_over_decoys=round(rate(tgt, "yes") - rate(dec, "yes"), 3))


# ---- audio (local; the box tape) ----
def consult_audio(consult_id, link, out_mp3):
    """Rebuild the consult's audio from the hourly tape pull with the frozen cut_window harness (read-only import), then encode mp3 mono 16 kHz 32 kbps."""
    for path, pin in ((HARNESS, PIN_CUT), (FULLAUDIO, PIN_FULL)):                      # the frozen harness, pinned: refuse on any difference before importing it
        if sha(open(path, "rb").read())[:16] != pin:
            raise SystemExit(f"refused: {os.path.basename(path)} does not match its pin")
    sys.path.insert(0, os.path.dirname(HARNESS))
    import cut_window as cw
    from datetime import datetime, timedelta
    a = datetime.fromisoformat(link["span"][0]) - timedelta(seconds=PAD_S - 30); b = datetime.fromisoformat(link["span"][1]) + timedelta(seconds=PAD_S - 30)
    rows, files = [], {}
    for l in open(TAPES + "manifest.jsonl"):
        r = json.loads(l)
        if r["room_id"] != link["room"]:
            continue
        s = datetime.fromisoformat(r["started_at"].replace("Z", "+00:00")); e = s + timedelta(milliseconds=r["duration_ms"])
        if e <= a or s >= b:
            continue
        r = dict(r, ended_at=e.isoformat().replace("+00:00", "Z"), upload_state="verified"); rows.append(r); files[r["id"]] = TAPES + r["path"]
    if not rows:
        raise RuntimeError("no tape chunks for this consult span")
    webm = out_mp3[:-4] + ".webm"
    rep = cw.cut(rows, a, b, webm, files)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", webm, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", out_mp3], check=True); os.remove(webm); os.chmod(out_mp3, 0o600)
    return rep


# ---- routes ----
def ask_openrouter(audio_path, terms):
    import urllib.request
    key = open(os.path.expanduser(os.environ.get("OPENROUTER_KEY_FILE", "~/.claude/secrets/openrouter_api_key"))).read().strip()
    b = base64.b64encode(open(audio_path, "rb").read()).decode()
    text = PROMPT + "\n".join(f"{q}. {t}" for q, t in terms)
    body = {"model": "google/gemini-3.8-flash", "temperature": 0, "provider": {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [{"type": "text", "text": text}, {"type": "input_audio", "input_audio": {"data": b, "format": "mp3"}}]}]}
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    r = json.load(urllib.request.urlopen(req, timeout=300))
    if r.get("model") != "google/gemini-3.8-flash":
        raise RuntimeError("returned model differs")
    return r["choices"][0]["message"]["content"], r.get("provider")


def ask_cmd(cmd, audio_path, terms):
    """External wrapper (for example a Vertex wrapper on the Air): stdin = JSON {audio_b64, prompt, terms}, stdout = the model's JSON reply text."""
    payload = json.dumps(dict(audio_b64=base64.b64encode(open(audio_path, "rb").read()).decode(), prompt=PROMPT + "\n".join(f"{q}. {t}" for q, t in terms), terms=terms))
    r = subprocess.run(cmd, shell=True, input=payload, capture_output=True, text=True, timeout=600)
    if r.returncode:
        raise RuntimeError(f"wrapper rc {r.returncode}")
    return r.stdout, "wrapper"


def cmd_commit(a):
    os.makedirs(CEIL, mode=0o700, exist_ok=True)
    if os.path.exists(a.salt_file):
        raise SystemExit("refused: the salt file already exists")
    salt = os.urandom(32).hex()
    fd = os.open(a.salt_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, salt.encode()); os.close(fd)
    print("commit (post this BEFORE drawing):", commit_value(salt, a.list_sha))


def cmd_draw(a):
    salt = open(a.salt_file).read().strip()
    if commit_value(salt, a.list_sha) != a.commit:
        raise SystemExit("refused: the commit does not match the salt and list sha")
    ids = json.load(open(a.absent_ids))
    if list_sha(ids) != a.list_sha:
        raise SystemExit("refused: the ABSENT id list does not hash to the committed list sha (sha256 of the sorted JSON list of unique ids)")
    items = [json.loads(l) for l in open(BUNDLE + "items.jsonl")]
    links = {l["consult_id"]: l for l in (json.loads(x) for x in open(BUNDLE + "links.jsonl"))}
    by_item = {i["item_id"]: i for i in items}
    eligible = [i for i in ids if i in by_item and links.get(by_item[i]["consult_id"], {}).get("status") == "confirmed"]      # CONFIRMED links only (eta-refuter-2 #3506.2)
    n_confirmed = sum(1 for l in links.values() if l.get("status") == "confirmed")
    lo, hi = HELDOUT_CONFIRMED_FALSE; exp_false = [round(lo * len(links), 1), round(hi * len(links), 1)]                      # expected false confirmed links over the link rows (the link_thresholds formula)
    targets = draw_targets(eligible, salt, a.list_sha)
    jobs, key = build_questions(targets, items, salt, a.list_sha)
    os.makedirs(CEIL + "audio", mode=0o700, exist_ok=True)
    with open(CEIL + "jobs.jsonl", "w") as f:
        for c, terms in sorted(jobs.items()):
            p = CEIL + f"audio/{c}.mp3"
            try:
                consult_audio(c, links[c], p)
            except Exception as e:
                print("audio failed for a consult:", type(e).__name__, file=sys.stderr); continue
            f.write(json.dumps(dict(consult_id=c, audio=p, terms=terms)) + "\n")
    with open(CEIL + "key.jsonl", "w") as f:
        for k in key: f.write(json.dumps(k) + "\n")
    json.dump(dict(targets=targets, list_sha=a.list_sha, commit=a.commit, n_absent_in_list=len(set(ids)), n_eligible_confirmed=len(eligible), n_targets=len(targets), n_consults=len(jobs), bundle_manifest_sha=manifest_sha(),
                confirmed_only=True, n_confirmed_links=n_confirmed, confirmed_false_rate=f"held-out {lo:.1%}-{hi:.1%} (eta-refuter-2 #3532, shifts NOT used to tune; in-sample 0.9% withdrawn)", expected_false_confirmed=exp_false), open(CEIL + "draw.json", "w"))
    for fn in ("jobs.jsonl", "key.jsonl", "draw.json"): os.chmod(CEIL + fn, 0o600)
    print(f"targets from CONFIRMED links only: {n_confirmed} confirmed; held-out confirmed false-link {lo:.1%}-{hi:.1%} (eta-refuter-2 #3532): expect ~{exp_false[0]:.0f}-{exp_false[1]:.0f} false;", "drawn", len(targets), "targets over", len(jobs), "consults; decoys", sum(1 for k in key if k["role"] == "decoy"))


def check_bundle_unchanged():
    d = json.load(open(CEIL + "draw.json"))
    if d.get("bundle_manifest_sha") != manifest_sha():
        raise SystemExit("refused: the bundle MANIFEST changed after the draw")
    return d


def cmd_run(a):
    check_bundle_unchanged()
    out = open(CEIL + "answers.jsonl", "a"); os.chmod(CEIL + "answers.jsonl", 0o600)
    done = {json.loads(l)["consult_id"] for l in open(CEIL + "answers.jsonl")} if os.path.getsize(CEIL + "answers.jsonl") else set()
    for l in open(CEIL + "jobs.jsonl"):
        j = json.loads(l)
        if j["consult_id"] in done:
            continue
        ask = ask_openrouter if a.route == "openrouter" else (lambda p, t: ask_cmd(a.route[4:], p, t))
        content, prov = ask(j["audio"], j["terms"])
        ans = parse_answers(content, [q for q, _ in j["terms"]])
        out.write(json.dumps(dict(consult_id=j["consult_id"], provider=prov, answers=ans)) + "\n"); out.flush()
    print("done")


def cmd_score(a):
    d = check_bundle_unchanged()
    key = [json.loads(l) for l in open(CEIL + "key.jsonl")]
    ans = {}
    for l in open(CEIL + "answers.jsonl"):
        j = json.loads(l)
        for q, v in j["answers"].items(): ans[(j["consult_id"], q)] = v["said"]
    res = score(key, ans)
    n_run = len({j for j, _ in ans})
    res.update(n_targets_drawn=d["n_targets"], n_consults_drawn=d["n_consults"], n_consults_answered=n_run, n_questions=len(key), n_answered=sum(1 for k in key if (k["consult_id"], k["qid"]) in ans),
               n_unparsed=sum(1 for v in ans.values() if v == "unparsed"), n_missing=sum(1 for k in key if (k["consult_id"], k["qid"]) not in ans),
               confirmed_only=d.get("confirmed_only", True), n_confirmed_links=d.get("n_confirmed_links"), confirmed_false_rate=d.get("confirmed_false_rate"), expected_false_confirmed=d.get("expected_false_confirmed"),
               note="decoys are other consults' real prescription terms: a decoy may truly have been said, so the decoy yes rate is an UPPER bound on the false-yes rate")
    json.dump(res, open(CEIL + "ceiling_result.json", "w"), indent=1); os.chmod(CEIL + "ceiling_result.json", 0o600)
    print(json.dumps(res))


def selftest():
    lo, hi = HELDOUT_CONFIRMED_FALSE; assert round(lo * 183, 1) == 1.8 and round(hi * 183, 1) == 6.6      # refuter-2 #3532: expect ~2-6 false confirmed links over 183 link rows
    items = []
    for c in range(1, 41):
        for n, (cls, txt) in enumerate((("drug", f"drugname{c % 7}"), ("diagnosis", f"dx{c % 5}"), ("advice", f"advice text {c}"))):
            items.append(dict(item_id=f"{c:02d}{n}", consult_id=f"c{c}", cls=cls, text=txt, alt=[f"alt{txt}"] if cls == "drug" else []))
    absent = [i["item_id"] for i in items][::2]
    salt = "ab" * 32; ls = sha(json.dumps(sorted(absent)).encode())
    t1 = draw_targets(absent, salt, ls, 10); t2 = draw_targets(absent, salt, ls, 10)
    assert t1 == t2 and len(t1) == 10 and set(t1) <= set(absent)
    assert draw_targets(absent, "cd" * 32, ls, 10) != t1                                   # a different salt draws differently
    assert commit_value(salt, ls) != commit_value("cd" * 32, ls)
    jobs, key = build_questions(t1, items, salt, ls)
    by = {i["item_id"]: i for i in items}
    for k in key:
        if k["role"] == "decoy":
            tgt = by[k["matched_target"]]; d = by[k["item_id"]]
            assert d["cls"] == tgt["cls"] and d["consult_id"] != tgt["consult_id"]
            assert norm(d["text"]) not in {norm(i["text"]) for i in items if i["consult_id"] == tgt["consult_id"]}      # a decoy is NOT on the target's prescription
    assert sum(1 for k in key if k["role"] == "target") == 10
    for c, terms in jobs.items():
        assert [q for q, _ in terms] == [str(n) for n in range(1, len(terms) + 1)]
        assert not any("target" in t or "decoy" in t for _, t in terms)                    # the wording gives no hint of the role
    orders = {tuple(k["role"] for k in key if k["consult_id"] == c) for c in jobs}
    assert len(orders) > 1 or len(jobs) == 1                                               # shuffled, not always target first
    fake = {(k["consult_id"], k["qid"]): ("yes" if k["role"] == "target" else "no") for k in key}
    r = score(key, fake); assert r["target_yes"] == 1.0 and r["decoy_yes"] == 0.0 and r["excess_yes_over_decoys"] == 1.0
    assert parse_answers('{"1":{"said":"yes","at_s":3.5}}', ["1", "2"]) == {"1": dict(said="yes", at_s=3.5), "2": dict(said="unparsed", at_s=None)}
    assert parse_answers("not json", ["1"]) == {"1": dict(said="unparsed", at_s=None)}
    assert list_sha(absent) == sha(json.dumps(sorted(absent)).encode()) and list_sha(absent + absent[:3]) == list_sha(absent)     # order and duplicates do not change the list sha
    edited = absent[:-5] + ["zz1", "zz2", "zz3", "zz4", "zz5"]
    assert list_sha(edited) != list_sha(absent)                                                                                    # an edited list hashes differently, so draw() (which compares to the committed sha) refuses it
    import tempfile
    with tempfile.TemporaryDirectory() as d:                                                    # draw() itself must REFUSE an edited list after the commit
        sf = d + "/salt"; open(sf, "w").write(salt); af = d + "/absent.json"; json.dump(edited, open(af, "w"))
        ns = argparse.Namespace(salt_file=sf, list_sha=ls, commit=commit_value(salt, ls), absent_ids=af)
        try:
            cmd_draw(ns); raise AssertionError("draw accepted an edited list")
        except SystemExit as e:
            assert "does not hash" in str(e)
        ns2 = argparse.Namespace(salt_file=sf, list_sha=ls, commit="0" * 64, absent_ids=af)
        try:
            cmd_draw(ns2); raise AssertionError("draw accepted a wrong commit")
        except SystemExit as e:
            assert "commit does not match" in str(e)
    print("cap_ceiling selftest ok (invented data only)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("commit"); c.add_argument("--list-sha", required=True); c.add_argument("--salt-file", required=True)
    d = sub.add_parser("draw"); d.add_argument("--absent-ids", required=True); d.add_argument("--list-sha", required=True); d.add_argument("--salt-file", required=True); d.add_argument("--commit", required=True)
    r = sub.add_parser("run"); r.add_argument("--route", required=True)
    sub.add_parser("score"); sub.add_parser("selftest")
    a = ap.parse_args()
    {"commit": cmd_commit, "draw": cmd_draw, "run": cmd_run, "score": cmd_score, "selftest": lambda _: selftest()}[a.cmd](a)
