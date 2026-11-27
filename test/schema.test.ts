import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildFailure, parseInboundEvent } from "../src/protocol.js";
import { cleanReason, MAX_REASON_LENGTH } from "../src/redact.js";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as object;

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateInbound = ajv.compile(load("inbound-event.schema.json"));
const validateReply = ajv.compile(load("outbound-reply.schema.json"));
const validateStatus = ajv.compile(load("status.schema.json"));
const validateFailure = ajv.compile(load("failure.schema.json"));

const validMessage = {
  type: "message",
  conversationId: "conv-1",
  messageId: "msg-1",
  sender: "ann",
  text: "Hello",
  sentAt: "2026-11-26T10:00:00Z",
  replyTo: "msg-0",
  attribution: "user",
};

describe("published JSON Schemas", () => {
  it("accept each kind of inbound event", () => {
    assert.equal(validateInbound(validMessage), true, JSON.stringify(validateInbound.errors));
    assert.equal(validateInbound({ type: "interrupt", conversationId: "conv-1" }), true);
    assert.equal(validateInbound({ type: "close", conversationId: "conv-1" }), true);
  });

  it("reject what the hand-written validator rejects", () => {
    const cases: unknown[] = [
      { ...validMessage, text: "" },
      { ...validMessage, messageId: "a b" },
      { ...validMessage, extra: true },
      { ...validMessage, attribution: "robot" },
      { type: "interrupt" },
    ];
    for (const item of cases) {
      assert.equal(validateInbound(item), false, JSON.stringify(item));
      assert.equal(parseInboundEvent(item).ok, false, JSON.stringify(item));
    }
  });

  it("accept and reject the message context the same way the parser does", () => {
    const withContext = (context: unknown) => ({ ...validMessage, context });
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, "v"]));
    const valid: unknown[] = [
      withContext({ route: "/pricing", title: "Prices" }),
      withContext({}),
      withContext({ a1_b: "x".repeat(200) }),
      withContext(eight),
    ];
    for (const item of valid) {
      assert.equal(validateInbound(item), true, JSON.stringify(validateInbound.errors));
      assert.equal(parseInboundEvent(item).ok, true, JSON.stringify(item));
    }
    const invalid: unknown[] = [
      withContext({ ...eight, k8: "v" }),
      withContext({ Route: "/x" }),
      withContext({ "1route": "/x" }),
      withContext({ route: 7 }),
      withContext("route"),
      withContext(["route"]),
      { type: "interrupt", conversationId: "conv-1", context: {} },
    ];
    for (const item of invalid) {
      assert.equal(validateInbound(item), false, JSON.stringify(item));
      assert.equal(parseInboundEvent(item).ok, false, JSON.stringify(item));
    }
    // The schema describes what a sender must send; the parser cuts a longer value instead.
    const long = withContext({ route: "x".repeat(201) });
    assert.equal(validateInbound(long), false);
    assert.equal(parseInboundEvent(long).ok, true);
  });

  it("validate the failure report that is built, with and without a reason", () => {
    const report = { messageId: "f-1", at: new Date("2026-11-26T10:00:00.000Z") };
    const long = cleanReason("x ".repeat(MAX_REASON_LENGTH));
    for (const reason of ["404 not loaded", long, undefined]) {
      const failure = buildFailure("conv-1", "msg-1", reason, report);
      assert.equal(validateFailure(failure), true, JSON.stringify(validateFailure.errors));
    }
    const failure = buildFailure("conv-1", "msg-1", "x", report);
    assert.equal(validateFailure({ ...failure, replyTo: undefined }), false);
    assert.equal(validateFailure({ ...failure, extra: 1 }), false);
  });

  it("validate outbound reply and status shapes", () => {
    const reply = {
      type: "reply",
      conversationId: "conv-1",
      messageId: "r-1",
      replyTo: "msg-1",
      text: "answer",
      at: "2026-11-26T10:00:00.000Z",
    };
    assert.equal(validateReply(reply), true, JSON.stringify(validateReply.errors));
    assert.equal(validateReply({ ...reply, replyTo: undefined }), false);
    const status = {
      type: "status",
      conversationId: "conv-1",
      status: "working",
      at: "2026-11-26T10:00:00.000Z",
    };
    assert.equal(validateStatus(status), true, JSON.stringify(validateStatus.errors));
    assert.equal(validateStatus({ ...status, status: "busy" }), false);
  });
});
