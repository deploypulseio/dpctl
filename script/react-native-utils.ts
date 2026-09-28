// Hermes support for `release-react`, lost when dpctl was forked from the CodePush CLI: --useHermes,
// --extraHermesFlags and --podFile were documented but silently ignored.
//
// `react-native bundle` emits plain JavaScript; a Hermes app expects bytecode, so the bundle is compiled
// with hermesc and replaced in place. Sourcemaps need a second step, because hermesc maps bytecode to the
// packed JS rather than to source.

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn } from "child_process";
import * as chalk from "chalk";
import { envWithoutCredentials } from "./child-env";

/** Directory under node_modules/react-native/sdks holding the hermesc build for this OS. */
export function getHermesOSBin(): string {
  switch (process.platform) {
    case "win32":
      return "win64-bin";
    case "darwin":
      return "osx-bin";
    case "freebsd":
    case "linux":
    case "sunos":
    default:
      return "linux64-bin";
  }
}

export function getHermesOSExe(): string {
  const hermesExecutableName = "hermesc";
  return process.platform === "win32" ? hermesExecutableName + ".exe" : hermesExecutableName;
}

// The prebuilt compiler inside react-native first, then a locally built Hermes for anyone compiling
// the engine themselves.
function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best effort cleanup */
  }
}

export function getHermesCommand(projectRoot?: string): string {
  const root = projectRoot || process.cwd();
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };

  const bundledHermesEngine = path.join(
    root,
    "node_modules",
    "react-native",
    "sdks",
    "hermesc",
    getHermesOSBin(),
    getHermesOSExe()
  );
  if (fileExists(bundledHermesEngine)) return bundledHermesEngine;

  const localHermesEngine = path.join(root, "node_modules", "react-native", "sdks", "hermes", "build", "bin", getHermesOSExe());
  if (fileExists(localHermesEngine)) return localHermesEngine;

  // React Native 0.68 and earlier keep the compiler in its own package. Those versions are a large share
  // of CodePush users, and Hermes is detected from their gradle config, so omitting this made the
  // detection a trap rather than a convenience.
  const standaloneHermesEngine = path.join(root, "node_modules", "hermes-engine", getHermesOSBin(), getHermesOSExe());
  if (fileExists(standaloneHermesEngine)) return standaloneHermesEngine;

  throw new Error(
    `Could not find the Hermes compiler. Looked in:\n  ${bundledHermesEngine}\n  ${localHermesEngine}\n  ${standaloneHermesEngine}\n` +
      `Check that react-native is installed in this project, or pass --no-useHermes to release a plain JavaScript bundle.`
  );
}

// gradle.properties (RN 0.71+), then the older enableHermes in app/build.gradle. Not driven by
// --gradleFile: that flag names the file holding the binary version, which never has hermesEnabled.
export function getAndroidHermesEnabled(projectRoot?: string): boolean {
  const root = projectRoot || process.cwd();
  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  if (/^\s*hermesEnabled\s*=\s*true\s*$/m.test(read(path.join(root, "android", "gradle.properties")))) return true;
  return /^\s*enableHermes\s*:\s*true/m.test(read(path.join(root, "android", "app", "build.gradle")));
}

// The line `expo prebuild` writes into ios/Podfile, evaluated against Podfile.properties.json.
const EXPO_PODFILE_HERMES_LINE =
  /^\s*:hermes_enabled\s*=>\s*podfile_properties\['expo\.jsEngine'\]\s*==\s*nil\s*\|\|\s*podfile_properties\['expo\.jsEngine'\]\s*==\s*'hermes'/m;

// An explicit `:hermes_enabled => true`, or Expo's generated line evaluated the way CocoaPods will.
// The RN 0.70+ template enables Hermes without writing either, so it reads as off here: guessing "on"
// would compile bytecode into a JSC app and brick it. Those projects pass --useHermes.
export function getiOSHermesEnabled(podFile?: string, projectRoot?: string): boolean {
  const root = projectRoot || process.cwd();
  const file = podFile || path.join(root, "ios", "Podfile");
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }

  if (/^\s*:?hermes_enabled\s*(=>|:)\s*true/m.test(contents)) return true;

  if (EXPO_PODFILE_HERMES_LINE.test(contents)) {
    let properties: any = {};
    try {
      properties = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "Podfile.properties.json"), "utf8"));
    } catch {
      /* same as the Podfile's `rescue {}` */
    }
    const engine = properties && properties["expo.jsEngine"];
    return engine === undefined || engine === null || engine === "hermes";
  }

  return false;
}

