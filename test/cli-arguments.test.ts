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
