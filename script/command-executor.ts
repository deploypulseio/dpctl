// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import AccountManager = require("./management-sdk");
const childProcess = require("child_process");
import * as crypto from "crypto";
import debugCommand from "./commands/debug";
import * as fs from "fs";
import * as hashUtils from "./hash-utils";
import * as expoUtils from "./expo-utils";
import * as recursiveFs from "recursive-fs";
import * as yazl from "yazl";
import slash = require("slash");
import { envWithoutCredentials } from "./child-env";
import { compileHermesIfEnabled } from "./react-native-utils";
import { appPlatformLabel, assertReleasePlatform, assertReleaseRuntime, checkReleaseProjectKind } from "./ota-runtime";
import * as chalk from "chalk";
const g2js = require("gradle-to-js/lib/parser");
import * as moment from "moment";
const opener = require("opener");
import * as os from "os";
import * as path from "path";
const plist = require("plist");
const progress = require("progress");
const prompt = require("prompt");
import * as Q from "q";
const { rimraf } = require("rimraf");
import * as semver from "semver";
const Table = require("cli-table");
const which = require("which");
import wordwrap = require("wordwrap");
import * as cli from "../script/types/cli";
import {
  AccessKey,
  Account,
  App,
  CodePushError,
  CollaboratorMap,
  Org,
  CollaboratorProperties,
  Deployment,
  DeploymentMetrics,
  Headers,
  Package,
  PackageInfo,
  Session,
  UpdateMetrics,
} from "../script/types";

const configFilePath: string = path.join(process.env.LOCALAPPDATA || process.env.HOME, ".dpctl.config");
const emailValidator = require("email-validator");
const packageJson = require(
  path.resolve(__dirname, path.basename(path.dirname(__dirname)) === "bin" ? "../../package.json" : "../package.json")
);
const parseXml = Q.denodeify(require("xml2js").parseString);
import Promise = Q.Promise;
const properties = require("properties");

const CLI_HEADERS: Headers = {
  "X-CodePush-CLI-Version": packageJson.version,
};

/** Deprecated */
interface ILegacyLoginConnectionInfo {
  accessKeyName: string;
}

interface ILoginConnectionInfo {
  accessKey: string;
  preserveAccessKeyOnLogout?: boolean;
  /** Saved by `dpctl org use`. Always the resolved id, so later commands need no lookup. */
  orgId?: string;
  orgSlug?: string;
}

interface OrgContext {
  id: string;
  slug: string;
}

export interface UpdateMetricsWithTotalActive extends UpdateMetrics {
  totalActive: number;
}

export interface PackageWithMetrics {
  metrics?: UpdateMetricsWithTotalActive;
}

export const log = (message: string | any): void => console.log(message);
export let sdk: AccountManager;
export const spawn = childProcess.spawn;
export const execSync = childProcess.execSync;

let connectionInfo: ILoginConnectionInfo;

export const confirm = (message: string = "Are you sure?"): Promise<boolean> => {
  message += " (y/N):";
  return Promise<boolean>((resolve, reject, notify): void => {
    if (!process.stdin.isTTY) {
      log(chalk.cyan(message) + " no (not a terminal, so nothing was asked). Nothing was changed.");
      resolve(false);
      return;
    }

    prompt.message = "";
    prompt.delimiter = "";

    prompt.start();

    prompt.get(
      {
        properties: {
          response: {
            description: chalk.cyan(message),
          },
        },
      },
      (err: any, result: any): void => {
        if (err || !result) {
          resolve(false);
          return;
        }
        const accepted = result.response && result.response.toLowerCase() === "y";
        const rejected = !result.response || result.response.toLowerCase() === "n";

        if (accepted) {
          resolve(true);
        } else {
          if (!rejected) {
            console.log('Invalid response: "' + result.response + '"');
          }
          resolve(false);
        }
      }
    );
  });
};

function formatKeyScope(scopes: string[] | undefined, appNames: string[] | null | undefined): string {
  const access = !scopes || !scopes.length || scopes.includes("full") ? "full access" : "read only";
  const apps = appNames && appNames.length ? appNames.join(", ") : "all apps";
  return `${access}, ${apps}`;
}

function accessKeyAdd(command: cli.IAccessKeyAddCommand): Promise<void> {
  // The API scopes by app id but people type names, so resolve first and fail before minting a key
  // that would reach nothing.
  const resolveAppIds = (): Promise<string[] | undefined> => {
    if (!command.appNames || !command.appNames.length) return Q(<string[]>undefined);
    return sdk.getApps().then((apps: App[]) =>
      command.appNames.map((appName: string): string => {
        const app = apps.find((candidate: App) => candidate.name === appName);
        if (!app) {
          throw new Error(`App "${appName}" was not found in your account, so the access key was not created.`);
        }
        if (!app.id) {
          throw new Error(`The server did not return an id for app "${appName}". Limiting keys to apps needs a newer DeployPulse API.`);
        }
        return app.id;
      })
    );
  };

  return resolveAppIds().then((appIds: string[] | undefined) =>
    sdk.addAccessKey(command.name, command.ttl, command.scopes, appIds).then((accessKey: AccessKey) => {
      log(`Successfully created the "${command.name}" access key: ${accessKey.key}`);
      if (command.scopes || appIds) {
        log(`Scope: ${formatKeyScope(command.scopes, command.appNames)}`);
      }
      log("Make sure to save this key value somewhere safe, since you won't be able to view it from the CLI again!");
    })
  );
}

function accessKeyPatch(command: cli.IAccessKeyPatchCommand): Promise<void> {
  const willUpdateName: boolean = isCommandOptionSpecified(command.newName) && command.oldName !== command.newName;
  const willUpdateTtl: boolean = isCommandOptionSpecified(command.ttl);

  if (!willUpdateName && !willUpdateTtl) {
    throw new Error("A new name and/or TTL must be provided.");
  }

  return sdk.patchAccessKey(command.oldName, command.newName, command.ttl).then((accessKey: AccessKey) => {
    let logMessage: string = "Successfully ";
    if (willUpdateName) {
      logMessage += `renamed the access key "${command.oldName}" to "${command.newName}"`;
    }

    if (willUpdateTtl) {
      const expirationDate = moment(accessKey.expires).format("LLLL");
      if (willUpdateName) {
        logMessage += ` and changed its expiration date to ${expirationDate}`;
      } else {
        logMessage += `changed the expiration date of the "${command.oldName}" access key to ${expirationDate}`;
      }
    }

    log(`${logMessage}.`);
  });
}

function accessKeyList(command: cli.IAccessKeyListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getAccessKeys().then((accessKeys: AccessKey[]): void => {
    printAccessKeys(command.format, accessKeys);
  });
}

function accessKeyRemove(command: cli.IAccessKeyRemoveCommand): Promise<void> {
  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeAccessKey(command.accessKey).then((): void => {
        log(`Successfully removed the "${command.accessKey}" access key.`);
      });
    }

    log("Access key removal cancelled.");
  });
}

function appAdd(command: cli.IAppAddCommand): Promise<void> {
  return sdk.addApp(command.appName, command.platform).then((app: App): Promise<void> => {
    log('Successfully added the "' + command.appName + '" app, along with the following default deployments:');
    const deploymentListCommand: cli.IDeploymentListCommand = {
      type: cli.CommandType.deploymentList,
      appName: app.name,
      format: "table",
      displayKeys: true,
    };
    return deploymentList(deploymentListCommand, /*showPackage=*/ false);
  });
}

function appList(command: cli.IAppListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);
  let apps: App[];
  return sdk.getApps().then((retrievedApps: App[]): void => {
    printAppList(command.format, retrievedApps);
  });
}

function appRemove(command: cli.IAppRemoveCommand): Promise<void> {
  return confirm("Are you sure you want to remove this app? Note that its deployment keys will be PERMANENTLY unrecoverable.").then(
    (wasConfirmed: boolean): Promise<void> => {
      if (wasConfirmed) {
        return sdk.removeApp(command.appName).then((): void => {
          log('Successfully removed the "' + command.appName + '" app.');
        });
      }

      log("App removal cancelled.");
    }
  );
}

function appRename(command: cli.IAppRenameCommand): Promise<void> {
  return sdk.renameApp(command.currentAppName, command.newAppName).then((): void => {
    log('Successfully renamed the "' + command.currentAppName + '" app to "' + command.newAppName + '".');
  });
}

/** Must match the base packageFileFromPath zips with, or the signature covers keys the package lacks. */
/**
 * The platform, for deciding WHICH implementation runs (CodePush or Expo Updates). Only a genuine 404
 * is allowed to be inconclusive; anything else propagates. Swallowing a 500 here meant `dpctl rollback`
 * on an Expo app ran the CodePush rollback and announced "MyApp is a CodePush app", mid-incident.
 */
function getAppPlatformForRouting(appName: string): Promise<string | null | undefined> {
  return sdk.getApp(appName).then(
    (app: App): string | null => (app && app.platform) || null,
    (error: any): undefined => {
      if (error && error.statusCode === AccountManager.ERROR_NOT_FOUND) return undefined;
      throw error;
    }
  );
}

function uploadProgressBar(): (currentProgress: number) => void {
  let lastTotalProgress = 0;
  const progressBar = new progress("Upload progress:[:bar] :percent :etas", {
    complete: "=",
    incomplete: " ",
    width: 50,
    total: 100,
  });
  return (currentProgress: number): void => {
    progressBar.tick(currentProgress - lastTotalProgress);
    lastTotalProgress = currentProgress;
  };
}

const EXPO_PLATFORM_LABELS: { [platform: string]: string } = { ios: "iOS", android: "Android" };

