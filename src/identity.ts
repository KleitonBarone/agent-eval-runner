import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { TaskSpec } from "./spec.js";
import { executionIdentity } from "./execution-spec.js";
import { SAFETY_POLICY } from "./safety.js";
import type { ResourceIdentity } from "./resources-spec.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// Object order is irrelevant; array order remains part of the input identity.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new Error("Cannot hash a non-JSON value");
}

export function comparisonDigest(
  task: Omit<TaskSpec, "adapter">,
  resources: ResourceIdentity = { kind: "unmanaged" },
): string {
  return sha256(
    canonicalJson({
      repository: {
        path: resolve(task.repository.path),
        revision: task.repository.revision.toLowerCase(),
      },
      prompt: task.prompt,
      budgets: {
        ...task.budgets,
        maxArtifactBytes:
          task.budgets.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      },
      checks: task.checks,
      artifacts: task.artifacts,
      execution: executionIdentity(task.execution),
      safety: SAFETY_POLICY,
      resources,
    }),
  );
}
