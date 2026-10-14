"""link3_translate.py: piece A of the translated stratum (P1-PREREG-v7.15, rulings 211, 222, 239).

  every command takes --batch b1 (default: the 8 items of v7.15, mt/) or --batch b2 (the other 11 of v7.16, mt-b2/)
  python3 link3_translate.py select       counts only: the items and the >50% non-English rooms that would be translated (no network)
  python3 link3_translate.py preflight    ONE call with a single invented line (no patient text): the returned model must be exactly the requested one; writes mt/preflight.json
  python3 link3_translate.py translate    (refuses without a passing preflight for this script sha) MT of every turn of those rooms (OpenRouter, ZDR); writes mt/translated.json, mt/provenance.json, mt/mt_log.jsonl, mt/ledger.json
  (external)  deid.py (surg-deid): mt/translated.json -> mt/deid.json     name-leak check (link3_nameleak.py)     link3_screen.py
  python3 link3_translate.py verify --nameleak-summary S.json --screen-report R.json --second-pin SHA256    the gate: writes the 'gate' entry of the ledger, nothing else
  python3 link3_translate.py score        Jev on the kept de-identified English turns; refuses unless the ledger is cleared for the exact files on disk
  python3 link3_translate.py selftest

Patient text lives only in ~/eta-data/surgical-chain/p1/mt/ (0700, files 0600). stdout and the log carry ids and counts. The class key is never read.
The MT key comes from OPENROUTER_API_KEY, or from the file named by OPENROUTER_KEY_FILE; never from argv, never printed or logged.
"""
import argparse, collections, hashlib, json, os, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, "..", "..", "2026-09-24-surgery-review-v2"))     # finalize.residual_identifiers
BOX = os.path.expanduser("~/eta-data/surgical-chain/p1/")
RUN, MT = BOX + "run/", BOX + "mt/"
PREREG = "P1-PREREG-v7.15.md"
LL_ITEMS = ("c004", "c006", "c011", "c013", "c014", "c016", "c023", "c026")
INTERIM = ("c004", "c006", "c011", "c013")                     # excluded from every accuracy claim for this stratum (v7.15 M1)
LL_ITEMS_B2 = ("c001", "c012", "c021", "c025", "c028", "c030", "c033", "c034", "c035", "c036", "c037")     # v7.16 V1: every other LANGUAGE_LIMITED item (rule-based, no subset)
ACCURACY_EXCLUDED_B2 = ("c001",)                               # a pilot item of the main run (v7.7 K2.4): scored and reported, never in an accuracy claim
LL_ITEMS_B3 = ("c001", "c012", "c028", "c036")                  # v7.16a F1: exactly the four items that were MT_FAILED in mt-b2/ (rule: every item that failed, nothing chosen)
BATCHES = {"b1": dict(items=LL_ITEMS, mt=BOX + "mt/", excluded=INTERIM),           # v7.16 V4: separate directories, batch 1's record is never touched by a b2 run
           "b2": dict(items=LL_ITEMS_B2, mt=BOX + "mt-b2/", excluded=ACCURACY_EXCLUDED_B2),
           "b3": dict(items=LL_ITEMS_B3, mt=BOX + "mt-b3/", excluded=ACCURACY_EXCLUDED_B2, isolate=True, parent="b2")}   # v7.16a: ONE fresh attempt with line isolation, c001 stays excluded
SHARE_OVER = 0.5                                               # v7.10 non-English share definition, unchanged
MODEL, URL = "google/gemini-3.8-flash", "https://openrouter.ai/api/v1/chat/completions"
PROVIDER = {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}
QS = ("ok", "garbled", "untranslatable")
BATCH = 25
WAITS = (0, 4, 12, 30, 60)
MIN_FULL_READ = 20                                            # v7.15a N1: fewer eligible kept turns than this is a weak gate
FLOOR, MARGIN, LOCAL = 0.50, 0.15, timedelta(minutes=2)       # v7.x, unchanged
SYSTEM = ("You translate a clinic conversation transcript into English, faithfully.\n- Leave English words and English sentences exactly as they are.\n"
          "- Keep drug names, doses, numbers and units exact.\n- Never summarise, and never add or drop any content.\n- If the input is already English, return it unchanged.\n"
          "- If a line is too garbled to translate faithfully, give your best literal rendering and mark it garbled. If a line has no recoverable words (noise, a fragment), mark it untranslatable.\n"
          "- Output only the JSON object requested: no preamble, no notes.")
