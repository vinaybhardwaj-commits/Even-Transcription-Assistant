"""The vendored floors.py oracles: byte-equal to git history where history is available, and complete for every sha the oracle loaders name.

The fixtures are stored as `floors_<sha40>.py` so the repo's scrub gate treats them as ordinary source. They are never imported or
collected (the name does not match `test_*.py`); the loaders read them as text.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ORACLES = HERE / "fixtures" / "oracles"
FLOORS_PATH = "tools/eta2freescript/eval/pdqi9/floors.py"
_NAME = re.compile(r"^floors_([0-9a-f]{40})\.py$")
LOADERS = ("test_floor_strict.py", "test_floor_ordered_not_supported.py")


def _fixtures():
    return sorted(p for p in ORACLES.iterdir() if _NAME.match(p.name))


def _loader_full_shas():
    found = set()
    for name in LOADERS:
        found.update(re.findall(r"(?<![0-9A-Za-z_])[0-9a-f]{40}(?![0-9A-Za-z_])", (HERE / name).read_text()))
    return sorted(found)


def _git_show(sha):
    return subprocess.run(["git", "show", f"{sha}:{FLOORS_PATH}"], cwd=HERE, capture_output=True, check=True).stdout


def test_loaders_name_full_shas():
    assert len(_loader_full_shas()) >= 6


def test_every_named_sha_has_a_fixture():
    for sha in _loader_full_shas():
        assert (ORACLES / f"floors_{sha}.py").is_file(), sha


def test_every_fixture_file_is_named_like_a_fixture():
    for p in ORACLES.iterdir():
        assert _NAME.match(p.name), p.name


def _referenced_hex_tokens():
    """Every 8+ hex token with a letter in it, from the test modules (a full sha, or the short prefix a test names).

    The oracle fixtures themselves are not references. The letter requirement keeps digit runs such as "0123456789" from counting.
    """
    tokens = set()
    for p in HERE.rglob("*.py"):
        if p.resolve() == Path(__file__).resolve() or ORACLES in p.resolve().parents:
            continue
        found = re.findall(r"(?<![0-9A-Za-z_])[0-9a-f]{8,40}(?![0-9A-Za-z_])", p.read_text(errors="replace"))
        tokens.update(t for t in found if re.search(r"[a-f]", t))
    return tokens


def test_no_stray_fixture_files():
    tokens = _referenced_hex_tokens()
    for p in _fixtures():
        sha = _NAME.match(p.name).group(1)
        assert any(sha.startswith(t) for t in tokens), p.name


@pytest.mark.parametrize("fixture", _fixtures(), ids=lambda p: p.name[7:19])
def test_fixture_equals_git_history(fixture):
    sha = _NAME.match(fixture.name).group(1)
    try:
        want = _git_show(sha)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip(f"commit {sha} not available locally (shallow checkout)")
    assert fixture.read_bytes() == want
