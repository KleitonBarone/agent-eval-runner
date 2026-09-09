import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { resolveInside } from "./paths.js";
import type { Redactor } from "./redaction.js";

export interface CapturedArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly originalBytes: number;
  readonly sha256: string;
  readonly originalSha256: string;
  readonly redacted: boolean;
  readonly contentBase64: string;
}

export async function captureArtifact(
  root: string,
  descriptor: { readonly path: string; readonly mediaType: string },
  maxBytes: number,
  redact: Redactor,
): Promise<CapturedArtifact> {
  const rootRealPath = await realpath(root);
  const requested = resolveInside(root, descriptor.path);
  const targetRealPath = await realpath(requested);
  const relation = relative(rootRealPath, targetRealPath);
  if (relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(
      `Artifact resolves outside the disposable worktree: ${descriptor.path}`,
    );
  }

  const metadata = await stat(targetRealPath);
  if (!metadata.isFile())
    throw new Error(`Artifact is not a file: ${descriptor.path}`);
  if (metadata.size > maxBytes) {
    throw new Error(
      `Artifact exceeds the ${String(maxBytes)} byte limit: ${descriptor.path}`,
    );
  }
  const originalContent = await readFile(targetRealPath);
  const isText =
    descriptor.mediaType.startsWith("text/") ||
    /(?:json|xml|javascript|yaml|toml)/u.test(descriptor.mediaType);
  const redactedText = isText ? redact(originalContent.toString("utf8")) : null;
  const content =
    redactedText === null ? originalContent : Buffer.from(redactedText, "utf8");
  return {
    path: descriptor.path,
    mediaType: descriptor.mediaType,
    bytes: content.byteLength,
    originalBytes: originalContent.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    originalSha256: createHash("sha256").update(originalContent).digest("hex"),
    redacted: !content.equals(originalContent),
    contentBase64: content.toString("base64"),
  };
}
