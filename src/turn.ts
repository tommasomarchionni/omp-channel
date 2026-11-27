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

/** What the service is told when a run ends normally and a message got no reply. */
export const NO_REPLY_REASON = "The agent finished without sending a reply";

export interface FailedRun {
  /**
   * The error the model provider reported, as it came (clean it before it leaves the machine), or
   * `NO_REPLY_REASON` for a run that ended normally.
   */
  readonly reason: string | undefined;
  /** Ids of the channel messages the failed work was answering, oldest first. */
  readonly messageIds: readonly string[];
}

/**
 * The messages a finished run may have left without a reply: it ended in a model error, or it
 * ended normally. Undefined for a run that goes on (a retry, background work), an abort, or a run
 * without any channel message. The caller drops the messages that did get a reply.
 *
 * The messages looked at are those after the previous completed answer: an older message that the
 * model finished with is not blamed for a later end.
 */
export function failedRun(end: RunEnd): FailedRun | undefined {
  if (end.willContinue === true) {
    return undefined;
  }
  const messages = (end.messages ?? []).filter(isRecord);
  let last = messages.length - 1;
  while (last >= 0 && messages[last]?.role !== "assistant") {
    last -= 1;
  }
  const failed = messages[last];
  const errored = failed?.stopReason === "error";
  const completed = isCompleted(failed?.stopReason) && end.awaitingAsyncWork !== true;
  if (failed === undefined || (!errored && !completed)) {
    return undefined;
  }
  const ids: string[] = [];
  for (let index = last - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "assistant") {
      if (isCompleted(message.stopReason)) {
        break;
      }
      continue;
    }
    if (message.role === "user" || message.role === "developer") {
      ids.unshift(...textsOf(message.content).flatMap(messageIdsIn));
    }
  }
  if (ids.length === 0) {
    return undefined;
  }
  const error = typeof failed.errorMessage === "string" ? failed.errorMessage : undefined;
  return { reason: errored ? error : NO_REPLY_REASON, messageIds: [...new Set(ids)] };
}

function isCompleted(stopReason: unknown): boolean {
  return stopReason === "stop" || stopReason === "length";
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(isRecord)
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
