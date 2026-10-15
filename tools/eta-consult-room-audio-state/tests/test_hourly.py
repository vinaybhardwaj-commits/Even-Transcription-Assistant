import sys, types
import pytest
from ras import hourly


def _stub(monkeypatch, tmp_path, scan_main=None, write_main=None):
    monkeypatch.setattr(hourly, "LOG", str(tmp_path / "logs" / "hourly.log"))
    import ras.scan as scan
    monkeypatch.setattr(scan, "main", scan_main or (lambda *a, **k: None))
    mod = types.ModuleType("ras_write")
    mod.main = write_main or (lambda argv: 0)
    monkeypatch.setitem(sys.modules, "ras_write", mod)


def lines(tmp_path):
    return (tmp_path / "logs" / "hourly.log").read_text().splitlines()


def test_success_logs_one_counts_line(monkeypatch, tmp_path):
    def wm(argv):
        wm.last = {"room_days": 26, "committed_room_days": 26, "rolled_back": 0, "intervals": 97}
        return 0
    _stub(monkeypatch, tmp_path, write_main=wm)
    assert hourly.main() == 0
    ls = lines(tmp_path)
    assert len(ls) == 1 and "rc=0 room_days=26 committed=26 rolled_back=0 intervals=97" in ls[0]


def test_crash_before_the_write_loop_still_logs_one_line(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise ConnectionError("db down with secret")
    _stub(monkeypatch, tmp_path, scan_main=boom)
    with pytest.raises(ConnectionError):
        hourly.main()
    ls = lines(tmp_path)
    assert len(ls) == 1 and "rc=EXC ConnectionError" in ls[0] and "secret" not in ls[0]


def test_crash_in_the_writer_before_the_loop_logs_the_exception_type(monkeypatch, tmp_path):
    def wm(argv):
        raise RuntimeError("connect failed")
    _stub(monkeypatch, tmp_path, write_main=wm)
    with pytest.raises(RuntimeError):
        hourly.main()
    assert "rc=EXC RuntimeError" in lines(tmp_path)[0]


def test_killed_run_logs_too(monkeypatch, tmp_path):
    def wm(argv):
        raise KeyboardInterrupt
    _stub(monkeypatch, tmp_path, write_main=wm)
    with pytest.raises(KeyboardInterrupt):
        hourly.main()
    assert "rc=EXC KeyboardInterrupt" in lines(tmp_path)[0]


def test_rc2_run_logs_counts(monkeypatch, tmp_path):
    def wm(argv):
        wm.last = {"room_days": 3, "committed_room_days": 2, "rolled_back": 1, "intervals": 9}
        return 2
    _stub(monkeypatch, tmp_path, write_main=wm)
    assert hourly.main() == 2
    assert "rc=2 room_days=3 committed=2 rolled_back=1" in lines(tmp_path)[0]


def test_sigterm_still_logs_one_line_and_exits_143(tmp_path):
    import os, signal, subprocess, textwrap, time
    log = tmp_path / "logs" / "hourly.log"
    code = textwrap.dedent(f"""
        import sys, time, types
        sys.path.insert(0, {os.path.dirname(os.path.dirname(os.path.abspath(__file__)))!r})
        from ras import hourly, scan
        hourly.LOG = {str(log)!r}
        scan.main = lambda *a, **k: (print("ready", flush=True), time.sleep(60))
        sys.modules["ras_write"] = types.ModuleType("ras_write")
        sys.exit(hourly.main())
    """)
    p = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "ready"
    p.send_signal(signal.SIGTERM)
    assert p.wait(timeout=10) == 143
    ls = log.read_text().splitlines()
    assert len(ls) == 1 and "rc=EXC SystemExit" in ls[0]
