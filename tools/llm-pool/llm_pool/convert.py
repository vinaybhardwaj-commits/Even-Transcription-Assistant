"""OpenAI chat-completions shapes <-> Bedrock Converse and Vertex Gemini payloads."""
from __future__ import annotations

import base64
import json
import time
import uuid

from .errors import UpstreamError
from .pricing import Usage

_BEDROCK_FINISH = {
    "end_turn": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "stop_sequence": "stop",
}
_GEMINI_FINISH = {"STOP": "stop", "MAX_TOKENS": "length"}
_GEMINI_BLOCKED = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"}
_IMAGE_FORMATS = {"jpeg": "jpeg", "jpg": "jpeg", "png": "png", "gif": "gif", "webp": "webp"}


def new_completion_id() -> str:
    return "chatcmpl-" + uuid.uuid4().hex[:24]


def _bad(message: str) -> UpstreamError:
    return UpstreamError(400, message, "invalid_request_error", err_type="invalid_request_error")


def _json_object(raw) -> dict:
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {"value": raw}


def _text_of(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out: list[str] = []
        for part in content:
            if isinstance(part, str):
                out.append(part)
            elif isinstance(part, dict) and part.get("type", "text") == "text":
                out.append(str(part.get("text", "")))
            else:
                raise _bad("unsupported content part in message content")
        return "".join(out)
    raise _bad("message content must be a string or a list of parts")


def _image_block(part: dict) -> dict:
    image_url = part.get("image_url")
    url = image_url.get("url") if isinstance(image_url, dict) else image_url
    if not isinstance(url, str) or not url.startswith("data:image/"):
        raise _bad("image_url must be a data: URL; remote image URLs are not supported")
    header, _, b64 = url.partition(",")
    mime = header[len("data:image/"):].split(";")[0].lower()
    fmt = _IMAGE_FORMATS.get(mime)
    if not fmt:
        raise _bad(f"unsupported image type {mime!r}")
    try:
        data = base64.b64decode(b64 + "=" * (-len(b64) % 4))
    except Exception as exc:
        raise _bad("image data URL is not valid base64") from exc
    return {"image": {"format": fmt, "source": {"type": "bytes", "bytes": data}}}


def _user_blocks(content) -> list:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"text": content}] if content else []
    if isinstance(content, list):
        blocks = []
        for part in content:
            if not isinstance(part, dict):
                raise _bad("each content part must be an object")
            ptype = part.get("type")
            if ptype == "text" or (ptype is None and "text" in part):
                blocks.append({"text": str(part.get("text", ""))})
            elif ptype == "image_url":
                blocks.append(_image_block(part))
            else:
                raise _bad(f"unsupported content part type {ptype!r}")
        return blocks
    raise _bad("message content must be a string or a list of parts")


def _tool_use_block(tool_call: dict) -> dict:
    if not isinstance(tool_call, dict):
        raise _bad("each tool_call must be an object")
    fn = tool_call.get("function") or {}
    name = fn.get("name")
    if not name:
        raise _bad("tool_call is missing function.name")
    tool_use_id = tool_call.get("id") or f"call_{uuid.uuid4().hex[:16]}"
    return {"toolUse": {"toolUseId": tool_use_id, "name": name, "input": _json_object(fn.get("arguments"))}}


def _append_message(out: list, role: str, blocks: list) -> None:
    if out and out[-1]["role"] == role:
        out[-1]["content"].extend(blocks)
    else:
        out.append({"role": role, "content": list(blocks)})


def to_bedrock_messages(messages: list) -> tuple[list, list]:
    system: list = []
    out: list = []
    for message in messages:
        if not isinstance(message, dict):
            raise _bad("each message must be an object")
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "developer"):
            text = _text_of(content)
            if text:
                system.append({"text": text})
            continue
        if role == "user":
            blocks = _user_blocks(content)
            if blocks:
                _append_message(out, "user", blocks)
            continue
        if role == "assistant":
            blocks = []
            text = _text_of(content)
            if text:
                blocks.append({"text": text})
            for tool_call in message.get("tool_calls") or []:
                blocks.append(_tool_use_block(tool_call))
            if blocks:
                _append_message(out, "assistant", blocks)
            continue
        if role == "tool":
            tool_use_id = message.get("tool_call_id")
            if not isinstance(tool_use_id, str) or not tool_use_id:
                raise _bad("tool message is missing tool_call_id")
            text = _text_of(content) or "(no output)"
            _append_message(
                out,
                "user",
                [{"toolResult": {"toolUseId": tool_use_id, "content": [{"text": text}], "status": "success"}}],
            )
            continue
        raise _bad(f"unsupported message role {role!r}")
    return system, out


