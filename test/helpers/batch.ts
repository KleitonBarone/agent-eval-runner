import type { BatchSpec } from "../../src/batch-spec.js";
import type { createTestRepository } from "./repository.js";

export function batchFor(
  repository: Awaited<ReturnType<typeof createTestRepository>>,
): BatchSpec {
  return {
    schemaVersion: "1",
    id: "batch-test",
    task: {
      schemaVersion: "1",
      id: "answer-task",
      repository,
      prompt: "Write answer.txt containing answer followed by a newline.",
      budgets: { wallClockMs: 5_000, maxCommands: 2, maxOutputBytes: 16_384 },
      checks: [
        {
          id: "answer",
          kind: "test",
          command: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').readFileSync('answer.txt','utf8') === 'answer\\n' ? 0 : 1)",
          ],
          timeoutMs: 2_000,
        },
      ],
      artifacts: [{ path: "answer.txt", mediaType: "text/plain" }],
    },
    configurations: [
      {
        id: "success",
        repetitions: 1,
        adapter: {
          kind: "fake",
          actions: [
            { kind: "writeFile", path: "answer.txt", content: "answer\n" },
          ],
        },
      },
    ],
  };
}