// Copies what the source channel serves onto the destination. CodePush-only options are refused rather
// than silently ignored: an Expo release has no mandatory flag or binary version.
function promoteExpo(command: cli.IPromoteCommand): Promise<void> {
  const unsupported: string[] = [];
  if (command.label) unsupported.push("--label");
  if (command.description) unsupported.push("--description");
  if (command.mandatory !== null && command.mandatory !== undefined) unsupported.push("--mandatory");
  if (command.disabled !== null && command.disabled !== undefined) unsupported.push("--disabled");
  if (command.appStoreVersion) unsupported.push("--targetBinaryVersion");
  if (unsupported.length) {
    throw new Error(
      `"${command.appName}" uses Expo Updates, where promote copies the releases a channel serves as they are. ` +
        `Not supported: ${unsupported.join(", ")}.`
    );
  }

  return Q(
    (async () => {
      const source: Deployment = await sdk.getDeployment(command.appName, command.sourceDeploymentName);
      if (!source || !source.key) {
        throw new Error(`Could not read the key of the "${command.sourceDeploymentName}" channel.`);
      }
      const result = await sdk.promoteExpo(source.key, command.destDeploymentName, {
        platform: command.platform,
        rollout: command.rollout,
      });

      result.promotions.forEach((entry) => {
        const where = `${EXPO_PLATFORM_LABELS[entry.platform] ?? entry.platform} (runtime version ${entry.runtimeVersion})`;
        log(
          `Promoted ${where}${entry.label ? ` as ${entry.label}` : ""} from "${command.sourceDeploymentName}" to ` +
            `"${command.destDeploymentName}" on "${command.appName}".`
        );
      });
      result.skipped.forEach((entry) => {
        log(
          chalk.yellow(
            `Skipped ${EXPO_PLATFORM_LABELS[entry.platform] ?? entry.platform} (runtime version ${entry.runtimeVersion}): ${entry.reason}.`
          )
        );
      });
      log("Devices pick this up on their next update check.");
    })()
  );
}

// Only the rollout can change. Expo releases have no label, mandatory flag or target binary version, so
// those options are refused rather than silently ignored.
function patchExpo(command: cli.IPatchCommand): Promise<void> {
  const unsupported: string[] = [];
  if (command.label) unsupported.push("--label");
  if (command.description !== null && command.description !== undefined) unsupported.push("--description");
  if (command.disabled !== null && command.disabled !== undefined) unsupported.push("--disabled");
  if (command.mandatory !== null && command.mandatory !== undefined) unsupported.push("--mandatory");
  if (command.appStoreVersion) unsupported.push("--targetBinaryVersion");
  if (unsupported.length) {
    throw new Error(`"${command.appName}" uses Expo Updates, where patch can only change --rollout. Not supported: ${unsupported.join(", ")}.`);
  }
  if (!command.rollout) {
    throw new Error("Specify the new percentage with --rollout, e.g. --rollout 50%.");
  }

  return Q(
    (async () => {
      const deployment: Deployment = await sdk.getDeployment(command.appName, command.deploymentName);
      if (!deployment || !deployment.key) {
        throw new Error(`Could not read the key of the "${command.deploymentName}" channel.`);
      }
      const releases = await sdk.patchExpoRollout(deployment.key, command.rollout);
      const what = releases.map((r) => `${EXPO_PLATFORM_LABELS[r.platform] ?? r.platform} (runtime version ${r.runtimeVersion})`).join(", ");
      const reach = command.rollout === 100 ? "every device" : `${command.rollout}% of devices`;
      log(`Successfully rolled out ${what} on the "${command.deploymentName}" channel of "${command.appName}" to ${reach}.`);
    })()
  );
}

