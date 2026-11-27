import { messageIdsIn } from "./protocol.js";

/**
 * Reads the end of an Oh My Pi run. The shapes are declared loosely on purpose: only the fields
 * used here are required, so an unexpected message is skipped instead of breaking the session.
 */
export interface RunEnd {
  /** True when Oh My Pi continues the run on its own (a retry, for example). */
  readonly willContinue?: boolean | undefined;
  /** The session messages when the run ended. */
  readonly messages?: readonly unknown[] | undefined;
}

export interface FailedRun {
  /** The error the model provider reported, as it came. Clean it before it leaves the machine. */
  readonly reason: string | undefined;
  /** Ids of the channel messages the failed work was answering, oldest first. */
  readonly messageIds: readonly string[];
}

/**
 * The failure of a run that ended in a model error, or undefined for every other end: a run that
 * goes on, a normal answer, an abort, or a run without any channel message.
 *
 * The messages looked at are those after the last completed answer: an older message that the
 * model finished with is not blamed for a later error.
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
  if (failed === undefined || failed.stopReason !== "error") {
    return undefined;
  }
  const ids: string[] = [];
  for (let index = last - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "assistant") {
      if (message.stopReason === "stop" || message.stopReason === "length") {
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
  return {
    reason: typeof failed.errorMessage === "string" ? failed.errorMessage : undefined,
    messageIds: [...new Set(ids)],
  };
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
