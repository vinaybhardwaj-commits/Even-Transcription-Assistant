"""deploy.sh against a throwaway repo and worktree (never the real ones)."""
import os, subprocess, shutil
import pytest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "deploy.sh")


def sh(*a, cwd, env=None, check=True):
    return subprocess.run(a, cwd=cwd, capture_output=True, text=True, check=check,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                               "GIT_COMMITTER_EMAIL": "t@t", **(env or {})})


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    sh("git", "init", "-q", cwd=r)
    shutil.copy(SCRIPT, r / "deploy.sh")
    (r / "a.txt").write_text("1")
    sh("git", "add", "-A", cwd=r)
    sh("git", "commit", "-qm", "c1", cwd=r)
    env = {"RAS_VENV": "", "RAS_DEPLOY_DIR": str(tmp_path / "deploy"), "RAS_DEPLOY_LOG": str(tmp_path / "deploy.log")}
    return r, tmp_path, env


def run(repo, *args, check=True):
    r, t, env = repo
    return sh("bash", "deploy.sh", *args, cwd=r, env=env, check=check)


def test_deploys_clean_head_creates_tag_and_worktree(repo):
    r, t, env = repo
    out = run(repo)
    head = sh("git", "rev-parse", "HEAD", cwd=r).stdout.strip()
    tag = sh("git", "tag", "--list", "ras-deploy-2*", cwd=r).stdout.split()
    assert len(tag) == 1 and tag[0].endswith("-1")
    assert sh("git", "rev-parse", "HEAD", cwd=t / "deploy").stdout.strip() == head
    assert sh("git", "rev-parse", "ras-deploy-current", cwd=r).stdout.strip() == head
    assert head in (t / "deploy.log").read_text()


def test_refuses_dirty_or_untracked_tree_and_changes_nothing(repo):
    r, t, env = repo
    (r / "a.txt").write_text("dirty")
    p = run(repo, check=False)
    assert p.returncode == 1 and "not clean" in p.stderr
    assert not (t / "deploy").exists() and sh("git", "tag", cwd=r).stdout.strip() == ""
    sh("git", "checkout", "a.txt", cwd=r)
    (r / "new.txt").write_text("untracked")
    assert run(repo, check=False).returncode == 1


def test_second_deploy_moves_worktree_and_numbers_the_tag(repo):
    r, t, env = repo
    run(repo)
    (r / "a.txt").write_text("2")
    sh("git", "commit", "-qam", "c2", cwd=r)
    run(repo)
    tags = sorted(sh("git", "tag", "--list", "ras-deploy-2*", cwd=r).stdout.split())
    assert len(tags) == 2 and tags[0].endswith("-1") and tags[1].endswith("-2")
    head = sh("git", "rev-parse", "HEAD", cwd=r).stdout.strip()
    assert sh("git", "rev-parse", "HEAD", cwd=t / "deploy").stdout.strip() == head
    assert (t / "deploy" / "a.txt").read_text() == "2"
    assert sh("git", "rev-parse", "ras-deploy-current", cwd=r).stdout.strip() == head


def test_refuses_when_deploy_worktree_was_edited(repo):
    r, t, env = repo
    run(repo)
    (t / "deploy" / "a.txt").write_text("hand edit")
    (r / "b.txt").write_text("x")
    sh("git", "add", "-A", cwd=r)
    sh("git", "commit", "-qm", "c2", cwd=r)
    p = run(repo, check=False)
    assert p.returncode == 1 and "deploy worktree" in p.stderr


def test_check_mode_changes_nothing(repo):
    r, t, env = repo
    p = run(repo, "--check")
    assert "ras-deploy-" in p.stdout and not (t / "deploy").exists() and sh("git", "tag", cwd=r).stdout.strip() == ""


def test_unit_points_at_deploy_worktree_not_live_tree():
    unit = open(os.path.join(os.path.dirname(__file__), "..", "ras-hourly.service")).read()
    wd = [l for l in unit.splitlines() if l.startswith("WorkingDirectory=")][0]
    assert wd.endswith("/oc/consult/audio/deploy")


def test_unit_uses_a_venv_outside_the_live_tree_and_the_deploy_tree():
    unit = open(os.path.join(os.path.dirname(__file__), "..", "ras-hourly.service")).read()
    ex = [l for l in unit.splitlines() if l.startswith("ExecStart=")][0]
    assert "/oc/consult/audio/ras-venv/bin/python" in ex
    assert "room-audio-state" not in ex and "/audio/deploy" not in ex


def test_deploy_installs_requirements_into_the_venv_only_on_a_real_deploy(repo, tmp_path):
    r, t, env = repo
    fake = tmp_path / "venv" / "bin"
    fake.mkdir(parents=True)
    py = fake / "python"
    py.write_text('#!/bin/bash\necho "$PYTHONNOUSERSITE $@" >> "%s"\n' % (tmp_path / "pip.log"))
    py.chmod(0o755)
    (r / "requirements.txt").write_text("numpy==2.2.6\n")
    sh("git", "add", "-A", cwd=r)
    sh("git", "commit", "-qm", "req", cwd=r)
    env2 = {**env, "RAS_VENV": str(tmp_path / "venv")}
    sh("bash", "deploy.sh", "--check", cwd=r, env=env2)
    assert not (tmp_path / "pip.log").exists()
    sh("bash", "deploy.sh", cwd=r, env=env2)
    line = (tmp_path / "pip.log").read_text()
    assert line.startswith("1 -m pip install") and "-r " in line


def test_failed_pip_moves_nothing_and_logs_a_failure_line(repo, tmp_path):
    r, t, env = repo
    fake = tmp_path / "venv2" / "bin"
    fake.mkdir(parents=True)
    py = fake / "python"
    py.write_text("#!/bin/bash\nexit 3\n")
    py.chmod(0o755)
    (r / "requirements.txt").write_text("numpy==2.2.6\n")
    sh("git", "add", "-A", cwd=r)
    sh("git", "commit", "-qm", "req", cwd=r)
    p = sh("bash", "deploy.sh", cwd=r, env={**env, "RAS_VENV": str(tmp_path / "venv2")}, check=False)
    assert p.returncode == 1 and "nothing was deployed" in p.stderr
    assert not (t / "deploy").exists() and sh("git", "tag", cwd=r).stdout.strip() == ""
    assert "FAILED pip install" in (t / "deploy.log").read_text()


def test_requirements_pin_the_full_runtime_closure():
    req = open(os.path.join(os.path.dirname(__file__), "..", "requirements.txt")).read().lower()
    for name in ("psycopg[binary]==", "psycopg-binary==", "typing-extensions==", "numpy=="):
        assert name in req, name
    assert ">=" not in req
