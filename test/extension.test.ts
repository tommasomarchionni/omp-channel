import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelAdapter, Delivery } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import { createChannelExtension, REPLY_TOOL_NAME } from "../src/extension.js";
import type { OutboundReply, OutboundStatus } from "../src/protocol.js";
import { fakeContext, fakePi, flush } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });

const messageEvent = (messageId: string, conversationId = "c1") => ({
  type: "mcp_notification" as const,
  server: "omp-channel",
  method: "notifications/omp/channel",
  params: { type: "message", conversationId, messageId, sender: "ann", text: `text ${messageId}` },
});

interface TestAdapter extends ChannelAdapter {
  acks: string[];
  replies: OutboundReply[];
  statuses: OutboundStatus[];
}

/** Adapter that yields the given deliveries and then waits until its signal aborts. */
function scriptedAdapter(deliveries: Delivery[]): TestAdapter {
  const acks: string[] = [];
  const replies: OutboundReply[] = [];
  const statuses: OutboundStatus[] = [];
  return {
    acks,
    replies,
    statuses,
    async *receive(signal) {
      for (const delivery of deliveries) {
        yield delivery;
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    reply: async (reply) => {
      replies.push(reply);
    },
    ack: async (deliveryId) => {
      acks.push(deliveryId);
    },
    status: async (status) => {
      statuses.push(status);
    },
  };
}

const delivery = (deliveryId: string, messageId: string): Delivery => ({
  deliveryId,
  event: {
    type: "message",
    conversationId: "c1",
    messageId,
    sender: "ann",
    text: `text ${messageId}`,
  },
});

describe("MCP push path", () => {
  it("admits a notification as a follow-up and only once", async () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    pi.notify(messageEvent("m1"));
    pi.notify(messageEvent("m1"));
    await flush();
    assert.equal(pi.sent.length, 1);
    assert.deepEqual(pi.sent[0]?.options, { deliverAs: "followUp", attribution: "agent" });
  });

  it("ignores notifications from other servers and logs invalid ones without their text", async () => {
    const logs: string[] = [];
    const pi = fakePi();
    createChannelExtension({ config, log: (line) => logs.push(line) })(pi.api);
    pi.notify({ ...messageEvent("m1"), server: "other" });
    pi.notify({
      ...messageEvent("m2"),
      params: { type: "message", conversationId: "c1", messageId: "m2", sender: "a", text: "" },
    });
    await flush();
    assert.equal(pi.sent.length, 0);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.includes("text"), true);
  });

  it("logs a prompt the session refused", async () => {
    const logs: string[] = [];
    const pi = fakePi("reject");
    createChannelExtension({ config, log: (line) => logs.push(line) })(pi.api);
    pi.notify(messageEvent("m1"));
    await flush();
    await flush();
    assert.equal(logs.includes("MCP channel event not admitted: rejected"), true);
    assert.equal(
      logs.some((line) => line.includes("text m1")),
      false,
      "logs never contain message text",
    );
  });
});

describe("reply tool", () => {
  it("is registered with a strict schema", () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    const tool = pi.tool(REPLY_TOOL_NAME);
    assert.deepEqual(tool.parameters.required, ["messageId", "text"]);
    assert.equal(tool.parameters.additionalProperties, false);
  });

  it("refuses a messageId that was not delivered in this session", async () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    const result = await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t1", { messageId: "x", text: "y" }, undefined, undefined, fakeContext());
    assert.equal(result.content[0]?.text, "Reply not sent: unknown messageId.");
  });

  it("rejects invalid arguments before doing anything", async () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    const result = await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t2", { messageId: "x", text: "" }, undefined, undefined, fakeContext());
    assert.match(result.content[0]?.text ?? "", /^Reply rejected: text must be/);
  });

  it("posts the reply through the adapter, bound to the messageId", async () => {
    const pi = fakePi();
    const adapter = scriptedAdapter([delivery("d1", "m1")]);
    const stop = new AbortController();
    createChannelExtension({ config, adapter })(pi.api);
    await flush();
    pi.notify(messageEvent("m1"));
    const result = await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t3", { messageId: "m1", text: "answer" }, undefined, undefined, fakeContext());
    stop.abort();
    assert.equal(result.content[0]?.text, "Reply sent.");
    assert.equal(adapter.replies[0]?.replyTo, "m1");
    assert.equal(adapter.replies[0]?.text, "answer");
  });

  it("reports that replies are not configured when there is no adapter", async () => {
    const pi = fakePi();
    createChannelExtension({ config })(pi.api);
    pi.notify(messageEvent("m1"));
    await flush();
    const result = await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t4", { messageId: "m1", text: "x" }, undefined, undefined, fakeContext());
    assert.equal(result.content[0]?.text, "Reply not sent: replies are not configured.");
  });
});

describe("adapter receive loop", () => {
  it("acknowledges a delivery only after the agent admitted it", async () => {
    const pi = fakePi();
    const adapter = scriptedAdapter([delivery("d1", "m1"), delivery("d2", "m2")]);
    createChannelExtension({ config, adapter })(pi.api);
    await flush();
    await flush();
    assert.equal(pi.sent.length, 2);
    assert.deepEqual(adapter.acks, ["d1", "d2"]);
    pi.lifecycle("session_shutdown");
  });

  it("does not acknowledge a refused delivery, so the service delivers it again", async () => {
    const pi = fakePi();
    const other: Delivery = {
      deliveryId: "d2",
      event: { type: "message", conversationId: "c2", messageId: "m2", sender: "a", text: "t" },
    };
    const adapter = scriptedAdapter([delivery("d1", "m1"), other]);
    createChannelExtension({ config, adapter })(pi.api);
    await flush();
    await flush();
    // c2 is refused while c1 is open: it is neither admitted nor acknowledged.
    assert.deepEqual(adapter.acks, ["d1"]);
    assert.equal(pi.sent.length, 1);
    pi.lifecycle("session_shutdown");
  });

  it("reports agent state for the open conversation", async () => {
    const pi = fakePi();
    const adapter = scriptedAdapter([delivery("d1", "m1")]);
    createChannelExtension({ config, adapter })(pi.api);
    await flush();
    pi.lifecycle("agent_start");
    pi.lifecycle("agent_end");
    await flush();
    assert.deepEqual(
      adapter.statuses.map((item) => [item.conversationId, item.status]),
      [
        ["c1", "working"],
        ["c1", "free"],
      ],
    );
    pi.lifecycle("session_shutdown");
  });

  it("stops the loop on session shutdown", async () => {
    const pi = fakePi();
    let finished = false;
    const adapter: ChannelAdapter = {
      async *receive(signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        finished = true;
      },
      reply: async () => undefined,
    };
    createChannelExtension({ config, adapter })(pi.api);
    pi.lifecycle("session_shutdown");
    await flush();
    assert.equal(finished, true);
  });
});
