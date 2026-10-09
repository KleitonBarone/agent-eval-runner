import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  parseBatchSpec,
  type BatchIndex,
  type BatchSpec,
} from "./batch-spec.js";
import { canonicalJson, comparisonDigest, sha256 } from "./identity.js";
import { writeJsonAtomic } from "./persistence.js";
import { collectTaskSecrets, createRedactor } from "./redaction.js";
import { runEvaluation } from "./runner.js";

export interface BatchOptions {
  readonly outputDirectory: string;
  readonly signal?: AbortSignal;
}

// Index order is configuration order, then repetition order. No retries or concurrency.
export async function runBatch(
  batchInput: BatchSpec,
  options: BatchOptions,
): Promise<BatchIndex> {
  const batch = parseBatchSpec(batchInput);
  await mkdir(dirname(resolve(options.outputDirectory)), { recursive: true });
  // Non-recursive creation is the exclusive claim on this batch's evidence directory.
  await mkdir(options.outputDirectory);
  const redact = createRedactor(
    batch.configurations.flatMap(({ adapter }) =>
      collectTaskSecrets({ ...batch.task, adapter }),
    ),
  );
  const index: BatchIndex = {
    schemaVersion: "1",
    id: batch.id,
    batchSha256: sha256(canonicalJson(batch)),
    comparisonSha256: comparisonDigest(batch.task),
    state: "active",
    attempts: batch.configurations.flatMap(
      (configuration, configurationIndex) =>
        Array.from({ length: configuration.repetitions }, (_, repetition) => ({
          id: `attempt-${String(configurationIndex + 1)}-${String(repetition + 1)}`,
          configurationId: configuration.id,
          repetition: repetition + 1,
          adapterSha256: sha256(canonicalJson(configuration.adapter)),
          state: "pending",
          resultFile: null,
        })),
    ),
  };
  const indexPath = join(options.outputDirectory, "batch-index.json");
  await writeJsonAtomic(indexPath, index);
  let failure = false;
  for (const [position, entry] of index.attempts.entries()) {
    if (options.signal?.aborted === true || failure) {
      index.attempts[position] = {
        ...entry,
        state: "not_started",
        resultFile: null,
        reason: failure ? "persistence_error" : "cancelled",
      };
      continue;
    }
    const configuration = batch.configurations.find(
      ({ id }) => id === entry.configurationId,
    );
    if (configuration === undefined)
      throw new Error("Missing scheduled configuration");
    const resultFile = `${entry.id}.json`;
    index.attempts[position] = { ...entry, state: "running", resultFile };
    await writeJsonAtomic(indexPath, index);
    try {
      await runEvaluation(
        { ...batch.task, adapter: configuration.adapter },
        {
          outputPath: join(options.outputDirectory, resultFile),
          attemptId: entry.id,
          configurationId: entry.configurationId,
          repetition: entry.repetition,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      const contents = await readFile(
        join(options.outputDirectory, resultFile),
      );
      index.attempts[position] = {
        ...entry,
        state: "finished",
        resultFile,
        resultSha256: sha256(contents),
      };
    } catch (error) {
      failure = true;
      index.attempts[position] = {
        ...entry,
        state: "persistence_failed",
        resultFile: null,
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    }
    await writeJsonAtomic(indexPath, index);
  }
  index.state = failure
    ? "failed"
    : options.signal?.aborted === true
      ? "cancelled"
      : "completed";
  await writeJsonAtomic(indexPath, index);
  return index;
}
