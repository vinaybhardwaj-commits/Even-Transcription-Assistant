"""FastAPI gateway: client-token auth, OpenAI chat completions (stream + tools), spend ledger, /spend."""
from __future__ import annotations

import hmac
import json
import logging
import re
import time
import uuid

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import timeutil
from .cap import CapGuard
from .config import list_models, resolve_model
from .errors import UpstreamError
from .ledger import Ledger, LedgerRow
from .pricing import Usage, estimate_usd, price_for

log = logging.getLogger("llm_pool.server")

_SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
_CALLER_RE = re.compile(r"[^A-Za-z0-9._-]")


class ApiError(Exception):
    def __init__(self, status_code: int, message: str, code: str, err_type: str = "invalid_request_error"):
        super().__init__(message)
        self.status_code = int(status_code)
        self.message = message
        self.code = code
        self.err_type = err_type

    def response(self) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if self.status_code == 401 else None
        return JSONResponse(
            status_code=self.status_code,
            content={"error": {"message": self.message, "type": self.err_type, "code": self.code}},
            headers=headers,
        )


def _caller_for(request: Request, config: dict, presented: str, client_token: str) -> str | None:
    callers = config.get("callers") or {}
    for name, known in callers.items():
        if isinstance(known, str) and known and hmac.compare_digest(known, presented):
            return str(name)
    if hmac.compare_digest(client_token, presented):
        header = request.headers.get("x-llm-pool-caller") or "default"
        return _CALLER_RE.sub("-", str(header))[:64].strip("-") or "default"
    return None


