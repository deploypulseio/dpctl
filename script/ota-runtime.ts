// App platforms, and the guards that keep a release-react bundle going to the app it was built for.
// The server rejects a mismatch too, but only after a minute of bundling and without naming the right
// command.

import * as fs from "fs";
import * as path from "path";

// Kept in step with the dashboard's platform.ts, so both name an app type the same way.
const PLATFORM_LABELS: { [platform: string]: string } = {
  ios: "React Native (iOS)",
  android: "React Native (Android)",
  "expo-cng-ios": "Expo CNG (iOS)",
  "expo-cng-android": "Expo CNG (Android)",
  "expo-v1": "Expo Updates v1",
};

/** Human-readable app type. Apps created before platforms existed are plain React Native apps. */
export function appPlatformLabel(platform: string | null | undefined): string {
  return (platform && PLATFORM_LABELS[platform]) || "React Native";
}

const quoteArg = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

function releaseReactHint(appName: string, deploymentName: string, appPlatform: string | null | undefined): string {
  const platform = appPlatform && /ios$/.test(appPlatform) ? "ios" : appPlatform && /android$/.test(appPlatform) ? "android" : "<ios|android>";
  return `dpctl release-react ${quoteArg(appName)} ${platform} -d ${quoteArg(deploymentName)}`;
}

/** "ios" or "android" for a CodePush app's platform; null for apps with no platform or no OS in it. */
export function osForAppPlatform(platform: string | null | undefined): "ios" | "android" | null {
  if (platform === "ios" || platform === "expo-cng-ios") return "ios";
  if (platform === "android" || platform === "expo-cng-android") return "android";
  return null;
}

// `release-react MyApp-iOS android` would ship Android JavaScript to every iOS device, and the server
// cannot tell. Apps with no platform are not checked.
export function assertReleasePlatform(opts: {
  appName: string;
  deploymentName: string;
  appPlatform: string | null | undefined;
  releasePlatform: string;
}): void {
  const { appName, deploymentName, appPlatform } = opts;
  const expectedOs = osForAppPlatform(appPlatform);
  const releaseOs = opts.releasePlatform.toLowerCase();
  if (!expectedOs || releaseOs === expectedOs) return;
  throw new Error(
    `"${appName}" is a ${appPlatformLabel(appPlatform)} app, so it can't take a bundle built for ${releaseOs}. ` +
      `Run this instead:\n  ${releaseReactHint(appName, deploymentName, appPlatform)}`
  );
}

const EXPO_CONFIG_FILES = ["app.json", "app.config.js", "app.config.ts", "app.config.mjs", "app.config.cjs"];

// "expo-cng" when the app config registers the CodePush config plugin, "bare" for React Native with no
// `expo` package, null otherwise. The `expo` dependency alone proves nothing: bare apps use Expo modules.
export function detectCodePushProjectKind(projectRoot: string = process.cwd()): "expo-cng" | "bare" | null {
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const usesConfigPlugin = EXPO_CONFIG_FILES.some((file: string) => {
    try {
      // Both plugin forms count. `<pkg>/expo` is the subpath the docs used before the SDK shipped an
      // app.plugin.js; the bare package name is what they use now. Any fork matches, same as the
      // dependency check above.
      return /react-native-code-push/.test(fs.readFileSync(path.join(projectRoot, file), "utf8"));
    } catch {
      return false;
    }
  });
  if (usesConfigPlugin) return "expo-cng";
  if (!deps["expo"] && deps["react-native"]) return "bare";
  return null;
}

// Throws for an Expo CNG app released from a non-Expo folder. The reverse only warns: the bundle is still
// valid, and an app's platform can't be changed, so a bare app that moved to CNG must still release.
export function checkReleaseProjectKind(opts: {
  appName: string;
  appPlatform: string | null | undefined;
  projectRoot?: string;
}): string | null {
  const { appName, appPlatform } = opts;
  if (!osForAppPlatform(appPlatform)) return null;
  const kind = detectCodePushProjectKind(opts.projectRoot);
  const appIsExpoCng = appPlatform === "expo-cng-ios" || appPlatform === "expo-cng-android";

  if (appIsExpoCng && kind === "bare") {
    throw new Error(
      `"${appName}" is an ${appPlatformLabel(appPlatform)} app, but this project doesn't use Expo, so it's ` +
        `almost certainly the wrong folder. Run release-react from the Expo project this app belongs to.`
    );
  }
  if (!appIsExpoCng && kind === "expo-cng") {
    return (
      `This is an Expo CNG project, but "${appName}" was created as a ${appPlatformLabel(appPlatform)} app. ` +
      `The release will still work. If this isn't the app you meant, stop now and check the app name.`
    );
  }
  return null;
}
