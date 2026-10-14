"""W33.4(a) S3 LANGUAGE JUDGE (linker). A listening model says WHICH LANGUAGE(S) a window (<= 30 s) speaks; nothing else is asked.
Route = the CAP-1 ceiling / link-3 route: OpenRouter google/gemini-3.8-flash, temperature 0, provider {zdr: true, data_collection: deny, allow_fallbacks: false}, mp3 input_audio.
Key: env OPENROUTER_API_KEY or the file named by OPENROUTER_KEY_FILE (default ~/.claude/secrets/openrouter_api_key); never argv, never printed or logged. No text of any kind is logged: only ids, labels, status, model, provider.
Labels: en hi kn ta te ml mixed none.  PRE-REGISTERED LABEL RULE, PROMPT v4 (PREREG-S3-JUDGE.md: v1 main-language rule, v2 foreground rule, v3 foreground-only two-field reply, v4 explicit switch-detection declared after v3 called real foreground code-switching a single language on confirm3; Fable ruling 11:25): the label is the MAIN language; English medical/drug/diagnosis words inside another language's sentences do NOT make it mixed;
  mixed = the foreground speakers THEMSELVES sustain code-switching between two of those languages at sentence/clause level, asked as its own explicit yes/no question (not a side effect of picking among 8 labels); none = no speech. SELFTEST truth: the event's main language (xx-en = xx); `mixed` only when the events' main languages differ.

  validate  --suite DIR [--suite DIR ...] --out RUN_DIR     judge SELFTEST audio (DIR/*.truth.json + .wav, known language) -> judged.jsonl, then report.json (accuracy per language, verdict)
  window    --manifest M.jsonl --out RUN_DIR                real audio: M rows {id, audio} (audio <= 31 s) -> judged.jsonl (labels only). PATIENT AUDIO LEAVES THE BOX: launched by Fable/V from a terminal
  score     --judged J.jsonl --truth T.jsonl                (validate report is built by validate itself; this rescoring is for any labelled set: T rows {id, truth})
Gate (Fable W33.4a): the judge is usable ONLY IF accuracy >= 95% overall AND >= 90% per language. A language with fewer than 5 clips is reported "n<5: gate not met" (the gate needs enough clips to mean anything).
Resumable: ids already in judged.jsonl are skipped. Failures are recorded as label "error" (counted as wrong in validate, and listed as unjudged in window mode)."""
import argparse, collections, glob, hashlib, json, math, os, subprocess, sys, tempfile, time, urllib.error, urllib.request

MODEL, URL = "google/gemini-3.8-flash", "https://openrouter.ai/api/v1/chat/completions"
PROVIDER = {"zdr": True, "data_collection": "deny", "allow_fallbacks": False}
LABELS = ("en", "hi", "kn", "ta", "te", "ml", "mixed", "none")
FG_LANGS = ("en", "hi", "kn", "ta", "te", "ml", "none")            # v4: "mixed" is not a valid foreground_lang value; switching is asked for separately (see PROMPT)
MAX_S = 31.0
WAITS = (0, 4, 12, 30)
_sleep = time.sleep
PROMPT = ("Listen to this audio clip. It may contain a conversation in the foreground (the two or three people speaking closest to the microphone, clearly and loudly: typically a doctor and a patient) "
          "and, sometimes, other voices in the background (quieter or more distant: other rooms, crowd chatter, TV, passers-by). Consider ONLY the foreground conversation for questions (1) and (2); ignore background voices entirely for those. "
          'Reply with a JSON object {"foreground_lang": X, "switch": S, "background": Y}. '
          "(1) X is the single language the foreground speakers use for MOST of their turns, exactly one of: en (English), hi (Hindi), kn (Kannada), ta (Tamil), te (Telugu), ml (Malayalam), none (no foreground speech). "
          "English drug names, doses, diagnoses, test names and other English medical or technical words inside a sentence in another language do NOT change X: the sentence is still that other language. "
          "(2) S is true or false. Answer true ONLY when the FOREGROUND speakers THEMSELVES switch between two of these six languages from one sentence or clause to the next, WITHIN a turn OR across their own "
          "consecutive turns (for example: one speaker's turn in Hindi followed by their own or the other speaker's turn in English, or a speaker changing language mid-turn) "
          "(not for single borrowed words, and NOT because a background voice speaks a different language). Answer false when the foreground uses only one language throughout, even if the room contains other-language chatter. "
          "(3) Background voices NEVER affect X or S, even when they speak a different language from the foreground. "
          "Y is the language of any background voices, exactly one of: en, hi, kn, ta, te, ml, mixed, none (none when there are no background voices; mixed when background voices use more than one language). "
          "Reply with the JSON object and nothing else.")
PROMPT_SHA = hashlib.sha256((MODEL + "\n" + PROMPT).encode()).hexdigest()