function spawnAsync(command: string, args: string[], label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: envWithoutCredentials() });
    child.on("error", (err: Error) => reject(new Error(`${label} failed to start: ${err.message}`)));
    child.on("close", (code: number) => {
      if (code === 0) return resolve();
      reject(new Error(`${label} exited with code ${code}.`));
    });
  });
}

// In place, because the zip, the hash and the upload all refer to the bundle by name. Emitting
// alongside it would ship both and leave the app loading the wrong one.
export async function runHermesEmitBinaryCommand(
  bundleName: string,
  outputFolder: string,
  sourcemapOutput: string,
  extraHermesFlags: string[],
  projectRoot?: string
): Promise<void> {
  const hermesCommand = getHermesCommand(projectRoot);
  const hermesArgs: string[] = [];
  const bundlePath = path.join(outputFolder, bundleName);

  hermesArgs.push("-emit-binary", "-out", path.join(outputFolder, bundleName + ".hbc"), bundlePath, "-O");
  if (sourcemapOutput) hermesArgs.push("-output-source-map");
  if (extraHermesFlags && extraHermesFlags.length) hermesArgs.push(...extraHermesFlags);

  console.log(chalk.cyan("Converting JS bundle to byte code via Hermes, running command:\n"));
  console.log(`${hermesCommand} ${hermesArgs.join(" ")}\n`);
  await spawnAsync(hermesCommand, hermesArgs, "Hermes");

  fs.unlinkSync(bundlePath);
  fs.renameSync(path.join(outputFolder, bundleName + ".hbc"), bundlePath);

  if (!sourcemapOutput) return;

  // Compose hermesc's bytecode map with Metro's, so stack frames resolve to source.
  const hermesMap = path.join(outputFolder, bundleName + ".hbc.map");
  if (!fs.existsSync(hermesMap)) {
    console.log(chalk.yellow("Hermes did not emit a source map; leaving the JS source map as-is."));
    return;
  }

  const root = projectRoot || process.cwd();
  const composeScript = path.join(root, "node_modules", "react-native", "scripts", "compose-source-maps.js");
  if (!fs.existsSync(composeScript)) {
    console.log(chalk.yellow(`Could not find ${composeScript}; leaving the JS source map as-is.`));
    removeQuietly(hermesMap);
    return;
  }

  const composedMap = path.join(os.tmpdir(), `${bundleName}.composed.map`);
  await spawnAsync("node", [composeScript, sourcemapOutput, hermesMap, "-o", composedMap], "compose-source-maps");
  fs.copyFileSync(composedMap, sourcemapOutput);
  // hermesMap first: it sits inside the release payload, so failing to remove it costs bandwidth on every
  // device and leaks source detail. composedMap is only a temp file.
  removeQuietly(hermesMap);
  removeQuietly(composedMap);
  console.log(chalk.cyan("Composed Hermes source map with the JavaScript source map.\n"));
}

// Run after `react-native bundle` and before anything hashes, signs, zips or uploads the folder: it
// rewrites the bundle in place.
export async function compileHermesIfEnabled(opts: {
  platform: string;
  bundleName: string;
  outputFolder: string;
  sourcemapOutput?: string;
  useHermes?: boolean;
  extraHermesFlags?: string[];
  podFile?: string;
  log?: (message: string) => void;
}): Promise<void> {
  // `--no-useHermes` arrives as false and means "do not compile", which is the only way out when
  // detection is wrong or the compiler is missing. Undefined means "decide for me".
  if (opts.useHermes === false) return;
  const explicit = opts.useHermes === true;
  const detected =
    opts.platform === "android" ? getAndroidHermesEnabled() : opts.platform === "ios" ? getiOSHermesEnabled(opts.podFile) : false;
  if (!explicit && !detected) return;
  if (!explicit) {
    (opts.log || console.log)(chalk.cyan(`Hermes is enabled for this ${opts.platform} project; compiling the bundle to bytecode.`));
  }
  await runHermesEmitBinaryCommand(opts.bundleName, opts.outputFolder, opts.sourcemapOutput, opts.extraHermesFlags || []);
}
