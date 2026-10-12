import { createHash } from "node:crypto";
import type { Redactor } from "./redaction.js";
import { SafetyDeadline } from "./safety.js";
import { readBoundedFile } from "./workspace.js";

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
  deadline = new SafetyDeadline(),
): Promise<CapturedArtifact> {
  const originalContent = await readBoundedFile(
    root,
    descriptor.path,
    maxBytes,
    deadline,
  );
  const isText =
    descriptor.mediaType.startsWith("text/") ||
    /(?:json|xml|javascript|yaml|toml)/u.test(descriptor.mediaType);
  const redactedText = isText ? redact(originalContent.toString("utf8")) : null;
  const content =
    redactedText === null ? originalContent : Buffer.from(redactedText, "utf8");
  if (content.length > maxBytes)
    throw new Error(
      `Redacted artifact exceeds the ${String(maxBytes)} byte limit: ${descriptor.path}`,
    );
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
