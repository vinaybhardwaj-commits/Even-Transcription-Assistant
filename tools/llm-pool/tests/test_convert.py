import json

import pytest

from llm_pool import convert
from llm_pool.errors import UpstreamError
from llm_pool.pricing import Usage

from fakes import bedrock_text_events, bedrock_tool_events


def openai_messages():
    return [
        {"role": "system", "content": "You are terse."},
        {"role": "user", "content": "Say hi"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": '{"city": "Pune"}'}},
        ]},
        {"role": "tool", "tool_call_id": "call_1", "content": '{"temp_c": 31}'},
    ]


def test_to_bedrock_messages_and_tools():
    body = {
        "model": "haiku",
        "messages": openai_messages(),
        "max_tokens": 128,
        "temperature": 0.2,
        "tools": [{"type": "function", "function": {"name": "get_weather", "description": "weather",
                                                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}],
        "tool_choice": "auto",
    }
    kwargs = convert.to_bedrock(body, "global.anthropic.claude-haiku-5-5")
    assert kwargs["system"] == [{"text": "You are terse."}]
    assert kwargs["inferenceConfig"]["maxTokens"] == 128
    assert kwargs["inferenceConfig"]["temperature"] == 0.2
    roles = [m["role"] for m in kwargs["messages"]]
    assert roles == ["user", "assistant", "user"]
    tool_use = kwargs["messages"][1]["content"][0]["toolUse"]
    assert tool_use["name"] == "get_weather"
    assert tool_use["input"] == {"city": "Pune"}
    tool_result = kwargs["messages"][2]["content"][0]["toolResult"]
    assert tool_result["toolUseId"] == "call_1"
    assert tool_result["content"][0]["text"] == '{"temp_c": 31}'
    assert kwargs["toolConfig"]["tools"][0]["toolSpec"]["name"] == "get_weather"
    assert kwargs["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"] == {
        "json": {"type": "object", "properties": {"city": {"type": "string"}}}
    }
    assert kwargs["toolConfig"]["toolChoice"] == {"auto": {}}


def test_consecutive_roles_merge():
    body = {"messages": [
        {"role": "user", "content": "one"},
        {"role": "user", "content": "two"},
        {"role": "assistant", "content": "ok"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "call_2", "type": "function", "function": {"name": "t", "arguments": "{}"}}]},
    ]}
    kwargs = convert.to_bedrock(body, "global.anthropic.claude-haiku-5-5")
    assert [m["role"] for m in kwargs["messages"]] == ["user", "assistant"]
    assert [b.get("text") for b in kwargs["messages"][0]["content"]] == ["one", "two"]
    assert kwargs["messages"][1]["content"][1]["toolUse"]["toolUseId"] == "call_2"


def test_tool_choice_none_drops_tools():
    body = {"messages": [{"role": "user", "content": "hi"}],
            "tools": [{"type": "function", "function": {"name": "t"}}], "tool_choice": "none"}
    kwargs = convert.to_bedrock(body, "global.anthropic.claude-haiku-5-5")
    assert "toolConfig" not in kwargs


def test_tool_choice_required_and_named():
    body = {"messages": [{"role": "user", "content": "hi"}],
            "tools": [{"type": "function", "function": {"name": "t"}}], "tool_choice": "required"}
    assert convert.to_bedrock(body, "m")["toolConfig"]["toolChoice"] == {"any": {}}
    body["tool_choice"] = {"type": "function", "function": {"name": "t"}}
    assert convert.to_bedrock(body, "m")["toolConfig"]["toolChoice"] == {"tool": {"name": "t"}}


def test_bad_requests_raise_400():
    with pytest.raises(UpstreamError) as excinfo:
        convert.to_bedrock({"messages": []}, "m")
    assert excinfo.value.status_code == 400
    with pytest.raises(UpstreamError):
        convert.to_bedrock({"messages": [{"role": "user", "content": "x"}], "n": 2}, "m")
    with pytest.raises(UpstreamError):
        convert.to_bedrock({"messages": [{"role": "narrator", "content": "x"}]}, "m")
    with pytest.raises(UpstreamError):
        convert.to_bedrock({"messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://example.com/a.png"}}]}]}, "m")


def test_image_data_url_supported():
    body = {"messages": [{"role": "user", "content": [
        {"type": "text", "text": "look"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,aGVsbG8="}},
    ]}]}
    kwargs = convert.to_bedrock(body, "m")
    blocks = kwargs["messages"][0]["content"]
    assert blocks[0] == {"text": "look"}
    assert blocks[1]["image"]["format"] == "png"
    assert blocks[1]["image"]["source"]["bytes"] == b"hello"


def test_bedrock_result_to_openai_text():
    raw = {"output": {"message": {"role": "assistant", "content": [{"text": "hi"}, {"text": " there"}]}},
           "stopReason": "end_turn", "usage": {"inputTokens": 10, "outputTokens": 3, "totalTokens": 13}}
    response = convert.bedrock_result_to_openai(raw, requested_model="haiku", request_id="chatcmpl-t1")
    assert response["id"] == "chatcmpl-t1"
    message = response["choices"][0]["message"]
    assert message["content"] == "hi there"
    assert response["choices"][0]["finish_reason"] == "stop"
    assert response["usage"]["prompt_tokens"] == 10
    assert response["usage"]["completion_tokens"] == 3


def test_bedrock_result_to_openai_tool_calls():
    raw = {"output": {"message": {"role": "assistant", "content": [
        {"toolUse": {"toolUseId": "call_9", "name": "get_weather", "input": {"city": "Pune"}}}]}},
        "stopReason": "tool_use", "usage": {"inputTokens": 20, "outputTokens": 8, "totalTokens": 28}}
    response = convert.bedrock_result_to_openai(raw, requested_model="haiku")
    message = response["choices"][0]["message"]
    assert message["content"] is None
    assert response["choices"][0]["finish_reason"] == "tool_calls"
    tool_call = message["tool_calls"][0]
    assert tool_call["id"] == "call_9"
    assert json.loads(tool_call["function"]["arguments"]) == {"city": "Pune"}


def test_finish_reason_mapping():
    assert convert._BEDROCK_FINISH["max_tokens"] == "length"
    assert convert._BEDROCK_FINISH["tool_use"] == "tool_calls"
    assert convert._gemini_finish("MAX_TOKENS") == "length"
    assert convert._gemini_finish("SAFETY") == "content_filter"
    assert convert._gemini_finish(None) == "stop"


def test_bedrock_stream_text():
    usage = Usage()
    translator = convert.BedrockStreamTranslator(requested_model="haiku", request_id="chatcmpl-s1",
                                                 include_usage=True, usage=usage)
    chunks = []
    for event in bedrock_text_events():
        chunks.extend(translator.feed(event))
    chunks.extend(translator.final())
    assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks if c.get("choices"))
    assert text == "Hello"
    finish = [c for c in chunks if c.get("choices") and c["choices"][0]["finish_reason"]]
    assert finish[-1]["choices"][0]["finish_reason"] == "stop"
    usage_chunks = [c for c in chunks if c.get("choices") == []]
    assert usage_chunks[-1]["usage"]["prompt_tokens"] == 7
    assert usage.input_tokens == 7
    assert usage.output_tokens == 2


