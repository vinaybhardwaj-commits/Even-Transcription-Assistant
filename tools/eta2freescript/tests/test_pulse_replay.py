"""Offline replay of the downstream parse. Fake transport only; every prompt string here is synthetic."""
from __future__ import annotations

import copy
import json
import logging
import re
import shutil
from datetime import date
from pathlib import Path

import pytest

from tools.eta2freescript.eval.pulse import assets as A
from tools.eta2freescript.eval.pulse import replay as R
from tools.eta2freescript.eval.pulse.catalogue import Catalogue, SearchParams
from tools.eta2freescript.eval.pulse.schema import build_schema, field_paths
from tools.eta2freescript.eval.pulse.vertex import (ReplayUnavailable, TranscriptGuardError, VertexClient, guard_request)

FIX = Path(__file__).resolve().parent / "fixtures" / "pulse"
VISIT = date(2026, 10, 13)
SERVED = "synthetic-served-id-007"


@pytest.fixture
def assets():
    return json.loads((FIX / "assets.json").read_text())


@pytest.fixture
def cat():
    return Catalogue.load(FIX / "catalogue.jsonl")


@pytest.fixture
def extraction():
    return json.loads((FIX / "extraction.json").read_text())


class FakeTransport:
    """Answers the extraction call with a fixture, and each adjudicator call with adj(user_text) -> dict."""

    def __init__(self, extraction, adj=None, model_version=SERVED):
        self.extraction, self.adj, self.model_version = extraction, adj, model_version
        self.calls = []

    def __call__(self, url, headers, body):
        sysmsg = body["systemInstruction"]["parts"][0]["text"]
        user = body["contents"][0]["parts"][0]["text"]
        self.calls.append({"url": url, "system": sysmsg, "user": user, "body": body})
        if sysmsg.startswith("SYNTHETIC SYSTEM PROMPT"):
            text = json.dumps(self.extraction)
        else:
            out = self.adj(user) if self.adj else {"choice": 0, "reason": "NO_VALID_CANDIDATE", "note": ""}
            text = out if isinstance(out, str) else json.dumps(out)
        resp = {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 7, "totalTokenCount": 18}}
        if self.model_version:
            resp["modelVersion"] = self.model_version
        return resp


def client(transport):
    return VertexClient("synth-proj-001", "asia-northeast1", lambda: "SYNTHTOKEN9", transport=transport)


def pick_line(user, needle):
    for line in user.splitlines():
        m = re.match(r"(\d+)\. (.*)", line)
        if m and needle in m.group(2):
            return int(m.group(1))
    return 0


def pick_zorvex(user):
    n = pick_line(user, "Zorvex")
    return {"choice": n, "reason": "MATCHED" if n else "NO_VALID_CANDIDATE", "note": ""}


def run(assets, cat, extraction, adj=pick_zorvex):
    t = FakeTransport(extraction, adj)
    return R.replay((FIX / "note.txt").read_text(), VISIT, cat, client(t), assets=assets), t


# ---- section-guide mapping round trip, normalisation ------------------------------------------------------------

def test_round_trip_and_normalisation(assets, cat, extraction):
    note = (FIX / "note.txt").read_text()
    assert len(re.findall(r"^[A-Za-z][A-Za-z\- ]*:", note, re.M)) == 11
    res, t = run(assets, cat, extraction)
    ext_call = t.calls[0]
    assert ext_call["system"] == "SYNTHETIC SYSTEM PROMPT 2026-10-13\n\nSYNTHETIC SECTION GUIDE"
    assert "SYNTHETIC MERGE CLAUSE" not in ext_call["system"]  # empty draft: no merge
    assert ext_call["user"] == note
    assert "responseJsonSchema" in ext_call["body"]["generationConfig"]
    assert res["extraction"] == extraction
    n = res["normalised"]
    surg = n["plan_of_management"]["surgery_or_procedure_recommendations"]
    assert surg[0]["scheduled_date"] == "2026-12-01" and surg[1]["scheduled_date"] == ""  # past date dropped
    com = n["comorbidities"]
    assert com[0]["duration"] == {"value": 2, "unit": "YEARS"}
    assert "duration" not in com[1] and "duration" not in com[2]  # 1001 days, UNKNOWN unit
    assert res["normalise_drops"] == {"durations": 2, "dates": 1, "empty_names": 1}
    assert len(n["medicines"]) == 3  # empty name skipped
    assert n["follow_up"]["followup_date"] == "2026-10-27"


def test_date_far_future_dropped(assets):
    ext = {"further_investigations": [{"name": "x", "raw_name": "x", "scheduled_date": "2031-10-14"},
                                      {"name": "y", "raw_name": "y", "scheduled_date": "2031-10-13"},
                                      {"name": "z", "raw_name": "z", "scheduled_date": "13/10/2026"}]}
    out, d = R.normalise(ext, VISIT, assets)
    assert [i["scheduled_date"] for i in out["further_investigations"]] == ["", "2031-10-13", ""] and d["dates"] == 2


def test_extraction_schema_failure_retries_then_unavailable(assets, cat):
    t = FakeTransport({"unknown_top_key": 1})
    with pytest.raises(ReplayUnavailable):
        R.replay("note", VISIT, cat, client(t), assets=assets)
    assert len(t.calls) == 2  # 1 try + 1 retry


# ---- resolution -------------------------------------------------------------------------------------------------

def by_query(res, q):
    return next(r for r in res["resolutions"] if q in r["query_terms"] and r["kind"] != "referral")


def test_exact_match_short_circuits(assets, cat, extraction):
    res, t = run(assets, cat, extraction)
    r = by_query(res, "Zorvex 500")
    assert r["method"] == "EXACT_MATCH" and r["candidate_uid"] == "m01"
    exact_n_calls = sum(1 for c in t.calls if "SYNTH wrote: Zorvex 500" in c["user"])
    assert exact_n_calls == 0
    assert by_query(res, "Synthetic fever syndrome")["method"] == "EXACT_MATCH"


