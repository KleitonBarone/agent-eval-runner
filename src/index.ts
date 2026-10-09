export { runEvaluation, type RunEvaluationOptions } from "./runner.js";
export { ResultSpecSchema, type ResultSpec } from "./result.js";
export { parseTaskSpec, TaskSpecSchema, type TaskSpec } from "./spec.js";
export { runBatch } from "./batch.js";
export { parseBatchSpec, parseBatchIndex } from "./batch-spec.js";
export type { BatchSpec, BatchIndex, BatchEntry } from "./batch-spec.js";
export {
  readComparison,
  createComparison,
  writeComparison,
  renderMarkdown,
} from "./comparison.js";
export type { ComparisonSpec } from "./comparison-spec.js";
export { parseResultSpec } from "./result.js";
export type { Usage, UsageMetric } from "./usage.js";
