import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DockerExecution } from "./docker.js";
import type { ExecutionConfig, ExecutionEvidence } from "./execution-spec.js";
import type { PreparedCheckout } from "./git.js";
import { resolveInside } from "./paths.js";
import {
  runProcess,
  type ProcessRequest,
  type ProcessResult,
} from "./process.js";
import type { Redactor } from "./redaction.js";

export interface ExecutionBackend {
  readonly workspace: string;
  readonly quiescent: boolean;
  prepare(signal?: AbortSignal): Promise<void>;
  execute(request: ProcessRequest): Promise<ProcessResult>;
  writeFile(
    path: string,
    content: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<"wall_clock" | "cancelled" | null>;
  synchronize(): Promise<void>;
  dispose(): Promise<void>;
  removeWorkspace(): Promise<void>;
}

export function createExecutionBackend(
  config: ExecutionConfig | undefined,
  checkout: PreparedCheckout,
  evidence: ExecutionEvidence,
  redact: Redactor,
): ExecutionBackend {
  if (config?.kind === "docker") {
    if (evidence.kind !== "docker") throw new Error("Missing Docker evidence");
    return new DockerExecution(checkout, config.image, evidence, redact);
  }
  return {
    workspace: checkout.path,
    quiescent: true,
    prepare: () => Promise.resolve(),
    execute: (request) => runProcess(request, redact),
    writeFile: async (path, content) => {
      const target = resolveInside(checkout.path, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return null;
    },
    synchronize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    removeWorkspace: () => Promise.resolve(),
  };
}
