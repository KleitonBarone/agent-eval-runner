#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { runBatch } from "./batch.js";
import { parseBatchSpec } from "./batch-spec.js";
import { CLI_USAGE, parseArguments } from "./cli-arguments.js";
import { readComparison, writeComparison } from "./comparison.js";
import { runEvaluation } from "./runner.js";
import { parseTaskSpec } from "./spec.js";
import {
  createResourcePool,
  readResourceInventory,
  ResourceAdmissionError,
} from "./resources.js";
import { parseResourcePolicy } from "./resources-spec.js";
import type { ResourceInventory } from "./resources-spec.js";
import { readBoundedFile } from "./workspace.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${CLI_USAGE}\n`);
    return;
  }
  const arguments_ = parseArguments(args);
  if (
    arguments_.operation === "inventory" ||
    arguments_.operation === "resources-init"
  ) {
    let inventory: ResourceInventory;
    if (arguments_.operation === "inventory") {
      inventory = await readResourceInventory(arguments_.root);
    } else {
      const input: unknown = JSON.parse(
        (
          await readBoundedFile(
            dirname(arguments_.policyPath),
            basename(arguments_.policyPath),
            16 * 1024,
          )
        ).toString("utf8"),
      );
      inventory = await createResourcePool(
        arguments_.root,
        parseResourcePolicy(input),
      );
    }
    process.stdout.write(`${JSON.stringify(inventory)}\n`);
    return;
  }
  if (arguments_.operation === "compare") {
    const report = await writeComparison(
      arguments_.inputDirectory,
      arguments_.outputPath,
      arguments_.markdownPath,
    );
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: "1", finished: report.summary.finished, output: arguments_.outputPath, markdown: arguments_.markdownPath })}\n`,
    );
    return;
  }
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (arguments_.operation === "run") {
      const input: unknown = JSON.parse(
        await readFile(arguments_.taskPath, "utf8"),
      );
      const result = await runEvaluation(parseTaskSpec(input), {
        outputPath: arguments_.outputPath,
        keepWorktree: arguments_.keepWorktree,
        signal: controller.signal,
        ...(arguments_.resourceRoot === undefined
          ? {}
          : { resourceRoot: arguments_.resourceRoot }),
      });
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: "1", status: result.status, output: arguments_.outputPath })}\n`,
      );
      process.exitCode =
        result.status === "succeeded"
          ? 0
          : result.status === "interrupted"
            ? 130
            : 1;
    } else {
      const input: unknown = JSON.parse(
        await readFile(arguments_.batchPath, "utf8"),
      );
      const index = await runBatch(parseBatchSpec(input), {
        outputDirectory: arguments_.outputDirectory,
        signal: controller.signal,
        ...(arguments_.resourceRoot === undefined
          ? {}
          : { resourceRoot: arguments_.resourceRoot }),
      });
      const report = await readComparison(arguments_.outputDirectory);
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: "1", state: index.state, index: join(arguments_.outputDirectory, "batch-index.json"), summary: report.summary })}\n`,
      );
      process.exitCode =
        index.state === "cancelled"
          ? 130
          : index.state === "failed" ||
              report.summary.failed > 0 ||
              report.summary.interrupted > 0
            ? 1
            : 0;
    }
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ResourceAdmissionError) {
    process.stdout.write(`${JSON.stringify(error.decision)}\n`);
    process.exitCode =
      error.decision.reason === "cancelled"
        ? 130
        : error.decision.reason === "capacity"
          ? 1
          : 2;
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