USER_HEAD = ('Translate each numbered line to English. Reply with a JSON object {"1": {"t": "...", "q": "ok"}, "2": {"t": "...", "q": "garbled"}, ...} '
             'keyed by the line numbers, where q is one of ok, garbled, untranslatable, and nothing else.')
_sleep = time.sleep


MALFORMED_TWICE = "MT_FAILED(malformed reply twice)"


class ItemFail(Exception):
    """An item that cannot be translated on the frozen route. It is counted and reported, never scored, never partly used."""
    def __init__(self, status): super().__init__(status); self.status = status


def jl(path):
    with open(path) as f:
        return json.load(f)


def sha256_bytes(b): return hashlib.sha256(b).hexdigest()
def sha256_file(p):
    with open(p, "rb") as f:
        return sha256_bytes(f.read())
def prompt_sha256(): return sha256_bytes((SYSTEM + "\n" + USER_HEAD).encode())


def iso(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))


def write_private(path, obj, jsonl=False):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_APPEND if jsonl else os.O_TRUNC), 0o600)
    with os.fdopen(fd, "a" if jsonl else "w") as f:
        f.write((json.dumps(obj) + "\n") if jsonl else json.dumps(obj, indent=1, ensure_ascii=False))
    os.chmod(path, 0o600)


# ---- code provenance: a run is refused unless the script and the pre-registration are committed and unmodified ----
def committed_sha(path, cwd=HERE):
    r = subprocess.run(["git", "log", "-1", "--format=%H", "--", path], cwd=cwd, capture_output=True, text=True)
    d = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", path], cwd=cwd)
    if r.returncode or not r.stdout.strip() or d.returncode:
        raise SystemExit(f"refused: {os.path.basename(path)} is not committed and unmodified")
    return r.stdout.strip()


def code_provenance():
    return dict(script_sha=committed_sha(os.path.abspath(__file__)), prereg_sha=committed_sha(os.path.join(HERE, "..", PREREG)))


# ---- selection (v7.15 M1) ----
def select(manifest, items=LL_ITEMS):
    """[(item, room id, non-English share)] for the batch's LANGUAGE_LIMITED items' rooms whose share is above 0.5. Reads the run manifest only (counts, no text)."""
    out = []
    for it in items:
        for r in (manifest.get(it) or {}).get("rooms", []):
            if r["turns"] and r["non_english_share"] > SHARE_OVER:
                out.append((it, r["id"], r["non_english_share"]))
    return out


def load_records(sel, run=RUN):
    """Every turn of every selected room as a record {item, room, i, lang, at, src}. `src` is the native text and never leaves this process except to the MT call."""
    recs = []
    for it, rid, _ in sel:
        for t in jl(run + f"raw/{rid}.json")["turns"]:
            recs.append(dict(item=it, room=rid, i=t["i"], lang=t.get("lang") or "", at=t["at"], src=t["orig"]))
    return recs


# ---- the MT route (v7.15 M2) ----
def get_key(env=None):
    env = os.environ if env is None else env
    k = env.get("OPENROUTER_API_KEY", "").strip()
    if not k and env.get("OPENROUTER_KEY_FILE"):
        with open(os.path.expanduser(env["OPENROUTER_KEY_FILE"])) as f:
            k = f.read().strip()
    if not k:
        raise SystemExit("no OpenRouter key supplied: set OPENROUTER_API_KEY or OPENROUTER_KEY_FILE in the run environment")
    return k


def request_body(messages):
    return {"model": MODEL, "temperature": 0, "provider": dict(PROVIDER), "response_format": {"type": "json_object"}, "messages": messages}


