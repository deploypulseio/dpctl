// Contract tests for the command line itself: exit codes and which flags are accepted.
//
// These run the real CLI in a child process rather than calling createCommand(), because what is being
// guarded here IS the process-level behaviour: the exit code a CI script branches on, and whether yargs
// accepts a flag at all. A unit call cannot observe either, and yargs keeps module state between parses.
//
// Every run gets an empty HOME and no DEPLOYPULSE_ACCESS_KEY, so there is no session file and the CLI
// stops at "You are not currently logged in" instead of doing real work against a real account.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const CLI_PATH = path.join(__dirname, "..", "script", "cli.ts");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

let sandboxHome: string;

function run(...args: string[]): Run {
  const result = spawnSync(process.execPath, ["-r", "ts-node/register", CLI_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: sandboxHome,
      LOCALAPPDATA: sandboxHome,
      DEPLOYPULSE_ACCESS_KEY: "",
      DEPLOYPULSE_ORG_ID: "",
      TS_NODE_TRANSPILE_ONLY: "1",
      // chalk would otherwise wrap the strings being matched in escape codes.
      FORCE_COLOR: "0",
    },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

describe("command line", function () {
  // Each run boots ts-node, so this suite is seconds rather than milliseconds.
  this.timeout(60000);

  before(() => {
    sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-test-home-"));
  });

  after(() => {
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Exit codes. `dpctl` on its own is someone asking for help; anything typed and rejected is an error.
  // ---------------------------------------------------------------------------

  it("a bare dpctl prints help and exits 0", () => {
    const result = run();
    assert.strictEqual(result.status, 0, "a Dockerfile smoke check or a `set -e` script must not fail on this");
    assert.ok(/Usage: dpctl/.test(result.output), result.output.slice(0, 400));
  });

  it("help is branded dpctl, not the entry file name", () => {
    // yargs falls back to $0 without scriptName, which printed "cli.js app add" in every listing.
    const result = run("app", "--help");
    assert.ok(/dpctl app add/.test(result.output), result.output.slice(0, 400));
    assert.ok(!/cli\.js/.test(result.output), `the entry file leaked into help: ${result.output.slice(0, 400)}`);
  });

  it("an unrecognized command exits 1 and says which one", () => {
    const result = run("nonsense-command");
    assert.strictEqual(result.status, 1);
    assert.ok(/Unrecognized command: nonsense-command/.test(result.output), result.output.slice(0, 400));
  });

  // ---------------------------------------------------------------------------
  // -h is help, everywhere, and reserved so no option can claim it later.
  // ---------------------------------------------------------------------------

  it("-h prints help and exits 0, on a subcommand as well as the root", () => {
    const result = run("release-react", "-h");
    assert.strictEqual(result.status, 0, "-h must not be read as an argument to the command");
    assert.ok(/Usage: dpctl release-react/.test(result.output), result.output.slice(0, 400));
    assert.ok(/-h, --help/.test(result.output), "-h should be listed as the help alias");
  });

  // ---------------------------------------------------------------------------
  // strictOptions rejects an unknown flag before anything runs, so "was it accepted?" is answered by
  // whether the run got as far as the auth check. Every spelling below appears in older docs or in
  // scripts migrated from upstream code-push, so all of them have to survive.
  // ---------------------------------------------------------------------------

  const NOT_LOGGED_IN = /not currently logged in/;
  const UNKNOWN_ARGUMENT = /Unknown argument/i;

  ["--private-key", "--private-key-path", "--privateKeyPath", "-k"].forEach((flag: string) => {
    it(`release-react accepts ${flag}`, () => {
      const result = run("release-react", "myapp", "ios", flag, "./private.pem");
      assert.ok(!UNKNOWN_ARGUMENT.test(result.output), `${flag} was rejected by strictOptions: ${result.output.slice(0, 300)}`);
      // Reaching the auth check proves the parse succeeded and nothing was released.
      assert.ok(NOT_LOGGED_IN.test(result.output), result.output.slice(0, 300));
    });
  });

  it("an actually unknown option is still rejected", () => {
    // The guard above is only meaningful if strictOptions still bites.
    const result = run("release-react", "myapp", "ios", "--not-a-real-flag", "x");
    assert.notStrictEqual(result.status, 0);
    assert.ok(UNKNOWN_ARGUMENT.test(result.output), result.output.slice(0, 300));
  });

  it("--deployment is accepted as an alias for --deploymentName", () => {
    const result = run("release-react", "myapp", "ios", "--deployment", "Production");
    assert.ok(!UNKNOWN_ARGUMENT.test(result.output), result.output.slice(0, 300));
    assert.ok(NOT_LOGGED_IN.test(result.output), result.output.slice(0, 300));
  });
});

// ---------------------------------------------------------------------------
// Two dependencies of the destructive-command path, kept honest here because both broke silently once.
// ---------------------------------------------------------------------------

