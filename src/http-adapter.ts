import { AdapterError, type ChannelAdapter, type Delivery } from "./adapter.js";
import type { PollConfig, ServiceConfig } from "./config.js";
import {
  type InboundEvent,
  type Limits,
  type OutboundActivity,
  type OutboundFailure,
  type OutboundReply,
  type OutboundStatus,
  parseInboundEvent,
} from "./protocol.js";

export interface HttpAdapterOptions {
  readonly service: ServiceConfig;
  readonly poll: PollConfig;
  readonly limits: Limits;
  readonly log: (line: string) => void;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Transport over plain HTTP with leases (see docs/protocol.md, "HTTP transport"):
 * - GET paths.messages returns { deliveries: [{ deliveryId, leaseExpiresAt, event }] } in order;
 * - POST paths.ack with { deliveryIds: [...] } after the agent admitted a delivery;
 * - POST paths.replies with a reply; POST paths.status with an agent status;
 * - POST paths.failures when a turn ended in an error and a message got no answer;
 * - POST paths.activity, only when that path is configured, with the tools being used.
 * A delivery that is not acknowledged before its lease ends is delivered again by the service.
 */
export function createHttpAdapter(options: HttpAdapterOptions): ChannelAdapter {
  const { service, poll, limits, log } = options;
  const fetchFn = options.fetch ?? fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const url = new URL(`${service.url.pathname.replace(/\/+$/, "")}${path}`, service.url.origin);
    const timeout = AbortSignal.timeout(service.requestTimeoutMs);
    const headers: Record<string, string> = {
      authorization: `Bearer ${service.key}`,
      accept: "application/json",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new AdapterError("the request timed out");
      }
      if (signal?.aborted) {
        throw error;
      }
      throw new AdapterError(
        `the request failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
    if (!response.ok) {
      throw new AdapterError(`the service answered with HTTP ${response.status}`);
    }
    return response;
  };

  const ack = async (deliveryId: string): Promise<void> => {
    await request("POST", service.paths.ack, { deliveryIds: [deliveryId] }, undefined);
  };

  const poll_ = async (signal: AbortSignal): Promise<Delivery[]> => {
    const response = await request(
      "GET",
      `${service.paths.messages}?limit=${poll.batchSize}`,
      undefined,
      signal,
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as { deliveries?: unknown }).deliveries)
    ) {
      throw new AdapterError("the service returned an unexpected response");
    }
    const deliveries: Delivery[] = [];
    for (const item of (body as { deliveries: unknown[] }).deliveries) {
      const deliveryId =
        typeof item === "object" && item !== null
          ? (item as { deliveryId?: unknown }).deliveryId
          : undefined;
      if (typeof deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(deliveryId)) {
        log("discarded a delivery without a valid deliveryId");
        continue;
      }
      const parsed = parseInboundEvent((item as { event?: unknown }).event, limits);
      if (!parsed.ok) {
        // An invalid delivery is acknowledged and dropped, so it cannot block the queue forever.
        log(`discarded invalid delivery ${deliveryId}: ${parsed.reason}`);
        await ack(deliveryId).catch(() => log(`could not acknowledge delivery ${deliveryId}`));
        continue;
      }
      deliveries.push({ deliveryId, event: parsed.value as InboundEvent });
    }
    return deliveries;
  };

  const activityPath = service.paths.activity;

  return {
    ...(activityPath === undefined
      ? {}
      : {
          async activity(activity: OutboundActivity): Promise<void> {
            await request("POST", activityPath, activity, undefined);
          },
        }),

    async *receive(signal: AbortSignal): AsyncGenerator<Delivery> {
      let failures = 0;
      while (!signal.aborted) {
        let batch: Delivery[];
        try {
          batch = await poll_(signal);
          failures = 0;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          failures += 1;
          const wait = Math.min(poll.intervalMs * 2 ** Math.min(failures, 16), poll.maxBackoffMs);
          log(
            `polling failed (${error instanceof Error ? error.name : "unknown"}), retrying in ${wait} ms`,
          );
          await sleep(wait, signal);
          continue;
        }
        if (batch.length === 0) {
          await sleep(poll.intervalMs, signal);
          continue;
        }
        for (const delivery of batch) {
          if (signal.aborted) {
            return;
          }
          yield delivery;
        }
      }
    },

    async reply(reply: OutboundReply): Promise<void> {
      await request("POST", service.paths.replies, reply, undefined);
    },

    async ack(deliveryId: string): Promise<void> {
      await ack(deliveryId);
    },

    async status(status: OutboundStatus): Promise<void> {
      await request("POST", service.paths.status, status, undefined);
    },

    async failure(failure: OutboundFailure): Promise<void> {
      await request("POST", service.paths.failures, failure, undefined);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
