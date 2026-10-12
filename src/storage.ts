import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { CONTAINER_POLICY } from "./execution-spec.js";
import { resolveInside } from "./paths.js";
import { SAFETY_POLICY, type SafetyDeadline } from "./safety.js";
import { assertPortablePath, registerPath } from "./workspace.js";

export const STORAGE_TRANSFER_BYTES = 96 * 1024 * 1024;

export function volumeOptions(uid: number, gid: number): string {
  return `rw,nosuid,nodev,size=${String(CONTAINER_POLICY.workspaceBytes)},nr_inodes=${String(CONTAINER_POLICY.workspaceInodes)},uid=${String(uid)},gid=${String(gid)},mode=0700`;
}

export function assertVolumePolicy(
  input: unknown,
  name: string,
  uid: number,
  gid: number,
): void {
  const schema = Type.Object({
    Name: Type.Literal(name),
    Driver: Type.Literal("local"),
    Scope: Type.Literal("local"),
    Labels: Type.Object({ "agent-eval-runner": Type.Literal(name) }),
    Options: Type.Object(
      {
        type: Type.Literal("tmpfs"),
        device: Type.Literal("tmpfs"),
        o: Type.Literal(volumeOptions(uid, gid)),
      },
      { additionalProperties: false },
    ),
  });
  if (!Value.Check(schema, input))
    throw new Error("Docker volume does not match the fixed storage policy");
}

const FilesystemSchema = Type.Object({
  type: Type.Literal(0x01021994),
  bsize: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
  blocks: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  files: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
const ProbeSchema = Type.Object({
  workspace: FilesystemSchema,
  temporary: FilesystemSchema,
});

export function assertStorageProbe(input: unknown): void {
  if (
    !Value.Check(ProbeSchema, input) ||
    input.workspace.bsize * input.workspace.blocks !==
      CONTAINER_POLICY.workspaceBytes ||
    input.workspace.files !== CONTAINER_POLICY.workspaceInodes ||
    input.temporary.bsize * input.temporary.blocks !==
      CONTAINER_POLICY.temporaryBytes ||
    input.temporary.files !== CONTAINER_POLICY.temporaryInodes
  )
    throw new Error(
      "Mounted filesystems do not enforce the fixed byte/inode storage limits",
    );
}

export const STORAGE_PROBE_SCRIPT =
  "const fs=require('node:fs'); console.log(JSON.stringify({workspace:fs.statfsSync('/workspace'),temporary:fs.statfsSync('/tmp')}))";

// The image needs only Node. Helpers are fixed runner code, not repository scripts.
// Export reads occur through a read-only holder after the agent container stops.
export const STORAGE_EXPORT_SCRIPT = String.raw`
const fs=require('node:fs'); const path=require('node:path');
const [root,limits]=JSON.parse(process.argv[1]);
const files=[]; const errors=[]; let entries=0,bytes=0,metadataBytes=0;
function fail(message) { if(errors.length<20) errors.push(String(message).slice(0,1024)); }
function visit(directory,prefix,depth) {
  if(depth>limits.pathDepth) { fail('Workspace path depth limit exceeded'); return; }
  const dir=fs.opendirSync(directory,{bufferSize:32});
  try { for(let entry;(entry=dir.readSync())!==null;) {
    if(++entries>limits.workspaceEntries) { fail('Workspace entry limit exceeded'); return; }
    const relative=prefix ? prefix+'/'+entry.name : entry.name;
    if(relative.length>1024 || relative.split('/').length>limits.pathDepth) { fail('Workspace path depth/length limit exceeded'); continue; }
    metadataBytes+=Buffer.byteLength(relative)+128;
    if(metadataBytes>limits.gitMetadataBytes) { fail('Workspace metadata byte limit exceeded'); return; }
    const target=path.join(directory,entry.name);
    try {
      const stat=fs.lstatSync(target);
      if(stat.isDirectory()) { visit(target,relative,depth+1); continue; }
      if(!stat.isFile() || stat.nlink!==1) { fail('Workspace accepts only single-link regular files and directories: '+relative); continue; }
      if(stat.size>limits.fileBytes) { fail('Workspace file byte limit exceeded: '+relative); continue; }
      if(bytes+stat.size>limits.workspaceBytes) { fail('Workspace byte limit exceeded'); continue; }
      const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try {
        const opened=fs.fstatSync(fd);
        if(!opened.isFile() || opened.nlink!==1 || opened.size!==stat.size) throw Error('Workspace changed during export');
        const data=Buffer.alloc(stat.size+1); let read=0;
        while(read<data.length) { const count=fs.readSync(fd,data,read,Math.min(65536,data.length-read),null); if(count===0) break; read+=count; }
        if(read!==stat.size) throw Error('Workspace changed during export');
        bytes+=read;
        files.push({path:relative,mode:(stat.mode&73)===0?'100644':'100755',contentBase64:data.subarray(0,read).toString('base64')});
      } finally { fs.closeSync(fd); }
    } catch(error) { fail(error.message); }
  } } finally { dir.closeSync(); }
}
visit(root,'',0);
process.stdout.write(JSON.stringify({files,errors}));
`;

export const STORAGE_IMPORT_SCRIPT = String.raw`
const fs=require('node:fs'); const path=require('node:path');
const files=JSON.parse(fs.readFileSync(0,'utf8'));
for(const file of files) {
  const target=path.join('/workspace',file.path);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,Buffer.from(file.contentBase64,'base64'),{flag:'wx',mode:file.mode==='100755'?493:420});
}
`;

const ExportSchema = Type.Object(
  {
    files: Type.Array(
      Type.Object(
        {
          path: Type.String({ maxLength: 1024 }),
          mode: Type.Union([Type.Literal("100644"), Type.Literal("100755")]),
          contentBase64: Type.String({
            maxLength: Math.ceil(SAFETY_POLICY.fileBytes / 3) * 4,
          }),
        },
        { additionalProperties: false },
      ),
      { maxItems: SAFETY_POLICY.workspaceEntries },
    ),
    errors: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 20 }),
  },
  { additionalProperties: false },
);

// Never extract a daemon archive. Validate names/bytes before exclusively writing files.
export async function materializeStorageExport(
  input: unknown,
  root: string,
  deadline: SafetyDeadline,
): Promise<string[]> {
  if (!Value.Check(ExportSchema, input))
    throw new Error("Invalid bounded workspace export");
  const errors = [...input.errors];
  const paths = new Map<string, string>();
  let bytes = 0;
  let metadataBytes = 0;
  await mkdir(root, { recursive: true });
  for (const file of input.files) {
    deadline.remainingMs();
    try {
      assertPortablePath(file.path);
      registerPath(file.path, paths);
      metadataBytes += Buffer.byteLength(file.path) + 128;
      if (
        paths.size > SAFETY_POLICY.workspaceEntries ||
        metadataBytes > SAFETY_POLICY.gitMetadataBytes
      )
        throw new Error("Workspace export entry/metadata limit exceeded");
      const content = Buffer.from(file.contentBase64, "base64");
      if (
        content.toString("base64") !== file.contentBase64 ||
        content.length > SAFETY_POLICY.fileBytes ||
        bytes + content.length > SAFETY_POLICY.workspaceBytes
      )
        throw new Error("Invalid or oversized workspace export bytes");
      bytes += content.length;
      const target = resolveInside(root, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, {
        flag: "wx",
        mode: file.mode === "100755" ? 0o755 : 0o644,
      });
    } catch (error) {
      if (errors.length < 20)
        errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
