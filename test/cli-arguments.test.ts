import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArguments } from "../src/cli-arguments.js";

describe("CLI arguments", () => {
  it("selects run, batch, and comparison operations", () => {
    expect(
      parseArguments([
        "run",
        "--task",
        "task.json",
        "--output",
        "result.json",
        "--keep-worktree",
      ]),
    ).toMatchObject({
      operation: "run",
      taskPath: resolve("task.json"),
      keepWorktree: true,
    });
    expect(
      parseArguments(["batch", "--batch", "batch.json", "--output-dir", "new"]),
    ).toMatchObject({ operation: "batch", outputDirectory: resolve("new") });
    expect(
      parseArguments([
        "compare",
        "--input-dir",
        "results",
        "--output",
        "report.json",
        "--markdown",
        "report.md",
      ]),
    ).toMatchObject({
      operation: "compare",
      markdownPath: resolve("report.md"),
    });
  });
  it("selects resource policy initialization, read-only inventory, and opt-in pool execution", () => {
    expect(
      parseArguments([
        "resources-init",
        "--root",
        "pool",
        "--policy",
        "policy.json",
      ]),
    ).toEqual({
      operation: "resources-init",
      root: resolve("pool"),
      policyPath: resolve("policy.json"),
    });
    expect(parseArguments(["inventory", "--root", "pool"])).toEqual({
      operation: "inventory",
      root: resolve("pool"),
    });
    expect(
      parseArguments([
        "run",
        "--task",
        "task.json",
        "--output",
        "result.json",
        "--resource-root",
        "pool",
      ]),
    ).toMatchObject({ resourceRoot: resolve("pool") });
    expect(() =>
      parseArguments(["inventory", "--root", "pool", "--delete"]),
    ).toThrow("Unknown argument");
  });
  it.each([
    ["run", "--task", "--output", "result.json"],
    ["run", "--task", "task.json", "--output"],
    [
      "batch",
      "--batch",
      "batch.json",
      "--batch",
      "other.json",
      "--output-dir",
      "new",
    ],
    ["compare", "--keep-worktree"],
    ["unknown"],
  ])(
    "rejects missing values, duplicates, and unsupported flags: %j",
    (...args) => {
      expect(() => parseArguments(args)).toThrow();
    },
  );
});
