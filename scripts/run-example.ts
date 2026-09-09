import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { runEvaluation } from "../src/runner.js";
import { parseTaskSpec } from "../src/spec.js";

const execFileAsync = promisify(execFile);
const repositoryPath = resolve(".");
const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryPath,
});
const revision = stdout.trim();
const outputDirectory = resolve(".agent-eval");
await mkdir(outputDirectory, { recursive: true });

const input: unknown = {
  $schema: "https://agent-eval-runner.dev/schemas/task-v1.schema.json",
  schemaVersion: "1",
  id: "local-fake-agent-example",
  repository: { path: repositoryPath, revision },
  prompt: "Create a deterministic answer and a JSON artifact.",
  adapter: {
    kind: "fake",
    actions: [
      {
        kind: "writeFile",
        path: "evaluation-answer.txt",
        content: "deterministic fake agent\n",
      },
      {
        kind: "writeFile",
        path: "artifacts/fake-agent.json",
        content: '{"agent":"fake","deterministic":true}\n',
      },
      {
        kind: "runCommand",
        command: process.execPath,
        args: ["-e", "console.log('fake agent completed')"],
      },
    ],
  },
  budgets: {
    wallClockMs: 5_000,
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
        "const fs=require('node:fs');if(fs.readFileSync('evaluation-answer.txt','utf8')!=='deterministic fake agent\\n')process.exit(1)",
      ],
      timeoutMs: 2_000,
    },
    {
      id: "lint",
      kind: "lint",
      command: process.execPath,
      args: [
        "-e",
        "const value=require('./artifacts/fake-agent.json');if(value.agent!=='fake'||value.deterministic!==true)process.exit(1)",
      ],
      timeoutMs: 2_000,
    },
  ],
  artifacts: [
    { path: "artifacts/fake-agent.json", mediaType: "application/json" },
  ],
};
const task = parseTaskSpec(input);
const taskPath = resolve(outputDirectory, "example-task.json");
const resultPath = resolve(outputDirectory, "example-result.json");
await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
const result = await runEvaluation(task, { outputPath: resultPath });
process.stdout.write(
  `${JSON.stringify({ task: taskPath, result: resultPath, status: result.status })}\n`,
);
if (result.status !== "succeeded") process.exitCode = 1;
