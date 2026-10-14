#!/usr/bin/env python3
"""build_consult.py — one JSON per consult for the v2 review page (orders/SURGERY-REVIEW-V2.md items 3, 4, 6).

For each pilot consult (turns from fetch_turns.py):
  * English alongside: turns whose STT language is not English go through OpenRouter (google/gemini-3.8-flash, ZDR + data_collection deny,
    temperature 0, the router's own translate system prompt, verbatim). 'english' turns are skipped and marked as such.
  * Jev U9 (u9.py, wording v2.2) on the FULL English consult: the proposals; plus per-turn EVIDENCE probes (5 kinds x every turn, chunked to
    <=180 questions per call; Jev supports 1-200 per call) so each answer can link to the turns that carry it.
  * The procedure phrase: Jev cannot return free text, so a Gemini call reads only the evidence turns and returns a short phrase or null.
The reviewer sees these as PROPOSALS (Agree / Correct); nothing pre-selects the form. No bucket appears here (kept in selection.json).
Writes ~/eta-data/surgery-review-v2/consult-<id>.json (0600). Prints counts only. `--selftest` runs offline.
"""
import json, os, re, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
import u9

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
TRANSLATE_MODEL = "google/gemini-3.8-flash"
OR_URL = "https://openrouter.ai/api/v1/chat/completions"
CHUNK = 180
EVIDENCE_MIN_P, EVIDENCE_MAX = 0.5, 6
TRANSLATE_SYSTEM = ("You translate a clinic conversation transcript into English, faithfully.\n- Leave English words and English sentences exactly as they are.\n"
    "- Keep drug names, doses, numbers and units exact.\n- Never summarise, and never add or drop any content.\n"
    "- If the input is already English, return it unchanged.\n- Output only the translation: no preamble, no notes, no quotation marks.")
PROBES = {
    "P": "Does line [{i}] take part in discussing a surgical or interventional procedure: naming it, proposing or explaining it, or referring back to it?",
    "R": "Is line [{i}] the patient (or an attender) reacting to a proposed procedure: agreeing, hesitating, asking for time, refusing, or questioning it?",
    "C": "Does line [{i}] mention the cost, price or insurance coverage of a procedure?",
    "T": "Does line [{i}] give a timeframe or urgency for doing a procedure (soon, next week, within a month, do not delay)?",
    "S": "Does line [{i}] mention getting a second opinion?",
}
EVIDENCE_NAME = {"P": "procedure", "R": "patient_reaction", "C": "cost", "T": "timeframe", "S": "second_opinion"}


def _post(fn_name, transport, *a, **k):
    return transport(*a, **k)


import time
_sleep = time.sleep


def or_chat(messages, json_mode=False, transport=None):
    if transport:
        return transport(messages, json_mode)
    key = open(os.path.expanduser("~/.claude/secrets/openrouter_api_key")).read().strip()
    body = {"model": TRANSLATE_MODEL, "temperature": 0, "provider": {"zdr": True, "data_collection": "deny"}, "messages": messages}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(OR_URL, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    for wait in (0, 4, 12, 30, 60):  # a rate limit (429) or a server error (5xx) is retried with backoff; anything else fails at once
        if wait:
            _sleep(wait)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)["choices"][0]["message"]["content"]
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and wait != 60:
                continue
            raise SystemExit(f"openrouter http {e.code}")  # body withheld
        except Exception as e:
            raise SystemExit(f"openrouter error {type(e).__name__}")


def translate_turns(turns, transport=None):
    """Adds t['en'] for non-English turns (None for English/already-English). Batches of 25 numbered lines, JSON in, JSON out."""
    todo = [t for t in turns if (t.get("lang") or "").lower() not in ("english", "en")]
    for t in turns:
        t["en"] = None
    for k in range(0, len(todo), 25):
        batch = todo[k:k + 25]
        user = ("Translate each numbered line to English. Reply with a JSON object {\"1\": \"...\", \"2\": \"...\"} keyed by the line numbers, nothing else.\n\n" +
                "\n".join(f"{n + 1}. {t['text']}" for n, t in enumerate(batch)))
        raw = or_chat([{"role": "system", "content": TRANSLATE_SYSTEM}, {"role": "user", "content": user}], json_mode=True, transport=transport)
        try:
            got = json.loads(raw)
        except ValueError:
            raise SystemExit("translation reply was not JSON")
        for n, t in enumerate(batch):
            v = got.get(str(n + 1))
            if not isinstance(v, str) or not v.strip():
                raise SystemExit("translation reply missing a line: refusing to show source text as English")
            t["en"] = v.strip()
    return len(todo)


