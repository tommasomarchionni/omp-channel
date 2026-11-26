import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, parseServiceUrl, type ReadText } from "../src/config.js";

const cwd = "/work/project";
const configPath = join(cwd, ".omp", "omp-channel.json");

function sources(files: Record<string, string>, env: Record<string, string> = {}) {
  const readText: ReadText = (path) => files[path];
  return { env, cwd, readText };
}

const serviceFile = JSON.stringify({ service: { url: "https://chat.example.com/api" } });

describe("loadConfig", () => {
  it("uses safe defaults when no file exists and no service is set", () => {
    const config = loadConfig(sources({}));
    assert.equal(config.mcpServer, "omp-channel");
    assert.equal(config.service, undefined);
    assert.equal(config.adapterModule, undefined);
    assert.deepEqual(config.delivery, { deliverAs: "followUp", attribution: "agent" });
    assert.deepEqual(config.limits, { maxTextLength: 4000, maxSenderLength: 64, maxPending: 5 });
    assert.deepEqual(config.poll, { intervalMs: 2000, maxBackoffMs: 30000, batchSize: 10 });
  });

  it("reads the service key from the variable named by keyEnv, never from the file", () => {
    const config = loadConfig(
      sources(
        {
          [configPath]: JSON.stringify({
            service: { url: "https://chat.example.com/api", keyEnv: "EXAMPLE_CHANNEL_KEY" },
          }),
        },
        { EXAMPLE_CHANNEL_KEY: " key-123 " },
      ),
    );
    assert.equal(config.service?.key, "key-123");
    assert.equal(config.service?.url.href, "https://chat.example.com/api");
    assert.deepEqual(config.service?.paths, {
      messages: "/messages",
      ack: "/messages/ack",
      replies: "/replies",
      status: "/status",
    });
  });

  it("reads the key from the file named by <keyEnv>_FILE", () => {
    const config = loadConfig({
      ...sources(
        { [configPath]: serviceFile, "/run/keys/k": "from-file\n" },
        { OMP_CHANNEL_KEY_FILE: "/run/keys/k" },
      ),
    });
    assert.equal(config.service?.key, "from-file");
  });

  it("refuses a service without a key", () => {
    assert.throws(() => loadConfig(sources({ [configPath]: serviceFile })), /set OMP_CHANNEL_KEY/);
  });

  it("uses OMP_CHANNEL_CONFIG when set and fails if that file is missing", () => {
    assert.throws(
      () => loadConfig(sources({}, { OMP_CHANNEL_CONFIG: "/elsewhere/c.json" })),
      /does not exist/,
    );
    const config = loadConfig(
      sources(
        { "/elsewhere/c.json": JSON.stringify({ mcpServer: "other" }) },
        { OMP_CHANNEL_CONFIG: "/elsewhere/c.json" },
      ),
    );
    assert.equal(config.mcpServer, "other");
  });

  it("rejects invalid JSON and values outside the schema, with the path but not the value", () => {
    assert.throws(() => loadConfig(sources({ [configPath]: "{" })), /not valid JSON/);
    assert.throws(
      () => loadConfig(sources({ [configPath]: JSON.stringify({ limits: { maxPending: 0 } }) })),
      (error: unknown) =>
        error instanceof ConfigError && /\/limits\/maxPending/.test(error.message),
    );
    assert.throws(
      () => loadConfig(sources({ [configPath]: JSON.stringify({ unknownKey: 1 }) })),
      ConfigError,
    );
    assert.throws(
      () =>
        loadConfig(sources({ [configPath]: JSON.stringify({ delivery: { deliverAs: "now" } }) })),
      ConfigError,
    );
  });

  it("refuses a key or path that is not a valid environment variable name", () => {
    assert.throws(
      () =>
        loadConfig(
          sources({
            [configPath]: JSON.stringify({
              service: { url: "https://x.example.org", keyEnv: "lower" },
            }),
          }),
        ),
      ConfigError,
    );
  });
});

describe("parseServiceUrl", () => {
  it("accepts https and loopback http", () => {
    assert.equal(parseServiceUrl("https://chat.example.com/api").protocol, "https:");
    assert.equal(parseServiceUrl("http://127.0.0.1:8080/api").port, "8080");
  });

  it("refuses remote http, other schemes, invalid URLs and credentials", () => {
    assert.throws(() => parseServiceUrl("http://chat.example.com"), ConfigError);
    assert.throws(() => parseServiceUrl("ftp://chat.example.com"), ConfigError);
    assert.throws(() => parseServiceUrl("not a url"), ConfigError);
    assert.throws(() => parseServiceUrl("https://user:pw@chat.example.com"), ConfigError);
  });
});
