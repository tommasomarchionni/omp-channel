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
