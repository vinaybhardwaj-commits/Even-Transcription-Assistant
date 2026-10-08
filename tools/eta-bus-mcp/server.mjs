#!/usr/bin/env node
// eta-bus MCP server: stdio, newline-delimited JSON-RPC 2.0, hand-rolled
// (no npm dependencies — see even-jev-mcp for the SDK-based reference
// this copies the wire conventions from: initialize/tools-list/tools-call
// shape and protocol version negotiation).

import readline from 'node:readline';
import { resolveIdentity } from './lib/identity.mjs';
import { getDb } from './lib/db.mjs';
import { listToolDefs, callTool } from './lib/tools.mjs';
import {
  PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
} from './lib/constants.mjs';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function negotiateProtocolVersion(requested) {
  if (requested && PROTOCOL_VERSIONS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize': {
        const protocolVersion = negotiateProtocolVersion(params?.protocolVersion);
        sendResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }

      case 'ping': {
        sendResult(id, {});
        return;
      }

      case 'tools/list': {
        sendResult(id, { tools: listToolDefs() });
        return;
      }

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments ?? {};
        try {
          const identity = await resolveIdentity();
          const db = getDb();
          const result = await callTool(toolName, args, { identity, db });
          // O2 (fix round 3): structuredContent duplicated the whole
          // payload on the wire (content[].text AND structuredContent),
          // so ruling 9's 24KB inbox cap was a 24KB array inside a ~50KB
          // reply. Send the payload once.
          sendResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendResult(id, {
            isError: true,
            content: [{ type: 'text', text: message }],
          });
        }
        return;
      }

      default:
        if (id !== undefined) {
          sendError(id, -32601, `method not found: ${method}`);
        }
        return;
    }
  } catch (err) {
    if (id !== undefined) {
      sendError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // stdin can hit EOF (rl 'close') while a request's async work — e.g. a
  // herdr-ctl.sh child process — is still in flight (this matters for
  // one-shot test pipes; a real MCP client keeps stdin open). Track
  // in-flight handlers and only exit once they've all settled.
  const inFlight = new Set();
  let stdinClosed = false;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore unparseable lines
    }
    if (msg && msg.method) {
      // Notifications (no id) still get dispatched for side effects (none
      // needed today) but never receive a response.
      const p = handleRequest(msg).catch(() => {});
      inFlight.add(p);
      p.finally(() => {
        inFlight.delete(p);
        if (stdinClosed && inFlight.size === 0) process.exit(0);
      });
    }
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (inFlight.size === 0) process.exit(0);
  });
}

main();
