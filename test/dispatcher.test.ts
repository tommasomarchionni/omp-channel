import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelAdapter } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import { Dispatcher, type SessionPort } from "../src/dispatcher.js";
import type { SendUserMessageOptions } from "../src/omp-api.js";
import type { InboundEvent, OutboundReply, OutboundStatus } from "../src/protocol.js";
import { flush } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });

function fakeSession(options: { idle?: boolean; reject?: boolean; delayMs?: number } = {}) {
  const sent: { content: string; options: SendUserMessageOptions }[] = [];
  let aborts = 0;
  const session: SessionPort = {
    async send(content, sendOptions) {
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.reject) {
        throw Object.assign(new Error("dropped"), { name: "PromptDroppedError" });
      }
      sent.push({ content, options: sendOptions });
    },
    abort: () => {
      aborts += 1;
    },
    isIdle: () => options.idle ?? true,
  };
  return { session, sent, aborts: () => aborts };
}

function fakeAdapter() {
  const replies: OutboundReply[] = [];
  const statuses: OutboundStatus[] = [];
  const interrupts: string[] = [];
  const closes: string[] = [];
  const adapter: ChannelAdapter = {
    receive: async function* () {},
    reply: async (reply) => {
      replies.push(reply);
    },
    status: async (status) => {
      statuses.push(status);
    },
    interrupt: async (conversationId) => {
      interrupts.push(conversationId);
    },
    close: async (conversationId) => {
      closes.push(conversationId);
    },
  };
  return { adapter, replies, statuses, interrupts, closes };
}

const message = (
  conversationId: string,
  messageId: string,
  extra: Partial<InboundEvent> = {},
): InboundEvent =>
  ({
    type: "message",
    conversationId,
    messageId,
    sender: "ann",
    text: `text ${messageId}`,
    ...extra,
  }) as InboundEvent;

function setup(sessionOptions = {}, withAdapter = true) {
  const session = fakeSession(sessionOptions);
  const adapter = fakeAdapter();
  const logs: string[] = [];
  const dispatcher = new Dispatcher({
    config,
    session: session.session,
    adapter: withAdapter ? adapter.adapter : undefined,
    log: (line) => logs.push(line),
    now: () => new Date("2026-11-26T10:00:00Z"),
    newId: () => "reply-1",
  });
  return { dispatcher, ...session, ...adapter, logs };
}

