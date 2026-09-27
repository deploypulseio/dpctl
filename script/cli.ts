#!/usr/bin/env node

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import "./node-version-check";
import * as parser from "./command-parser";
import * as execute from "./command-executor";
import * as chalk from "chalk";

function run() {
  const command = parser.createCommand();

  if (!command) {
    // Print if the command is unrecognized, then provide command help info
    const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    if (args.length && !parser.failureReported()) {
      console.error(chalk.red(`[Error]  Unrecognized command: ${args.join(" ")}`));
    }
    parser.showHelp(/*showRootDescription*/ !args.length);
    // A bare `dpctl` is someone asking for help, not a failed command: it keeps 1.0.0's exit 0 so a
    // Dockerfile smoke check or a `set -e` script does not fail on it. Anything actually typed and
    // rejected still exits 1.
    if (args.length) process.exitCode = 1;
    return;
  }

  execute
    .execute(command)
    .catch((error: any): void => {
      console.error(chalk.red(`[Error]  ${error.message}`));
      process.exit(1);
    })
    .done();
}

run();
