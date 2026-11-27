import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { MAX_ACTIVITIES_PER_MESSAGE, MAX_WAITING_REPORTS } from "../src/activity.js";
import type { ChannelAdapter } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import { createChannelExtension, REPLY_TOOL_NAME } from "../src/extension.js";
import { createHttpAdapter } from "../src/http-adapter.js";
import type { OutboundActivity } from "../src/protocol.js";
import { activityText, MAX_ACTIVITY_LENGTH } from "../src/redact.js";
import { fakeContext, fakePi, flush } from "./helpers.js";

const config = loadConfig({ env: {}, cwd: "/", readText: () => undefined });

const schema = JSON.parse(
  readFileSync(new URL("../schema/activity.schema.json", import.meta.url), "utf8"),
) as object;
const validateActivity = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** An adapter that yields the given messages and records the reports and replies, in order. */
function adapterWith(
  options: { messages?: string[]; hook?: boolean; send?: () => Promise<void> } = {},
) {
  const activities: OutboundActivity[] = [];
  const calls: string[] = [];
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
      calls.push(`reply ${reply.replyTo}`);
    },
    failure: async (failure) => {
      calls.push(`failure ${failure.replyTo}`);
    },
    ...(options.hook === false
      ? {}
      : {
          activity: async (activity: OutboundActivity) => {
            await options.send?.();
            activities.push(activity);
            calls.push(`activity ${activity.replyTo} ${activity.state}`);
          },
        }),
  };
  return { adapter, activities, calls };
}

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
  /** The agent takes the prompt the extension sent for a message, as Oh My Pi announces it. */
  const take = (index = 0) =>
    pi.lifecycle("message_start", fakeContext(), {
      message: { role: "user", content: [{ type: "text", text: pi.sent[index]?.content }] },
    });
  const begin = (toolCallId: string, toolName: string, intent?: string, args: unknown = {}) =>
    pi.lifecycle("tool_execution_start", fakeContext(), {
      toolCallId,
      toolName,
      args,
      ...(intent === undefined ? {} : { intent }),
    });
  const end = (toolCallId: string, toolName: string, isError = false) =>
    pi.lifecycle("tool_execution_end", fakeContext(), {
      toolCallId,
      toolName,
      result: { content: [{ type: "text", text: "TOOL-OUTPUT-NEVER-SENT" }] },
      isError,
    });
  const answer = (messageId = "m1") =>
    pi
      .tool(REPLY_TOOL_NAME)
      .execute("reply-call", { messageId, text: "done" }, undefined, undefined, fakeContext());
  return { pi, logs, take, begin, end, answer };
}

const settleAll = async () => {
  for (let i = 0; i < 5; i += 1) await flush();
};

