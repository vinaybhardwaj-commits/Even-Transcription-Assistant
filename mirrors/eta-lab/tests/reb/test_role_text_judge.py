import json
import os
import types

import pytest

from kit.reb import role_text_judge as rj
from kit.reb import sarvam_lane as sl
from kit.reb.from_hist import GuardUnavailable
from .test_sarvam_lane import DATE, UID, Env, FakeGW, make_row, tdir

DOC = "So what is the problem? How long has the fever and pain been there? Take this tablet 500 mg twice daily. Come back after five days. Avoid cold water."
PAT = "I have fever since two days and my knee pain is bad"
ENTRIES = [{"speaker_id": "0", "start": 0.0, "end": 60.0, "transcript": DOC},
           {"speaker_id": "1", "start": 60.0, "end": 100.0, "transcript": PAT},
           {"speaker_id": "2", "start": 100.0, "end": 108.0, "transcript": "She also has sugar"}]


class FakeJev:
    """Scripted choose(): answers by question type. Records every state it was shown."""
    model = "fake-jev"          # the configured name: the only judge identity in the track's cfg8
    model_id = "fake-jev-1"     # as the "server" reports it: extras only

    def __init__(self, doctor="0", p=0.95, others=None, abstain=False):
        self.doctor, self.p, self.others, self.abstain, self.states, self.questions = doctor, p, others or {}, abstain, [], []

    def choose(self, state, question, options, escape):
        self.states.append(state)
        self.questions.append((question, tuple(options), escape))
        if question.startswith("Which speaker"):
            if self.abstain:
                return {escape: 0.6, options[0]: 0.4}
            rest = (1 - self.p) / max(len(options), 1)
            return {**{o: rest for o in options}, self.doctor: self.p, escape: 0.0}
        sp = question.split()[1]
        role = self.others.get(sp, "patient")
        return {role: 0.9, escape: 0.1}


def make(tmp, date=DATE, entries=ENTRIES, identified=True):
    row = make_row(date=date)
    row["doctor_identified"] = identified
    env = Env(tmp, [row])
    env.run(FakeGW(entries=entries), date=date)
    return env, row


def judge(env, jev, write=True, held=lambda d, r: False, since=DATE):
    a = types.SimpleNamespace(consult=None, date=None, since=since, write=write, min_minutes=0, identified=False)
    return rj.run(a, root=env.root, is_held=held, jev=jev, index_path=env.index, clips_root=env.clips)


def the_track(env, date=DATE):
    names = [n for n in os.listdir(tdir(env, date=date)) if n.startswith("role.text-judge")]
    assert len(names) == 1
    return json.load(open(os.path.join(tdir(env, date=date), names[0])))


def test_thresholds_p_and_runner_up():
    assert rj.confident({"a": 0.80, "b": 0.19, "none": 0.01})[0] == "a"
    assert rj.confident({"a": 0.80, "b": 0.20})[0] is None                       # runner-up must be strictly below 0.20
    assert rj.confident({"a": 0.79, "b": 0.10, "none": 0.11})[0] is None         # P below 0.80
    assert rj.confident({})[0] is None and rj.confident({"a": 1.0})[0] == "a"


def test_judge_a_asks_others_only_for_ten_seconds_of_talk_and_never_returns_the_escape():
    talk = {"0": 60.0, "1": 40.0, "2": 9.9}
    j = FakeJev(doctor="0", others={"1": "attendant"})
    a = rj.judge_a(j, "state", ["0", "1", "2"], talk)
    assert a["doctor"] == "0" and a["others"] == {"1": ("attendant", 0.9)} and a["calls"] == 2        # speaker 2 (9.9 s) is not asked
    assert j.questions[0][2] == rj.ESCAPE and rj.ESCAPE not in j.questions[0][1]
    assert rj.judge_a(FakeJev(abstain=True), "s", ["0", "1"], talk)["doctor"] is None
    # an escape-heavy answer is an abstain even if a speaker is the runner-up
    assert rj.judge_a(FakeJev(p=0.7), "s", ["0", "1"], {"0": 50, "1": 50})["doctor"] is None


