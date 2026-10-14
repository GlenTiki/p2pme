import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { reserveQrFile } from "../src/cli-qr.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "p2pme-qr-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("private invitation QR image", () => {
  it("writes a private readable PNG with the exact synthetic link", async () => {
    const path = join(await directory(), "phone.png");
    const url =
      "https://p2pme.glentiki.dev/live/#pair=synthetic-private-invitation";
    const file = await reserveQrFile(path);
    expect((await lstat(path)).size).toBe(0);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await file.write(url);
    await file.close();
    const png = PNG.sync.read(await readFile(path));
    expect(png.width).toBeGreaterThanOrEqual(512);
    expect(png.width).toBe(768);
    expect(png.height).toBe(png.width);
    expect(
      jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data,
    ).toBe(url);
    expect([...png.data.subarray(0, png.width * 4)]).toEqual(
      Array(png.width * 4).fill(255),
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });
  it("removes a newly reserved empty file when no invitation arrives", async () => {
    const path = join(await directory(), "phone.png");
    const file = await reserveQrFile(path);
    await file.close();
    await file.close();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes its incomplete image after encoding fails", async () => {
    const path = join(await directory(), "phone.png");
    const file = await reserveQrFile(path, async () => {
      await writeFile(path, "partial synthetic image");
      throw new Error("encoder failure");
    });
    await expect(file.write("synthetic")).rejects.toThrow("encoder failure");
    await file.close();
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves a replacement path during failed-image cleanup", async () => {
    const path = join(await directory(), "phone.png");
    const file = await reserveQrFile(path);
    await unlink(path);
    await writeFile(path, "replacement");
    await file.close();
    expect(await readFile(path, "utf8")).toBe("replacement");
  });
  it("rejects relative paths, public parents and symlink parents", async () => {
    const parent = await directory();
    await expect(reserveQrFile("relative.png")).rejects.toThrow(
      "Invalid QR image path",
    );
    const publicParent = join(parent, "public");
    await mkdir(publicParent, { mode: 0o755 });
    await chmod(publicParent, 0o755);
    await expect(
      reserveQrFile(join(publicParent, "phone.png")),
    ).rejects.toThrow("Invalid QR image path");
    const link = join(parent, "link");
    await symlink(parent, link);
    await expect(reserveQrFile(join(link, "phone.png"))).rejects.toThrow(
      "Invalid QR image path",
    );
  });
  it("preserves existing images and symlink targets", async () => {
    const parent = await directory();
    const path = join(parent, "phone.png");
    await writeFile(path, "existing");
    await expect(reserveQrFile(path)).rejects.toThrow("Invalid QR image path");
    const link = join(parent, "link.png");
    await symlink(path, link);
    await expect(reserveQrFile(link)).rejects.toThrow("Invalid QR image path");
    expect(await readFile(path, "utf8")).toBe("existing");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