def english(t):
    return t["en"] if t.get("en") else t["text"]


def state_text(turns):
    return ("A doctor-patient consultation transcript. Lines are numbered. 'Doctor' is a voiceprint-confirmed doctor; 'Speaker A/B/...' are unlabelled speakers "
            "(letters restart at each audio window; a speaker may be the patient, an attender or staff). The text is machine-transcribed and may be garbled.\n\n" +
            "\n".join(f"[{t['i']}] {t['speaker']}: {english(t)}" for t in turns))


def probe_questions(turns):
    qs = {}
    for t in turns:
        for kind, tmpl in PROBES.items():
            qs[f"{kind}{t['i']}"] = {"type": "noul", "instructions": tmpl.format(i=t["i"])}
    return qs


def chunks(d, n):
    items = list(d.items())
    return [dict(items[k:k + n]) for k in range(0, len(items), n)]


def evidence_from(answers, turns):
    """{kind_name: [turn indexes]} = turns whose probe P>=0.5, at most 6 per kind (highest first, then time order)."""
    ev = {}
    for kind, name in EVIDENCE_NAME.items():
        scored = []
        for t in turns:
            a = answers.get(f"{kind}{t['i']}")
            if a and a["type"] == "noul" and a["noul"] >= EVIDENCE_MIN_P:
                scored.append((a["noul"], t["i"]))
        top = sorted(scored, key=lambda x: -x[0])[:EVIDENCE_MAX]
        ev[name] = sorted(i for _, i in top)
    return ev


def procedure_phrase(turns, ev_idx, transport=None):
    if not ev_idx:
        return {"phrase": None, "named": False}
    keep = sorted({j for i in ev_idx for j in (i - 1, i, i + 1)})
    by = {t["i"]: t for t in turns}
    lines = "\n".join(f"[{j}] {by[j]['speaker']}: {english(by[j])}" for j in keep if j in by)
    sys_p = ("You read a few lines of a machine-transcribed doctor-patient conversation. Say what surgical or interventional procedure, if any, is being discussed. "
             "Use only what the lines say; never guess or complete a name that is not there. If only surgery in general is mentioned, or the text is too garbled, answer null. "
             "Reply with JSON {\"procedure\": <short phrase or null>, \"named\": <true if a specific procedure or operation is named, false if it is only described or vague>}.")
    raw = or_chat([{"role": "system", "content": sys_p}, {"role": "user", "content": lines}], json_mode=True, transport=transport)
    if not isinstance(raw, str) or not raw.strip():  # an empty reply (content None) happened on a real consult: ask once more, then fail soft to "no phrase"
        raw = or_chat([{"role": "system", "content": sys_p}, {"role": "user", "content": lines}], json_mode=True, transport=transport)
    try:
        j = json.loads(raw)
    except (ValueError, TypeError):
        return {"phrase": None, "named": False, "error": "non_json"}
    ph = j.get("procedure")
    return {"phrase": ph.strip()[:80] if isinstance(ph, str) and ph.strip() else None, "named": bool(j.get("named")) and bool(ph)}


def read_consult(turns, jev=None, transport=None):
    """Jev proposals + evidence for one consult. `jev(state, questions)` is injectable for the selftest."""
    jev = jev or u9.ask
    state = state_text(turns)
    main = jev(state, {**u9.QUESTIONS, "too_poor": {"type": "noul", "instructions":
        "Is this transcript too garbled, fragmentary or incomplete to tell reliably what was discussed about any surgical procedure?"}})["answers"]
    prop = {}
    for f in ("discussed", "context", "proposed_by", "recommended", "firmness", "patient_response", "urgency", "cost", "second_opinion", "procedure_named", "too_poor"):
        a = main[f]
        if a["type"] == "choice":
            prop[f] = {"value": a["choice"], "confidence": a.get("confidence"), "probs": a.get("probabilities")}
        else:
            prop[f] = {"value": "yes" if a["noul"] >= 0.5 else "no", "confidence": round(max(a["noul"], 1 - a["noul"]), 3), "p_yes": a["noul"]}
    skip = prop["discussed"]["p_yes"] < 0.2 and prop["context"]["value"] == "no_surgical_talk" and (prop["context"]["confidence"] or 0) >= 0.8
    answers, calls = {}, 0
    if not skip:
        for ch in chunks(probe_questions(turns), CHUNK):
            answers.update(jev(state, ch)["answers"]); calls += 1
    ev = evidence_from(answers, turns) if answers else {n: [] for n in EVIDENCE_NAME.values()}
    proc = procedure_phrase(turns, ev["procedure"], transport=transport)
    return {"proposals": prop, "evidence": ev, "procedure": proc, "probe_calls": calls, "probes_skipped": skip}


