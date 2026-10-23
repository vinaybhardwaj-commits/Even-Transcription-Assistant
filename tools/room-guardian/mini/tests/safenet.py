"""FR1 D7-4 MUST-1: the session-wide safety net. Import this FIRST in any test module that imports the router code (the router modules read
GUARDIAN_HOME, GUARDIAN_GATING_INBOX and UBUS_MCP once, at import). run.sh sets the variables before python starts; this module covers a run that
did not come through run.sh (python -m unittest on one file) and a run that inherited the LIVE values. The live router runs from
~/oc/fleet-access/guardian: no test may open anything under it, nor the real gating inbox."""
import atexit, os, shutil, tempfile

LIVE_HOME = os.path.realpath(os.path.expanduser("~/oc/fleet-access/guardian"))
LIVE_INBOX = os.path.realpath(os.path.expanduser("~/oc/fable/INBOX-FROM-GATING.md"))


def real(p):
    return os.path.realpath(os.path.expanduser(p))


def under(path, root):
    path, root = real(path), real(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def is_live(path):
    return under(path, LIVE_HOME) or real(path) == LIVE_INBOX


def install():
    """Point GUARDIAN_HOME, GUARDIAN_GATING_INBOX and UBUS_MCP at a scratch dir unless they already name a scratch place (set by run.sh)."""
    home = os.environ.get("GUARDIAN_HOME")
    if not home or is_live(home):
        d = tempfile.mkdtemp(prefix="guardian-test-")
        atexit.register(shutil.rmtree, d, True)
        os.environ["GUARDIAN_HOME"] = d
        home = d
    inbox = os.environ.get("GUARDIAN_GATING_INBOX")
    if not inbox or is_live(inbox):
        os.environ["GUARDIAN_GATING_INBOX"] = os.path.join(home, "INBOX-scratch.md")
    shim = os.environ.get("UBUS_MCP")
    if not shim or under(shim, os.path.expanduser("~/.local/ubus-mcp")):
        os.environ["UBUS_MCP"] = os.path.join(home, "no-such-ubus-mcp")      # a test that forgets to mock Popen fails here, it never reaches the real bus


install()
