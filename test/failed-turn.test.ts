import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelAdapter } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import {
  ANSWERED_LATER_TEXT,
  CLOSED_REASON,
  SWITCHED_REASON,
  UNDELIVERED_REASON,
} from "../src/dispatcher.js";
import { createChannelExtension, REPLY_TOOL_NAME } from "../src/extension.js";
import type { OutboundFailure, OutboundReply, OutboundStatus } from "../src/protocol.js";
import { NO_REPLY_REASON, STOPPED_REASON } from "../src/turn.js";
import { fakeContext, fakePi, flush } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });
const noText = { ...config, replies: { fromFinalText: false } };

/** An adapter that yields the given messages and records what it is told. */
function adapterWith(
  options: { refuse?: number; refuseReplies?: number; hook?: boolean; messages?: string[] } = {},
) {
  const failures: OutboundFailure[] = [];
  const replies: OutboundReply[] = [];
  const statuses: OutboundStatus[] = [];
  let refusals = options.refuse ?? 0;
  let refusedReplies = options.refuseReplies ?? 0;
  const adapter: ChannelAdapter = {
    async *receive(signal) {
      for (const messageId of options.messages ?? ["m1"]) {
        yield {
          deliveryId: `d-${messageId}`,
          event: {
            type: "message",
            conversationId: "c1",
            messageId,
            sender: "ann",
            attribution: "user",
            text: "hello",
          },
        };
      }
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
    reply: async (reply) => {
      if (refusedReplies > 0) {
        refusedReplies -= 1;
        throw new Error("refused");
      }
      replies.push(reply);
    },
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
  return { adapter, failures, replies, statuses };
}

const SECRET_ERROR = "404 not loaded, key sk-abc123def456ghi789";

async function start(adapter: ChannelAdapter, settings = config) {
  const logs: string[] = [];
  const pi = fakePi();
  createChannelExtension({
    config: settings,
    adapter,
    log: (line) => logs.push(line),
    wait: async () => undefined,
  })(pi.api);
  await flush();
  await flush();
  const asked = () =>
    pi.sent.map((prompt) => ({
      role: "user",
      content: [{ type: "text", text: prompt.content }],
    }));
  /** Ends a run the way Oh My Pi does, with the messages the extension sent in the transcript. */
  const end = async (
    stopReason: string,
    extra: { willContinue?: boolean; awaitingAsyncWork?: boolean } = {},
    text = "",
  ) => {
    pi.lifecycle("agent_end", fakeContext(), {
      ...extra,
      messages: [
        ...asked(),
        {
          role: "assistant",
          stopReason,
          content: text === "" ? [] : [{ type: "text", text }],
          ...(stopReason === "error" ? { errorMessage: SECRET_ERROR } : {}),
        },
      ],
    });
    await flush();
    await flush();
  };
  const answer = (messageId: string, text = "done") =>
    pi
      .tool(REPLY_TOOL_NAME)
      .execute("t1", { messageId, text }, undefined, undefined, fakeContext());
  return { pi, logs, end, answer };
}

describe("the reply tool", () => {
  it("is always among the tools sent to the model", async () => {
    const { pi } = await start(adapterWith().adapter);
    // Oh My Pi leaves an extension tool out of the model's tools unless it says it is essential.
    assert.equal(pi.tool(REPLY_TOOL_NAME).loadMode, "essential");
  });
});

describe("a run that ends without the reply tool", () => {
  it("sends the final text of the model as the reply, with secrets hidden", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("stop", {}, "I restarted it.\nThe key was sk-abc123def456ghi789");
    await end("stop", {}, "again");
    assert.deepEqual(
      service.replies.map((reply) => [reply.replyTo, reply.text]),
      [["m1", "I restarted it.\nThe key was [hidden]"]],
    );
    assert.deepEqual(service.failures, []);
    assert.equal(service.statuses.at(-1)?.status, "free");
  });

  it("cuts a final text longer than the limit", async () => {
    const service = adapterWith();
    const settings = { ...config, limits: { ...config.limits, maxTextLength: 10 } };
    const { end } = await start(service.adapter, settings);
    await end("length", {}, "abcdefghijklmnop");
    assert.equal(service.replies[0]?.text, "abcdefghi…");
  });

  it("reports the message when the model wrote no text", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("stop");
    assert.deepEqual(service.replies, []);
    assert.equal(service.failures[0]?.reason, NO_REPLY_REASON);
  });

  it("reports the message, without the text, when sending it is turned off", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter, noText);
    await end("stop", {}, "stays here");
    assert.deepEqual(service.replies, []);
    assert.equal(service.failures[0]?.reason, NO_REPLY_REASON);
  });

  it("sends nothing when the model used the reply tool", async () => {
    const service = adapterWith();
    const { end, answer } = await start(service.adapter);
    await answer("m1");
    await end("stop", {}, "Reply sent.");
    assert.equal(service.replies.length, 1);
    assert.deepEqual(service.failures, []);
  });

  it("waits while background work will continue the run", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("stop", { awaitingAsyncWork: true }, "Working on it");
    assert.deepEqual(service.replies, []);
    assert.deepEqual(service.failures, []);
  });

  it("tries a refused reply again", async () => {
    const service = adapterWith({ refuseReplies: 2 });
    const { end } = await start(service.adapter);
    await end("stop", {}, "answer");
    assert.equal(service.replies[0]?.text, "answer");
    assert.deepEqual(service.failures, []);
  });

  it("says the answer could not be delivered when every attempt is refused", async () => {
    const service = adapterWith({ refuseReplies: 3 });
    const { logs, end } = await start(service.adapter);
    await end("stop", {}, "answer");
    assert.equal(service.failures[0]?.reason, UNDELIVERED_REASON);
    assert.match(logs.join("\n"), /an answer could not be delivered/);
  });

  it("gives the text to the newest message and a note to the older ones", async () => {
    const service = adapterWith({ messages: ["m1", "m2"] });
    const { end } = await start(service.adapter);
    await end("stop", {}, "both done");
    assert.deepEqual(
      service.replies.map((reply) => [reply.replyTo, reply.text]),
      [
        ["m2", "both done"],
        ["m1", ANSWERED_LATER_TEXT],
      ],
    );
  });

  it("closes an older message with a note when the model answered the newer one", async () => {
    const service = adapterWith({ messages: ["m1", "m2"] });
    const { end, answer } = await start(service.adapter);
    await answer("m2", "here");
    await end("stop", {}, "Reply sent.");
    assert.deepEqual(
      service.replies.map((reply) => [reply.replyTo, reply.text]),
      [
        ["m2", "here"],
        ["m1", ANSWERED_LATER_TEXT],
      ],
    );
  });
});

