/**
 * The subset of the Oh My Pi (OMP) extension API that omp-channel uses.
 *
 * Derived from Oh My Pi at commit eded751bee10cedac1df7ace6616b8d2cf121a8a (branch main):
 * - extensions/types.ts: ExtensionAPI (on, registerTool, sendUserMessage), McpNotificationEvent,
 *   ToolDefinition, ExtensionContext (abort, isIdle), ExtensionFactory;
 * - session/agent-session.ts: SendUserMessageOptions (deliverAs, attribution).
 *
 * The same declarations are in the published package @oh-my-pi/pi-coding-agent@19.2.1
 * (dist/types/extensibility/extensions/types.d.ts and dist/types/session/agent-session-types.d.ts),
 * where they were checked. The package is not a dependency: it is a full agent with a large
 * dependency tree, and this project needs only the declarations below.
 *
 * Differences to re-check when Oh My Pi changes:
 * - OMP declares tool `parameters` as a TypeBox schema; this file uses a plain JSON Schema object,
 *   which TypeBox produces and accepts at runtime. Not verified in a running OMP session.
 * - Only the fields used by this project are listed.
 *
 * Keep this file in sync with the OMP version listed in README.md.
 */

export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface AgentToolResult<TDetails = unknown> {
  content: TextContent[];
  details?: TDetails;
}

export interface ExtensionContext {
  readonly hasUI: boolean;
  /** Whether the agent is idle (not streaming). */
  isIdle(): boolean;
  /** Aborts the current agent operation. */
  abort(): void;
}

export type ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => Promise<void> | void;

export interface McpNotificationEvent {
  type: "mcp_notification";
  /** Server name as declared in the MCP configuration (raw, not sanitized). */
  server: string;
  /** JSON-RPC method, for example `notifications/omp/channel`. */
  method: string;
  /** JSON-RPC params, opaque to the runtime. */
  params: unknown;
}

export interface LifecycleEvent {
  type: "session_start" | "agent_start" | "agent_end" | "session_shutdown";
}

export interface SendUserMessageOptions {
  /** Omitted: start a turn when idle, steer while streaming. */
  deliverAs?: "steer" | "followUp" | "aside";
  /** Explicit billing/initiator attribution. */
  attribution?: "user" | "agent";
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchemaObject;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult>;
}

export interface ExtensionAPI {
  on(event: "mcp_notification", handler: ExtensionHandler<McpNotificationEvent>): void;
  on(
    event: "session_start" | "agent_start" | "agent_end" | "session_shutdown",
    handler: ExtensionHandler<LifecycleEvent>,
  ): void;
  registerTool(tool: ToolDefinition): void;
  /**
   * Sends a user prompt. Rejects with PromptDroppedError (OMP) when the session refuses it,
   * for example after an abort or when a cost cap is reached.
   */
  sendUserMessage(content: string, options?: SendUserMessageOptions): Promise<void>;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
