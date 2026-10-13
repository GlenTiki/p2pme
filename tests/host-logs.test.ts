import { expect, it } from "vitest";
import { HostLogPair } from "../src/host-logs.js";
import { MAX_SESSION_ENTRIES } from "../src/protocol.js";

function fixture() {
  const writes: unknown[] = [];
  let stopped = false;
  const log = {
    async append(value: unknown) {
      writes.push(value);
    },
    async close() {},
  };
  const pair = new HostLogPair({ ingress: log, egress: log }, () => {
    stopped = true;
  });
  return { pair, writes, stopped: () => stopped };
}
it("reserves a final receipt while outputs consume the remaining slots", async () => {
  const f = fixture();
  for (let index = 0; index < MAX_SESSION_ENTRIES - 2; index++)
    await f.pair.egress.append("surface");
  const request = f.pair.reserve(true);
  await f.pair.ingress.append("request");
  request.check();
  await f.pair.egress.append("completed");
  await request.appendResult("receipt");
  request.release();
  expect(f.writes.slice(-3)).toEqual(["request", "completed", "receipt"]);
  expect(() => f.pair.reserve(false)).toThrow("restart");
});
it("fails before invocation if a concurrent publication consumes the output slot", async () => {
  const f = fixture();
  for (let index = 0; index < MAX_SESSION_ENTRIES - 2; index++)
    await f.pair.egress.append("surface");
  const request = f.pair.reserve(true);
  await f.pair.egress.append("concurrent surface");
  expect(() => request.check()).toThrow("restart");
  request.release();
  expect(f.stopped()).toBe(true);
});
it("accounts for pending writes before admitting another append", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = false;
  const log = {
    async append() {
      if (block) await held;
    },
    async close() {},
  };
  const pair = new HostLogPair({ ingress: log, egress: log }, () => {});
  for (let index = 0; index < MAX_SESSION_ENTRIES - 1; index++)
    await pair.egress.append("surface");
  block = true;
  const pending = pair.egress.append("last");
  const rejected = expect(pending).rejects.toThrow("restart");
  await expect(pair.egress.append("excess")).rejects.toThrow("restart");
  release();
  await rejected;
});
