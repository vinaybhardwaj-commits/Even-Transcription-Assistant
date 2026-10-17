"""Advise-mode agent loop: read-only tools, then one submit_report call. Executes no actions."""
from __future__ import annotations
import json
import os
import time

from . import config, report as rpt, spend, tools

SYSTEM = """You are the ENC steward for a hospital's consult-audio pipeline. Mode: ADVISE. You only read and suggest.
You never change code, deploy, migrate or delete, and you cannot execute actions; a human approves any action later.

Job: compare yesterday and today. Find gaps: visits with no placed room, placed visits with no cut consult, skipped or
deferred consults, rooms with tape hours but few consults, rooms with consults but no tape, lane files missing for a
cut consult, R2 mirror not 'mirrored', recent alerts. Use the tools, then call submit_report once.

Rules:
- Name rooms by their room_label (for example "OPD 5") and room_id only. Never write a room slug (hyphenated names).
- Write ids, counts, dates, times only. Never a person's name, a transcript, or any number with 6 or more digits.
  A tool never gives you names; do not guess any.
- summary_md: 5 to 12 short plain lines. Say what looks normal as well as what does not.
- EVERY concrete gap you find becomes its own entry in the findings array of submit_report (these are the items) (up to 25; group by room and date, one item per room per gap type, and
  list consult ids in body_md). Gap types you must itemise when present:
  1. unplaced visits (visits with no room);
  2. skipped consults with no room, and skip reasons such as url_clear with zero coverage;
  3. doctor_split_failed consults;
  4. cut consults missing doctor.flac or others.flac;
  5. low coverage (below 0.9) cut consults;
  6. recon versus placed mismatches (cut count and placed count differ);
  7. rooms with tape hours but no consults, or consults but no tape; R2 not mirrored; recent alerts.
- Each item has kind 'suggestion' or 'question'. A suggestion carries proposed_action {type, args} where type is one of
  recut, rerun_lane, retry_pull, rerun_recon, and args use consult_uid, room_id, date, lane (sarvam|nemotron|role|parts) only.
  Use recut for a consult whose clip is bad, rerun_lane for a missing lane file, retry_pull for tape gaps, rerun_recon for
  count mismatches. When no allowed action fits, set kind 'question', leave proposed_action out, and say in body_md in plain
  words who should act (for example "ops: placement data" or "V: clinical call"). Propose an action only when the tool
  output shows the cause.
- If data is missing (no recon file, no alerts file), say so once and carry on with what you have."""

SUBMIT = {"toolSpec": {"name": "submit_report", "description": "Final report. Call once, last.",
                       "inputSchema": {"json": {"type": "object", "required": ["summary_md", "findings"], "properties": {
                           "summary_md": {"type": "string"},
                           "findings": {"type": "array", "description": "One entry per concrete gap. Never empty when the summary lists a gap.", "items": {"type": "object", "required": ["kind", "title", "body_md"],
                                                                  "properties": {
                                                                      "kind": {"type": "string", "enum": ["suggestion", "question"]},
                                                                      "ist_date": {"type": "string"},
                                                                      "room_id": {"type": "string"},
                                                                      "consult_uid": {"type": "string"},
                                                                      "title": {"type": "string"},
                                                                      "body_md": {"type": "string"},
                                                                      "proposed_action": {"type": "object", "properties": {
                                                                          "type": {"type": "string", "enum": list(config.ALLOWED_ACTIONS)},
                                                                          "args": {"type": "object"}}}}}}}}}}}

MAX_TURNS = 14


MAX_ATTEMPTS = 2  # per logical call; every attempt is checked against the cap and booked


def _est(messages, tc, max_out) -> float:
    return spend.estimate_call_usd(len(SYSTEM) + len(json.dumps(messages, default=str)) + len(json.dumps(tc)), max_out)