def test_decide_abstain_cases_and_roles():
    talk = {"0": 60.0, "1": 40.0}
    sc = {"0": {"score": 20.0, "talk_share": 0.6}, "1": {"score": 3.0, "talk_share": 0.4}}
    a = {"doctor": "0", "p_doctor": 0.95, "others": {"1": ("patient", 0.9)}, "calls": 2}
    mp, why = rj.decide(["0", "1"], talk, a, "0", sc)
    assert why is None and mp["0"]["role"] == "doctor" and mp["1"]["role"] == "patient" and mp["1"]["confidence"] == 0.9 and not mp["0"]["abstain"]
    mp, why = rj.decide(["0", "1"], talk, a, None, sc)                           # B has no opinion: A stands
    assert why is None and mp["0"]["role"] == "doctor"
    mp, why = rj.decide(["0", "1"], talk, a, "1", sc)                            # B names someone else: disagreement -> nobody is assigned
    assert why == "a_b_disagree" and {v["role"] for v in mp.values()} == {"unknown"} and all(v["abstain"] for v in mp.values())
    mp, why = rj.decide(["0", "1"], talk, {**a, "doctor": None, "others": {}}, "0", sc)   # Jev abstains: B never assigns alone
    assert why == "jev_abstain" and {v["role"] for v in mp.values()} == {"unknown"}
    t3 = {"0": 40.0, "1": 35.0, "2": 30.0}                                       # three speakers within 10 points of the top: abstain
    mp, why = rj.decide(["0", "1", "2"], t3, {**a, "others": {}}, "0", sc)
    assert why == "comparable_speakers" and rj.comparable_count(t3) == 3
    assert rj.comparable_count({"0": 60.0, "1": 40.0}) == 1 and rj.comparable_count({"0": 50.0, "1": 45.0, "2": 5.0}) == 2
    t4 = {"0": 60.0, "1": 40.0, "2": 8.0}                                        # a short speaker is unknown and never asked
    mp, why = rj.decide(["0", "1", "2"], t4, {**a, "others": {"1": ("attendant", 0.85)}}, "0", sc)
    assert mp["2"]["role"] == "unknown" and mp["1"]["role"] == "attendant" and mp["0"]["role"] == "doctor"


def test_heuristic_scores_and_margin_rule():
    turns = [("0", DOC, None, 0, 60000), ("1", PAT, None, 60000, 100000)]
    talk = rj.talk_seconds(turns)
    assert talk == {"0": 60.0, "1": 40.0}
    sc = rj.heuristic_scores(turns, talk)
    assert sc["0"]["question_rate"] > 0 and sc["0"]["instruction_rate"] > 0 and sc["0"]["dose_rate"] > 0
    assert sc["1"]["keyword_rate"] > sc["0"]["keyword_rate"] and sc["0"]["score"] > sc["1"]["score"]      # a symptom-describing patient does not outscore the doctor
    assert rj.judge_b(sc, talk) == "0"
    assert rj.judge_b({"0": {"score": 10.0}, "1": {"score": 8.0}}, {"0": 50, "1": 50}) is None            # margin: the top must beat the runner-up by > 25% of itself
    assert rj.judge_b({"0": {"score": 0.5}}, {"0": 50}) is None                                              # below the minimum score
    assert rj.judge_b({"0": {"score": 99.0}, "1": {"score": 1.0}}, {"0": 5, "1": 50}) == "1"                # a speaker under 10 s never qualifies
    assert len(rj._DOSE.findall("take 500 mg twice daily and 1-0-1 bd")) >= 3


def test_state_has_only_speaker_id_and_text_english_preferred():
    turns = [("0", "orig a", "english a", 0, 1000), ("1", "orig b", None, 1000, 2000), ("0", "  ", None, 2000, 3000)]
    assert rj.build_state(turns) == "[0] english a\n[1] orig b"
    assert rj.build_state(turns, english=False) == "[0] orig a\n[1] orig b"
    stt = [{"t0_ms": 0, "t1_ms": 1000}, {"t0_ms": 1000, "t1_ms": 2000}, {"t0_ms": 5000, "t1_ms": 6000}]
    tr = [{"t0_ms": 100, "t1_ms": 1000, "text": "A"}, {"t0_ms": 1000, "t1_ms": 1900, "text": "B"}]
    assert rj.align_english(stt, tr) == ["A", "B", None]