def test_aliases_never_exact_match(assets, cat, extraction):
    res, t = run(assets, cat, extraction)
    r = by_query(res, "Quelitra")
    assert r["query_terms"] == ["Quelitra", "Zorvex 500"]
    assert r["method"] == "LLM_PICK" and r["candidate_uid"] == "m01" and r["reason"] == "MATCHED"
    call = next(c for c in t.calls if "SYNTH wrote: Quelitra" in c["user"])
    assert "SYNTH aka: Zorvex 500" in call["user"] and "SYNTH candidates:" in call["user"]
    assert call["system"] == "SYNTHETIC ADJUDICATOR medicine / SYNTH RULE MED"


def test_no_match_gives_other_medicine_with_dictated_name(assets, cat, extraction):
    res, _ = run(assets, cat, extraction)
    r = by_query(res, "Blorpanol")
    assert r["method"] == "NO_MATCH" and r["candidate_uid"] is None
    other = [m for m in res["prescription"]["medicines"] if m["other"]]
    assert [m["name"] for m in other] == ["Blorpanol"] and other[0]["uid"] is None and other[0]["frequency"] == "at night"
    assert res["other_medicines"] == 1


def test_unmatched_investigation_and_referral_dropped_and_counted(assets, cat, extraction):
    res, _ = run(assets, cat, extraction)
    rx = res["prescription"]
    assert [i["uid"] for i in rx["investigations"]] == ["i01"]
    assert rx["investigations"][0]["urgent"] is True
    assert [r["name"] for r in rx["referrals"]] == ["Synthetic Orthopaedics"]  # exact over the shorter-name rule
    assert res["dropped"] == {"investigations": 1, "referrals": 1}


def test_referral_shortest_name_without_model(assets, cat):
    rec, ent = R.resolve_referral({"speciality": "Orthopaedics"}, cat, SearchParams())
    assert rec["method"] == "SHORTEST_NAME" and ent["uid"] == "p02"


def test_free_text_entities_when_unmatched(assets, cat, extraction):
    res, _ = run(assets, cat, extraction)
    dx = res["prescription"]["diagnoses"]
    assert dx[1]["free_text"] and dx[1]["uid"] is None and dx[1]["name"] == "Unlisted synthetic ailment"
    assert dx[0]["icd"] == "Z01.1"


@pytest.mark.parametrize("answer, method", [
    ({"choice": 99, "reason": "MATCHED", "note": ""}, "LLM_INCOHERENT"),
    ({"choice": 0, "reason": "MATCHED", "note": ""}, "LLM_INCOHERENT"),
    ({"choice": 1, "reason": "NO_VALID_CANDIDATE", "note": ""}, "LLM_INCOHERENT"),
    ({"choice": 0, "reason": "AMBIGUOUS", "note": ""}, "LLM_INCOHERENT"),
    ({"choice": -1, "reason": "NO_VALID_CANDIDATE", "note": ""}, "LLM_INCOHERENT"),
    ({"choice": 0, "reason": "NO_VALID_CANDIDATE", "note": ""}, "NO_MATCH"),
    ("not json", "LLM_ERROR"),
])
def test_adjudicator_answers(assets, cat, extraction, answer, method):
    res, _ = run(assets, cat, extraction, adj=lambda u: answer)
    r = by_query(res, "Quelitra")
    assert r["method"] == method and r["candidate_uid"] is None
    assert any(m["name"] == "Quelitra" and m["other"] for m in res["prescription"]["medicines"])


@pytest.mark.parametrize("reason", ["MATCHED", "MATCHED_ONE_OF_SEVERAL", "AMBIGUOUS"])
def test_every_reason_but_the_no_pick_reason_is_a_pick(assets, cat, extraction, reason):
    res, _ = run(assets, cat, extraction, adj=lambda u: {"choice": pick_line(u, "Zorvex"), "reason": reason, "note": ""})
    r = by_query(res, "Quelitra")
    assert r["method"] == "LLM_PICK" and r["reason"] == reason and r["candidate_uid"] == "m01"


def test_no_pick_reason_is_configurable(assets, cat, extraction):
    a2 = copy.deepcopy(assets)
    a2["adjudicate"]["no_pick_reason"] = "AMBIGUOUS"
    res, _ = run(a2, cat, extraction, adj=lambda u: {"choice": 0, "reason": "AMBIGUOUS", "note": ""})
    assert by_query(res, "Quelitra")["method"] == "NO_MATCH"
    a2["adjudicate"]["no_pick_reason"] = "NOT_A_REASON"
    with pytest.raises(A.AssetsError):
        A.validate(a2)


def test_interpreted_as_always_sent_and_context_built(assets, cat, extraction):
    _, t = run(assets, cat, extraction)
    call = next(c for c in t.calls if "SYNTH wrote: Quelitra" in c["user"])
    u = call["user"]
    assert "SYNTH read as: Quelitra" in u  # equal to the raw name, still sent
    assert u.startswith("SYNTH CONTEXT:\nSYNTH dx: Synthetic fever syndrome | Unlisted synthetic ailment\n"
                        "SYNTH sx: synthetic complaint text\n"
                        "SYNTH rx: Zorvex 500 | Quelitra | Blorpanol\n"
                        "SYNTH inv: Synthetic blood panel | Synthetic unlisted test\n\nSYNTH wrote: Quelitra")


def test_context_skips_empty_lines_and_vanishes_when_empty(assets):
    ext = {"presenting_complaints": {"symptoms": "  ", "diagnoses": [{"diagnosis_or_impression": "dx one", "raw_name": "x"}]},
           "medicines": [{"name": " ", "raw_name": "y"}]}
    assert R.prescription_context(ext, assets) == "SYNTH CONTEXT:\nSYNTH dx: dx one\n\n"
    assert R.prescription_context({}, assets) == ""