def create_app(
    config: dict,
    *,
    ledger: Ledger,
    bedrock,
    vertex,
    client_token: str,
    clock=time.time,
    cap_guard: CapGuard | None = None,
    logger=log,
) -> FastAPI:
    app = FastAPI(title="llm-pool", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)
    guard = cap_guard or CapGuard(
        ledger,
        config["aws_daily_cap_usd"],
        config.get("aws_daily_cap_warn_fraction", 0.8),
        clock=clock,
        logger=logger,
    )
    state = {
        "config": config,
        "ledger": ledger,
        "bedrock": bedrock,
        "vertex": vertex,
        "client_token": client_token,
        "clock": clock,
        "cap_guard": guard,
        "logger": logger,
        "started": int(clock()),
    }

    @app.exception_handler(ApiError)
    async def _api_error_handler(request: Request, exc: ApiError):
        return exc.response()

    async def require_auth(request: Request) -> str:
        header = request.headers.get("authorization") or ""
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not presented.strip():
            raise ApiError(401, "missing bearer token", "unauthorized", "authentication_error")
        caller = _caller_for(request, config, presented.strip(), client_token)
        if caller is None:
            raise ApiError(401, "invalid client token", "unauthorized", "authentication_error")
        return caller

    def _record(caller: str, body: dict, spec, usage: Usage, request_id: str) -> float:
        price = price_for(config, spec.price_family)
        estimated = estimate_usd(price, usage)
        ledger.add(
            LedgerRow(
                caller=caller,
                model=str(body.get("model") or spec.model_id),
                model_id=spec.model_id,
                provider=spec.provider,
                price_family=spec.price_family,
                in_tokens=usage.input_tokens,
                out_tokens=usage.output_tokens,
                cache_tokens=usage.cache_tokens,
                est_usd=estimated,
                request_id=request_id,
            )
        )
        return estimated

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/v1/models")
    async def models(caller: str = Depends(require_auth)):
        created = state["started"]
        return {
            "object": "list",
            "data": [
                {"id": spec.requested, "object": "model", "created": created, "owned_by": spec.provider}
                for spec in list_models(config)
            ],
        }

    @app.get("/spend")
    async def spend(caller: str = Depends(require_auth)):
        today = timeutil.ist_day(state["clock"]())
        by_model = ledger.totals_for_day(today)
        aws_total = sum(row["est_usd"] for row in by_model if row["provider"] == "bedrock")
        cap = float(config["aws_daily_cap_usd"])
        return {
            "day_ist": today,
            "tz": timeutil.TZ_NAME,
            "by_model": by_model,
            "aws_daily_total_usd": round(aws_total, 6),
            "aws_daily_cap_usd": cap,
            "aws_remaining_usd": round(max(0.0, cap - aws_total), 6),
            "aws_percent_used": round(100.0 * aws_total / cap, 2) if cap else 0.0,
        }

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request, caller: str = Depends(require_auth)):
        try:
            body = await request.json()
        except Exception:
            raise ApiError(400, "request body is not valid JSON", "invalid_request_error")
        if not isinstance(body, dict):
            raise ApiError(400, "request body must be a JSON object", "invalid_request_error")
        model = body.get("model")
        if not isinstance(model, str) or not model.strip():
            raise ApiError(400, "model is required", "invalid_request_error")
        spec = resolve_model(config, model)
        if spec is None:
            raise ApiError(404, f"unknown model: {model}", "model_not_found")
        upstream = state["bedrock"] if spec.provider == "bedrock" else state["vertex"]
        if upstream is None:
            raise ApiError(503, f"provider {spec.provider} is not configured", "provider_unavailable", "api_error")
        if spec.provider == "bedrock":
            decision = state["cap_guard"].check("bedrock")
            if not decision.allowed:
                raise ApiError(
                    429,
                    (
                        f"AWS daily cap reached: spent USD {decision.spent_usd:.2f} of USD "
                        f"{decision.cap_usd:.2f} since 00:00 IST; bedrock calls are refused "
                        "until the IST day rolls over"
                    ),
                    "aws_daily_cap_exceeded",
                    "rate_limit_error",
                )
        request_id = "chatcmpl-" + uuid.uuid4().hex[:24]
        usage = Usage()

        if body.get("stream"):
            def generate():
                try:
                    for chunk in upstream.stream(body, spec, usage, request_id=request_id):
                        yield "data: " + json.dumps(chunk) + "\n\n"
                    yield "data: [DONE]\n\n"
                except UpstreamError as exc:
                    state["logger"].warning(
                        "llm-pool: stream failed (%s/%s): %s %s",
                        spec.provider, spec.model_id, exc.code, exc.message[:200],
                    )
                    yield "data: " + json.dumps(exc.openai_body()) + "\n\n"
                    yield "data: [DONE]\n\n"
                except Exception as exc:
                    state["logger"].warning(
                        "llm-pool: stream failed (%s/%s): %s", spec.provider, spec.model_id, type(exc).__name__
                    )
                    err = UpstreamError(502, "upstream stream failed", "upstream_error")
                    yield "data: " + json.dumps(err.openai_body()) + "\n\n"
                    yield "data: [DONE]\n\n"
                finally:
                    try:
                        estimated = _record(caller, body, spec, usage, request_id)
                        state["logger"].info(
                            "llm-pool: caller=%s %s %s stream in=%d out=%d cache=%d usd=%.6f",
                            caller,
                            spec.provider,
                            spec.model_id,
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.cache_tokens,
                            estimated,
                        )
                    except Exception as record_exc:
                        state["logger"].warning(
                            "llm-pool: spend row not written (%s)", type(record_exc).__name__
                        )

            return StreamingResponse(generate(), media_type="text/event-stream", headers=dict(_SSE_HEADERS))

        try:
            response, usage = await run_in_threadpool(upstream.complete, body, spec, request_id)
        except UpstreamError as exc:
            state["logger"].warning(
                "llm-pool: request failed (%s/%s): %s %s",
                spec.provider, spec.model_id, exc.code, exc.message[:200],
            )
            try:
                _record(caller, body, spec, usage, request_id)
                state["logger"].info(
                    "llm-pool: caller=%s %s %s failed code=%s (0 tokens billed)",
                    caller, spec.provider, spec.model_id, exc.code,
                )
            except Exception as record_exc:
                state["logger"].warning(
                    "llm-pool: spend row not written (%s)", type(record_exc).__name__
                )
            return JSONResponse(status_code=exc.status_code, content=exc.openai_body())
        estimated = _record(caller, body, spec, usage, request_id)
        state["logger"].info(
            "llm-pool: caller=%s %s %s in=%d out=%d cache=%d usd=%.6f",
            caller,
            spec.provider,
            spec.model_id,
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_tokens,
            estimated,
        )
        return JSONResponse(content=response)

    app.state.llm_pool = state
    return app
