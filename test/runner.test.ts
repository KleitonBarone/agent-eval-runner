import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runEvaluation } from "../src/runner.js";
import type { TaskSpec } from "../src/spec.js";
import { SAFETY_POLICY } from "../src/safety.js";
import {
  cleanupTestRepositories,
  createTestRepository,
  removeTestWorktree,
} from "./helpers/repository.js";

afterEach(async () => {
  await cleanupTestRepositories();
});

function taskFor(
  repository: Awaited<ReturnType<typeof createTestRepository>>,
  overrides: Partial<TaskSpec> = {},
): TaskSpec {
  return {
    schemaVersion: "1",
    id: "runner-test",
    repository,
    prompt: "Produce a deterministic change.",
    adapter: {
      kind: "fake",
      actions: [
        { kind: "writeFile", path: "answer.txt", content: "answer\n" },
        {
          kind: "runCommand",
          command: process.execPath,
          args: ["-e", "console.log('agent output')"],
        },
      ],
    },
    budgets: { wallClockMs: 5_000, maxCommands: 2, maxOutputBytes: 16_384 },
    checks: [
      {
        id: "answer",
        kind: "test",
        command: process.execPath,
        args: ["-e", "require('fs').accessSync('answer.txt')"],
        timeoutMs: 2_000,
      },
    ],
    artifacts: [{ path: "answer.txt", mediaType: "text/plain" }],
    ...overrides,
  };
}