describe("a turn that ends in an error or is stopped", () => {
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

  it("reports a stopped turn", async () => {
    const service = adapterWith();
    const { end } = await start(service.adapter);
    await end("aborted", {}, "half an ans");
    assert.deepEqual(service.replies, []);
    assert.equal(service.failures[0]?.reason, STOPPED_REASON);
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
    const { end, answer } = await start(service.adapter);
    await answer("m1");
    await end("error");
    assert.deepEqual(service.failures, []);
  });

  it("still accepts a reply after the report", async () => {
    const service = adapterWith();
    const { end, answer } = await start(service.adapter);
    await end("error");
    const result = await answer("m1", "late");
    assert.deepEqual(result.content[0], { type: "text", text: "Reply sent." });
  });

  it("tries a refused report again, and once more at the next end", async () => {
    const service = adapterWith({ refuse: 3 });
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

describe("a session that goes away", () => {
  for (const [event, reason] of [
    ["session_shutdown", CLOSED_REASON],
    ["session_switch", SWITCHED_REASON],
  ] as const) {
    it(`reports the open messages on ${event}`, async () => {
      const service = adapterWith();
      const { pi } = await start(service.adapter);
      pi.lifecycle(event);
      await flush();
      assert.equal(service.failures[0]?.reason, reason);
    });
  }

  it("reports nothing when every message has its reply", async () => {
    const service = adapterWith();
    const { pi, answer } = await start(service.adapter);
    await answer("m1");
    pi.lifecycle("session_shutdown");
    await flush();
    assert.deepEqual(service.failures, []);
  });
});
