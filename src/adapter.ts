import type {
  InboundEvent,
  OutboundActivity,
  OutboundFailure,
  OutboundReply,
  OutboundStatus,
} from "./protocol.js";

/** One event from a service, with the lease id that the service uses for acknowledgement. */
export interface Delivery {
  /** Present when the transport leases deliveries (the HTTP transport does). */
  readonly deliveryId?: string;
  readonly event: InboundEvent;
}

/**
 * Contract a service implements to connect to omp-channel from code (see docs/protocol.md).
 * Only `receive` and `reply` are required. The others are optional hooks.
 */
export interface ChannelAdapter {
  /**
   * Yields deliveries in the order the service sent them. The consumer awaits each one before
   * asking for the next, so the order is kept. Stops when `signal` aborts.
   */
  receive(signal: AbortSignal): AsyncIterable<Delivery>;
  /** Posts a reply. Throws when the service does not accept it. */
  reply(reply: OutboundReply): Promise<void>;
  /** Acknowledges a delivery once the agent has admitted it. Without it, the service may redeliver. */
  ack?(deliveryId: string): Promise<void>;
  /** Reports agent state for a conversation. Best effort. */
  status?(status: OutboundStatus): Promise<void>;
  /**
   * Reports that a message got no answer because the turn ended in an error. Without it the
   * service learns nothing and the message stays unanswered. Throws when it is not accepted.
   */
  failure?(failure: OutboundFailure): Promise<void>;
  /**
   * Reports a tool the agent is using for a message, or how that use ended. Best effort: a report
   * that is refused is logged and not sent again. Without it no activity is collected.
   */
  activity?(activity: OutboundActivity): Promise<void>;
  /** Tells the service that an interrupt was applied. Optional. */
  interrupt?(conversationId: string): Promise<void>;
  /** Tells the service that a conversation was closed on the agent side. Optional. */
  close?(conversationId: string): Promise<void>;
  /**
   * A short plain-text description of the adapter's state, shown by the `/channel-status` command.
   * It is for the person who runs the agent: it must not contain keys or message text. Optional.
   */
  describe?(): Promise<string> | string;
}

export function isChannelAdapter(value: unknown): value is ChannelAdapter {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.receive === "function" && typeof candidate.reply === "function";
}

/**
 * Error raised by adapters. Its message is safe to show to the model or to log: it must never
 * contain the service key, request bodies, or message text.
 */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}