// A channel serves one release per platform AND runtime version, so this rolls back each unless narrowed.
// The previous release is published again rather than the bad one disabled, because expo-updates only loads
// an update NEWER than the one it launched. --toEmbedded goes back to the bundle in the store binary.
function rollbackExpo(command: cli.IRollbackCommand): Promise<void> {
  if (command.targetRelease) {
    throw new Error(
      `"${command.appName}" uses Expo Updates, where releases have no labels, so --targetRelease does not apply. ` +
        `Roll back to the previous release with:\n  dpctl rollback ${command.appName} ${command.deploymentName}`
    );
  }

  const what = command.toEmbedded ? "the bundle built into the store binary" : "the previous release";
  const scope = [
    command.platform ? EXPO_PLATFORM_LABELS[command.platform] ?? command.platform : null,
    command.runtimeVersion ? `runtime version ${command.runtimeVersion}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return confirm(
    `Roll the "${command.deploymentName}" channel of "${command.appName}"${scope ? ` (${scope})` : ""} back to ${what}?`
  ).then((wasConfirmed: boolean) => {
    if (!wasConfirmed) {
      log("Rollback cancelled.");
      return;
    }

    return Q(
      (async () => {
        const deployment: Deployment = await sdk.getDeployment(command.appName, command.deploymentName);
        if (!deployment || !deployment.key) {
          throw new Error(`Could not read the key of the "${command.deploymentName}" channel.`);
        }
        const result = await sdk.rollbackExpo(deployment.key, {
          platform: command.platform,
          runtimeVersion: command.runtimeVersion,
          toEmbedded: command.toEmbedded,
        });

        result.rollbacks.forEach((entry) => {
          const where = `${EXPO_PLATFORM_LABELS[entry.platform] ?? entry.platform} (runtime version ${entry.runtimeVersion})`;
          const how = entry.mode === "embedded" ? "back to the embedded bundle" : "back to the previous release";
          log(`Rolled ${where} ${how} on the "${command.deploymentName}" channel of "${command.appName}".`);
        });
        result.skipped.forEach((entry) => {
          log(
            chalk.yellow(
              `Skipped ${EXPO_PLATFORM_LABELS[entry.platform] ?? entry.platform} (runtime version ${entry.runtimeVersion}): ${entry.reason}.`
            )
          );
        });
        log("Devices pick this up on their next update check.");
      })()
    );
  });
}

export const releaseExpo = (command: cli.IReleaseExpoCommand): Promise<void> => {
  const projectRoot = process.cwd();
  const platforms: string[] = command.platform ? [command.platform] : ["ios", "android"];
  const metadata: object | undefined = command.metadata ? JSON.parse(command.metadata) : undefined;

  const run = async () => {
    const deployment: Deployment = await sdk.getDeployment(command.appName, command.deploymentName);
    if (!deployment || !deployment.key) {
      throw new Error(`Could not read the key of the "${command.deploymentName}" deployment, which Expo Updates releases are uploaded to.`);
    }

    assertReleaseRuntime({
      expected: "expo-updates",
      appName: command.appName,
      deploymentName: command.deploymentName,
      appPlatform: await getAppPlatform(command.appName),
      projectRoot,
    });

    // Exporting and resolving runtime versions both read the project; only a prebuilt export with
    // an explicit runtime version can be released from anywhere.
    if (!command.exportDir || !command.runtimeVersion) {
      expoUtils.assertExpoProject(projectRoot);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-expo-"));
    try {
      const exportDir = command.exportDir ? path.resolve(command.exportDir) : path.join(workDir, "dist");
      if (!command.exportDir) {
        const labels = platforms.map((platform: string) => EXPO_PLATFORM_LABELS[platform]);
        log(chalk.cyan(`Exporting ${labels.join(" and ")} with "npx expo export":\n`));
        await expoUtils.runExpoExport(projectRoot, exportDir, platforms);
      }
      const exportMetadata = expoUtils.readExportMetadata(exportDir);

      // Resolve and package every platform before uploading any, so a problem with the second one
      // can't leave the first released on its own.
      const prepared: Array<{ platform: string; runtimeVersion: string; zip: expoUtils.PlatformZip }> = [];
      for (const platform of platforms) {
        const runtimeVersion = command.runtimeVersion || (await expoUtils.resolveRuntimeVersion(projectRoot, platform));
        const zip = await expoUtils.zipPlatformExport(exportDir, exportMetadata, platform, path.join(workDir, `${platform}.zip`));
        prepared.push({ platform, runtimeVersion, zip });
      }

      const released: string[] = [];
      for (const { platform, runtimeVersion, zip } of prepared) {
        const label = EXPO_PLATFORM_LABELS[platform];
        log(
          chalk.cyan(
            `\nReleasing ${label} (runtime version ${runtimeVersion}, ${zip.assetCount} asset(s)) ` +
              `to the "${command.deploymentName}" deployment of "${command.appName}":\n`
          )
        );
        try {
          await sdk.releaseExpo(deployment.key, zip.zipPath, platform, runtimeVersion, metadata, command.rollout, command.description, uploadProgressBar());
        } catch (error: any) {
          if (released.length && error) {
            error.message = `${released.join(" and ")} was released, but ${label} failed: ${error.message}`;
          }
          throw error;
        }
        released.push(label);
      }

      const reach = command.rollout && command.rollout < 100 ? ` for ${command.rollout}% of devices` : "";
      log(`Successfully released ${released.join(" and ")} to the "${command.deploymentName}" deployment of the "${command.appName}" app${reach}.`);
    } finally {
      // Only the temporary folder: an --exportDir the user passed is never inside it. Swallowed, because
      // a rejection here would REPLACE the in-flight error, and "EBUSY android.zip" is a poor substitute
      // for "iOS was released, but Android failed: <reason>".
      try {
        await rimraf(workDir);
      } catch {
        /* best effort */
      }
    }
  };

  return Q(run());
};

export function signatureManifestBase(filePath: string): string {
  return path.dirname(filePath);
}

// undefined = the app couldn't be fetched (the release itself will report why); null = no platform set.
function getAppPlatform(appName: string): Promise<string | null | undefined> {
  return sdk.getApp(appName).then(
    (app: App): string | null => (app && app.platform) || null,
    (): undefined => undefined
  );
}

export function resolvePrivateKey(value: string): string {
  return value.trimStart().startsWith("-----BEGIN")
    ? value                              // inline PEM content
    : fs.readFileSync(value, "utf8");    // file path
}

function createRS256JWT(privateKeyPem: string, contentHash: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ contentHash })).toString("base64url");
  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem, "base64url");
  return `${header}.${payload}.${signature}`;
}

function appSetPublicKey(command: cli.IAppSetPublicKeyCommand): Promise<void> {
  const publicKey = fs.readFileSync(command.publicKeyPath, "utf8");
  return sdk.setAppPublicKey(command.appName, publicKey).then((): void => {
    log(`Successfully set the public key for the "${command.appName}" app.`);
  });
}

export const createEmptyTempReleaseFolder = (folderPath: string) => {
  return deleteFolder(folderPath).then(() => {
    fs.mkdirSync(folderPath);
  });
};

function appTransfer(command: cli.IAppTransferCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.transferApp(command.appName, command.email).then((): void => {
        log(
          'Successfully transferred the ownership of app "' + command.appName + '" to the account with email "' + command.email + '".'
        );
      });
    }

    log("App transfer cancelled.");
  });
}

function addCollaborator(command: cli.ICollaboratorAddCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return sdk.addCollaborator(command.appName, command.email).then((): void => {
    log('Successfully added "' + command.email + '" as a collaborator to the app "' + command.appName + '".');
  });
}

function listCollaborators(command: cli.ICollaboratorListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getCollaborators(command.appName).then((retrievedCollaborators: CollaboratorMap): void => {
    printCollaboratorsList(command.format, retrievedCollaborators);
  });
}

function removeCollaborator(command: cli.ICollaboratorRemoveCommand): Promise<void> {
  throwForInvalidEmail(command.email);

  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeCollaborator(command.appName, command.email).then((): void => {
        log('Successfully removed "' + command.email + '" as a collaborator from the app "' + command.appName + '".');
      });
    }

    log("App collaborator removal cancelled.");
  });
}

function deleteConnectionInfoCache(printMessage: boolean = true): void {
  try {
    fs.unlinkSync(configFilePath);

    if (printMessage) {
      log(`Successfully logged-out. The session file located at ${chalk.cyan(configFilePath)} has been deleted.\r\n`);
    }
  } catch (ex) {}
}

/** rimraf 4+ needs `glob` to expand a pattern. Off by default so a literal path like "build[1]" is safe. */
export function deleteFolder(folderPath: string, glob: boolean = false): Promise<void> {
  return Q.Promise<void>((resolve, reject) => {
    rimraf(folderPath, { glob }).then(() => resolve(<void>null)).catch(reject);
  });
}

function deploymentAdd(command: cli.IDeploymentAddCommand): Promise<void> {
  return sdk.addDeployment(command.appName, command.deploymentName).then((deployment: Deployment): void => {
    log(
      'Successfully added the "' +
        command.deploymentName +
        '" deployment with key "' +
        deployment.key +
        '" to the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistoryClear(command: cli.IDeploymentHistoryClearCommand): Promise<void> {
  return confirm().then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.clearDeploymentHistory(command.appName, command.deploymentName).then((): void => {
        log(
          'Successfully cleared the release history associated with the "' +
            command.deploymentName +
            '" deployment from the "' +
            command.appName +
            '" app.'
        );
      });
    }

    log("Clear deployment cancelled.");
  });
}

export const deploymentList = (command: cli.IDeploymentListCommand, showPackage: boolean = true): Promise<void> => {
  throwForInvalidOutputFormat(command.format);
  let deployments: Deployment[];

  return sdk
    .getDeployments(command.appName)
    .then((retrievedDeployments: Deployment[]) => {
      deployments = retrievedDeployments;
      if (showPackage) {
        const metricsPromises: Promise<void>[] = deployments.map((deployment: Deployment) => {
          if (deployment.package) {
            return sdk.getDeploymentMetrics(command.appName, deployment.name).then((metrics: DeploymentMetrics): void => {
              if (metrics[deployment.package.label]) {
                const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
                (<PackageWithMetrics>deployment.package).metrics = {
                  active: metrics[deployment.package.label].active,
                  downloaded: metrics[deployment.package.label].downloaded,
                  failed: metrics[deployment.package.label].failed,
                  installed: metrics[deployment.package.label].installed,
                  totalActive: totalActive,
                };
              }
            });
          } else {
            return Q(<void>null);
          }
        });

        return Q.all(metricsPromises);
      }
    })
    .then(() => {
      printDeploymentList(command, deployments, showPackage);
    });
};

function deploymentAutoRollbackGet(command: cli.IDeploymentAutoRollbackGetCommand): Promise<void> {
  return sdk.getAutoRollbackConfig(command.appName, command.deploymentName).then((config: any): void => {
    if (!config) {
      log(`Auto-rollback is not configured for the "${command.deploymentName}" deployment.`);
    } else {
      log(
        `Auto-rollback for "${command.deploymentName}":\n` +
          `  Enabled:          ${config.enabled}\n` +
          `  Error rate:       ${config.errorRateThreshold}%\n` +
          `  Min devices:      ${config.minDevices}`
      );
    }
  });
}

function deploymentAutoRollbackEnable(command: cli.IDeploymentAutoRollbackEnableCommand): Promise<void> {
  return sdk
    .setAutoRollbackConfig(command.appName, command.deploymentName, {
      enabled: true,
      errorRateThreshold: command.errorRate,
      minDevices: command.minDevices,
    })
    .then((): void => {
      log(
        `Successfully enabled auto-rollback for the "${command.deploymentName}" deployment ` +
          `(error rate >= ${command.errorRate}%, min devices: ${command.minDevices}).`
      );
    });
}

function deploymentAutoRollbackDisable(command: cli.IDeploymentAutoRollbackDisableCommand): Promise<void> {
  return sdk.deleteAutoRollbackConfig(command.appName, command.deploymentName).then((): void => {
    log(`Successfully disabled auto-rollback for the "${command.deploymentName}" deployment.`);
  });
}

function deploymentRemove(command: cli.IDeploymentRemoveCommand): Promise<void> {
  return confirm(
    "Are you sure you want to remove this deployment? Note that its deployment key will be PERMANENTLY unrecoverable."
  ).then((wasConfirmed: boolean): Promise<void> => {
    if (wasConfirmed) {
      return sdk.removeDeployment(command.appName, command.deploymentName).then((): void => {
        log('Successfully removed the "' + command.deploymentName + '" deployment from the "' + command.appName + '" app.');
      });
    }

    log("Deployment removal cancelled.");
  });
}

function deploymentRename(command: cli.IDeploymentRenameCommand): Promise<void> {
  return sdk.renameDeployment(command.appName, command.currentDeploymentName, command.newDeploymentName).then((): void => {
    log(
      'Successfully renamed the "' +
        command.currentDeploymentName +
        '" deployment to "' +
        command.newDeploymentName +
        '" for the "' +
        command.appName +
        '" app.'
    );
  });
}

function deploymentHistory(command: cli.IDeploymentHistoryCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return Q.all<any>([
    sdk.getAccountInfo(),
    sdk.getDeploymentHistory(command.appName, command.deploymentName),
    sdk.getDeploymentMetrics(command.appName, command.deploymentName),
  ]).spread<void>((account: Account, deploymentHistory: Package[], metrics: DeploymentMetrics): void => {
    const totalActive: number = getTotalActiveFromDeploymentMetrics(metrics);
    deploymentHistory.forEach((packageObject: Package) => {
      if (metrics[packageObject.label]) {
        (<PackageWithMetrics>packageObject).metrics = {
          active: metrics[packageObject.label].active,
          downloaded: metrics[packageObject.label].downloaded,
          failed: metrics[packageObject.label].failed,
          installed: metrics[packageObject.label].installed,
          totalActive: totalActive,
        };
      }
    });
    printDeploymentHistory(command, <Package[]>deploymentHistory, account.email);
  });
}

export const deserializeConnectionInfo = (): ILoginConnectionInfo => {
  try {
    const savedConnection: string = fs.readFileSync(configFilePath, {
      encoding: "utf8",
    });
    let connectionInfo: ILegacyLoginConnectionInfo | ILoginConnectionInfo = JSON.parse(savedConnection);

    // If the connection info is in the legacy format, convert it to the modern format
    if ((<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName) {
      connectionInfo = <ILoginConnectionInfo>{
        accessKey: (<ILegacyLoginConnectionInfo>connectionInfo).accessKeyName,
      };
    }

    const connInfo = <ILoginConnectionInfo>connectionInfo;

    return connInfo;
  } catch (ex) {
    return;
  }
};

export function execute(command: cli.ICommand) {
  connectionInfo = deserializeConnectionInfo();

  return Q(<void>null).then(() => {
    switch (command.type) {
      // Only touches the session file on this machine.
      case cli.CommandType.orgClear:
        break;

      // Must not be logged in
      case cli.CommandType.login:
        if (connectionInfo) {
          throw new Error("You are already logged in from this machine.");
        }
        break;

      // Must be logged in
      default:
        if (!!sdk) break; // Used by unit tests to skip authentication

        const accessKey = connectionInfo?.accessKey || process.env.DEPLOYPULSE_ACCESS_KEY;

        if (!accessKey) {
          throw new Error(
            "You are not currently logged in. Run the 'dpctl login' command to authenticate with the DeployPulse API or provide an access key by setting the DEPLOYPULSE_ACCESS_KEY environment variable."
          );
        }

        sdk = getSdk(accessKey, CLI_HEADERS);
        break;
    }
  })
  .then(() => applyOrgContext(command))
  .then(() => {
    switch (command.type) {
      case cli.CommandType.accessKeyAdd:
        return accessKeyAdd(<cli.IAccessKeyAddCommand>command);

      case cli.CommandType.accessKeyPatch:
        return accessKeyPatch(<cli.IAccessKeyPatchCommand>command);

      case cli.CommandType.accessKeyList:
        return accessKeyList(<cli.IAccessKeyListCommand>command);

      case cli.CommandType.accessKeyRemove:
        return accessKeyRemove(<cli.IAccessKeyRemoveCommand>command);

      case cli.CommandType.appAdd:
        return appAdd(<cli.IAppAddCommand>command);

      case cli.CommandType.appList:
        return appList(<cli.IAppListCommand>command);

      case cli.CommandType.appRemove:
        return appRemove(<cli.IAppRemoveCommand>command);

      case cli.CommandType.appRename:
        return appRename(<cli.IAppRenameCommand>command);

      case cli.CommandType.appSetPublicKey:
        return appSetPublicKey(<cli.IAppSetPublicKeyCommand>command);

      case cli.CommandType.bundleReact:
        return bundleReact(<cli.IBundleReactCommand>command);

      case cli.CommandType.appTransfer:
        return appTransfer(<cli.IAppTransferCommand>command);

      case cli.CommandType.collaboratorAdd:
        return addCollaborator(<cli.ICollaboratorAddCommand>command);

      case cli.CommandType.collaboratorList:
        return listCollaborators(<cli.ICollaboratorListCommand>command);

      case cli.CommandType.collaboratorRemove:
        return removeCollaborator(<cli.ICollaboratorRemoveCommand>command);

      case cli.CommandType.debug:
        return debugCommand(<cli.IDebugCommand>command);

      case cli.CommandType.deploymentAdd:
        return deploymentAdd(<cli.IDeploymentAddCommand>command);

      case cli.CommandType.deploymentHistoryClear:
        return deploymentHistoryClear(<cli.IDeploymentHistoryClearCommand>command);

      case cli.CommandType.deploymentHistory:
        return deploymentHistory(<cli.IDeploymentHistoryCommand>command);

      case cli.CommandType.deploymentList:
        return deploymentList(<cli.IDeploymentListCommand>command);

      case cli.CommandType.deploymentAutoRollbackGet:
        return deploymentAutoRollbackGet(<cli.IDeploymentAutoRollbackGetCommand>command);

      case cli.CommandType.deploymentAutoRollbackEnable:
        return deploymentAutoRollbackEnable(<cli.IDeploymentAutoRollbackEnableCommand>command);

      case cli.CommandType.deploymentAutoRollbackDisable:
        return deploymentAutoRollbackDisable(<cli.IDeploymentAutoRollbackDisableCommand>command);

      case cli.CommandType.deploymentRemove:
        return deploymentRemove(<cli.IDeploymentRemoveCommand>command);

      case cli.CommandType.deploymentRename:
        return deploymentRename(<cli.IDeploymentRenameCommand>command);

      case cli.CommandType.login:
        return login(<cli.ILoginCommand>command);

      case cli.CommandType.logout:
        return logout(command);

      case cli.CommandType.orgList:
        return orgList(<cli.IOrgListCommand>command);

      case cli.CommandType.orgUse:
        return orgUse(<cli.IOrgUseCommand>command);

      case cli.CommandType.orgClear:
        return orgClear(command);

      case cli.CommandType.patch:
        return patch(<cli.IPatchCommand>command);

      case cli.CommandType.promote:
        return promote(<cli.IPromoteCommand>command);

      case cli.CommandType.release:
        return release(<cli.IReleaseCommand>command);

      case cli.CommandType.releaseExpo:
        return releaseExpo(<cli.IReleaseExpoCommand>command);

      case cli.CommandType.releaseReact:
        return releaseReact(<cli.IReleaseReactCommand>command);

      case cli.CommandType.rollback:
        return rollback(<cli.IRollbackCommand>command);

      case cli.CommandType.sessionList:
        return sessionList(<cli.ISessionListCommand>command);

      case cli.CommandType.sessionRemove:
        return sessionRemove(<cli.ISessionRemoveCommand>command);

      case cli.CommandType.whoami:
        return whoami(command);

      default:
        // We should never see this message as invalid commands should be caught by the argument parser.
        throw new Error("Invalid command:  " + JSON.stringify(command));
    }
  });
}

function fileDoesNotExistOrIsDirectory(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isDirectory();
  } catch (error) {
    return true;
  }
}

function getTotalActiveFromDeploymentMetrics(metrics: DeploymentMetrics): number {
  let totalActive = 0;
  Object.keys(metrics).forEach((label: string) => {
    totalActive += metrics[label].active;
  });

  return totalActive;
}

function initiateExternalAuthenticationAsync(action: string): void {
  const message: string =
    `A browser is being launched to authenticate your DeployPulse account. Follow the instructions ` +
    `it displays to complete your ${action === "register" ? "registration" : action}.`;

  log(message);
  const hostname: string = os.hostname();
  const url: string = `${AccountManager.SERVER_URL}/auth/${action}?hostname=${hostname}`;
  opener(url);
}

function login(command: cli.ILoginCommand): Promise<void> {
  // Check if one of the flags were provided.
  if (command.accessKey) {
    sdk = getSdk(command.accessKey, CLI_HEADERS);
    return sdk.isAuthenticated().then((isAuthenticated: boolean): Promise<void> => {
      if (!isAuthenticated) {
        throw new Error("Invalid access key.");
      }
      return chooseOrgContext(command).then((org: OrgContext): void => {
        serializeConnectionInfo(command.accessKey, /*preserveAccessKeyOnLogout*/ true, org);
      });
    });
  } else {
    return loginWithExternalAuthentication("login", command);
  }
}

function loginWithExternalAuthentication(action: string, command?: cli.ICommand): Promise<void> {
  initiateExternalAuthenticationAsync(action);
  log(""); // Insert newline

  return requestAccessKey().then((accessKey: string): Promise<void> => {
    if (accessKey === null) {
      // The user has aborted the synchronous prompt (e.g.:  via [CTRL]+[C]).
      return;
    }

    sdk = getSdk(accessKey, CLI_HEADERS);

    return sdk.isAuthenticated().then((isAuthenticated: boolean): Promise<void> => {
      if (!isAuthenticated) {
        throw new Error("Invalid access key.");
      }
      return chooseOrgContext(command).then((org: OrgContext): void => {
        serializeConnectionInfo(accessKey, /*preserveAccessKeyOnLogout*/ false, org);
      });
    });
  });
}

function logout(command: cli.ICommand): Promise<void> {
  return Q(<void>null)
    .then((): Promise<void> => {
      if (!connectionInfo.preserveAccessKeyOnLogout) {
        const machineName: string = os.hostname();
        return sdk.removeSession(machineName).catch((error: CodePushError) => {
          // If we are not authenticated or the session doesn't exist anymore, just swallow the error instead of displaying it
          if (error.statusCode !== AccountManager.ERROR_UNAUTHORIZED && error.statusCode !== AccountManager.ERROR_NOT_FOUND) {
            throw error;
          }
        });
      }
    })
    .then((): void => {
      sdk = null;
      deleteConnectionInfoCache();
    });
}

function formatDate(unixOffset: number): string {
  const date: moment.Moment = moment(unixOffset);
  const now: moment.Moment = moment();
  if (Math.abs(now.diff(date, "days")) < 30) {
    return date.fromNow(); // "2 hours ago"
  } else if (now.year() === date.year()) {
    return date.format("MMM D"); // "Nov 6"
  } else {
    return date.format("MMM D, YYYY"); // "Nov 6, 2014"
  }
}

function printAppList(format: string, apps: App[]): void {
  if (format === "json") {
    printJson(apps);
  } else if (format === "table") {
    const headers = ["Name", "Platform", "Deployments"];
    printTable(headers, (dataSource: any[]): void => {
      apps.forEach((app: App, index: number): void => {
        const row = [app.name, appPlatformLabel(app.platform), wordwrap(50)(app.deployments.join(", "))];
        dataSource.push(row);
      });
    });
  }
}

function getCollaboratorDisplayName(email: string, collaboratorProperties: CollaboratorProperties): string {
  return collaboratorProperties.permission === AccountManager.AppPermission.OWNER ? email + chalk.magenta(" (Owner)") : email;
}

function printCollaboratorsList(format: string, collaborators: CollaboratorMap): void {
  if (format === "json") {
    const dataSource = { collaborators: collaborators };
    printJson(dataSource);
  } else if (format === "table") {
    const headers = ["E-mail Address"];
    printTable(headers, (dataSource: any[]): void => {
      Object.keys(collaborators).forEach((email: string): void => {
        const row = [getCollaboratorDisplayName(email, collaborators[email])];
        dataSource.push(row);
      });
    });
  }
}

function printDeploymentList(command: cli.IDeploymentListCommand, deployments: Deployment[], showPackage: boolean = true): void {
  if (command.format === "json") {
    printJson(deployments);
  } else if (command.format === "table") {
    const headers = ["Name"];
    if (command.displayKeys) {
      headers.push("Deployment Key");
    }

    if (showPackage) {
      headers.push("Update Metadata");
      headers.push("Install Metrics");
    }

    printTable(headers, (dataSource: any[]): void => {
      deployments.forEach((deployment: Deployment): void => {
        const row = [deployment.name];
        if (command.displayKeys) {
          row.push(deployment.key);
        }

        if (showPackage) {
          row.push(getPackageString(deployment.package));
          row.push(getPackageMetricsString(deployment.package));
        }

        dataSource.push(row);
      });
    });
  }
}

function printDeploymentHistory(command: cli.IDeploymentHistoryCommand, deploymentHistory: Package[], currentUserEmail: string): void {
  if (command.format === "json") {
    printJson(deploymentHistory);
  } else if (command.format === "table") {
    const headers = ["Label", "Release Time", "App Version", "Mandatory"];
    if (command.displayAuthor) {
      headers.push("Released By");
    }

    headers.push("Description", "Install Metrics");

    printTable(headers, (dataSource: any[]) => {
      deploymentHistory.forEach((packageObject: Package) => {
        let releaseTime: string = formatDate(packageObject.uploadTime);
        let releaseSource: string;
        if (packageObject.releaseMethod === "Promote") {
          releaseSource = `Promoted ${packageObject.originalLabel} from "${packageObject.originalDeployment}"`;
        } else if (packageObject.releaseMethod === "Rollback") {
          const labelNumber: number = parseInt(packageObject.label.substring(1));
          const lastLabel: string = "v" + (labelNumber - 1);
          releaseSource = `Rolled back ${lastLabel} to ${packageObject.originalLabel}`;
        }

        if (releaseSource) {
          releaseTime += "\n" + chalk.magenta(`(${releaseSource})`).toString();
        }

        let row: string[] = [packageObject.label, releaseTime, packageObject.appVersion, packageObject.isMandatory ? "Yes" : "No"];
        if (command.displayAuthor) {
          let releasedBy: string = packageObject.releasedBy ? packageObject.releasedBy : "";
          if (currentUserEmail && releasedBy === currentUserEmail) {
            releasedBy = "You";
          }

          row.push(releasedBy);
        }

        row.push(packageObject.description ? wordwrap(30)(packageObject.description) : "");
        row.push(getPackageMetricsString(packageObject) + (packageObject.isDisabled ? `\n${chalk.green("Disabled:")} Yes` : ""));
        if (packageObject.isDisabled) {
          row = row.map((cellContents: string) => applyChalkSkippingLineBreaks(cellContents, (<any>chalk).dim));
        }

        dataSource.push(row);
      });
    });
  }
}

function applyChalkSkippingLineBreaks(applyString: string, chalkMethod: (string: string) => any): string {
  // Used to prevent "chalk" from applying styles to linebreaks which
  // causes table border chars to have the style applied as well.
  return applyString
    .split("\n")
    .map((token: string) => chalkMethod(token))
    .join("\n");
}

function getPackageString(packageObject: Package): string {
  if (!packageObject) {
    return chalk.magenta("No updates released").toString();
  }

  let packageString: string =
    chalk.green("Label: ") +
    packageObject.label +
    "\n" +
    chalk.green("App Version: ") +
    packageObject.appVersion +
    "\n" +
    chalk.green("Mandatory: ") +
    (packageObject.isMandatory ? "Yes" : "No") +
    "\n" +
    chalk.green("Release Time: ") +
    formatDate(packageObject.uploadTime) +
    "\n" +
    chalk.green("Released By: ") +
    (packageObject.releasedBy ? packageObject.releasedBy : "") +
    (packageObject.description ? wordwrap(70)("\n" + chalk.green("Description: ") + packageObject.description) : "");

  if (packageObject.isDisabled) {
    packageString += `\n${chalk.green("Disabled:")} Yes`;
  }

  return packageString;
}

function getPackageMetricsString(obj: Package): string {
  const packageObject = <PackageWithMetrics>obj;
  const rolloutString: string =
    obj && obj.rollout && obj.rollout !== 100 ? `\n${chalk.green("Rollout:")} ${obj.rollout.toLocaleString()}%` : "";

  if (!packageObject || !packageObject.metrics) {
    return chalk.magenta("No installs recorded").toString() + (rolloutString || "");
  }

  const activePercent: number = packageObject.metrics.totalActive
    ? (packageObject.metrics.active / packageObject.metrics.totalActive) * 100
    : 0.0;
  let percentString: string;
  if (activePercent === 100.0) {
    percentString = "100%";
  } else if (activePercent === 0.0) {
    percentString = "0%";
  } else {
    percentString = activePercent.toPrecision(2) + "%";
  }

  const numPending: number = packageObject.metrics.downloaded - packageObject.metrics.installed - packageObject.metrics.failed;
  let returnString: string =
    chalk.green("Active: ") +
    percentString +
    " (" +
    packageObject.metrics.active.toLocaleString() +
    " of " +
    packageObject.metrics.totalActive.toLocaleString() +
    ")\n" +
    chalk.green("Total: ") +
    packageObject.metrics.installed.toLocaleString();

  if (numPending > 0) {
    returnString += " (" + numPending.toLocaleString() + " pending)";
  }

  if (packageObject.metrics.failed) {
    returnString += "\n" + chalk.green("Rollbacks: ") + chalk.red(packageObject.metrics.failed.toLocaleString() + "");
  }

  if (rolloutString) {
    returnString += rolloutString;
  }

  return returnString;
}

function getReactNativeProjectAppVersion(command: cli.IReleaseReactCommand, projectName: string): Promise<string> {
  const fileExists = (file: string): boolean => {
    try {
      return fs.statSync(file).isFile();
    } catch (e) {
      return false;
    }
  };

  const isValidVersion = (version: string): boolean => !!semver.valid(version) || /^\d+\.\d+$/.test(version);

  log(chalk.cyan(`Detecting ${command.platform} app version:\n`));

  if (command.platform === "ios") {
    let resolvedPlistFile: string = command.plistFile;
    if (resolvedPlistFile) {
      // If a plist file path is explicitly provided, then we don't
      // need to attempt to "resolve" it within the well-known locations.
      if (!fileExists(resolvedPlistFile)) {
        throw new Error("The specified plist file doesn't exist. Please check that the provided path is correct.");
      }
    } else {
      // Allow the plist prefix to be specified with or without a trailing
      // separator character, but prescribe the use of a hyphen when omitted,
      // since this is the most commonly used convetion for plist files.
      if (command.plistFilePrefix && /.+[^-.]$/.test(command.plistFilePrefix)) {
        command.plistFilePrefix += "-";
      }

      const iOSDirectory: string = "ios";
      const plistFileName = `${command.plistFilePrefix || ""}Info.plist`;

      const knownLocations = [path.join(iOSDirectory, projectName, plistFileName), path.join(iOSDirectory, plistFileName)];

      resolvedPlistFile = (<any>knownLocations).find(fileExists);

      if (!resolvedPlistFile) {
        throw new Error(
          `Unable to find either of the following plist files in order to infer your app's binary version: "${knownLocations.join(
            '", "'
          )}". If your plist has a different name, or is located in a different directory, consider using either the "--plistFile" or "--plistFilePrefix" parameters to help inform the CLI how to find it.`
        );
      }
    }

    const plistContents = fs.readFileSync(resolvedPlistFile).toString();

    let parsedPlist;

    try {
      parsedPlist = plist.parse(plistContents);
    } catch (e) {
      throw new Error(`Unable to parse "${resolvedPlistFile}". Please ensure it is a well-formed plist file.`);
    }

    if (parsedPlist && parsedPlist.CFBundleShortVersionString) {
      if (isValidVersion(parsedPlist.CFBundleShortVersionString)) {
        log(`Using the target binary version value "${parsedPlist.CFBundleShortVersionString}" from "${resolvedPlistFile}".\n`);
        return Q(parsedPlist.CFBundleShortVersionString);
      } else {
        throw new Error(
          `The "CFBundleShortVersionString" key in the "${resolvedPlistFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
        );
      }
    } else {
      throw new Error(`The "CFBundleShortVersionString" key doesn't exist within the "${resolvedPlistFile}" file.`);
    }
  } else if (command.platform === "android") {
    let buildGradlePath: string = path.join("android", "app");
    if (command.gradleFile) {
      buildGradlePath = command.gradleFile;
    }
    if (fs.lstatSync(buildGradlePath).isDirectory()) {
      buildGradlePath = path.join(buildGradlePath, "build.gradle");
    }

    if (fileDoesNotExistOrIsDirectory(buildGradlePath)) {
      throw new Error(`Unable to find gradle file "${buildGradlePath}".`);
    }

    return g2js
      .parseFile(buildGradlePath)
      .catch(() => {
        throw new Error(`Unable to parse the "${buildGradlePath}" file. Please ensure it is a well-formed Gradle file.`);
      })
      .then((buildGradle: any) => {
        let versionName: string = null;

        // First 'if' statement was implemented as workaround for case
        // when 'build.gradle' file contains several 'android' nodes.
        // In this case 'buildGradle.android' prop represents array instead of object
        // due to parsing issue in 'g2js.parseFile' method.
        if (buildGradle.android instanceof Array) {
          for (let i = 0; i < buildGradle.android.length; i++) {
            const gradlePart = buildGradle.android[i];
            if (gradlePart.defaultConfig && gradlePart.defaultConfig.versionName) {
              versionName = gradlePart.defaultConfig.versionName;
              break;
            }
          }
        } else if (buildGradle.android && buildGradle.android.defaultConfig && buildGradle.android.defaultConfig.versionName) {
          versionName = buildGradle.android.defaultConfig.versionName;
        } else {
          throw new Error(
            `The "${buildGradlePath}" file doesn't specify a value for the "android.defaultConfig.versionName" property.`
          );
        }

        if (typeof versionName !== "string") {
          throw new Error(
            `The "android.defaultConfig.versionName" property value in "${buildGradlePath}" is not a valid string. If this is expected, consider using the --targetBinaryVersion option to specify the value manually.`
          );
        }

        let appVersion: string = versionName.replace(/"/g, "").trim();

        if (isValidVersion(appVersion)) {
          // The versionName property is a valid semver string,
          // so we can safely use that and move on.
          log(`Using the target binary version value "${appVersion}" from "${buildGradlePath}".\n`);
          return appVersion;
        } else if (/^\d.*/.test(appVersion)) {
          // The versionName property isn't a valid semver string,
          // but it starts with a number, and therefore, it can't
          // be a valid Gradle property reference.
          throw new Error(
            `The "android.defaultConfig.versionName" property in the "${buildGradlePath}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        // The version property isn't a valid semver string
        // so we assume it is a reference to a property variable.
        const propertyName = appVersion.replace("project.", "");
        const propertiesFileName = "gradle.properties";

        const knownLocations = [path.join("android", "app", propertiesFileName), path.join("android", propertiesFileName)];

        // Search for gradle properties across all `gradle.properties` files
        let propertiesFile: string = null;
        for (let i = 0; i < knownLocations.length; i++) {
          propertiesFile = knownLocations[i];
          if (fileExists(propertiesFile)) {
            const propertiesContent: string = fs.readFileSync(propertiesFile).toString();
            try {
              const parsedProperties: any = properties.parse(propertiesContent);
              appVersion = parsedProperties[propertyName];
              if (appVersion) {
                break;
              }
            } catch (e) {
              throw new Error(`Unable to parse "${propertiesFile}". Please ensure it is a well-formed properties file.`);
            }
          }
        }

        if (!appVersion) {
          throw new Error(`No property named "${propertyName}" exists in the "${propertiesFile}" file.`);
        }

        if (!isValidVersion(appVersion)) {
          throw new Error(
            `The "${propertyName}" property in the "${propertiesFile}" file needs to specify a valid semver string, containing both a major and minor version (e.g. 1.3.2, 1.1).`
          );
        }

        log(`Using the target binary version value "${appVersion}" from the "${propertyName}" key in the "${propertiesFile}" file.\n`);
        return appVersion.toString();
      });
  } else {
    const appxManifestFileName: string = "Package.appxmanifest";
    let appxManifestContainingFolder: string;
    let appxManifestContents: string;

    try {
      appxManifestContainingFolder = path.join("windows", projectName);
      appxManifestContents = fs.readFileSync(path.join(appxManifestContainingFolder, "Package.appxmanifest")).toString();
    } catch (err) {
      throw new Error(`Unable to find or read "${appxManifestFileName}" in the "${path.join("windows", projectName)}" folder.`);
    }

    return parseXml(appxManifestContents)
      .catch((err: any) => {
        throw new Error(
          `Unable to parse the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file, it could be malformed.`
        );
      })
      .then((parsedAppxManifest: any) => {
        try {
          return parsedAppxManifest.Package.Identity[0]["$"].Version.match(/^\d+\.\d+\.\d+/)[0];
        } catch (e) {
          throw new Error(
            `Unable to parse the package version from the "${path.join(appxManifestContainingFolder, appxManifestFileName)}" file.`
          );
        }
      });
  }
}

function printJson(object: any): void {
  log(JSON.stringify(object, /*replacer=*/ null, /*spacing=*/ 2));
}

function printAccessKeys(format: string, keys: AccessKey[]): void {
  if (format === "json") {
    printJson(keys);
  } else if (format === "table") {
    printTable(["Name", "Created", "Expires", "Scope"], (dataSource: any[]): void => {
      const now = new Date().getTime();

      function isExpired(key: AccessKey): boolean {
        return now >= key.expires;
      }

      function keyToTableRow(key: AccessKey, dim: boolean): string[] {
        const row: string[] = [key.name, key.createdTime ? formatDate(key.createdTime) : "", formatDate(key.expires), formatKeyScope(key.scopes, key.appNames)];

        if (dim) {
          row.forEach((col: string, index: number) => {
            row[index] = (<any>chalk).dim(col);
          });
        }

        return row;
      }

      keys.forEach((key: AccessKey) => !isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ false)));
      keys.forEach((key: AccessKey) => isExpired(key) && dataSource.push(keyToTableRow(key, /*dim*/ true)));
    });
  }
}

function printSessions(format: string, sessions: Session[]): void {
  if (format === "json") {
    printJson(sessions);
  } else if (format === "table") {
    printTable(["Machine", "Logged in"], (dataSource: any[]): void => {
      sessions.forEach((session: Session) => dataSource.push([session.machineName, formatDate(session.loggedInTime)]));
    });
  }
}

function printTable(columnNames: string[], readData: (dataSource: any[]) => void): void {
  const table = new Table({
    head: columnNames,
    style: { head: ["cyan"] },
  });

  readData(table);

  log(table.toString());
}

function promote(command: cli.IPromoteCommand): Promise<void> {
  return getAppPlatformForRouting(command.appName).then((platform) => (platform === "expo-v1" ? promoteExpo(command) : promoteCodePush(command)));
}

function promoteCodePush(command: cli.IPromoteCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    label: command.label,
    isDisabled: command.disabled,
    isMandatory: command.mandatory,
    rollout: command.rollout,
  };

  return sdk
    .promote(command.appName, command.sourceDeploymentName, command.destDeploymentName, packageInfo)
    .then((): void => {
      log(
        "Successfully promoted " +
          (command.label !== null ? '"' + command.label + '" of ' : "") +
          'the "' +
          command.sourceDeploymentName +
          '" deployment of the "' +
          command.appName +
          '" app to the "' +
          command.destDeploymentName +
          '" deployment.'
      );
    })
    .catch((err: CodePushError) => releaseErrorHandler(err, command));
}

function patch(command: cli.IPatchCommand): Promise<void> {
  return getAppPlatformForRouting(command.appName).then((platform) => (platform === "expo-v1" ? patchExpo(command) : patchCodePush(command)));
}

function patchCodePush(command: cli.IPatchCommand): Promise<void> {
  const packageInfo: PackageInfo = {
    appVersion: command.appStoreVersion,
    description: command.description,
    isMandatory: command.mandatory,
    isDisabled: command.disabled,
    rollout: command.rollout,
  };

  for (const updateProperty in packageInfo) {
    if ((<any>packageInfo)[updateProperty] !== null) {
      return sdk.patchRelease(command.appName, command.deploymentName, command.label, packageInfo).then((): void => {
        log(
          `Successfully updated the "${command.label ? command.label : `latest`}" release of "${command.appName}" app's "${
            command.deploymentName
          }" deployment.`
        );
      });
    }
  }

  throw new Error("At least one property must be specified to patch a release.");
}

