"""Shared error type for upstream and conversion failures."""
from __future__ import annotations


class UpstreamError(Exception):
    def __init__(
        self,
        status_code: int,
        message: str,
        code: str = "upstream_error",
        *,
        err_type: str = "api_error",
        auth_expired: bool = False,
    ):
        super().__init__(message)
        self.status_code = int(status_code)
        self.message = message
        self.code = code
        self.err_type = err_type
        self.auth_expired = auth_expired

    def openai_body(self) -> dict:
        return {"error": {"message": self.message, "type": self.err_type, "code": self.code}}
