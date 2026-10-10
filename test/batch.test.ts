import { realpathSync, watch } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBatch } from "../src/batch.js";
import { parseBatchSpec } from "../src/batch-spec.js";
import { readComparison } from "../src/comparison.js";
import { parseResultSpec } from "../src/result.js";
import { batchFor } from "./helpers/batch.js";
import {
  cleanupTestRepositories,
  createTestRepository,
  removeTestWorktree,
  retainedTestWorktrees,
} from "./helpers/repository.js";

afterEach(cleanupTestRepositories);

describe("sequential batches", () => {
  it("isolates repetitions and preserves failures without stopping later attempts", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    batch.configurations = [
      {
        id: "failed-check",
        repetitions: 1,
        adapter: {
          kind: "fake",
          actions: [
            { kind: "writeFile", path: "answer.txt", content: "wrong\n" },
          ],
        },
      },
      {
        id: "repeat",
        repetitions: 2,
        adapter: {
          kind: "fake",
          actions: [
            {
              kind: "runCommand",
              command: process.execPath,
              args: [
                "-e",
                "const fs=require('fs'); if(fs.existsSync('answer.txt')) process.exit(9); fs.writeFileSync('answer.txt','answer\\n'); console.log(process.cwd())",
              ],
            },
          ],
        },
      },
    ];
    const directory = join(repository.path, "results");
    const index = await runBatch(batch, { outputDirectory: directory });
    expect(index.state).toBe("completed");
    expect(index.attempts.map(({ state }) => state)).toEqual([
      "finished",
      "finished",
      "finished",
    ]);
    const results = await Promise.all(
      index.attempts.map(async (entry) => {
        if (entry.state !== "finished")
          throw new Error("Expected finished result");
        const input: unknown = JSON.parse(
          await readFile(join(directory, entry.resultFile), "utf8"),
        );
        return parseResultSpec(input);
      }),
    );
    expect(results.map(({ status }) => status)).toEqual([
      "failed",
      "succeeded",
      "succeeded",
    ]);
    expect(results.map(({ attempt }) => attempt.id)).toEqual([
      "attempt-1-1",
      "attempt-2-1",
      "attempt-2-2",
    ]);
    expect(results[1]?.commands[0]?.stdout).not.toEqual(
      results[2]?.commands[0]?.stdout,
    );
    expect(results[1]?.patch.originalSha256).toBe(
      results[2]?.patch.originalSha256,
    );
    expect(results[1]?.taskSha256).toBe(results[2]?.taskSha256);
    expect(
      results.every(
        ({ comparisonSha256 }) => comparisonSha256 === index.comparisonSha256,
      ),
    ).toBe(true);
    await expect(access(join(repository.path, "answer.txt"))).rejects.toThrow();
    expect((await readComparison(directory)).summary).toMatchObject({
      finished: 3,
      succeeded: 2,
      failed: 1,
    });
  });

  it("continues after a timeout and includes skipped checks and partial artifacts", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    batch.task.budgets.wallClockMs = 250;
    batch.configurations.unshift({
      id: "timeout",
      repetitions: 1,
      adapter: {
        kind: "fake",
        actions: [
          { kind: "writeFile", path: "answer.txt", content: "partial\n" },
          {
            kind: "runCommand",
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
          },
        ],
      },
    });
    const directory = join(repository.path, "results");
    const index = await runBatch(batch, { outputDirectory: directory });
    expect(index.state).toBe("completed");
    const report = await readComparison(directory);
    expect(report.summary).toMatchObject({
      interrupted: 1,
      succeeded: 1,
      finished: 2,
    });
    expect(report.rows[0]).toMatchObject({
      state: "finished",
      outcome: "wall_clock_exceeded",
      score: { total: 1, skipped: 1, ratio: 0 },
    });
    const first = index.attempts[0];
    if (first?.state !== "finished")
      throw new Error("Missing interrupted result");
    const raw: unknown = JSON.parse(
      await readFile(join(directory, first.resultFile), "utf8"),
    );
    const result = parseResultSpec(raw);
    expect(result.artifacts).toHaveLength(1);
    expect(result.patch.captured).toBe(true);
    expect(result.commands[0]?.termination).toBe("wall_clock");
  });

  it("cancels an active command and marks every later repetition not started", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    batch.configurations = [
      {
        id: "cancel",
        repetitions: 3,
        adapter: {
          kind: "fake",
          actions: [
            { kind: "writeFile", path: "answer.txt", content: "partial\n" },
            {
              kind: "runCommand",
              command: process.execPath,
              args: [
                "-e",
                "require('fs').writeFileSync(process.env.EVAL_READY, 'ready'); setInterval(() => {}, 1000)",
              ],
              env: { EVAL_READY: join(repository.path, "ready") },
            },
          ],
        },
      },
    ];
    const controller = new AbortController();
    // Windows 8.3 temp paths can trigger a native libuv watcher assertion.
    const watchDirectory = realpathSync.native(repository.path);
    const watcher = watch(watchDirectory, (_event, filename) => {
      if (String(filename) === "ready") controller.abort();
    });
    const directory = join(repository.path, "results");
    try {
      const index = await runBatch(batch, {
        outputDirectory: directory,
        signal: controller.signal,
      });
      expect(index.state).toBe("cancelled");
      expect(index.attempts.map(({ state }) => state)).toEqual([
        "finished",
        "not_started",
        "not_started",
      ]);
      const report = await readComparison(directory);
      expect(report.rows[0]).toMatchObject({
        state: "finished",
        outcome: "cancelled",
        score: { skipped: 1, total: 1 },
      });
      expect(report.summary).toMatchObject({ interrupted: 1, notStarted: 2 });
      expect(report.rows.slice(1)).toMatchObject([
        { reason: "cancelled" },
        { reason: "cancelled" },
      ]);
    } finally {
      watcher.close();
    }
  });

  it("does not claim existing evidence directories or start pre-cancelled schedules", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    const directory = join(repository.path, "existing");
    await mkdir(directory);
    await writeFile(join(directory, "sentinel"), "preserve");
    await expect(
      runBatch(batch, { outputDirectory: directory }),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "sentinel"), "utf8")).toBe(
      "preserve",
    );
    const controller = new AbortController();
    controller.abort();
    const index = await runBatch(batch, {
      outputDirectory: join(repository.path, "cancelled"),
      signal: controller.signal,
    });
    expect(index.state).toBe("cancelled");
    expect(index.attempts[0]).toMatchObject({
      state: "not_started",
      reason: "cancelled",
      resultFile: null,
    });
  });

  it("rejects duplicate configurations and check identities before allocating output", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    expect(() =>
      parseBatchSpec({
        ...batch,
        configurations: [...batch.configurations, ...batch.configurations],
      }),
    ).toThrow("unique");
    const directory = join(repository.path, "invalid");
    batch.task.checks.push(...batch.task.checks);
    await expect(
      runBatch(batch, { outputDirectory: directory }),
    ).rejects.toThrow("unique");
    await expect(access(directory)).rejects.toThrow();
  });

  it("stops scheduling after persistence failure and retains the only remaining checkout", async () => {
    const repository = await createTestRepository();
    const batch = batchFor(repository);
    const directory = join(repository.path, "results");
    batch.configurations = [
      {
        id: "blocked-output",
        repetitions: 2,
        adapter: {
          kind: "fake",
          actions: [
            { kind: "writeFile", path: "answer.txt", content: "answer\n" },
            {
              kind: "runCommand",
              command: process.execPath,
              args: ["-e", "require('fs').mkdirSync(process.env.EVAL_BLOCK)"],
              env: { EVAL_BLOCK: join(directory, "attempt-1-1.json") },
            },
          ],
        },
      },
    ];
    try {
      const index = await runBatch(batch, { outputDirectory: directory });
      expect(index.state).toBe("failed");
      expect(index.attempts).toMatchObject([
        { state: "persistence_failed" },
        { state: "not_started", reason: "persistence_error" },
      ]);
      const retained = await retainedTestWorktrees(repository.path);
      expect(retained).toHaveLength(1);
      expect(
        await readFile(join(retained[0] ?? "", "answer.txt"), "utf8"),
      ).toBe("answer\n");
      const report = await readComparison(directory);
      expect(report.summary.usage.modelTokens.status).toBe("unknown");
      expect(report.summary).toMatchObject({
        persistenceFailed: 1,
        notStarted: 1,
      });
    } finally {
      for (const worktree of await retainedTestWorktrees(repository.path))
        await removeTestWorktree(repository.path, worktree);
    }
  });
});
