"""jev_client.py: Jev (TypeSafe) choice-question client for the role judges (6S9) and the reference set's Matcher B (8A).

V rulings O6/O7 (09 Oct 2026): Jev may read PHI under ZDR. API shape: in/JEV-API-SHAPE.md (from the even-jev-mcp source): POST https://api.typesafe.ai/v1/systemone,
body {"state": str, "model": "jev-latest", "questions": {id: {"type": "choice", "instructions": str, "criteria": {option: description}}}}, response
{"model", "answers": {id: {"type": "choice", "choice", "probabilities": {option: p}, "confidence"}}, "usage": {"input_tokens", "output_tokens"}}.
Retry on 429 / 529 / 5xx honouring retry-after (max 2 retries), 30 s timeout. 400 max_tokens_exceeded = input too large, 401 bad key, 422 bad questions: never retried.

Secrets and text: the key is read from ~/.config/even-jev/key INSIDE the process when a request is made, only ever placed in the Authorization header, and never logged,
stored in an exception or printed. The state text and the questions are never logged: only status, tokens, latency and counts go to the log callback.
Thresholds (what probability counts as an answer) live in the callers, not here.
"""
import json
import os
import time
import urllib.error
import urllib.request

URL = "https://api.typesafe.ai/v1/systemone"
KEY_FILE = os.path.expanduser("~/.config/even-jev/key")
MODEL = "jev-latest"
TIMEOUT_S = 30
MAX_RETRIES = 2
RETRY_STATUS = (429, 529)
ESCAPE_ID = "cannot_tell"


class JevError(RuntimeError):
    """A Jev call failed. `reason` is a short code (no text, no key): bad_key | bad_questions | input_too_large | http_<status> | network | bad_response | no_key."""

    def __init__(self, reason, status=None):
        super().__init__(reason if status is None else f"{reason} (HTTP {status})")
        self.reason, self.status = reason, status


