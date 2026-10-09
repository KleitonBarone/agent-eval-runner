import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseBatchSpec } from "../src/batch-spec.js";
import { readComparison, writeComparison } from "../src/comparison.js";
import { writeJsonAtomic } from "../src/persistence.js";
import { parseResultSpec } from "../src/result.js";

const execFileAsync = promisify(execFile);
const repositoryPath = resolve(".");
const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryPath,
});
const root = resolve(".agent-eval");
await mkdir(root, { recursive: true });
const name = `batch-example-${randomUUID()}`;
const directory = join(root, name);
const batchPath = join(root, `${name}.json`);
const answer = {
  kind: "writeFile",
  path: "evaluation-answer.txt",
  content: "deterministic fake agent\n",
};
const batch = parseBatchSpec({
  schemaVersion: "1",
  id: "local-comparison-example",
  task: {
    schemaVersion: "1",
    id: "local-comparison-task",
    repository: { path: repositoryPath, revision: stdout.trim() },
    prompt:
      "Write evaluation-answer.txt containing deterministic fake agent and a final newline.",
    budgets: {
      wallClockMs: 1_000,
      maxCommands: 1,
      maxOutputBytes: 16_384,
      maxArtifactBytes: 65_536,
    },
    checks: [
      {
        id: "test",
        kind: "test",
        command: process.execPath,
        args: [
          "-e",
          "process.exit(require('fs').readFileSync('evaluation-answer.txt','utf8') === 'deterministic fake agent\\n' ? 0 : 1)",
        ],
        timeoutMs: 2_000,
      },
      {
        id: "lint",
        kind: "lint",
        command: process.execPath,
        args: [
          "-e",
          "process.exit(require('fs').readFileSync('evaluation-answer.txt','utf8').endsWith('\\n') ? 0 : 1)",
        ],
        timeoutMs: 2_000,
      },
    ],
    artifacts: [{ path: "evaluation-answer.txt", mediaType: "text/plain" }],
  },
  configurations: [
    {
      id: "success",
      repetitions: 2,
      adapter: { kind: "fake", actions: [answer] },
    },
    {
      id: "failed-check",
      repetitions: 1,
      adapter: { kind: "fake", actions: [{ ...answer, content: "wrong\n" }] },
    },
    {
      id: "timeout",
      repetitions: 1,
      adapter: {
        kind: "fake",
        actions: [
          answer,
          {
            kind: "runCommand",
            command: process.execPath,
            args: ["-e", "setInterval(() => {}, 1000)"],
          },
        ],
      },
    },
  ],
});
await writeJsonAtomic(batchPath, batch);
let batchExitCode: number | null = 0;
try {
  await execFileAsync(process.execPath, [
    "dist/cli.js",
    "batch",
    "--batch",
    batchPath,
    "--output-dir",
    directory,
  ]);
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "number"
  )
    throw error;
  batchExitCode = error.code;
}
if (batchExitCode !== 1)
  throw new Error(
    `Expected batch CLI exit 1 for intentional failures, got ${String(batchExitCode)}`,
  );
const reportPath = join(directory, "comparison.json");
const markdownPath = join(directory, "comparison.md");
await execFileAsync(process.execPath, [
  "dist/cli.js",
  "compare",
  "--input-dir",
  directory,
  "--output",
  reportPath,
  "--markdown",
  markdownPath,
]);
const report = await readComparison(directory);
if (
  report.summary.finished !== 4 ||
  report.summary.succeeded !== 2 ||
  report.summary.failed !== 1 ||
  report.summary.interrupted !== 1
)
  throw new Error("Unexpected acceptance outcomes");
const finished = report.rows.filter((row) => row.state === "finished");
if (
  finished[0]?.score.ratio !== 1 ||
  finished[1]?.score.ratio !== 1 ||
  finished[2]?.score.ratio !== 0.5 ||
  finished[3]?.score.skipped !== 2
)
  throw new Error("Unexpected acceptance scores");
for (const row of finished) {
  const raw: unknown = JSON.parse(
    await readFile(join(directory, row.resultFile), "utf8"),
  );
  if (parseResultSpec(raw).artifacts.length !== 1)
    throw new Error("Missing acceptance artifact");
}
const regeneratedJson = join(directory, "regenerated.json");
const regeneratedMarkdown = join(directory, "regenerated.md");
await writeComparison(directory, regeneratedJson, regeneratedMarkdown);
if (
  (await readFile(reportPath, "utf8")) !==
    (await readFile(regeneratedJson, "utf8")) ||
  (await readFile(markdownPath, "utf8")) !==
    (await readFile(regeneratedMarkdown, "utf8"))
)
  throw new Error("Reports did not regenerate byte-identically");
process.stdout.write(
  `${JSON.stringify({ batch: batchPath, index: join(directory, "batch-index.json"), report: reportPath, markdown: markdownPath, verified: true, summary: report.summary })}\n`,
);
