#!/usr/bin/env node
import { runCli } from "./cli-main.js";
runCli(process.argv.slice(2)).catch(() => {
  process.stderr.write(
    "p2pme command failed. Check the command and host terminal; run p2pme --help.\n",
  );
  process.exitCode = 1;
});
