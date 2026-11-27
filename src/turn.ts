import { messageIdsIn } from "./protocol.js";

/**
 * Reads the end of an Oh My Pi run. The shapes are declared loosely on purpose: only the fields
 * used here are required, so an unexpected message is skipped instead of breaking the session.
 */
export interface RunEnd {
  /** True when Oh My Pi continues the run on its own (a retry, for example). */
  readonly willContinue?: boolean | undefined;
  /** True when background work that will continue the run is still going. */
  readonly awaitingAsyncWork?: boolean | undefined;
  /** The session messages when the run ended. */
  readonly messages?: readonly unknown[] | undefined;
}

/** Fixed texts a service receives when there is no answer of the model to send. */
export const NO_REPLY_REASON = "The agent finished without sending a reply";
export const STOPPED_REASON = "The turn was stopped before the agent answered";
export const INCOMPLETE_REASON = "The agent stopped before finishing its answer";

/**
 * A stretch of a run that ends with one outcome, and the channel messages it was answering.
 * `completed`: the model finished an answer (`text`, which may be missing). `failed`: a model
 * error. `stopped`: aborted, or ended before an answer.
 */
export interface Segment {
  /** Ids of the channel messages this stretch was answering, oldest first. */
  readonly messageIds: readonly string[];
  readonly outcome: "completed" | "failed" | "stopped";
  /** Why there is no answer. A model error comes as it is: clean it before it is sent. */
  readonly reason: string | undefined;
  /** The text the model ended its answer with, as it came: clean it before it is sent. */
  readonly text: string | undefined;
}

/**
 * The channel messages of a finished run, grouped by the answer that closed them. Empty for a run
 * that Oh My Pi continues (a retry, or background work that has not ended in an error) and for a
 * run without channel messages. The messages are the whole session, so the caller drops those
 * that already have a reply or a report.
 */
export function segmentsOf(end: RunEnd): Segment[] {
  if (end.willContinue === true) {
    return [];
  }
  const segments: Segment[] = [];
  let ids: string[] = [];
  // The last assistant message after the last completed answer and the last message to answer.
  let last: Record<string, unknown> | undefined;
  for (const message of (end.messages ?? []).filter(isRecord)) {
    if (message.role === "user" || message.role === "developer") {
      ids.push(...textsOf(message.content).flatMap(messageIdsIn));
      // An end seen before this message says nothing about it.
      last = undefined;
    } else if (message.role === "assistant") {
      if (message.stopReason === "stop" || message.stopReason === "length") {
        const text = textsOf(message.content).join("\n").trim();
        add(segments, ids, "completed", undefined, text);
        ids = [];
        last = undefined;
      } else {
        last = message;
      }
    }
  }
  if (last?.stopReason === "error") {
    const reason = typeof last.errorMessage === "string" ? last.errorMessage : undefined;
    add(segments, ids, "failed", reason, "");
  } else {
    const aborted = last === undefined || last.stopReason === "aborted";
    add(segments, ids, "stopped", aborted ? STOPPED_REASON : INCOMPLETE_REASON, "");
  }
  // Background work will continue the run: only an error is already final.
  if (end.awaitingAsyncWork === true && segments.at(-1)?.outcome !== "failed") {
    return [];
  }
  return segments;
}

function add(
  segments: Segment[],
  ids: readonly string[],
  outcome: Segment["outcome"],
  reason: string | undefined,
  text: string,
): void {
  if (ids.length > 0) {
    segments.push({
      messageIds: [...new Set(ids)],
      outcome,
      reason,
      text: text === "" ? undefined : text,
    });
  }
}

/** The text parts of a message. Thinking and tool calls are not text. */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(isRecord)
    .flatMap((part) =>
      (part.type === undefined || part.type === "text") && typeof part.text === "string"
        ? [part.text]
        : [],
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