export const release = (command: cli.IReleaseCommand): Promise<void> => {
  if (isBinaryOrZip(command.package)) {
    throw new Error(
      "It is unnecessary to package releases in a .zip or binary file. Please specify the direct path to the update content's directory (e.g. /platforms/ios/www) or file (e.g. main.jsbundle)."
    );
  }

  throwForInvalidSemverRange(command.appStoreVersion);
  const filePath: string = command.package;
  let isSingleFilePackage: boolean = true;

  if (fs.lstatSync(filePath).isDirectory()) {
    isSingleFilePackage = false;
  }

  let lastTotalProgress = 0;
  const progressBar = new progress("Upload progress:[:bar] :percent :etas", {
    complete: "=",
    incomplete: " ",
    width: 50,
    total: 100,
  });

  const uploadProgress = (currentProgress: number): void => {
    progressBar.tick(currentProgress - lastTotalProgress);
    lastTotalProgress = currentProgress;
  };

  const updateMetadata: PackageInfo = {
    description: command.description,
    isDisabled: command.disabled,
    isMandatory: command.mandatory,
    rollout: command.rollout,
  };

  const getSignatureJwt = (): Promise<string | undefined> => {
    if (!command.privateKey) return Q(undefined);
    const privateKey = resolvePrivateKey(command.privateKey);
    // For single-file packages, build a single-entry manifest so the contentHash matches
    // what the SDK computes on-device after extracting the zip (manifest hash, not raw sha256).
    const hashPromise: Promise<string> = isSingleFilePackage
      ? hashUtils.hashFile(filePath).then((fileHash: string) => {
          const map = new Map<string, string>();
          map.set(path.basename(filePath), fileHash);
          return new hashUtils.PackageManifest(map).computePackageHash();
        })
      : hashUtils.generatePackageHashFromDirectory(filePath, signatureManifestBase(filePath));
    return hashPromise.then((packageHash: string) => createRS256JWT(privateKey, packageHash));
  };

  return sdk
    .isAuthenticated(true)
    .then((): Promise<string | undefined> => getSignatureJwt())
    .then((signatureJwt: string | undefined): Promise<void> => {
      return sdk.release(command.appName, command.deploymentName, filePath, command.appStoreVersion, updateMetadata, uploadProgress, signatureJwt);
    })
    .then((): void => {
      log(
        'Successfully released an update containing the "' +
          command.package +
          '" ' +
          (isSingleFilePackage ? "file" : "directory") +
          ' to the "' +
          command.deploymentName +
          '" deployment of the "' +
          command.appName +
          '" app.'
      );
    })
    .catch((err: CodePushError) => releaseErrorHandler(err, command));
};

