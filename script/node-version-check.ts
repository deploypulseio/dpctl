// Imported first by cli.ts. parse-duration 2.x is ESM-only (earlier versions have a ReDoS advisory), and
// require()ing an ES module needs Node 20.19 or 22.12. Below that it throws ERR_REQUIRE_ESM before dpctl can
// print anything, and "engines" only makes npm warn.

const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19);

if (!supported) {
  console.error(`[Error]  dpctl needs Node.js 20.19 or later, or 22.12 or later. You are running Node.js ${process.versions.node}.`);
  process.exit(1);
}

export {};