def test_write_track_no_text_derived_from_and_idempotent(tmp_path):
    env, row = make(tmp_path)
    j = FakeJev(doctor="0", others={"1": "patient"})
    cnt = judge(env, j)
    assert cnt["written"] == 1 and cnt["doctor_assigned"] == 1 and cnt["jev_calls"] == 2 and cnt["judged"] == 1
    t = the_track(env)
    assert (t["layer"], t["engine"], t["version"], t["window_id"], t["status"]) == ("role", "text-judge", "v1", "consult-" + UID, "ok")
    m = t["extras"]["map"]
    assert m["0"]["role"] == "doctor" and m["1"]["role"] == "patient" and m["2"]["role"] == "unknown" and m["2"]["abstain"] and t["extras"]["abstain_reason"] is None
    assert [(s["speaker"], s["role"]) for s in t["segments"]] == [("0", "doctor"), ("1", "patient"), ("2", "unknown")]
    assert set(t["segments"][0]) == {"t0_ms", "t1_ms", "speaker", "role"}
    dump = json.dumps(t)
    assert "fever" not in dump and "tablet" not in dump and "synthetic" not in dump                           # no transcript text anywhere
    stt = [n for n in os.listdir(tdir(env)) if n.startswith("stt.")][0]
    d = t["extras"]["derived_from"]
    assert d["stt_path"].endswith("tracks/" + stt) and d["stt_sha256"] == rj.sha256_file(os.path.join(tdir(env), stt)) and d["translate_sha256"] is None
    assert t["extras"]["judge"] == {"jev": "fake-jev", "reported": "fake-jev-1"} and t["config"]["jev"] == "fake-jev"
    calls = len(j.states)
    again = judge(env, j)
    assert again["written"] == 0 and again["skipped_existing"] == 1
    assert len([n for n in os.listdir(tdir(env)) if n.startswith("role.text-judge")]) == 1
    j2 = FakeJev(doctor="0")
    j2.model_id = "fake-jev-2"                                                                                                       # the server now reports another version: same track
    assert judge(env, j2)["skipped_existing"] == 1 and len([n for n in os.listdir(tdir(env)) if n.startswith("role.text-judge")]) == 1
    j3 = FakeJev(doctor="0")
    j3.model = "fake-jev-pro"                                                                                                        # another CONFIGURED model = another track
    assert judge(env, j3)["written"] == 1 and len([n for n in os.listdir(tdir(env)) if n.startswith("role.text-judge")]) == 2


def test_what_jev_sees_is_only_speaker_ids_and_text(tmp_path):
    env, row = make(tmp_path)
    j = FakeJev()
    judge(env, j)
    state = j.states[0]
    assert state.splitlines()[0].startswith("[0] ") and "Dr" not in state and row["doctor_uid"] not in state and "2026" not in state and UID not in state
    assert all(l.startswith("[") for l in state.splitlines())


def test_translate_track_gives_english_for_8_oct_and_is_hashed(tmp_path):
    env, row = make(tmp_path, date="2026-10-08")
    j = FakeJev()
    judge(env, j, since="2026-10-08")
    t = the_track(env, "2026-10-08")
    assert t["extras"]["derived_from"]["translate_sha256"] and len(t["extras"]["derived_from"]["translate_sha256"]) == 64


def test_jev_abstain_writes_unknown_for_everyone(tmp_path):
    env, row = make(tmp_path)
    cnt = judge(env, FakeJev(abstain=True))
    assert cnt["abstain_jev"] == 1 and cnt["doctor_assigned"] == 0 and cnt["jev_calls"] == 1
    t = the_track(env)
    assert {v["role"] for v in t["extras"]["map"].values()} == {"unknown"} and t["extras"]["abstain_reason"] == "jev_abstain"


def test_a_b_disagreement_abstains(tmp_path):
    ents = [{"speaker_id": "0", "start": 0.0, "end": 60.0, "transcript": "ok ok yes yes fine"},
            {"speaker_id": "1", "start": 60.0, "end": 100.0, "transcript": DOC}]
    env, row = make(tmp_path, entries=ents)
    cnt = judge(env, FakeJev(doctor="0"))                                          # Jev says 0; the heuristic says 1
    assert cnt["abstain_disagree"] == 1 and cnt["doctor_assigned"] == 0
    assert {v["role"] for v in the_track(env)["extras"]["map"].values()} == {"unknown"}


def test_blind_refused_before_any_text_or_jev_call(tmp_path):
    env, row = make(tmp_path)
    j = FakeJev()
    cnt = judge(env, j, held=lambda d, r: True)
    assert cnt["blind_refused"] == 1 and j.states == [] and not [n for n in os.listdir(tdir(env)) if n.startswith("role.text-judge")]