def effective_max_tokens(body: dict, default_max_tokens: int) -> int:
    """The output ceiling the upstream call will actually carry (also used to size the cap reservation)."""
    max_tokens = body.get("max_tokens")
    if isinstance(max_tokens, (int, float)) and not isinstance(max_tokens, bool) and max_tokens > 0:
        return int(max_tokens)
    return int(default_max_tokens)


def _inference_config(body: dict, default_max_tokens: int) -> dict:
    config: dict = {}
    config["maxTokens"] = effective_max_tokens(body, default_max_tokens)
    temperature = body.get("temperature")
    if isinstance(temperature, (int, float)):
        config["temperature"] = float(temperature)
    top_p = body.get("top_p")
    if isinstance(top_p, (int, float)):
        config["topP"] = float(top_p)
    stop = body.get("stop") or body.get("stop_sequences")
    if isinstance(stop, str):
        stop = [stop]
    if isinstance(stop, list) and stop:
        config["stopSequences"] = [str(item) for item in stop[:4]]
    return config


def _tool_choice_is_none(choice) -> bool:
    return choice == "none" or (isinstance(choice, dict) and choice.get("type") == "none")


def _tool_specs(body: dict) -> list:
    tools = body.get("tools")
    specs: list = []
    if isinstance(tools, list):
        for tool in tools:
            if not isinstance(tool, dict):
                raise _bad("each tool must be an object")
            if tool.get("type", "function") != "function":
                raise _bad(f"unsupported tool type {tool.get('type')!r}")
            fn = tool.get("function") or {}
            name = fn.get("name")
            if not name:
                raise _bad("tool is missing function.name")
            schema = fn.get("parameters") or {"type": "object", "properties": {}}
            specs.append(
                {
                    "toolSpec": {
                        "name": name,
                        "description": str(fn.get("description") or ""),
                        "inputSchema": {"json": schema},
                    }
                }
            )
    return specs


def _tool_config(body: dict) -> dict | None:
    if _tool_choice_is_none(body.get("tool_choice")):
        return None
    specs = _tool_specs(body)
    choice = body.get("tool_choice")
    if not specs:
        if choice in (None, "auto"):
            return None
        raise _bad("tool_choice was given but no tools were provided")
    config: dict = {"tools": specs}
    tool_choice = None
    if choice in (None, "auto"):
        tool_choice = {"auto": {}}
    elif choice == "required":
        tool_choice = {"any": {}}
    elif isinstance(choice, dict):
        ctype = choice.get("type")
        if ctype == "auto":
            tool_choice = {"auto": {}}
        elif ctype == "any":
            tool_choice = {"any": {}}
        elif ctype == "function":
            name = (choice.get("function") or {}).get("name")
            if not name:
                raise _bad("tool_choice function is missing name")
            tool_choice = {"tool": {"name": name}}
        elif ctype == "tool":
            name = choice.get("name")
            if not name:
                raise _bad("tool_choice is missing name")
            tool_choice = {"tool": {"name": name}}
        elif ctype == "none":
            return None
        else:
            raise _bad(f"unsupported tool_choice type {ctype!r}")
    elif isinstance(choice, str) and choice:
        tool_choice = {"tool": {"name": choice}}
    if tool_choice is not None:
        config["toolChoice"] = tool_choice
    return config


def _history_tool_names(messages: list) -> tuple[bool, list[str]]:
    """(history has any toolUse/toolResult block, distinct toolUse names in order)."""
    has_tools = False
    names: list[str] = []
    for message in messages:
        for block in message.get("content") or []:
            if "toolResult" in block:
                has_tools = True
            elif "toolUse" in block:
                has_tools = True
                name = block["toolUse"].get("name")
                if name and name not in names:
                    names.append(name)
    return has_tools, names


