import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelAdapter, Delivery } from "../src/adapter.js";
import { AdapterError } from "../src/adapter.js";
import { loadConfig } from "../src/config.js";
import { createHttpAdapter } from "../src/http-adapter.js";
import { DEFAULT_LIMITS } from "../src/protocol.js";

const SECRET = "key-value-must-not-leak";

function serviceConfig() {
  const config = loadConfig({
    env: { OMP_CHANNEL_KEY: SECRET },
    cwd: "/",
    readText: (path) =>
      path === "/.omp/omp-channel.json"
        ? JSON.stringify({ service: { url: "https://chat.example.com/api" } })
        : undefined,
  });
  if (config.service === undefined) {
    throw new Error("service expected");
  }
  return config;
}

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** Fake service: `responder` returns a Response for each call. */
function fakeService(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapterWith(fetchFn: typeof fetch, logs: string[] = []): ChannelAdapter {
  const config = serviceConfig();
  if (config.service === undefined) {
    throw new Error("service expected");
  }
  return createHttpAdapter({
    service: config.service,
    poll: { intervalMs: 100, maxBackoffMs: 1000, batchSize: 5 },
    limits: DEFAULT_LIMITS,
    log: (line) => logs.push(line),
    fetch: fetchFn,
  });
}

const validEvent = {
  type: "message",
  conversationId: "c1",
  messageId: "m1",
  sender: "ann",
  text: "hi",
};

async function collect(adapter: ChannelAdapter, count: number): Promise<Delivery[]> {
  const controller = new AbortController();
  const received: Delivery[] = [];
  for await (const delivery of adapter.receive(controller.signal)) {
    received.push(delivery);
    if (received.length === count) {
      controller.abort();
      break;
    }
  }
  return received;
}

describe("HTTP transport", () => {
  it("polls with the bearer key and yields deliveries in order", async () => {
    const service = fakeService(() =>
      json({
        deliveries: [
          { deliveryId: "d1", leaseExpiresAt: "2026-11-26T10:00:30Z", event: validEvent },
          {
            deliveryId: "d2",
            leaseExpiresAt: "2026-11-26T10:00:30Z",
            event: { ...validEvent, messageId: "m2" },
          },
        ],
      }),
    );
    const adapter = adapterWith(service.fetchFn);
    const delivered = await collect(adapter, 2);
    assert.deepEqual(
      delivered.map((item) => [
        item.deliveryId,
        item.event.type === "message" && item.event.messageId,
      ]),
      [
        ["d1", "m1"],
        ["d2", "m2"],
      ],
    );
    const poll = service.calls[0];
    assert.equal(poll?.method, "GET");
    assert.equal(poll?.url, "https://chat.example.com/api/messages?limit=5");
    assert.equal(poll?.headers.authorization, `Bearer ${SECRET}`);
  });

  it("acknowledges a delivery with its id", async () => {
    const service = fakeService(() => new Response(null, { status: 204 }));
    const adapter = adapterWith(service.fetchFn);
    await adapter.ack?.("d1");
    assert.equal(service.calls[0]?.url, "https://chat.example.com/api/messages/ack");
    assert.deepEqual(service.calls[0]?.body, { deliveryIds: ["d1"] });
  });

  it("discards an invalid delivery after acknowledging it, so it cannot block the queue", async () => {
    const logs: string[] = [];
    const service = fakeService((call) => {
      if (call.url.endsWith("/messages/ack")) {
        return new Response(null, { status: 204 });
      }
      return json({
        deliveries: [
          {
            deliveryId: "bad",
            leaseExpiresAt: "2026-11-26T10:00:30Z",
            event: { type: "message", text: "" },
          },
          { deliveryId: "good", leaseExpiresAt: "2026-11-26T10:00:30Z", event: validEvent },
        ],
      });
    });
    const delivered = await collect(adapterWith(service.fetchFn, logs), 1);
    assert.deepEqual(
      delivered.map((item) => item.deliveryId),
      ["good"],
    );
    assert.deepEqual(
      service.calls.filter((call) => call.url.endsWith("/ack")).map((call) => call.body),
      [{ deliveryIds: ["bad"] }],
    );
    assert.equal(
      logs.some((line) => line.includes("bad")),
      true,
    );
    assert.equal(
      logs.some((line) => line.includes("Bearer")),
      false,
    );
  });

  it("posts replies and statuses to their paths", async () => {
    const service = fakeService(() => new Response(null, { status: 200 }));
    const adapter = adapterWith(service.fetchFn);
    await adapter.reply({
      type: "reply",
      conversationId: "c1",
      messageId: "r1",
      replyTo: "m1",
      text: "answer",
      at: "2026-11-26T10:00:00.000Z",
    });
    await adapter.status?.({
      type: "status",
      conversationId: "c1",
      status: "free",
      at: "2026-11-26T10:00:00.000Z",
    });
    assert.equal(service.calls[0]?.url, "https://chat.example.com/api/replies");
    assert.equal(service.calls[1]?.url, "https://chat.example.com/api/status");
    assert.equal(((service.calls[0]?.body ?? {}) as { replyTo: string }).replyTo, "m1");
  });

  it("reports HTTP failures by status only, without the key or the body", async () => {
    const service = fakeService(() => new Response(`echo ${SECRET}`, { status: 503 }));
    const adapter = adapterWith(service.fetchFn);
    const error = await adapter
      .reply({
        type: "reply",
        conversationId: "c1",
        messageId: "r1",
        replyTo: "m1",
        text: "x",
        at: "2026-11-26T10:00:00.000Z",
      })
      .catch((reason: unknown) => reason);
    assert.ok(error instanceof AdapterError);
    assert.equal(error.message, "the service answered with HTTP 503");
    assert.equal(error.message.includes(SECRET), false);
  });

  it("reports a timeout as a plain message", async () => {
    const service = fakeService(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    const adapter = adapterWith(service.fetchFn);
    const error = await adapter.ack?.("d1").catch((reason: unknown) => reason);
    assert.ok(error instanceof AdapterError);
    assert.equal(error.message, "the request failed (TimeoutError)");
  });

  it("backs off after an unexpected response instead of yielding", async () => {
    const service = fakeService(() => json({ unexpected: true }));
    const adapter = adapterWith(service.fetchFn);
    const controller = new AbortController();
    const received: Delivery[] = [];
    const timer = setTimeout(() => controller.abort(), 250);
    for await (const delivery of adapter.receive(controller.signal)) {
      received.push(delivery);
    }
    clearTimeout(timer);
    assert.equal(received.length, 0);
    assert.ok(service.calls.length >= 2, "the poll is retried after a back-off");
  });
});