describe("activity reports", () => {
  it("report each tool of a message as running and then done or failed", async () => {
    const { adapter, activities } = adapterWith();
    const { take, begin, end } = await start(adapter);
    take();
    begin("call-1", "read", "Reading the log");
    end("call-1", "read");
    begin("call-2", "bash", "Running the tests");
    end("call-2", "bash", true);
    await settleAll();
    assert.deepEqual(
      activities.map((a) => [a.state, a.text, a.replyTo, a.conversationId]),
      [
        ["running", "read: Reading the log", "m1", "c1"],
        ["done", "read: Reading the log", "m1", "c1"],
        ["running", "bash: Running the tests", "m1", "c1"],
        ["failed", "bash: Running the tests", "m1", "c1"],
      ],
    );
    assert.equal(activities[0]?.activityId, activities[1]?.activityId);
    assert.notEqual(activities[0]?.activityId, activities[2]?.activityId);
    assert.equal(new Set(activities.map((a) => a.messageId)).size, 4);
    for (const activity of activities) {
      assert.equal(validateActivity(activity), true, JSON.stringify(validateActivity.errors));
    }
  });

  it("send the tool name and the intent only, never arguments or results", async () => {
    const { adapter, activities } = adapterWith();
    const { take, begin, end } = await start(adapter);
    take();
    begin("call-1", "bash", undefined, { command: "cat /etc/hosts" });
    end("call-1", "bash");
    await settleAll();
    assert.deepEqual(
      activities.map((a) => a.text),
      ["bash", "bash"],
    );
    assert.doesNotMatch(JSON.stringify(activities), /etc\/hosts|TOOL-OUTPUT/);
  });

  it("leave out the reply tool, which is the answer itself", async () => {
    const { adapter, activities } = adapterWith();
    const { take, begin, end } = await start(adapter);
    take();
    begin("call-1", REPLY_TOOL_NAME, "Answering");
    end("call-1", REPLY_TOOL_NAME);
    await settleAll();
    assert.equal(activities.length, 0);
  });

  it("reach the service before the reply that follows them", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, calls } = adapterWith({ send: () => gate });
    const { take, begin, end, answer } = await start(adapter);
    take();
    begin("call-1", "read");
    end("call-1", "read");
    const answered = answer();
    await settleAll();
    assert.deepEqual(calls, []);
    release();
    await answered;
    assert.deepEqual(calls, ["activity m1 running", "activity m1 done", "reply m1"]);
  });

  it("do not hold a reply behind a report that never settles", async () => {
    const { adapter, calls } = adapterWith({ send: () => new Promise<void>(() => undefined) });
    const { take, begin, answer } = await start(adapter);
    take();
    begin("call-1", "read");
    await answer();
    assert.deepEqual(calls, ["reply m1"]);
  });

  it("stop once the message has its reply", async () => {
    const { adapter, activities } = adapterWith();
    const { take, begin, end, answer } = await start(adapter);
    take();
    begin("call-1", "read");
    await answer();
    end("call-1", "read");
    begin("call-2", "bash");
    await settleAll();
    assert.deepEqual(
      activities.map((a) => a.state),
      ["running"],
    );
  });

  it("go to the newest message the agent has taken", async () => {
    const { adapter, activities } = adapterWith({ messages: ["m1", "m2"] });
    const { take, begin, answer } = await start(adapter);
    take(0);
    begin("call-1", "read");
    take(1);
    begin("call-2", "read");
    await answer("m2");
    begin("call-3", "read");
    await settleAll();
    assert.deepEqual(
      activities.map((a) => a.replyTo),
      ["m1", "m2", "m1"],
    );
  });

  it("say nothing about work for a prompt typed at the terminal", async () => {
    const { adapter, activities } = adapterWith();
    const { pi, take, begin } = await start(adapter);
    take();
    pi.lifecycle("message_start", fakeContext(), {
      message: { role: "user", content: "a private question" },
    });
    begin("call-1", "bash", "Looking at private files");
    await settleAll();
    assert.equal(activities.length, 0);
  });

  it("keep the message across notes the agent adds for itself", async () => {
    const { adapter, activities } = adapterWith();
    const { pi, take, begin } = await start(adapter);
    take();
    for (const message of [
      { role: "developer", content: "a reminder" },
      { role: "user", synthetic: true, content: "continue" },
      { role: "assistant", content: [] },
      null,
    ]) {
      pi.lifecycle("message_start", fakeContext(), { message });
    }
    begin("call-1", "read");
    await settleAll();
    assert.equal(activities.length, 1);
  });

  it("say nothing before the agent takes a message", async () => {
    const { adapter, activities } = adapterWith();
    const { begin } = await start(adapter);
    begin("call-1", "read");
    await settleAll();
    assert.equal(activities.length, 0);
  });

  it("forget the message when the session is switched", async () => {
    const { adapter, activities } = adapterWith();
    const { pi, take, begin, end } = await start(adapter);
    take();
    begin("call-1", "read");
    pi.lifecycle("session_switch");
    await settleAll();
    end("call-1", "read");
    begin("call-2", "read");
    await settleAll();
    assert.deepEqual(
      activities.map((a) => a.state),
      ["running"],
    );
  });

  it(`stop at ${MAX_ACTIVITIES_PER_MESSAGE} tools for one message`, async () => {
    const { adapter, activities } = adapterWith();
    const { take, begin, end } = await start(adapter);
    take();
    for (let i = 0; i < MAX_ACTIVITIES_PER_MESSAGE + 5; i += 1) {
      begin(`call-${i}`, "read");
      end(`call-${i}`, "read");
      await flush();
    }
    await settleAll();
    assert.equal(activities.length, 2 * MAX_ACTIVITIES_PER_MESSAGE);
  });

  it("drop reports instead of piling them up behind a slow service", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, activities } = adapterWith({ send: () => gate });
    const { logs, take, begin } = await start(adapter);
    take();
    for (let i = 0; i < MAX_WAITING_REPORTS + 20; i += 1) begin(`call-${i}`, "read");
    release();
    for (let i = 0; i < MAX_WAITING_REPORTS * 2; i += 1) await flush();
    assert.equal(activities.length, MAX_WAITING_REPORTS);
    assert.equal(logs.filter((line) => line.includes("activity reports are dropped")).length, 1);
  });

  it("log a refused report once and keep the session going", async () => {
    const { adapter, calls } = adapterWith({
      send: () => Promise.reject(new TypeError("refused with details")),
    });
    const { logs, take, begin, end, answer } = await start(adapter);
    take();
    begin("call-1", "read");
    end("call-1", "read");
    await settleAll();
    await answer();
    assert.deepEqual(calls, ["reply m1"]);
    assert.deepEqual(
      logs.filter((line) => line.includes("activity")),
      ["activity was not reported (TypeError)"],
    );
  });

  it("are off when the configuration says so, and without the hook", async () => {
    const off = { ...config, reports: { activity: false } };
    const configured = await start(adapterWith().adapter, off);
    assert.equal(configured.pi.listensTo("tool_execution_start"), false);
    const without = await start(adapterWith({ hook: false }).adapter);
    assert.equal(without.pi.listensTo("tool_execution_start"), false);
    assert.equal(without.pi.listensTo("message_start"), false);
  });

  it("are on by default", () => {
    assert.deepEqual(config.reports, { activity: true });
    const file = loadConfig({
      env: {},
      cwd: "/",
      readText: () => '{"reports":{"activity":false}}',
    });
    assert.deepEqual(file.reports, { activity: false });
  });
});

