import { describe, expect, it } from "vitest";

import { scoreChecks } from "../src/scoring.js";

describe("deterministic scoring", () => {
  it("counts passing checks without model judgment", () => {
    expect(
      scoreChecks([
        { id: "test", status: "passed" },
        { id: "lint", status: "failed" },
      ]),
    ).toEqual({ passed: 1, total: 2, ratio: 0.5 });
  });

  it("reports a null ratio when a task has no checks", () => {
    expect(scoreChecks([])).toEqual({ passed: 0, total: 0, ratio: null });
  });
});
