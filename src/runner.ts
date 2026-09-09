import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { captureArtifact, type CapturedArtifact } from "./artifacts.js";
import { EventRecorder } from "./events.js";
import { runFakeAgent } from "./fake-agent.js";
import {
  capturePatch,
  prepareCheckout,
  removeCheckout,
  type PreparedCheckout,
} from "./git.js";
import { resolveInside } from "./paths.js";
import { runProcess, type ProcessResult } from "./process.js";
import { collectTaskSecrets, createRedactor } from "./redaction.js";
import {
  assertResultSpec,
  type CheckResult,
  type CommandResult,
  type ResultSpec,
} from "./result.js";
import { scoreChecks } from "./scoring.js";
import type { TaskSpec } from "./spec.js";

const RUNNER_VERSION = "0.1.0";
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface RunEvaluationOptions {
  readonly outputPath?: string;
  readonly keepWorktree?: boolean;
  readonly signal?: AbortSignal;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  redact: (value: string) => string,
): Record<string, string> | undefined {
  if (environment === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, redact(value)]),
  );
}

function sanitizeTask(
  task: TaskSpec,
  redact: (value: string) => string,
): TaskSpec {
  const actions: TaskSpec["adapter"]["actions"] = task.adapter.actions.map(
    (action) => {
      if (action.kind === "writeFile") {
        return {
          kind: "writeFile",
          path: redact(action.path),
          content: redact(action.content),
        };
      }
      const environment = sanitizeEnvironment(action.env, redact);
      return {
        kind: "runCommand",
        command: redact(action.command),
        args: action.args.map(redact),
        ...(action.cwd === undefined ? {} : { cwd: redact(action.cwd) }),
        ...(environment === undefined ? {} : { env: environment }),
      };
    },
  );
  const checks: TaskSpec["checks"] = task.checks.map((check) => {
    const environment = sanitizeEnvironment(check.env, redact);
    return {
      id: check.id,
      kind: check.kind,
      command: redact(check.command),
      args: check.args.map(redact),
      ...(check.cwd === undefined ? {} : { cwd: redact(check.cwd) }),
      ...(environment === undefined ? {} : { env: environment }),
      timeoutMs: check.timeoutMs,
    };
  });
  return {
    ...(task.$schema === undefined ? {} : { $schema: task.$schema }),
    schemaVersion: "1",
    id: task.id,
    repository: {
      path: redact(task.repository.path),
      revision: task.repository.revision,
    },
    prompt: redact(task.prompt),
    adapter: { kind: "fake", actions },
    budgets: { ...task.budgets },
    checks,
    artifacts: task.artifacts.map((artifact) => ({
      path: redact(artifact.path),
      mediaType: artifact.mediaType,
    })),
  };
}

function commandEvidence(
  id: string,
  cwd: string,
  result: ProcessResult,
): CommandResult {
  return {
    id,
    command: result.command,
    args: [...result.args],
    cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
    termination: result.termination,
    error: result.error,
  };
}

async function persistResult(path: string, result: ResultSpec): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${String(process.pid)}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, path);
}

