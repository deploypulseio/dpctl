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

// Parses args and returns the command object, without running it. A fresh process per call, because
// yargs keeps module state between parses.
function parse(...args: string[]): any {
  const script = 'const p = require(process.argv[1]); console.log("CMD:" + JSON.stringify(p.createCommand()));';
  const parserPath = path.join(__dirname, "..", "script", "command-parser.ts");
  const result = spawnSync(process.execPath, ["-r", "ts-node/register", "-e", script, parserPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: sandboxHome, TS_NODE_TRANSPILE_ONLY: "1", FORCE_COLOR: "0" },
  });
  const line = (result.stdout || "").split("\n").find((l: string) => l.startsWith("CMD:"));
  assert.ok(line, `no command parsed: ${(result.stdout || "") + (result.stderr || "")}`.slice(0, 400));
  return JSON.parse(line.slice("CMD:".length));
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

  it("-h is not an alias for --useHermes", () => {
    const result = run("release-react", "--help");
    const hermesLine = result.output.split("\n").find((line: string) => line.indexOf("--useHermes") >= 0);
    assert.ok(hermesLine, "expected a --useHermes option");
    assert.ok(!/-h, --useHermes/.test(hermesLine), `-h must not be bound to Hermes: ${hermesLine}`);
  });

  it("--useHermes works under its long name", () => {
    const result = run("release-react", "--help");
    assert.ok(/--useHermes/.test(result.output), "the long flag is the supported spelling");
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

  // ---------------------------------------------------------------------------
  // Expo Updates. release-expo is a new command, and rollback grew options that only apply to it.
  // ---------------------------------------------------------------------------

  it("release-expo is registered and documents the export it takes", () => {
    const result = run("release-expo", "-h");
    assert.strictEqual(result.status, 0);
    assert.ok(/Usage: dpctl release-expo/.test(result.output), result.output.slice(0, 400));
    ["--exportDir", "--runtimeVersion", "--platform"].forEach((flag: string) => {
      assert.ok(result.output.indexOf(flag) >= 0, `${flag} is missing from release-expo help`);
    });
  });

  it("rollback accepts the Expo options", () => {
    const result = run("rollback", "myapp", "Production", "--platform", "ios", "--runtimeVersion", "1.0.0", "--toEmbedded");
    assert.ok(!UNKNOWN_ARGUMENT.test(result.output), result.output.slice(0, 300));
    assert.ok(NOT_LOGGED_IN.test(result.output), result.output.slice(0, 300));
  });

  // ---------------------------------------------------------------------------
  // Two checks that reject at parse time, before anything is sent.
  // ---------------------------------------------------------------------------

  it("deployment errors rejects a --limit below 1", () => {
    const result = run("deployment", "errors", "myapp", "Production", "--limit", "0");
    assert.notStrictEqual(result.status, 0);
    assert.ok(/--limit must be a whole number of 1 or more/.test(result.output), result.output.slice(0, 300));
  });

  it("webhook update rejects --enabled and --disabled together", () => {
    const result = run("webhook", "update", "abc-123", "--enabled", "--disabled");
    assert.notStrictEqual(result.status, 0);
    assert.ok(/Pass --enabled or --disabled, not both/.test(result.output), result.output.slice(0, 300));
  });

  it("webhook update takes either flag on its own", () => {
    ["--enabled", "--disabled", "--no-enabled"].forEach((flag: string) => {
      const result = run("webhook", "update", "abc-123", flag);
      assert.ok(!UNKNOWN_ARGUMENT.test(result.output), `${flag}: ${result.output.slice(0, 300)}`);
      assert.ok(NOT_LOGGED_IN.test(result.output), `${flag}: ${result.output.slice(0, 300)}`);
    });
  });

  it("webhook update maps --disabled to enabled: false", () => {
    assert.strictEqual(parse("webhook", "update", "abc-123", "--disabled").enabled, false);
    assert.strictEqual(parse("webhook", "update", "abc-123", "--enabled").enabled, true);
    assert.strictEqual(parse("webhook", "update", "abc-123", "--no-enabled").enabled, false);
    // Neither flag given is not the same as disabling it.
    assert.strictEqual(parse("webhook", "update", "abc-123", "--name", "x").enabled, null);
  });

  it("a bare command category reports one error, not the source of a check callback", () => {
    ["org", "app", "webhook", "deployment", "access-key"].forEach((category: string) => {
      const result = run(category);
      const errors = result.output.split("\n").filter((line: string) => line.indexOf("[Error]") >= 0);
      assert.strictEqual(errors.length, 1, `${category} printed ${errors.length} errors:\n${errors.join("\n")}`);
      assert.ok(!/Argument check failed/.test(result.output), `${category} leaked the check callback`);
      assert.strictEqual(result.status, 1, `${category} should still exit 1`);
    });
  });

  it("each command is registered once", () => {
    // A command registered twice silently wins with its last builder, so its newest options vanish
    // from the parse while still showing up in the source.
    const listed = run("--help")
      .output.split("\n")
      .map((line: string) => /^\s{2}dpctl ([a-z][a-z-]*)/.exec(line))
      .filter((match: RegExpExecArray | null): match is RegExpExecArray => !!match)
      .map((match: RegExpExecArray) => match[1]);
    const duplicates = listed.filter((name: string, index: number) => listed.indexOf(name) !== index);
    assert.deepStrictEqual(duplicates, [], `registered more than once: ${duplicates.join(", ")}`);
    assert.ok(listed.indexOf("release-expo") >= 0, "release-expo should be listed in help");
  });
});

// ---------------------------------------------------------------------------
// Two dependencies of the destructive-command path, kept honest here because both broke silently once.
// ---------------------------------------------------------------------------


describe("confirm on a non-terminal", () => {
  const cmdexec = require("../script/command-executor");

  it("declines instead of hanging when nobody can answer", function (done: Mocha.Done) {
    // Forced, not inherited: stdin is piped under CI but a terminal under `npm test`.
    this.timeout(5000);
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const restore = (): void => {
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else delete (process.stdin as any).isTTY;
    };

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        restore();
        done(new Error("confirm never settled: it is hanging again"));
      }
    }, 3000);

    cmdexec.confirm("Delete it?").then(
      (answer: boolean) => {
        settled = true;
        clearTimeout(timer);
        restore();
        assert.strictEqual(answer, false, "an unanswered destructive question is a no");
        done();
      },
      (error: any) => {
        restore();
        done(error);
      }
    );
  });
});

describe("deleteFolder", () => {
  const cmdexec = require("../script/command-executor");

  it("only expands a pattern when asked to", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-glob-test-"));
    const pattern = path.join(os.tmpdir(), "dpctl-glob-test-*");

    await cmdexec.deleteFolder(pattern);
    assert.strictEqual(fs.existsSync(dir), true, "without glob a pattern is a literal path, so nothing matches");

    await cmdexec.deleteFolder(pattern, true);
    assert.strictEqual(fs.existsSync(dir), false, "the glob flag is what actually deletes");
  });

  it("leaves glob off by default, so a literal path with metacharacters is safe", async () => {
    // An --outputDir like "build[1]" is a real directory name, not a pattern.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-literal-"));
    const literal = path.join(parent, "build[1]");
    fs.mkdirSync(literal);
    fs.writeFileSync(path.join(literal, "keep.txt"), "x");

    await cmdexec.deleteFolder(literal);
    assert.strictEqual(fs.existsSync(literal), false, "the literal directory itself is removed");

    fs.rmSync(parent, { recursive: true, force: true });
  });
});
