import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { readComparison, writeComparison } from "../src/comparison.js";
import { runBatch } from "../src/batch.js";
import { parseResultSpec, type ResultSpec } from "../src/result.js";
import { writeJsonAtomic } from "../src/persistence.js";
import { runEvaluation } from "../src/runner.js";
import type { TaskSpec } from "../src/spec.js";
import {
  cleanupTestRepositories,
  createTestRepository,
} from "../test/helpers/repository.js";

// Trusted official Node image, preinstalled explicitly. The runner never pulls images.
export const ISOLATION_EXAMPLE_IMAGE =
  "node@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

if (process.platform !== "linux")
  throw new Error(
    "Run the isolation example on Linux with a local Docker Engine",
  );
const execFileAsync = promisify(execFile);
const output = resolve(".agent-eval", `isolation-example-${randomUUID()}`);
await mkdir(output, { recursive: true });
const originalTmpdir = process.env["TMPDIR"];
const fixtureRoot = await mkdtemp(
  join(tmpdir(), "agent-eval-isolation-example-"),
);
process.env["TMPDIR"] = fixtureRoot;
const secretKey = "AGENT_EVAL_HOST_TEST_SECRET";
const originalSecret = process.env[secretKey];
process.env[secretKey] = `test-only-${randomUUID()}`;
const hostAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
if (hostAddress === undefined)
  throw new Error("Isolation network test requires a host IPv4 interface");
let connections = 0;
const listener = createServer((socket) => {
  connections += 1;
  socket.destroy();
});
await new Promise<void>((done, reject) => {
  listener.once("error", reject);
  listener.listen(0, hostAddress, done);
});
const address = listener.address();
if (address === null || typeof address === "string")
  throw new Error("Missing test listener address");
const results: ResultSpec[] = [];
let retainFixtures = false;

