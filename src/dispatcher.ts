import { randomUUID } from "node:crypto";
import { AdapterError, type ChannelAdapter } from "./adapter.js";
import type { ChannelConfig } from "./config.js";
import { cleanReason, cleanText } from "./redact.js";
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
import { NO_REPLY_REASON, type Segment } from "./turn.js";

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
  /** Waits between two attempts to deliver (tests replace it). */
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * Called before a reply or a failure report leaves: what must reach the service first. Undefined
   * when there is nothing to wait for. It must settle on its own in a short time.
   */
  readonly beforeOutcome?: () => Promise<void> | undefined;
}

export type ReplyResult = { ok: true } | { ok: false; reason: string };

const MAX_REMEMBERED = 1000;

/** Waits before each attempt to deliver what the end of a run owes the service. */
const ATTEMPT_DELAYS_MS: readonly number[] = [0, 1_000, 5_000];

/** The reply a message gets when the answer to a later one covers it. */
export const ANSWERED_LATER_TEXT = "Answered together with a later message.";
export const UNDELIVERED_REASON = "The agent answered, but the answer could not be delivered";
export const CLOSED_REASON = "The agent was closed before it answered";
export const SWITCHED_REASON = "The agent moved to another session before it answered";

/**
 * Applies inbound events to the agent session, one at a time and in arrival order.
 *
 * - One conversation is open at a time. Messages of another conversation are refused and are not
 *   acknowledged, so the service delivers them again once the open conversation closes.
 * - A message is admitted once. Duplicates (same messageId, or same delivery) are acknowledged
 *   without running again.
 * - Interrupt stops the current turn only. Tool results already produced stay in the session.
 * - Agent state is reported to the service for the open conversation.
 * - A message is never left waiting: when a run ends, or the session goes away, every message
 *   without a reply gets the final answer of the model, a note, or a failure report.
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
  /** Messages whose end is being sent now, so a second end of a run does not send it twice. */
  readonly #settling = new Set<string>();
  /** Admitted messages that have neither a reply nor a report yet, oldest first. */
  readonly #waiting = new Set<string>();

  constructor(options: DispatcherOptions) {
    this.#options = options;
  }

  get activeConversation(): string | undefined {
    return this.#active;
  }

  /** The conversation of a message that has no reply or report yet, undefined otherwise. */
  conversationOfOpen(messageId: string): string | undefined {
    return this.#isOpen(messageId) ? this.#conversationOf.get(messageId) : undefined;
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
    await this.#outcomeIsNext();
    try {
      await adapter.reply(reply);
      this.#answered.add(messageId);
      this.#waiting.delete(messageId);
      return { ok: true };
    } catch (error) {
      const detail =
        error instanceof AdapterError ? error.message : `the request failed (${errorName(error)})`;
      return { ok: false, reason: `the service did not accept the reply: ${detail}` };
    }
  }

  /**
   * Closes what a finished run left open. For each message without a reply or a report: the final
   * text of the model as its reply (when the run completed with one), a note when a later message
   * got the answer, or a failure report. Refused calls are tried again, and a message that could
   * not be closed stays open for the end of the next run.
   */
  async settle(segments: readonly Segment[]): Promise<void> {
    const order = segments.flatMap((segment) => segment.messageIds);
    const open = new Set(order.filter((messageId) => this.#isOpen(messageId)));
    // Taken before the first wait.
    for (const messageId of open) {
      this.#settling.add(messageId);
    }
    try {
      for (const segment of segments) {
        const mine = segment.messageIds.filter((messageId) => open.has(messageId));
        // Covered: a message that came after it already has its answer.
        const covered = mine.filter((messageId) =>
          order.slice(order.indexOf(messageId) + 1).some((later) => this.#answered.has(later)),
        );
        await this.#close(
          segment,
          mine.filter((id) => !covered.includes(id)),
          covered,
        );
      }
    } finally {
      for (const messageId of open) {
        this.#settling.delete(messageId);
      }
    }
  }

  /** The session goes away: every open message is reported, with one attempt. */
  async abandon(reason: string): Promise<void> {
    const open = [...this.#waiting].filter((messageId) => this.#isOpen(messageId));
    await Promise.all(open.map((messageId) => this.#reportFailure(messageId, reason, [0])));
  }

  /** True while some admitted message has neither a reply nor a report. */
  get hasOpenMessages(): boolean {
    return [...this.#waiting].some((messageId) => this.#isOpen(messageId));
  }

  async #close(segment: Segment, due: string[], covered: string[]): Promise<void> {
    const { config } = this.#options;
    const newest = due.at(-1);
    const text =
      newest !== undefined && config.replies.fromFinalText && segment.text !== undefined
        ? cleanText(segment.text, config.limits.maxTextLength)
        : undefined;
    let notes = covered;
    if (newest !== undefined && text !== undefined) {
      if (await this.#deliverReply(newest, text)) {
        notes = [...covered, ...due.slice(0, -1)];
      } else {
        for (const messageId of due) {
          await this.#reportFailure(messageId, UNDELIVERED_REASON);
        }
      }
    } else {
      const reason =
        segment.reason ?? (segment.outcome === "completed" ? NO_REPLY_REASON : undefined);
      for (const messageId of due) {
        await this.#reportFailure(messageId, reason);
      }
    }
    for (const messageId of notes) {
      if (!(await this.#deliverReply(messageId, ANSWERED_LATER_TEXT))) {
        await this.#reportFailure(messageId, UNDELIVERED_REASON);
      }
    }
  }

  #isOpen(messageId: string): boolean {
    return (
      this.#conversationOf.get(messageId) !== undefined &&
      !this.#answered.has(messageId) &&
      !this.#reportedFailed.has(messageId) &&
      !this.#settling.has(messageId)
    );
  }

  async #deliverReply(messageId: string, text: string): Promise<boolean> {
    for (const delay of ATTEMPT_DELAYS_MS) {
      await this.#wait(delay);
      // The model may have answered while this waited.
      if (this.#answered.has(messageId) || (await this.reply(messageId, text)).ok) {
        return true;
      }
    }
    this.#options.log("an answer could not be delivered");
    return false;
  }

  async #reportFailure(
    messageId: string,
    reason: string | undefined,
    delays: readonly number[] = ATTEMPT_DELAYS_MS,
  ): Promise<void> {
    const conversation = this.#conversationOf.get(messageId);
    if (conversation === undefined) {
      return;
    }
    const adapter = this.#options.adapter;
    if (adapter?.failure === undefined) {
      this.#options.log("a message got no answer and the adapter does not report failures");
      return;
    }
    const shown =
      this.#options.config.failures.includeReason && reason !== undefined
        ? cleanReason(reason)
        : undefined;
    const report = buildFailure(conversation, messageId, shown, {
      messageId: this.#newId(),
      at: this.#now(),
    });
    await this.#outcomeIsNext();
    let failure = "unknown";
    for (const delay of delays) {
      await this.#wait(delay);
      if (this.#answered.has(messageId)) {
        return;
      }
      try {
        await adapter.failure(report);
        this.#reportedFailed.add(messageId);
        this.#waiting.delete(messageId);
        return;
      } catch (error) {
        failure = errorName(error);
      }
    }
    this.#options.log(`failure was not reported (${failure})`);
  }

  async #outcomeIsNext(): Promise<void> {
    const pending = this.#options.beforeOutcome?.();
    if (pending !== undefined) {
      await pending;
    }
  }

  async #wait(ms: number): Promise<void> {
    if (ms === 0) {
      return;
    }
    await (this.#options.wait?.(ms) ?? new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    this.#waiting.add(event.messageId);
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
