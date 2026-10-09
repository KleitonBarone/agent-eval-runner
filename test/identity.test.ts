import { describe, expect, it } from "vitest";

import { canonicalJson, comparisonDigest } from "../src/identity.js";
import { batchFor } from "./helpers/batch.js";

describe("comparison identity", () => {
  it("canonicalizes object keys while retaining ordered arrays", () => {
    expect(canonicalJson({ b: 2, a: { z: 1, y: [3, 2] } })).toBe(
      canonicalJson({ a: { y: [3, 2], z: 1 }, b: 2 }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
  it("ignores labels and adapters but includes effective budgets and check inputs", () => {
    const task = batchFor({
      path: process.cwd(),
      revision: "a".repeat(40),
    }).task;
    expect(comparisonDigest({ ...task, id: "different-label" })).toBe(
      comparisonDigest(task),
    );
    expect(
      comparisonDigest({
        ...task,
        budgets: { ...task.budgets, maxArtifactBytes: 1_048_576 },
      }),
    ).toBe(comparisonDigest(task));
    expect(
      comparisonDigest({
        ...task,
        budgets: { ...task.budgets, maxCommands: 9 },
      }),
    ).not.toBe(comparisonDigest(task));
    expect(comparisonDigest({ ...task, checks: [] })).not.toBe(
      comparisonDigest(task),
    );
  });
});
