import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBatch } from "../src/batch.js";
import type { BatchEntry, BatchIndex } from "../src/batch-spec.js";
import {
  createComparison,
  readComparison,
  renderMarkdown,
  writeComparison,
} from "../src/comparison.js";
import { canonicalJson, sha256 } from "../src/identity.js";
import { jsonDocument } from "../src/persistence.js";
import { parseResultSpec, type ResultSpec } from "../src/result.js";
import { batchFor } from "./helpers/batch.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "./helpers/repository.js";

afterEach(cleanupTestRepositories);

async function savedBatch() {
  const repository = await createTestRepository();
  const batch = batchFor(repository);
  const directory = join(repository.path, "results");
  const index = await runBatch(batch, { outputDirectory: directory });
  const entry = index.attempts[0];
  if (entry?.state !== "finished") throw new Error("Missing finished fixture");
  const input: unknown = JSON.parse(
    await readFile(join(directory, entry.resultFile), "utf8"),
  );
  const result = parseResultSpec(input);
  return { repository, directory, index, entry, result };
}

describe("saved-result comparisons", () => {
  it("regenerates byte-identical JSON and Markdown using only saved evidence", async () => {
    const { directory, index, entry, result } = await savedBatch();
    // The recorded adapter remains data. Report creation must not execute its commands.
    result.task.adapter.actions = [
      {
        kind: "runCommand",
        command: "never-execute-this",
        args: ["```\n<script>bad</script> | secret"],
        env: { API_KEY: "[REDACTED]" },
      },
    ];
    result.adapterSha256 = sha256(canonicalJson(result.task.adapter));
    const contents = jsonDocument(result);
    index.attempts[0] = {
      ...entry,
      adapterSha256: result.adapterSha256,
      resultSha256: sha256(contents),
    };
    await writeFile(join(directory, entry.resultFile), contents);
    await writeFile(join(directory, "batch-index.json"), jsonDocument(index));
    const firstJson = join(directory, "report.json");
    const firstMarkdown = join(directory, "report.md");
    const report = await writeComparison(directory, firstJson, firstMarkdown);
    await writeComparison(
      directory,
      join(directory, "copy.json"),
      join(directory, "copy.md"),
    );
    expect(await readFile(firstJson, "utf8")).toBe(
      await readFile(join(directory, "copy.json"), "utf8"),
    );
    expect(await readFile(firstMarkdown, "utf8")).toBe(
      await readFile(join(directory, "copy.md"), "utf8"),
    );
    expect(report.rows[0]).toMatchObject({
      configurationId: "success",
      score: { ratio: 1 },
      checks: [{ id: "answer", kind: "test", status: "passed" }],
      patchBytes: result.patch.originalBytes,
    });
    expect(report.summary.usage.modelTokens).toEqual({
      status: "known",
      source: "not_applicable",
      value: 0,
    });
    expect(renderMarkdown(report)).toContain("\\u0060\\u0060\\u0060");
    expect(renderMarkdown(report).match(/^```/gmu)).toHaveLength(2);
  });

  it("rejects incompatible tasks, inconsistent scores, and old result versions", async () => {
    const { index, entry, result } = await savedBatch();
    const compare = (value: ResultSpec) =>
      createComparison(index, new Map([[entry.id, value]]));
    expect(() =>
      compare({ ...result, comparisonSha256: "0".repeat(64) }),
    ).toThrow("Incompatible task");
    expect(() =>
      compare({ ...result, score: { ...result.score, passed: 0, ratio: 0 } }),
    ).toThrow("Inconsistent score");
    expect(() => compare({ ...result, checks: [] })).toThrow(
      "Incomplete check",
    );
    expect(() => parseResultSpec({ ...result, schemaVersion: "1" })).toThrow(
      "require result version 2",
    );
  });

  it("preserves scheduling order, warns about differing runtimes, and propagates missing usage", async () => {
    const { index, entry, result } = await savedBatch();
    const secondEntry = { ...entry, id: "second", repetition: 2 };
    const secondResult = {
      ...result,
      runner: { ...result.runner, node: "v99.0.0" },
      attempt: { ...result.attempt, id: "second", repetition: 2 },
      usage: {
        ...result.usage,
        modelTokens: {
          status: "unknown",
          reason: "provider did not report usage",
        },
      },
    } satisfies ResultSpec;
    const unfinished: BatchEntry = {
      id: "third",
      configurationId: "success",
      repetition: 3,
      adapterSha256: entry.adapterSha256,
      state: "running",
      resultFile: "third.json",
    };
    const partial: BatchIndex = {
      ...index,
      state: "active",
      attempts: [entry, secondEntry, unfinished],
    };
    const report = createComparison(
      partial,
      new Map([
        [entry.id, result],
        [secondEntry.id, secondResult],
      ]),
    );
    expect(report.rows.map(({ id }) => id)).toEqual([
      entry.id,
      "second",
      "third",
    ]);
    expect(report.warnings).toHaveLength(2);
    expect(report.summary.usage.modelTokens.status).toBe("unknown");
    expect(report.summary.usage.modelCostUsd.status).toBe("unknown");
    expect(report.summary).toMatchObject({ finished: 2, running: 1 });
  });

  it("detects changed bytes and refuses paths that escape the evidence directory", async () => {
    const { repository, directory, index, entry } = await savedBatch();
    await writeFile(join(directory, entry.resultFile), "{}\n");
    await expect(readComparison(directory)).rejects.toThrow("digest mismatch");
    index.attempts[0] = { ...entry, resultFile: "../outside.json" };
    await writeFile(join(directory, "batch-index.json"), jsonDocument(index));
    await expect(readComparison(directory)).rejects.toThrow("escapes");
    const outside = join(repository.path, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "result.json"), "{}");
    await symlink(outside, join(directory, "alias"), "junction");
    index.attempts[0] = { ...entry, resultFile: "alias/result.json" };
    await writeFile(join(directory, "batch-index.json"), jsonDocument(index));
    await expect(readComparison(directory)).rejects.toThrow(
      "outside the input directory",
    );
  });

  it("refuses output aliases that would overwrite input evidence", async () => {
    const { repository, directory, entry } = await savedBatch();
    const original = await readFile(join(directory, entry.resultFile), "utf8");
    await symlink(directory, join(repository.path, "alias"), "junction");
    await expect(
      writeComparison(
        directory,
        join(repository.path, "alias", entry.resultFile),
        join(directory, "report.md"),
      ),
    ).rejects.toThrow("overwrite batch evidence");
    expect(await readFile(join(directory, entry.resultFile), "utf8")).toBe(
      original,
    );
    await expect(
      writeComparison(
        directory,
        join(directory, "same"),
        join(repository.path, "alias", "same"),
      ),
    ).rejects.toThrow("must differ");
  });
});