def get_key(env=None):
    env = os.environ if env is None else env
    k = env.get("OPENROUTER_API_KEY", "").strip()
    if not k:
        p = os.path.expanduser(env.get("OPENROUTER_KEY_FILE", "~/.claude/secrets/openrouter_api_key"))
        with open(p) as f:
            k = f.read().strip()
    if not k:
        raise SystemExit("no OpenRouter key supplied")
    return k


def to_mp3(src, dst):
    """mono 16 kHz 32 kbps mp3, at most MAX_S seconds (a longer clip is refused for real windows, cut for validation stimuli)."""
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-t", str(int(MAX_S)), "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", dst], check=True)


def duration_s(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def request_body(mp3_b64):
    return {"model": MODEL, "temperature": 0, "provider": dict(PROVIDER), "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "input_audio", "input_audio": {"data": mp3_b64, "format": "mp3"}}]}]}


def http_transport(key):
    def send(body):
        req = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, None                                   # the error body is never read or kept
        except Exception:
            return 0, None
    return send


def parse_label(data):
    """label from a reply, or None when it is not exactly the expected v4 JSON. v4: `mixed` is never chosen directly (it is not in FG_LANGS);
    it is derived only from the explicit `switch` boolean, so switching is tested for directly instead of being one of 8 competing label choices."""
    try:
        got = json.loads(data["choices"][0]["message"]["content"])
        x, s, bg = got["foreground_lang"], got["switch"], got["background"]
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if not (isinstance(x, str) and x in FG_LANGS and isinstance(s, bool) and isinstance(bg, str) and bg in LABELS):
        return None
    if s and x == "none":
        return None                                         # contradictory: switching between languages with no foreground speech
    return ("mixed" if s else x), bg                         # v4: the label scored is the FOREGROUND language, or `mixed` iff switch=true; background is recorded, never scored


def judge_one(mp3_path, send):
    """-> dict(label, status, model, provider, tries). label 'error' when no accepted reply. A returned model other than the requested one, or no provider reported, is an error (no ZDR check possible)."""
    import base64
    body = request_body(base64.b64encode(open(mp3_path, "rb").read()).decode())
    bad = 0; last = 0
    for w in WAITS:
        if w:
            _sleep(w)
        status, data = send(body); last = status
        if status in (429, 500, 502, 503, 504):
            continue
        if status != 200 or not isinstance(data, dict):
            bad += 1
            if bad >= 2:
                break
            continue
        if data.get("model") != MODEL or not isinstance(data.get("provider"), str) or not data["provider"].strip():
            return dict(label="error", status="route_mismatch", model=data.get("model"), provider=data.get("provider"))
        parsed = parse_label(data)
        lab = None if parsed is None else parsed[0]
        if lab is None:
            bad += 1
            if bad >= 2:
                return dict(label="error", status="bad_reply", model=data["model"], provider=data["provider"])
            continue
        return dict(label=lab, background=parsed[1], status="ok", model=data["model"], provider=data["provider"])
    return dict(label="error", status=f"http_{last}", model=None, provider=None)


def truth_label(t):
    """SELFTEST truth -> judge label under the pre-registered rule: the MAIN (matrix) language. An event tagged xx-en (English words inside an xx sentence: the code-mixed dialogues) is `xx`;
    `mixed` only when the events' main languages differ (sustained switching between two languages); none for silence/tones/no language events. Only events starting inside the judged (cut) part count."""
    langs = {e.get("lang").split("-")[0] if e.get("lang") != "en" else "en" for e in (t.get("events") or []) if e.get("lang") and e.get("start_ms", 0) < MAX_S * 1000}
    if t.get("kind") in ("silence", "tones") or not langs:
        return "none"
    if len(langs) > 1:
        return "mixed"
    l = next(iter(langs))
    return l if l in LABELS else None


def load_suite(dirs):
    items = []
    for d in dirs:
        for tp in sorted(glob.glob(os.path.join(d, "*.truth.json"))):
            wav = tp[:-len(".truth.json")] + ".wav"
            if not os.path.exists(wav):
                continue
            t = json.load(open(tp)); lab = truth_label(t)
            if lab is None:
                continue
            items.append(dict(id=os.path.basename(os.path.dirname(tp)) + "/" + os.path.basename(wav)[:-4], audio=wav, truth=lab, kind=t.get("kind"), audio_sha256=hashlib.sha256(open(wav, "rb").read()).hexdigest()))
    return items


def wilson_lo(k, n, z=1.96):
    if n == 0:
        return 0.0
    p = k / n; d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d


def condition_of(stimulus_id):
    """clean, or the noise bed in the stimulus id (dlg_en_2__fan_snr10 -> fan10, __babble_snr5 -> babble5, __ac_hum_snr0 -> ac_hum0)."""
    if "__" not in stimulus_id:
        return "clean"
    bed, _, snr = stimulus_id.split("__", 1)[1].partition("_snr")
    return f"{bed}{snr}"


def report(rows):
    """The gate holds overall AND inside every condition present (eta-refuter-2 C3): each condition must itself pass (>=95%, every label >=90% with n>=5)."""
    rep = _report(rows)
    conds = collections.defaultdict(list)
    for r in rows:
        conds[r.get("condition", "clean")].append(r)
    if len(conds) > 1 or "clean" not in conds:
        rep["per_condition"] = {c: _report(rs) for c, rs in sorted(conds.items())}
        rep["usable"] = rep["usable"] and all(v["usable"] for v in rep["per_condition"].values())
    return rep


def _report(rows):
    """rows: dict(id, truth, label). Accuracy overall and per truth label (an 'error' label is wrong) and the Fable gate."""
    per = collections.defaultdict(lambda: [0, 0]); conf = collections.Counter()
    for r in rows:
        per[r["truth"]][1] += 1; per[r["truth"]][0] += r["label"] == r["truth"]; conf[(r["truth"], r["label"])] += 1
    ok, n = sum(v[0] for v in per.values()), sum(v[1] for v in per.values())
    langs = {k: dict(n=v[1], correct=v[0], acc=round(v[0] / v[1], 3), wilson95_lo=round(wilson_lo(v[0], v[1]), 3)) for k, v in sorted(per.items())}
    fails = [k for k, v in langs.items() if v["n"] < 5 or v["acc"] < 0.90]
    overall = dict(n=n, correct=ok, acc=round(ok / n, 3) if n else 0.0, wilson95_lo=round(wilson_lo(ok, n), 3))
    usable = n > 0 and overall["acc"] >= 0.95 and not fails
    return dict(model=MODEL, prompt_sha256=PROMPT_SHA, overall=overall, per_label=langs, labels_below_gate=fails,
                confusion={f"{a}->{b}": c for (a, b), c in sorted(conf.items()) if a != b}, gate="overall>=95% and every label>=90% with n>=5", usable=usable)


def run_judged(items, out_dir, send, prep_dir):
    os.makedirs(out_dir, mode=0o700, exist_ok=True); os.chmod(out_dir, 0o700)
    jp = os.path.join(out_dir, "judged.jsonl")
    done = set()
    if os.path.exists(jp):
        for l in open(jp):
            r = json.loads(l)
            if r.get("prompt_sha256") != PROMPT_SHA:
                raise SystemExit("refused: judged.jsonl holds a row from a different prompt (%s); use a new --out" % str(r.get("prompt_sha256"))[:16])
            done.add(r["id"])
    with open(jp, "a") as f:
        os.chmod(jp, 0o600)
        for it in items:
            if it["id"] in done:
                continue
            mp3 = os.path.join(prep_dir, hashlib.sha1(it["id"].encode()).hexdigest()[:12] + ".mp3")
            to_mp3(it["audio"], mp3)
            res = judge_one(mp3, send); os.remove(mp3)
            f.write(json.dumps(dict(id=it["id"], **res, prompt_sha256=PROMPT_SHA)) + "\n"); f.flush()
    return {json.loads(l)["id"]: json.loads(l) for l in open(jp)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0]); sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate"); v.add_argument("--suite", action="append", required=True); v.add_argument("--out", required=True)
    w = sub.add_parser("window"); w.add_argument("--manifest", required=True); w.add_argument("--out", required=True)
    s = sub.add_parser("score"); s.add_argument("--judged", required=True); s.add_argument("--truth", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "score":
        j = {json.loads(l)["id"]: json.loads(l)["label"] for l in open(a.judged)}
        rows = [dict(id=r["id"], truth=r["truth"], label=j.get(r["id"], "error")) for r in map(json.loads, open(a.truth))]
        print(json.dumps(report(rows), indent=1)); return 0
    send = http_transport(get_key())
    with tempfile.TemporaryDirectory() as prep:
        if a.cmd == "validate":
            items = load_suite(a.suite)
            got = run_judged(items, a.out, send, prep)
            rows = [dict(id=i["id"], truth=i["truth"], label=got[i["id"]]["label"], kind=i["kind"], condition=condition_of(i["id"].split("/")[-1])) for i in items]
            rep = report(rows); rep["clips"] = len(items); rep["suites"] = a.suite; rep["errors"] = sum(r["label"] == "error" for r in rows)
            rp = os.path.join(a.out, "report.json"); open(rp, "w").write(json.dumps(rep, indent=1)); os.chmod(rp, 0o600)
            print(json.dumps(rep, indent=1)); return 0 if rep["usable"] else 2
        items = []
        for r in map(json.loads, open(a.manifest)):
            if duration_s(r["audio"]) > MAX_S:
                raise SystemExit("refused: a window is longer than %.0f s (%s)" % (MAX_S, r["id"]))
            items.append(dict(id=r["id"], audio=r["audio"]))
        got = run_judged(items, a.out, send, prep)
        c = collections.Counter(g["label"] for g in got.values())
        print(json.dumps(dict(judged=len(got), labels=dict(c), errors=c.get("error", 0), prompt_sha256=PROMPT_SHA)))
        return 0


if __name__ == "__main__":
    sys.exit(main())
