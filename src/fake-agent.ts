import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveInside } from "./paths.js";
import type { ProcessResult } from "./process.js";
import type { TaskSpec } from "./spec.js";

type FakeAction = TaskSpec["adapter"]["actions"][number];

export type FakeAgentOutcome =
  | "completed"
  | "agent_failed"
  | "command_budget_exceeded"
  | "wall_clock_exceeded"
  | "cancelled";

export interface FakeAgentContext {
  readonly workspace: string;
  readonly actions: readonly FakeAction[];
  readonly execute: (
    action: Extract<FakeAction, { kind: "runCommand" }>,
  ) => Promise<ProcessResult | null>;
  readonly outcomeAfterSkippedCommand: () =>
    "command_budget_exceeded" | "wall_clock_exceeded" | "cancelled";
  readonly signal?: AbortSignal;
  readonly deadline: number;
}

export async function runFakeAgent(
  context: FakeAgentContext,
): Promise<FakeAgentOutcome> {
  for (const action of context.actions) {
    if (context.signal?.aborted === true) return "cancelled";
    if (performance.now() >= context.deadline) return "wall_clock_exceeded";

    if (action.kind === "writeFile") {
      const target = resolveInside(context.workspace, action.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, action.content, "utf8");
      continue;
    }

    const result = await context.execute(action);
    if (result === null) return context.outcomeAfterSkippedCommand();
    if (result.termination === "cancelled") return "cancelled";
    if (result.termination === "wall_clock") return "wall_clock_exceeded";
    if (result.exitCode !== 0) return "agent_failed";
  }
  return "completed";
}
