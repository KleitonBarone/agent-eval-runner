import { readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { Value } from "@sinclair/typebox/value";

import {
  parseBatchIndex,
  type BatchEntry,
  type BatchIndex,
} from "./batch-spec.js";
import {
  ComparisonSpecSchema,
  type ComparisonSpec,
  type FinishedComparisonRow,
} from "./comparison-spec.js";
import { canonicalJson, sha256 } from "./identity.js";
import { executionIdentity } from "./execution-spec.js";
import type { ExecutionEvidence } from "./execution-spec.js";
import { resolveInside } from "./paths.js";
import { writeAtomic, writeJsonAtomic } from "./persistence.js";
import { parseResultSpec, type ResultSpec } from "./result.js";
import { scoreChecks } from "./scoring.js";
import { totalMetric, type UsageMetric } from "./usage.js";

function verifyResult(
  result: ResultSpec,
  entry: Extract<BatchEntry, { state: "finished" }>,
  comparisonSha256: string,
): void {
  const configuredExecution = executionIdentity(result.task.execution);
  if (
    configuredExecution.kind !== result.execution.kind ||
    (result.execution.kind === "docker" &&
      (result.task.execution?.kind !== "docker" ||
        result.execution.requestedImage !== result.task.execution.image))
  )
    throw new Error(`Execution identity does not match task for ${entry.id}`);
  if (result.comparisonSha256 !== comparisonSha256)
    throw new Error(`Incompatible task inputs for ${entry.id}`);
  if (
    result.attempt.id !== entry.id ||
    result.attempt.configurationId !== entry.configurationId ||
    result.attempt.repetition !== entry.repetition ||
    result.adapterSha256 !== entry.adapterSha256
  ) {
    throw new Error(`Attempt identity does not match the index: ${entry.id}`);
  }
  if (
    result.checks.length !== result.task.checks.length ||
    result.checks.some(
      (check, position) =>
        check.id !== result.task.checks[position]?.id ||
        check.kind !== result.task.checks[position].kind,
    )
  ) {
    throw new Error(`Incomplete check evidence for ${entry.id}`);
  }
  if (
    canonicalJson(result.score) !== canonicalJson(scoreChecks(result.checks))
  ) {
    throw new Error(`Inconsistent score for ${entry.id}`);
  }
  if (
    result.source.resolvedRevision !== null &&
    result.source.resolvedRevision.toLowerCase() !==
      result.source.requestedRevision.toLowerCase()
  ) {
    throw new Error(`Requested and resolved commits differ for ${entry.id}`);
  }
}

function executionRuntime(execution: ExecutionEvidence) {
  return execution.kind === "local"
    ? execution
    : {
        kind: execution.kind,
        policyVersion: execution.policyVersion,
        imageId: execution.imageId,
        architecture: execution.architecture,
        node: execution.node,
        engineVersion: execution.engineVersion,
        uid: execution.uid,
        gid: execution.gid,
      };
}

export function createComparison(
  index: BatchIndex,
  results: ReadonlyMap<string, ResultSpec>,
): ComparisonSpec {
  parseBatchIndex(index);
  const rows: ComparisonSpec["rows"] = index.attempts.map((entry) => {
    if (entry.state !== "finished") return entry;
    const result = results.get(entry.id);
    if (result === undefined) throw new Error(`Missing result for ${entry.id}`);
    parseResultSpec(result);
    verifyResult(result, entry, index.comparisonSha256);
    return {
      state: "finished",
      id: entry.id,
      configurationId: entry.configurationId,
      repetition: entry.repetition,
      resultFile: entry.resultFile,
      resultSha256: entry.resultSha256,
      taskSha256: result.taskSha256,
      adapterSha256: result.adapterSha256,
      adapter: result.task.adapter,
      runner: result.runner,
      source: result.source,
      execution: result.execution,
      safety: result.safety,
      status: result.status,
      outcome: result.attempt.outcome,
      score: result.score,
      checks: result.checks.map((check) =>
        check.status === "skipped"
          ? {
              id: check.id,
              kind: check.kind,
              status: check.status,
              reason: check.reason,
            }
          : { id: check.id, kind: check.kind, status: check.status },
      ),
      durationMs: result.attempt.durationMs,
      commandCount: result.attempt.commandCount,
      patchBytes: result.patch.captured ? result.patch.originalBytes : null,
      usage: result.usage,
      errors: result.errors,
    };
  });
  const finished = rows.filter(
    (row): row is FinishedComparisonRow => row.state === "finished",
  );
  const uncertainUsage = rows.some(
    ({ state }) => state === "running" || state === "persistence_failed",
  );
  const uncertainty: UsageMetric[] = uncertainUsage
    ? [
        {
          status: "unknown",
          reason: "Some started attempts have no finalized result",
        },
      ]
    : [];
  const warnings: string[] = [];
  const first = finished[0];
  if (
    first !== undefined &&
    finished.some(
      ({ runner, execution }) =>
        canonicalJson(runner) !== canonicalJson(first.runner) ||
        canonicalJson(executionRuntime(execution)) !==
          canonicalJson(executionRuntime(first.execution)),
    )
  ) {
    warnings.push(
      "Runtime identities differ. Durations and executable behavior may not be comparable.",
    );
  }
  if (index.state !== "completed")
    warnings.push(
      `Batch state is ${index.state}; some attempts may be unfinished.`,
    );
  const report: ComparisonSpec = {
    schemaVersion: "4",
    batchId: index.id,
    comparisonSha256: index.comparisonSha256,
    scoringVersion: "2",
    rows,
    summary: {
      scheduled: rows.length,
      finished: finished.length,
      succeeded: finished.filter(({ status }) => status === "succeeded").length,
      failed: finished.filter(({ status }) => status === "failed").length,
      interrupted: finished.filter(({ status }) => status === "interrupted")
        .length,
      notStarted: rows.filter(({ state }) => state === "not_started").length,
      pending: rows.filter(({ state }) => state === "pending").length,
      running: rows.filter(({ state }) => state === "running").length,
      persistenceFailed: rows.filter(
        ({ state }) => state === "persistence_failed",
      ).length,
      usage: {
        modelTokens: totalMetric([
          ...finished.map(({ usage }) => usage.modelTokens),
          ...uncertainty,
        ]),
        modelCostUsd: totalMetric([
          ...finished.map(({ usage }) => usage.modelCostUsd),
          ...uncertainty,
        ]),
      },
    },
    warnings,
  };
  if (!Value.Check(ComparisonSpecSchema, report))
    throw new Error("Invalid comparison report");
  return report;
}

// Treat declared result paths as untrusted data, including symlinks.
async function resultPath(root: string, requested: string): Promise<string> {
  const target = await realpath(resolveInside(root, requested));
  const relation = relative(root, target);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error(
      `Result file resolves outside the input directory: ${requested}`,
    );
  }
  return target;
}

