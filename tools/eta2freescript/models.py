"""Model clients. Every one exposes resolve(alias) -> (model_id, route) and chat(...) -> text, so the pipeline and the
eval can be driven by Bedrock, the box gateway, stored outputs (replay) or a test double without changing code.

Unit tests use FakeClient / ReplayClient only; nothing under tests/ imports boto3 or reaches the network.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from .phi_guard import assert_phi_safe

# Bedrock model ids. Defaults are the global inference profiles the prototype used through the gateway; override per
# deployment with ETA2FS_BEDROCK_<ALIAS> (e.g. ETA2FS_BEDROCK_SONNET).
DEFAULT_BEDROCK_IDS = {
    "sonnet": "global.anthropic.claude-sonnet-4-6",
    "opus": "global.anthropic.claude-opus-4-6-v1",
    "haiku": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
}
# USD per 1M tokens (input, output), Anthropic list prices; the Bedrock bill may differ.
PRICES = {"sonnet": (3.0, 15.0), "opus": (5.0, 25.0), "haiku": (1.0, 5.0)}


class UsageLedger:
    """Appends one JSON line per model call: tag, model, seconds, tokens, USD. Counts only, never text."""

    def __init__(self, path: Path | None):
        self.path = Path(path) if path else None
        self._lock = threading.Lock()

    def record(self, alias: str, tag: str, secs: float, tin: int, tout: int, stop: str | None = None) -> None:
        if not self.path:
            return
        pi, po = PRICES.get(alias, (0.0, 0.0))
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "model": alias, "tag": tag, "secs": round(secs, 1),
               "in": tin, "out": tout, "stop": stop, "usd": round(tin / 1e6 * pi + tout / 1e6 * po, 5)}
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")


def cost_for_uid(ledger: UsageLedger | None, uid: str) -> float | None:
    """Sum USD already written for this consult. Tags are ``stageA-v2:<uid>`` and ``stageB-v4:<uid>``. No model call."""
    path = getattr(ledger, "path", None)
    if not path or not Path(path).exists() or not uid:
        return None
    total = 0.0
    found = False
    suffix = ":" + uid
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if str(rec.get("tag") or "").endswith(suffix):
            total += float(rec.get("usd") or 0)
            found = True
    return round(total, 5) if found else None


class ModelClient:
    ledger: UsageLedger = UsageLedger(None)

    def resolve(self, alias: str) -> tuple[str, str]:
        raise NotImplementedError

    def _chat(self, alias: str, prompt: str, system: str, max_tokens: int, temperature: float, tag: str) -> str:
        raise NotImplementedError

    def chat(self, alias: str, prompt: str, system: str, max_tokens: int = 8000, temperature: float = 0.0, tag: str = "") -> str:
        model_id, route = self.resolve(alias)
        assert_phi_safe(model_id, route)
        return self._chat(alias, prompt, system, max_tokens, temperature, tag)


class BedrockClient(ModelClient):
    """boto3 bedrock-runtime converse. AWS credentials and region come from the usual AWS env / profile."""

    def __init__(self, ledger: UsageLedger | None = None, region: str | None = None):
        self.ledger = ledger or UsageLedger(None)
        self.region = region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        self._rt = None

    def resolve(self, alias: str) -> tuple[str, str]:
        mid = os.environ.get(f"ETA2FS_BEDROCK_{alias.upper()}") or DEFAULT_BEDROCK_IDS.get(alias) or alias
        return mid, "converse"

    def _runtime(self):
        if self._rt is None:
            import boto3  # optional dependency; requirements-bedrock.txt
            self._rt = boto3.client("bedrock-runtime", region_name=self.region)
        return self._rt

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        mid, _ = self.resolve(alias)
        t0 = time.time()
        for attempt in range(3):
            try:
                resp = self._runtime().converse(
                    modelId=mid, system=[{"text": system}],
                    messages=[{"role": "user", "content": [{"text": prompt}]}],
                    inferenceConfig={"maxTokens": max_tokens, "temperature": temperature})
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(10 * (attempt + 1))
        text = "".join(c.get("text", "") for c in resp["output"]["message"]["content"])
        u = resp.get("usage", {})
        self.ledger.record(alias, tag, time.time() - t0, u.get("inputTokens", 0), u.get("outputTokens", 0), resp.get("stopReason"))
        return text


class GatewayClient(ModelClient):
    """The box's shared llm-gateway (`evengw`), as the prototype used it. ETA2FS_EVENGW_PATH points at its directory."""

    def __init__(self, ledger: UsageLedger | None = None, path: str | None = None):
        self.ledger = ledger or UsageLedger(None)
        p = path or os.environ.get("ETA2FS_EVENGW_PATH")
        if p and p not in sys.path:
            sys.path.insert(0, p)
        import evengw  # noqa: E402
        self.gw = evengw

    def resolve(self, alias):
        return self.gw.resolve(alias), self.gw.route(alias)[1]

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        t0 = time.time()
        for attempt in range(3):
            try:
                text, resp = self.gw.chat(alias, prompt, system=system, max_tokens=max_tokens, temperature=temperature, raw=True)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(10 * (attempt + 1))
        u = resp.get("usage", {})
        self.ledger.record(alias, tag, time.time() - t0, u.get("inputTokens", 0), u.get("outputTokens", 0), resp.get("stopReason"))
        return text