def http_transport(key):
    def send(body):
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None                              # the error body is never read or kept
        except Exception:
            return 0, None
    return send


def parse_reply(data, n):
    """([(t, q)], None) for an accepted reply of n lines, else (None, (reason, line index or None)). The reason is from a closed list and never carries text (v7.16a F2)."""
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None, ("no_choices", None)
    try:
        got = json.loads(content)
    except (ValueError, TypeError):
        return None, ("not_json", None)
    if not isinstance(got, dict):
        return None, ("not_object", None)
    out = []
    for k in range(n):
        v = got.get(str(k + 1))
        if not isinstance(v, dict):
            return None, ("line_missing", k)
        if not isinstance(v.get("t"), str):
            return None, ("t_not_string", k)
        if not v["t"].strip():
            return None, ("t_empty", k)
        if v.get("q") not in QS:
            return None, ("q_invalid", k)
        out.append((v["t"].strip(), v["q"]))
    return out, None


def one_batch(lines, send, log):
    """One call for up to 25 lines. Returns ([(t, q)], returned provider, returned model). v7.15 M2: 429/5xx are retried with backoff; any other failure, or a reply that is not JSON or is
    malformed, is repeated ONCE at the same settings and a second one fails the item. A returned model other than the requested one, or no returned provider, fails the item at once.
    A malformed reply logs its structural reason and line index, never text (v7.16a F2)."""
    user = USER_HEAD + "\n\n" + "\n".join(f"{n + 1}. {s}" for n, s in enumerate(lines))
    body = request_body([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}])
    bad = 0
    for wait in WAITS:
        if wait:
            _sleep(wait)
        status, data = send(body)
        rec = dict(lines=len(lines), status=status, model_requested=MODEL, temperature=0, provider_settings=PROVIDER, prompt_sha256=prompt_sha256())
        if status in (429, 500, 502, 503, 504) and wait != WAITS[-1]:
            log(dict(rec, retry=True)); continue
        if status != 200 or not isinstance(data, dict):
            bad += 1; log(dict(rec, failed=True, repeat=bad < 2))
            if bad >= 2: raise ItemFail(f"MT_FAILED(http {status})")
            continue
        rec.update(model_returned=data.get("model"), provider_returned=data.get("provider"))
        if data.get("model") != MODEL:
            log(dict(rec, failed=True)); raise ItemFail("MT_ROUTE_MISMATCH")
        if not isinstance(data.get("provider"), str) or not data["provider"].strip():
            log(dict(rec, failed=True)); raise ItemFail("MT_ROUTE_MISMATCH(provider not reported)")      # nothing to check against the ZDR list
        out, why = parse_reply(data, len(lines))
        if why:
            bad += 1; log(dict(rec, malformed=True, reason=why[0], index=why[1]))
            if bad >= 2: raise ItemFail(MALFORMED_TWICE)
            continue
        log(dict(rec, ok=True))
        return out, data["provider"], data["model"]
    raise ItemFail("MT_FAILED(retries exhausted)")