export const releaseReact = (command: cli.IReleaseReactCommand): Promise<void> => {
  let bundleName: string = command.bundleName;
  let entryFile: string = command.entryFile;
  const outputFolder: string = command.outputDir || path.join(os.tmpdir(), "dpctl");
  const platform: string = (command.platform = command.platform.toLowerCase());
  const releaseCommand: cli.IReleaseCommand = <any>command;
  // Check for app and deployment exist before releasing an update.
  // This validation helps to save about 1 minute or more in case user has typed wrong app or deployment name.
  return (
    sdk
      .getDeployment(command.appName, command.deploymentName)
      .then(() => getAppPlatform(command.appName))
      .then((appPlatform: string | null | undefined): any => {
        assertReleaseRuntime({ expected: "codepush", appName: command.appName, deploymentName: command.deploymentName, appPlatform });
        assertReleasePlatform({ appName: command.appName, deploymentName: command.deploymentName, appPlatform, releasePlatform: platform });
        const projectWarning = checkReleaseProjectKind({ appName: command.appName, appPlatform, projectRoot: process.cwd() });
        if (projectWarning) console.warn(chalk.yellow("[Warning] " + projectWarning));

        releaseCommand.package = outputFolder;

        switch (platform) {
          case "android":
          case "ios":
          case "windows":
            if (!bundleName) {
              bundleName = platform === "ios" ? "main.jsbundle" : `index.${platform}.bundle`;
            }

            break;
          default:
            throw new Error('Platform must be either "android", "ios" or "windows".');
        }

        let projectName: string;

        try {
          const projectPackageJson: any = require(path.join(process.cwd(), "package.json"));
          projectName = projectPackageJson.name;
          if (!projectName) {
            throw new Error('The "package.json" file in the CWD does not have the "name" field set.');
          }

          if (!projectPackageJson.dependencies["react-native"]) {
            throw new Error("The project in the CWD is not a React Native project.");
          }
        } catch (error) {
          throw new Error(
            'Unable to find or read "package.json" in the CWD. The "release-react" command must be executed in a React Native project folder.'
          );
        }

        if (!entryFile) {
          entryFile = `index.${platform}.js`;
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            entryFile = "index.js";
          }

          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "index.${platform}.js" or "index.js" does not exist.`);
          }
        } else {
          if (fileDoesNotExistOrIsDirectory(entryFile)) {
            throw new Error(`Entry file "${entryFile}" does not exist.`);
          }
        }

        if (command.appStoreVersion) {
          throwForInvalidSemverRange(command.appStoreVersion);
        }

        const appVersionPromise: Promise<string> = command.appStoreVersion
          ? Q(command.appStoreVersion)
          : getReactNativeProjectAppVersion(command, projectName);

        if (command.outputDir) {
          command.sourcemapOutput = path.join(command.outputDir, bundleName + ".map");
        }

        return appVersionPromise;
      })
      .then((appVersion: string) => {
        releaseCommand.appStoreVersion = appVersion;
        return createEmptyTempReleaseFolder(outputFolder);
      })
      // This is needed to clear the react native bundler cache:
      // https://github.com/facebook/react-native/issues/4289
      .then(() => deleteFolder(`${os.tmpdir()}/react-*`, /*glob*/ true))
      .then(() =>
        runReactNativeBundleCommand(
          bundleName,
          command.development || false,
          entryFile,
          outputFolder,
          platform,
          command.sourcemapOutput
        )
      )
      // Hermes runs after bundling and before the upload: it rewrites the bundle in place.
      .then(() =>
        Q(
          compileHermesIfEnabled({
            platform,
            bundleName,
            outputFolder,
            sourcemapOutput: command.sourcemapOutput,
            useHermes: command.useHermes,
            extraHermesFlags: command.extraHermesFlags,
            podFile: command.podFile,
            log,
          })
        )
      )
      .then(() => {
        log(chalk.cyan("\nReleasing update contents to DeployPulse:\n"));
        return release(releaseCommand);
      })
      .then(() => {
        if (!command.outputDir) {
          deleteFolder(outputFolder);
        }
      })
      .catch((err: Error) => {
        deleteFolder(outputFolder);
        throw err;
      })
  );
};

export const bundleReact = (command: cli.IBundleReactCommand): Promise<void> => {
  let bundleName: string = command.bundleName;
  let entryFile: string = command.entryFile;
  const isTempDir = !command.outputDir;
  const outputFolder: string = command.outputDir || path.join(os.tmpdir(), "dpctl");
  const platform: string = (command.platform = command.platform.toLowerCase());
  const outputZipPath: string = path.resolve(command.outputPath || "bundle.zip");

  return Q(<void>null)
    .then((): void => {
      switch (platform) {
        case "android":
        case "ios":
        case "windows":
          if (!bundleName) {
            bundleName = platform === "ios" ? "main.jsbundle" : `index.${platform}.bundle`;
          }
          break;
        default:
          throw new Error('Platform must be either "android", "ios" or "windows".');
      }

      // Only the read is guarded. Wrapping the checks too made their messages unreachable, so a project
      // with no "name" was reported as an unreadable package.json.
      let projectPackageJson: any;
      try {
        projectPackageJson = require(path.join(process.cwd(), "package.json"));
      } catch {
        throw new Error(
          'Unable to find or read "package.json" in the CWD. The "bundle-react" command must be executed in a React Native project folder.'
        );
      }
      if (!projectPackageJson.name) {
        throw new Error('The "package.json" file in the CWD does not have the "name" field set.');
      }
      if (!projectPackageJson.dependencies?.["react-native"]) {
        throw new Error("The project in the CWD is not a React Native project.");
      }

      if (!entryFile) {
        entryFile = `index.${platform}.js`;
        if (fileDoesNotExistOrIsDirectory(entryFile)) entryFile = "index.js";
        if (fileDoesNotExistOrIsDirectory(entryFile)) {
          throw new Error(`Entry file "index.${platform}.js" or "index.js" does not exist.`);
        }
      } else if (fileDoesNotExistOrIsDirectory(entryFile)) {
        throw new Error(`Entry file "${entryFile}" does not exist.`);
      }
    })
    .then(() => createEmptyTempReleaseFolder(outputFolder))
    .then(() => deleteFolder(`${os.tmpdir()}/react-*`, /*glob*/ true))
    .then(() =>
      runReactNativeBundleCommand(bundleName, command.development || false, entryFile, outputFolder, platform, command.sourcemapOutput)
    )
    // Before the signature step, which hashes outputFolder: signing the JS and then swapping in
    // bytecode would produce a zip whose signature fails verification on device.
    .then(() =>
      Q(
        compileHermesIfEnabled({
          platform,
          bundleName,
          outputFolder,
          sourcemapOutput: command.sourcemapOutput,
          useHermes: command.useHermes,
          extraHermesFlags: command.extraHermesFlags,
          podFile: command.podFile,
          log,
        })
      )
    )
    .then((): Promise<string | undefined> => {
      if (!command.privateKey) return Q(undefined);
      const privateKey = resolvePrivateKey(command.privateKey);
      return hashUtils
        .generatePackageHashFromDirectory(outputFolder, signatureManifestBase(outputFolder))
        .then((packageHash: string) => createRS256JWT(privateKey, packageHash));
    })
    .then((signatureJwt: string | undefined): Promise<void> => {
      return Promise<void>((resolve, reject) => {
        recursiveFs.readdirr(outputFolder, (error?: any, _dirs?: string[], files?: string[]) => {
          if (error) { reject(error); return; }
          const baseDir = path.dirname(outputFolder);
          const zipFile = new yazl.ZipFile();
          const writeStream = fs.createWriteStream(outputZipPath);
          zipFile.outputStream.pipe(writeStream).on("error", reject).on("close", resolve);
          for (const file of files) {
            zipFile.addFile(file, slash(path.relative(baseDir, file)));
          }
          if (signatureJwt) {
            zipFile.addBuffer(Buffer.from(signatureJwt), "CodePush/.codepushrelease");
          }
          zipFile.end();
        });
      });
    })
    .then((): void => {
      log(chalk.green(`\nSuccessfully created bundle: ${outputZipPath}\n`));
      if (isTempDir) deleteFolder(outputFolder);
    })
    .catch((err: Error) => {
      if (isTempDir) deleteFolder(outputFolder);
      throw err;
    });
};

function rollback(command: cli.IRollbackCommand): Promise<void> {
  return getAppPlatformForRouting(command.appName).then((platform) => (platform === "expo-v1" ? rollbackExpo(command) : rollbackCodePush(command)));
}

function rollbackCodePush(command: cli.IRollbackCommand): Promise<void> {
  const expoOnly: string[] = [];
  if (command.platform) expoOnly.push("--platform");
  if (command.runtimeVersion) expoOnly.push("--runtimeVersion");
  if (command.toEmbedded) expoOnly.push("--toEmbedded");
  if (expoOnly.length) {
    throw new Error(
      `${expoOnly.join(" and ")} only appl${expoOnly.length > 1 ? "y" : "ies"} to Expo Updates apps, and ` +
        `"${command.appName}" is a CodePush app. Roll back to an earlier release with --targetRelease instead.`
    );
  }

  return confirm().then((wasConfirmed: boolean) => {
    if (!wasConfirmed) {
      log("Rollback cancelled.");
      return;
    }

    return sdk.rollback(command.appName, command.deploymentName, command.targetRelease || undefined).then((): void => {
      log(
        'Successfully performed a rollback on the "' + command.deploymentName + '" deployment of the "' + command.appName + '" app.'
      );
    });
  });
}

function requestAccessKey(): Promise<string> {
  return Promise<string>((resolve, reject, notify): void => {
    prompt.message = "";
    prompt.delimiter = "";

    prompt.start();

    prompt.get(
      {
        properties: {
          response: {
            description: chalk.cyan("Enter your access key: "),
          },
        },
      },
      (err: any, result: any): void => {
        if (err) {
          resolve(null);
        } else {
          resolve(result.response.trim());
        }
      }
    );
  });
}

export const runReactNativeBundleCommand = (
  bundleName: string,
  development: boolean,
  entryFile: string,
  outputFolder: string,
  platform: string,
  sourcemapOutput: string
): Promise<void> => {
  const reactNativeBundleArgs: string[] = [];
  const envNodeArgs: string = process.env.CODE_PUSH_NODE_ARGS;

  if (typeof envNodeArgs !== "undefined") {
    Array.prototype.push.apply(reactNativeBundleArgs, envNodeArgs.trim().split(/\s+/));
  }

  const isNewCLI = fs.existsSync(path.join("node_modules", "react-native", "cli.js"));

  Array.prototype.push.apply(reactNativeBundleArgs, [
    isNewCLI ? path.join("node_modules", "react-native", "cli.js") : path.join("node_modules", "react-native", "local-cli", "cli.js"),
    "bundle",
    "--assets-dest",
    outputFolder,
    "--bundle-output",
    path.join(outputFolder, bundleName),
    "--dev",
    development,
    "--entry-file",
    entryFile,
    "--platform",
    platform,
  ]);

  if (sourcemapOutput) {
    reactNativeBundleArgs.push("--sourcemap-output", sourcemapOutput);
  }

  log(chalk.cyan('Running "react-native bundle" command:\n'));
  const reactNativeBundleProcess = spawn("node", reactNativeBundleArgs, { env: envWithoutCredentials() });
  log(`node ${reactNativeBundleArgs.join(" ")}`);

  return Promise<void>((resolve, reject, notify) => {
    reactNativeBundleProcess.stdout.on("data", (data: Buffer) => {
      log(data.toString().trim());
    });

    reactNativeBundleProcess.stderr.on("data", (data: Buffer) => {
      console.error(data.toString().trim());
    });

    reactNativeBundleProcess.on("close", (exitCode: number) => {
      if (exitCode) {
        reject(new Error(`"react-native bundle" command exited with code ${exitCode}.`));
      }

      resolve(<void>null);
    });
  });
};


/**
 * Ask, once at login, which organization this machine's commands run against.
 *
 * Single-select: x-org-id carries one organization, so a command runs against the personal account or
 * exactly one org. It asks nothing when --org already answered, when the account has no organizations,
 * or when stdin is not a terminal, which is the CI case. A failure here never fails the login: the
 * access key has already been minted by this point.
 */
// `export const`, like writeConnectionInfo: TypeScript routes calls to an exported const through the
// exports object, which is what lets a test stub promptForLine without a terminal.
export const chooseOrgContext = (command?: cli.ICommand): Promise<OrgContext | null> => {
  if (command?.org) {
    return resolveOrg(command.org).then((org: Org): OrgContext => ({ id: org.id, slug: org.slug }));
  }

  if (!process.stdin.isTTY) return Q(<OrgContext>null);

  return sdk
    .getOrgs()
    .then((orgs: Org[]): Promise<OrgContext> => {
      if (!orgs.length) return Q(<OrgContext>null);

      log("");
      log("You belong to the following organizations:");
      orgs.forEach((org: Org, index: number) => log(`  ${index + 1}) ${org.name} (${org.slug})`));
      log("  0) Personal account");

      return exports.promptForLine(`Which should commands run against? [0-${orgs.length}, default 0]:`).then(
        (answer: string): OrgContext => {
          const choice: number = parseInt(answer, 10);
          // Anything else means personal, which is the safe answer: it touches only your own apps.
          if (!(choice >= 1 && choice <= orgs.length)) return null;
          return { id: orgs[choice - 1].id, slug: orgs[choice - 1].slug };
        }
      );
    })
    .catch((): OrgContext => null);
};

export const promptForLine = (message: string): Promise<string> => {
  return Promise<string>((resolve): void => {
    prompt.message = "";
    prompt.delimiter = "";
    prompt.start();
    prompt.get({ properties: { response: { description: chalk.cyan(message) } } }, (err: any, result: any): void => {
      resolve(err || !result ? "" : String(result.response ?? "").trim());
    });
  });
};

// --org, then DEPLOYPULSE_ORG_ID, then `dpctl org use`. The variable beats the session file so CI can
// switch context without rewriting it. `resolve` marks the one that costs a lookup: --org takes a slug
// or a name, the other two are already ids.
function requestedOrg(command: cli.ICommand): { value: string; resolve: boolean } | null {
  if (command.org) return { value: command.org, resolve: true };
  if (process.env.DEPLOYPULSE_ORG_ID) return { value: process.env.DEPLOYPULSE_ORG_ID, resolve: false };
  if (connectionInfo?.orgId) return { value: connectionInfo.orgId, resolve: false };
  return null;
}

function resolveOrg(requested: string): Promise<Org> {
  return sdk.getOrgs().then((orgs: Org[]): Org => {
    const needle = requested.toLowerCase();
    // Tiered, most specific first, because slugs are unique server-side but NAMES ARE NOT: two orgs
    // called "Acme" get slugs "acme" and "acme-2", and one find() over id|slug|name could match the
    // wrong one by name and persist it.
    const byId = orgs.filter((org: Org) => org.id === requested);
    const bySlug = orgs.filter((org: Org) => (org.slug ?? "").toLowerCase() === needle);
    const byName = orgs.filter((org: Org) => (org.name ?? "").toLowerCase() === needle);
    const tier = byId.length ? byId : bySlug.length ? bySlug : byName;
    if (tier.length > 1) {
      throw new Error(
        `"${requested}" matches ${tier.length} organizations (${tier.map((org: Org) => org.slug).join(", ")}). Use the slug or the id.`
      );
    }
    const match = tier[0];
    if (!match) {
      const known = orgs.length ? orgs.map((org: Org) => org.slug).join(", ") : "none";
      throw new Error(`No organization "${requested}". Organizations you belong to: ${known}.`);
    }
    return match;
  });
}

// Runs after authentication and before the command, so every request it makes carries the header.
function applyOrgContext(command: cli.ICommand): Promise<void> {
  const requested = requestedOrg(command);
  if (!requested || !sdk || command.type === cli.CommandType.orgList || command.type === cli.CommandType.orgUse) {
    return Q(<void>null);
  }
  if (!requested.resolve) {
    sdk.setOrgId(requested.value);
    return Q(<void>null);
  }
  return resolveOrg(requested.value).then((org: Org): void => {
    sdk.setOrgId(org.id);
  });
}

function orgList(command: cli.IOrgListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getOrgs().then((orgs: Org[]): void => {
    const activeId = requestedOrg(command)?.value ?? null;
    if (command.format === "json") {
      printJson(orgs.map((org: Org) => ({ ...org, active: org.id === activeId || org.slug === activeId })));
      return;
    }
    printTable(["", "Slug", "Name", "Role"], (dataSource: any[]): void => {
      orgs.forEach((org: Org) => {
        const active = org.id === activeId || org.slug === activeId;
        dataSource.push([active ? chalk.green("*") : "", org.slug, org.name, org.role]);
      });
    });
    if (!orgs.length) {
      log("You do not belong to any organizations.");
    }
  });
}

/** The env var beats the session file, so a change to the file is a no-op while it is set. */
function warnIfOrgEnvOverrides(): void {
  if (process.env.DEPLOYPULSE_ORG_ID) {
    log(
      chalk.yellow(
        `[Warning] DEPLOYPULSE_ORG_ID is set (${process.env.DEPLOYPULSE_ORG_ID}) and takes precedence, so commands still run against that organization. Unset it for this change to take effect.`
      )
    );
  }
}

function orgUse(command: cli.IOrgUseCommand): Promise<void> {
  if (!connectionInfo) {
    throw new Error(
      "There is no session file to save the organization to. Run 'dpctl login' first, or set DEPLOYPULSE_ORG_ID if you authenticate with an access key."
    );
  }
  return resolveOrg(command.organization).then((org: Org): void => {
    writeConnectionInfo({ ...connectionInfo, orgId: org.id, orgSlug: org.slug });
    log(`Commands now run against ${chalk.cyan(org.name)} (${org.slug}). Run ${chalk.cyan("dpctl org clear")} to go back to your personal account.`);
    warnIfOrgEnvOverrides();
  });
}

function orgClear(command: cli.ICommand): Promise<void> {
  if (!connectionInfo?.orgId && !connectionInfo?.orgSlug) {
    log("Commands already run against your personal account.");
    return Q(<void>null);
  }
  const { orgId, orgSlug, ...rest } = connectionInfo;
  writeConnectionInfo(rest);
  log(
    orgSlug
      ? `Commands now run against your personal account. ${chalk.cyan("dpctl org use " + orgSlug)} switches back.`
      : "Commands now run against your personal account."
  );
  warnIfOrgEnvOverrides();
  return Q(<void>null);
}

// `export const`, not `export function`: TypeScript compiles calls to an exported const through the
// exports object, which is what lets the tests stub this and keep the real session file untouched.
export const writeConnectionInfo = (connectionInfo: ILoginConnectionInfo): void => {
  fs.writeFileSync(configFilePath, JSON.stringify(connectionInfo), { encoding: "utf8" });
};

function serializeConnectionInfo(accessKey: string, preserveAccessKeyOnLogout: boolean, org?: OrgContext): void {
  const connectionInfo: ILoginConnectionInfo = {
    accessKey: accessKey,
    preserveAccessKeyOnLogout: preserveAccessKeyOnLogout,
    ...(org?.id ? { orgId: org.id, orgSlug: org.slug } : {}),
  };

  writeConnectionInfo(connectionInfo);

  log(
    `\r\nSuccessfully logged-in. Your session file was written to ${chalk.cyan(configFilePath)}. You can run the ${chalk.cyan(
      "dpctl logout"
    )} command at any time to delete this file and terminate your session.\r\n`
  );
}

function sessionList(command: cli.ISessionListCommand): Promise<void> {
  throwForInvalidOutputFormat(command.format);

  return sdk.getSessions().then((sessions: Session[]): void => {
    printSessions(command.format, sessions);
  });
}

function sessionRemove(command: cli.ISessionRemoveCommand): Promise<void> {
  if (os.hostname() === command.machineName) {
    throw new Error("Cannot remove the current login session via this command. Please run 'dpctl logout' instead.");
  } else {
    return confirm().then((wasConfirmed: boolean): Promise<void> => {
      if (wasConfirmed) {
        return sdk.removeSession(command.machineName).then((): void => {
          log(`Successfully removed the login session for "${command.machineName}".`);
        });
      }

      log("Session removal cancelled.");
    });
  }
}

function releaseErrorHandler(error: CodePushError, command: cli.ICommand): void {
  if ((<any>command).noDuplicateReleaseError && error.statusCode === AccountManager.ERROR_CONFLICT) {
    console.warn(chalk.yellow("[Warning] " + error.message));
  } else {
    throw error;
  }
}

function isBinaryOrZip(path: string): boolean {
  return path.search(/\.zip$/i) !== -1 || path.search(/\.apk$/i) !== -1 || path.search(/\.ipa$/i) !== -1;
}

function throwForInvalidEmail(email: string): void {
  if (!emailValidator.validate(email)) {
    throw new Error('"' + email + '" is an invalid e-mail address.');
  }
}

function throwForInvalidSemverRange(semverRange: string): void {
  if (semver.validRange(semverRange) === null) {
    throw new Error('Please use a semver-compliant target binary version range, for example "1.0.0", "*" or "^1.2.3".');
  }
}

function throwForInvalidOutputFormat(format: string): void {
  switch (format) {
    case "json":
    case "table":
      break;

    default:
      throw new Error("Invalid format:  " + format + ".");
  }
}

function whoami(command: cli.ICommand): Promise<void> {
  return sdk.getAccountInfo().then((account): void => {
    const accountInfo = `${account.email} (${account.linkedProviders.join(", ")})`;

    log(accountInfo);
  });
}

function isCommandOptionSpecified(option: any): boolean {
  return option !== undefined && option !== null;
}

function getSdk(accessKey: string, headers: Headers): AccountManager {
  const sdk: any = new AccountManager(accessKey, CLI_HEADERS);
  /*
   * If the server returns `Unauthorized`, it must be due to an invalid
   * (or expired) access key. For convenience, we patch every SDK call
   * to delete the cached connection so the user can simply
   * login again instead of having to log out first.
   */
  Object.getOwnPropertyNames(AccountManager.prototype).forEach((functionName: any) => {
    if (typeof sdk[functionName] === "function") {
      const originalFunction = sdk[functionName];
      sdk[functionName] = function () {
        let maybePromise: Promise<any> = originalFunction.apply(sdk, arguments);
        if (maybePromise && maybePromise.then !== undefined) {
          maybePromise = maybePromise.catch((error: any) => {
            if (error.statusCode && error.statusCode === AccountManager.ERROR_UNAUTHORIZED) {
              deleteConnectionInfoCache(/* printMessage */ false);
            }

            throw error;
          });
        }

        return maybePromise;
      };
    }
  });

  return sdk;
}