export async function readComparison(
  inputDirectory: string,
): Promise<ComparisonSpec> {
  const root = await realpath(inputDirectory);
  const rawIndex: unknown = JSON.parse(
    await readFile(await resultPath(root, "batch-index.json"), "utf8"),
  );
  const index = parseBatchIndex(rawIndex);
  const results = new Map<string, ResultSpec>();
  for (const entry of index.attempts) {
    if (entry.state !== "finished") continue;
    const contents = await readFile(
      await resultPath(root, entry.resultFile),
      "utf8",
    );
    if (sha256(contents) !== entry.resultSha256)
      throw new Error(`Result digest mismatch: ${entry.id}`);
    const rawResult: unknown = JSON.parse(contents);
    results.set(entry.id, parseResultSpec(rawResult));
  }
  return createComparison(index, results);
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replace(/([|`*_[\]])/gu, "\\$1")
    .replace(/[\r\n]+/gu, " ");
}

function formatMetric(metric: UsageMetric): string {
  return metric.status === "known" ? String(metric.value) : "unknown";
}

export function renderMarkdown(report: ComparisonSpec): string {
  const lines = [
    `# ${escapeMarkdown(report.batchId)}`,
    "",
    `Comparison digest: ${report.comparisonSha256}`,
    "",
    "Score version 2 counts all declared checks. Patch bytes are the original bytes before redaction.",
    "",
    "| Attempt | Configuration | Repeat | Outcome | Passed | Failed | Skipped | Score | Duration ms | Commands | Tokens | Cost USD | Patch bytes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const values =
      row.state === "finished"
        ? [
            row.id,
            row.configurationId,
            row.repetition,
            `${row.status}: ${row.outcome}`,
            row.score.passed,
            row.score.failed,
            row.score.skipped,
            row.score.ratio ?? "n/a",
            row.durationMs,
            row.commandCount,
            formatMetric(row.usage.modelTokens),
            formatMetric(row.usage.modelCostUsd),
            row.patchBytes ?? "unknown",
          ]
        : [
            row.id,
            row.configurationId,
            row.repetition,
            row.state,
            "n/a",
            "n/a",
            "n/a",
            "n/a",
            "n/a",
            "n/a",
            "unknown",
            "unknown",
            "unknown",
          ];
    lines.push(
      `| ${values.map((value) => escapeMarkdown(String(value))).join(" | ")} |`,
    );
  }
  lines.push(
    "",
    `${String(report.summary.finished)} of ${String(report.summary.scheduled)} attempts finished. Model tokens: ${formatMetric(report.summary.usage.modelTokens)}. Model cost USD: ${formatMetric(report.summary.usage.modelCostUsd)}.`,
    "",
    "## Attempt details",
    "",
  );
  for (const row of report.rows) {
    lines.push(`### ${escapeMarkdown(row.id)}`, "");
    if (row.state === "finished") {
      lines.push(
        `Runtime: ${escapeMarkdown(canonicalJson(row.runner))}`,
        "",
        `Execution: ${escapeMarkdown(canonicalJson(row.execution))}`,
        "",
        `Safety policy: ${escapeMarkdown(canonicalJson(row.safety))}`,
        "",
        `Adapter digest: ${row.adapterSha256}`,
        "",
        "```json",
        JSON.stringify(row.adapter, null, 2).replaceAll("`", "\\u0060"),
        "```",
        "",
      );
      for (const error of row.errors) lines.push(`- ${escapeMarkdown(error)}`);
      for (const check of row.checks)
        lines.push(
          `- Check ${escapeMarkdown(check.id)} (${check.kind}): ${check.status}${check.status === "skipped" ? ` (${check.reason})` : ""}`,
        );
    } else if (row.state === "not_started") {
      lines.push(`Reason: ${row.reason}`);
    } else if (row.state === "persistence_failed") {
      lines.push(`Error: ${escapeMarkdown(row.error)}`);
    }
    lines.push("");
  }
  for (const warning of report.warnings)
    lines.push(`Warning: ${escapeMarkdown(warning)}`, "");
  return `${lines.join("\n")}\n`;
}

// Resolve existing parents too, so aliases cannot overwrite input evidence.
async function canonicalDestination(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalDestination(parent), basename(absolute));
  }
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export async function writeComparison(
  inputDirectory: string,
  outputPath: string,
  markdownPath: string,
): Promise<ComparisonSpec> {
  const jsonTarget = pathIdentity(await canonicalDestination(outputPath));
  const markdownTarget = pathIdentity(await canonicalDestination(markdownPath));
  if (jsonTarget === markdownTarget)
    throw new Error("JSON and Markdown output paths must differ");
  const report = await readComparison(inputDirectory);
  const inputRoot = await realpath(inputDirectory);
  const inputs = new Set(
    (
      await Promise.all(
        [
          "batch-index.json",
          ...report.rows.flatMap((row) =>
            row.state === "finished" ? [row.resultFile] : [],
          ),
        ].map((path) => resultPath(inputRoot, path)),
      )
    ).map(pathIdentity),
  );
  if (inputs.has(jsonTarget) || inputs.has(markdownTarget)) {
    throw new Error("Reports cannot overwrite batch evidence");
  }
  await writeJsonAtomic(outputPath, report);
  await writeAtomic(markdownPath, renderMarkdown(report));
  return report;
}