def test_adjudicator_transport_failure_is_llm_error(assets, cat, extraction):
    class T(FakeTransport):
        def __call__(self, url, headers, body):
            if not body["systemInstruction"]["parts"][0]["text"].startswith("SYNTHETIC SYSTEM PROMPT"):
                raise ReplayUnavailable("vertex http 503")
            return super().__call__(url, headers, body)
    res = R.replay("note", VISIT, cat, client(T(extraction)), assets=assets)
    assert by_query(res, "Quelitra")["method"] == "LLM_ERROR"


def test_empty_rule_logged_for_unkeyed_entity_types(assets, cat, extraction):
    res, _ = run(assets, cat, extraction)
    assert res["adjudicator_empty_rule_kinds"] == ["investigation", "surgery"]
    assets2 = copy.deepcopy(assets)
    assets2["adjudicate"]["rule_lookup"] = "substring"
    assert R.type_rule(assets2, "investigation") == "SYNTH RULE INV" and R.type_rule(assets2, "surgery") == "SYNTH RULE SX"


# ---- catalogue --------------------------------------------------------------------------------------------------

def test_catalogue_search_rules(cat):
    p = SearchParams()
    assert len(cat.entities) == 29  # one of the 30 is disabled
    assert [e["uid"] for e, _ in cat.search("medicine", "zorvex 500", p)][0] == "m01"
    assert cat.search("medicine", "zzzz", p) == []
    assert all(s >= 0.3 for _, s in cat.search("medicine", "zorvex", p))
    assert "m11" not in [e["uid"] for e, _ in cat.search("medicine", "ulmaray", p)]
    cands = cat.candidates("medicine", ["zorvex", "tarnox"], p)
    assert len({c["uid"] for c in cands}) == len(cands)


def test_describe_lines(cat):
    from tools.eta2freescript.eval.pulse.catalogue import describe
    by = {e["uid"]: e for e in cat.entities}
    assert describe(by["m01"]) == "Zorvex 500 (generic: zorvexamide)"
    assert describe(by["d01"]) == "Synthetic fever syndrome (ICD: Z01.1)"
    assert describe(by["d04"]) == "Synthetic gastric upset"
    assert describe(by["i01"]) == "Synthetic blood panel [package including: Synthetic Hb, Synthetic WBC, Synthetic platelets]"
    assert describe(by["s01"]) == "Synthetic knee arthroscopy"


# ---- build ------------------------------------------------------------------------------------------------------

def test_build_general_advice_one_item_and_requires_surgery(assets, cat, extraction):
    res, _ = run(assets, cat, extraction)
    rx = res["prescription"]
    assert rx["general_advice"] == [{"text": "synthetic advice line one\nsynthetic advice line two"}]
    assert rx["requires_surgery"] is True and len(rx["surgeries"]) == 2
    ext = copy.deepcopy(extraction)
    ext["plan_of_management"].update(surgery_or_procedure_recommendations=[], requires_surgery_or_procedure=True)
    ext["general_advice"] = ""
    res2, _ = run(assets, cat, ext)
    assert res2["prescription"]["requires_surgery"] is False and res2["prescription"]["general_advice"] == []


def test_build_dedupes_and_follow_up(assets, cat, extraction):
    ext = copy.deepcopy(extraction)
    ext["medicines"] = [ext["medicines"][0], dict(ext["medicines"][0], frequency="again")]
    ext["follow_up"] = {"no_follow_up_needed": True, "followup_date": "2026-10-27"}
    res, _ = run(assets, cat, ext)
    assert len(res["prescription"]["medicines"]) == 1
    assert res["prescription"]["follow_up"] == {"no_follow_up_needed": True}


# ---- assets -----------------------------------------------------------------------------------------------------

def test_assets_mode_and_strictness(tmp_path, assets):
    p = tmp_path / "a.json"
    shutil.copy(FIX / "assets.json", p)
    p.chmod(0o640)
    with pytest.raises(A.AssetsError, match="chmod 600"):
        A.load_assets(p)
    p.chmod(0o600)
    assert A.load_assets(p)["source"] == "synthetic test assets"
    for mutate in (lambda a: a.update(extra=1), lambda a: a["extract"].update(extra=1), lambda a: a["extract"].pop("model"),
                   lambda a: a["extract"].update(system_template="no date slot"), lambda a: a["adjudicate"]["type_rules"].pop("surgery"),
                   lambda a: a["extract"].update(temperature="hot"), lambda a: a["adjudicate"].pop("context"),
                   lambda a: a["adjudicate"]["context"].pop("joiner"), lambda a: a["adjudicate"].pop("no_pick_reason"), lambda a: a.update(assets_version="x")):
        bad = copy.deepcopy(assets)
        mutate(bad)
        with pytest.raises(A.AssetsError):
            A.validate(bad)


def test_assets_env_unset(monkeypatch):
    monkeypatch.delenv("PULSE_REPLAY_ASSETS", raising=False)
    with pytest.raises(A.AssetsError):
        A.load_assets()


# ---- schema -----------------------------------------------------------------------------------------------------

def test_schema_non_strict_and_coverage(assets):
    s = build_schema()
    txt = json.dumps(s)
    assert '"required"' not in txt and "UNKNOWN" not in txt and "$ref" not in txt
    assert s["additionalProperties"] is False
    paths = field_paths(s)
    for p in ("examination", "general_advice", "presenting_complaints.symptoms", "presenting_complaints.diagnoses[].raw_name",
              "plan_of_management.surgery_or_procedure_recommendations[].aliases", "medicines[].frequency",
              "further_investigations[].urgent", "comorbidities[].duration.unit", "follow_up.followup_type", "referrals[].speciality"):
        assert p in paths
    assert s["properties"]["comorbidities"]["items"]["properties"]["duration"]["properties"]["unit"]["enum"] == ["DAYS", "WEEKS", "MONTHS"]
    override = dict(assets, response_schema={"type": "object", "properties": {}})
    assert build_schema(override) == {"type": "object", "properties": {}}


