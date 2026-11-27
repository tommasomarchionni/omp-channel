import { randomUUID } from "node:crypto";
import { AdapterError, type ChannelAdapter } from "./adapter.js";
import type { ChannelConfig } from "./config.js";
import { cleanReason } from "./redact.js";
import type { SendUserMessageOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
  type AgentStatus,
  buildFailure,
  buildReply,
  buildStatus,
  formatForSession,
  type InboundEvent,
  type MessageEvent,
} from "./protocol.js";

/** What happened to an inbound event. The outcomes marked as acknowledged may be acked. */
export type AdmitOutcome =
  | "admitted"
  | "duplicate"
  | "ignored"
  | "refused"
  | "rejected"
  | "dropped";

export const ACKNOWLEDGED_OUTCOMES: ReadonlySet<AdmitOutcome> = new Set([
  "admitted",
  "duplicate",
  "ignored",
]);

/** The part of the Oh My Pi session that the dispatcher uses. */
export interface SessionPort {
  send(content: string, options: SendUserMessageOptions): Promise<void>;
  abort(): void;
  isIdle(): boolean;
}

export interface DispatcherOptions {
  readonly config: ChannelConfig;
  readonly session: SessionPort;
  readonly adapter: ChannelAdapter | undefined;
  readonly log: (line: string) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type ReplyResult = { ok: true } | { ok: false; reason: string };

const MAX_REMEMBERED = 1000;

/**
 * Applies inbound events to the agent session, one at a time and in arrival order.
 *
 * - One conversation is open at a time. Messages of another conversation are refused and are not
 *   acknowledged, so the service delivers them again once the open conversation closes.
 * - A message is admitted once. Duplicates (same messageId, or same delivery) are acknowledged
 *   without running again.
 * - Interrupt stops the current turn only. Tool results already produced stay in the session.
 * - Agent state is reported to the service for the open conversation.
 * - A message that a failed turn left unanswered is reported once.
 */
export class Dispatcher {
  readonly #options: DispatcherOptions;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #active: string | undefined;
  readonly #remembered = new RecentSet(MAX_REMEMBERED);
  readonly #conversationOf = new RecentMap(MAX_REMEMBERED);
  readonly #answered = new RecentSet(MAX_REMEMBERED);
  readonly #reportedFailed = new RecentSet(MAX_REMEMBERED);

  constructor(options: DispatcherOptions) {
    this.#options = options;
  }

  get activeConversation(): string | undefined {
    return this.#active;
  }

