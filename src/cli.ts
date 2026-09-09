#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runEvaluation } from "./runner.js";
import { parseTaskSpec } from "./spec.js";

interface CliArguments {
  readonly taskPath: string;
  readonly outputPath: string;
  readonly keepWorktree: boolean;
}

function usage(): string {
  return "Usage: agent-eval run --task <task.json> --output <result.json> [--keep-worktree]";
}

function parseArguments(args: readonly string[]): CliArguments {
  if (args[0] !== "run") throw new Error(usage());
  let taskPath: string | undefined;
  let outputPath: string | undefined;
  let keepWorktree = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-worktree") {
      keepWorktree = true;
    } else if (argument === "--task") {
      taskPath = args[index + 1];
      index += 1;
    } else if (argument === "--output") {
      outputPath = args[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}\n${usage()}`);
    }
  }
  if (taskPath === undefined || outputPath === undefined)
    throw new Error(usage());
  return {
    taskPath: resolve(taskPath),
    outputPath: resolve(outputPath),
    keepWorktree,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const rawTask: unknown = JSON.parse(
    await readFile(arguments_.taskPath, "utf8"),
  );
  const task = parseTaskSpec(rawTask);
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const result = await runEvaluation(task, {
    outputPath: arguments_.outputPath,
    keepWorktree: arguments_.keepWorktree,
    signal: controller.signal,
  });
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  process.stdout.write(
    `${JSON.stringify({ status: result.status, output: arguments_.outputPath })}\n`,
  );
  process.exitCode =
    result.status === "succeeded"
      ? 0
      : result.status === "interrupted"
        ? 130
        : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