def translate_item(rows, send, log, isolate=False, stats=None):
    """rows: records of one item. Returns (translated rows, providers seen, models returned). Every turn is sent (the prompt keeps English as it is). Provider must agree across batches.
    isolate (v7.16a F3, the b3 re-attempt only): a batch whose lines were malformed twice is re-sent ONE LINE PER CALL under the same M2 rules; a line that fails twice becomes a record with
    q = "mt_failed" and en = "" (no text kept, nothing repaired); it is dropped by the screen and counted in stats["isolated_failed_lines"]. Route failures and HTTP failures still fail the item."""
    stats = stats if stats is not None else {}
    stats.setdefault("isolated_failed_lines", 0); stats.setdefault("isolated_calls", 0)
    out, provs, models = [], [], []
    for k in range(0, len(rows), BATCH):
        chunk = rows[k:k + BATCH]; it, b = chunk[0]["item"], k // BATCH
        try:
            res, prov, model = one_batch([r["src"] for r in chunk], send, lambda rec: log(dict(rec, item=it, batch=b)))
        except ItemFail as e:
            if not (isolate and e.status == MALFORMED_TWICE):
                raise
            res = []                                                          # the batch failed twice on the shape of the reply: isolate its lines
            for j, r in enumerate(chunk):
                stats["isolated_calls"] += 1
                try:
                    one, prov, model = one_batch([r["src"]], send, lambda rec, j=j: log(dict(rec, item=it, batch=b, isolated=True, chunk_line=j)))
                except ItemFail as e2:
                    if e2.status != MALFORMED_TWICE:
                        raise
                    stats["isolated_failed_lines"] += 1; res.append(("", "mt_failed")); continue
                provs.append(prov); models.append(model); res.append(one[0])
        else:
            provs.append(prov); models.append(model)
        out += [dict(item=r["item"], room=r["room"], i=r["i"], lang=r["lang"], at=r["at"], en=t, q=q) for r, (t, q) in zip(chunk, res)]
    if len(set(provs)) > 1:
        raise ItemFail("MT_ROUTE_MISMATCH(provider changed within the item)")
    if out and all(r["q"] == "mt_failed" for r in out):
        raise ItemFail("MT_FAILED(every line isolated-failed)")
    return out, sorted(set(provs)), sorted(set(models))


