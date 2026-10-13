import { describe, expect, it } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { runCli } from "../src/cli-main.js";
import {
  approvalText,
  createTerminalApprover,
  terminalJson,
} from "../src/cli-consent.js";
import type { ControlRequest } from "../src/local-client.js";

function fixture() {
  let output = "";
  const requests: ControlRequest[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += String(chunk);
      done();
    },
  });
  return {
    requests,
    output: () => output,
    options: {
      input: Readable.from(["private-invitation"]),
      output: stream,
      request: async (_socket: string, request: ControlRequest) => {
        requests.push(request);
        return {
          id: request.id,
          ok: true as const,
          result: { completed: true },
        };
      },
    },
  };
}
describe("local CLI", () => {
  it("reuses one terminal across aborted approvals until host shutdown", async () => {
    let opens = 0;
    let closes = 0;
    const input = new PassThrough();
    const terminal = createTerminalApprover(() => {
      opens++;
      return {
        input,
        output: new PassThrough(),
        close() {
          closes++;
          input.destroy();
        },
      };
    });
    const approval = {
      label: "test",
      principal: "human-device" as const,
      scopes: ["sessions:list" as const],
      profileIds: ["codex"],
      workspace: "/workspace",
      sessionAccess: "registered" as const,
      expiresAt: "2026-10-13T20:00:00Z",
    };
    for (let index = 0; index < 6; index++) {
      const abort = new AbortController();
      const question = terminal.confirm(approval, abort.signal);
      abort.abort();
      await expect(question).rejects.toThrow();
    }
    const question = terminal.confirm(approval, new AbortController().signal);
    input.write("approve\n");
    expect(await question).toBe(true);
    expect(opens).toBe(1);
    expect(closes).toBe(0);
    await terminal.close();
    expect(closes).toBe(1);
  });
  it("propagates daemon shutdown failure through the CLI error path", async () => {
    const f = fixture();
    await expect(
      runCli(["host", "--workspace", "/private/tmp"], {
        ...f.options,
        daemon: async () => {
          setImmediate(() => process.emit("SIGTERM"));
          return {
            host: { hostId: crypto.randomUUID() },
            close: async () => {
              throw new Error("close failed");
            },
          };
        },
      }),
    ).rejects.toThrow("close failed");
  });
  it("prints help without starting an agent or connection", async () => {
    const f = fixture();
    await runCli(["--help"], f.options);
    expect(f.output()).toContain("p2pme host --workspace");
    expect(f.requests).toEqual([]);
  });
  it("reads pairing secrets from stdin and requires explicit profiles", async () => {
    const f = fixture();
    await runCli(
      [
        "pair",
        "--profiles",
        "codex",
        "--agent",
        "--scopes",
        "sessions:list,tasks:delegate",
      ],
      f.options,
    );
    expect(f.requests[0]!.args).toEqual({
      invitation: "private-invitation",
      principal: "agent",
      scopes: ["sessions:list", "tasks:delegate"],
      profileIds: ["codex"],
    });
    expect(f.output()).not.toContain("private-invitation");
    await expect(runCli(["pair"], fixture().options)).rejects.toThrow(
      "--profiles",
    );
    await expect(
      runCli(["pair", "--profiles", "codex", "--yes"], fixture().options),
    ).rejects.toThrow();
  });
  it("rejects hidden command arguments before request dispatch", async () => {
    const f = fixture();
    await expect(
      runCli(["start", "codex", "--shell", "cmd"], f.options),
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
  it("escapes terminal control and format characters in status", () => {
    const output = terminalJson({ label: "bad\u009b\u202e" });
    expect(output).not.toContain("\u009b");
    expect(output).not.toContain("\u202e");
    expect(JSON.parse(output)).toEqual({ label: "bad\u009b\u202e" });
  });
  it("states future session and provider tool access before approval", () => {
    const prompt = approvalText({
      label: "Phone",
      principal: "human-device",
      scopes: ["sessions:chat"],
      profileIds: ["codex"],
      workspace: "/workspace",
      sessionAccess: "registered",
      expiresAt: "2026-10-13T20:00:00Z",
    });
    expect(prompt).toContain("current and future registered sessions");
    expect(prompt).toContain("existing tools and return local file content");
    expect(prompt).toContain("/workspace");
  });
});