export async function runEvaluation(
  task: TaskSpec,
  options: RunEvaluationOptions = {},
): Promise<ResultSpec> {
  const recorder = new EventRecorder();
  recorder.record({ type: "run.started" });
  const redact = createRedactor(collectTaskSecrets(task));
  const taskJson = JSON.stringify(task);
  const sanitizedTask = sanitizeTask(task, redact);
  const errors: string[] = [];
  const commands: CommandResult[] = [];
  const checks: CheckResult[] = [];
  const artifacts: CapturedArtifact[] = [];
  let checkout: PreparedCheckout | undefined;
  let resolvedRevision: string | null = null;
  let patchContent = "";
  let attemptOutcome: ResultSpec["attempt"]["outcome"] = "runner_error";
  let attemptDurationMs = 0;
  let commandCount = 0;
  let status: ResultSpec["status"] = "failed";
  let retainedWorkspacePath: string | null = null;

  try {
    checkout = await prepareCheckout(
      task.repository.path,
      task.repository.revision,
    );
    const workspace = checkout.path;
    resolvedRevision = checkout.revision;
    recorder.record({ type: "checkout.prepared", revision: checkout.revision });

    const attemptStartedAt = performance.now();
    const deadline = attemptStartedAt + task.budgets.wallClockMs;
    let skippedReason:
      "command_budget_exceeded" | "wall_clock_exceeded" | "cancelled" =
      "command_budget_exceeded";
    recorder.record({ type: "agent.started", adapter: "fake" });

    const execute = async (
      action: Extract<
        TaskSpec["adapter"]["actions"][number],
        { kind: "runCommand" }
      >,
    ): Promise<ProcessResult | null> => {
      if (options.signal?.aborted === true) {
        skippedReason = "cancelled";
        return null;
      }
      if (commandCount >= task.budgets.maxCommands) {
        skippedReason = "command_budget_exceeded";
        recorder.record({ type: "budget.exceeded", budget: "commands" });
        return null;
      }
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs <= 0) {
        skippedReason = "wall_clock_exceeded";
        recorder.record({ type: "budget.exceeded", budget: "wall_clock" });
        return null;
      }

      commandCount += 1;
      const id = `agent-${String(commandCount)}`;
      const relativeCwd = action.cwd ?? ".";
      const cwd = resolveInside(workspace, relativeCwd);
      recorder.record({
        type: "command.started",
        commandId: id,
        command: redact(action.command),
        args: action.args.map(redact),
      });
      const result = await runProcess(
        {
          command: action.command,
          args: action.args,
          cwd,
          ...(action.env === undefined ? {} : { env: action.env }),
          timeoutMs: remainingMs,
          timeoutTermination: "wall_clock",
          maxOutputBytes: task.budgets.maxOutputBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        redact,
      );
      commands.push(commandEvidence(id, relativeCwd, result));
      recorder.record({
        type: "command.finished",
        commandId: id,
        exitCode: result.exitCode,
        termination: result.termination,
      });
      if (result.termination === "wall_clock") {
        skippedReason = "wall_clock_exceeded";
        recorder.record({ type: "budget.exceeded", budget: "wall_clock" });
      } else if (result.termination === "cancelled") {
        skippedReason = "cancelled";
      }
      return result;
    };

    attemptOutcome = await runFakeAgent({
      workspace,
      actions: task.adapter.actions,
      execute,
      outcomeAfterSkippedCommand: () => skippedReason,
      deadline,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    attemptDurationMs =
      Math.round((performance.now() - attemptStartedAt) * 1_000) / 1_000;
    recorder.record({ type: "agent.finished", outcome: attemptOutcome });

    patchContent = await capturePatch(workspace);
    recorder.record({
      type: "patch.captured",
      bytes: Buffer.byteLength(patchContent),
    });

    for (const descriptor of task.artifacts) {
      try {
        const artifact = await captureArtifact(
          workspace,
          descriptor,
          task.budgets.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
          redact,
        );
        const sanitizedArtifact = { ...artifact, path: redact(artifact.path) };
        artifacts.push(sanitizedArtifact);
        recorder.record({
          type: "artifact.captured",
          path: sanitizedArtifact.path,
          bytes: sanitizedArtifact.bytes,
        });
      } catch (error) {
        errors.push(
          redact(error instanceof Error ? error.message : String(error)),
        );
      }
    }

    if (
      attemptOutcome !== "wall_clock_exceeded" &&
      attemptOutcome !== "cancelled"
    ) {
      for (const check of task.checks) {
        recorder.record({ type: "check.started", checkId: check.id });
        const relativeCwd = check.cwd ?? ".";
        const checkProcess = await runProcess(
          {
            command: check.command,
            args: check.args,
            cwd: resolveInside(workspace, relativeCwd),
            ...(check.env === undefined ? {} : { env: check.env }),
            timeoutMs: check.timeoutMs,
            timeoutTermination: "check_timeout",
            maxOutputBytes: task.budgets.maxOutputBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          redact,
        );
        const checkStatus = checkProcess.exitCode === 0 ? "passed" : "failed";
        checks.push({
          id: check.id,
          kind: check.kind,
          status: checkStatus,
          command: commandEvidence(
            `check-${check.id}`,
            relativeCwd,
            checkProcess,
          ),
        });
        recorder.record({
          type: "check.finished",
          checkId: check.id,
          status: checkStatus,
        });
      }
    }

    const score = scoreChecks(checks);
    recorder.record({
      type: "score.computed",
      passed: score.passed,
      total: score.total,
    });
    status =
      options.signal?.aborted === true ||
      attemptOutcome === "wall_clock_exceeded" ||
      attemptOutcome === "cancelled"
        ? "interrupted"
        : attemptOutcome === "completed" &&
            checks.every(
              ({ status: checkStatus }) => checkStatus === "passed",
            ) &&
            errors.length === 0
          ? "succeeded"
          : "failed";
  } catch (error) {
    errors.push(redact(error instanceof Error ? error.message : String(error)));
    attemptOutcome =
      options.signal?.aborted === true ? "cancelled" : "runner_error";
    status = options.signal?.aborted === true ? "interrupted" : "failed";
  }

  if (checkout !== undefined) {
    if (options.keepWorktree === true) {
      retainedWorkspacePath = checkout.path;
    } else {
      try {
        await removeCheckout(checkout);
      } catch (error) {
        retainedWorkspacePath = checkout.path;
        errors.push(
          redact(error instanceof Error ? error.message : String(error)),
        );
        status = "failed";
      }
    }
  }

  recorder.record({ type: "run.finished", status });
  const score = scoreChecks(checks);
  const redactedPatchContent = redact(patchContent);
  const patchBytes = Buffer.byteLength(redactedPatchContent);
  const result: ResultSpec = {
    $schema: "https://agent-eval-runner.dev/schemas/result-v1.schema.json",
    schemaVersion: "1",
    runner: {
      name: "agent-eval-runner",
      version: RUNNER_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    task: sanitizedTask,
    taskSha256: sha256(taskJson),
    status,
    source: {
      repositoryPath: redact(task.repository.path),
      requestedRevision: task.repository.revision,
      resolvedRevision,
    },
    attempt: {
      adapter: "fake",
      outcome: attemptOutcome,
      durationMs: attemptDurationMs,
      commandCount,
    },
    commands,
    patch: {
      bytes: patchBytes,
      originalBytes: Buffer.byteLength(patchContent),
      sha256: sha256(redactedPatchContent),
      originalSha256: sha256(patchContent),
      redacted: redactedPatchContent !== patchContent,
      content: redactedPatchContent,
    },
    artifacts,
    checks,
    score,
    events: recorder.events,
    errors,
    workspace: {
      retained: retainedWorkspacePath !== null,
      path: retainedWorkspacePath,
    },
  };
  assertResultSpec(result);
  if (options.outputPath !== undefined)
    await persistResult(options.outputPath, result);
  return result;
}