def translate_all(recs, send, log, isolate=False):
    by = collections.defaultdict(list)
    for r in recs: by[r["item"]].append(r)
    translated, status = [], {}
    for it in sorted(by):
        cnt = collections.Counter(); stats = {}
        def lg(rec):
            cnt["retries"] += bool(rec.get("retry")); cnt["repeats"] += bool(rec.get("malformed") or rec.get("repeat")); log(rec)
        rooms = len({r["room"] for r in by[it]})
        try:
            rows, provs, models = translate_item(by[it], send, lg, isolate, stats)
            translated += rows; iso = stats.get("isolated_failed_lines", 0)
            status[it] = dict(status="MT_OK", turns_in=len(by[it]), turns_returned=len(rows) - iso, turns=len(rows), rooms=rooms, batches=-(-len(by[it]) // BATCH), providers=provs,
                              model_returned=models, retries=cnt["retries"], repeats=cnt["repeats"], isolated_failed_lines=iso)
        except ItemFail as e:
            status[it] = dict(status=e.status, turns_in=len(by[it]), turns_returned=0, turns=0, rooms=rooms, retries=cnt["retries"], repeats=cnt["repeats"],
                              isolated_failed_lines=stats.get("isolated_failed_lines", 0))
    return translated, status


# ---- order: nothing reaches Jev unless every earlier stage ran and passed (v7.15 M4) ----
def pipeline(recs, mt, deid, gate, screen, jev):
    """The stages as callables: mt, deid, gate, screen, then jev. `jev` is the only stage that can spend, and it only ever sees what `screen` returns from the de-identified English.
    In the CLI the same prerequisites run as: translate, (external) deid, draw and human counts, screen, verify (the gate: it needs the screen report and score_input.json), score; `score` refuses
    unless the ledger shows the gate cleared for the exact files on disk. Screen and gate are both prerequisites of Jev; their relative order does not matter, and both come after deid."""
    translated = mt(recs)
    deided = deid(translated)
    gate(deided)
    kept = screen(deided)
    return jev(kept)


def file_key(rows): return [(r["item"], r["room"], r["i"]) for r in rows]


def check_score_input(mt=MT):
    """Every scored turn must be, byte for byte, the en_deid of the same (item, room, i) in deid.json: the judge can never be fed the raw `en`, or an edited text."""
    d = {(r["item"], r["room"], r["i"]): r for r in jl(mt + "deid.json")}
    for it, rooms in jl(mt + "score_input.json").items():
        for rid, room in rooms.items():
            for t in room["turns"]:
                r = d.get((it, rid, t["i"]))
                if r is None or "en_deid" not in r or t.get("en") != r["en_deid"] or room.get("stratum") != "translated":
                    raise SystemExit("refused: a score_input turn is not the de-identified text of its deid.json record (or is not tagged translated)")


def residual_hits(mt=MT):
    """finalize.residual_identifiers over EVERY scored turn (not a sample): [(item, room, i, tag)]. Shapes (numbers, ids, emails, Indic script, spoken digits), not names."""
    from finalize import residual_identifiers
    hits = []
    for it, rooms in jl(mt + "score_input.json").items():
        for rid, room in rooms.items():
            for (i, _f, tag) in residual_identifiers([{"i": t["i"], "en": t["en"], "orig": ""} for t in room["turns"]]):
                hits.append((it, rid, i, tag))
    return hits


def assert_no_residuals(mt=MT):
    hits = residual_hits(mt)
    if hits:
        raise SystemExit(f"refused: {len(hits)} residual identifier hit(s) in scored turns {dict(collections.Counter(h[3] for h in hits))} at {sorted({(h[0], h[1], h[2]) for h in hits})[:20]}: re-de-identify, do not score")


def cmd_verify(nameleak_summary, screen_report, second_pin, mt=MT, items=None):
    import re
    if not re.fullmatch(r"[0-9a-f]{64}", second_pin or ""):
        raise SystemExit("gate refused: --second-pin must be the 64-hex sha256 refuter-2 posted for his locked counts file")
    L = jl(mt + "ledger.json")
    tr, dj = mt + "translated.json", mt + "deid.json"
    if items is not None:                                          # refuter-2 #1505: a batch's verify also refuses another batch's items (the directory alone was the guard)
        held = {r["item"] for r in jl(tr)} | set(jl(mt + "provenance.json")["items"]) | set(jl(mt + "score_input.json"))
        if held - set(items):
            raise SystemExit("gate refused: the batch's files hold an item that is not in this batch (batches are never mixed)")
    if sha256_file(tr) != L["translate"]["translated_sha256"]:
        raise SystemExit("gate refused: translated.json changed since the translate step")
    t, d = jl(tr), jl(dj)
    if file_key(t) != file_key(d) or any(a["en"] != b["en"] for a, b in zip(t, d)) or any("en_deid" not in b for b in d):
        raise SystemExit("gate refused: deid.json does not match translated.json (same keys, same en, and an en_deid on every record)")
    s = jl(nameleak_summary)
    if s.get("gate") != "PASS" or "second_total_missed" not in s:
        raise SystemExit("gate refused: name-leak summary is not a passing check with the second reader's counts")
    import link3_nameleak as NL                                    # v7.15a N3: the check must be a FULL READ of the eligible set recomputed from deid.json (seed irrelevant)
    elig = NL.eligible(d)
    if len(elig) < MIN_FULL_READ or s.get("n_turns") != len(elig) or s.get("eligible_sha256") != NL.keys_sha([NL.turn_key(r) for r in elig]):
        raise SystemExit(f"gate refused: the name-leak read is not a full read of the {len(elig)} eligible kept turns of deid.json (or fewer than {MIN_FULL_READ}): a sample or a partial draw does not clear it")
    if s.get("second_counts_sha256") != second_pin or not s.get("counts_sha256"):
        raise SystemExit("gate refused: the summary was not made against the second reader's counts file pinned on the bus")
    if s.get("deid_sha256") != sha256_file(dj) or s.get("translated_sha256") != sha256_file(tr):
        raise SystemExit("gate refused: the name-leak counts were made on a different deid.json or translated.json than the ones on disk")
    r = jl(screen_report)
    if r.get("status") not in ("OK", "INCOMPLETE") or not os.path.exists(mt + "score_input.json") or not os.path.exists(mt + "screened.json"):
        raise SystemExit("gate refused: screen report is blocked, or score_input.json / screened.json is missing")
    check_score_input(mt); assert_no_residuals(mt)
    L["gate"] = dict(deid_sha256=sha256_file(dj), score_input_sha256=sha256_file(mt + "score_input.json"), screened_sha256=sha256_file(mt + "screened.json"), nameleak_seed=s["seed"],
                     nameleak_total_missed=s["total_missed"], nameleak_second_total_missed=s["second_total_missed"], second_counts_sha256=second_pin, screen_status=r["status"])
    write_private(mt + "ledger.json", L)
    print("gate cleared: name-leak seed", s["seed"], "screen", r["status"])


def require_cleared(mt=MT):
    L = jl(mt + "ledger.json")
    g = L.get("gate")
    if not g:
        raise SystemExit("refused: the gate has not cleared (run verify)")
    for name, key in (("translated.json", None), ("deid.json", "deid_sha256"), ("score_input.json", "score_input_sha256"), ("screened.json", "screened_sha256")):
        want = L["translate"]["translated_sha256"] if key is None else g[key]
        if sha256_file(mt + name) != want:
            raise SystemExit(f"refused: {name} changed after the gate cleared")
    return L


# ---- Jev scoring: the v7.x rules, unchanged (mirrors link3_run.stage_score's chain; that file is not edited) ----
def verdict_chain(item, m, docs, rx_own, decoys, zero, ask):
    import link3_judge as lj
    text = lambda doc, lo=None, hi=None: "\n".join(f"[{t['i']}] {t.get('en') or ''}" for t in doc["turns"] if (t.get("en") or "").strip() and (lo is None or lo <= iso(t["at"]) <= hi))
    rooms = [r["id"] for r in m["rooms"]]; f = dict(calls=0)
    sc = lambda a, b: lj.score(a, b, ask, lj.LINK_QUESTION_V2)
    room_scores = {r: (0.0 if r in zero else sc(text(docs[r]), rx_own)) for r in rooms}; f["calls"] += len(rooms) - len(zero)
    ranked = sorted(room_scores.items(), key=lambda kv: -kv[1]); best_room, best = ranked[0]
    room_margin = (best - ranked[1][1]) if len(ranked) > 1 else None
    lo, hi = iso(m["start"]) - LOCAL, iso(m["end"]) + LOCAL
    local = text(docs[best_room], lo, hi)
    f.update(room_scores={r: round(x, 3) for r, x in room_scores.items()}, best_room=best_room, best=round(best, 3))
    if not local.strip():
        return f, None
    own_local = sc(local, rx_own); f["calls"] += 1
    dec = [sc(local, text(d)) for d in decoys]; f["calls"] += len(dec)
    rx_margin = (own_local - max(dec)) if dec else None
    f.update(own_local=round(own_local, 3), room_margin=None if room_margin is None else round(room_margin, 3), n_decoys=len(dec), best_decoy=round(max(dec), 3) if dec else None,
             rx_margin=None if rx_margin is None else round(rx_margin, 3))
    if best < FLOOR:
        return f, "REJECT_BELOW_FLOOR"
    fails = [n for n, mg in (("room", room_margin), ("rx", rx_margin)) if mg is not None and mg < MARGIN]
    v = "ACCEPTED" if not fails else "AMBIGUOUS_TIE(" + "+".join(fails) + ")"
    if room_margin is None and rx_margin is None: v = "SINGLE"
    elif (room_margin is None or rx_margin is None) and not fails: v += "(single on " + ("room" if room_margin is None else "rx") + ")"
    return f, v


def score_translated(ask=None, run=RUN, mt=MT, items=LL_ITEMS, excluded=INTERIM, batch="b1"):
    L = require_cleared(mt); check_score_input(mt); assert_no_residuals(mt)
    si = jl(mt + "score_input.json"); prov = jl(mt + "provenance.json")["items"]
    if (set(prov) | set(si)) - set(items):
        raise SystemExit("refused: the batch's files hold an item that is not in this batch (batches are never mixed)")
    man = jl(run + "manifest.json"); sel = select(man, items); out = {}
    for it in sorted(set(prov) | set(si)):                                  # every translated item is accounted for, including MT_FAILED and no-kept-turn items
        base = dict(stratum="translated", batch=batch, interim_item=it in INTERIM, accuracy_excluded=it in excluded)
        st = (prov.get(it) or {}).get("status")
        if st != "MT_OK":
            out[it] = dict(base, verdict=st or "NOT_TRANSLATED", calls=0); print(it, out[it]["verdict"], "| no scoring (translation did not complete)"); continue
        m = man[it]; trooms = {rid for i2, rid, _ in sel if i2 == it}; rooms = si.get(it) or {}
        if set(rooms) - trooms:
            raise SystemExit("refused: score_input holds a room that is not a selected translated room")
        if not rooms:
            out[it] = dict(base, verdict="INCOMPLETE", calls=0, why="no kept turn in any translated room"); print(it, "INCOMPLETE | no kept turn"); continue
        docs = {}
        for r in m["rooms"]:                                                # a translated room is NEVER read from the pooled file: absent from score_input means no kept turn, so it scores 0
            docs[r["id"]] = {"turns": (rooms.get(r["id"]) or {}).get("turns", [])} if r["id"] in trooms else jl(run + f"deid/{r['id']}.json")
        rx_own = "\n".join(f"[{t['i']}] {t.get('en') or ''}" for t in jl(run + f"deid/{it}_rxown.json")["turns"] if (t.get("en") or "").strip())
        decoys = [jl(run + f"deid/{it}_rxd{n:02d}.json") for n in range(m["decoys"])]
        zero = {r["id"] for r in m["rooms"] if r["turns"] == 0 or (r["id"] in trooms and not docs[r["id"]]["turns"]) or (r["id"] not in trooms and r["non_english"] == r["turns"])}
        f, v = verdict_chain(it, m, docs, rx_own, decoys, zero, ask)
        out[it] = dict(f, **base, verdict=v or "INCOMPLETE", translated_rooms=sorted(trooms), translated_rooms_with_kept_turns=sorted(rooms))
        if v is None:                                                       # v7.10 / v7.7: an INCOMPLETE verdict carries its reason (refuter-2 #1497)
            out[it]["why"] = "no kept turn inside the consult +/- 2 min in the best room"
        print(it, out[it]["verdict"], "| translated rooms", len(trooms), "| with kept turns", len(rooms), "| excluded from accuracy claims" if it in excluded else "", "| calls", f["calls"])
    write_private(mt + "translated_results.json", out)


# ---- commands ----
def cmd_select(batch="b1"):
    man = jl(RUN + "manifest.json"); sel = select(man, BATCHES[batch]["items"])
    per = collections.Counter(i for i, _, _ in sel)
    turns = sum(next(r["turns"] for r in man[i]["rooms"] if r["id"] == rid) for i, rid, _ in sel)
    print("items", len(per), "| rooms", len(sel), "| turns to translate", turns, "| per item rooms", dict(sorted(per.items())))


PREFLIGHT_LINE = "Good morning, please have a seat."                      # invented; no patient text


def cmd_preflight(send=None, mt=MT, prov=None):
    """ONE call with one invented line on the frozen route (refuter-2 #1218). The returned model must be exactly the requested string, else every item would fail closed and waste the run."""
    prov = prov or code_provenance()
    os.makedirs(mt, mode=0o700, exist_ok=True); os.chmod(mt, 0o700)
    send = send or http_transport(get_key())
    log = lambda rec: write_private(mt + "mt_log.jsonl", dict(rec, preflight=True), jsonl=True)
    try:
        _res, provider, model = one_batch([PREFLIGHT_LINE], send, log)
    except ItemFail as e:
        write_private(mt + "preflight.json", dict(ok=False, status=e.status, **prov, at=datetime.now().isoformat()))
        raise SystemExit(f"preflight failed: {e.status}")
    write_private(mt + "preflight.json", dict(ok=True, model_returned=model, provider_returned=provider, model_requested=MODEL, prompt_sha256=prompt_sha256(), **prov, at=datetime.now().isoformat()))
    print("preflight ok: returned model", model, "| provider", provider)


def require_preflight(mt, prov):
    try:
        pf = jl(mt + "preflight.json")
    except OSError:
        raise SystemExit("refused: no preflight (run `preflight` first)")
    if not pf.get("ok") or pf.get("script_sha") != prov["script_sha"] or pf.get("model_returned") != MODEL:
        raise SystemExit("refused: the preflight did not pass for this script sha")


def cmd_translate(send=None, run=RUN, mt=MT, prov=None, items=LL_ITEMS, batch="b1", isolate=False, parent_mt=None):
    prov = prov or code_provenance()                       # refuses an uncommitted or modified script or pre-registration
    attempt1 = None
    if parent_mt:                                          # v7.16a F1: a re-attempt only for an item that is MT_FAILED in the parent batch, and both attempts are recorded
        p1 = jl(parent_mt + "provenance.json")["items"]
        notfailed = [it for it in items if not str((p1.get(it) or {}).get("status", "")).startswith("MT_FAILED")]
        if notfailed:
            raise SystemExit(f"refused: {notfailed} is not MT_FAILED in the parent batch: only failed items are re-attempted")
        attempt1 = {it: p1[it]["status"] for it in items}
    man = jl(run + "manifest.json"); sel = select(man, items); recs = load_records(sel, run)
    os.makedirs(mt, mode=0o700, exist_ok=True); os.chmod(mt, 0o700)
    if os.path.exists(mt + "translated.json"):
        raise SystemExit("refused: mt/translated.json already exists (never overwritten)")
    require_preflight(mt, prov)
    send = send or http_transport(get_key())
    translated, status = translate_all(recs, send, lambda rec: write_private(mt + "mt_log.jsonl", rec, jsonl=True), isolate)
    write_private(mt + "translated.json", translated)
    write_private(mt + "provenance.json", dict(model_requested=MODEL, temperature=0, provider_settings=PROVIDER, prompt_sha256=prompt_sha256(), **prov,
                                              translated_sha256=sha256_file(mt + "translated.json"), items=status, rooms_selected=len(sel), turns_selected=len(recs), batch=batch,
                                              items_expected=list(items), attempt=2 if parent_mt else 1, attempt1=attempt1, line_isolation=bool(isolate)))
    write_private(mt + "ledger.json", dict(translate=dict(translated_sha256=sha256_file(mt + "translated.json"), **prov, at=datetime.now().isoformat())))
    print("translated", len(translated), "of", len(recs), "turns |", dict(collections.Counter(s["status"] for s in status.values())),
          "| isolated-failed lines", sum(v.get("isolated_failed_lines", 0) for v in status.values()))


def build_parser():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    for n in ("select", "preflight", "translate", "score", "selftest"):
        sub.add_parser(n).add_argument("--batch", choices=sorted(BATCHES), default="b1")
    v = sub.add_parser("verify"); v.add_argument("--nameleak-summary", required=True); v.add_argument("--screen-report", required=True); v.add_argument("--second-pin", required=True)
    v.add_argument("--batch", choices=sorted(BATCHES), default="b1")
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv); B = BATCHES[a.batch]
    if a.cmd == "select": cmd_select(a.batch)
    elif a.cmd == "preflight": cmd_preflight(mt=B["mt"])
    elif a.cmd == "translate": cmd_translate(mt=B["mt"], items=B["items"], batch=a.batch, isolate=B.get("isolate", False), parent_mt=BATCHES[B["parent"]]["mt"] if B.get("parent") else None)
    elif a.cmd == "verify": cmd_verify(a.nameleak_summary, a.screen_report, a.second_pin, mt=B["mt"], items=B["items"])
    elif a.cmd == "score": score_translated(mt=B["mt"], items=B["items"], excluded=B["excluded"], batch=a.batch)
    else:
        sys.exit(subprocess.run([sys.executable, "-B", "-m", "unittest", "test_order"], cwd=os.path.join(HERE, "tests")).returncode)


if __name__ == "__main__":
    main()