def _history_tool_config(body: dict, out: list) -> dict | None:
    """Converse rejects toolUse/toolResult blocks without a toolConfig. When the request omits tools (or says
    tool_choice=none) still send one: the request's tools if any, else a minimal stub per tool used in history.
    Converse has no 'none' choice, so no toolChoice is set here."""
    has_tools, names = _history_tool_names(out)
    if not has_tools:
        return None
    specs = _tool_specs(body)
    if not specs:
        specs = [
            {"toolSpec": {"name": name, "description": "", "inputSchema": {"json": {"type": "object", "properties": {}}}}}
            for name in (names or ["tool"])
        ]
    return {"tools": specs}


def to_bedrock(body: dict, model_id: str, *, default_max_tokens: int = 4096) -> dict:
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise _bad("messages must be a non-empty array")
    if body.get("n") not in (None, 1):
        raise _bad("only n=1 is supported")
    system, out = to_bedrock_messages(messages)
    if not out:
        raise _bad("messages produced no content for bedrock")
    kwargs: dict = {"messages": out, "inferenceConfig": _inference_config(body, default_max_tokens)}
    if system:
        kwargs["system"] = system
    tool_config = _tool_config(body)
    if tool_config is None:
        tool_config = _history_tool_config(body, out)
    if tool_config is not None:
        kwargs["toolConfig"] = tool_config
    return kwargs


def bedrock_usage(raw: dict) -> Usage:
    usage = (raw or {}).get("usage") or {}
    return Usage(
        input_tokens=int(usage.get("inputTokens") or 0),
        output_tokens=int(usage.get("outputTokens") or 0),
        cache_tokens=int(usage.get("cacheReadInputTokens") or 0),
        reported=bool(usage),
    )


def _finish_chunk(translator_id: str, created: int, model: str, finish_reason: str | None) -> dict:
    return {
        "id": translator_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
    }


def _usage_chunk(translator_id: str, created: int, model: str, usage: Usage) -> dict:
    return {
        "id": translator_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [],
        "usage": usage.to_openai(),
    }


def bedrock_result_to_openai(raw: dict, *, requested_model: str, request_id: str | None = None, clock=time.time) -> dict:
    message = ((raw.get("output") or {}).get("message")) or {}
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for block in message.get("content") or []:
        if "text" in block:
            text_parts.append(str(block["text"]))
        elif "toolUse" in block:
            tool_use = block["toolUse"]
            tool_calls.append(
                {
                    "id": tool_use.get("toolUseId") or f"call_{uuid.uuid4().hex[:16]}",
                    "type": "function",
                    "function": {
                        "name": tool_use.get("name") or "",
                        "arguments": json.dumps(tool_use.get("input") or {}),
                    },
                }
            )
    text = "".join(text_parts)
    finish_reason = _BEDROCK_FINISH.get(raw.get("stopReason"), "stop")
    message_body: dict = {"role": "assistant", "content": text if text else (None if tool_calls else "")}
    if tool_calls:
        message_body["tool_calls"] = tool_calls
    return {
        "id": request_id or new_completion_id(),
        "object": "chat.completion",
        "created": int(clock()),
        "model": requested_model,
        "choices": [{"index": 0, "message": message_body, "finish_reason": finish_reason, "logprobs": None}],
        "usage": bedrock_usage(raw).to_openai(),
    }