# ---- vertex -----------------------------------------------------------------------------------------------------

def test_served_id_is_never_the_intended_id(assets, cat, extraction):
    res, t = run(assets, cat, extraction)
    assert res["served_model_ids"]["extract"] == SERVED and res["served_model_ids"]["adjudicate"] == [SERVED]
    assert "synthetic-extract-model" in t.calls[0]["url"] and res["served_model_ids"]["extract"] != "synthetic-extract-model"
    t2 = FakeTransport(extraction, model_version=None)
    res2 = R.replay("note", VISIT, cat, client(t2), assets=assets)
    assert res2["served_model_ids"]["extract"] is None  # absent stays null, not the intended id
    assert res["usage"]["extract"]["input"] == 11 and res["usage"]["extract"]["calls"] == 1


def test_regional_host_only_and_global_refused():
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "global", lambda: "t")
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "", lambda: "t")
    seen = []
    c = VertexClient("synth-proj-001", "asia-northeast1", lambda: "t", transport=lambda u, h, b: seen.append(u) or {})
    c.generate(stage="extract", model="m-1", system="s", user="u", schema={}, temperature=0, max_tokens=1)
    assert seen[0].startswith("https://asia-northeast1-aiplatform.googleapis.com/") and "global" not in seen[0]


def test_key_file_mode_checked(tmp_path):
    key = tmp_path / "k.json"
    key.write_text("{}")
    env = {"VERTEX_PROJECT": "synth-proj-001", "VERTEX_LOCATION": "asia-northeast1", "VERTEX_SA_KEY_FILE": str(key)}
    key.chmod(0o644)
    with pytest.raises(ReplayUnavailable, match="chmod 600"):
        VertexClient.from_env(env, token_provider=lambda: "t")
    key.chmod(0o600)
    c = VertexClient.from_env(env, token_provider=lambda: "t")
    assert c.extract_model == "gemini-3.1-pro-preview" and c.adj_model == "gemini-3.5-flash"
    env2 = dict(env, PULSE_EXTRACT_MODEL="m-x", PULSE_ADJ_MODEL="m-y")
    c2 = VertexClient.from_env(env2, token_provider=lambda: "t")
    assert (c2.extract_model, c2.adj_model) == ("m-x", "m-y")
    with pytest.raises(ReplayUnavailable):
        VertexClient.from_env({k: v for k, v in env.items() if k != "VERTEX_SA_KEY_FILE"}, token_provider=lambda: "t")


@pytest.mark.parametrize("marker", ["T0 [S1] (00:00) x", "NATIVE[hi]: a | ENGLISH: b", "english_segments", "native_segments"])
def test_transcript_marker_guard(marker, assets, cat, extraction):
    t = FakeTransport(extraction)
    with pytest.raises(TranscriptGuardError):
        R.replay(f"fine text {marker} more", VISIT, cat, client(t), assets=assets)
    assert t.calls == []  # nothing left the machine
    with pytest.raises(TranscriptGuardError):
        guard_request("ok", f"x {marker}")


def test_length_guard():
    guard_request("a" * 40_000)
    with pytest.raises(TranscriptGuardError):
        guard_request("a" * 20_000, "b" * 20_001)


def test_failure_and_cutoff_raise_unavailable(assets, cat, extraction):
    def boom(u, h, b):
        raise ReplayUnavailable("vertex http 500")
    with pytest.raises(ReplayUnavailable):
        R.replay("note", VISIT, cat, client(boom), assets=assets)

    def cut(u, h, b):
        return {"candidates": [{"content": {"parts": [{"text": "{}"}]}, "finishReason": "MAX_TOKENS"}]}
    with pytest.raises(ReplayUnavailable):
        R.replay("note", VISIT, cat, client(cut), assets=assets)


def test_no_text_in_logs(assets, cat, extraction, caplog):
    caplog.set_level(logging.DEBUG)
    res, t = run(assets, cat, extraction)
    log_text = caplog.text
    assert "vertex call" in log_text and "tokens" in log_text
    for c in t.calls:
        assert c["user"] not in log_text and c["system"] not in log_text
    for needle in ("synthetic exam text", "Blorpanol", "SYNTHETIC SYSTEM PROMPT", "synthetic advice", "SYNTHTOKEN9"):
        assert needle not in log_text


def test_error_messages_carry_no_text(assets, cat):
    def bad(u, h, b):
        return {"candidates": [{"content": {"parts": [{"text": "SECRET-LOOKING TEXT {"}]}, "finishReason": "STOP"}]}
    with pytest.raises(ReplayUnavailable) as e:
        R.replay("my note body", VISIT, cat, client(bad), assets=assets)
    assert "SECRET" not in str(e.value) and "my note body" not in str(e.value)


# ---- cli --------------------------------------------------------------------------------------------------------

def test_visit_date_is_local_ist_date():
    assert R.visit_date_of({"encounter": {"window_start": "2026-10-12T19:00:00Z"}}) == date(2026, 10, 13)
    assert R.visit_date_of({"encounter": {"window_start": "2026-10-13T03:00:00+00:00"}}) == date(2026, 10, 13)


@pytest.mark.parametrize("text", ["t0 [s1] (00:00)", "T0  [S1]  (0:05)", "T0\t\r[S1] (00:00)", "native[hi]: a | english: b",
                                  "Native[hi] : a | English :", "ＮＡＴＩＶＥ[ｈｉ]: a | ＥＮＧＬＩＳＨ:", "Ｔ０ [Ｓ１] （００：００）",
                                  "English_Segments", "NATIVE_SEGMENTS"])
def test_marker_guard_is_case_nfkc_and_whitespace_insensitive(text):
    with pytest.raises(TranscriptGuardError):
        guard_request("ok", f"x {text} y")
    guard_request("a t0 and some [s] text")  # not a marker