def test_bedrock_stream_tool_call():
    usage = Usage()
    translator = convert.BedrockStreamTranslator(requested_model="haiku", include_usage=False, usage=usage)
    chunks = []
    for event in bedrock_tool_events():
        chunks.extend(translator.feed(event))
    chunks.extend(translator.final())
    tool_chunks = [c for c in chunks if c["choices"][0]["delta"].get("tool_calls")]
    first = tool_chunks[0]["choices"][0]["delta"]["tool_calls"][0]
    assert first["id"] == "call_abc123"
    assert first["function"]["name"] == "get_weather"
    arguments = "".join(c["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"] for c in tool_chunks)
    assert json.loads(arguments) == {"city": "Pune"}
    finish = [c for c in chunks if c["choices"][0]["finish_reason"]]
    assert finish[-1]["choices"][0]["finish_reason"] == "tool_calls"
    assert usage.output_tokens == 8


def test_to_vertex_messages_and_tools():
    body = {
        "model": "gemini",
        "messages": openai_messages(),
        "max_tokens": 64,
        "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {
            "type": "object", "properties": {"city": {"type": "string"}}, "$schema": "http://json-schema.org"}}}],
    }
    payload = convert.to_vertex(body, "gemini-2.5-pro")
    assert payload["systemInstruction"]["parts"][0]["text"] == "You are terse."
    assert payload["generationConfig"]["maxOutputTokens"] == 64
    roles = [c["role"] for c in payload["contents"]]
    assert roles == ["user", "model", "user"]
    call = payload["contents"][1]["parts"][0]["functionCall"]
    assert call == {"name": "get_weather", "args": {"city": "Pune"}}
    response_part = payload["contents"][2]["parts"][0]["functionResponse"]
    assert response_part["name"] == "get_weather"
    assert response_part["response"] == {"temp_c": 31}
    declaration = payload["tools"]["functionDeclarations"][0]
    assert "$schema" not in declaration["parameters"]


def test_vertex_result_and_tool_call():
    raw = {"candidates": [{"content": {"role": "model", "parts": [{"text": "hello "}, {"text": "gemini"}]},
                           "finishReason": "STOP"}],
           "usageMetadata": {"promptTokenCount": 9, "candidatesTokenCount": 4, "totalTokenCount": 13}}
    response = convert.vertex_result_to_openai(raw, requested_model="gemini")
    assert response["choices"][0]["message"]["content"] == "hello gemini"
    assert response["usage"]["prompt_tokens"] == 9

    tool_raw = {"candidates": [{"content": {"role": "model", "parts": [
        {"functionCall": {"name": "get_weather", "args": {"city": "Pune"}}}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 15, "candidatesTokenCount": 6, "totalTokenCount": 21}}
    response = convert.vertex_result_to_openai(tool_raw, requested_model="gemini")
    message = response["choices"][0]["message"]
    assert message["content"] is None
    assert message["tool_calls"][0]["function"]["name"] == "get_weather"
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {"city": "Pune"}


def test_vertex_blocked_prompt():
    with pytest.raises(UpstreamError) as excinfo:
        convert.vertex_result_to_openai({"promptFeedback": {"blockReason": "SAFETY"}}, requested_model="gemini")
    assert excinfo.value.status_code == 400


def test_vertex_stream_text_and_usage():
    usage = Usage()
    translator = convert.VertexStreamTranslator(requested_model="gemini", include_usage=True, usage=usage)
    chunks = []
    chunks.extend(translator.feed({"candidates": [{"content": {"parts": [{"text": "Hi"}]}}]}))
    chunks.extend(translator.feed({"candidates": [{"content": {"parts": [{"text": " there"}]}, "finishReason": "STOP"}],
                                   "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 2}}))
    chunks.extend(translator.final())
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks if c.get("choices"))
    assert text == "Hi there"
    finish = [c for c in chunks if c["choices"] and c["choices"][0]["finish_reason"]]
    assert finish[-1]["choices"][0]["finish_reason"] == "stop"
    assert usage.input_tokens == 5
    usage_chunks = [c for c in chunks if c.get("choices") == []]
    assert usage_chunks and usage_chunks[0]["usage"]["completion_tokens"] == 2
