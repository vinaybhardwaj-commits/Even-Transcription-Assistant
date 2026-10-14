"""Shared pieces for the VJ arm runners and the scorer: frozen-text check, question set, doubtful rule, Jev + Vertex clients, jsonl io.

Secrets are read from files only (never argv, never logged). HTTP error bodies are withheld because they can echo the state (PHI).
"""
import hashlib, json, os, re, subprocess, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FREEZE_SHA12 = "b961291ae64c"
ADDENDUM_SHA12 = "9c335c59c5be"
ADDENDUM166_SHA12 = "87b8cdac4330"   # ruling 166 amends 165 (ECAPA margins, truth priority)
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_KEY = os.path.expanduser("~/.config/even-jev/key")
VERTEX_PROJECT = "clinical-infra"
FORBIDDEN_KEYS = {"truth", "is_doctor_truth", "truth_label", "teacher_count", "human_count", "human_counts", "hidden_fields"}
FORBIDDEN_PATH_PARTS = ("key.json", "human-counts", "/truth/", "truth_")


def sha256_bytes(b): return hashlib.sha256(b).hexdigest()
def sha256_file(p): return sha256_bytes(open(p, "rb").read())


def freeze_text():
    """freeze.txt is the verbatim text between the FREEZE markers of orders/VOICE-JEV-BUILD.md. Refuse to run if its sha moved."""
    b = open(os.path.join(HERE, "freeze.txt"), "rb").read()
    full = sha256_bytes(b)
    if not full.startswith(FREEZE_SHA12):
        raise SystemExit(f"freeze.txt sha {full[:12]} != frozen {FREEZE_SHA12}: this is a new run, not this build")
    return b.decode(), full


def addendum_sha():
    """addendum.txt = text between the VJ-ADDENDUM markers of orders/RULING-165-VJ.md (same awk | shasum -a 256 as the freeze)."""
    full = sha256_file(os.path.join(HERE, "addendum.txt"))
    if not full.startswith(ADDENDUM_SHA12):
        raise SystemExit(f"addendum.txt sha {full[:12]} != VJ-ADDENDUM-165 {ADDENDUM_SHA12}")
    return full


def addendum166_sha():
    full = sha256_file(os.path.join(HERE, "addendum166.txt"))
    if not full.startswith(ADDENDUM166_SHA12):
        raise SystemExit(f"addendum166.txt sha {full[:12]} != VJ-ADDENDUM-166 {ADDENDUM166_SHA12}")
    return full


def stamp():
    """All three hashes, put on every result row (ruling 165 K, ruling 166 D)."""
    freeze_text(); addendum_sha(); addendum166_sha()
    return {"freeze_sha12": FREEZE_SHA12, "addendum_sha12": ADDENDUM_SHA12, "addendum166_sha12": ADDENDUM166_SHA12}


def select_turns(arm1_rows, mode, turn_ids=None, confident_ids=None, extra_ids=None):
    """Which turns an arm runs on. doubtful = every DOUBTFUL turn; doubtful+page = those plus the confident sample, which is the 40 confident items of the
    "Who is speaking" page (ruling 169 X1: they have human truth), given as confident_ids; all = everything.
    extra_ids = turns that are NOT in the arm 1 file but must still be run (ruling 290 E3X pseudo-turns: no production row, so they never enter arm1_in);
    they are added as given. turn_ids (a list) restricts the result further (used by the refuter's stability re-query)."""
    have = {r["turn_id"] for r in arm1_rows}
    ids = {r["turn_id"] for r in arm1_rows if is_doubtful(r)} if mode != "all" else set(have)
    if mode == "doubtful+page":
        if confident_ids is None: raise SystemExit("--select doubtful+page needs --confident-ids (the page's 40 confident items)")
        ids |= set(confident_ids) & have
    if extra_ids: ids |= set(extra_ids) - have          # ids that ARE in arm 1 follow the normal selection, not this back door
    return ids & set(turn_ids) if turn_ids is not None else ids


def read_jsonl(p):
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


def write_jsonl(p, rows):
    os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
    with open(p, "w") as f:
        for r in rows: f.write(json.dumps(r, sort_keys=True) + "\n")


def append_jsonl(p, row):
    with open(p, "a") as f: f.write(json.dumps(row, sort_keys=True) + "\n")