def test_signature_mismatch_no_stt_and_dry_run(tmp_path):
    env, row = make(tmp_path)
    with open(env.index, "a") as f:
        f.write(json.dumps(dict(row, signature=[1.0, "url_clear", "DOC1"])) + "\n")      # re-cut: the live stt names the old signature
    j = FakeJev()
    assert judge(env, j)["signature_mismatch"] == 1 and j.states == []
    env2 = Env(tmp_path / "e2", [make_row()])                                          # the lane never ran
    assert judge(env2, j)["no_stt"] == 1
    env3, _ = make(tmp_path / "e3")
    cnt = judge(env3, None, write=False)                                               # no Jev: guards + input + judge B only
    assert cnt["judged"] == 1 and cnt["written"] == 0 and cnt["jev_calls"] == 0 and not [n for n in os.listdir(tdir(env3)) if n.startswith("role.text-judge")]
    cnt = judge(env3, FakeJev(), write=False)
    assert cnt["would_write"] == 1 and cnt["written"] == 0


def test_guard_unavailable_is_fatal_and_write_needs_a_real_client(tmp_path, monkeypatch):
    env, row = make(tmp_path)

    def boom():
        raise GuardUnavailable("none")
    monkeypatch.setattr(rj, "load_heldout", boom)
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=False, min_minutes=0, identified=False)
    with pytest.raises(GuardUnavailable):
        rj.run(a, root=env.root, index_path=env.index, clips_root=env.clips)
    with pytest.raises(SystemExit):
        rj.main(["--since", DATE, "--write"])


def test_no_jev_call_when_the_outcome_is_already_an_abstain(tmp_path):
    ents = [{"speaker_id": "0", "start": 0.0, "end": 40.0, "transcript": DOC}, {"speaker_id": "1", "start": 40.0, "end": 75.0, "transcript": PAT},
            {"speaker_id": "2", "start": 75.0, "end": 105.0, "transcript": "she has sugar too"}]                         # 40 / 35 / 30 s: three comparable speakers
    env, row = make(tmp_path, entries=ents)
    j = FakeJev()
    cnt = judge(env, j)
    assert cnt["abstain_comparable"] == 1 and cnt["jev_calls"] == 0 and j.states == [] and cnt["written"] == 1              # the track is still written (all unknown)
    t = the_track(env)
    assert t["extras"]["abstain_reason"] == "comparable_speakers" and {v["role"] for v in t["extras"]["map"].values()} == {"unknown"}
    short = [{"speaker_id": "0", "start": 0.0, "end": 6.0, "transcript": DOC}, {"speaker_id": "1", "start": 6.0, "end": 12.0, "transcript": PAT}]
    env2, _ = make(tmp_path / "s", entries=short)                                                                              # nobody has 10 s of talk
    j2 = FakeJev()
    cnt2 = judge(env2, j2)
    assert cnt2["abstain_no_speaker"] == 1 and j2.states == [] and cnt2["jev_calls"] == 0


def test_transcript_is_not_opened_before_both_heldout_checks(tmp_path, monkeypatch):
    env, row = make(tmp_path)
    opened = []
    real = rj.live_track
    monkeypatch.setattr(rj, "live_track", lambda *a, **k: (opened.append(a[2]), real(*a, **k))[1])
    cnt = judge(env, FakeJev(), held=lambda d, r: True)                                                                    # day+room blind
    assert cnt["blind_refused"] == 1 and opened == []
    cnt = judge(env, FakeJev(), held=lambda d, r: False)
    assert opened and opened[0] == "stt"
    # a span-only block (the day+room check passes, the span check refuses): still no transcript opened
    opened.clear()
    env2, _ = make(tmp_path / "e2")
    monkeypatch.setattr(rj, "window_held", lambda *a, **k: True)
    cnt = judge(env2, FakeJev())
    assert cnt["blind_refused"] == 1 and opened == []


