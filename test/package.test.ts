import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  files: string[];
  publishConfig?: { access?: string; provenance?: boolean };
  engines: { node: string };
  repository: { url: string };
  license: string;
  omp: { extensions: string[] };
  scripts: Record<string, string>;
};

describe("package.json", () => {
  it("lists only files that exist in the repository or are produced by the build", () => {
    for (const entry of pkg.files) {
      if (entry === "dist") continue;
      assert.ok(existsSync(new URL(entry, root)), `files entry is missing: ${entry}`);
    }
  });

  it("does not publish tests, examples or personal files", () => {
    for (const entry of pkg.files) {
      assert.doesNotMatch(entry, /^(test|\.github|\.env|node_modules)/);
    }
  });

  it("publishes publicly with provenance", () => {
    assert.equal(pkg.publishConfig?.access, "public");
    assert.equal(pkg.publishConfig?.provenance, true);
  });

  it("declares the extension entry that the build produces", () => {
    assert.deepEqual(pkg.omp.extensions, ["./dist/index.js"]);
    assert.match(pkg.scripts.build ?? "", /tsc/);
  });

  it("declares license, Node range and repository", () => {
    assert.equal(pkg.license, "Apache-2.0");
    assert.match(pkg.engines.node, /^>=20/);
    assert.match(pkg.repository.url, /^git\+https:\/\/github\.com\/.+\.git$/);
  });

  it("builds before it is packed or published", () => {
    assert.match(pkg.scripts.prepack ?? "", /build/);
  });
});
