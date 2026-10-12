import { randomUUID } from "node:crypto";

import { captureArtifact, type CapturedArtifact } from "./artifacts.js";
import { EventRecorder } from "./events.js";
import { createExecutionBackend, type ExecutionBackend } from "./execution.js";
import { initialExecutionEvidence } from "./execution-spec.js";
import { runFakeAgent } from "./fake-agent.js";
import {
  capturePatch,
  prepareCheckout,
  removeCheckout,
  type PreparedCheckout,
} from "./git.js";
import {
  canonicalJson,
  comparisonDigest,
  DEFAULT_MAX_ARTIFACT_BYTES,
  sha256,
} from "./identity.js";
import { resolveInside } from "./paths.js";
import { writeJsonAtomic } from "./persistence.js";
import type { ProcessResult } from "./process.js";
import {
  collectTaskSecrets,
  createRedactor,
  type Redactor,
} from "./redaction.js";
import {
  assertResultSpec,
  type CheckResult,
  type CommandResult,
  type ResultSpec,
} from "./result.js";
import { scoreChecks } from "./scoring.js";
import { parseTaskSpec, type TaskSpec } from "./spec.js";
import { fakeUsage } from "./usage.js";
import { SAFETY_POLICY, SafetyDeadline } from "./safety.js";

export interface RunEvaluationOptions {
  readonly outputPath?: string;
  readonly keepWorktree?: boolean;
  readonly signal?: AbortSignal;
  readonly attemptId?: string;
  readonly configurationId?: string;
  readonly repetition?: number;
}

function sanitizeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  redact: Redactor,
) {
  if (environment === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, redact(value)]),
  );
}

function sanitizeTask(task: TaskSpec, redact: Redactor): TaskSpec {
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
    ...(task.execution === undefined
      ? {}
      : { execution: { ...task.execution } }),
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
  return { ...result, id, args: [...result.args], cwd };
}