def run_agent(client, ledger: spend.Ledger, today: str, yesterday: str, model: str) -> dict:
    tc = tools.tool_config()
    tc["tools"].append(SUBMIT)
    messages = [{"role": "user", "content": [{"text": f"Advise run. Today (IST) is {today}; yesterday is {yesterday}. "
                                                      "Start with recon_get for both dates."}]}]
    normal_out, report_out = config.MAX_OUT_TOKENS, config.REPORT_OUT_TOKENS
    truncated = False
    tin = tout = 0
    submitted = None
    status = "ok"
    squeezed = False
    for _ in range(MAX_TURNS):
        # Squeeze early enough that the report call still fits: when two more calls would not fit, report now.
        if not squeezed and ledger.run_cap is not None and \
                ledger.run_spent + _est(messages, tc, normal_out) + _est(messages, {"tools": [SUBMIT]}, report_out) > ledger.run_cap:
            squeezed = True
        if not squeezed and ledger.run_cap is not None and ledger.run_spent >= 0.6 * ledger.run_cap:
            squeezed = True
        if squeezed and tc["tools"] != [SUBMIT]:
            tc = {"tools": [SUBMIT]}
            note = {"text": "Budget nearly used. Call submit_report now with every gap found so far, one finding per room and gap type."}
            if messages[-1]["role"] == "user":
                messages[-1]["content"].append(note)
            else:
                messages.append({"role": "user", "content": [note]})
        max_out = report_out if squeezed else normal_out  # the report call gets the larger budget
        resp = None
        for attempt in range(MAX_ATTEMPTS):
            est = _est(messages, tc, max_out)
            try:
                ledger.check(est)  # hard stop per attempt
            except spend.CapExceeded:
                status = "cap"
                break
            t0 = time.time()
            try:
                resp = client.converse(SYSTEM, messages, tc, max_tokens=max_out)
                break
            except Exception:  # noqa: BLE001  timeout or API error: usage unknown, book the worst case
                ledger.record_worst(model, est, time.time() - t0)
                status = "error"
                time.sleep(2 if attempt == 0 and MAX_ATTEMPTS > 1 and not os.environ.get("STEWARD_NO_SLEEP") else 0)
        if resp is None:
            break
        status = "ok"
        u = resp.get("usage", {})
        ledger.record(model, u.get("inputTokens", 0), u.get("outputTokens", 0), time.time() - t0, tag="advise")
        tin += u.get("inputTokens", 0)
        tout += u.get("outputTokens", 0)
        msg = resp["output"]["message"]
        messages.append(msg)
        if resp.get("stopReason") == "max_tokens":
            # reply cut off: keep any report already parsed, but never call this run ok
            truncated = True
            for c in msg["content"]:
                if "toolUse" in c and c["toolUse"]["name"] == "submit_report" and isinstance(c["toolUse"].get("input"), dict):
                    submitted = c["toolUse"]["input"]
            break
        uses = [c["toolUse"] for c in msg["content"] if "toolUse" in c]
        if not uses:
            status = "no_report"
            break
        results = []
        for tu in uses:
            if tu["name"] == "submit_report":
                submitted = tu["input"]
                results.append({"toolResult": {"toolUseId": tu["toolUseId"], "content": [{"text": "received"}]}})
                continue
            try:
                out = json.dumps(tools.call(tu["name"], tu.get("input") or {}), separators=(",", ":"))
                results.append({"toolResult": {"toolUseId": tu["toolUseId"], "content": [{"text": out}]}})
            except Exception as e:  # noqa: BLE001
                results.append({"toolResult": {"toolUseId": tu["toolUseId"], "content": [{"text": f"error: {e}"}],
                                               "status": "error"}})
        messages.append({"role": "user", "content": results})
        if submitted is not None:
            break
    else:
        status = "turn_limit"
    if truncated:
        status = "truncated"
    elif submitted is not None:
        status = "ok"
    elif status == "ok":
        status = "no_report"
    return {"report": submitted, "tokens_in": tin, "tokens_out": tout, "status": status}
