import { describe, expect, it } from "vitest";

import { parseTaskSpec } from "../src/spec.js";

describe("task specification", () => {
  it("accepts version 1 and rejects a symbolic Git revision", () => {
    const valid = {
      schemaVersion: "1",
      id: "schema-test",
      repository: {
        path: "/trusted/repository",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
      prompt: "Create result.txt",
      adapter: { kind: "fake", actions: [] },
      budgets: { wallClockMs: 1_000, maxCommands: 1, maxOutputBytes: 1_024 },
      checks: [],
      artifacts: [],
    };

    expect(parseTaskSpec(valid)).toEqual(valid);
    expect(() =>
      parseTaskSpec({
        ...valid,
        repository: { ...valid.repository, revision: "HEAD" },
      }),
    ).toThrow(/revision/);
  });
});
