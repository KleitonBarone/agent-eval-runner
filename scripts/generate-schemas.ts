import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { format } from "prettier";

import { BatchIndexSchema, BatchSpecSchema } from "../src/batch-spec.js";
import { ComparisonSpecSchema } from "../src/comparison-spec.js";
import { ResultSpecSchema } from "../src/result.js";
import { TaskSpecSchema } from "../src/spec.js";
import {
  PreparationRequestSchema,
  PreparationResponseSchema,
} from "../src/preparation-protocol.js";
import {
  AdmissionDecisionSchema,
  ResourceInventorySchema,
  ResourceLedgerSchema,
  ResourcePolicyInputSchema,
} from "../src/resources-spec.js";

const schemas = [
  ["schemas/task-v1.schema.json", TaskSpecSchema],
  ["schemas/result-v7.schema.json", ResultSpecSchema],
  ["schemas/batch-v1.schema.json", BatchSpecSchema],
  ["schemas/batch-index-v2.schema.json", BatchIndexSchema],
  ["schemas/comparison-v6.schema.json", ComparisonSpecSchema],
  ["schemas/preparation-request-v1.schema.json", PreparationRequestSchema],
  ["schemas/preparation-response-v1.schema.json", PreparationResponseSchema],
  ["schemas/resource-policy-v1.schema.json", ResourcePolicyInputSchema],
  ["schemas/resource-ledger-v1.schema.json", ResourceLedgerSchema],
  ["schemas/resource-inventory-v1.schema.json", ResourceInventorySchema],
  ["schemas/resource-admission-v1.schema.json", AdmissionDecisionSchema],
] as const;
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("Use --check or --write");
}

for (const [relativePath, schema] of schemas) {
  const path = resolve(relativePath);
  const expected = await format(JSON.stringify(schema), { parser: "json" });
  if (mode === "--write") {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected, "utf8");
    continue;
  }
  const actual = await readFile(path, "utf8").catch(() => "");
  if (actual !== expected)
    throw new Error(`${relativePath} is stale. Run pnpm schemas:write.`);
}