  submit(event: InboundEvent, deliveryId?: string): Promise<AdmitOutcome> {
    if (this.#pending >= this.#options.config.limits.maxPending) {
      return Promise.resolve("dropped");
    }
    this.#pending += 1;
    const run = this.#queue.then(async () => {
      try {
        return await this.#apply(event, deliveryId);
      } finally {
        this.#pending -= 1;
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Reports the agent state for the open conversation. Best effort: errors are logged. */
  setStatus(status: AgentStatus): void {
    const conversation = this.#active;
    const adapter = this.#options.adapter;
    if (conversation === undefined || adapter?.status === undefined) {
      return;
    }
    adapter.status(buildStatus(conversation, status, this.#now())).catch((error: unknown) => {
      this.#options.log(`status was not reported (${errorName(error)})`);
    });
  }

  async reply(messageId: string, text: string): Promise<ReplyResult> {
    const conversation = this.#conversationOf.get(messageId);
    if (conversation === undefined) {
      return { ok: false, reason: "unknown messageId" };
    }
    const adapter = this.#options.adapter;
    if (adapter === undefined) {
      return { ok: false, reason: "replies are not configured" };
    }
    const reply = buildReply(conversation, messageId, text, {
      messageId: this.#newId(),
      at: this.#now(),
    });
    try {
      await adapter.reply(reply);
      this.#answered.add(messageId);
      return { ok: true };
    } catch (error) {
      const detail =
        error instanceof AdapterError ? error.message : `the request failed (${errorName(error)})`;
      return { ok: false, reason: `the service did not accept the reply: ${detail}` };
    }
  }

  /**
   * Tells the service that a failed turn left these messages unanswered. Messages that were not
   * admitted here, already answered or already reported are skipped. Best effort: a report that
   * is refused is logged, and a later failure of the same message tries again.
   */
  async reportFailure(messageIds: readonly string[], reason: string | undefined): Promise<void> {
    const waiting = messageIds.flatMap((messageId) => {
      const conversation = this.#conversationOf.get(messageId);
      return conversation === undefined ||
        this.#answered.has(messageId) ||
        this.#reportedFailed.has(messageId)
        ? []
        : [{ messageId, conversation }];
    });
    if (waiting.length === 0) {
      return;
    }
    const adapter = this.#options.adapter;
    if (adapter?.failure === undefined) {
      this.#options.log("a turn failed and the adapter does not report failures");
      return;
    }
    const shown =
      this.#options.config.failures.includeReason && reason !== undefined
        ? cleanReason(reason)
        : undefined;
    // Marked before the first wait, so a second end of the same run does not report twice.
    for (const { messageId } of waiting) {
      this.#reportedFailed.add(messageId);
    }
    for (const { messageId, conversation } of waiting) {
      const report = buildFailure(conversation, messageId, shown, {
        messageId: this.#newId(),
        at: this.#now(),
      });
      try {
        await adapter.failure(report);
      } catch (error) {
        this.#reportedFailed.delete(messageId);
        this.#options.log(`failure was not reported (${errorName(error)})`);
      }
    }
  }

  async #apply(event: InboundEvent, deliveryId: string | undefined): Promise<AdmitOutcome> {
    const { config, session } = this.#options;
    if (event.type === "message") {
      return this.#applyMessage(event, config);
    }

    const key = deliveryId === undefined ? undefined : `delivery:${deliveryId}`;
    if (key !== undefined && this.#remembered.has(key)) {
      return "duplicate";
    }
    if (event.conversationId !== this.#active) {
      return "ignored";
    }

    if (event.type === "interrupt") {
      if (!session.isIdle()) {
        session.abort();
      }
      if (key !== undefined) {
        this.#remembered.add(key);
      }
      await this.#notify(
        () => this.#options.adapter?.interrupt?.(event.conversationId),
        "interrupt",
      );
      return "admitted";
    }

    this.#active = undefined;
    if (key !== undefined) {
      this.#remembered.add(key);
    }
    await this.#notify(() => this.#options.adapter?.close?.(event.conversationId), "close");
    return "admitted";
  }

  async #applyMessage(event: MessageEvent, config: ChannelConfig): Promise<AdmitOutcome> {
    const key = `message:${event.messageId}`;
    if (this.#remembered.has(key)) {
      return "duplicate";
    }
    if (this.#active !== undefined && this.#active !== event.conversationId) {
      return "refused";
    }
    const options: SendUserMessageOptions = {
      deliverAs: config.delivery.deliverAs,
      attribution: event.attribution,
    };
    try {
      await this.#options.session.send(formatForSession(event), options);
    } catch (error) {
      this.#options.log(`message ${event.messageId} was not admitted (${errorName(error)})`);
      return "rejected";
    }
    this.#active = event.conversationId;
    this.#remembered.add(key);
    this.#conversationOf.set(event.messageId, event.conversationId);
    return "admitted";
  }

  async #notify(call: () => Promise<void> | undefined, label: string): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.#options.log(`${label} was not reported (${errorName(error)})`);
    }
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #newId(): string {
    return this.#options.newId?.() ?? randomUUID();
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

class RecentSet {
  readonly #values = new Set<string>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  delete(value: string): void {
    this.#values.delete(value);
  }

  add(value: string): void {
    this.#values.add(value);
    if (this.#values.size > this.#capacity) {
      const oldest = this.#values.values().next();
      if (oldest.value !== undefined) {
        this.#values.delete(oldest.value);
      }
    }
  }
}

class RecentMap {
  readonly #values = new Map<string, string>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  set(key: string, value: string): void {
    this.#values.set(key, value);
    if (this.#values.size > this.#capacity) {
      const oldest = this.#values.keys().next();
      if (oldest.value !== undefined) {
        this.#values.delete(oldest.value);
      }
    }
  }
}
