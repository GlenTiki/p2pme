import { afterEach, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlRequest } from "../src/local-client.js";
import { cliErrorMessage } from "../src/cli-error.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "p2pme-control-errors-"));
  directories.push(path);
  return path;
}
function status(path: string) {
  return controlRequest(path, {
    id: crypto.randomUUID(),
    op: "status",
    args: {},
  });
}
it.each(["absent/control.sock", "control.sock"])(
  "explains the missing host at %s without exposing its path",
  async (suffix) => {
    const path = join(await directory(), suffix);
    const error = await status(path).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(cliErrorMessage(error)).toBe(
      "Local host is not running. Start p2pme host --workspace PATH and keep it running. Use the same --state-dir on every command.",
    );
    expect(cliErrorMessage(error)).not.toContain(path);
  },
);
it("explains a refused private stale socket", async () => {
  const path = join(await directory(), "control.sock");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {createServer} from 'node:net'; process.umask(0o077); createServer().listen(process.argv[1],()=>process.stdout.write('ready'));",
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await once(child.stdout!, "data");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect((await lstat(path)).isSocket()).toBe(true);
    const error = await status(path).catch((error) => error);
    expect(cliErrorMessage(error)).toContain("Local host is not running.");
  } finally {
    child.kill("SIGKILL");
  }
});
it("keeps socket symlinks and unsafe directory modes as security errors", async () => {
  const parent = await directory();
  const path = join(parent, "control.sock");
  await symlink(join(parent, "missing"), path);
  await expect(status(path)).rejects.toThrow("Control socket must be private");
  await chmod(parent, 0o755);
  await expect(status(path)).rejects.toThrow(
    "Control directory must be private",
  );
});
it("keeps a parent symlink and a non-directory parent as security errors", async () => {
  const parent = await directory();
  const target = join(parent, "target");
  await mkdir(target, { mode: 0o700 });
  const link = join(parent, "link");
  await symlink(target, link);
  await expect(status(join(link, "control.sock"))).rejects.toThrow(
    "Control directory must be private",
  );
  const file = join(parent, "file");
  await writeFile(file, "", { mode: 0o600 });
  await expect(status(join(file, "control.sock"))).rejects.toThrow(
    "Control directory must be private",
  );
});
it.skipIf(process.getuid?.() === 0)(
  "does not describe denied directory access as a missing host",
  async () => {
    const parent = await directory();
    await chmod(parent, 0);
    try {
      const error = await status(join(parent, "control.sock")).catch(
        (error) => error,
      );
      expect(error.code).toBe("EACCES");
      expect(cliErrorMessage(error)).not.toContain("not running");
    } finally {
      await chmod(parent, 0o700);
    }
  },
);
