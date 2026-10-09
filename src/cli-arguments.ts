import { resolve } from "node:path";

export const CLI_USAGE = [
  "Usage:",
  "  agent-eval run --task <task.json> --output <result.json> [--keep-worktree]",
  "  agent-eval batch --batch <batch.json> --output-dir <new-directory>",
  "  agent-eval compare --input-dir <batch-directory> --output <report.json> --markdown <report.md>",
].join("\n");

export type CliArguments =
  | {
      operation: "run";
      taskPath: string;
      outputPath: string;
      keepWorktree: boolean;
    }
  | { operation: "batch"; batchPath: string; outputDirectory: string }
  | {
      operation: "compare";
      inputDirectory: string;
      outputPath: string;
      markdownPath: string;
    };

export function parseArguments(args: readonly string[]): CliArguments {
  const operation = args[0];
  if (operation !== "run" && operation !== "batch" && operation !== "compare")
    throw new Error(CLI_USAGE);
  const allowed =
    operation === "run"
      ? ["--task", "--output", "--keep-worktree"]
      : operation === "batch"
        ? ["--batch", "--output-dir"]
        : ["--input-dir", "--output", "--markdown"];
  const values = new Map<string, string>();
  let keepWorktree = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !allowed.includes(flag))
      throw new Error(`Unknown argument: ${flag ?? ""}\n${CLI_USAGE}`);
    if (values.has(flag) || (flag === "--keep-worktree" && keepWorktree))
      throw new Error(`Duplicate argument: ${flag}`);
    if (flag === "--keep-worktree") {
      keepWorktree = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--"))
      throw new Error(`Missing value: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  function path(flag: string): string {
    const value = values.get(flag);
    if (value === undefined)
      throw new Error(`Missing argument: ${flag}\n${CLI_USAGE}`);
    return resolve(value);
  }
  if (operation === "run")
    return {
      operation,
      taskPath: path("--task"),
      outputPath: path("--output"),
      keepWorktree,
    };
  if (operation === "batch")
    return {
      operation,
      batchPath: path("--batch"),
      outputDirectory: path("--output-dir"),
    };
  return {
    operation,
    inputDirectory: path("--input-dir"),
    outputPath: path("--output"),
    markdownPath: path("--markdown"),
  };
}