def test_limit_and_seed_pick_a_sample_and_decided_abstains_do_not_spend_the_budget(tmp_path):
    rows = [make_row(uid=f"u{i}", date=DATE) for i in range(4)]
    env = Env(tmp_path, rows)
    env.run(FakeGW(entries=ENTRIES), date=DATE)
    j = FakeJev()
    a = types.SimpleNamespace(consult=None, date=None, since=DATE, write=False, min_minutes=0, identified=False, limit=2, seed=3)
    cnt = rj.run(a, root=env.root, is_held=lambda d, r: False, jev=j, index_path=env.index, clips_root=env.clips)
    assert cnt["jev_calls"] > 0 and cnt["judged"] == 2 and cnt["limit_reached"] == 2 and len([s for s in j.states if True]) == cnt["jev_calls"]
    a2 = types.SimpleNamespace(**{**vars(a), "limit": 0, "seed": 3})
    j2 = FakeJev()
    assert rj.run(a2, root=env.root, is_held=lambda d, r: False, jev=j2, index_path=env.index, clips_root=env.clips)["judged"] == 4
    ents = [{"speaker_id": "0", "start": 0.0, "end": 6.0, "transcript": DOC}]                            # nobody with 10 s: no Jev call, budget untouched
    env3 = Env(tmp_path / "s", [make_row()])
    env3.run(FakeGW(entries=ents), date=DATE)
    b = rj.Budget(1)
    cnt3 = {k: 0 for k in rj.COUNTERS}
    import collections
    c3 = collections.Counter(cnt3)
    rj.process(make_row(), env3.root, lambda d, r: False, False, c3, FakeJev(), env3.clips, b)
    assert b.taken == 0 and c3["jev_calls"] == 0


def test_jev_errors_are_counted_by_reason_without_text(tmp_path):
    from kit.reb import jev_client as jc

    class Boom:
        model = "boom"
        model_id = "boom-1"

        def choose(self, *a, **k):
            raise jc.JevError("input_too_large", 400)
    env, row = make(tmp_path)
    cnt = judge(env, Boom())
    assert cnt["errors"] == 1 and cnt["jev_error_input_too_large"] == 1 and cnt["written"] == 0


def test_main_requires_limit_for_real_jev_and_still_refuses_write():
    with pytest.raises(SystemExit):
        rj.main(["--since", DATE, "--jev", "real"])
    with pytest.raises(SystemExit):
        rj.main(["--since", DATE, "--write"])


class UnwarmedJev(FakeJev):
    """Like the real client: the reported model id is unknown until a first (warm-up) call."""
    model_id = None

    def warm_up(self):
        self.model_id = "warm-model-1"
        return self.model_id


def test_cfg8_is_the_configured_name_so_it_never_depends_on_processing_order(tmp_path):
    short = [{"speaker_id": "0", "start": 0.0, "end": 6.0, "transcript": DOC}]                       # nobody with 10 s: a decided abstain, 0 Jev calls
    env, _ = make(tmp_path / "a", entries=short)
    cnt = judge(env, UnwarmedJev())                                                                   # processed BEFORE any real call: reported id unknown at that point
    assert cnt["written"] == 1 and cnt["jev_calls"] == 0
    t = the_track(env)
    assert t["config"]["jev"] == "fake-jev" and t["extras"]["judge"] == {"jev": "fake-jev", "reported": "warm-model-1"}
    j2 = FakeJev()                                                                                    # a later run, calls already made, another reported id
    assert judge(env, j2)["skipped_existing"] == 1 and len([n for n in os.listdir(tdir(env)) if n.startswith("role.text-judge")]) == 1


def test_run_refuses_a_judge_with_no_configured_name(tmp_path):
    env, _ = make(tmp_path)

    class Anon(FakeJev):
        model = None
    with pytest.raises(SystemExit):
        judge(env, Anon())


class BatchJev(FakeJev):
    """Adds choose_many: one 'request' for all the patient/attendant questions."""
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.requests = 0

    def choose(self, state, question, options, escape):
        self.requests += 1
        return super().choose(state, question, options, escape)

    def choose_many(self, state, questions):
        self.requests += 1
        self.states.append(state)
        return {k: {options[0] if self.others.get(k, "patient") == options[0] else options[1]: 0.9, escape: 0.1} for k, (q, options, escape) in questions.items()}


