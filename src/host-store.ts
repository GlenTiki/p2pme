import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { hostStateSchema, type HostState } from "./host-protocol.js";

export interface HostStore {
  readonly hostId: string;
  readonly healthy: boolean;
  snapshot(): HostState;
  update(change: (state: HostState) => void): Promise<void>;
  close(): Promise<void>;
}

export type StateWriter = (
  directory: string,
  state: HostState,
) => Promise<void>;

async function writeState(directory: string, state: HostState): Promise<void> {
  const temporary = join(directory, `host-${crypto.randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, "host.json"));
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

class LocalHostStore implements HostStore {
  private pending = Promise.resolve();
  private failed = false;
  private closing: Promise<void> | null = null;
  constructor(
    private readonly directory: string,
    private state: HostState,
    private readonly write: StateWriter,
    private readonly release: () => Promise<void>,
  ) {}
  get hostId(): string {
    return this.state.hostId;
  }
  get healthy(): boolean {
    return !this.failed && !this.closing;
  }
  snapshot(): HostState {
    return structuredClone(this.state);
  }
  update(change: (state: HostState) => void): Promise<void> {
    const mutation = this.pending.then(async () => {
      if (!this.healthy) throw new Error("Host persistence is unavailable");
      const next = this.snapshot();
      change(next);
      const valid = hostStateSchema.parse(next);
      try {
        await this.write(this.directory, valid);
      } catch (error) {
        this.failed = true;
        throw error;
      }
      this.state = valid;
    });
    this.pending = mutation.catch(() => {});
    return mutation;
  }
  close(): Promise<void> {
    this.closing ??= this.pending.then(this.release);
    return this.closing;
  }
}

async function acquireLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, "host.lock");
  const file = await open(path, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(
          "Host store is already open; inspect host.lock before manual recovery",
        );
      throw error;
    },
  );
  const identity = await file.stat();
  await file.writeFile(
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
  );
  return async () => {
    await file.close();
    const current = await lstat(path);
    if (current.dev === identity.dev && current.ino === identity.ino)
      await unlink(path);
  };
}

async function readState(directory: string): Promise<HostState | null> {
  const path = join(directory, "host.json");
  try {
    if (!(await lstat(path)).isFile())
      throw new Error("Host state must be a regular file");
    await chmod(path, 0o600);
    return hostStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function openHostStore(
  directory: string,
  write: StateWriter = writeState,
): Promise<HostStore> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Host state path must be a directory");
  await chmod(directory, 0o700);
  const release = await acquireLock(directory);
  try {
    let state = await readState(directory);
    if (!state) {
      state = {
        version: 1,
        hostId: crypto.randomUUID(),
        grants: [],
        sessions: [],
      };
      await write(directory, state);
    }
    return new LocalHostStore(directory, state, write, release);
  } catch (error) {
    await release();
    throw error;
  }
}