describe("Dispatcher", () => {
  it("admits a message as a follow-up with the configured attribution", async () => {
    const env = setup();
    assert.equal(await env.dispatcher.submit(message("c1", "m1")), "admitted");
    assert.equal(env.sent.length, 1);
    assert.deepEqual(env.sent[0]?.options, { deliverAs: "followUp", attribution: "agent" });
    assert.equal(env.dispatcher.activeConversation, "c1");
  });

  it("uses the attribution set by the service when present", async () => {
    const env = setup();
    await env.dispatcher.submit(message("c1", "m1", { attribution: "user" }));
    assert.equal(env.sent[0]?.options.attribution, "user");
  });

  it("delivers a message only once, by messageId", async () => {
    const env = setup();
    await env.dispatcher.submit(message("c1", "m1"));
    assert.equal(await env.dispatcher.submit(message("c1", "m1")), "duplicate");
    assert.equal(env.sent.length, 1);
  });

  it("keeps one open conversation: other conversations are refused until it closes", async () => {
    const env = setup();
    await env.dispatcher.submit(message("c1", "m1"));
    assert.equal(await env.dispatcher.submit(message("c2", "m2")), "refused");
    await env.dispatcher.submit({ type: "close", conversationId: "c1" });
    assert.equal(env.dispatcher.activeConversation, undefined);
    assert.equal(await env.dispatcher.submit(message("c2", "m3")), "admitted");
    assert.equal(env.closes[0], "c1");
  });

  it("keeps the order of events, even when admission is slow", async () => {
    const env = setup({ delayMs: 5 });
    const outcomes = await Promise.all([
      env.dispatcher.submit(message("c1", "a")),
      env.dispatcher.submit(message("c1", "b")),
      env.dispatcher.submit(message("c1", "c")),
    ]);
    assert.deepEqual(outcomes, ["admitted", "admitted", "admitted"]);
    assert.deepEqual(
      env.sent.map((item) => /messageId: (\S+?)\)/.exec(item.content)?.[1]),
      ["a", "b", "c"],
    );
  });

  it("drops events beyond maxPending instead of queueing without bound", async () => {
    const env = setup({ delayMs: 20 });
    const limited = new Dispatcher({
      config: loadConfig({
        env: { OMP_CHANNEL_CONFIG: "/c.json" },
        cwd: "/",
        readText: () => JSON.stringify({ limits: { maxPending: 1 } }),
      }),
      session: env.session,
      adapter: undefined,
      log: () => undefined,
    });
    const first = limited.submit(message("c1", "a"));
    assert.equal(await limited.submit(message("c1", "b")), "dropped");
    assert.equal(await first, "admitted");
  });

  it("does not remember a rejected message, so a redelivery can be admitted", async () => {
    const env = setup({ reject: true });
    assert.equal(await env.dispatcher.submit(message("c1", "m1")), "rejected");
    assert.equal(env.logs.length, 1);
    assert.equal(env.logs[0]?.includes("text m1"), false, "logs never contain message text");
  });

  it("interrupt aborts only a busy agent and only for the open conversation", async () => {
    const busy = setup({ idle: false });
    await busy.dispatcher.submit(message("c1", "m1"));
    assert.equal(
      await busy.dispatcher.submit({ type: "interrupt", conversationId: "c9" }),
      "ignored",
    );
    assert.equal(busy.aborts(), 0);
    assert.equal(
      await busy.dispatcher.submit({ type: "interrupt", conversationId: "c1" }),
      "admitted",
    );
    assert.equal(busy.aborts(), 1);
    assert.deepEqual(busy.interrupts, ["c1"]);

    const idle = setup({ idle: true });
    await idle.dispatcher.submit(message("c1", "m1"));
    await idle.dispatcher.submit({ type: "interrupt", conversationId: "c1" });
    assert.equal(idle.aborts(), 0, "an idle agent is not aborted");
  });

  it("applies a redelivered interrupt only once, by deliveryId", async () => {
    const env = setup({ idle: false });
    await env.dispatcher.submit(message("c1", "m1"));
    await env.dispatcher.submit({ type: "interrupt", conversationId: "c1" }, "d-1");
    assert.equal(
      await env.dispatcher.submit({ type: "interrupt", conversationId: "c1" }, "d-1"),
      "duplicate",
    );
    assert.equal(env.aborts(), 1);
  });

  it("reports status for the open conversation only", async () => {
    const env = setup();
    env.dispatcher.setStatus("working");
    assert.equal(env.statuses.length, 0, "no conversation is open yet");
    await env.dispatcher.submit(message("c1", "m1"));
    env.dispatcher.setStatus("working");
    env.dispatcher.setStatus("free");
    await flush();
    assert.deepEqual(
      env.statuses.map((item) => [item.conversationId, item.status]),
      [
        ["c1", "working"],
        ["c1", "free"],
      ],
    );
  });

  it("replies only to a messageId it delivered, bound to its conversation", async () => {
    const env = setup();
    await env.dispatcher.submit(message("c1", "m1"));
    assert.deepEqual(await env.dispatcher.reply("unknown", "x"), {
      ok: false,
      reason: "unknown messageId",
    });
    assert.deepEqual(await env.dispatcher.reply("m1", "answer"), { ok: true });
    assert.deepEqual(env.replies[0], {
      type: "reply",
      conversationId: "c1",
      messageId: "reply-1",
      replyTo: "m1",
      text: "answer",
      at: "2026-11-26T10:00:00.000Z",
    });
  });

  it("reports when replies are not configured, without any call to a service", async () => {
    const env = setup({}, false);
    await env.dispatcher.submit(message("c1", "m1"));
    assert.deepEqual(await env.dispatcher.reply("m1", "x"), {
      ok: false,
      reason: "replies are not configured",
    });
  });

  it("does not expose adapter internals when a reply fails", async () => {
    const env = setup();
    const failing: ChannelAdapter = {
      receive: async function* () {},
      reply: async () => {
        throw new Error("Bearer secret-value leaked");
      },
    };
    const dispatcher = new Dispatcher({
      config,
      session: env.session,
      adapter: failing,
      log: () => undefined,
    });
    await dispatcher.submit(message("c1", "m1"));
    const result = await dispatcher.reply("m1", "x");
    assert.deepEqual(result, {
      ok: false,
      reason: "the service did not accept the reply: the request failed (Error)",
    });
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  });
});