def test_speaker_questions_are_one_request_after_the_doctor_answer():
    talk = {"0": 60.0, "1": 40.0, "2": 15.0, "3": 12.0, "4": 5.0}
    j = BatchJev(doctor="0", others={"2": "attendant"})
    a = rj.judge_a(j, "state", ["0", "1", "2", "3", "4"], talk)
    assert j.requests == 2 and a["calls"] == 2                                                         # the doctor question + ONE batch for speakers 1, 2, 3 (4 has < 10 s)
    assert a["doctor"] == "0" and set(a["others"]) == {"1", "2", "3"} and a["others"]["2"][0] == "attendant" and a["others"]["1"][0] == "patient"
    j2 = BatchJev(abstain=True)
    assert rj.judge_a(j2, "s", ["0", "1"], talk)["calls"] == 1 and j2.requests == 1                    # no doctor: no second request at all
    j3 = BatchJev(doctor="0")
    assert rj.judge_a(j3, "s", ["0", "1"], {"0": 50.0, "1": 5.0})["calls"] == 1                         # nobody else with 10 s: no batch


def test_warm_up_uses_a_synthetic_state_and_sets_the_model(tmp_path):
    from kit.reb import jev_client as jc
    from .test_jev_client import Scripted, ok
    kf = tmp_path / "k"
    kf.write_text("sk-x\n")
    op = Scripted(ok({"a": 0.9, "b": 0.05, "cannot_tell": 0.05}))
    c = jc.JevClient(key_file=str(kf), opener=op)
    assert c.warm_up() == "jev-1.13.0" and c.model_id == "jev-1.13.0" and c.model == "jev-latest"
    body = json.loads(op.reqs[0][0].data)
    assert body["state"] == "warm-up" and set(body["questions"]["q"]["criteria"]) == {"a", "b", "cannot_tell"}                # no consult text in it


def test_main_writes_a_private_metadata_only_call_log(tmp_path, monkeypatch, capsys):
    import glob
    from kit.reb import jev_client as jc
    monkeypatch.setattr(rj.sl, "OUT_DIR", str(tmp_path / "out"))
    seen = {}

    class Fake(jc.JevClient):
        def __init__(self, log=None):
            seen["log"] = log
            self.model_id, self.stats = "m1", {"calls": 0, "ok": 0, "retries": 0, "errors": {}, "input_tokens": 0, "output_tokens": 0, "latency_s": []}

        def warm_up(self):
            seen["log"]({"status": 200, "latency_s": 0.1, "attempt": 0, "input_tokens": 5, "output_tokens": 1})
            return "m1"
    monkeypatch.setattr(rj.jev_client, "JevClient", Fake)
    monkeypatch.setattr(rj, "run", lambda a, root=None, jev=None, **k: (jev.warm_up(), {"clips": 0})[1])      # run() warms the judge up first
    assert rj.main(["--since", DATE, "--dry-run", "--jev", "real", "--limit", "3"]) == 0
    files = glob.glob(str(tmp_path / "out" / "jev-calls-*.jsonl"))
    assert len(files) == 1 and oct(os.stat(files[0]).st_mode & 0o777) == "0o600"
    line = json.loads(open(files[0]).read().splitlines()[0])
    assert set(line) == {"ts", "use", "status", "latency_s", "attempt", "input_tokens", "output_tokens"} and line["use"] == "6S9"
    assert json.loads(capsys.readouterr().out)["jev_call_log"] == files[0]


def test_client_choose_many_is_one_request_with_the_state_sent_once(tmp_path):
    from kit.reb import jev_client as jc
    from .test_jev_client import Resp, Scripted
    kf = tmp_path / "k"
    kf.write_text("sk-x\n")
    body = {"model": "m", "answers": {"q0": {"type": "choice", "choice": "patient", "probabilities": {"patient": 0.9, "attendant": 0.05, "cannot_tell": 0.05}},
                                      "q1": {"type": "choice", "choice": "attendant", "probabilities": {"patient": 0.1, "attendant": 0.85, "cannot_tell": 0.05}}},
            "usage": {"input_tokens": 100, "output_tokens": 9}}
    op = Scripted(Resp(body))
    c = jc.JevClient(key_file=str(kf), opener=op)
    r = c.choose_many("STATE", {"1": ("is 1 a patient?", ["patient", "attendant"], "none / cannot tell"), "2": ("is 2 a patient?", ["patient", "attendant"], "none / cannot tell")})
    assert r["1"] == {"patient": 0.9, "attendant": 0.05, "none / cannot tell": 0.05} and r["2"]["attendant"] == 0.85
    assert len(op.reqs) == 1 and json.loads(op.reqs[0][0].data)["state"] == "STATE" and set(json.loads(op.reqs[0][0].data)["questions"]) == {"q0", "q1"}
