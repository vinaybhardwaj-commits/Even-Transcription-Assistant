"""FastAPI gateway: client-token auth, OpenAI chat completions (stream + tools), spend ledger, /spend."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import timeutil
from .cap import CapGuard
from .config import MAIN_CALLER, list_models, resolve_model
from .convert import effective_max_tokens
from .errors import UpstreamError
from .ledger import Ledger, LedgerRow
from .pricing import Usage, estimate_usd, price_for, reservation_usd

log = logging.getLogger("llm_pool.server")

_SSE_HEADERS = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
_CALLER_RE = re.compile(r"[^A-Za-z0-9._-]")


class ApiError(Exception):
    def __init__(self, status_code: int, message: str, code: str, err_type: str = "invalid_request_error",
                 extra: dict | None = None):
        super().__init__(message)
        self.extra = extra or {}
        self.status_code = int(status_code)
        self.message = message
        self.code = code
        self.err_type = err_type

    def response(self) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if self.status_code == 401 else None
        return JSONResponse(
            status_code=self.status_code,
            content={"error": {"message": self.message, "type": self.err_type, "code": self.code, **self.extra}},
            headers=headers,
        )


@dataclass(frozen=True)
class Identity:
    principal: str  # cap bucket: per-caller token name, or "main"
    label: str      # ledger sub-label only (X-LLM-Pool-Caller or the principal)


def _same(known: str, presented: str) -> bool:
    # Compare bytes: hmac.compare_digest raises TypeError on non-ASCII str, which used to surface as a 500.
    return hmac.compare_digest(known.encode("utf-8"), presented.encode("utf-8"))


def _identify(request: Request, config: dict, presented: str, client_token: str) -> Identity | None:
    matched: str | None = None
    for name, known in (config.get("callers") or {}).items():
        if isinstance(known, str) and known and _same(known, presented) and matched is None:
            matched = str(name)
    if matched is None and client_token and _same(client_token, presented):
        matched = MAIN_CALLER
    if matched is None:
        return None
    header = request.headers.get("x-llm-pool-caller")
    label = (_CALLER_RE.sub("-", str(header))[:64].strip("-") if header else "") or matched
    return Identity(matched, label)


def _input_upper_bound(body: dict) -> int:
    """Upper bound on prompt tokens: UTF-8 bytes of the messages/tools payload (a token is at least a byte)."""
    try:
        text = json.dumps({"m": body.get("messages"), "t": body.get("tools")}, default=str, ensure_ascii=False)
    except Exception:
        text = str(body)
    return len(text.encode("utf-8", "replace"))


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
    app = FastAPI(title="llm-pool", version="0.2.0", docs_url=None, redoc_url=None, openapi_url=None)
    cap_per_caller = float(config["aws_daily_cap_usd_per_caller"])
    total_cap = config.get("aws_daily_total_cap_usd")
    guard = cap_guard or CapGuard(
        ledger,
        cap_per_caller,
        config.get("aws_daily_cap_warn_fraction", 0.8),
        total_cap_usd=total_cap,
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

    async def require_auth(request: Request) -> Identity:
        header = request.headers.get("authorization") or ""
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not presented.strip():
            raise ApiError(401, "missing bearer token", "unauthorized", "authentication_error")
        identity = _identify(request, config, presented.strip(), client_token)
        if identity is None:
            raise ApiError(401, "invalid client token", "unauthorized", "authentication_error")
        return identity

    def _settle(identity: Identity, body: dict, spec, usage: Usage, request_id: str, reservation) -> float:
        """Write the ledger row for a call and release its reservation. Never raises, never writes 0 for a
        call the provider accepted: if no usage was reported the worst-case reservation is billed."""
        price = price_for(config, spec.price_family)
        if usage.reported:
            basis, in_t, out_t, cache_t = "actual", usage.input_tokens, usage.output_tokens, usage.cache_tokens
            usd = estimate_usd(price, usage)
        elif usage.accepted:
            basis, in_t, out_t, cache_t = "reserved", reservation.input_tokens, reservation.output_tokens, 0
            usd = reservation.usd
        else:
            basis, in_t, out_t, cache_t, usd = "none", 0, 0, 0, 0.0
        row = LedgerRow(
            caller=identity.label,
            principal=identity.principal,
            model=str(body.get("model") or spec.model_id),
            model_id=spec.model_id,
            provider=spec.provider,
            price_family=spec.price_family,
            in_tokens=in_t,
            out_tokens=out_t,
            cache_tokens=cache_t,
            est_usd=usd,
            request_id=request_id,
            basis=basis,
        )
        try:
            guard.settle(reservation, row)
        except Exception as exc:
            state["logger"].warning("llm-pool: spend row not written (%s); reservation kept", type(exc).__name__)
        return usd

    def _log_done(identity, spec, kind, usage, usd):
        state["logger"].info(
            "llm-pool: caller=%s label=%s %s %s %s in=%d out=%d cache=%d usd=%.6f basis=%s",
            identity.principal, identity.label, spec.provider, spec.model_id, kind,
            usage.input_tokens, usage.output_tokens, usage.cache_tokens, usd,
            "actual" if usage.reported else ("reserved" if usage.accepted else "none"),
        )

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/v1/models")
    async def models(identity: Identity = Depends(require_auth)):
        created = state["started"]
        return {
            "object": "list",
            "data": [
                {"id": spec.requested, "object": "model", "created": created, "owned_by": spec.provider}
                for spec in list_models(config)
            ],
        }

    @app.get("/spend")
    async def spend(identity: Identity = Depends(require_auth)):
        today = timeutil.ist_day(state["clock"]())
        by_model = ledger.totals_for_day(today)
        per: dict[str, dict] = {}
        for row in ledger.totals_by_principal(today):
            entry = per.setdefault(row["principal"], {"calls": 0, "bedrock_usd": 0.0, "vertex_usd": 0.0})
            entry["calls"] += row["calls"]
            entry[f"{row['provider']}_usd"] = round(entry.get(f"{row['provider']}_usd", 0.0) + row["est_usd"], 6)
        names = {MAIN_CALLER} | set((config.get("callers") or {}).keys()) | set(per)
        callers = []
        for name in sorted(names):
            entry = per.get(name, {"calls": 0, "bedrock_usd": 0.0, "vertex_usd": 0.0})
            reserved = guard.reserved_usd(name)
            callers.append(
                {
                    "caller": name,
                    "calls": entry["calls"],
                    "bedrock_usd": round(entry["bedrock_usd"], 6),
                    "vertex_usd": round(entry["vertex_usd"], 6),
                    "reserved_usd": reserved,
                    "cap_usd": cap_per_caller,
                    "remaining_usd": round(max(0.0, cap_per_caller - entry["bedrock_usd"] - reserved), 6),
                    "percent_used": round(100.0 * entry["bedrock_usd"] / cap_per_caller, 2),
                }
            )
        aws_total = round(sum(row["est_usd"] for row in by_model if row["provider"] == "bedrock"), 6)
        out = {
            "day_ist": today,
            "tz": timeutil.TZ_NAME,
            "by_model": by_model,
            "callers": callers,
            "you": identity.principal,
            "aws_daily_cap_usd_per_caller": cap_per_caller,
            "aws_daily_total_usd": aws_total,
            "aws_daily_total_cap_usd": total_cap,
            "aws_total_remaining_usd": (
                round(max(0.0, float(total_cap) - aws_total - guard.reserved_usd()), 6) if total_cap else None
            ),
        }
        return out

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request, identity: Identity = Depends(require_auth)):
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

        # Atomic cap: reserve the worst case (all input tokens uncached + max_tokens of output) under a lock
        # before the upstream call; _settle() replaces it with the real usage afterwards.
        input_upper = _input_upper_bound(body)
        out_ceiling = effective_max_tokens(body, config["default_max_tokens"])
        estimate = reservation_usd(price_for(config, spec.price_family), input_upper, out_ceiling)
        decision = guard.reserve(identity.principal, spec.provider, estimate, input_upper, out_ceiling)
        if not decision.allowed:
            if decision.scope == "total":
                message = (
                    f"AWS daily total cap reached: all callers together spent USD {decision.spent_usd:.2f} of "
                    f"USD {decision.cap_usd:.2f} since 00:00 IST (in-flight USD {decision.reserved_usd:.2f}, "
                    f"this call needs up to USD {decision.estimate_usd:.2f}); caller {identity.principal} "
                    "is refused until the IST day rolls over"
                )
            else:
                message = (
                    f"AWS daily cap reached for caller {identity.principal}: spent USD {decision.spent_usd:.2f} of "
                    f"USD {decision.cap_usd:.2f} since 00:00 IST (in-flight USD {decision.reserved_usd:.2f}, "
                    f"this call needs up to USD {decision.estimate_usd:.2f}); bedrock calls for this caller are "
                    "refused until the IST day rolls over"
                )
            raise ApiError(
                429,
                message,
                "aws_daily_cap_exceeded",
                "rate_limit_error",
                extra={
                    "caller": identity.principal,
                    "scope": decision.scope,
                    "spent_usd": decision.spent_usd,
                    "cap_usd": decision.cap_usd,
                    "reserved_usd": decision.reserved_usd,
                    "estimate_usd": decision.estimate_usd,
                },
            )
        reservation = decision.reservation
        request_id = "chatcmpl-" + uuid.uuid4().hex[:24]
        log_ = state["logger"]

        if body.get("stream"):
            usage = Usage()
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue = asyncio.Queue()

            def emit(item) -> None:
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, item)
                except RuntimeError:
                    pass  # event loop gone (shutdown); the worker still finishes and settles

            def worker() -> None:
                # Owns the upstream stream to its end even if the client disconnects, so Bedrock's final
                # metadata event (the only place usage arrives) is always read and billed.
                try:
                    for chunk in upstream.stream(body, spec, usage, request_id=request_id):
                        emit("data: " + json.dumps(chunk) + "\n\n")
                    emit("data: [DONE]\n\n")
                except UpstreamError as exc:
                    log_.warning("llm-pool: stream failed (%s/%s): %s %s",
                                 spec.provider, spec.model_id, exc.code, exc.message[:200])
                    emit("data: " + json.dumps(exc.openai_body()) + "\n\n")
                    emit("data: [DONE]\n\n")
                except Exception as exc:
                    log_.warning("llm-pool: stream failed (%s/%s): %s",
                                 spec.provider, spec.model_id, type(exc).__name__)
                    err = UpstreamError(502, "upstream stream failed", "upstream_error")
                    emit("data: " + json.dumps(err.openai_body()) + "\n\n")
                    emit("data: [DONE]\n\n")
                finally:
                    usd = _settle(identity, body, spec, usage, request_id, reservation)
                    _log_done(identity, spec, "stream", usage, usd)
                    emit(None)

            threading.Thread(target=worker, name="llm-pool-stream", daemon=True).start()

            async def generate():
                while True:
                    item = await queue.get()
                    if item is None:
                        return
                    yield item

            return StreamingResponse(generate(), media_type="text/event-stream", headers=dict(_SSE_HEADERS))

        def run_call():
            usage = Usage()
            response = None
            error = None
            try:
                response, _ = upstream.complete(body, spec, request_id, usage)
            except UpstreamError as exc:
                error = exc
            except Exception as exc:
                error = UpstreamError(502, type(exc).__name__, "upstream_error")
            finally:
                # Settled inside the thread: a client disconnect cannot skip billing.
                usd = _settle(identity, body, spec, usage, request_id, reservation)
            return response, error, usage, usd

        response, error, usage, usd = await run_in_threadpool(run_call)
        if error is not None:
            log_.warning("llm-pool: request failed (%s/%s): %s %s",
                         spec.provider, spec.model_id, error.code, error.message[:200])
            _log_done(identity, spec, "failed", usage, usd)
            return JSONResponse(status_code=error.status_code, content=error.openai_body())
        _log_done(identity, spec, "complete", usage, usd)
        return JSONResponse(content=response)

    app.state.llm_pool = state
    return app
