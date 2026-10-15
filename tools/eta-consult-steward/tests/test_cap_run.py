import json
import pytest
from steward import spend, run, config


def test_cost():
    assert spend.cost_usd(1_000_000, 1_000_000) == 18.0


def test_daily_cap_blocks(tmp_path):
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=0.01)
    L.check(0.0)
    L.record("m", 10_000, 0, 1.0)  # 0.03
    with pytest.raises(spend.CapExceeded):
        L.check()
    # other instance, same file, same day
    with pytest.raises(spend.CapExceeded):
        spend.Ledger(tmp_path / "c.jsonl", cap_usd=0.01).check()


def test_run_cap(tmp_path):
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=5, run_cap_usd=0.01)
    L.record("m", 10_000, 0, 1.0)
    with pytest.raises(spend.CapExceeded):
        L.check()


def test_log_has_no_content(tmp_path):
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=5)
    L.record("m", 5, 6, 0.1, tag="advise")
    assert set(json.loads((tmp_path / "c.jsonl").read_text())) == {"ts", "ist_day", "model", "tag", "tokens_in", "tokens_out", "seconds", "cost_usd"}


def test_flag_file(data):
    assert not spend.enabled()
    (config.home_dir() / "ENABLED").write_text("")
    assert spend.enabled()


class Fake:
    """Scripted converse client: one tool call, then submit_report."""
    def __init__(self, report):
        self.n = 0
        self.report = report

    def converse(self, system, messages, tool_config, max_tokens=2000):
        self.n += 1
        if self.n == 1:
            c = [{"toolUse": {"toolUseId": "t1", "name": "recon_get", "input": {"date": "2026-10-12"}}}]
        else:
            c = [{"toolUse": {"toolUseId": "t2", "name": "submit_report", "input": self.report}}]
        return {"output": {"message": {"role": "assistant", "content": c}}, "usage": {"inputTokens": 1000, "outputTokens": 200}}


def test_disabled_without_flag(data, capsys):
    assert run.main([], client=Fake({})) == 0
    assert "disabled" in capsys.readouterr().out


def test_full_run_writes_json_and_never_posts(data, tmp_path, monkeypatch):
    monkeypatch.delenv("ENC_STEWARD_TOKEN", raising=False)
    out = tmp_path / "o.json"
    rep = {"summary_md": "room_aaa: 2 cut of 2 visits; 1 unplaced.", "items": [
        {"kind": "question", "title": "Unplaced visit", "body_md": "1 visit has no room on 2026-10-12."}]}
    assert run.main(["--force", "--out", str(out), "--date", "2026-10-12"], client=Fake(rep)) == 0
    d = json.loads(out.read_text())
    assert d["run"]["mode"] == "advise" and d["run"]["tokens_in"] == 2000 and len(d["items"]) == 1
    assert d["items"][0]["state"] == "open"
    calls = config.ledger_path().read_text().splitlines()
    assert len(calls) == 2


def test_run_stops_at_cap(data, tmp_path):
    out = tmp_path / "o.json"
    rc = run.main(["--force", "--out", str(out), "--cap", "0.001", "--date", "2026-10-12"], client=Fake({"summary_md": "x", "items": []}))
    d = json.loads(out.read_text())
    assert rc == 3 and d["run"]["status"] == "cap" and d["items"] == [] and d["run"]["tokens_in"] == 0


def test_poster_off_by_default(monkeypatch):
    from steward import poster
    monkeypatch.delenv("ENC_STEWARD_TOKEN", raising=False)
    assert poster.post_run({"run": {"id": "1"}, "items": []}) == {"posted": False, "reason": "off"}


def test_poster_on(monkeypatch):
    from steward import poster
    monkeypatch.setenv("STEWARD_POST", "1")
    monkeypatch.setenv("ENC_STEWARD_TOKEN", "t")
    monkeypatch.setenv("STEWARD_API_BASE", "https://x.invalid")
    seen = []

    class R:
        status = 200
        def __enter__(self): return self
        def __exit__(self, *a): pass

    def op(req, timeout=0):
        seen.append((req.full_url, req.headers["Authorization"]))
        return R()
    assert poster.post_run({"run": {"id": "1"}, "items": []}, opener=op)["posted"]
    assert seen[0][0].endswith("/api/admin/steward/run") and seen[1][0].endswith("/items")


def test_squeeze_forces_report_near_cap(data, tmp_path):
    from steward import agent
    class Greedy:
        def converse(self, system, messages, tool_config, max_tokens=2000):
            names = [t["toolSpec"]["name"] for t in tool_config["tools"]]
            if names == ["submit_report"]:
                c = [{"toolUse": {"toolUseId": "s", "name": "submit_report", "input": {"summary_md": "ok", "items": []}}}]
            else:
                c = [{"toolUse": {"toolUseId": "t", "name": "alerts_tail", "input": {}}}]
            return {"output": {"message": {"role": "assistant", "content": c}}, "usage": {"inputTokens": 40000, "outputTokens": 0}}
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=10, run_cap_usd=0.5)  # each call 0.12
    res = agent.run_agent(Greedy(), L, "2026-10-12", "2026-10-11", "m")
    assert res["status"] == "ok" and res["report"]["summary_md"] == "ok"


def test_estimate_and_hard_stop(tmp_path):
    e = spend.estimate_call_usd(30000, 8000)   # 10001 in + 8000 out
    assert 0.16 < e < 0.17
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=5, run_cap_usd=1.0)
    L.run_spent = 0.90
    with pytest.raises(spend.CapExceeded):
        L.check(0.15)       # 0.90 + 0.15 > 1.0
    L.check(0.09)           # fits
    D = spend.Ledger(tmp_path / "c.jsonl", cap_usd=0.10)
    with pytest.raises(spend.CapExceeded):
        D.check(0.15)       # daily, even with nothing spent


def test_agent_never_sends_call_over_cap(data, tmp_path):
    from steward import agent
    class Count:
        n = 0
        def converse(self, system, messages, tool_config, max_tokens=2000):
            Count.n += 1
            c = [{"toolUse": {"toolUseId": "t", "name": "alerts_tail", "input": {}}}]
            return {"output": {"message": {"role": "assistant", "content": c}}, "usage": {"inputTokens": 100000, "outputTokens": 0}}
    # each real call costs 0.30; estimate of the next is >= 0.12 (8000 out) so cap 0.5 allows 1 call only after check
    L = spend.Ledger(tmp_path / "c.jsonl", cap_usd=10, run_cap_usd=0.5)
    res = agent.run_agent(Count(), L, "2026-10-12", "2026-10-11", "m")
    assert res["status"] == "cap" and Count.n == 2 and L.run_spent <= 0.7
    # the third call was refused because 0.60 + estimate > 0.5; no call is sent when estimate alone exceeds cap
    L2 = spend.Ledger(tmp_path / "d.jsonl", cap_usd=10, run_cap_usd=0.05)
    Count.n = 0
    res = agent.run_agent(Count(), L2, "2026-10-12", "2026-10-11", "m")
    assert Count.n == 0 and res["status"] == "cap"
