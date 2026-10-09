import { describe, expect, it } from "vitest";

import { scoreChecks } from "../src/scoring.js";

describe("deterministic scoring", () => {
  it("counts passing checks without model judgment", () => {
    expect(
      scoreChecks([
        { id: "test", status: "passed" },
        { id: "lint", status: "failed" },
      ]),
    ).toEqual({
      version: "2",
      passed: 1,
      failed: 1,
      skipped: 0,
      total: 2,
      ratio: 0.5,
    });
  });

  it("reports a null ratio when a task has no checks", () => {
    expect(scoreChecks([])).toEqual({
      version: "2",
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      ratio: null,
    });
  });

  it("keeps skipped checks in the denominator", () => {
    expect(
      scoreChecks([
        { id: "test", status: "passed" },
        { id: "lint", status: "skipped" },
      ]),
    ).toEqual({
      version: "2",
      passed: 1,
      failed: 0,
      skipped: 1,
      total: 2,
      ratio: 0.5,
    });
  });
});
