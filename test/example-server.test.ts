import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MCP_NOTIFICATION_METHOD, parseMcpNotification } from "../src/protocol.js";

const serverPath = fileURLToPath(new URL("../examples/mcp-server/server.mjs", import.meta.url));

describe("example MCP server", () => {
  it("answers initialize and pushes one valid message after initialized", async () => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
    const lines: string[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    const waitFor = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(predicate(), "expected output from the example server");
    };

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    );
    await waitFor(() => lines.some((line) => line.includes('"id":1')));
    const initialize = JSON.parse(lines.find((line) => line.includes('"id":1')) ?? "{}") as {
      result: { serverInfo: { name: string } };
    };
    assert.equal(initialize.result.serverInfo.name, "example-service-mcp");

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    await waitFor(() => lines.some((line) => line.includes(MCP_NOTIFICATION_METHOD)));
    const notification = JSON.parse(
      lines.find((line) => line.includes(MCP_NOTIFICATION_METHOD)) ?? "{}",
    ) as {
      method: string;
      params: unknown;
    };
    const parsed = parseMcpNotification(
      { server: "omp-channel", method: notification.method, params: notification.params },
      "omp-channel",
    );
    assert.equal(parsed?.ok, true);

    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
  });
});