def test_other_region_needs_a_ruling():
    for loc in ("us-central1", "europe-west4"):
        with pytest.raises(ReplayUnavailable):
            VertexClient("synth-proj-001", loc, lambda: "t")
        with pytest.raises(ReplayUnavailable):
            VertexClient("synth-proj-001", loc, lambda: "t", location_ruling="  ")
    c = VertexClient("synth-proj-001", "europe-west4", lambda: "t", location_ruling="fable-ruling-99")
    assert c.location == "europe-west4"
    VertexClient("synth-proj-001", "asia-northeast1", lambda: "t")  # the default needs none


def test_from_env_region_ruling(tmp_path):
    key = tmp_path / "k.json"
    key.write_text("{}")
    key.chmod(0o600)
    env = {"VERTEX_SA_KEY_FILE": str(key), "VERTEX_PROJECT": "synth-proj-001", "VERTEX_LOCATION": "us-central1"}
    with pytest.raises(ReplayUnavailable):
        VertexClient.from_env(env, token_provider=lambda: "t")
    with pytest.raises(ReplayUnavailable):
        VertexClient.from_env({**env, "VERTEX_LOCATION_OVERRIDE_RULING": ""}, token_provider=lambda: "t")
    c = VertexClient.from_env({**env, "VERTEX_LOCATION_OVERRIDE_RULING": "fable-ruling-99"}, token_provider=lambda: "t")
    assert c.location == "us-central1"


@pytest.mark.parametrize("text", ["T1 [S0|doctor] (00:05) hi", "T12[S3|patient] (01:10)", "T0\u200b [S1] (00:00)", "nati\u00adve[hi]: a | english: b",
                                  "\u0422" + "0 [S1] (00:00)", "NAT\u0130VE[hi]: a |ENGLISH:", "english-segments"])
def test_guard_by_shape_refuses(text):
    with pytest.raises(TranscriptGuardError):
        guard_request("ok", f"x {text} y")


from tools.eta2freescript.ingest import Consult, Turn, format_transcript


def _writer(speaker="0", role="unknown", role_source="none", text="x", native=None, quarantined=False):
    c = Consult(uid="u", turns=[Turn(idx=0, t0_ms=0, t1_ms=1000, speaker=speaker, text=text, native_text=native,
                                     native_lang="hi" if native else None, role=role, role_source=role_source)],
                clip_t0_ms=0, clip_t1_ms=1000, language_code="en", english_source="s", diarised=True, room="r")
    return format_transcript(c, {0} if quarantined else frozenset())


_WRITER_LINES = [
    _writer(), _writer("?"), _writer("?", quarantined=True), _writer("A"), _writer("speaker_0"), _writer("0", quarantined=True),
    _writer("3", "patient", "role_track"), _writer("0", native="a", text="b"), _writer("?", native="a", text="b", quarantined=True),
]
_REFUSE_B4A3 = [
    "T0 [S?] (00:00) x", "T0 [S?] (00:00) [QUARANTINED: possible other consult] x", "T0 [SA] (00:01) x",
    "T0 [Sspeaker_0] (00:01) x", "T12 [S3|patient] (01:10) x", "T0 [S0] (00:00) NATIVE[hi]: a | ENGLISH: b",
    "NATIVE[ta]: x | ENGLISH: y", "NATIVE[pt-BR]: x | ENGLISH: y",
    "T0\u034f[S1] (00:00) x", "T0\ufe0f[S1] (00:00) x", "T0\u3164[S1] (00:00) x", "T0\u2800[S1] (00:00) x",
    "T0\U000e0100[S1] (00:00) x", "T0\u115f[S1] (00:00) x", "T0\uffa0[S1] (00:00) x", "T0 [\ua731" + "1] (00:00) x",
    "nat\u0131ve[hi]: a | english: b", "T3 [S2|doctor] (01:10) hi", "t3 [ s2 | role ] ( 1 : 10 ) hi",
    "T\u03000 [S0] (00:00) x", "T\u03070 [S0] (00:00) x", "\u1e6a0 [S0] (00:00) x", "T0 [\u1e60?] (00:00) x", "T0 [S\u0307?] (00:00) x", "T0 [S\u0323A] (00:00) x", "\u1d1b0 [S0] (00:00) x", "T0 [S0] (00:00)",
    "english\u2014segments", "english\u2013segments", "english\u2010segments", "english\u2212segments", "english\u2043segments",
    "english.segments", "english_segments", '"english segments"', "'native segments'",
    '{"native_segments": []}', '{"english_segments": []}',
    *_WRITER_LINES,
]
_PASS_B4A3 = [
    "a t0 and some text", "nativeness", "patient native place", "Tab T3 tablet", "T3 hormone",
    "T3 [Sustained release] 25 mcg", "T4 [Synthroid] 50mcg", "on T2 [SR] tab", "T2 [s/p]",
    "MRI T1 [STIR]", "T1 [SI joint]", "lesion T12 [spine]", "Vitals at T1 [Systolic 120]",
    "native [Bihar]", "native[1]", "English segments of the leaflet", "ST segments normal", "T2DM [since 2010]",
    "english segments", "native[hi] later",
    "spine T2 [S1] level", "T12 [S1] radiculopathy", "L5-S1 and T1 [S2] dermatome", "Fundus T1 [S3] grade",
    "T3 [S4|L5] sacral", "native[en]: speaks English", "Pt native [en]: ok",
    # B4a.3 must-refuse cases that carry no timestamp or no ENGLISH pair; moved here by the B4a.4 kickoff
    "T0 [S1]", "T0\u034f[S1]", "T0\u2800[S1]", "T0 [\ua731" + "1]", "t3 [ s2 | role ]", "nat\u0131ve[hi]:",
    "NATIVE[pt-BR]: x", "T12 [S3|patient]", "T0 [S0] hello", "NATIVE[hi]: a",
]