class FakeClient(ModelClient):
    """Test double. `responder(tag, prompt, system) -> text`, or a dict keyed by tag prefix (e.g. "stageA")."""

    def __init__(self, responder: Callable[[str, str, str], str] | dict, model_id: str = "anthropic.claude-test", route: str = "converse"):
        self.responder, self.model_id, self.route = responder, model_id, route
        self.calls: list[dict] = []

    def resolve(self, alias):
        return self.model_id, self.route

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        self.calls.append({"alias": alias, "tag": tag, "prompt": prompt, "system": system})
        if callable(self.responder):
            return self.responder(tag, prompt, system)
        for k, v in self.responder.items():
            if tag.startswith(k):
                return v
        raise KeyError(f"FakeClient has no response for tag {tag!r}")


class ReplayClient(ModelClient):
    """Replays stored model output from DIR/<uid>/<file>: stageA.json, stageB.txt, judge.json. Lets the deterministic
    stages (guards, mapper, validator, eval metrics) be rerun offline, e.g. on the synthetic fixtures."""

    FILES = {"stageA": "stageA.json", "stageB": "stageB.txt", "judge": "judge.json"}

    def __init__(self, root: Path):
        self.root = Path(root)

    def resolve(self, alias):
        return f"replay.anthropic.claude-{alias}", "converse"

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        stage, _, rest = tag.partition(":")
        uid = rest.split(":")[-1]
        p = self.root / uid / self.FILES[stage.split("-")[0]]
        if not p.exists():
            raise FileNotFoundError(f"replay: no stored {stage} output for {uid} at {p}")
        return p.read_text(encoding="utf-8")


class StageAFromClient(ModelClient):
    """Reuses another run's stored Stage A output so two arms differ only in Stage B. A Stage A call (tag stage part
    starts ``stageA-``) returns ROOT/<uid>/stageA.raw.txt exactly, with no model call and no ledger row. Every other
    call goes to the inner client unchanged. A missing, unreadable or empty file raises: never a live Stage A fallback."""

    def __init__(self, inner: ModelClient, root: Path):
        self.inner, self.root = inner, Path(root)

    @property
    def ledger(self) -> UsageLedger:
        return self.inner.ledger

    def resolve(self, alias):
        return self.inner.resolve(alias)

    @staticmethod
    def _uid(tag: str) -> str:
        return tag.partition(":")[2].split(":")[-1]

    def stage_a_path(self, uid: str) -> Path:
        if not uid or uid in (".", "..") or "/" in uid or "\\" in uid:
            raise ValueError(f"stage-a-from: unusable consult id in tag {uid!r}")
        return self.root / uid / "stageA.raw.txt"

    def stage_a_text(self, uid: str) -> str:
        p = self.stage_a_path(uid)
        if not p.is_file():
            raise FileNotFoundError(f"stage-a-from: no stored Stage A output for {uid} at {p}")
        text = p.read_bytes().decode("utf-8")
        if not text.strip():
            raise ValueError(f"stage-a-from: stored Stage A output for {uid} is empty at {p}")
        return text

    def stage_a_sha12(self, uid: str) -> str:
        self.stage_a_text(uid)
        return hashlib.sha256(self.stage_a_path(uid).read_bytes()).hexdigest()[:12]

    def chat(self, alias, prompt, system, max_tokens=8000, temperature=0.0, tag=""):
        if tag.partition(":")[0].startswith("stageA-"):
            return self.stage_a_text(self._uid(tag))
        return self.inner.chat(alias, prompt, system, max_tokens, temperature, tag)

    def _chat(self, alias, prompt, system, max_tokens, temperature, tag):
        return self.chat(alias, prompt, system, max_tokens, temperature, tag)


def make_client(kind: str, ledger: UsageLedger | None = None, replay_dir: Path | None = None) -> ModelClient:
    if kind == "bedrock":
        return BedrockClient(ledger)
    if kind == "gateway":
        return GatewayClient(ledger)
    if kind == "replay":
        if not replay_dir:
            raise SystemExit("--replay DIR is required for the replay client")
        return ReplayClient(replay_dir)
    raise SystemExit(f"unknown client {kind!r} (bedrock | gateway | replay)")
