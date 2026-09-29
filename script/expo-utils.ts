// `release-expo`: what `eas update` does before it uploads, pointed at DeployPulse.
//
// `npx expo export` writes one folder for every platform, and each platform can have its own runtime
// version. The server takes one platform per upload, so the export is split into a zip per platform.

import * as fs from "fs";
import * as path from "path";
import * as yazl from "yazl";
import { envWithoutCredentials } from "./child-env";
const childProcess = require("child_process");

export interface ExpoExportMetadata {
  version: number;
  bundler: string;
  fileMetadata: { [platform: string]: { bundle: string; assets?: Array<{ path: string; ext: string }> } };
}

export interface PlatformZip {
  zipPath: string;
  bundlePath: string;
  assetCount: number;
  bytes: number;
}

const NOT_AN_EXPO_PROJECT = 'Run "dpctl release-expo" from your Expo project folder, or pass both --exportDir and --runtimeVersion.';

// `--no` stops npx from downloading a package the project doesn't have: releasing with whatever
// version of the Expo CLI happens to be newest on npm would not match the app's own SDK.
// On Windows `npx` is a .cmd shim, which Node only runs through a shell, so arguments need quoting.
function spawnNpx(args: string[], cwd: string, captureOutput: boolean): any {
  const isWindows = process.platform === "win32";
  const finalArgs = ["--no", ...args].map((arg: string) => (isWindows && /\s/.test(arg) ? `"${arg}"` : arg));
  return childProcess.spawn("npx", finalArgs, {
    cwd,
    env: envWithoutCredentials(),
    shell: isWindows,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
}

export function assertExpoProject(projectRoot: string): void {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    throw new Error(`No package.json in "${projectRoot}". ${NOT_AN_EXPO_PROJECT}`);
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (!deps.expo) {
    throw new Error(`The project in "${projectRoot}" does not depend on "expo". ${NOT_AN_EXPO_PROJECT}`);
  }
}

export function runExpoExport(projectRoot: string, outputDir: string, platforms: string[]): Promise<void> {
  const args = ["expo", "export", "--output-dir", outputDir];
  platforms.forEach((platform: string) => args.push("--platform", platform));

  return new Promise<void>((resolve, reject) => {
    const child = spawnNpx(args, projectRoot, /*captureOutput*/ false);
    child.on("error", (err: Error) => reject(new Error(`Could not run "npx expo export": ${err.message}`)));
    child.on("close", (code: number) => {
      if (code === 0) return resolve();
      reject(new Error(`"npx expo export" exited with code ${code}. Its output above says why.`));
    });
  });
}

/** The runtime version expo-updates will report for `platform`, resolved from the app config. */
export function resolveRuntimeVersion(projectRoot: string, platform: string): Promise<string> {
  const command = `npx expo-updates runtimeversion:resolve --platform ${platform}`;

  return new Promise<string>((resolve, reject) => {
    const child = spawnNpx(["expo-updates", "runtimeversion:resolve", "--platform", platform], projectRoot, /*captureOutput*/ true);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err: Error) => reject(new Error(`Could not run "${command}": ${err.message}`)));
    child.on("close", (code: number) => {
      if (code !== 0) {
        return reject(
          new Error(
            `Could not resolve the ${platform} runtime version with "${command}" (exit code ${code}). ` +
              `Check that expo-updates is installed, or pass --runtimeVersion.` +
              (stderr.trim() ? `\n${stderr.trim()}` : "")
          )
        );
      }

      // The resolver prints a single JSON line. Take the last one so a warning printed by a config
      // plugin can't break parsing.
      const jsonLine = stdout
        .split(/\r?\n/)
        .reverse()
        .find((line: string) => line.trim().startsWith("{"));
      let info: any;
      try {
        info = JSON.parse(jsonLine);
      } catch {
        return reject(new Error(`Unexpected output from "${command}": ${stdout.trim() || "(nothing)"}`));
      }
      if (!info || typeof info.runtimeVersion !== "string" || !info.runtimeVersion) {
        return reject(new Error(`Your app config has no ${platform} runtime version. Set "runtimeVersion" in app.json, or pass --runtimeVersion.`));
      }
      resolve(info.runtimeVersion);
    });
  });
}

export function readExportMetadata(exportDir: string): ExpoExportMetadata {
  const file = path.join(exportDir, "metadata.json");
  let metadata: any;
  try {
    metadata = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`No readable metadata.json in "${exportDir}". --exportDir must be the folder "npx expo export" wrote, not a folder inside it.`);
  }
  if (!metadata || typeof metadata.fileMetadata !== "object" || !metadata.fileMetadata) {
    throw new Error(`"${file}" is not an Expo export metadata file.`);
  }
  return metadata;
}

/** Zip one platform's bundle and assets, laid out exactly as `expo export` wrote them. */
export function zipPlatformExport(exportDir: string, metadata: ExpoExportMetadata, platform: string, zipPath: string): Promise<PlatformZip> {
  const entry = metadata.fileMetadata[platform];
  if (!entry || !entry.bundle) {
    return Promise.reject(
      new Error(`The export in "${exportDir}" has no ${platform} bundle. Export ${platform} as well, or pick the platforms it has with --platform.`)
    );
  }

  const assetPaths = Array.from(new Set((entry.assets || []).map((asset) => asset.path)));
  const files = [entry.bundle, ...assetPaths];
  const missing = files.find((file: string) => !fs.existsSync(path.join(exportDir, file)));
  if (missing) {
    return Promise.reject(new Error(`"${missing}" is listed in metadata.json but missing from "${exportDir}".`));
  }

  // metadata.json goes in too, trimmed to this platform. Asset files are named by hash with no
  // extension, so it is the only record of each asset's type, which the server needs to describe
  // assets correctly in the manifest.
  const platformMetadata: ExpoExportMetadata = { ...metadata, fileMetadata: { [platform]: entry } };

  return new Promise<PlatformZip>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    // pipe() returns the DESTINATION, so the handlers below belong to the write stream. Readable.pipe
    // does not forward source errors, so without this an error from yazl itself (a file that changed or
    // vanished between the existence sweep and the read) is unhandled: the process dies with a raw
    // stack, this promise never settles, and the caller's cleanup never runs.
    zip.outputStream.on("error", reject);
    zip.outputStream
      .pipe(fs.createWriteStream(zipPath))
      .on("error", reject)
      .on("close", () =>
        resolve({ zipPath, bundlePath: entry.bundle, assetCount: assetPaths.length, bytes: fs.statSync(zipPath).size })
      );
    zip.addBuffer(Buffer.from(JSON.stringify(platformMetadata)), "metadata.json");
    files.forEach((file: string) => zip.addFile(path.join(exportDir, file), file.split(path.sep).join("/")));
    zip.end();
  });
}
