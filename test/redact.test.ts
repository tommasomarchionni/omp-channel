import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanReason, MAX_REASON_LENGTH } from "../src/redact.js";

describe("cleanReason", () => {
  it("keeps an ordinary provider error", () => {
    const raw = "404 The model 'tiny:Q4' is downloaded but not loaded (type=not_found_error)";
    assert.equal(cleanReason(raw), raw);
  });

  it("writes it on one line without control characters", () => {
    assert.equal(cleanReason("a\n\tb\u0007c\u2028d"), "a b c d");
    assert.equal(cleanReason(" \n "), undefined);
  });

  it("hides the common shapes of secrets", () => {
    const secrets = [
      "sk-abc123def456ghi789",
      "ghp_abcdefghijklmnopqrstuvwx",
      "hf_abcdefghijklmnopqrstuvwx",
      "AKIAABCDEFGHIJKLMNOP",
      "Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZg",
    ];
    for (const secret of secrets) {
      const cleaned = cleanReason(`failed with ${secret} here`) ?? "";
      assert.ok(!cleaned.includes(secret), secret);
      assert.match(cleaned, /^failed with \[hidden\] here$/);
    }
  });

  it("hides credentials in headers, addresses and assignments", () => {
    const cleaned =
      cleanReason(
        "GET https://ann:pw123@host.test/v1?key=abc123 Authorization: Bearer abc.def.ghi api_key=zzz999",
      ) ?? "";
    for (const secret of ["pw123", "abc123", "abc.def.ghi", "zzz999"]) {
      assert.ok(!cleaned.includes(secret), `${secret} in ${cleaned}`);
    }
    assert.match(cleaned, /host\.test/);
  });

  it("hides the name of the home folder", () => {
    assert.equal(
      cleanReason("cannot open /Users/ann/models/x.gguf and /home/bob/y"),
      "cannot open ~/models/x.gguf and ~/y",
    );
    assert.equal(cleanReason("at C:\\Users\\ann\\x"), "at ~\\x");
  });

  it("cuts a long text after hiding secrets", () => {
    const cleaned = cleanReason(`${"é".repeat(MAX_REASON_LENGTH - 5)} sk-abc123def456ghi789`);
    assert.equal([...(cleaned ?? "")].length <= MAX_REASON_LENGTH, true);
    assert.ok(!cleaned?.includes("sk-abc"));
  });
});