class BedrockStreamTranslator:
    def __init__(self, *, requested_model: str, request_id: str | None = None, include_usage: bool = False,
                 usage: Usage | None = None, clock=time.time):
        self.requested_model = requested_model
        self.id = request_id or new_completion_id()
        self.created = int(clock())
        self.include_usage = include_usage
        self.usage = usage if usage is not None else Usage()
        self.finish_reason: str | None = None
        self._tool_index_by_block: dict[int, int] = {}
        self._tool_count = 0
        self._emitted_finish = False
        self._emitted_usage = False

    def _chunk(self, delta: dict, finish_reason: str | None = None) -> dict:
        return {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.requested_model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }

    def _set_usage(self, usage: Usage) -> None:
        self.usage.input_tokens = usage.input_tokens
        self.usage.output_tokens = usage.output_tokens
        self.usage.cache_tokens = usage.cache_tokens
        self.usage.reported = True

    def feed(self, event: dict) -> list[dict]:
        chunks: list[dict] = []
        if "messageStart" in event:
            chunks.append(self._chunk({"role": "assistant", "content": ""}))
        elif "contentBlockStart" in event:
            payload = event["contentBlockStart"] or {}
            start = payload.get("start") or {}
            if "toolUse" in start:
                tool_use = start["toolUse"]
                index = self._tool_count
                self._tool_count += 1
                block_index = payload.get("contentBlockIndex")
                if block_index is not None:
                    self._tool_index_by_block[block_index] = index
                chunks.append(
                    self._chunk(
                        {
                            "tool_calls": [
                                {
                                    "index": index,
                                    "id": tool_use.get("toolUseId") or f"call_{uuid.uuid4().hex[:16]}",
                                    "type": "function",
                                    "function": {"name": tool_use.get("name") or "", "arguments": ""},
                                }
                            ]
                        }
                    )
                )
        elif "contentBlockDelta" in event:
            payload = event["contentBlockDelta"] or {}
            delta = payload.get("delta") or {}
            if "text" in delta:
                chunks.append(self._chunk({"content": str(delta["text"])}))
            elif "toolUse" in delta:
                partial = (delta["toolUse"] or {}).get("input")
                if partial:
                    block_index = payload.get("contentBlockIndex")
                    index = self._tool_index_by_block.get(block_index, 0)
                    chunks.append(self._chunk({"tool_calls": [{"index": index, "function": {"arguments": str(partial)}}]}))
        elif "messageStop" in event:
            payload = event["messageStop"] or {}
            self.finish_reason = _BEDROCK_FINISH.get(payload.get("stopReason"), "stop")
            if "usage" in payload:
                self._set_usage(bedrock_usage(payload))
            if not self._emitted_finish:
                chunks.append(self._chunk({}, self.finish_reason))
                self._emitted_finish = True
        elif "metadata" in event:
            meta = event["metadata"] or {}
            if "usage" in meta:
                self._set_usage(bedrock_usage(meta))
        return chunks

    def final(self) -> list[dict]:
        chunks: list[dict] = []
        if not self._emitted_finish:
            self.finish_reason = self.finish_reason or "stop"
            chunks.append(_finish_chunk(self.id, self.created, self.requested_model, self.finish_reason))
            self._emitted_finish = True
        if self.include_usage and not self._emitted_usage:
            chunks.append(_usage_chunk(self.id, self.created, self.requested_model, self.usage))
            self._emitted_usage = True
        return chunks


def _strip_schema(value):
    if isinstance(value, dict):
        return {k: _strip_schema(v) for k, v in value.items() if k not in ("$schema", "$defs", "definitions")}
    if isinstance(value, list):
        return [_strip_schema(item) for item in value]
    return value


def _tool_name_for(messages: list, tool_call_id) -> str | None:
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for tool_call in message.get("tool_calls") or []:
            if isinstance(tool_call, dict) and tool_call.get("id") == tool_call_id:
                name = (tool_call.get("function") or {}).get("name")
                if name:
                    return str(name)
    return None


def _append_vertex(contents: list, role: str, parts: list) -> None:
    if contents and contents[-1]["role"] == role:
        contents[-1]["parts"].extend(parts)
    else:
        contents.append({"role": role, "parts": list(parts)})


def _vertex_user_parts(content) -> list:
    if content is None:
        return []
    if isinstance(content, str):
        return [{"text": content}] if content else []
    if isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                raise _bad("each content part must be an object")
            ptype = part.get("type")
            if ptype == "text" or (ptype is None and "text" in part):
                parts.append({"text": str(part.get("text", ""))})
            elif ptype == "image_url":
                raise _bad("image inputs are not supported on the gemini path yet")
            else:
                raise _bad(f"unsupported content part type {ptype!r}")
        return parts
    raise _bad("message content must be a string or a list of parts")


def _vertex_tools(body: dict) -> list | None:
    tools = body.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    declarations = []
    for tool in tools:
        if not isinstance(tool, dict):
            raise _bad("each tool must be an object")
        if tool.get("type", "function") != "function":
            raise _bad(f"unsupported tool type {tool.get('type')!r}")
        fn = tool.get("function") or {}
        name = fn.get("name")
        if not name:
            raise _bad("tool is missing function.name")
        declaration: dict = {"name": name, "description": str(fn.get("description") or "")}
        parameters = fn.get("parameters")
        if parameters:
            declaration["parameters"] = _strip_schema(parameters)
        declarations.append(declaration)
    return declarations


