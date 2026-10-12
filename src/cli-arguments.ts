import { resolve } from "node:path";

export const CLI_USAGE = [
  "Usage:",
  "  agent-eval run --task <task.json> --output <result.json> [--keep-worktree] [--resource-root <pool>]",
  "  agent-eval batch --batch <batch.json> --output-dir <new-directory> [--resource-root <pool>]",
  "  agent-eval compare --input-dir <batch-directory> --output <report.json> --markdown <report.md>",
  "  agent-eval resources-init --root <new-pool> --policy <resource-policy.json>",
  "  agent-eval inventory --root <pool>",
].join("\n");

export type CliArguments =
  | {
      operation: "run";
      taskPath: string;
      outputPath: string;
      keepWorktree: boolean;
      resourceRoot?: string;
    }
  | {
      operation: "batch";
      batchPath: string;
      outputDirectory: string;
      resourceRoot?: string;
    }
  | { operation: "resources-init"; root: string; policyPath: string }
  | { operation: "inventory"; root: string }
  | {
      operation: "compare";
      inputDirectory: string;
      outputPath: string;
      markdownPath: string;
    };

export function parseArguments(args: readonly string[]): CliArguments {
  const operation = args[0];
  if (
    operation !== "run" &&
    operation !== "batch" &&
    operation !== "compare" &&
    operation !== "resources-init" &&
    operation !== "inventory"
  )
    throw new Error(CLI_USAGE);
  const allowed =
    operation === "run"
      ? ["--task", "--output", "--keep-worktree", "--resource-root"]
      : operation === "batch"
        ? ["--batch", "--output-dir", "--resource-root"]
        : operation === "compare"
          ? ["--input-dir", "--output", "--markdown"]
          : operation === "resources-init"
            ? ["--root", "--policy"]
            : ["--root"];
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
  const resourceRoot = values.get("--resource-root");
  const resources =
    resourceRoot === undefined ? {} : { resourceRoot: resolve(resourceRoot) };
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
      ...resources,
    };
  if (operation === "batch")
    return {
      operation,
      batchPath: path("--batch"),
      outputDirectory: path("--output-dir"),
      ...resources,
    };
  if (operation === "resources-init")
    return { operation, root: path("--root"), policyPath: path("--policy") };
  if (operation === "inventory") return { operation, root: path("--root") };
  return {
    operation,
    inputDirectory: path("--input-dir"),
    outputPath: path("--output"),
    markdownPath: path("--markdown"),
  };
}