def blind_check(path, rows):
    """Arm runners must never see truth. Refuse a truth-looking path or any record carrying a truth-looking key."""
    for part in FORBIDDEN_PATH_PARTS:
        if part in os.path.abspath(path): raise SystemExit(f"blinding: runner refuses input path containing '{part}': {path}")
    for r in rows:
        bad = FORBIDDEN_KEYS & set(r)
        if bad: raise SystemExit(f"blinding: input record {r.get('turn_id') or r.get('window_id')} carries {sorted(bad)}")


# ---- frozen definitions ----
MIN_CONFIDENT_MARGIN, MIN_CONFIDENT_BEST = 0.10, 0.50


def is_doubtful(rec):
    """Phase 0 DOUBTFUL: margin < 0.10 OR speaker_basis == diarization_only OR nemotron_n != pyannote_n, amended by ruling 186: CONFIDENT also needs
    best >= 0.50 (the turn's best match to the room-day doctor's VERIFIED centroid). Gaps (COMBINE_RULE.md D1): missing margin or missing best => doubtful;
    a missing diarizer count is not a disagreement."""
    if rec.get("speaker_basis") == "diarization_only": return True
    m, b = rec.get("margin"), rec.get("best")
    if m is None or m < MIN_CONFIDENT_MARGIN or b is None or b < MIN_CONFIDENT_BEST: return True
    n, p = rec.get("nemotron_n"), rec.get("pyannote_n")
    return n is not None and p is not None and n != p


Q1_KEYS = ["doctor", "patient", "companion", "staff", "cannot_tell"]


def questions(doctor_name):
    """Q1-Q3 wording lifted from freeze.txt so it stays verbatim; <Dr X> filled from the card's candidate."""
    text, _ = freeze_text()
    card = text.split("ARM 2 CONTROL PROMPT")[0]
    q = {k: re.search(rf"^{k} \((?:choice|yes/no)\): (.*)$", card, re.M) for k in ("Q1", "Q2", "Q3")}
    if not all(q.values()): raise SystemExit("could not parse Q1-Q3 from freeze.txt")
    q1 = q["Q1"].group(1)
    q1_text = q1.split(" Options:")[0]
    dr = doctor_name or "the doctor"
    return {
        "q1": {"type": "choice", "instructions": q1_text, "criteria": {
            "doctor": f"the doctor ({dr})", "patient": "the patient", "companion": "a companion or relative",
            "staff": "staff", "cannot_tell": "cannot tell"}},
        "q2": {"type": "noul", "instructions": q["Q2"].group(1)},
        "q3": {"type": "noul", "instructions": q["Q3"].group(1)},
    }


def strip_question_block(text):
    """The state is the card without its own Q1-Q3 lines (the questions travel in `questions`)."""
    return re.split(r"^\s*Q1 \(choice\)", text, maxsplit=1, flags=re.M)[0].rstrip() + "\n"


# ---- Jev ----
def jev_call(state, qs, timeout=90, model="jev-latest", key_path=JEV_KEY):
    key = open(key_path).read().strip()
    body = json.dumps({"model": model, "state": state, "questions": qs}).encode()
    for attempt in range(1, 6):
        req = urllib.request.Request(JEV_URL, data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 5: time.sleep(2 ** attempt); continue
            raise RuntimeError(f"jev http {e.code}")
        except Exception as e:
            if attempt < 3: time.sleep(2 ** attempt); continue
            raise RuntimeError(f"jev error {type(e).__name__}")


# ---- Vertex Gemini ----
_tok = {"t": None, "at": 0}
def vertex_token():
    """Service-account token from the box's own gcloud (cloud-platform scope). Cached 40 min."""
    if _tok["t"] is None or time.time() - _tok["at"] > 2400:
        _tok["t"] = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True, stderr=subprocess.DEVNULL).strip()
        _tok["at"] = time.time()
    return _tok["t"]


def vertex_generate(model, body, location="global", timeout=120):
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    url = f"https://{host}/v1/projects/{VERTEX_PROJECT}/locations/{location}/publishers/google/models/{model}:generateContent"
    for attempt in range(1, 6):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {vertex_token()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 5: time.sleep(2 ** attempt); continue
            raise RuntimeError(f"vertex http {e.code}")  # refused (403/404) is reported, not worked around
        except Exception as e:
            if attempt < 3: time.sleep(2 ** attempt); continue
            raise RuntimeError(f"vertex error {type(e).__name__}")