def _vertex_tool_config(body: dict) -> dict | None:
    choice = body.get("tool_choice")
    if choice is None or choice == "auto":
        return None
    if choice == "required":
        return {"functionCallingConfig": {"mode": "ANY"}}
    if _tool_choice_is_none(choice):
        return {"functionCallingConfig": {"mode": "NONE"}}
    if isinstance(choice, dict):
        ctype = choice.get("type")
        if ctype == "function":
            name = (choice.get("function") or {}).get("name")
        elif ctype == "tool":
            name = choice.get("name")
        else:
            raise _bad(f"unsupported tool_choice type {ctype!r}")
        if not name:
            raise _bad("tool_choice is missing name")
        return {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [name]}}
    if isinstance(choice, str) and choice:
        return {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": [choice]}}
    raise _bad("unsupported tool_choice value")


def to_vertex(body: dict, model_id: str, *, default_max_tokens: int = 4096) -> dict:
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise _bad("messages must be a non-empty array")
    if body.get("n") not in (None, 1):
        raise _bad("only n=1 is supported")
    system_parts: list[str] = []
    contents: list = []
    for message in messages:
        if not isinstance(message, dict):
            raise _bad("each message must be an object")
        role = message.get("role")
        content = message.get("content")
        if role in ("system", "developer"):
            text = _text_of(content)
            if text:
                system_parts.append(text)
            continue
        if role == "user":
            parts = _vertex_user_parts(content)
            if parts:
                _append_vertex(contents, "user", parts)
            continue
        if role == "assistant":
            parts = []
            text = _text_of(content)
            if text:
                parts.append({"text": text})
            for tool_call in message.get("tool_calls") or []:
                fn = (tool_call or {}).get("function") or {}
                name = fn.get("name")
                if not name:
                    raise _bad("tool_call is missing function.name")
                parts.append({"functionCall": {"name": name, "args": _json_object(fn.get("arguments"))}})
            if parts:
                _append_vertex(contents, "model", parts)
            continue
        if role == "tool":
            text = _text_of(content) or "(no output)"
            name = _tool_name_for(messages, message.get("tool_call_id")) or "tool"
            try:
                response = json.loads(text)
            except json.JSONDecodeError:
                response = {"result": text}
            if not isinstance(response, dict):
                response = {"result": response}
            _append_vertex(contents, "user", [{"functionResponse": {"name": name, "response": response}}])
            continue
        raise _bad(f"unsupported message role {role!r}")
    if not contents:
        raise _bad("messages produced no content for vertex")
    payload: dict = {"contents": contents}
    if system_parts:
        payload["systemInstruction"] = {"parts": [{"text": "\n".join(system_parts)}]}
    generation: dict = {"maxOutputTokens": effective_max_tokens(body, default_max_tokens)}
    temperature = body.get("temperature")
    if isinstance(temperature, (int, float)):
        generation["temperature"] = float(temperature)
    top_p = body.get("top_p")
    if isinstance(top_p, (int, float)):
        generation["topP"] = float(top_p)
    stop = body.get("stop") or body.get("stop_sequences")
    if isinstance(stop, str):
        stop = [stop]
    if isinstance(stop, list) and stop:
        generation["stopSequences"] = [str(item) for item in stop[:4]]
    payload["generationConfig"] = generation
    tools = _vertex_tools(body)
    if tools:
        payload["tools"] = {"functionDeclarations": tools}
    tool_config = _vertex_tool_config(body)
    if tool_config is not None:
        payload["toolConfig"] = tool_config
    return payload


def vertex_usage(raw: dict) -> Usage:
    meta = (raw or {}).get("usageMetadata") or {}
    return Usage(
        input_tokens=int(meta.get("promptTokenCount") or 0),
        output_tokens=int(meta.get("candidatesTokenCount") or 0),
        cache_tokens=int(meta.get("cachedContentTokenCount") or 0),
        reported=bool(meta),
    )


def _gemini_finish(reason: str | None) -> str:
    if reason in _GEMINI_FINISH:
        return _GEMINI_FINISH[reason]
    if reason in _GEMINI_BLOCKED:
        return "content_filter"
    return "stop"


def _vertex_candidate(raw: dict) -> dict:
    candidates = raw.get("candidates") or []
    if not candidates:
        block = (raw.get("promptFeedback") or {}).get("blockReason")
        detail = f": {block}" if block else ""
        raise UpstreamError(400, f"gemini returned no candidates{detail}", "invalid_request_error",
                            err_type="invalid_request_error")
    return candidates[0]


def vertex_result_to_openai(raw: dict, *, requested_model: str, request_id: str | None = None, clock=time.time) -> dict:
    candidate = _vertex_candidate(raw)
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for part in ((candidate.get("content") or {}).get("parts") or []):
        if "text" in part:
            text_parts.append(str(part["text"]))
        if "functionCall" in part:
            call = part["functionCall"]
            tool_calls.append(
                {
                    "id": f"call_{uuid.uuid4().hex[:16]}",
                    "type": "function",
                    "function": {"name": call.get("name") or "", "arguments": json.dumps(call.get("args") or {})},
                }
            )
    text = "".join(text_parts)
    message_body: dict = {"role": "assistant", "content": text if text else (None if tool_calls else "")}
    if tool_calls:
        message_body["tool_calls"] = tool_calls
    return {
        "id": request_id or new_completion_id(),
        "object": "chat.completion",
        "created": int(clock()),
        "model": requested_model,
        "choices": [
            {
                "index": 0,
                "message": message_body,
                "finish_reason": "tool_calls" if tool_calls and _gemini_finish(candidate.get("finishReason")) == "stop"
                else _gemini_finish(candidate.get("finishReason")),
                "logprobs": None,
            }
        ],
        "usage": vertex_usage(raw).to_openai(),
    }


class VertexStreamTranslator:
    def __init__(self, *, requested_model: str, request_id: str | None = None, include_usage: bool = False,
                 usage: Usage | None = None, clock=time.time):
        self.requested_model = requested_model
        self.id = request_id or new_completion_id()
        self.created = int(clock())
        self.include_usage = include_usage
        self.usage = usage if usage is not None else Usage()
        self.finish_reason: str | None = None
        self._emitted_finish = False
        self._emitted_usage = False
        self._tool_count = 0

    def _finish(self, reason: str | None) -> str:
        finish = _gemini_finish(reason)
        return "tool_calls" if self._tool_count and finish == "stop" else finish

    def _chunk(self, delta: dict, finish_reason: str | None = None) -> dict:
        return {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.requested_model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }

    def _set_usage(self, usage: Usage) -> None:
        self.usage.input_tokens = usage.input_tokens
        self.usage.output_tokens = usage.output_tokens
        self.usage.cache_tokens = usage.cache_tokens
        self.usage.reported = True

    def feed(self, event: dict) -> list[dict]:
        chunks: list[dict] = []
        feedback = event.get("promptFeedback") or {}
        if feedback.get("blockReason"):
            raise UpstreamError(400, f"gemini blocked the request: {feedback['blockReason']}",
                                "invalid_request_error", err_type="invalid_request_error")
        if "usageMetadata" in event:
            self._set_usage(vertex_usage(event))
        candidates = event.get("candidates") or []
        if candidates:
            candidate = candidates[0]
            for part in ((candidate.get("content") or {}).get("parts") or []):
                if "text" in part and part["text"]:
                    chunks.append(self._chunk({"content": str(part["text"])}))
                if "functionCall" in part:
                    call = part["functionCall"]
                    index = self._tool_count
                    self._tool_count += 1
                    chunks.append(
                        self._chunk(
                            {
                                "tool_calls": [
                                    {
                                        "index": index,
                                        "id": f"call_{uuid.uuid4().hex[:16]}",
                                        "type": "function",
                                        "function": {
                                            "name": call.get("name") or "",
                                            "arguments": json.dumps(call.get("args") or {}),
                                        },
                                    }
                                ]
                            }
                        )
                    )
            reason = candidate.get("finishReason")
            if reason and not self._emitted_finish:
                self.finish_reason = self._finish(reason)
                chunks.append(self._chunk({}, self.finish_reason))
                self._emitted_finish = True
        return chunks

    def final(self) -> list[dict]:
        chunks: list[dict] = []
        if not self._emitted_finish:
            self.finish_reason = self.finish_reason or ("tool_calls" if self._tool_count else "stop")
            chunks.append(_finish_chunk(self.id, self.created, self.requested_model, self.finish_reason))
            self._emitted_finish = True
        if self.include_usage and not self._emitted_usage:
            chunks.append(_usage_chunk(self.id, self.created, self.requested_model, self.usage))
            self._emitted_usage = True
        return chunks


def include_usage(body: dict) -> bool:
    options = body.get("stream_options")
    return isinstance(options, dict) and bool(options.get("include_usage"))