async function savedAttempt(
  task: TaskSpec,
  label: string,
  options: { signal?: AbortSignal; cli?: boolean } = {},
) {
  const path = join(output, `${label}.json`);
  let result: ResultSpec;
  if (options.cli === true) {
    const taskPath = join(output, `${label}-task.json`);
    await writeJsonAtomic(taskPath, task);
    const { stdout } = await execFileAsync(process.execPath, [
      "dist/cli.js",
      "run",
      "--task",
      taskPath,
      "--output",
      path,
    ]);
    const summary: unknown = JSON.parse(stdout);
    assert.deepEqual(summary, {
      schemaVersion: "1",
      status: "succeeded",
      output: path,
    });
    const evidence: unknown = JSON.parse(await readFile(path, "utf8"));
    result = parseResultSpec(evidence);
  } else {
    result = await runEvaluation(task, {
      outputPath: path,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(parseResultSpec(raw), result);
  assert.equal(result.execution.kind, "docker");
  assert.equal(result.execution.cleanup, "removed");
  assert.match(result.execution.imageId ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.execution.node, "v24.20.0");
  assert.deepEqual(
    result.events.map(({ sequence }) => sequence),
    result.events.map((_, index) => index),
  );
  assert.equal(result.events.at(-1)?.type, "run.finished");
  const eventTypes = result.events.map(({ type }) => type);
  assert.ok(
    eventTypes.indexOf("checkout.prepared") <
      eventTypes.indexOf("execution.prepared"),
  );
  assert.ok(
    eventTypes.indexOf("execution.prepared") <
      eventTypes.indexOf("agent.started"),
  );
  assert.ok(
    eventTypes.indexOf("agent.finished") < eventTypes.indexOf("score.computed"),
  );
  if (result.patch.captured && eventTypes.includes("check.started"))
    assert.ok(
      eventTypes.indexOf("patch.captured") <
        eventTypes.indexOf("check.started"),
    );
  results.push(result);
  process.stderr.write(`Finalized isolated ${label}: ${result.status}\n`);
  return result;
}

try {
  const repository = await createTestRepository();
  const hostSentinel = join(repository.path, "host-only-secret.txt");
  await writeFile(hostSentinel, "host-only-sentinel");
  const base = {
    schemaVersion: "1",
    id: "isolated-example",
    repository,
    prompt: "Write answer.txt using the deterministic fake adapter.",
    execution: { kind: "docker", image: ISOLATION_EXAMPLE_IMAGE },
    budgets: { wallClockMs: 30_000, maxCommands: 2, maxOutputBytes: 16_384 },
    checks: [
      {
        id: "answer",
        kind: "test",
        command: "node",
        args: [
          "-e",
          "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'answer\\n')",
        ],
        timeoutMs: 10_000,
      },
      {
        id: "lint",
        kind: "lint",
        command: "node",
        args: [
          "-e",
          "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8').endsWith('\\n'),true)",
        ],
        timeoutMs: 10_000,
      },
    ],
    artifacts: [{ path: "answer.txt", mediaType: "text/plain" }],
    adapter: {
      kind: "fake",
      actions: [{ kind: "writeFile", path: "answer.txt", content: "answer\n" }],
    },
  } satisfies TaskSpec;
  const taskCredential = "isolation-test-only-credential";
  const probe = [
    "const fs=require('node:fs'); const assert=require('node:assert/strict');",
    "assert.notEqual(process.getuid(),0); assert.equal(process.cwd(),'/workspace');",
    "assert.equal(fs.existsSync('.git'),false); assert.equal(fs.existsSync('/var/run/docker.sock'),false);",
    `assert.equal(process.env.${secretKey},undefined); assert.throws(()=>fs.readFileSync(${JSON.stringify(hostSentinel)}));`,
    `assert.equal(process.env.API_KEY,${JSON.stringify(taskCredential)});`,
    "assert.throws(()=>fs.writeFileSync('/home/node/host-escape','bad'));",
    "const status=fs.readFileSync('/proc/self/status','utf8'); assert.match(status,/CapEff:\\s+0+\\n/); assert.match(status,/NoNewPrivs:\\s+1/);",
    `const socket=require('node:net').connect({host:${JSON.stringify(hostAddress)},port:${String(address.port)}});`,
    "socket.setTimeout(1500); socket.once('connect',()=>process.exit(9)); socket.once('timeout',()=>process.exit(10)); socket.once('error',()=>{fs.writeFileSync('credential.txt','API_KEY='+process.env.API_KEY);console.log('restrictions-verified');console.log('Bearer '+process.env.API_KEY);socket.destroy()});",
  ].join("\n");
  const success = await savedAttempt(
    {
      ...base,
      artifacts: [
        ...base.artifacts,
        { path: "credential.txt", mediaType: "text/plain" },
      ],
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: ["-e", probe],
            env: { API_KEY: taskCredential },
          },
        ],
      },
    },
    "success",
    { cli: true },
  );
  assert.equal(success.status, "succeeded", success.errors.join("\n"));
  assert.equal(
    success.commands[0]?.stdout,
    "restrictions-verified\nBearer [REDACTED]\n",
  );
  assert.equal(JSON.stringify(success).includes(taskCredential), false);
  const credentialArtifact = success.artifacts.find(
    ({ path }) => path === "credential.txt",
  );
  assert.ok(credentialArtifact);
  assert.equal(credentialArtifact.redacted, true);
  assert.notEqual(credentialArtifact.sha256, credentialArtifact.originalSha256);
  assert.equal(success.patch.redacted, true);
  assert.equal(connections, 0);
  assert.equal(await readFile(hostSentinel, "utf8"), "host-only-sentinel");
  assert.equal(success.score.ratio, 1);
  assert.match(success.patch.content, /answer\.txt/u);
  assert.equal(
    Buffer.from(success.artifacts[0]?.contentBase64 ?? "", "base64").toString(),
    "answer\n",
  );

  const failed = await savedAttempt(
    {
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          { kind: "writeFile", path: "answer.txt", content: "wrong\n" },
        ],
      },
    },
    "failed",
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.score.ratio, 0.5);
  assert.equal(failed.artifacts.length, 1);
  assert.match(failed.patch.content, /wrong/u);

  const descendantScript =
    "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('escaped.txt','bad'),1500);setInterval(()=>{},1000)\"],{detached:true,stdio:'ignore'}).unref();console.log('parent-exited');";
  const descendants = await savedAttempt(
    {
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: ["-e", descendantScript],
          },
        ],
      },
      checks: [
        {
          id: "no-descendant",
          kind: "test",
          command: "node",
          args: [
            "-e",
            "setTimeout(()=>process.exit(require('node:fs').existsSync('escaped.txt')?1:0),1800)",
          ],
          timeoutMs: 10_000,
        },
      ],
    },
    "descendants",
  );
  assert.equal(descendants.status, "succeeded");

  const timeout = await savedAttempt(
    {
      ...base,
      budgets: { ...base.budgets, wallClockMs: 2500 },
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: [
              "-e",
              "console.log('before-timeout');setInterval(()=>{},1000)",
            ],
          },
        ],
      },
    },
    "timeout",
  );
  assert.equal(timeout.status, "interrupted");
  assert.equal(timeout.attempt.outcome, "wall_clock_exceeded");
  assert.equal(timeout.commands[0]?.termination, "wall_clock");
  assert.match(timeout.commands[0].stdout, /before-timeout/u);
  assert.equal(timeout.artifacts.length, 1);
  assert.equal(timeout.patch.captured, true);
  assert.equal(timeout.score.skipped, 2);

  const budget = await savedAttempt(
    {
      ...base,
      budgets: { ...base.budgets, maxCommands: 0 },
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: ["-e", "process.exit(99)"],
          },
        ],
      },
    },
    "command-budget",
  );
  assert.equal(budget.attempt.outcome, "command_budget_exceeded");
  assert.equal(budget.commands.length, 0);
  assert.equal(budget.artifacts.length, 1);

  const controller = new AbortController();
  const ready = `ready-${randomUUID()}`;
  const pending = savedAttempt(
    {
      ...base,
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: [
              "-e",
              `console.log('before-cancel');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready'),500);setInterval(()=>{},1000)`,
            ],
          },
        ],
      },
    },
    "cancelled",
    { signal: controller.signal },
  );
  const polling = setInterval(() => {
    void readdir(fixtureRoot).then(async (entries) => {
      for (const entry of entries.filter((name) =>
        name.startsWith("agent-eval-isolated-"),
      )) {
        if (
          await access(join(fixtureRoot, entry, "workspace", ready)).then(
            () => true,
            () => false,
          )
        )
          controller.abort();
      }
    });
  }, 25);
  const fallback = setTimeout(() => {
    controller.abort();
  }, 20_000);
  let cancelled: ResultSpec;
  try {
    cancelled = await pending;
  } finally {
    clearInterval(polling);
    clearTimeout(fallback);
  }
  assert.equal(cancelled.attempt.outcome, "cancelled");
  assert.equal(cancelled.commands[0]?.termination, "cancelled");
  assert.equal(cancelled.artifacts.length, 1);
  assert.match(cancelled.commands[0].stdout, /before-cancel/u);

  const unsafeExport = await savedAttempt(
    {
      ...base,
      artifacts: [
        ...base.artifacts,
        { path: "escape.txt", mediaType: "text/plain" },
      ],
      adapter: {
        kind: "fake",
        actions: [
          ...base.adapter.actions,
          {
            kind: "runCommand",
            command: "node",
            args: [
              "-e",
              `require('node:fs').symlinkSync(${JSON.stringify(hostSentinel)},'escape.txt')`,
            ],
          },
        ],
      },
    },
    "rejected-export",
  );
  // Preserve the source metadata too, so the retained checkout remains inspectable.
  retainFixtures = unsafeExport.workspace.retained;
  assert.equal(unsafeExport.status, "failed");
  assert.equal(unsafeExport.attempt.outcome, "completed");
  assert.equal(unsafeExport.patch.captured, false);
  assert.equal(unsafeExport.workspace.retained, true);
  assert.ok(unsafeExport.execution.kind === "docker");
  assert.ok(unsafeExport.execution.workspacePath);
  await access(join(unsafeExport.execution.workspacePath, "answer.txt"));
  assert.equal(unsafeExport.artifacts.length, 1);
  assert.equal(
    JSON.stringify(unsafeExport).includes("host-only-sentinel"),
    false,
  );
  assert.match(unsafeExport.errors.join("\n"), /only regular files.*outside/su);

  const batchDirectory = join(output, "batch");
  const { adapter, ...shared } = base;
  await runBatch(
    {
      schemaVersion: "1",
      id: "isolated-repetitions",
      task: shared,
      configurations: [{ id: "same", repetitions: 2, adapter }],
    },
    { outputDirectory: batchDirectory },
  );
  const report = await readComparison(batchDirectory);
  assert.equal(report.summary.succeeded, 2);
  await writeComparison(
    batchDirectory,
    join(batchDirectory, "comparison.json"),
    join(batchDirectory, "comparison.md"),
  );
  await writeComparison(
    batchDirectory,
    join(batchDirectory, "regenerated.json"),
    join(batchDirectory, "regenerated.md"),
  );
  for (const extension of ["json", "md"])
    assert.equal(
      await readFile(join(batchDirectory, `comparison.${extension}`), "utf8"),
      await readFile(join(batchDirectory, `regenerated.${extension}`), "utf8"),
    );
  for (const row of report.rows) {
    if (row.state !== "finished")
      throw new Error("Missing completed isolated repetition");
    assert.equal(row.execution.kind, "docker");
    assert.equal(row.execution.requestedImage, ISOLATION_EXAMPLE_IMAGE);
    const containerExists = await execFileAsync("docker", [
      "--host",
      "unix:///var/run/docker.sock",
      "inspect",
      row.execution.containerId ?? "invalid",
    ]).then(
      () => true,
      () => false,
    );
    assert.equal(containerExists, false, "Container was not removed");
  }
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: "1", verified: true, output, attempts: results.length, repetitions: report.summary.finished, image: ISOLATION_EXAMPLE_IMAGE })}\n`,
  );
} finally {
  await new Promise<void>((done, reject) => {
    listener.close((error) => {
      if (error === undefined) done();
      else reject(error);
    });
  });
  if (!retainFixtures) await cleanupTestRepositories();
  if (originalTmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = originalTmpdir;
  if (originalSecret === undefined)
    delete process.env["AGENT_EVAL_HOST_TEST_SECRET"];
  else process.env[secretKey] = originalSecret;
  // Keep the scoped fixture root, including any workspace retained after capture failure.
}