describe("the text of an activity", () => {
  const cases: [string, string | undefined, unknown, string][] = [
    ["read", "Reading the log", {}, "read: Reading the log"],
    ["read", undefined, {}, "read"],
    ["read", "  ", {}, "read"],
    ["read", "Two\nlines\there", {}, "read: Two lines here"],
    ["bash", "Running npm test now", { command: "npm test" }, "bash: Running … now"],
    ["bash", "Deploy 42", { command: "Deploy 42" }, "bash"],
    [
      "checkpoint",
      "checkpointing: find the cause",
      { goal: "find the cause" },
      "checkpoint: checkpointing: …",
    ],
    ["edit", "Fixing the test", { input: { lines: ["the test"] } }, "edit: Fixing …"],
    ["read", "Testing the reader", { mode: "test" }, "read: Testing the reader"],
    ["read", "Reading the log", { i: "Reading the log" }, "read: Reading the log"],
    [
      "read",
      "Reading /Users/ann/notes.txt, then ./src/a.ts",
      {},
      "read: Reading [path], then [path]",
    ],
    // A folder with a name and an extension, or two folders, is a path; one slash is not.
    ["read", "Opening docs/a/b (src/main.rs)", {}, "read: Opening [path] ([path])"],
    ["web", "Fetching (https://example.com/a), now", {}, "web: Fetching ([path]), now"],
    ["web", "Fetching https://example.com/a?b=1", {}, "web: Fetching [path]"],
    ["read", "Reading C:\\work\\a.txt and a/b/c", {}, "read: Reading [path] and [path]"],
    ["read", "Compare read/write and TCP/IP", {}, "read: Compare read/write and TCP/IP"],
    ["read", "/etc/hosts", {}, "read"],
  ];

  for (const [toolName, intent, args, expected] of cases) {
    it(`${JSON.stringify(intent)} of ${toolName}`, () => {
      assert.equal(activityText(toolName, intent, args), expected);
    });
  }

  it("hides secrets before it cuts, on one line", () => {
    const text = activityText(
      "bash",
      `Login with token=abcdef123456 ${"word ".repeat(80)}`,
      undefined,
    );
    assert.match(text, /^bash: Login with token=\[hidden\] /);
    assert.equal([...text].length, MAX_ACTIVITY_LENGTH);
    assert.ok(text.endsWith("…"));
  });

  it("does not read arguments far longer than the intent", () => {
    const args = {
      content: "x".repeat(5_000_000),
      list: Array.from({ length: 10_000 }, () => "log"),
    };
    assert.equal(activityText("write", "Saving the log", args), "write: Saving the log");
  });

  it("cleans the tool name too, and never returns an empty text", () => {
    assert.equal(activityText("my\ntool", undefined, null), "my tool");
    assert.equal(activityText("", undefined, null), "tool");
    assert.ok(activityText("x".repeat(300), undefined, null).length <= 80);
  });
});

describe("activity over HTTP", () => {
  const poll = { intervalMs: 100, maxBackoffMs: 1000, batchSize: 1 };
  const paths = {
    messages: "/messages",
    ack: "/messages/ack",
    replies: "/replies",
    status: "/status",
    failures: "/failures",
  };
  const adapterFor = (extra: { activity?: string }, calls: string[]) =>
    createHttpAdapter({
      service: {
        url: new URL("https://chat.example.com/api"),
        key: "k",
        requestTimeoutMs: 1000,
        paths: { ...paths, ...extra },
      },
      poll,
      limits: config.limits,
      log: () => undefined,
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push(`${init.method} ${url.pathname} ${String(init.body)}`);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

  it("has no path by default, so a service sees no new requests", () => {
    const service = loadConfig({
      env: { OMP_CHANNEL_KEY: "k" },
      cwd: "/",
      readText: () => '{"service":{"url":"https://chat.example.com"}}',
    }).service;
    assert.equal(service?.paths.activity, undefined);
    assert.equal(adapterFor({}, []).activity, undefined);
  });

  it("posts the report to the configured path", async () => {
    const calls: string[] = [];
    const report: OutboundActivity = {
      type: "activity",
      conversationId: "c1",
      messageId: "a-1",
      replyTo: "m1",
      activityId: "t-1",
      state: "running",
      text: "read",
      at: "2026-11-26T10:00:00.000Z",
    };
    await adapterFor({ activity: "/activity" }, calls).activity?.(report);
    assert.deepEqual(calls, [`POST /api/activity ${JSON.stringify(report)}`]);
  });
});
