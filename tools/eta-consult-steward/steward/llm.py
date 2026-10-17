"""Bedrock converse client (boto3). One attempt per call: no silent retries (botocore max_attempts=1, no loop here).
The agent owns retries so every attempt is counted against the cap. With BEDROCK_ROLE_ARN set, credentials come from
steward.creds (GCP -> STS web identity); otherwise the usual AWS env / profile."""
from __future__ import annotations
import os

from . import creds, phi

READ_TIMEOUT_S = 300


class BedrockConverse:
    def __init__(self, model_id: str, region: str | None = None, cache: creds.CredentialCache | None = None):
        self.model_id = phi.assert_model_ok(model_id)
        self.region = region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        self.cache = cache if cache is not None else (creds.CredentialCache() if creds.configured() else None)
        self._rt, self._rt_exp = None, 0.0

    @staticmethod
    def _config():
        from botocore.config import Config
        return Config(read_timeout=READ_TIMEOUT_S, connect_timeout=15, retries={"total_max_attempts": 1, "mode": "standard"})

    def _runtime(self):
        import boto3
        if self.cache is None:
            if self._rt is None:
                self._rt = boto3.client("bedrock-runtime", region_name=self.region, config=self._config())
            return self._rt
        c = self.cache.get()
        if self._rt is None or c["expires_at"] != self._rt_exp:
            self._rt = boto3.client("bedrock-runtime", region_name=self.region, aws_access_key_id=c["access_key"],
                                    aws_secret_access_key=c["secret_key"], aws_session_token=c["token"],
                                    config=self._config())
            self._rt_exp = c["expires_at"]
        return self._rt

    def converse(self, system: str, messages: list, tool_config: dict, max_tokens: int = 2000) -> dict:
        return self._runtime().converse(modelId=self.model_id, system=[{"text": system}], messages=messages,
                                        toolConfig=tool_config, inferenceConfig={"maxTokens": max_tokens})
