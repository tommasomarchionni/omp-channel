#!/usr/bin/env node
// Minimal MCP server over stdio. It has no dependencies: it reads newline-delimited JSON-RPC
// from stdin and writes to stdout. After the client sends notifications/initialized, it pushes
// one test message to the agent. It never contacts any external service.
// Use it through the MCP configuration of Oh My Pi (see README.md), or run it to see the output.

import { createInterface } from "node:readline";

const CHANNEL_METHOD = "notifications/omp/channel";
const PROTOCOL_VERSION = "2025-06-18";

const text = process.env.EXAMPLE_CHANNEL_TEXT ?? "Hello from the example service.";
const messageId = process.env.EXAMPLE_CHANNEL_MESSAGE_ID ?? "example-1";
const conversationId = process.env.EXAMPLE_CHANNEL_CONVERSATION_ID ?? "example-conversation";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitMessage(id, body) {
  send({
    jsonrpc: "2.0",
    method: CHANNEL_METHOD,
    params: {
      type: "message",
      conversationId,
      messageId: id,
      sender: "example-user",
      attribution: "agent",
      text: body,
      sentAt: new Date().toISOString(),
    },
  });
}

function emitTestMessage() {
  emitMessage(messageId, text);
  // Optional second message, for checks of a busy agent (test/omp-e2e). Off unless set.
  const secondAfter = Number(process.env.EXAMPLE_CHANNEL_SECOND_AFTER_MS ?? "");
  if (Number.isFinite(secondAfter) && secondAfter > 0) {
    setTimeout(
      () =>
        emitMessage(`${messageId}-2`, "Second example message, sent while the agent may be busy."),
      secondAfter,
    );
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        serverInfo: { name: "example-service-mcp", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") {
    emitTestMessage();
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [] } });
    return;
  }
  // Notifications without an id are ignored. Requests for unknown methods get an error.
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${String(method)}` },
    });
  }
});

lines.on("close", () => process.exit(0));
