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


@pytest.mark.parametrize("marker", ["T0 [S", "NATIVE[", "english_segments", "native_segments"])
def test_transcript_marker_guard(marker, assets, cat, extraction):
    t = FakeTransport(extraction)
    with pytest.raises(TranscriptGuardError):
        R.replay(f"fine text {marker}1] more", VISIT, cat, client(t), assets=assets)
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
