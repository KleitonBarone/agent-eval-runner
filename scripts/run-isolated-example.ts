import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { readComparison, writeComparison } from "../src/comparison.js";
import { runBatch } from "../src/batch.js";
import { parseResultSpec, type ResultSpec } from "../src/result.js";
import { writeJsonAtomic } from "../src/persistence.js";
import { SAFETY_POLICY } from "../src/safety.js";
import { CONTAINER_POLICY } from "../src/execution-spec.js";
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
  // Keep source metadata whenever any saved attempt needs forensic inspection.
  results.push(result);
  assert.deepEqual(parseResultSpec(raw), result);
  assert.deepEqual(result.safety, SAFETY_POLICY);
  assert.equal(result.execution.kind, "docker");
  assert.equal(result.execution.cleanup, "removed");
  assert.equal(result.execution.storage.verified, true);
  assert.ok(["removed", "retained"].includes(result.execution.storage.cleanup));
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
  let pollingActive = false;
  const polling = setInterval(() => {
    if (pollingActive) return;
    pollingActive = true;
    void (async () => {
      const { stdout } = await execFileAsync("docker", [
        "--host",
        "unix:///var/run/docker.sock",
        "ps",
        "--filter",
        "label=agent-eval-runner",
        "--format",
        "{{.Names}}",
      ]);
      for (const name of stdout
        .trim()
        .split("\n")
        .filter((value) => /^agent-eval-[a-f0-9-]+-holder$/u.test(value))) {
        const found = await execFileAsync("docker", [
          "--host",
          "unix:///var/run/docker.sock",
          "exec",
          name,
          "/usr/local/bin/node",
          "-e",
          `process.exit(require('node:fs').existsSync(${JSON.stringify(`/workspace/${ready}`)})?0:1)`,
        ]).then(
          () => true,
          () => false,
        );
        if (found) controller.abort();
      }
    })()
      .catch(() => {
        // A holder may disappear between listing and probing. The fallback still cancels.
      })
      .finally(() => {
        pollingActive = false;
      });
  }, 250);
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

  // Trusted writes deliberately reach kernel ENOSPC, then release filler files.
  // The failing command's output, prior patch, artifacts, and later checks survive.
  for (const root of ["/workspace", "/tmp"]) {
    for (const resource of ["bytes", "inodes"]) {
      const label = `${root.slice(1)}-${resource}`;
      const count =
        resource === "bytes" ? 40 : CONTAINER_POLICY.workspaceInodes + 2;
      const exhaust = `const fs=require('node:fs');const assert=require('node:assert/strict');const dir=${JSON.stringify(`${root}/filler`)};fs.mkdirSync(dir);let exhausted=false;try{for(let i=0;i<${String(count)};i++)fs.writeFileSync(dir+'/'+i,${resource === "bytes" ? "Buffer.alloc(8*1024*1024,1)" : "''"});}catch(error){assert.equal(error.code,'ENOSPC');exhausted=true;console.log(${JSON.stringify(`ENOSPC:${label}`)});}finally{fs.rmSync(dir,{recursive:true});}assert.equal(exhausted,true);fs.writeFileSync('/workspace/quota.txt',${JSON.stringify(`ENOSPC:${label}\n`)});process.exitCode=1;`;
      const quota = await savedAttempt(
        {
          ...base,
          artifacts: [
            ...base.artifacts,
            { path: "quota.txt", mediaType: "text/plain" },
          ],
          adapter: {
            kind: "fake",
            actions: [
              ...base.adapter.actions,
              { kind: "runCommand", command: "node", args: ["-e", exhaust] },
            ],
          },
        },
        label,
      );
      assert.equal(quota.status, "failed");
      assert.equal(quota.attempt.outcome, "agent_failed");
      assert.equal(quota.commands[0]?.stdout.trim(), `ENOSPC:${label}`);
      assert.equal(quota.commands[0].exitCode, 1);
      assert.equal(quota.patch.captured, true, quota.errors.join("\n"));
      assert.match(quota.patch.content, /quota\.txt/u);
      assert.equal(quota.artifacts.length, 2);
      assert.equal(quota.score.ratio, 1);
      assert.equal(quota.execution.kind, "docker");
      assert.equal(quota.execution.storage.cleanup, "removed");
      assert.equal(await readFile(hostSentinel, "utf8"), "host-only-sentinel");
      if (root === "/workspace" && resource === "bytes") {
        const checkQuota = await savedAttempt(
          {
            ...base,
            checks: [
              {
                id: "quota-check",
                kind: "test",
                command: "node",
                args: ["-e", exhaust],
                timeoutMs: 10_000,
              },
              ...base.checks,
            ],
          },
          "check-workspace-bytes",
        );
        assert.equal(checkQuota.status, "failed");
        assert.equal(checkQuota.attempt.outcome, "completed");
        assert.equal(
          checkQuota.checks[0]?.command?.stdout.trim(),
          "ENOSPC:workspace-bytes",
        );
        assert.equal(checkQuota.score.passed, 2);
        assert.equal(checkQuota.score.failed, 1);
        assert.equal(checkQuota.artifacts.length, 1);
        assert.equal(checkQuota.patch.captured, true);
        assert.doesNotMatch(checkQuota.patch.content, /quota\.txt/u);
      }
    }
  }

  const oversizedExport = await savedAttempt(
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
              `const fs=require('node:fs');fs.closeSync(fs.openSync('large.bin','w'));fs.truncateSync('large.bin',${String(SAFETY_POLICY.fileBytes + 1)});console.log('export-over-limit')`,
            ],
          },
        ],
      },
    },
    "oversized-export",
  );
  assert.equal(oversizedExport.status, "failed");
  assert.equal(oversizedExport.attempt.outcome, "completed");
  assert.equal(oversizedExport.commands[0]?.stdout, "export-over-limit\n");
  assert.equal(oversizedExport.patch.captured, false);
  assert.equal(oversizedExport.artifacts.length, 1);
  assert.equal(oversizedExport.workspace.retained, true);
  assert.match(oversizedExport.errors.join("\n"), /file byte limit/u);
  assert.equal(oversizedExport.execution.kind, "docker");
  assert.equal(oversizedExport.execution.storage.cleanup, "retained");

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
  assert.equal(unsafeExport.status, "failed");
  assert.equal(unsafeExport.attempt.outcome, "completed");
  assert.equal(unsafeExport.patch.captured, false);
  assert.equal(unsafeExport.workspace.retained, true);
  assert.ok(unsafeExport.execution.kind === "docker");
  assert.ok(unsafeExport.execution.workspacePath);
  await access(join(unsafeExport.execution.workspacePath, "answer.txt"));
  assert.equal(unsafeExport.artifacts.length, 1);
  assert.equal(unsafeExport.execution.storage.cleanup, "retained");
  assert.equal(
    JSON.stringify(unsafeExport).includes("host-only-sentinel"),
    false,
  );
  assert.match(unsafeExport.errors.join("\n"), /single-link regular files/su);

  for (const [retained, probe] of [
    [
      oversizedExport,
      "require('node:fs').statSync('/workspace/large.bin').size",
    ],
    [
      unsafeExport,
      "require('node:fs').lstatSync('/workspace/escape.txt').isSymbolicLink()",
    ],
  ] as const) {
    assert.equal(retained.execution.kind, "docker");
    const holder = retained.execution.storage.holderName;
    const volume = retained.execution.storage.volumeName;
    assert.ok(holder);
    assert.ok(volume);
    const state = await execFileAsync("docker", [
      "--host",
      "unix:///var/run/docker.sock",
      "inspect",
      "--format",
      "{{.State.Running}} {{(index .Mounts 0).RW}}",
      holder,
    ]);
    assert.equal(state.stdout.trim(), "true false");
    await execFileAsync("docker", [
      "--host",
      "unix:///var/run/docker.sock",
      "volume",
      "inspect",
      volume,
    ]);
    const raw = await execFileAsync("docker", [
      "--host",
      "unix:///var/run/docker.sock",
      "exec",
      holder,
      "/usr/local/bin/node",
      "-p",
      probe,
    ]);
    assert.equal(
      raw.stdout.trim(),
      retained === oversizedExport
        ? String(SAFETY_POLICY.fileBytes + 1)
        : "true",
    );
  }

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
    for (const name of [
      row.execution.storage.holderName,
      row.execution.storage.volumeName,
    ]) {
      assert.ok(name);
      const exists = await execFileAsync("docker", [
        "--host",
        "unix:///var/run/docker.sock",
        "inspect",
        name,
      ]).then(
        () => true,
        () => false,
      );
      assert.equal(exists, false, "Storage resource was not removed");
    }
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
  if (!results.some(({ workspace }) => workspace.retained))
    await cleanupTestRepositories();
  if (originalTmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = originalTmpdir;
  if (originalSecret === undefined)
    delete process.env["AGENT_EVAL_HOST_TEST_SECRET"];
  else process.env[secretKey] = originalSecret;
  // Keep the scoped fixture root, including any workspace retained after capture failure.
}
