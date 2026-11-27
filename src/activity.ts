import { randomUUID } from "node:crypto";
import { buildActivity, messageIdsIn, type OutboundActivity } from "./protocol.js";
import { activityText } from "./redact.js";
import { textsOf } from "./turn.js";

/** Tool uses reported for one message. */
export const MAX_ACTIVITIES_PER_MESSAGE = 200;
/** Reports waiting to be sent, the one in flight included. More are dropped. */
export const MAX_WAITING_REPORTS = 100;
/** How long one report may take before the next one is sent. */
export const REPORT_TIMEOUT_MS = 5_000;
/** How long a reply or a failure report waits for the reports that come before it. */
export const FLUSH_TIMEOUT_MS = 1_000;

const MAX_REMEMBERED = 1000;

/** The start of a tool use, as Oh My Pi announces it. */
export interface ToolStart {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly intent?: string | undefined;
  readonly args?: unknown;
}

export interface ToolEnd {
  readonly toolCallId: string;
  readonly isError?: boolean | undefined;
}

export interface ActivityOptions {
  readonly send: (activity: OutboundActivity) => Promise<void>;
  /** The conversation of a message that has no reply or report yet, undefined otherwise. */
  readonly conversationOfOpen: (messageId: string) => string | undefined;
  /** Tools whose use is not reported. */
  readonly ignored: ReadonlySet<string>;
  readonly log: (line: string) => void;
  readonly now?: (() => Date) | undefined;
  readonly newId?: (() => string) | undefined;
}

interface Use {
  readonly conversationId: string;
  readonly replyTo: string;
  readonly activityId: string;
  readonly text: string;
}

/**
 * Tells the service which tools the agent uses for its messages (docs/protocol.md, "Activity").
 * The work belongs to the newest open message of the last prompt that carried one. Nothing is said
 * about work for a prompt typed at the terminal. Reports leave one at a time, in order, and never
 * hold the agent back.
 */
export class ActivityReports {
  readonly #options: ActivityOptions;
  /** Message ids the agent has taken and may be working on, oldest first. */
  #messages: string[] = [];
  readonly #uses = new Map<string, Use>();
  readonly #counts = new Map<string, number>();
  #queue: Promise<void> = Promise.resolve();
  #waiting = 0;
  #refused = false;
  #dropped = false;

  constructor(options: ActivityOptions) {
    this.#options = options;
  }

  /** A message entered the session. */
  heard(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const { role, content, synthetic } = message as Record<string, unknown>;
    if (role !== "user" && role !== "developer") {
      return;
    }
    const ids = textsOf(content).flatMap(messageIdsIn);
    if (ids.length > 0) {
      const kept = this.#messages.filter((id) => !ids.includes(id));
      this.#messages = [...kept, ...ids].slice(-MAX_REMEMBERED);
    } else if (role === "user" && synthetic !== true) {
      // A person typed at the terminal: what follows is not for the service.
      this.#messages = [];
    }
  }

  started(tool: ToolStart): void {
    if (this.#options.ignored.has(tool.toolName)) {
      return;
    }
    const replyTo = [...this.#messages]
      .reverse()
      .find((id) => this.#options.conversationOfOpen(id) !== undefined);
    const conversationId =
      replyTo === undefined ? undefined : this.#options.conversationOfOpen(replyTo);
    if (replyTo === undefined || conversationId === undefined) {
      return;
    }
    const count = this.#counts.get(replyTo) ?? 0;
    if (count >= MAX_ACTIVITIES_PER_MESSAGE) {
      return;
    }
    remember(this.#counts, replyTo, count + 1);
    const use: Use = {
      conversationId,
      replyTo,
      activityId: this.#newId(),
      text: activityText(tool.toolName, tool.intent, tool.args),
    };
    remember(this.#uses, tool.toolCallId, use);
    this.#report(use, "running");
  }

  ended(tool: ToolEnd): void {
    const use = this.#uses.get(tool.toolCallId);
    this.#uses.delete(tool.toolCallId);
    // After the reply or the failure report there is nothing left to say about the message.
    if (use !== undefined && this.#options.conversationOfOpen(use.replyTo) !== undefined) {
      this.#report(use, tool.isError === true ? "failed" : "done");
    }
  }

  /** The session goes to another conversation of its own. */
  reset(): void {
    this.#messages = [];
    this.#uses.clear();
  }

  /** Resolves when the reports made so far have left, or after a short wait. */
  flush(): Promise<void> | undefined {
    return this.#waiting === 0 ? undefined : within(this.#queue, FLUSH_TIMEOUT_MS).catch(() => {});
  }

  #report(use: Use, state: OutboundActivity["state"]): void {
    if (this.#waiting >= MAX_WAITING_REPORTS) {
      if (!this.#dropped) {
        this.#options.log("activity reports are dropped: the service is too slow");
      }
      this.#dropped = true;
      return;
    }
    const activity = buildActivity(
      use.conversationId,
      use.replyTo,
      { activityId: use.activityId, state, text: use.text },
      { messageId: this.#newId(), at: this.#options.now?.() ?? new Date() },
    );
    this.#waiting += 1;
    this.#queue = this.#queue.then(() => this.#deliver(activity));
  }

  /** One attempt. A refusal is logged once until a report is accepted again. */
  async #deliver(activity: OutboundActivity): Promise<void> {
    try {
      await within(this.#options.send(activity), REPORT_TIMEOUT_MS);
      this.#refused = false;
      this.#dropped = false;
    } catch (error) {
      if (!this.#refused) {
        const name = error instanceof Error ? error.name : "unknown";
        this.#options.log(`activity was not reported (${name})`);
      }
      this.#refused = true;
    } finally {
      this.#waiting -= 1;
    }
  }

  #newId(): string {
    return this.#options.newId?.() ?? randomUUID();
  }
}

/** The promise, or a rejection after `ms`. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("no answer in time");
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  try {
    await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Adds to a map that keeps only the newest entries. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next();
    if (oldest.value !== undefined) {
      map.delete(oldest.value);
    }
  }
}