@pytest.mark.parametrize("text", _REFUSE_B4A3)
def test_guard_b4a3_refuses(text):
    with pytest.raises(TranscriptGuardError):
        guard_request("ok", f"x {text} y")


@pytest.mark.parametrize("text", _PASS_B4A3)
def test_guard_b4a3_passes(text):
    guard_request("ok", text)
    guard_request(f"x {text} y")


def test_region_fullmatch_and_real_ruling():
    for ruling in ("\u200b", "\u200b \u00ad"):
        with pytest.raises(ReplayUnavailable):
            VertexClient("synth-proj-001", "us-central1", lambda: "t", location_ruling=ruling)
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "us-central1\n", lambda: "t", location_ruling="fable-ruling-99")
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "asia-northeast1\n", lambda: "t")


@pytest.mark.parametrize("ruling", ["\u034f", "\ufe0f", "\u3164", "\u2800", "\u0300", "\ue000", "\U000e0100", "\u200b \u00ad\u2800"])
def test_ruling_that_must_not_unlock(ruling):
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "us-central1", lambda: "t", location_ruling=ruling)
    VertexClient("synth-proj-001", "us-central1", lambda: "t", location_ruling="r1")


@pytest.mark.parametrize("ruling", ["\u2028", "\u2029", "\u0378", "\uffff", "\U0010ffff", "\u3164", "\u0020", "\u0000"])
def test_ruling_allow_list_more(ruling):
    with pytest.raises(ReplayUnavailable):
        VertexClient("synth-proj-001", "us-central1", lambda: "t", location_ruling=ruling)


@pytest.mark.parametrize("ruling", ["r", "7", "#", "+", "\u093e", "\u0915"])
def test_ruling_allow_list_unlocks(ruling):
    VertexClient("synth-proj-001", "us-central1", lambda: "t", location_ruling=ruling)