def build(c, turns, transport=None):
    for n, t in enumerate(turns, 1):
        t["i"] = n
    n_tr = translate_turns(turns, transport=transport)
    r = read_consult(turns, transport=transport)
    return {"id": c["id"], "minutes": c["minutes"], "n_turns": len(turns), "translated_turns": n_tr,
            "turns": [{k: t.get(k) for k in ("i", "at", "window", "speaker", "speaker_basis", "lang", "text", "en")} | {"audio": None} for t in turns],
            **r, "versions": {"u9": u9.PROMPT_VERSION, "translate_model": TRANSLATE_MODEL, "jev_model": "jev-latest"}}


def selftest():
    turns = [{"text": f"line {i}", "lang": "english", "speaker": "Doctor" if i % 2 else "Speaker A", "speaker_basis": "voiceprint", "window": "w1", "at": "t"} for i in range(1, 9)]
    turns[3]["lang"] = "hindi"; turns[3]["text"] = "namaste"
    for n, t in enumerate(turns, 1):
        t["i"] = n
    sent = []

    def fake_tr(messages, json_mode):
        sent.append(messages)
        if "Translate each numbered" in messages[-1]["content"]:
            return json.dumps({"1": "hello"})
        return json.dumps({"procedure": "knee replacement", "named": True})
    assert translate_turns(turns, transport=fake_tr) == 1 and turns[3]["en"] == "hello" and turns[0]["en"] is None, "only the non-English turn is translated"
    assert len(sent) == 1 and "line 1" not in sent[0][-1]["content"], "English turns must not be sent for translation"
    try:
        translate_turns([{"text": "x", "lang": "hindi", "i": 1}], transport=lambda m, j: json.dumps({"1": ""}))
        raise AssertionError("an empty translation must be refused, never shown as English")
    except SystemExit:
        pass
    qs = probe_questions(turns)
    assert len(qs) == 5 * 8 and "P3" in qs and "[3]" in qs["P3"]["instructions"]
    parts = chunks(probe_questions([{"i": i} for i in range(1, 100)]), CHUNK)
    assert [len(p) for p in parts] == [180, 180, 135], [len(p) for p in parts]
    ans = {f"P{i}": {"type": "noul", "noul": 0.9 if i in (2, 3) else 0.1} for i in range(1, 9)}
    ans["R5"] = {"type": "noul", "noul": 0.6}
    ev = evidence_from(ans, turns)
    assert ev["procedure"] == [2, 3] and ev["patient_reaction"] == [5] and ev["cost"] == [], ev
    many = {f"P{i}": {"type": "noul", "noul": 0.5 + i / 100} for i in range(1, 9)}
    assert len(evidence_from(many, turns)["procedure"]) == EVIDENCE_MAX, "evidence is capped per kind"
    assert procedure_phrase(turns, [], transport=fake_tr) == {"phrase": None, "named": False}
    assert procedure_phrase(turns, [2], transport=fake_tr)["phrase"] == "knee replacement"
    calls = []

    def fake_jev(state, q):
        calls.append(len(q))
        if "discussed" in q:
            return {"answers": {**{k: ({"type": "choice", "choice": "no_surgical_talk", "confidence": 0.95, "probabilities": {}} if v["type"] == "choice" else {"type": "noul", "noul": 0.03}) for k, v in q.items()}}}
        return {"answers": {k: {"type": "noul", "noul": 0.9} for k in q}}
    r = read_consult(turns, jev=fake_jev, transport=fake_tr)
    assert r["probes_skipped"] and r["probe_calls"] == 0 and calls == [len(u9.QUESTIONS) + 1], "a confident no-surgery consult skips the per-turn probes"
    # an empty reply (content None) is asked again once; two empty replies fail soft to "no phrase" instead of crashing
    seq = iter([None, '{"procedure": "septoplasty", "named": true}'])
    assert procedure_phrase([{"i": 1, "speaker": "Doctor", "en": "x", "text": "x"}], [1], transport=lambda m, j: next(seq)) == {"phrase": "septoplasty", "named": True}, "one empty reply is retried"
    assert procedure_phrase([{"i": 1, "speaker": "Doctor", "en": "x", "text": "x"}], [1], transport=lambda m, j: None)["phrase"] is None, "two empty replies -> no phrase, no crash"
    # a 429 is retried with backoff (0, 4, 12, 30, 60 s), a 400 is not; the key/body never leave the function
    import io
    calls, waits = [], []
    class _R(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_open(code_seq):
        it = iter(code_seq)
        def f(req, timeout=60):
            c = next(it); calls.append(c)
            if c == 200:
                return _R(json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode())
            raise urllib.error.HTTPError("u", c, "x", {}, None)
        return f
    orig_open, orig_sleep = urllib.request.urlopen, globals()["_sleep"]
    globals()["_sleep"] = lambda w: waits.append(w)
    try:
        urllib.request.urlopen = fake_open([429, 429, 200]); assert or_chat([{"role": "user", "content": "x"}]) == "ok" and calls == [429, 429, 200] and waits == [4, 12], (calls, waits)
        calls.clear(); waits.clear(); urllib.request.urlopen = fake_open([400])
        try:
            or_chat([{"role": "user", "content": "x"}]); raise AssertionError("a 400 must fail at once")
        except SystemExit:
            assert calls == [400] and waits == []
        calls.clear(); waits.clear(); urllib.request.urlopen = fake_open([429] * 5)
        try:
            or_chat([{"role": "user", "content": "x"}]); raise AssertionError("five 429s must fail")
        except SystemExit:
            assert calls == [429] * 5 and waits == [4, 12, 30, 60], (calls, waits)
    finally:
        urllib.request.urlopen, globals()["_sleep"] = orig_open, orig_sleep
    print("selftest OK: translation only for non-English turns, empty translation refused, probes 5/turn chunked at 180, evidence capped, skip path")
    test_quarantine()


def test_quarantine():
    """W41 F1 (jev-audit #23): the raw v2 CLI must refuse before touching Jev or OpenRouter, even with real-shaped un-scrubbed text on disk."""
    import tempfile
    calls = []

    def spy_ask(*a, **k):
        calls.append("jev"); raise AssertionError("Jev must never be called by the quarantined entrypoint")

    def spy_urlopen(*a, **k):
        calls.append("http"); raise AssertionError("OpenRouter must never be called by the quarantined entrypoint")

    orig_ask, orig_urlopen, orig_out, orig_argv = u9.ask, urllib.request.urlopen, globals()["OUT"], sys.argv
    u9.ask, urllib.request.urlopen = spy_ask, spy_urlopen
    try:
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(f"{d}/work")
            json.dump({"pilot": [{"id": "X01", "minutes": 5}]}, open(f"{d}/selection.json", "w"))
            json.dump([{"i": 1, "text": "call me on 98450 12345, I am Sunita Verma", "lang": "english",
                        "speaker": "Speaker A", "speaker_basis": "x", "window": "w1", "at": "t"}], open(f"{d}/work/X01.turns.json", "w"))
            globals()["OUT"] = d
            sys.argv = ["build_consult.py"]
            try:
                main()
                raise AssertionError("the raw v2 entrypoint must refuse to run")
            except SystemExit as e:
                assert "QUARANTINED" in str(e), e
        assert not calls, f"no external client may be reached, even with un-scrubbed text present: {calls}"
    finally:
        u9.ask, urllib.request.urlopen, sys.argv = orig_ask, orig_urlopen, orig_argv
        globals()["OUT"] = orig_out
    print("test_quarantine OK: raw entrypoint refuses before any external call, un-scrubbed text never leaves the box")


QUARANTINE_MSG = (
    "QUARANTINED (W41 F1, jev-audit finding #23, 27 Sep 2026): this v2 entrypoint read RAW turns straight from "
    "work/*.turns.json (no de-identification) and sent them to both OpenRouter (translate_turns/procedure_phrase) "
    "and Jev (u9.ask) before any de-id gate ran -- a live PHI-exposure path, contrary to V's standing ruling 42/43. "
    "It is superseded by the gated v3/v4/v5 pipeline: build_v3.py / build_v4.py route de-identified turns through "
    "finalize.py's residual_identifiers() check before ever calling bc.read_consult/bc.build. This module's "
    "functions (read_consult, build, translate_turns, procedure_phrase) remain safe to import as a library -- the "
    "caller is responsible for de-identifying turns first. Only this raw standalone CLI path is quarantined."
)


def main():
    if "--selftest" in sys.argv:
        return selftest()
    raise SystemExit(QUARANTINE_MSG)


if __name__ == "__main__":
    main()
