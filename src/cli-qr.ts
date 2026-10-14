import { lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import QRCode from "qrcode";

export interface QrFile {
  write(url: string): Promise<void>;
  close(): Promise<void>;
}

async function encodeQr(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: "png",
    width: 768,
    margin: 4,
    errorCorrectionLevel: "M",
    color: { dark: "#000000ff", light: "#ffffffff" },
  });
}

async function openQrFile(path: string) {
  try {
    if (!isAbsolute(path)) throw new Error("Relative path");
    const parent = await lstat(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o077) !== 0
    )
      throw new Error("Non-private directory");
    return await open(path, "wx", 0o600);
  } catch {
    throw new Error(
      "Invalid QR image path. Use a new file in an existing private directory with an absolute path.",
    );
  }
}

export async function reserveQrFile(
  path: string,
  encode: (url: string) => Promise<Buffer> = encodeQr,
): Promise<QrFile> {
  const file = await openQrFile(path);
  const identity = await file.stat();
  let complete = false;
  let closed = false;
  return {
    async write(url) {
      await file.writeFile(await encode(url));
      complete = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      await file.close();
      if (complete) return;
      const current = await lstat(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (
        current?.isFile() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        await unlink(path);
    },
  };
}
