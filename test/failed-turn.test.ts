import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelAdapter } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import { createChannelExtension, REPLY_TOOL_NAME } from "../src/extension.js";
import type { OutboundFailure, OutboundStatus } from "../src/protocol.js";
import { fakeContext, fakePi, flush } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });

/** An adapter that yields one message and records what it is told. */
function adapterWith(options: { refuse?: number; hook?: boolean } = {}) {
  const failures: OutboundFailure[] = [];
  const statuses: OutboundStatus[] = [];
  let refusals = options.refuse ?? 0;
  const adapter: ChannelAdapter = {
    async *receive(signal) {
      yield {
        deliveryId: "d1",
        event: {
          type: "message",
          conversationId: "c1",
          messageId: "m1",
          sender: "ann",
          attribution: "user",
          text: "hello",
        },
      };
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    reply: async () => undefined,
    status: async (status) => {
      statuses.push(status);
    },
    ...(options.hook === false
      ? {}
      : {
          failure: async (failure: OutboundFailure) => {
            if (refusals > 0) {
              refusals -= 1;
              throw new Error("refused");
            }
            failures.push(failure);
          },
        }),
  };
  return { adapter, failures, statuses };
}

async function start(adapter: ChannelAdapter, settings = config) {
  const logs: string[] = [];
  const pi = fakePi();
  createChannelExtension({ config: settings, adapter, log: (line) => logs.push(line) })(pi.api);
  await flush();
  assert.equal(pi.sent.length, 1);
  /** Ends a run the way Oh My Pi does, with the message the extension sent in the transcript. */
  const end = async (stopReason: string, extra: { willContinue?: boolean } = {}) => {
    pi.lifecycle("agent_end", fakeContext(), {
      ...extra,
      messages: [
        { role: "user", content: [{ type: "text", text: pi.sent[0]?.content }] },
        {
          role: "assistant",
          stopReason,
          content: [],
          errorMessage: "404 not loaded, key sk-abc123def456ghi789",
        },
      ],
    });
    await flush();
  };
  return { pi, logs, end };
}

describe("a turn that ends in an error", () => {
  it("reports the unanswered message once, with the secret hidden, and frees the state", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("error");
    await end("error");
    assert.equal(service.failures.length, 1);
    const [failure] = service.failures;
    assert.equal(failure?.replyTo, "m1");
    assert.equal(failure?.conversationId, "c1");
    assert.equal(failure?.reason, "404 not loaded, key [hidden]");
    assert.equal(service.statuses.at(-1)?.status, "free");
  });

  it("stays working and reports nothing while Oh My Pi retries", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("error", { willContinue: true });
    assert.deepEqual(service.failures, []);
    assert.equal(
      service.statuses.some((status) => status.status === "free"),
      false,
    );
  });

  it("reports nothing for a message that already has its reply", async () => {
    const service = adapterWith();
    const { pi, end } = await start(service.adapter);
    await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t1", { messageId: "m1", text: "done" }, undefined, undefined, fakeContext());
    await end("error");
    assert.deepEqual(service.failures, []);
  });

  it("still accepts a reply after the report", async () => {
    const service = adapterWith();
    const { pi, end } = await start(service.adapter);
    await end("error");
    const result = await pi
      .tool(REPLY_TOOL_NAME)
      .execute("t1", { messageId: "m1", text: "late" }, undefined, undefined, fakeContext());
    assert.deepEqual(result.content[0], { type: "text", text: "Reply sent." });
  });

  it("tries again at the next failure when the service refused the report", async () => {
    const service = adapterWith({ refuse: 1 });
    const { logs, end } = await start(service.adapter);
    await end("error");
    assert.deepEqual(service.failures, []);
    assert.match(logs.join("\n"), /failure was not reported \(Error\)/);
    await end("error");
    assert.equal(service.failures.length, 1);
  });

  it("keeps the error text on the machine when it is turned off", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter, { ...config, failures: { includeReason: false } });
    await end("error");
    assert.equal(service.failures.length, 1);
    assert.equal("reason" in (service.failures[0] ?? {}), false);
  });

  it("only logs when the adapter cannot report failures", async () => {
    const service = adapterWith({ hook: false });
    const { logs, end } = await start(service.adapter);
    await end("error");
    assert.match(logs.join("\n"), /does not report failures/);
  });
});
