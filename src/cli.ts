#!/usr/bin/env node
import { runCli } from "./cli-main.js";
import { cliErrorMessage } from "./cli-error.js";
runCli(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(cliErrorMessage(error) + "\n");
  process.exitCode = 1;
});
