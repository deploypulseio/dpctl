// The session file holds a live access key, so these drive the real read and write paths rather than
// the stub the CLI tests use. `configFilePath` is resolved at import time from HOME, so each test
// points HOME at a temp directory and loads a fresh copy of the module.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function withTempHome<T>(body: (home: string, cmdexec: any) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-test-home-"));
  const previous = { HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.HOME = home;
  process.env.LOCALAPPDATA = home;
  const modulePath = require.resolve("../script/command-executor");
  delete require.cache[modulePath];
  try {
    return body(home, require("../script/command-executor"));
  } finally {
    delete require.cache[modulePath];
    process.env.HOME = previous.HOME;
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("the session file", () => {
  it("is written so that only its owner can read it", () => {
    withTempHome((home: string, cmdexec: any) => {
      cmdexec.writeConnectionInfo({ accessKey: "secret-key", preserveAccessKeyOnLogout: false });
      const file = path.join(home, ".dpctl.config");
      assert.strictEqual(mode(file), 0o600, `mode was ${mode(file).toString(8)}`);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).accessKey, "secret-key");
    });
  });

  it("is tightened on read, for anyone who logged in before it was written this way", () => {
    withTempHome((home: string, cmdexec: any) => {
      const file = path.join(home, ".dpctl.config");
      fs.writeFileSync(file, JSON.stringify({ accessKey: "secret-key" }), { mode: 0o644 });
      assert.strictEqual(mode(file), 0o644, "precondition: the file starts world-readable");

      assert.strictEqual(cmdexec.deserializeConnectionInfo().accessKey, "secret-key");
      assert.strictEqual(mode(file), 0o600, `mode was ${mode(file).toString(8)}`);
    });
  });

  it("leaves no temp file behind", () => {
    withTempHome((home: string, cmdexec: any) => {
      cmdexec.writeConnectionInfo({ accessKey: "secret-key", preserveAccessKeyOnLogout: false });
      const strays = fs.readdirSync(home).filter((name: string) => name.indexOf(".tmp") >= 0);
      assert.deepStrictEqual(strays, []);
    });
  });

  it("leaves no temp file behind when the rename fails", () => {
    withTempHome((home: string, cmdexec: any) => {
      // A directory in the session file's place: the temp file is written, then the rename fails.
      fs.mkdirSync(path.join(home, ".dpctl.config"));
      assert.throws(() => cmdexec.writeConnectionInfo({ accessKey: "secret-key", preserveAccessKeyOnLogout: false }));

      const strays = fs.readdirSync(home).filter((name: string) => name.indexOf(".tmp") >= 0);
      assert.deepStrictEqual(strays, []);
    });
  });

  it("does not replace the old session when the write fails", () => {
    withTempHome((home: string, cmdexec: any) => {
      const file = path.join(home, ".dpctl.config");
      cmdexec.writeConnectionInfo({ accessKey: "first-key", preserveAccessKeyOnLogout: false });

      // A directory where the temp file wants to go: writeFileSync fails, and the live file must survive.
      fs.mkdirSync(`${file}.${process.pid}.tmp`);
      assert.throws(() => cmdexec.writeConnectionInfo({ accessKey: "second-key", preserveAccessKeyOnLogout: false }));

      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).accessKey, "first-key");
      assert.strictEqual(mode(file), 0o600);
    });
  });
});
