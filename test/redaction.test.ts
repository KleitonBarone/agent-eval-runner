import { describe, expect, it } from "vitest";

import { createRedactor } from "../src/redaction.js";

describe("credential redaction", () => {
  it("redacts configured values, bearer tokens, and credential assignments", () => {
    const redact = createRedactor(["known-secret"]);

    expect(
      redact(
        "known-secret Authorization: Bearer abc.def-123 API_KEY=visible-password normal text",
      ),
    ).toBe(
      "[REDACTED] Authorization: Bearer [REDACTED] API_KEY=[REDACTED] normal text",
    );
  });
});
