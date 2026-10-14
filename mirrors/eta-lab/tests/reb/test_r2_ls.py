from kit.reb import r2_ls


class Stub:
    """list_objects_v2 stub paging 2 keys at a time."""
    def __init__(self, keys):
        self.keys, self.calls = keys, []

    def list_objects_v2(self, **kw):
        self.calls.append(kw)
        start = int(kw.get("ContinuationToken", 0))
        page = [k for k in self.keys if k.startswith(kw["Prefix"])][start:start + 2]
        more = start + 2 < len([k for k in self.keys if k.startswith(kw["Prefix"])])
        r = {"Contents": [{"Key": k, "Size": 10} for k in page], "IsTruncated": more}
        if more:
            r["NextContinuationToken"] = str(start + 2)
        return r


KEYS = [
    "reb/2026-09-26/index.jsonl",
    "reb/2026-09-26/room_a/w1/manifest.json",
    "reb/2026-09-26/room_a/w1/tracks/stt.whisper-auto__v1__abc.json",
    "reb/2026-09-26/room_a/w1/tracks/diar.pyannote__v1__abc.json",
    "reb/2026-09-26/room_a/w2/tracks/stt.whisper-auto__v1__abc.json",
    "reb/2026-09-27/room_a/w3/tracks/stt.koyal__v1__abc.json",
]


def test_pagination_follows_tokens():
    c = Stub(KEYS)
    assert len(list(r2_ls.iter_objects(c, "reb/"))) == 6
    assert len(c.calls) == 3 and "ContinuationToken" not in c.calls[0] and c.calls[2]["ContinuationToken"] == "4"


def test_summarize_counts():
    s = r2_ls.summarize(r2_ls.iter_objects(Stub(KEYS), "reb/"))
    d = s["2026-09-26"]
    assert d["windows"] == 2 and d["tracks"] == 3 and d["bytes"] == 50
    assert d["by_engine"] == {"diar.pyannote": 1, "stt.whisper-auto": 2}
    assert s["2026-09-27"]["by_engine"] == {"stt.koyal": 1}


def test_date_filter_and_empty():
    assert list(r2_ls.summarize(r2_ls.list_keys(Stub(KEYS), "2026-09-27"))) == ["2026-09-27"]
    assert r2_ls.summarize([]) == {}


def test_auth_failure_message_has_no_secret(capsys):
    class Bad:
        def list_objects_v2(self, **kw):
            raise RuntimeError("secret-xyz")
    assert r2_ls.main(["--all"], client=Bad()) == 2
    assert "secret-xyz" not in capsys.readouterr().err
