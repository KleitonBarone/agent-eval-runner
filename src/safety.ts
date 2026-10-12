import { Type, type Static } from "@sinclair/typebox";

export const SAFETY_POLICY = {
  version: "raw-git-and-bounded-capture-v1",
  checkout: "raw_blobs",
  patch: "all_regular_files",
  workspaceBytes: 64 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  workspaceEntries: 10_000,
  pathDepth: 32,
  patchBytes: 8 * 1024 * 1024,
  totalArtifactBytes: 8 * 1024 * 1024,
  gitMetadataBytes: 2 * 1024 * 1024,
  phaseTimeoutMs: 30_000,
} as const;

export const SafetyPolicySchema = Type.Object(
  {
    version: Type.Literal(SAFETY_POLICY.version),
    checkout: Type.Literal(SAFETY_POLICY.checkout),
    patch: Type.Literal(SAFETY_POLICY.patch),
    workspaceBytes: Type.Literal(SAFETY_POLICY.workspaceBytes),
    fileBytes: Type.Literal(SAFETY_POLICY.fileBytes),
    workspaceEntries: Type.Literal(SAFETY_POLICY.workspaceEntries),
    pathDepth: Type.Literal(SAFETY_POLICY.pathDepth),
    patchBytes: Type.Literal(SAFETY_POLICY.patchBytes),
    totalArtifactBytes: Type.Literal(SAFETY_POLICY.totalArtifactBytes),
    gitMetadataBytes: Type.Literal(SAFETY_POLICY.gitMetadataBytes),
    phaseTimeoutMs: Type.Literal(SAFETY_POLICY.phaseTimeoutMs),
  },
  { additionalProperties: false },
);
export type SafetyPolicy = Static<typeof SafetyPolicySchema>;

// Deadlines bound Git subprocesses and are checked between filesystem operations.
export class SafetyDeadline {
  readonly #expiresAt: number;
  constructor(
    timeoutMs: number = SAFETY_POLICY.phaseTimeoutMs,
    readonly signal?: AbortSignal,
  ) {
    this.#expiresAt = performance.now() + timeoutMs;
  }
  remainingMs(): number {
    if (this.signal?.aborted === true)
      throw new Error("Safety phase cancelled");
    const remaining = Math.floor(this.#expiresAt - performance.now());
    if (remaining <= 0) throw new Error("Safety phase deadline exceeded");
    return remaining;
  }
}
