import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { Limits } from "./protocol.js";

export const DEFAULT_CONFIG_RELATIVE_PATH = join(".omp", "omp-channel.json");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Reads text, or returns undefined when the file does not exist. Other errors are thrown. */
export type ReadText = (path: string) => string | undefined;

export interface ServiceConfig {
  readonly url: URL;
  readonly key: string;
  readonly requestTimeoutMs: number;
  readonly paths: ServicePaths;
}

export interface PollConfig {
  readonly intervalMs: number;
  readonly maxBackoffMs: number;
  readonly batchSize: number;
}

export interface DeliveryConfig {
  readonly deliverAs: "steer" | "followUp" | "aside";
}

export interface FailuresConfig {
  /** Whether the cleaned error text is sent with a failure report. */
  readonly includeReason: boolean;
}

export interface RepliesConfig {
  /** Send the final text of the model as the reply when it did not use the reply tool. */
  readonly fromFinalText: boolean;
}

export interface ChannelConfig {
  readonly mcpServer: string;
  readonly service: ServiceConfig | undefined;
  readonly adapterModule: string | undefined;
  readonly poll: PollConfig;
  readonly limits: Limits & { maxPending: number };
  readonly delivery: DeliveryConfig;
  readonly failures: FailuresConfig;
  readonly replies: RepliesConfig;
}

export interface ConfigSources {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly readText: ReadText;
}

const schemaUrl = new URL("../schema/config.schema.json", import.meta.url);
const ajv = new Ajv2020({ allErrors: false, strict: true, useDefaults: true, verbose: true });
const validateConfigFile = ajv.compile(JSON.parse(readFileSync(schemaUrl, "utf8")) as object);

/**
 * Loads the configuration. The file is OMP_CHANNEL_CONFIG when set, otherwise
 * <cwd>/.omp/omp-channel.json when it exists, otherwise built-in defaults.
 * The key is read from the environment variable named by service.keyEnv, or from the file named
 * by <keyEnv>_FILE. It is never read from the configuration file.
 */
export function loadConfig(sources: ConfigSources): ChannelConfig {
  const path =
    nonEmpty(sources.env.OMP_CHANNEL_CONFIG) ?? join(sources.cwd, DEFAULT_CONFIG_RELATIVE_PATH);
  const explicit = nonEmpty(sources.env.OMP_CHANNEL_CONFIG) !== undefined;
  const text = sources.readText(path);
  if (text === undefined && explicit) {
    throw new ConfigError("OMP_CHANNEL_CONFIG points to a file that does not exist");
  }

  let raw: unknown = {};
  if (text !== undefined) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ConfigError("the configuration file is not valid JSON");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("the configuration file must be a JSON object");
  }
  const data = { ...raw };
  if (!validateConfigFile(data)) {
    const first = validateConfigFile.errors?.[0];
    throw new ConfigError(
      `invalid configuration: ${first === undefined ? "unknown error" : describeSchemaError(first)}`,
    );
  }
  const parsed = data as {
    mcpServer: string;
    service?: { url: string; keyEnv: string; requestTimeoutMs: number; paths: ServicePaths };
    adapterModule?: string;
    poll: { intervalMs: number; maxBackoffMs: number; batchSize: number };
    limits: { maxTextLength: number; maxSenderLength: number; maxPending: number };
    delivery: { deliverAs: DeliveryConfig["deliverAs"] };
    failures: FailuresConfig;
    replies: RepliesConfig;
  };

  const service = parsed.service === undefined ? undefined : loadService(parsed.service, sources);

  return {
    mcpServer: parsed.mcpServer,
    service,
    adapterModule: parsed.adapterModule,
    poll: parsed.poll,
    limits: parsed.limits,
    delivery: parsed.delivery,
    failures: parsed.failures,
    replies: parsed.replies,
  };
}

/**
 * Turns a schema error into one sentence that names the place and what is allowed. It never
 * prints the rejected value, so a mistyped key cannot reach a log through this message.
 */
function describeSchemaError(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const place = error.instancePath === "" ? "the file" : error.instancePath;
  const allowed = (error.parentSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties;
  switch (error.keyword) {
    case "additionalProperties": {
      const keys = Object.keys(allowed ?? {}).filter((key) => key !== "$schema");
      const list = keys.length === 0 ? "" : ` (allowed: ${keys.join(", ")})`;
      return `unknown key "${String(params.additionalProperty)}" at ${place}${list}`;
    }
    case "required":
      return `missing required key "${String(params.missingProperty)}" at ${place}`;
    case "enum":
      return `${place} must be one of: ${(params.allowedValues as unknown[]).join(", ")}`;
    case "minimum":
      return `${place} must be at least ${String(params.limit)}`;
    case "maximum":
      return `${place} must be at most ${String(params.limit)}`;
    case "type":
      return `${place} must be ${article(String(params.type))}`;
    case "pattern":
      return `${place} has an invalid format`;
    case "minLength":
      return `${place} is too short`;
    case "maxLength":
      return `${place} is too long`;
    default:
      return `${place} ${error.message ?? "is invalid"}`;
  }
}

function article(type: string): string {
  return type === "integer" || type === "object" ? `an ${type}` : `a ${type}`;
}

interface ServicePaths {
  messages: string;
  ack: string;
  replies: string;
  status: string;
  failures: string;
}

function loadService(
  service: { url: string; keyEnv: string; requestTimeoutMs: number; paths: ServicePaths },
  sources: ConfigSources,
): ServiceConfig {
  const url = parseServiceUrl(service.url);
  const key = readKey(service.keyEnv, sources);
  return { url, key, requestTimeoutMs: service.requestTimeoutMs, paths: service.paths };
}

/** https is required. Plain http is accepted only for loopback, and credentials are refused. */
export function parseServiceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("service.url is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError("service.url must not contain credentials");
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) {
    return url;
  }
  throw new ConfigError("service.url must use https (http is allowed only for loopback)");
}

function readKey(keyEnv: string, sources: ConfigSources): string {
  const direct = nonEmpty(sources.env[keyEnv]);
  if (direct !== undefined) {
    return direct;
  }
  const filePath = nonEmpty(sources.env[`${keyEnv}_FILE`]);
  if (filePath !== undefined) {
    const text = sources.readText(filePath);
    const key = text === undefined ? undefined : nonEmpty(text);
    if (key !== undefined) {
      return key;
    }
    throw new ConfigError(`${keyEnv}_FILE cannot be read or is empty`);
  }
  throw new ConfigError(`set ${keyEnv} (or ${keyEnv}_FILE) to the service key`);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
