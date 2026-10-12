import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { mkdir } from "node:fs/promises";

import { sha256 } from "./identity.js";
import { SAFETY_POLICY, type SafetyDeadline } from "./safety.js";
import { materializeStorageExport } from "./storage.js";
import { readBoundedFile, scanWorkspace } from "./workspace.js";

const FileSchema = Type.Object(
  {
    path: Type.String({ maxLength: 1024 }),
    mode: Type.Union([Type.Literal("100644"), Type.Literal("100755")]),
    contentBase64: Type.String({
      maxLength: Math.ceil(SAFETY_POLICY.fileBytes / 3) * 4,
    }),
    sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);
const FilesSchema = Type.Array(FileSchema, {
  maxItems: SAFETY_POLICY.workspaceEntries,
});
const Revision = Type.String({ pattern: "^[0-9a-fA-F]{40}$" });
const Version = Type.Literal("1");
const Toolchain = Type.Object(
  { node: Type.String(), git: Type.String() },
  { additionalProperties: false },
);
export const PreparationRequestSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Version,
      kind: Type.Literal("prepare"),
      revision: Revision,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { schemaVersion: Version, kind: Type.Literal("patch"), files: FilesSchema },
    { additionalProperties: false },
  ),
]);
export const PreparationResponseSchema = Type.Union([
  Type.Object(
    {
      schemaVersion: Version,
      kind: Type.Literal("prepared"),
      revision: Revision,
      toolchain: Toolchain,
      files: FilesSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Version,
      kind: Type.Literal("patch"),
      toolchain: Toolchain,
      patch: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Version,
      kind: Type.Literal("error"),
      message: Type.String({ maxLength: 4096 }),
      toolchain: Type.Optional(Toolchain),
    },
    { additionalProperties: false },
  ),
]);
export type PreparationRequest = Static<typeof PreparationRequestSchema>;
export type PreparationResponse = Static<typeof PreparationResponseSchema>;
export type TransferFile = Static<typeof FileSchema>;

export function parsePreparationRequest(input: unknown): PreparationRequest {
  if (!Value.Check(PreparationRequestSchema, input))
    throw new Error("Invalid preparation request v1");
  return input;
}
export function parsePreparationResponse(input: unknown): PreparationResponse {
  if (!Value.Check(PreparationResponseSchema, input))
    throw new Error("Invalid preparation response v1");
  return input;
}

export async function transferFiles(
  root: string,
  deadline: SafetyDeadline,
): Promise<TransferFile[]> {
  const files = await scanWorkspace(root, deadline, { skipRootGit: true });
  const transfer: TransferFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const content = await readBoundedFile(
      root,
      file.path,
      Math.min(SAFETY_POLICY.fileBytes, SAFETY_POLICY.workspaceBytes - bytes),
      deadline,
    );
    bytes += content.length;
    transfer.push({
      path: file.path,
      mode: file.mode,
      contentBase64: content.toString("base64"),
      sha256: sha256(content),
    });
  }
  return transfer;
}

export async function materializeTransfer(
  files: readonly TransferFile[],
  root: string,
  deadline: SafetyDeadline,
): Promise<void> {
  for (const file of files) {
    deadline.remainingMs();
    const content = Buffer.from(file.contentBase64, "base64");
    if (
      content.toString("base64") !== file.contentBase64 ||
      sha256(content) !== file.sha256
    )
      throw new Error("Preparation file bytes/digest mismatch");
  }
  await mkdir(root, { recursive: true });
  const errors = await materializeStorageExport(
    {
      files: files.map(({ path, mode, contentBase64 }) => ({
        path,
        mode,
        contentBase64,
      })),
      errors: [],
    },
    root,
    deadline,
  );
  if (errors.length > 0)
    throw new Error(`Invalid preparation files: ${errors.join("; ")}`);
}