describe("evaluation runner", () => {
  it("preserves files written before an adapter exception", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const result = await runEvaluation({
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          { kind: "writeFile", path: "answer.txt", content: "answer\n" },
          { kind: "writeFile", path: "../escape.txt", content: "invalid" },
        ],
      },
    });

    expect(result.attempt.outcome).toBe("runner_error");
    expect(result.patch.content).toContain("answer.txt");
    expect(result.artifacts).toMatchObject([{ path: "answer.txt" }]);
    expect(result.checks).toMatchObject([{ id: "answer", status: "passed" }]);
    expect(result.errors.join(" ")).toContain("escapes");
  });

  it("includes every declared check when cancellation prevents execution", async () => {
    const repository = await createTestRepository();
    const controller = new AbortController();
    controller.abort();
    const result = await runEvaluation(taskFor(repository), {
      signal: controller.signal,
    });

    expect(result.status).toBe("interrupted");
    expect(result.checks).toMatchObject([
      { id: "answer", status: "skipped", reason: "cancelled", command: null },
    ]);
    expect(result.score).toMatchObject({ passed: 0, total: 1, ratio: 0 });
  });

  it("captures commands, artifacts, patch, checks, scoring, and ordered events", async () => {
    const repository = await createTestRepository();
    const result = await runEvaluation(taskFor(repository));

    expect(result.status).toBe("succeeded");
    expect(result.source.resolvedRevision).toBe(repository.revision);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      exitCode: 0,
      stdout: "agent output\n",
    });
    expect(result.patch.content).toContain("answer.txt");
    expect(result.artifacts).toHaveLength(1);
    expect(
      Buffer.from(
        result.artifacts[0]?.contentBase64 ?? "",
        "base64",
      ).toString(),
    ).toBe("answer\n");
    expect(result.checks).toMatchObject([{ id: "answer", status: "passed" }]);
    expect(result.score).toEqual({
      version: "2",
      passed: 1,
      failed: 0,
      skipped: 0,
      total: 1,
      ratio: 1,
    });
    expect(result.events.map(({ sequence }) => sequence)).toEqual(
      result.events.map((_, index) => index),
    );
    expect(result.events.at(0)?.type).toBe("run.started");
    expect(result.events.at(-1)?.type).toBe("run.finished");
    const types = result.events.map(({ type }) => type);
    expect(types.indexOf("command.started")).toBeLessThan(
      types.indexOf("command.finished"),
    );
    expect(types.indexOf("agent.finished")).toBeLessThan(
      types.indexOf("patch.captured"),
    );
    expect(types.indexOf("artifact.captured")).toBeLessThan(
      types.indexOf("check.started"),
    );
    expect(types.indexOf("check.finished")).toBeLessThan(
      types.indexOf("score.computed"),
    );
  });

  it("enforces the fake agent command budget outside the adapter", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const result = await runEvaluation({
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          {
            kind: "runCommand",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
          {
            kind: "runCommand",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        ],
      },
      budgets: { ...base.budgets, maxCommands: 1 },
    });

    expect(result.status).toBe("failed");
    expect(result.attempt.outcome).toBe("command_budget_exceeded");
    expect(result.commands).toHaveLength(1);
    expect(result.events.some(({ type }) => type === "budget.exceeded")).toBe(
      true,
    );
  });

  it("terminates the process tree when the wall-clock budget expires", async () => {
    const repository = await createTestRepository({
      "child.mjs":
        "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('escaped.txt', 'bad'), 800); setInterval(() => {}, 1000);\n",
      "parent.mjs":
        "import { spawn } from 'node:child_process'; spawn(process.execPath, ['child.mjs'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n",
    });
    const base = taskFor(repository);
    const resultPath = join(repository.path, "interrupted-result.json");
    const result = await runEvaluation(
      {
        ...base,
        adapter: {
          kind: "fake",
          actions: [
            {
              kind: "runCommand",
              command: process.execPath,
              args: ["parent.mjs"],
            },
          ],
        },
        budgets: { ...base.budgets, wallClockMs: 250 },
        checks: [],
        artifacts: [],
      },
      { keepWorktree: true, outputPath: resultPath },
    );

    expect(result.status).toBe("interrupted");
    expect(result.attempt.outcome).toBe("wall_clock_exceeded");
    expect(result.commands[0]?.termination).toBe("wall_clock");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(result.workspace.path).not.toBeNull();
    await expect(
      access(join(result.workspace.path ?? "", "escaped.txt")),
    ).rejects.toThrow();
    const persisted: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    expect(persisted).toEqual(result);
    await removeTestWorktree(repository.path, result.workspace.path ?? "");
  });

  it("preserves a failed attempt as machine-readable JSON", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const outputPath = join(repository.path, "failed-result.json");
    const result = await runEvaluation(
      {
        ...base,
        adapter: {
          kind: "fake",
          actions: [
            {
              kind: "writeFile",
              path: "secret.txt",
              content: "API_KEY=secret-value\n",
            },
            {
              kind: "runCommand",
              command: process.execPath,
              args: [
                "-e",
                "console.error('API_KEY=secret-value'); process.exit(7)",
              ],
              env: { API_KEY: "secret-value" },
            },
          ],
        },
        artifacts: [{ path: "secret.txt", mediaType: "text/plain" }],
      },
      { outputPath },
    );

    const persisted: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    expect(persisted).toEqual(result);
    expect(result.status).toBe("failed");
    expect(result.commands[0]).toMatchObject({
      exitCode: 7,
      stderr: "API_KEY=[REDACTED]\n",
    });
    expect(result.patch.redacted).toBe(true);
    expect(result.artifacts[0]?.redacted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("keeps the original outcome and later checks when artifact and check setup fail", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const result = await runEvaluation({
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          {
            kind: "runCommand",
            command: process.execPath,
            args: ["-e", "process.exit(7)"],
          },
        ],
      },
      artifacts: [{ path: "missing.txt", mediaType: "text/plain" }],
      checks: [
        {
          ...base.checks[0],
          id: "invalid-cwd",
          kind: "test",
          command: process.execPath,
          args: [],
          timeoutMs: 1000,
          cwd: "../escape",
        },
        {
          id: "later",
          kind: "lint",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 1000,
        },
      ],
    });
    expect(result.attempt.outcome).toBe("agent_failed");
    expect(result.patch.captured).toBe(true);
    expect(result.errors).toHaveLength(2);
    expect(result.checks).toMatchObject([
      { status: "skipped", reason: "check_error" },
      { status: "passed" },
    ]);
    expect(result.score).toMatchObject({
      passed: 1,
      skipped: 1,
      total: 2,
      ratio: 0.5,
    });
  });

  it("preserves output, smaller artifacts, checks, and the checkout after an oversized export", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const outputPath = join(repository.path, "oversized.json");
    const result = await runEvaluation(
      {
        ...base,
        adapter: {
          kind: "fake",
          actions: [
            { kind: "writeFile", path: "answer.txt", content: "answer\n" },
            {
              kind: "runCommand",
              command: process.execPath,
              args: [
                "-e",
                `const fs=require('node:fs');fs.closeSync(fs.openSync('large.bin','w'));fs.truncateSync('large.bin',${String(SAFETY_POLICY.fileBytes + 1)});console.log('available output')`,
              ],
            },
          ],
        },
      },
      { outputPath },
    );
    expect(result.status).toBe("failed");
    expect(result.attempt.outcome).toBe("completed");
    expect(result.commands[0]?.stdout).toBe("available output\n");
    expect(result.patch.captured).toBe(false);
    expect(result.artifacts[0]?.path).toBe("answer.txt");
    expect(result.checks[0]?.status).toBe("passed");
    expect(result.workspace.retained).toBe(true);
    expect(result.errors.join(" ")).toContain("file byte limit");
    const persisted: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    expect(persisted).toEqual(result);
    await access(join(result.workspace.path ?? "", "large.bin"));
  });

  it("caps aggregate artifacts and still captures later smaller evidence", async () => {
    const repository = await createTestRepository();
    const base = taskFor(repository);
    const bytes = SAFETY_POLICY.totalArtifactBytes / 2 + 1;
    const result = await runEvaluation({
      ...base,
      budgets: { ...base.budgets, maxArtifactBytes: bytes },
      adapter: {
        kind: "fake",
        actions: [
          { kind: "writeFile", path: "answer.txt", content: "answer\n" },
          {
            kind: "runCommand",
            command: process.execPath,
            args: [
              "-e",
              `const fs=require('node:fs');for(const file of ['a.bin','b.bin'])fs.writeFileSync(file,Buffer.alloc(${String(bytes)},1))`,
            ],
          },
        ],
      },
      artifacts: [
        { path: "a.bin", mediaType: "application/octet-stream" },
        { path: "b.bin", mediaType: "application/octet-stream" },
        ...base.artifacts,
      ],
    });
    expect(result.status).toBe("failed");
    expect(result.attempt.outcome).toBe("completed");
    expect(result.artifacts.map(({ path }) => path)).toEqual([
      "a.bin",
      "answer.txt",
    ]);
    expect(
      result.artifacts.reduce(
        (total, artifact) =>
          total + Math.max(artifact.bytes, artifact.originalBytes),
        0,
      ),
    ).toBeLessThanOrEqual(SAFETY_POLICY.totalArtifactBytes);
    expect(result.errors.join(" ")).toContain("byte limit");
    expect(result.workspace.retained).toBe(true);
  });
});