class JevClient:
    def __init__(self, key_file=KEY_FILE, url=URL, model=MODEL, timeout=TIMEOUT_S, retries=MAX_RETRIES, sleep=time.sleep, opener=urllib.request.urlopen, log=None):
        self._key_file, self.url, self.model, self.timeout, self.retries = key_file, url, model, timeout, retries
        self._sleep, self._opener, self._log = sleep, opener, log
        self.model_id = None   # the model as the server reports it; becomes part of the role track's cfg8
        self.stats = {"calls": 0, "ok": 0, "retries": 0, "input_tokens": 0, "output_tokens": 0, "errors": {}, "latency_s": []}

    def __repr__(self):   # never shows the key file contents
        return f"JevClient(url={self.url!r}, model={self.model!r}, calls={self.stats['calls']})"

    def _key(self):
        try:
            k = open(self._key_file).read().strip()
        except OSError:
            raise JevError("no_key")
        if not k:
            raise JevError("no_key")
        return k

    def _emit(self, **meta):
        if self._log:
            self._log(meta)

    def _post(self, body):
        """-> parsed JSON. Metadata (status, tokens, latency, attempts) is logged; the body, the state and the key are not."""
        data = json.dumps(body).encode()
        headers = {"Authorization": "Bearer " + self._key(), "Content-Type": "application/json"}
        attempt = 0
        while True:
            t = time.time()
            self.stats["calls"] += 1
            try:
                req = urllib.request.Request(self.url, data=data, headers=headers, method="POST")
                with self._opener(req, timeout=self.timeout) as r:
                    status, raw = getattr(r, "status", 200), r.read()
            except urllib.error.HTTPError as e:
                status, raw, hdrs = e.code, b"", e.headers
                try:
                    raw = e.read()
                except Exception:  # noqa: BLE001
                    pass
                lat = round(time.time() - t, 3)
                self._emit(status=status, latency_s=lat, attempt=attempt)
                if status in RETRY_STATUS or status >= 500:
                    if attempt < self.retries:
                        attempt += 1
                        self.stats["retries"] += 1
                        try:
                            wait = float((hdrs or {}).get("retry-after", 0))
                        except (TypeError, ValueError):
                            wait = 0.0
                        self._sleep(wait if wait > 0 else 1.0 * attempt)
                        continue
                    self._fail(f"http_{status}", status)
                if status == 401:
                    self._fail("bad_key", status)
                if status == 422:
                    self._fail("bad_questions", status)
                if status == 400:
                    self._fail("input_too_large" if b"max_tokens" in raw else "http_400", status)
                self._fail(f"http_{status}", status)
            except (urllib.error.URLError, OSError, TimeoutError):
                self._emit(status=None, latency_s=round(time.time() - t, 3), attempt=attempt, error="network")
                if attempt < self.retries:
                    attempt += 1
                    self.stats["retries"] += 1
                    self._sleep(1.0 * attempt)
                    continue
                self._fail("network", None)
            lat = round(time.time() - t, 3)
            try:
                out = json.loads(raw)
            except ValueError:
                self._emit(status=status, latency_s=lat, attempt=attempt, error="bad_response")
                self._fail("bad_response", status)
            u = out.get("usage") or {}
            self.stats["ok"] += 1
            self.stats["input_tokens"] += u.get("input_tokens") or 0
            self.stats["output_tokens"] += u.get("output_tokens") or 0
            self.stats["latency_s"].append(lat)
            self._emit(status=status, latency_s=lat, attempt=attempt, input_tokens=u.get("input_tokens"), output_tokens=u.get("output_tokens"))
            return out

    def _fail(self, reason, status):
        self.stats["errors"][reason] = self.stats["errors"].get(reason, 0) + 1
        raise JevError(reason, status)

    def ask_choice(self, state, questions):
        """questions: {qid: (instructions, {option_id: description})}. -> {qid: {option_id: probability}}. One request for all the questions."""
        body = {"state": state, "model": self.model,
                "questions": {q: {"type": "choice", "instructions": ins, "criteria": crit} for q, (ins, crit) in questions.items()}}
        out = self._post(body)
        if out.get("model"):
            self.model_id = out["model"]
        res = {}
        for q in questions:
            a = (out.get("answers") or {}).get(q) or {}
            pr = a.get("probabilities")
            if not isinstance(pr, dict):
                self._fail("bad_response", None)
            res[q] = {k: float(v) for k, v in pr.items()}
        return res

    def warm_up(self):
        """One call on a SYNTHETIC state (no consult text) so model_id is known before any clip is processed: the role track's cfg8 includes the judge identity, and it
        must not depend on whether a clip happens to be processed before or after the first real call. -> the model as the server reports it."""
        self.choose("warm-up", "Choose option a.", ["a", "b"], "none")
        if not self.model_id:
            raise JevError("bad_response")
        return self.model_id

    def choose_many(self, state, questions):
        """The judges' batched interface: questions = {key: (question, options, escape)} -> {key: {option: probability, escape: probability}} in ONE request (the state is
        sent once). Question ids sent to Jev are q0, q1, ...; option ids are the option strings; each escape is sent as ESCAPE_ID."""
        ids = {f"q{i}": k for i, k in enumerate(questions)}
        sent = {}
        for qid, k in ids.items():
            question, options, escape = questions[k]
            crit = {str(o): f"The answer is {o}." for o in options}
            crit[ESCAPE_ID] = escape
            sent[qid] = (question, crit)
        res = self.ask_choice(state, sent)
        return {ids[qid]: {(questions[ids[qid]][2] if o == ESCAPE_ID else o): v for o, v in pr.items()} for qid, pr in res.items()}

    def choose(self, state, question, options, escape):
        """The judges' interface: one choice over `options` plus an escape option -> {option: probability, escape: probability}. Option ids are the strings themselves
        (speaker ids, roles); the escape is sent as ESCAPE_ID and returned under the caller's `escape` key."""
        crit = {str(o): f"The answer is {o}." for o in options}
        crit[ESCAPE_ID] = escape
        pr = self.ask_choice(state, {"q": (question, crit)})["q"]
        return {(escape if k == ESCAPE_ID else k): v for k, v in pr.items()}
