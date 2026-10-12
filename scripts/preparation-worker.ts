import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  assertCheckoutRoot,
  capturePatch,
  prepareObjectCheckout,
  type PreparedCheckout,
} from "../src/git.js";
import { PREPARATION_POLICY } from "../src/execution-spec.js";
import {
  materializeTransfer,
  parsePreparationRequest,
  transferFiles,
  type PreparationResponse,
} from "../src/preparation-protocol.js";
import { SAFETY_POLICY, SafetyDeadline } from "../src/safety.js";

const execFileAsync = promisify(execFile);
process.env["TMPDIR"] = "/workspace";
const statePath = "/workspace/preparation-state.json";
let toolchain: { node: string; git: string } | undefined;
const StateSchema = Type.Object(
  {
    sourcePath: Type.String(),
    rootPath: Type.String(),
    gitPath: Type.String(),
    path: Type.String(),
    revision: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  },
  { additionalProperties: false },
);

async function readInput(): Promise<string> {
  return new Promise((done, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PREPARATION_POLICY.transferBytes) {
        reject(new Error("Preparation input byte limit exceeded"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => {
      done(Buffer.concat(chunks, bytes).toString("utf8"));
    });
  });
}

async function main(): Promise<PreparationResponse> {
  const input: unknown = JSON.parse(await readInput());
  const request = parsePreparationRequest(input);
  const deadline = new SafetyDeadline();
  const { stdout: version } = await execFileAsync(
    "/usr/bin/git",
    ["--version"],
    { timeout: deadline.remainingMs(), maxBuffer: 4096 },
  );
  toolchain = { node: process.version, git: version.trim() };
  const gitVersion = /^git version (\d+)\.(\d+)/u.exec(toolchain.git);
  if (
    gitVersion?.[1] === undefined ||
    gitVersion[2] === undefined ||
    Number(gitVersion[1]) < 2 ||
    (Number(gitVersion[1]) === 2 && Number(gitVersion[2]) < 39)
  )
    throw new Error("Preparation image requires Git 2.39 or newer");
  if (request.kind === "prepare") {
    const checkout = await prepareObjectCheckout(
      "/input/objects",
      request.revision,
      deadline,
    );
    await writeFile(statePath, JSON.stringify(checkout), { flag: "wx" });
    return {
      schemaVersion: "1",
      kind: "prepared",
      revision: checkout.revision,
      toolchain,
      files: await transferFiles(checkout.path, deadline),
    };
  }
  const saved: unknown = JSON.parse(await readFile(statePath, "utf8"));
  if (!Value.Check(StateSchema, saved))
    throw new Error("Invalid private preparation state");
  const checkout: PreparedCheckout = saved;
  await assertCheckoutRoot(checkout);
  for (const entry of await readdir(checkout.path))
    if (entry !== ".git")
      await rm(join(checkout.path, entry), { recursive: true, force: true });
  await materializeTransfer(request.files, checkout.path, deadline);
  const patch = await capturePatch(checkout, deadline);
  if (Buffer.byteLength(patch) > SAFETY_POLICY.patchBytes)
    throw new Error("Preparation patch byte limit exceeded");
  return { schemaVersion: "1", kind: "patch", toolchain, patch };
}

let response: PreparationResponse;
try {
  response = await main();
} catch (error) {
  response = {
    schemaVersion: "1",
    kind: "error",
    ...(toolchain === undefined ? {} : { toolchain }),
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      4096,
    ),
  };
  process.exitCode = 1;
}
const output = JSON.stringify(response);
if (Buffer.byteLength(output) > PREPARATION_POLICY.transferBytes)
  throw new Error("Preparation output byte limit exceeded");
process.stdout.write(output);
