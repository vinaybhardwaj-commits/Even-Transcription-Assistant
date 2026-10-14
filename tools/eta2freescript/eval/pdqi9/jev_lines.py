"""Per-line transcript support check through the even-jev MCP server (stdio). Metadata only is logged, never text.

JEV_MCP_CMD is a JSON argv (the real server is ~/dev/even-jev-mcp/run.sh on the Mini); the API key is the server's own env.
Without JEV_MCP_CMD the check is recorded as not run and nothing fails. Jev may receive patient text (V's ruling, TypeSafe
ZDR; no de-identification step). Logs stay metadata-only.

The call is matched to the even-jev server's src/evaluation/ask.ts as the lead described it (strict arguments
{"state", "questions": {id: {"type": "noul", "instructions"}}}, answers[id].noul in 0..1, at most 200 questions per call). One call per
consult, split beyond 200 lines. Not yet exercised against the live server; tests use a fake stdio server.
"""
from __future__ import annotations

import json
import os
import select
import subprocess
import time

from ... import validate

MAX_QUESTIONS = 200
INSTRUCTIONS = ("Does the transcript support note line {id}? true = the transcript supports every clinical claim in the line; "
                "false = it does not.")
THRESHOLD = 0.5
NOT_RUN = {"status": "not run"}


class JevError(RuntimeError):
    pass


class StdioMcp:
    """Minimal newline-delimited JSON-RPC client; enough for initialize + tools/call."""

    def __init__(self, argv: list[str], timeout: float = 60.0):
        self.timeout, self._id = timeout, 0
        self.p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "pdqi9-harness", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, msg: dict) -> None:
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def _rpc(self, method: str, params: dict) -> dict:
        self._id += 1
        self._send({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        end = time.time() + self.timeout
        while time.time() < end:
            if not select.select([self.p.stdout], [], [], max(0.0, end - time.time()))[0]:
                break
            line = self.p.stdout.readline()
            if not line:
                raise JevError("server closed")
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise JevError("rpc error")
                return msg.get("result") or {}
        raise JevError("timeout")

    def call(self, tool: str, args: dict) -> dict:
        return self._rpc("tools/call", {"name": tool, "arguments": args})

    def close(self) -> None:
        try:
            self.p.stdin.close()
            self.p.wait(timeout=5)
        except Exception:
            self.p.kill()


def answers_of(result: dict) -> tuple[dict[str, float], str | None]:
    """({question id: noul}, model) from a tools/call result: structuredContent, else the JSON text content."""
    d = result.get("structuredContent")
    if not isinstance(d, dict):
        d = json.loads("".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict)))
    out = {}
    for k, v in (d.get("answers") or {}).items():
        n = v.get("noul") if isinstance(v, dict) else None
        if isinstance(n, (int, float)) and not isinstance(n, bool) and 0 <= n <= 1:
            out[k] = float(n)
    return out, d.get("model") if isinstance(d.get("model"), str) else None


def _argv_from_env() -> list[str] | None:
    raw = os.environ.get("JEV_MCP_CMD")
    if not raw:
        return None
    argv = json.loads(raw)
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise JevError("JEV_MCP_CMD must be a JSON argv")
    return argv


def empty_headings(text: str) -> set[int]:
    """1-based line numbers of bare section headings with no body: `Heading:` with nothing after it and no body line before the next
    heading (or the end). The validator's own heading list decides what a heading is."""
    rows = [(i, ln) for i, ln in enumerate((text or "").split("\n"), 1) if ln.strip()]
    heads = validate.V.HEADINGS
    out = set()
    for k, (i, ln) in enumerate(rows):
        h, sep, body = ln.partition(":")
        if sep and h in heads and not body.strip():
            nxt = rows[k + 1][1] if k + 1 < len(rows) else None
            if nxt is None or (nxt.partition(":")[1] and nxt.partition(":")[0] in heads):
                out.add(i)
    return out


def jev_ask_args(transcript: str, lines: dict[str, str]) -> dict:
    """The one place the jev_ask argument shape lives. Strict: no other keys ("model" is optional and left to the server default)."""
    return {"state": {"transcript": transcript, "lines": lines},
            "questions": {k: {"type": "noul", "instructions": INSTRUCTIONS.format(id=k)} for k in lines}}


def check_lines(note_text: str, transcript: str, client=None) -> dict:
    """{"status": "ok", "lines": n, "low": [{"line": i, "p_yes": p}], "errors": k, "model": m, "calls": c, "jev_skipped_empty_headings": h} or a not-run/error status.
    Bare section headings with no body are not sent and not counted in `lines`.

    Line numbers are 1-based positions in note_text (blank lines count). `client` is a test seam (an object with .call)."""
    if client is None and not os.environ.get("JEV_MCP_CMD"):
        return {**NOT_RUN, "reason": "JEV_MCP_CMD unset"}
    own = client is None
    try:
        client = client or StdioMcp(_argv_from_env())
        bare = empty_headings(note_text or "")
        lines = [(i, ln) for i, ln in enumerate((note_text or "").split("\n"), 1) if ln.strip() and i not in bare]
        low, errors, model, calls = [], 0, None, 0
        for k in range(0, len(lines), MAX_QUESTIONS):
            chunk = lines[k:k + MAX_QUESTIONS]
            ids = {f"L{i}": ln for i, ln in chunk}
            calls += 1
            try:
                ans, m = answers_of(client.call("jev_ask", jev_ask_args(transcript, ids)))
                model = m or model
            except Exception:
                errors += len(chunk)
                continue
            for i, _ in chunk:
                p = ans.get(f"L{i}")
                if p is None:
                    errors += 1
                elif p < THRESHOLD:
                    low.append({"line": i, "p_yes": round(p, 3)})
        return {"status": "ok", "lines": len(lines), "low": low, "errors": errors, "model": model, "calls": calls,
                "jev_skipped_empty_headings": len(bare)}
    except Exception as ex:
        return {"status": "error", "reason": type(ex).__name__}
    finally:
        if own and client is not None:
            client.close()
