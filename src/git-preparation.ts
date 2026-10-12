import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerExecution } from "./docker.js";
import {
  PREPARATION_IMAGE,
  PREPARATION_POLICY,
  type PreparationEvidence,
} from "./execution-spec.js";
import type { PreparedCheckout } from "./git.js";
import { sha256 } from "./identity.js";
import { createSnapshotCheckout, snapshotObjects } from "./object-snapshot.js";
import {
  materializeTransfer,
  parsePreparationResponse,
  transferFiles,
  type PreparationRequest,
} from "./preparation-protocol.js";
import type { Redactor } from "./redaction.js";
import { SAFETY_POLICY, type SafetyDeadline } from "./safety.js";
import { readBoundedFile } from "./workspace.js";

export class GitPreparation {
  checkout: PreparedCheckout | undefined;
  #sandbox: DockerExecution | undefined;
  constructor(
    readonly evidence: PreparationEvidence,
    readonly redact: Redactor,
  ) {}

  async prepare(
    source: string,
    revision: string,
    deadline: SafetyDeadline,
  ): Promise<PreparedCheckout> {
    if (process.platform !== "linux")
      throw new Error(
        "Docker preparation requires a Linux runner and local Linux Docker Engine",
      );
    if (process.getuid?.() === 0)
      throw new Error("Docker preparation requires a non-root Linux runner");
    this.checkout = await createSnapshotCheckout(source, revision);
    const checkout = this.checkout;
    const input = join(checkout.rootPath, "preparation-input");
    this.evidence.inputPath = input;
    await mkdir(input);
    const snapshot = await snapshotObjects(
      checkout.sourcePath,
      join(input, "objects"),
      deadline,
    );
    this.evidence.snapshotSha256 = snapshot.sha256;
    this.evidence.snapshotBytes = snapshot.bytes;
    this.evidence.snapshotEntries = snapshot.entries;
    await writeFile(
      join(checkout.rootPath, "object-snapshot.json"),
      JSON.stringify(snapshot),
    );
    // Built asset only. Neither tsx nor package installation runs inside the sandbox.
    const asset = fileURLToPath(
      new URL("../dist/preparation-worker.mjs", import.meta.url),
    );
    const worker = await readBoundedFile(
      dirname(asset),
      basename(asset),
      4 * 1024 * 1024,
      deadline,
    );
    this.evidence.workerSha256 = sha256(worker);
    await writeFile(join(input, "preparation-worker.mjs"), worker, {
      flag: "wx",
      mode: 0o444,
    });
    this.#sandbox = new DockerExecution(
      checkout,
      PREPARATION_IMAGE,
      this.evidence,
      this.redact,
      { kind: "git_preparer", input },
    );
    await this.#sandbox.prepare(deadline);
    const response = await this.#operation(
      { schemaVersion: "1", kind: "prepare", revision },
      deadline,
    );
    if (
      response.kind !== "prepared" ||
      response.revision.toLowerCase() !== revision.toLowerCase()
    )
      throw new Error(
        "Preparation did not return the exact requested revision",
      );
    this.evidence.git = response.toolchain.git;
    await materializeTransfer(response.files, checkout.path, deadline);
    this.checkout = { ...checkout, revision: response.revision };
    return this.checkout;
  }

  async #operation(request: PreparationRequest, deadline: SafetyDeadline) {
    if (this.#sandbox === undefined || this.checkout === undefined)
      throw new Error("Preparation sandbox is missing");
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > PREPARATION_POLICY.transferBytes)
      throw new Error("Preparation input byte limit exceeded");
    const result = await this.#sandbox.execute(
      {
        command: "/usr/local/bin/node",
        args: ["/input/preparation-worker.mjs"],
        input,
        cwd: this.checkout.path,
        timeoutMs: deadline.remainingMs(),
        timeoutTermination: "check_timeout",
        maxOutputBytes: PREPARATION_POLICY.transferBytes,
        ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
      },
      (value) => value,
    );
    if (
      result.error !== null ||
      result.termination !== null ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw new Error(
        this.redact(
          `Preparation worker failed: ${result.error ?? result.termination ?? result.stderr}`,
        ),
      );
    const output: unknown = JSON.parse(result.stdout);
    const response = parsePreparationResponse(output);
    if (response.toolchain !== undefined) {
      if (response.toolchain.node !== this.evidence.node)
        throw new Error("Preparation Node runtime changed");
      if (
        this.evidence.git !== null &&
        response.toolchain.git !== this.evidence.git
      )
        throw new Error("Preparation Git runtime changed");
      this.evidence.git = response.toolchain.git;
    }
    if (response.kind === "error")
      throw new Error(this.redact(response.message));
    if (result.exitCode !== 0)
      throw new Error(
        this.redact(`Preparation worker failed: ${result.stderr}`),
      );
    if (response.toolchain.node !== this.evidence.node)
      throw new Error("Preparation Node runtime changed");
    return response;
  }

  async capture(deadline: SafetyDeadline): Promise<string> {
    if (this.checkout === undefined)
      throw new Error("Prepared checkout is missing");
    const response = await this.#operation(
      {
        schemaVersion: "1",
        kind: "patch",
        files: await transferFiles(this.checkout.path, deadline),
      },
      deadline,
    );
    if (
      response.kind !== "patch" ||
      response.toolchain.git !== this.evidence.git
    )
      throw new Error("Preparation patch runtime changed");
    if (Buffer.byteLength(response.patch) > SAFETY_POLICY.patchBytes)
      throw new Error("Preparation patch byte limit exceeded");
    this.#sandbox?.finishExport();
    return response.patch;
  }
  async dispose(): Promise<void> {
    await this.#sandbox?.dispose();
  }
  async removeWorkspace(): Promise<void> {
    await this.#sandbox?.removeWorkspace();
  }
}
