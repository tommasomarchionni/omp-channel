import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import ompChannel from "../src/index.js";
import { fakePi, flush, resultText } from "./helpers.js";

/** Local stand-in for a service: loopback only, no external host is contacted. */
function startService(key: string) {
  const queue = [
    {
      deliveryId: "d1",
      leaseExpiresAt: "2026-11-26T10:00:30Z",
      event: {
        type: "message",
        conversationId: "c1",
        messageId: "m1",
        sender: "ann",
        attribution: "agent",
        text: "Hello agent",
      },
    },
  ];
  const requests: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
  const acked: string[] = [];
  const replies: unknown[] = [];
  const statuses: unknown[] = [];

  const read = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      req.on("end", () => resolve(data.length === 0 ? undefined : JSON.parse(data)));
    });

  const server: Server = createServer((req, res: ServerResponse) => {
    void (async () => {
      const body = req.method === "POST" ? await read(req) : undefined;
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401).end();
        return;
      }
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      };
      if (req.method === "GET" && req.url?.startsWith("/api/messages?")) {
        json({ deliveries: queue.filter((item) => !acked.includes(item.deliveryId)) });
      } else if (req.method === "POST" && req.url === "/api/messages/ack") {
        acked.push(...(body as { deliveryIds: string[] }).deliveryIds);
        json({});
      } else if (req.method === "POST" && req.url === "/api/replies") {
        replies.push(body);
        json({});
      } else if (req.method === "POST" && req.url === "/api/status") {
        statuses.push(body);
        json({});
      } else {
        json({ error: "not found" }, 404);
      }
    })();
  });
  return { server, requests, acked, replies, statuses };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

describe("HTTP transport end to end (loopback service)", () => {
  const key = "loopback-test-key";
  const directory = mkdtempSync(join(tmpdir(), "omp-channel-e2e-"));
  const savedEnv = { ...process.env };
  const service = startService(key);
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", () => resolve()));
    port = (service.server.address() as AddressInfo).port;
    const configPath = join(directory, "omp-channel.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        service: { url: `http://127.0.0.1:${port}/api`, keyEnv: "OMP_CHANNEL_E2E_KEY" },
        poll: { intervalMs: 100, maxBackoffMs: 500, batchSize: 5 },
      }),
    );
    process.env.OMP_CHANNEL_CONFIG = configPath;
    process.env.OMP_CHANNEL_E2E_KEY = key;
  });

  after(async () => {
    process.env = savedEnv;
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  it("delivers, acknowledges, replies and reports status through the real extension", async () => {
    const pi = fakePi();
    await ompChannel(pi.api);
    pi.lifecycle("session_start");
    try {
      await waitFor(() => pi.sent.length === 1, "the message to reach the agent");
      assert.deepEqual(pi.sent[0]?.options, { deliverAs: "followUp", attribution: "agent" });
      await waitFor(() => service.acked.includes("d1"), "the acknowledgement");

      pi.lifecycle("agent_start");
      const result = await pi
        .tool("reply")
        .execute("call-1", { messageId: "m1", text: "Hi there" }, undefined, undefined, {
          hasUI: false,
          isIdle: () => true,
          abort: () => undefined,
        } as unknown as Parameters<ReturnType<typeof pi.tool>["execute"]>[4]);
      assert.equal(resultText(result), "Reply sent.");
      pi.lifecycle("agent_end");
      await waitFor(() => service.statuses.length === 2, "two status reports");

      const reply = service.replies[0] as { replyTo: string; text: string; conversationId: string };
      assert.equal(reply.replyTo, "m1");
      assert.equal(reply.conversationId, "c1");
      assert.equal(reply.text, "Hi there");
      assert.deepEqual(
        (service.statuses as { status: string }[]).map((item) => item.status),
        ["working", "free"],
      );
      assert.ok(
        service.requests.every((request) => request.auth === `Bearer ${key}`),
        "every call carries the key",
      );
      assert.equal(JSON.stringify(pi.sent).includes(key), false, "the key never reaches the model");
    } finally {
      pi.lifecycle("session_shutdown");
    }
    const countAtShutdown = service.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pollsAfter = service.requests
      .slice(countAtShutdown)
      .filter((request) => request.method === "GET");
    assert.ok(pollsAfter.length <= 1, "polling stops after session shutdown");
  });
});