def test_every_writer_label_is_refused():
    """Property: any line format_transcript can emit is refused, whatever the label, role, quarantine, native or time."""
    import random
    import uuid
    rng = random.Random(20261014)
    fixed = ["", "?", "A", "speaker_0", str(uuid.UUID(int=0x1234567890abcdef1234567890abcdef)), "x]y", "Sx]y", "]", "[S]"]
    roles = [("unknown", "none"), ("doctor", "role_track"), ("patient", "role_track")]
    times = [0, 59, 3599, 10 ** 6]

    def rand_label():
        n = rng.randint(0, 128)
        out = []
        while len(out) < n:
            c = chr(rng.randint(0, 0x10FFFF))
            if c != "\n":
                out.append(c)
        return "".join(out)

    labels = fixed + [rand_label() for _ in range(5000)]
    survivors = []
    for i, label in enumerate(labels):
        role, src = roles[i % 3]
        t = times[(i // 3) % 4]
        quarantined, native = bool(i % 2), bool((i // 2) % 2)
        c = Consult(uid="u", turns=[Turn(idx=0, t0_ms=t * 1000, t1_ms=t * 1000 + 1000, speaker=label, text="x",
                                         native_text="a" if native else None, native_lang="hi" if native else None,
                                         role=role, role_source=src)],
                    clip_t0_ms=0, clip_t1_ms=t * 1000 + 1000, language_code="en", english_source="s", diarised=True, room="r")
        line = format_transcript(c, {0} if quarantined else frozenset())
        try:
            guard_request(line)
        except TranscriptGuardError:
            continue
        survivors.append(label)
    assert not survivors, f"{len(survivors)} labels survived: " + ", ".join(repr(s) for s in survivors[:10])


def _turn_line(label: str, t: int = 59) -> str:
    c = Consult(uid="u", turns=[Turn(idx=0, t0_ms=t * 1000, t1_ms=t * 1000 + 1000, speaker=label, text="x")],
                clip_t0_ms=0, clip_t1_ms=t * 1000 + 1000, language_code="en", english_source="s", diarised=True, room="r")
    return format_transcript(c)


def test_max_label_chars_fits_the_guard_window():
    """B4a.7: if MAX_LABEL_CHARS or the fold expansion or the window moves, this test breaks, not the guard."""
    import unicodedata
    from tools.eta2freescript.eval.pulse import vertex as V
    from tools.eta2freescript.eval.pulse.vertex import _fold
    from tools.eta2freescript.ingest import MAX_LABEL_CHARS
    turn_rx = next(rx for what, rx in V._TRANSCRIPT_SHAPES if what.startswith("a transcript turn line"))
    window = int(re.search(r"\.\{0,(\d+)\}\?", turn_rx.pattern).group(1))
    longest = 0
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        ch = chr(cp)
        longest = max(longest, len(unicodedata.normalize("NFKC", ch)), len(unicodedata.normalize("NFKD", ch)),
                      len(_fold("s" + ch + "s")) - 2)
    assert MAX_LABEL_CHARS * longest + 64 <= window, f"{MAX_LABEL_CHARS} x {longest} + 64 > window {window}"


def test_label_window_covers_worst_expansion_of_a_128_char_label():
    """The window is read from the live pattern; a future Unicode version with a longer expansion breaks this test, not the guard."""
    import unicodedata
    from tools.eta2freescript.eval.pulse import vertex as V
    from tools.eta2freescript.eval.pulse.vertex import _fold
    turn_rx = next(rx for what, rx in V._TRANSCRIPT_SHAPES if what.startswith("a transcript turn line"))
    window = int(re.search(r"\.\{0,(\d+)\}\?", turn_rx.pattern).group(1))
    longest = 0
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            continue
        ch = chr(cp)
        longest = max(longest, len(unicodedata.normalize("NFKC", ch)), len(unicodedata.normalize("NFKD", ch)),
                      len(_fold("s" + ch + "s")) - 2)
    assert longest >= 18  # U+FDFA on current Unicode
    assert 128 * longest <= window, f"label window {window} < 128 x {longest}"


@pytest.mark.parametrize("label", [
    "ﷺ" * 128, "ﷻ" * 128, "שּׁ" * 128, "ﬃ" * 128, "ẞ" * 128, "ﷺ" * 127 + "]",
    "שּׁ" * 64 + "]" + "שּׁ" * 63, "]" + "ﷺ" * 127, "ﷺ" * 64 + "]" + "שּׁ" * 63,
    "ﷺ]" * 64, "x]y" + "ﷺ" * 125, "שּׁ]ﷺ" * 42,
])
def test_expanding_labels_are_refused(label):
    assert len(label) <= 128
    for t in (0, 59, 3599, 10 ** 6):
        with pytest.raises(TranscriptGuardError):
            guard_request(_turn_line(label, t))


# --- B4a.6: the guard checks each raw line ---------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "Tab Dolo 650 T1 [SOS] for fever.\nReview in OPD [Room 5] (10:30) tomorrow.",
    "MRI T2 [STIR] hyperintensity at L4.\nNext appointment [OPD] (11:15).",
    "Spine T12 [S1 level] tenderness;\nphysio [daily] (10:00)",
])
def test_cross_line_parts_pass(text):
    guard_request(text)


def test_whole_multi_turn_writer_output_is_refused():
    turns = [Turn(idx=i, t0_ms=i * 5000, t1_ms=i * 5000 + 1000, speaker=str(i % 2), text="x") for i in range(4)]
    c = Consult(uid="u", turns=turns, clip_t0_ms=0, clip_t1_ms=30000, language_code="en", english_source="s",
                diarised=True, room="r")
    out = format_transcript(c)
    assert out.count("\n") >= 3
    with pytest.raises(TranscriptGuardError):
        guard_request(out)


@pytest.mark.parametrize("text", [
    "T0 [S0] (10000000:00) x",
    "T0 [S0] (123456789012:00) x",
    "unrelated note line\nT0 [S0] (00:59) x",
    "unrelated note line\r\nT3 [S1|doctor] (01:05) x\nmore",
    "NATIVE[hi]: namaste | ENGLISH: hello",
    "intro\nNATIVE[hi]: namaste | ENGLISH: hello",
])
def test_line_split_still_refuses_writer_lines(text):
    with pytest.raises(TranscriptGuardError):
        guard_request(text)


@pytest.mark.parametrize("sep", [" ", "\u0085", "\r", " ", "\x0b", "\x0c"])
def test_only_newline_splits_lines(sep):
    with pytest.raises(TranscriptGuardError):
        guard_request("T0 [S0]" + sep + "(00:59) x")


@pytest.mark.parametrize("text", [
    "Started T1 [stat dose] inj ceftriaxone. Vitals [BP 120/80] (09:00) stable.",
    "Pt1 [stable], seen by Dr [cardiology] (14:20).",
    "Dose at T0 [start] then repeat [after food] (13:00).",
])
def test_same_line_false_positives_stay_refused(text):
    """Accepted false positives (B4a.5 verdict Note 1): same-line prose that has the turn-line shape."""
    with pytest.raises(TranscriptGuardError):
        guard_request(text)


def test_raw_vendor_labels_are_refused_end_to_end(tmp_path):
    """B4a.6b: raw speaker_id (with line breaks) -> load_consult -> format_transcript -> guard_request, always refused."""
    import random
    from tools.eta2freescript.ingest import format_transcript, load_consult
    rng = random.Random(20261015)
    fixed = ["0\n1", "\n", "SPEAKER_00\n", "\n0"]
    breaks = ["\n", "\r", "\u2028", "\u0085", "\u2029", "\x0b", "\x0c", "\x00"]

    def rand_label():
        n = rng.randint(0, 128)
        out = []
        while len(out) < n:
            out.append(rng.choice(breaks) if rng.random() < 0.05 else chr(rng.randint(0, 0x10FFFF)))
        return "".join(out)

    labels = fixed + [rand_label() for _ in range(2000)]
    assert len(labels) >= 2000 and all(len(x) <= 128 for x in labels)
    d = tmp_path / "u1"
    d.mkdir()
    survivors = []
    for i, label in enumerate(labels):
        t = [0, 59, 3599][i % 3]
        native, role_on, quarantined = bool(i % 2), bool((i // 2) % 2), bool((i // 4) % 2)
        seg = {"t0_ms": t * 1000, "t1_ms": t * 1000 + 1000, "speaker_id": label, "text": "x"}
        raw = {"consult_uid": "u1", "language_code": "hi" if native else "en", "english_segments": [seg],
               "clip": {"t0_ms": 0, "t1_ms": t * 1000 + 1000}}
        if native:
            raw["native_segments"] = [{"t0_ms": seg["t0_ms"], "t1_ms": seg["t1_ms"], "speaker_id": label, "text": "a", "lang": "hi"}]
        (d / "transcript.json").write_text(json.dumps(raw))
        role = d / "role.json"
        if role_on:
            role.write_text(json.dumps({"status": "ok", "layer": "role", "engine": "llm-roles", "config_hash": "c", "extras": {},
                                        "segments": [{"t0_ms": seg["t0_ms"], "t1_ms": seg["t1_ms"], "speaker": label,
                                                      "role": "doctor" if i % 3 else "patient"}]}))
        elif role.exists():
            role.unlink()
        c = load_consult(tmp_path, "u1")
        text = format_transcript(c, {0} if quarantined else frozenset())
        try:
            guard_request(text)
        except TranscriptGuardError:
            continue
        survivors.append(label)
    assert not survivors, f"{len(survivors)} survived: " + ", ".join(repr(s) for s in survivors[:10])


def test_long_raw_vendor_labels_are_refused_end_to_end(tmp_path):
    """B4a.7: over-long raw speaker_id -> load_consult -> format_transcript -> guard_request, always refused."""
    import random
    from tools.eta2freescript.ingest import format_transcript, load_consult
    rng = random.Random(20261016)
    labels = ["a" * 2401, "a" * 10000, "\ufdfa" * 134, "\ufdfa" * 5000, "]" * 3000]
    for _ in range(500):
        n = rng.randint(129, 10000)
        labels.append("".join(chr(rng.choice([rng.randint(0, 0xD7FF), rng.randint(0xE000, 0x10FFFF)])) for _ in range(n)))
    d = tmp_path / "u1"
    d.mkdir()
    survivors = []
    for i, label in enumerate(labels):
        t = [0, 59, 3599][i % 3]
        seg = {"t0_ms": t * 1000, "t1_ms": t * 1000 + 1000, "speaker_id": label, "text": "x"}
        raw = {"consult_uid": "u1", "language_code": "en", "english_segments": [seg],
               "clip": {"t0_ms": 0, "t1_ms": t * 1000 + 1000}}
        (d / "transcript.json").write_text(json.dumps(raw))
        text = format_transcript(load_consult(tmp_path, "u1"))
        try:
            guard_request(text)
        except TranscriptGuardError:
            continue
        survivors.append(len(label))
    assert not survivors, f"{len(survivors)} survived, lengths {survivors[:10]}"


def test_huge_integer_speaker_ids_are_refused_end_to_end(tmp_path):
    """B4a.7b: a JSON integer speaker_id of 2,401 / 3,000 / 4,300 digits, role none or doctor, quarantine on or off."""
    from tools.eta2freescript.ingest import format_transcript, load_consult
    d = tmp_path / "u1"
    d.mkdir()
    survivors = []
    for digits in (2401, 3000, 4300):
        for role_on in (False, True):
            for quarantined in (False, True):
                raw_json = ('{"consult_uid": "u1", "language_code": "en", "english_segments": [{"t0_ms": 0, "t1_ms": 1000, '
                            '"speaker_id": ' + "9" * digits + ', "text": "x"}], "clip": {"t0_ms": 0, "t1_ms": 1000}}')
                (d / "transcript.json").write_text(raw_json)
                role = d / "role.json"
                if role_on:
                    role.write_text('{"status": "ok", "layer": "role", "engine": "llm-roles", "config_hash": "c", "extras": {}, '
                                    '"segments": [{"t0_ms": 0, "t1_ms": 1000, "speaker": ' + "9" * digits + ', "role": "doctor"}]}')
                elif role.exists():
                    role.unlink()
                text = format_transcript(load_consult(tmp_path, "u1"), {0} if quarantined else frozenset())
                try:
                    guard_request(text)
                except TranscriptGuardError:
                    continue
                survivors.append((digits, role_on, quarantined))
    assert not survivors, survivors


def test_label_property_mixed_types():
    import random
    import unicodedata
    from tools.eta2freescript.ingest import MAX_LABEL_CHARS, _label
    rng = random.Random(20261017)
    bad = ("Cc", "Zl", "Zp")
    seen_str = 0
    for _ in range(300):
        k = rng.randrange(8)
        if k == 0:
            v = "".join(chr(rng.choice([rng.randint(0, 0xD7FF), rng.randint(0xE000, 0x10FFFF)])) for _ in range(rng.randint(0, 5000)))
        elif k == 1:
            v = rng.randint(-(10 ** rng.randint(1, 4300)) + 1, 10 ** rng.randint(1, 4300) - 1)
        elif k == 2:
            v = rng.choice([-1, 1]) * rng.random() * 1e308
        elif k == 3:
            v = rng.random() < 0.5
        elif k == 4:
            v = None
        elif k == 5:
            v = [rng.randint(0, 9)]
        elif k == 6:
            v = {"a": rng.randint(0, 9)}
        else:
            v = "\n\r \x00" * rng.randint(1, 200)
        out = _label(v)
        if out is None:
            continue
        seen_str += 1
        assert isinstance(out, str) and len(out) <= MAX_LABEL_CHARS, type(v)
        assert not any(unicodedata.category(c) in bad for c in out)
    assert seen_str > 100


def test_global_needs_a_ruling_and_uses_the_global_host():
    for ruling in (None, "", "  ", "​"):
        with pytest.raises(ReplayUnavailable):
            VertexClient("synth-proj-001", "global", lambda: "t", location_ruling=ruling)
    seen = []
    c = VertexClient("synth-proj-001", "global", lambda: "t", transport=lambda u, h, b: seen.append(u) or {},
                     location_ruling="fable-ruling-99")
    c.generate(stage="extract", model="m-1", system="s", user="u", schema={}, temperature=0, max_tokens=1)
    assert seen[0].startswith("https://aiplatform.googleapis.com/v1/projects/synth-proj-001/locations/global/")
    assert "-aiplatform" not in seen[0]


def test_asia_northeast1_host_unchanged_after_global_change():
    seen = []
    c = VertexClient("synth-proj-001", "asia-northeast1", lambda: "t", transport=lambda u, h, b: seen.append(u) or {})
    c.generate(stage="extract", model="m-1", system="s", user="u", schema={}, temperature=0, max_tokens=1)
    assert seen[0].startswith("https://asia-northeast1-aiplatform.googleapis.com/v1/projects/synth-proj-001/locations/asia-northeast1/")


def test_global_guard_hit_aborts_before_the_call():
    seen = []
    c = VertexClient("synth-proj-001", "global", lambda: "t", transport=lambda u, h, b: seen.append(u) or {},
                     location_ruling="fable-ruling-99")
    with pytest.raises(TranscriptGuardError):
        c.generate(stage="extract", model="m-1", system="s", user="x T0 [S1] (00:00) y", schema={}, temperature=0, max_tokens=1)
    with pytest.raises(TranscriptGuardError):
        c.generate(stage="extract", model="m-1", system="s", user="a" * 40_001, schema={}, temperature=0, max_tokens=1)
    assert seen == []