// Each phase can fail without preventing later evidence collection or cleanup.
export async function runEvaluation(
  taskInput: TaskSpec,
  options: RunEvaluationOptions = {},
): Promise<ResultSpec> {
  const task = parseTaskSpec(taskInput);
  const recorder = new EventRecorder();
  recorder.record({ type: "run.started" });
  const redact = createRedactor(collectTaskSecrets(task));
  const errors: string[] = [];
  const addError = (phase: string, error: unknown): void => {
    errors.push(
      `${phase}: ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  };
  const commands: CommandResult[] = [];
  const checks: CheckResult[] = [];
  const artifacts: CapturedArtifact[] = [];
  let checkout: PreparedCheckout | undefined;
  let backend: ExecutionBackend | undefined;
  let executionPrepared = false;
  const execution = initialExecutionEvidence(task.execution);
  let attemptOutcome: ResultSpec["attempt"]["outcome"] = "runner_error";
  let attemptDurationMs = 0;
  let commandCount = 0;
  let patchContent = "";
  let redactedPatch = "";
  let patchCaptured = false;
  let retainWorkspace = false;
  const preparationDeadline = new SafetyDeadline(undefined, options.signal);

  if (options.signal?.aborted === true) {
    attemptOutcome = "cancelled";
  } else {
    try {
      checkout = await prepareCheckout(
        task.repository.path,
        task.repository.revision,
        preparationDeadline,
      );
      recorder.record({
        type: "checkout.prepared",
        revision: checkout.revision,
      });
    } catch (error) {
      if (preparationDeadline.signal?.aborted === true)
        attemptOutcome = "cancelled";
      addError("checkout", error);
    }
  }

  if (checkout !== undefined) {
    backend = createExecutionBackend(
      task.execution,
      checkout,
      execution,
      redact,
    );
    try {
      await backend.prepare(preparationDeadline);
      executionPrepared = true;
      recorder.record({
        type: "execution.prepared",
        kind: execution.kind,
        policyVersion: execution.policyVersion,
      });
    } catch (error) {
      if (options.signal?.aborted === true) attemptOutcome = "cancelled";
      addError("execution", error);
    }
  }

  if (checkout !== undefined && backend !== undefined && executionPrepared) {
    const executor = backend;
    const workspace = checkout.path;
    const startedAt = performance.now();
    const deadline = startedAt + task.budgets.wallClockMs;
    let skippedReason:
      "command_budget_exceeded" | "wall_clock_exceeded" | "cancelled" =
      "command_budget_exceeded";
    recorder.record({ type: "agent.started", adapter: "fake" });
    try {
      attemptOutcome = await runFakeAgent({
        writeFile: (action) =>
          executor.writeFile(
            action.path,
            action.content,
            Math.max(1, Math.floor(deadline - performance.now())),
            options.signal,
          ),
        actions: task.adapter.actions,
        deadline,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        outcomeAfterSkippedCommand: () => skippedReason,
        execute: async (action) => {
          if (options.signal?.aborted === true) {
            skippedReason = "cancelled";
            return null;
          }
          const remainingMs = Math.floor(deadline - performance.now());
          if (remainingMs <= 0) {
            skippedReason = "wall_clock_exceeded";
            return null;
          }
          if (commandCount >= task.budgets.maxCommands) {
            skippedReason = "command_budget_exceeded";
            return null;
          }
          const relativeCwd = action.cwd ?? ".";
          const cwd = resolveInside(workspace, relativeCwd);
          commandCount += 1;
          const id = `agent-${String(commandCount)}`;
          recorder.record({
            type: "command.started",
            commandId: id,
            command: redact(action.command),
            args: action.args.map(redact),
          });
          const result = await executor.execute({
            command: action.command,
            args: action.args,
            cwd,
            ...(action.env === undefined ? {} : { env: action.env }),
            timeoutMs: remainingMs,
            timeoutTermination: "wall_clock",
            maxOutputBytes: task.budgets.maxOutputBytes,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          commands.push(commandEvidence(id, redact(relativeCwd), result));
          recorder.record({
            type: "command.finished",
            commandId: id,
            exitCode: result.exitCode,
            termination: result.termination,
          });
          return result;
        },
      });
    } catch (error) {
      attemptOutcome = "runner_error";
      addError("agent", error);
    } finally {
      attemptDurationMs =
        Math.round((performance.now() - startedAt) * 1000) / 1000;
      if (
        attemptOutcome === "wall_clock_exceeded" ||
        attemptOutcome === "command_budget_exceeded"
      ) {
        recorder.record({
          type: "budget.exceeded",
          budget:
            attemptOutcome === "wall_clock_exceeded"
              ? "wall_clock"
              : "commands",
        });
      }
      recorder.record({ type: "agent.finished", outcome: attemptOutcome });
    }

    // Cancellation stops execution, not the collection of surviving evidence.
    const captureDeadline = new SafetyDeadline();
    try {
      await executor.synchronize(captureDeadline);
      const capturedPatch = await capturePatch(checkout, captureDeadline);
      const sanitizedPatch = redact(capturedPatch);
      if (Buffer.byteLength(sanitizedPatch) > SAFETY_POLICY.patchBytes)
        throw new Error("Redacted patch byte limit exceeded");
      patchContent = capturedPatch;
      redactedPatch = sanitizedPatch;
      patchCaptured = true;
      recorder.record({
        type: "patch.captured",
        bytes: Buffer.byteLength(patchContent),
      });
    } catch (error) {
      retainWorkspace = true;
      addError("patch", error);
    }
    let artifactBytes = 0;
    for (const descriptor of task.artifacts) {
      try {
        if (!executor.quiescent)
          throw new Error(
            "Cannot capture artifacts while container processes may be running",
          );
        const artifact = await captureArtifact(
          executor.workspace,
          descriptor,
          Math.min(
            task.budgets.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
            SAFETY_POLICY.totalArtifactBytes - artifactBytes,
          ),
          redact,
          captureDeadline,
        );
        artifactBytes += Math.max(artifact.bytes, artifact.originalBytes);
        artifacts.push({ ...artifact, path: redact(artifact.path) });
        recorder.record({
          type: "artifact.captured",
          path: redact(artifact.path),
          bytes: artifact.bytes,
        });
      } catch (error) {
        retainWorkspace = true;
        addError("artifact", error);
      }
    }
  }

  for (const check of task.checks) {
    const skipReason =
      options.signal?.aborted === true || attemptOutcome === "cancelled"
        ? "cancelled"
        : checkout === undefined
          ? "checkout_failed"
          : !executionPrepared
            ? "execution_failed"
            : attemptOutcome === "wall_clock_exceeded"
              ? "wall_clock_exceeded"
              : null;
    if (skipReason !== null) {
      checks.push({
        id: check.id,
        kind: check.kind,
        status: "skipped",
        reason: skipReason,
        command: null,
      });
      recorder.record({
        type: "check.skipped",
        checkId: check.id,
        reason: skipReason,
      });
      continue;
    }
    // The non-null checkout follows from skipReason; keep the runtime boundary explicit.
    if (checkout === undefined)
      throw new Error("Missing checkout for a runnable check");
    if (backend === undefined) throw new Error("Missing execution backend");
    try {
      const relativeCwd = check.cwd ?? ".";
      const cwd = resolveInside(checkout.path, relativeCwd);
      recorder.record({ type: "check.started", checkId: check.id });
      const result = await backend.execute({
        command: check.command,
        args: check.args,
        cwd,
        ...(check.env === undefined ? {} : { env: check.env }),
        timeoutMs: check.timeoutMs,
        timeoutTermination: "check_timeout",
        maxOutputBytes: task.budgets.maxOutputBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const status =
        result.exitCode === 0 &&
        result.termination === null &&
        result.error === null
          ? "passed"
          : "failed";
      checks.push({
        id: check.id,
        kind: check.kind,
        status,
        command: commandEvidence(
          `check-${check.id}`,
          redact(relativeCwd),
          result,
        ),
      });
      recorder.record({ type: "check.finished", checkId: check.id, status });
    } catch (error) {
      addError(`check ${check.id}`, error);
      checks.push({
        id: check.id,
        kind: check.kind,
        status: "skipped",
        reason: "check_error",
        command: null,
      });
      recorder.record({
        type: "check.skipped",
        checkId: check.id,
        reason: "check_error",
      });
    }
  }

  if (backend !== undefined) {
    try {
      await backend.dispose();
    } catch (error) {
      addError("container cleanup", error);
    }
  }
  const score = scoreChecks(checks);
  recorder.record({
    type: "score.computed",
    passed: score.passed,
    total: score.total,
  });
  const interrupted =
    options.signal?.aborted === true ||
    attemptOutcome === "wall_clock_exceeded" ||
    attemptOutcome === "cancelled";
  const initialStatus = interrupted
    ? "interrupted"
    : attemptOutcome === "completed" &&
        score.passed === score.total &&
        errors.length === 0
      ? "succeeded"
      : "failed";
  const result: ResultSpec = {
    $schema: "https://agent-eval-runner.dev/schemas/result-v5.schema.json",
    schemaVersion: "5",
    safety: { ...SAFETY_POLICY },
    execution,
    runner: {
      name: "agent-eval-runner",
      version: "0.5.0",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    task: sanitizeTask(task, redact),
    taskSha256: sha256(canonicalJson(task)),
    comparisonSha256: comparisonDigest(task),
    adapterSha256: sha256(canonicalJson(task.adapter)),
    usage: fakeUsage(),
    status: initialStatus,
    source: {
      repositoryPath: redact(task.repository.path),
      requestedRevision: task.repository.revision,
      resolvedRevision: checkout?.revision ?? null,
    },
    attempt: {
      id: options.attemptId ?? randomUUID(),
      configurationId: options.configurationId ?? "fake",
      repetition: options.repetition ?? 1,
      adapter: "fake",
      outcome: attemptOutcome,
      durationMs: attemptDurationMs,
      commandCount,
    },
    commands,
    checks,
    artifacts,
    errors,
    score,
    events: recorder.events,
    patch: {
      captured: patchCaptured,
      bytes: Buffer.byteLength(redactedPatch),
      originalBytes: Buffer.byteLength(patchContent),
      sha256: sha256(redactedPatch),
      originalSha256: sha256(patchContent),
      redacted: redactedPatch !== patchContent,
      content: redactedPatch,
    },
    workspace: {
      retained: checkout !== undefined,
      path: checkout === undefined ? null : redact(checkout.path),
    },
  };
  assertResultSpec(result);
  // Preserve evidence before deleting the only remaining checkout. If writing fails,
  // leave that checkout available for recovery and propagate the persistence error.
  if (options.outputPath !== undefined)
    await writeJsonAtomic(options.outputPath, result);
  if (
    checkout !== undefined &&
    options.keepWorktree !== true &&
    !retainWorkspace
  ) {
    try {
      await backend?.removeWorkspace();
      await removeCheckout(checkout);
      result.workspace = { retained: false, path: null };
    } catch (error) {
      addError("cleanup", error);
      if (!interrupted) result.status = "failed";
    }
  }
  recorder.record({ type: "run.finished", status: result.status });
  assertResultSpec(result);
  if (options.outputPath !== undefined)
    await writeJsonAtomic(options.outputPath, result);
  return result;
}
