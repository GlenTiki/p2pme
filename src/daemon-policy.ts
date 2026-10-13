import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const schema = z
  .object({
    version: z.literal(1),
    workspace: z
      .object({ path: z.string(), dev: z.number(), ino: z.number() })
      .strict(),
    invitations: z
      .array(
        z
          .object({
            id: z.uuid(),
            expiresAt: z.string().datetime({ precision: 0 }),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
type Policy = z.infer<typeof schema>;
export interface DaemonPolicy {
  readonly workspace: string;
  consume(id: string, expiresAt: string): Promise<void>;
}
async function writePolicy(directory: string, policy: Policy): Promise<void> {
  const temporary = join(directory, `daemon-${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(policy));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, "daemon.json"));
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function openDaemonPolicy(
  directory: string,
  workspace: string,
  hasState: boolean,
): Promise<DaemonPolicy> {
  const path = await realpath(workspace);
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error("Invalid workspace");
  const identity = { path, dev: info.dev, ino: info.ino };
  let policy: Policy;
  try {
    const file = join(directory, "daemon.json");
    if (!(await lstat(file)).isFile())
      throw new Error("Invalid daemon policy file");
    await chmod(file, 0o600);
    policy = schema.parse(JSON.parse(await readFile(file, "utf8")));
    if (JSON.stringify(policy.workspace) !== JSON.stringify(identity))
      throw new Error(
        "Host workspace identity changed; use a separate state directory",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (hasState)
      throw new Error(
        "Missing workspace policy; use a separate state directory",
        { cause: error },
      );
    policy = { version: 1, workspace: identity, invitations: [] };
    await writePolicy(directory, policy);
  }
  return {
    workspace: path,
    async consume(id, expiresAt) {
      const invitations = policy.invitations.filter(
        (item) => Date.parse(item.expiresAt) > Date.now(),
      );
      if (
        invitations.some((item) => item.id === id) ||
        invitations.length >= 256
      )
        throw new Error("Pairing invitation was already used or limit reached");
      const next = schema.parse({
        ...policy,
        invitations: [
          ...invitations,
          {
            id,
            expiresAt: new Date(
              Math.max(Date.parse(expiresAt), Date.now() + 600000),
            )
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          },
        ],
      });
      await writePolicy(directory, next);
      policy = next;
    },
  };
}
