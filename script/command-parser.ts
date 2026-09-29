// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as path from "path";
import * as yargs from "yargs";
import * as cli from "../script/types/cli";
import * as chalk from "chalk";
import backslash from "./backslash";
import parse from "parse-duration";

const packageJson = require(
  path.resolve(__dirname, path.basename(path.dirname(__dirname)) === "bin" ? "../../package.json" : "../package.json")
);
const ROLLOUT_PERCENTAGE_REGEX: RegExp = /^(100|[1-9][0-9]|[1-9])%?$/;
const USAGE_PREFIX = "Usage: dpctl";

// Command categories are:  access-key, app, release, deployment, deployment-key, login, logout 
let isValidCommandCategory = false;
// Commands are the verb following the command category (e.g.:  "add" in "app add").
let isValidCommand = false;
let lastFailMessage: string | undefined;
let wasHelpShown = false;

/** True when yargs already printed why the arguments were rejected, so callers need not add their own. */
export function failureReported(): boolean {
  return !!lastFailMessage;
}

export function showHelp(showRootDescription?: boolean): void {
  if (!wasHelpShown) {
    if (showRootDescription) {
      console.log(chalk.cyan("    ____             __           " + chalk.green(" ____        __        ")));
      console.log(chalk.cyan("   / __ \\___  ____  / /___  __  __" + chalk.green("/ __ \\__  __/ /_______ ")));
      console.log(chalk.cyan("  / / / / _ \\/ __ \\/ / __ \\/ / / /" + chalk.green(" /_/ / / / / / ___/ _ \\")));
      console.log(chalk.cyan(" / /_/ /  __/ /_/ / / /_/ / /_/ /" + chalk.green(" ____/ /_/ / (__  )  __/")));
      console.log(chalk.cyan("/_____/\\___/ .___/_/\\____/\\__, /" + chalk.green("_/    \\__,_/_/____/\\___/ ")));
      console.log(chalk.cyan("          /_/            /____/"));
      console.log(chalk.cyan("========================================================="));
      console.log("");
      console.log("DeployPulse is a service that enables you to deploy mobile app updates directly to your users' devices.\n");
    }

    yargs.scriptName("dpctl").showHelp();
    wasHelpShown = true;
  }
}

function accessKeyAdd(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " access-key " + commandName + " <accessKeyName>")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example(
      "access-key " + commandName + ' "VSTS Integration"',
      'Creates a new access key with the name "VSTS Integration", which expires in 60 days'
    )
    .example(
      "access-key " + commandName + ' "One time key" --ttl 5m',
      'Creates a new access key with the name "One time key", which expires in 5 minutes'
    )
    .option("ttl", {
      default: "60d",
      demand: false,
      description: "Duration string which specifies the amount of time that the access key should remain valid for (e.g 5m, 60d, 1y)",
      type: "string",
    })
    .example(
      "access-key " + commandName + ' "MyApp CI" --app MyApp-iOS --app MyApp-Android',
      "Creates a key that can only reach those two apps"
    )
    .example("access-key " + commandName + ' "Metrics bot" --scope read', "Creates a read-only key")
    .option("scope", {
      // No default: yargs validates `choices` against the default too, and omitting the field lets the
      // server apply its own.
      choices: ["full", "read"],
      demand: false,
      description: 'What the key may do: "full" (default) or "read" (GET requests only)',
      type: "string",
    })
    .option("app", {
      demand: false,
      description: "Limit the key to this app. Repeat for several apps. Omit for all apps.",
      type: "array",
    });

  addCommonConfiguration(yargs);
}

function accessKeyPatch(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " access-key " + commandName + " <accessKeyName>")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example(
      "access-key " + commandName + ' "Key for build server" --name "Key for CI machine"',
      'Renames the access key named "Key for build server" to "Key for CI machine"'
    )
    .example(
      "access-key " + commandName + ' "Key for build server" --ttl 7d',
      'Updates the access key named "Key for build server" to expire in 7 days'
    )
    .option("name", {
      default: null,
      demand: false,
      description: "Display name for the access key",
      type: "string",
    })
    .option("ttl", {
      default: null,
      demand: false,
      description: "Duration string which specifies the amount of time that the access key should remain valid for (e.g 5m, 60d, 1y)",
      type: "string",
    });
  addCommonConfiguration(yargs);
}

function accessKeyList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " access-key " + commandName + " [options]")
    .demand(/*count*/ 0, /*max*/ 0)
    .example("access-key " + commandName, "Lists your access keys in tabular format")
    .example("access-key " + commandName + " --format json", "Lists your access keys in JSON format")
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display your access keys with ("json" or "table")',
      type: "string",
    });

  addCommonConfiguration(yargs);
}

function accessKeyRemove(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " access-key " + commandName + " <accessKeyName>")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example("access-key " + commandName + ' "VSTS Integration"', 'Removes the "VSTS Integration" access key');

  addCommonConfiguration(yargs);
}

function addCommonConfiguration(yargs: yargs.Argv): void {
  yargs
    .wrap(/*columnLimit*/ null)
    .string("_") // Interpret non-hyphenated arguments as strings (e.g. an app version of '1.10').
    // Declared here so every command accepts it; strictOptions would reject it otherwise.
    .option("org", {
      demand: false,
      description: "Organization to run this command against (slug, name or id). Overrides 'dpctl org use'",
      type: "string",
    })
    // strictOptions, NOT strict: unknown flags become errors instead of being silently dropped, which is
    // what let `--deployment Production` ship releases to Staging. Full .strict() also validates
    // positionals, and this parser declares only positional counts, so every command would fail with
    // "Unknown arguments: MyApp, ios".
    .strictOptions()
    // Keep yargs' actual complaint ("Unknown argument: deployment"); a bare showHelp() throws away the
    // one line that says what was wrong.
    .fail((msg: string) => {
      // yargs runs this handler once per nesting level (root, category, subcommand, ...), so the
      // same message arrives several times for a single mistake. Print each one once.
      if (msg && msg !== lastFailMessage) {
        lastFailMessage = msg;
        console.error(chalk.red(`[Error]  ${msg}`));
      }
      showHelp();
    });
}

function orgList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " org " + commandName + " [options]")
    .demand(/*count*/ 0, /*max*/ 0)
    .example("org " + commandName, "List your organizations in tabular format")
    .example("org " + commandName + " --format json", "List your organizations in JSON format")
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display your organizations in ("json" or "table")',
      type: "string",
    });
  addCommonConfiguration(yargs);
}

function appList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " app " + commandName + " [options]")
    .demand(/*count*/ 0, /*max*/ 0)
    .example("app " + commandName, "List your apps in tabular format")
    .example("app " + commandName + " --format json", "List your apps in JSON format")
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display your apps with ("json" or "table")',
      type: "string",
    });

  addCommonConfiguration(yargs);
}

function appRemove(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " app " + commandName + " <appName>")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example("app " + commandName + " MyApp", 'Removes app "MyApp"');

  addCommonConfiguration(yargs);
}

function listCollaborators(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " collaborator " + commandName + " <appName> [options]")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example("collaborator " + commandName + " MyApp", 'Lists the collaborators for app "MyApp" in tabular format')
    .example("collaborator " + commandName + " MyApp --format json", 'Lists the collaborators for app "MyApp" in JSON format')
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display collaborators with ("json" or "table")',
      type: "string",
    });

  addCommonConfiguration(yargs);
}

function removeCollaborator(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " collaborator " + commandName + " <appName> <email>")
    .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
    .example("collaborator " + commandName + " MyApp foo@bar.com", 'Removes foo@bar.com as a collaborator from app "MyApp"');

  addCommonConfiguration(yargs);
}

function sessionList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " session " + commandName + " [options]")
    .demand(/*count*/ 0, /*max*/ 0)
    .example("session " + commandName, "Lists your sessions in tabular format")
    .example("session " + commandName + " --format json", "Lists your login sessions in JSON format")
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display your login sessions with ("json" or "table")',
      type: "string",
    });

  addCommonConfiguration(yargs);
}

function sessionRemove(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " session " + commandName + " <machineName>")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example("session " + commandName + ' "John\'s PC"', 'Removes the existing login session from "John\'s PC"');

  addCommonConfiguration(yargs);
}

function deploymentHistoryClear(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " deployment " + commandName + " <appName> <deploymentName>")
    .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
    .example(
      "deployment " + commandName + " MyApp MyDeployment",
      'Clears the release history associated with deployment "MyDeployment" from app "MyApp"'
    );

  addCommonConfiguration(yargs);
}

function deploymentList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " deployment " + commandName + " <appName> [options]")
    .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
    .example("deployment " + commandName + " MyApp", 'Lists the deployments for app "MyApp" in tabular format')
    .example("deployment " + commandName + " MyApp --format json", 'Lists the deployments for app "MyApp" in JSON format')
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display your deployments with ("json" or "table")',
      type: "string",
    })
    .option("displayKeys", {
      alias: "k",
      default: false,
      demand: false,
      description: "Specifies whether to display the deployment keys",
      type: "boolean",
    });
  addCommonConfiguration(yargs);
}

function deploymentRemove(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " deployment " + commandName + " <appName> <deploymentName>")
    .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
    .example("deployment " + commandName + " MyApp MyDeployment", 'Removes deployment "MyDeployment" from app "MyApp"');

  addCommonConfiguration(yargs);
}

function webhookList(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs.usage(USAGE_PREFIX + " webhook " + commandName).option("format", {
    alias: "f",
    default: "table",
    demand: false,
    description: 'Output format: "table" or "json"',
    type: "string",
  });
  addCommonConfiguration(yargs);
}

function webhookRemove(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " webhook " + commandName + " <id>")
    .demand(/*count*/ 1, /*max*/ 1) // The id; the category counts the words before it.
    .example("webhook " + commandName + " abc-123", "Remove the webhook with id abc-123");
  addCommonConfiguration(yargs);
}

function deploymentErrors(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " deployment " + commandName + " <appName> <deploymentName> [options]")
    .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
    .example("deployment " + commandName + " MyApp Production", 'Shows failed updates for the "Production" deployment of "MyApp"')
    .example(
      "deployment " + commandName + " MyApp Production --format json",
      "Same, as JSON (for example to fail a CI job when a new release starts failing)"
    )
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format ("json" or "table")',
      type: "string",
    })
    .option("limit", {
      default: 50,
      demand: false,
      description: "Maximum number of failure reports to show",
      type: "number",
    })
    .check((argv: any): any => {
      // Rejected rather than quietly replaced by the default, which is what --limit 0 used to do.
      if (!Number.isInteger(argv.limit) || argv.limit < 1) {
        throw new Error("--limit must be a whole number of 1 or more.");
      }
      return true;
    });

  addCommonConfiguration(yargs);
}

function deploymentHistory(commandName: string, yargs: yargs.Argv): void {
  isValidCommand = true;
  yargs
    .usage(USAGE_PREFIX + " deployment " + commandName + " <appName> <deploymentName> [options]")
    .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
    .example(
      "deployment " + commandName + " MyApp MyDeployment",
      'Displays the release history for deployment "MyDeployment" from app "MyApp" in tabular format'
    )
    .example(
      "deployment " + commandName + " MyApp MyDeployment --format json",
      'Displays the release history for deployment "MyDeployment" from app "MyApp" in JSON format'
    )
    .option("format", {
      default: "table",
      demand: false,
      description: 'Output format to display the release history with ("json" or "table")',
      type: "string",
    })
    .option("displayAuthor", {
      alias: "a",
      default: false,
      demand: false,
      description: "Specifies whether to display the release author",
      type: "boolean",
    });

  addCommonConfiguration(yargs);
}

yargs
  .usage(USAGE_PREFIX + " <command>")
  .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option argument.
  .command("access-key", "View and manage the access keys associated with your account", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " access-key <command>")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments.
      .command("add", "Create a new access key associated with your account", (yargs: yargs.Argv) => accessKeyAdd("add", yargs))
      .command("patch", "Update the name and/or TTL of an existing access key", (yargs: yargs.Argv) => accessKeyPatch("patch", yargs))
      .command("remove", "Remove an existing access key", (yargs: yargs.Argv) => accessKeyRemove("remove", yargs))
      .command("rm", "Remove an existing access key", (yargs: yargs.Argv) => accessKeyRemove("rm", yargs))
      .command("list", "List the access keys associated with your account", (yargs: yargs.Argv) => accessKeyList("list", yargs))
      .command("ls", "List the access keys associated with your account", (yargs: yargs.Argv) => accessKeyList("ls", yargs))
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("app", "View and manage your DeployPulse apps", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " app <command>")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments.
      .command("add", "Add a new app to your account", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " app add <appName>")
          .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
          .example("app add MyApp --platform ios", 'Adds a React Native iOS app named "MyApp"')
          .example("app add MyApp --platform expo-v1", 'Adds an Expo Updates v1 app named "MyApp"')
          .option("platform", {
            alias: "p",
            default: null,
            demand: false,
            description: 'Target platform: "ios", "android", "expo-cng-ios", "expo-cng-android", or "expo-v1". Cannot be changed after creation.',
            type: "string",
          })
          .check((argv: any): any => {
            const validPlatforms = ["ios", "android", "expo-cng-ios", "expo-cng-android", "expo-v1"];
            if (argv.platform && !validPlatforms.includes(argv.platform)) {
              throw new Error("--platform must be one of: " + validPlatforms.join(", "));
            }
            return true;
          })
          .example("app add MyApp", 'Adds app "MyApp"');

        addCommonConfiguration(yargs);
      })
      .command("remove", "Remove an app from your account", (yargs: yargs.Argv) => appRemove("remove", yargs))
      .command("rm", "Remove an app from your account", (yargs: yargs.Argv) => appRemove("rm", yargs))
      .command("rename", "Rename an existing app", (yargs: yargs.Argv) => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " app rename <currentAppName> <newAppName>")
          .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
          .example("app rename CurrentName NewName", 'Renames app "CurrentName" to "NewName"');

        addCommonConfiguration(yargs);
      })
      .command("list", "Lists the apps associated with your account", (yargs: yargs.Argv) => appList("list", yargs))
      .command("ls", "Lists the apps associated with your account", (yargs: yargs.Argv) => appList("ls", yargs))
      .command("set-public-key", "Set the RSA public key used to verify signed releases for an app", (yargs: yargs.Argv) => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " app set-public-key <appName> <publicKeyPath>")
          .demand(/*count*/ 2, /*max*/ 2)
          .example("app set-public-key MyApp ./public.pem", 'Sets the RSA public key for "MyApp"');

        addCommonConfiguration(yargs);
      })
      .command("transfer", "Transfer the ownership of an app to another account", (yargs: yargs.Argv) => {
        // Required, or the category check below rejects every invocation.
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " app transfer <appName> <email>")
          .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
          .example("app transfer MyApp foo@bar.com", 'Transfers the ownership of app "MyApp" to an account with email "foo@bar.com"');

        addCommonConfiguration(yargs);
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("collaborator", "View and manage app collaborators", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " collaborator <command>")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments.
      .command("add", "Add a new collaborator to an app", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " collaborator add <appName> <email>")
          .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
          .example("collaborator add MyApp foo@bar.com", 'Adds foo@bar.com as a collaborator to app "MyApp"');

        addCommonConfiguration(yargs);
      })
      .command("remove", "Remove a collaborator from an app", (yargs: yargs.Argv) => removeCollaborator("remove", yargs))
      .command("rm", "Remove a collaborator from an app", (yargs: yargs.Argv) => removeCollaborator("rm", yargs))
      .command("list", "List the collaborators for an app", (yargs: yargs.Argv) => listCollaborators("list", yargs))
      .command("ls", "List the collaborators for an app", (yargs: yargs.Argv) => listCollaborators("ls", yargs))
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("debug", "View the DeployPulse debug logs for a running app", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    isValidCommand = true;
    yargs
      .usage(USAGE_PREFIX + " debug <platform>")
      .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option arguments
      .example("debug android", "View the CodePush debug logs for an Android emulator or device")
      .example("debug ios", "View the CodePush debug logs for the iOS simulator");

    addCommonConfiguration(yargs);
  })
  .command("deployment", "View and manage your app deployments", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " deployment <command>")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments.
      .command("add", "Add a new deployment to an app", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " deployment add <appName> <deploymentName>")
          .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
          .example("deployment add MyApp MyDeployment", 'Adds deployment "MyDeployment" to app "MyApp"');

        addCommonConfiguration(yargs);
      })
      .command("clear", "Clear the release history associated with a deployment", (yargs: yargs.Argv) =>
        deploymentHistoryClear("clear", yargs)
      )
      .command("remove", "Remove a deployment from an app", (yargs: yargs.Argv) => deploymentRemove("remove", yargs))
      .command("rm", "Remove a deployment from an app", (yargs: yargs.Argv) => deploymentRemove("rm", yargs))
      .command("rename", "Rename an existing deployment", (yargs: yargs.Argv) => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " deployment rename <appName> <currentDeploymentName> <newDeploymentName>")
          .demand(/*count*/ 3, /*max*/ 3) // Require exactly three non-option arguments
          .example(
            "deployment rename MyApp CurrentDeploymentName NewDeploymentName",
            'Renames deployment "CurrentDeploymentName" to "NewDeploymentName"'
          );

        addCommonConfiguration(yargs);
      })
      .command("list", "List the deployments associated with an app", (yargs: yargs.Argv) => deploymentList("list", yargs))
      .command("ls", "List the deployments associated with an app", (yargs: yargs.Argv) => deploymentList("ls", yargs))
      .command("errors", "Show failed updates reported by devices for a deployment", (yargs: yargs.Argv) => deploymentErrors("errors", yargs))
      .command("history", "Display the release history for a deployment", (yargs: yargs.Argv) => deploymentHistory("history", yargs))
      .command("h", "Display the release history for a deployment", (yargs: yargs.Argv) => deploymentHistory("h", yargs))
      .command("auto-rollback", "Manage auto-rollback configuration for a deployment", (yargs: yargs.Argv) => {
        isValidCommandCategory = true;
        yargs
          .usage(USAGE_PREFIX + " deployment auto-rollback <command>")
          .demand(/*count*/ 1, /*max*/ 1)
          .command("get", "Get the auto-rollback configuration for a deployment", (yargs: yargs.Argv): void => {
            isValidCommand = true;
            yargs
              .usage(USAGE_PREFIX + " deployment auto-rollback get <appName> <deploymentName>")
              .demand(/*count*/ 2, /*max*/ 2)
              .example("deployment auto-rollback get MyApp Production", 'Gets auto-rollback config for the "Production" deployment');

            addCommonConfiguration(yargs);
          })
          .command("enable", "Enable auto-rollback for a deployment", (yargs: yargs.Argv): void => {
            isValidCommand = true;
            yargs
              .usage(USAGE_PREFIX + " deployment auto-rollback enable <appName> <deploymentName>")
              .demand(/*count*/ 2, /*max*/ 2)
              .option("errorRate", {
                alias: "e",
                default: 5,
                demand: false,
                description: "Error rate percentage threshold that triggers an automatic rollback (1-100)",
                type: "number",
              })
              .option("minDevices", {
                alias: "m",
                default: 10,
                demand: false,
                description: "Minimum number of devices that must have reported before auto-rollback can trigger",
                type: "number",
              })
              .example(
                "deployment auto-rollback enable MyApp Production --errorRate 10 --minDevices 50",
                'Enables auto-rollback on "Production" with a 10% error rate threshold and 50 device minimum'
              );

            addCommonConfiguration(yargs);
          })
          .command("disable", "Disable auto-rollback for a deployment", (yargs: yargs.Argv): void => {
            isValidCommand = true;
            yargs
              .usage(USAGE_PREFIX + " deployment auto-rollback disable <appName> <deploymentName>")
              .demand(/*count*/ 2, /*max*/ 2)
              .example("deployment auto-rollback disable MyApp Production", 'Disables auto-rollback for the "Production" deployment');

            addCommonConfiguration(yargs);
          })
          .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand);

        addCommonConfiguration(yargs);
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("login", "Authenticate with the DeployPulse API in order to begin managing your apps", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    isValidCommand = true;
    yargs
      .usage(USAGE_PREFIX + " login [options]")
      .demand(/*count*/ 0, /*max*/ 1) //set 'max' to one to allow usage of serverUrl undocument parameter for testing
      .example("login", "Logs in to the DeployPulse API")
      .example("login --accessKey mykey", 'Logs in on behalf of the user who owns and created the access key "mykey"')
      .option("accessKey", {
        alias: "key",
        default: null,
        demand: false,
        description:
          "Access key to authenticate against the DeployPulse API with, instead of providing your username and password credentials",
        type: "string",
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("logout", "Log out of the current session", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    isValidCommand = true;
    yargs
      .usage(USAGE_PREFIX + " logout")
      .demand(/*count*/ 0, /*max*/ 0)
      .example("logout", "Logs out and ends your current session");
    addCommonConfiguration(yargs);
  })
  .command("bundle-react", "Bundle a React Native update into a .zip for manual upload", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " bundle-react <platform> [options]")
      .demand(/*count*/ 1, /*max*/ 1)
      .example("bundle-react ios", 'Bundles the React Native iOS project in the current working directory → ./bundle.zip')
      .example("bundle-react android --output release.zip", "Bundles Android and writes to release.zip")
      .example("bundle-react ios -k ./private.pem --output signed.zip", "Bundles iOS with code signing")
      .option("bundleName", {
        alias: "b",
        default: null,
        demand: false,
        description: 'Name of the generated JS bundle file. Defaults to "main.jsbundle" (iOS) or "index.<platform>.bundle"',
        type: "string",
      })
      .option("development", {
        alias: "dev",
        default: false,
        demand: false,
        description: "Specifies whether to generate a dev or release build",
        type: "boolean",
      })
      .option("entryFile", {
        alias: "e",
        default: null,
        demand: false,
        description: 'Path to the app\'s entry Javascript file. Defaults to "index.<platform>.js" then "index.js"',
        type: "string",
      })
      .option("sourcemapOutput", {
        alias: "s",
        default: null,
        demand: false,
        description: "Path to write the sourcemap. If omitted, no sourcemap is generated.",
        type: "string",
      })
      .option("outputDir", {
        alias: "o",
        default: null,
        demand: false,
        description: "Directory to keep intermediate bundle files after zipping. If omitted, a temp dir is used and cleaned up.",
        type: "string",
      })
      .option("output", {
        default: "bundle.zip",
        demand: false,
        description: "Destination path for the final .zip file (default: bundle.zip)",
        type: "string",
      })
      .option("useHermes", {
        demand: false,
        description:
          "Compile the JS bundle to Hermes bytecode before zipping, bypassing automatic detection. Pass --no-useHermes to skip Hermes even when the project enables it.",
        type: "boolean",
      })
      .option("extraHermesFlags", {
        alias: "hf",
        default: [],
        demand: false,
        description: "Flags to pass to the Hermes bytecode compiler. Can be specified multiple times.",
        type: "array",
      })
      .option("podFile", {
        alias: "pod",
        default: null,
        demand: false,
        description: "Path to the CocoaPods config file (iOS only), used to auto-detect whether Hermes is enabled. Ignored if --useHermes is specified.",
        type: "string",
      })
      .option("privateKey", {
        // `privateKeyPath` / `private-key-path` are what upstream code-push called this and what older
        // docs still show; accepted so a migrated script does not hard-fail under strictOptions.
        alias: ["private-key", "privateKeyPath", "private-key-path", "k"],
        default: null,
        demand: false,
        description: "RSA private key for code signing: either a file path (./private.pem) or inline PEM content",
        type: "string",
      });

    addCommonConfiguration(yargs);
  })
  .command("release-expo", "Release an Expo Updates update to an app deployment", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " release-expo <appName> [options]")
      .demand(/*count*/ 1, /*max*/ 1) // Require exactly one non-option argument
      .example(
        "release-expo MyApp",
        'Exports iOS and Android with "npx expo export" and releases both to the "preview" channel of "MyApp"'
      )
      .example("release-expo MyApp -d production --platform ios", 'Releases only iOS to the "production" channel')
      .example(
        "release-expo MyApp -d production --rollout 10%",
        'Releases to 10% of devices on the "production" channel. Raise it later with "patch MyApp production --rollout 50%"'
      )
      .example(
        "release-expo MyApp --exportDir ./dist --runtimeVersion 1.0.2",
        "Releases an export built earlier, for example in a previous CI step"
      )
      .option("deploymentName", {
        alias: ["d", "deployment"],
        // Expo apps have channels named after the eas.json profiles (development, preview, production), not
        // CodePush's Staging/Production. Defaulting to preview keeps the CodePush habit of never shipping to
        // production by accident, on a channel every Expo app actually has.
        default: "preview",
        demand: false,
        description: "Channel to release the update to (development, preview or production by default)",
        type: "string",
      })
      .option("platform", {
        alias: "p",
        choices: ["ios", "android"],
        demand: false,
        description: "Release only this platform. Omit to release iOS and Android",
        type: "string",
      })
      .option("runtimeVersion", {
        alias: "r",
        demand: false,
        description: "Runtime version to target. Omit to resolve it per platform from your app config, the same way expo-updates does",
        type: "string",
      })
      .option("description", {
        alias: "des",
        default: null,
        demand: false,
        description: "Description of the changes made to the app with this release",
        type: "string",
      })
      .option("exportDir", {
        demand: false,
        description: 'Folder written by "npx expo export" to release instead of exporting. dpctl never deletes it',
        type: "string",
      })
      .option("metadata", {
        default: null,
        demand: false,
        description: "Extra metadata to attach to the release, as a JSON string",
        type: "string",
      })
      // No -r alias: on this command -r is --runtimeVersion.
      .option("rollout", {
        demand: false,
        description: "Percentage of devices this release should be available to. Omit to release to every device",
        type: "string",
      })
      .check((argv: any): any => {
        if (!isValidRollout(argv)) {
          throw new Error("--rollout must be a whole percentage from 1 to 100, e.g. 25 or 25%");
        }
        if (argv.metadata) {
          try {
            JSON.parse(argv.metadata);
          } catch {
            throw new Error("--metadata must be valid JSON");
          }
        }
        return true;
      });

    addCommonConfiguration(yargs);
  })
  .command("rollback", "Rollback the latest release for an app deployment", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " rollback <appName> <deploymentName> [options]")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
      .example("rollback MyApp Production", 'Performs a rollback on the "Production" deployment of "MyApp"')
      .example(
        "rollback MyApp Production --targetRelease v4",
        'Performs a rollback on the "Production" deployment of "MyApp" to the v4 release'
      )
      .example(
        "rollback MyApp production --toEmbedded",
        'Expo Updates: sends devices on the "production" channel back to the bundle in the store binary'
      )
      .option("targetRelease", {
        alias: "r",
        default: null,
        demand: false,
        description:
          "Label of the release to roll the specified deployment back to (e.g. v4). If omitted, the deployment will roll back to the previous release.",
        type: "string",
      })
      .option("platform", {
        alias: "p",
        choices: ["ios", "android"],
        demand: false,
        description: "Expo Updates apps only: roll back only this platform. Omit to roll back both",
        type: "string",
      })
      .option("runtimeVersion", {
        demand: false,
        description: "Expo Updates apps only: roll back only this runtime version. Omit to roll back every runtime version the channel serves",
        type: "string",
      })
      .option("toEmbedded", {
        default: false,
        demand: false,
        description:
          "Expo Updates apps only: send devices back to the bundle built into the store binary, instead of to the previous release",
        type: "boolean",
      });

    addCommonConfiguration(yargs);
  })
  .command("org", "View and switch the organization your commands run against", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " org <command>")
      .demand(/*count*/ 2, /*max*/ 3)
      .command("list", "List the organizations you belong to", (yargs: yargs.Argv) => orgList("list", yargs))
      .command("ls", "List the organizations you belong to", (yargs: yargs.Argv) => orgList("ls", yargs))
      .command("use", "Run later commands against an organization", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " org use <organization>")
          .demand(/*count*/ 1, /*max*/ 1) // The organization; the category counts the words before it.
          .example("org use acme", "Run later commands against the acme organization")
          .example("org use " + chalk.cyan("<id>"), "The same, by organization id");
        addCommonConfiguration(yargs);
      })
      .command("clear", "Go back to running commands against your personal account", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs.usage(USAGE_PREFIX + " org clear").demand(/*count*/ 0, /*max*/ 0);
        addCommonConfiguration(yargs);
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand);

    addCommonConfiguration(yargs);
  })
  .command("patch", "Update the metadata for an existing release", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " patch <appName> <deploymentName> [options]")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
      .example(
        'patch MyApp Production --des "Updated description" -r 50%',
        'Updates the description of the latest release for "MyApp" app\'s "Production" deployment and updates the rollout value to 50%'
      )
      .example(
        'patch MyApp Production -l v3 --des "Updated description for v3"',
        'Updates the description of the release with label v3 for "MyApp" app\'s "Production" deployment'
      )
      .option("label", {
        alias: "l",
        default: null,
        demand: false,
        description: "Label of the release to update. Defaults to the latest release within the specified deployment",
        type: "string",
      })
      .option("description", {
        alias: "des",
        default: null,
        demand: false,
        description: "Description of the changes made to the app with this release",
        type: "string",
      })
      .option("disabled", {
        alias: "x",
        default: null,
        demand: false,
        description: "Specifies whether this release should be immediately downloadable",
        type: "boolean",
      })
      .option("mandatory", {
        alias: "m",
        default: null,
        demand: false,
        description: "Specifies whether this release should be considered mandatory",
        type: "boolean",
      })
      .option("rollout", {
        alias: "r",
        demand: false,
        description:
          "Percentage of users this release should be immediately available to. This attribute can only be increased from the current value.",
        type: "string",
      })
      .option("targetBinaryVersion", {
        alias: "t",
        default: null,
        demand: false,
        description: "Semver expression that specifies the binary app version(s) this release is targeting (e.g. 1.1.0, ~1.2.3).",
        type: "string",
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => {
        if (!isValidRollout(argv)) {
          throw new Error("--rollout must be a whole percentage from 1 to 100, e.g. 25 or 25%");
        }
        return true;
      });

    addCommonConfiguration(yargs);
  })
  .command("promote", "Promote the latest release from one app deployment to another", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " promote <appName> <sourceDeploymentName> <destDeploymentName> [options]")
      .demand(/*count*/ 3, /*max*/ 3) // Require exactly three non-option arguments
      .example(
        "promote MyApp Staging Production",
        'Promotes the latest release within the "Staging" deployment of "MyApp" to "Production"'
      )
      .example(
        'promote MyApp Staging Production --des "Production rollout" -r 25',
        'Promotes the latest release within the "Staging" deployment of "MyApp" to "Production", with an updated description, and targeting only 25% of the users'
      )
      .option("description", {
        alias: "des",
        default: null,
        demand: false,
        description:
          "Description of the changes made to the app with this release. If omitted, the description from the release being promoted will be used.",
        type: "string",
      })
      .option("label", {
        alias: "l",
        default: null,
        demand: false,
        description: "Label of the source release that will be taken. If omitted, the latest release being promoted will be used.",
        type: "string",
      })
      .option("disabled", {
        alias: "x",
        default: null,
        demand: false,
        description:
          "Specifies whether this release should be immediately downloadable. If omitted, the disabled attribute from the release being promoted will be used.",
        type: "boolean",
      })
      .option("mandatory", {
        alias: "m",
        default: null,
        demand: false,
        description:
          "Specifies whether this release should be considered mandatory. If omitted, the mandatory property from the release being promoted will be used.",
        type: "boolean",
      })
      .option("noDuplicateReleaseError", {
        default: false,
        demand: false,
        description:
          "When this flag is set, promoting a package that is identical to the latest release on the target deployment will produce a warning instead of an error",
        type: "boolean",
      })
      .option("rollout", {
        alias: "r",
        default: "100%",
        demand: false,
        description: "Percentage of users this update should be immediately available to",
        type: "string",
      })
      .option("targetBinaryVersion", {
        alias: "t",
        default: null,
        demand: false,
        description:
          "Semver expression that specifies the binary app version(s) this release is targeting (e.g. 1.1.0, ~1.2.3). If omitted, the target binary version property from the release being promoted will be used.",
        type: "string",
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => {
        if (!isValidRollout(argv)) {
          throw new Error("--rollout must be a whole percentage from 1 to 100, e.g. 25 or 25%");
        }
        return true;
      });

    addCommonConfiguration(yargs);
  })
  .command("release", "Release an update to an app deployment", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " release <appName> <updateContentsPath> <targetBinaryVersion> [options]")
      .demand(/*count*/ 3, /*max*/ 3) // Require exactly three non-option arguments.
      .example(
        'release MyApp app.js "*"',
        'Releases the "app.js" file to the "MyApp" app\'s "Staging" deployment, targeting any binary version using the "*" wildcard range syntax.'
      )
      .example(
        "release MyApp ./platforms/ios/www 1.0.3 -d Production",
        'Releases the "./platforms/ios/www" folder and all its contents to the "MyApp" app\'s "Production" deployment, targeting only the 1.0.3 binary version'
      )
      .example(
        "release MyApp ./platforms/ios/www 1.0.3 -d Production -r 20",
        'Releases the "./platforms/ios/www" folder and all its contents to the "MyApp" app\'s "Production" deployment, targeting the 1.0.3 binary version and rolling out to about 20% of the users'
      )
      .option("deploymentName", {
        // "deployment" is an alias because the docs used it for a long time while yargs silently
        // swallowed it and released to Staging. All three spellings, so no pipeline breaks on strict mode.
        alias: ["d", "deployment"],
        default: "Staging",
        demand: false,
        description: "Deployment to release the update to",
        type: "string",
      })
      .option("description", {
        alias: "des",
        default: null,
        demand: false,
        description: "Description of the changes made to the app in this release",
        type: "string",
      })
      .option("disabled", {
        alias: "x",
        default: false,
        demand: false,
        description: "Specifies whether this release should be immediately downloadable",
        type: "boolean",
      })
      .option("mandatory", {
        alias: "m",
        default: false,
        demand: false,
        description: "Specifies whether this release should be considered mandatory",
        type: "boolean",
      })
      .option("noDuplicateReleaseError", {
        default: false,
        demand: false,
        description:
          "When this flag is set, releasing a package that is identical to the latest release will produce a warning instead of an error",
        type: "boolean",
      })
      .option("rollout", {
        alias: "r",
        default: "100%",
        demand: false,
        description: "Percentage of users this release should be available to",
        type: "string",
      })
      .option("privateKey", {
        // `privateKeyPath` / `private-key-path` are what upstream code-push called this and what older
        // docs still show; accepted so a migrated script does not hard-fail under strictOptions.
        alias: ["private-key", "privateKeyPath", "private-key-path", "k"],
        default: null,
        demand: false,
        description: "RSA private key for code signing: either a file path (./private.pem) or inline PEM content",
        type: "string",
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => {
        if (!isValidRollout(argv)) {
          throw new Error("--rollout must be a whole percentage from 1 to 100, e.g. 25 or 25%");
        }
        if (!argv["deploymentName"]) {
          throw new Error("--deploymentName needs a value, e.g. --deploymentName Staging");
        }
        return true;
      });

    addCommonConfiguration(yargs);
  })
  .command("release-react", "Release a React Native update to an app deployment", (yargs: yargs.Argv) => {
    yargs
      .usage(USAGE_PREFIX + " release-react <appName> <platform> [options]")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments
      .example(
        "release-react MyApp ios",
        'Releases the React Native iOS project in the current working directory to the "MyApp" app\'s "Staging" deployment'
      )
      .example(
        "release-react MyApp android -d Production",
        'Releases the React Native Android project in the current working directory to the "MyApp" app\'s "Production" deployment'
      )
      .example(
        "release-react MyApp windows --dev",
        'Releases the development bundle of the React Native Windows project in the current working directory to the "MyApp" app\'s "Staging" deployment'
      )
      .option("bundleName", {
        alias: "b",
        default: null,
        demand: false,
        description:
          'Name of the generated JS bundle file. If unspecified, the standard bundle name will be used, depending on the specified platform: "main.jsbundle" (iOS), "index.android.bundle" (Android) or "index.windows.bundle" (Windows)',
        type: "string",
      })
      .option("deploymentName", {
        // "deployment" is an alias because the docs used it for a long time while yargs silently
        // swallowed it and released to Staging. All three spellings, so no pipeline breaks on strict mode.
        alias: ["d", "deployment"],
        default: "Staging",
        demand: false,
        description: "Deployment to release the update to",
        type: "string",
      })
      .option("description", {
        alias: "des",
        default: null,
        demand: false,
        description: "Description of the changes made to the app with this release",
        type: "string",
      })
      .option("development", {
        alias: "dev",
        default: false,
        demand: false,
        description: "Specifies whether to generate a dev or release build",
        type: "boolean",
      })
      .option("disabled", {
        alias: "x",
        default: false,
        demand: false,
        description: "Specifies whether this release should be immediately downloadable",
        type: "boolean",
      })
      .option("entryFile", {
        alias: "e",
        default: null,
        demand: false,
        description:
          'Path to the app\'s entry Javascript file. If omitted, "index.<platform>.js" and then "index.js" will be used (if they exist)',
        type: "string",
      })
      .option("useHermes", {
        demand: false,
        description:
          "Compile the JS bundle to Hermes bytecode before release, bypassing automatic detection. Pass --no-useHermes to skip Hermes even when the project enables it.",
        type: "boolean",
      })
      .option("extraHermesFlags", {
        alias: "hf",
        default: [],
        demand: false,
        description: "Flags to pass to the Hermes bytecode compiler. Can be specified multiple times.",
        type: "array",
      })
      .option("podFile", {
        alias: "pod",
        default: null,
        demand: false,
        description: "Path to the CocoaPods config file (iOS only), used to auto-detect whether Hermes is enabled. Ignored if --useHermes is specified.",
        type: "string",
      })
      .option("gradleFile", {
        alias: "g",
        default: null,
        demand: false,
        description: "Path to the gradle file which specifies the binary version you want to target this release at (android only).",
      })
      .option("mandatory", {
        alias: "m",
        default: false,
        demand: false,
        description: "Specifies whether this release should be considered mandatory",
        type: "boolean",
      })
      .option("noDuplicateReleaseError", {
        default: false,
        demand: false,
        description:
          "When this flag is set, releasing a package that is identical to the latest release will produce a warning instead of an error",
        type: "boolean",
      })
      .option("plistFile", {
        alias: "p",
        default: null,
        demand: false,
        description: "Path to the plist file which specifies the binary version you want to target this release at (iOS only).",
      })
      .option("plistFilePrefix", {
        alias: "pre",
        default: null,
        demand: false,
        description: "Prefix to append to the file name when attempting to find your app's Info.plist file (iOS only).",
      })
      .option("rollout", {
        alias: "r",
        default: "100%",
        demand: false,
        description: "Percentage of users this release should be immediately available to",
        type: "string",
      })
      .option("sourcemapOutput", {
        alias: "s",
        default: null,
        demand: false,
        description:
          "Path to where the sourcemap for the resulting bundle should be written. If omitted, a sourcemap will not be generated.",
        type: "string",
      })
      .option("targetBinaryVersion", {
        alias: "t",
        default: null,
        demand: false,
        description:
          'Semver expression that specifies the binary app version(s) this release is targeting (e.g. 1.1.0, ~1.2.3). If omitted, the release will target the exact version specified in the "Info.plist" (iOS), "build.gradle" (Android) or "Package.appxmanifest" (Windows) files.',
        type: "string",
      })
      .option("outputDir", {
        alias: "o",
        default: null,
        demand: false,
        description:
          "Path to where the bundle and sourcemap should be written. If omitted, a bundle and sourcemap will not be written.",
        type: "string",
      })
      .option("privateKey", {
        // `privateKeyPath` / `private-key-path` are what upstream code-push called this and what older
        // docs still show; accepted so a migrated script does not hard-fail under strictOptions.
        alias: ["private-key", "privateKeyPath", "private-key-path", "k"],
        default: null,
        demand: false,
        description: "RSA private key for code signing: either a file path (./private.pem) or inline PEM content",
        type: "string",
      })
      .check((argv: any, aliases: { [aliases: string]: string }): any => {
        if (!isValidRollout(argv)) {
          throw new Error("--rollout must be a whole percentage from 1 to 100, e.g. 25 or 25%");
        }
        if (!argv["deploymentName"]) {
          throw new Error("--deploymentName needs a value, e.g. --deploymentName Staging");
        }
        return true;
      });

    addCommonConfiguration(yargs);
  })
  .command("webhook", "View and manage webhooks for your account", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " webhook <command>")
      .demand(/*count*/ 2, /*max*/ 2)
      .command("list", "List all webhooks for your account", (yargs: yargs.Argv): void => webhookList("list", yargs))
      .command("ls", "List all webhooks for your account", (yargs: yargs.Argv): void => webhookList("ls", yargs))
      .command("add", "Add a new webhook to your account", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " webhook add <url> [options]")
          .demand(/*count*/ 1, /*max*/ 1) // The url; the category counts the words before it.
          .example("webhook add https://example.com/hook --events Upload,Rollback", "Add a webhook that fires on uploads and rollbacks")
          .option("name", {
            alias: "n",
            default: null,
            demand: false,
            description: "Friendly name for the webhook",
            type: "string",
          })
          .option("events", {
            alias: "e",
            default: null,
            demand: false,
            description: "Comma-separated list of events to subscribe to. If omitted, all events are sent.",
            type: "string",
          })
          .option("secret", {
            alias: "s",
            default: null,
            demand: false,
            description: "HMAC signing secret for payload verification",
            type: "string",
          })
          .option("disabled", {
            alias: "x",
            default: false,
            demand: false,
            description: "Create the webhook in a disabled state",
            type: "boolean",
          });
        addCommonConfiguration(yargs);
      })
      .command("update", "Update an existing webhook", (yargs: yargs.Argv): void => {
        isValidCommand = true;
        yargs
          .usage(USAGE_PREFIX + " webhook update <id> [options]")
          .demand(/*count*/ 1, /*max*/ 1) // The id; the category counts the words before it.
          .example("webhook update abc-123 --disabled", "Disable an existing webhook")
          .option("url", {
            alias: "u",
            default: null,
            demand: false,
            description: "New URL for the webhook",
            type: "string",
          })
          .option("name", {
            alias: "n",
            default: null,
            demand: false,
            description: "New friendly name",
            type: "string",
          })
          .option("events", {
            alias: "e",
            default: null,
            demand: false,
            description: "Comma-separated list of events, or empty string to receive all events",
            type: "string",
          })
          .option("secret", {
            alias: "s",
            default: null,
            demand: false,
            description: "New HMAC signing secret",
            type: "string",
          })
          .option("enabled", {
            default: null,
            demand: false,
            description: "Enable or disable the webhook (--enabled / --no-enabled)",
            type: "boolean",
          })
          // `webhook add` takes --disabled, so update takes it too rather than making people discover
          // that the same idea is spelled --no-enabled here.
          .option("disabled", {
            alias: "x",
            default: null,
            demand: false,
            description: "Disable the webhook. The same as --no-enabled",
            type: "boolean",
          })
          .check((argv: any): any => {
            if (argv.enabled !== null && argv.enabled !== undefined && argv.disabled !== null && argv.disabled !== undefined) {
              throw new Error("Pass --enabled or --disabled, not both.");
            }
            return true;
          });
        addCommonConfiguration(yargs);
      })
      .command("remove", "Remove a webhook", (yargs: yargs.Argv): void => webhookRemove("remove", yargs))
      .command("rm", "Remove a webhook", (yargs: yargs.Argv): void => webhookRemove("rm", yargs))
      .check((argv: any): any => isValidCommand);

    addCommonConfiguration(yargs);
  })
  .command("session", "View and manage the current login sessions associated with your account", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    yargs
      .usage(USAGE_PREFIX + " session <command>")
      .demand(/*count*/ 2, /*max*/ 2) // Require exactly two non-option arguments.
      .command("remove", "Remove an existing login session", (yargs: yargs.Argv) => sessionRemove("remove", yargs))
      .command("rm", "Remove an existing login session", (yargs: yargs.Argv) => sessionRemove("rm", yargs))
      .command("list", "List the current login sessions associated with your account", (yargs: yargs.Argv) =>
        sessionList("list", yargs)
      )
      .command("ls", "List the current login sessions associated with your account", (yargs: yargs.Argv) => sessionList("ls", yargs))
      .check((argv: any, aliases: { [aliases: string]: string }): any => isValidCommand); // Report unrecognized, non-hyphenated command category.

    addCommonConfiguration(yargs);
  })
  .command("whoami", "Display the account info for the current login session", (yargs: yargs.Argv) => {
    isValidCommandCategory = true;
    isValidCommand = true;
    yargs
      .usage(USAGE_PREFIX + " whoami")
      .demand(/*count*/ 0, /*max*/ 0)
      .example("whoami", "Display the account info for the current login session");
    addCommonConfiguration(yargs);
  })
  // Without this yargs falls back to $0 and prints the entry file, so every subcommand listing read
  // "cli.js app add" instead of "dpctl app add".
  .scriptName("dpctl")
  .alias("v", "version")
  // -h is help, the way it is in every other CLI. Declared explicitly so no option can claim it later.
  .alias("h", "help")
  .version(packageJson.version)
  .wrap(/*columnLimit*/ null)
  // Same treatment as the per-command handler above: say what was wrong, then show help without the
  // banner. This used to print the banner and throw `msg` away, so `dpctl --badflag` answered a typo with
  // six lines of ASCII art and no explanation. The greeting for a bare `dpctl` comes from cli.ts, not here.
  .fail((msg: string) => {
    // A bare `dpctl` also lands here (yargs demands a command), and that is not a mistake to report: it
    // gets the greeting. Anything else typed something wrong and wants the reason, not the banner.
    const typedSomething = process.argv.slice(2).length > 0;
    if (typedSomething && msg && msg !== lastFailMessage) {
      lastFailMessage = msg;
      console.error(chalk.red(`[Error]  ${msg}`));
    }
    showHelp(/*showRootDescription*/ !typedSomething);
  }).argv;

export function createCommand(): cli.ICommand {
  let cmd: cli.ICommand;

  const argv = yargs.parseSync();

  if (!wasHelpShown && argv._ && argv._.length > 0) {
    // Create a command object
    const arg0: any = argv._[0];
    const arg1: any = argv._[1];
    const arg2: any = argv._[2];
    const arg3: any = argv._[3];
    const arg4: any = argv._[4];

    switch (arg0) {
      case "access-key":
        switch (arg1) {
          case "add":
            if (arg2) {
              cmd = { type: cli.CommandType.accessKeyAdd };
              const accessKeyAddCmd = <cli.IAccessKeyAddCommand>cmd;
              accessKeyAddCmd.name = arg2;
              const ttlOption: string = argv["ttl"] as any;
              if (isDefined(ttlOption)) {
                accessKeyAddCmd.ttl = parseDurationMilliseconds(ttlOption);
              }
              const scopeOption: string = argv["scope"] as any;
              if (isDefined(scopeOption)) {
                accessKeyAddCmd.scopes = [scopeOption];
              }
              const appOption: any = argv["app"];
              if (isDefined(appOption)) {
                accessKeyAddCmd.appNames = (Array.isArray(appOption) ? appOption : [appOption]).map(String);
              }
            }
            break;

          case "patch":
            if (arg2) {
              cmd = { type: cli.CommandType.accessKeyPatch };
              const accessKeyPatchCmd = <cli.IAccessKeyPatchCommand>cmd;
              accessKeyPatchCmd.oldName = arg2;

              const newNameOption: string = argv["name"] as any;
              const ttlOption: string = argv["ttl"] as any;
              if (isDefined(newNameOption)) {
                accessKeyPatchCmd.newName = newNameOption;
              }

              if (isDefined(ttlOption)) {
                accessKeyPatchCmd.ttl = parseDurationMilliseconds(ttlOption);
              }
            }
            break;

          case "list":
          case "ls":
            cmd = { type: cli.CommandType.accessKeyList };

            (<cli.IAccessKeyListCommand>cmd).format = argv["format"] as any;
            break;

          case "remove":
          case "rm":
            if (arg2) {
              cmd = { type: cli.CommandType.accessKeyRemove };

              (<cli.IAccessKeyRemoveCommand>cmd).accessKey = arg2;
            }
            break;
        }
        break;

      case "app":
        switch (arg1) {
          case "add":
            if (arg2) {
              cmd = { type: cli.CommandType.appAdd };

              const appAddCommand = <cli.IAppAddCommand>cmd;
              appAddCommand.appName = arg2;
              appAddCommand.platform = argv["platform"] as any;
            }
            break;

          case "list":
          case "ls":
            cmd = { type: cli.CommandType.appList };

            (<cli.IAppListCommand>cmd).format = argv["format"] as any;
            break;

          case "remove":
          case "rm":
            if (arg2) {
              cmd = { type: cli.CommandType.appRemove };

              (<cli.IAppRemoveCommand>cmd).appName = arg2;
            }
            break;

          case "rename":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.appRename };

              const appRenameCommand = <cli.IAppRenameCommand>cmd;

              appRenameCommand.currentAppName = arg2;
              appRenameCommand.newAppName = arg3;
            }
            break;

          case "set-public-key":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.appSetPublicKey };

              const appSetPublicKeyCommand = <cli.IAppSetPublicKeyCommand>cmd;

              appSetPublicKeyCommand.appName = arg2;
              appSetPublicKeyCommand.publicKeyPath = arg3;
            }
            break;

          case "transfer":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.appTransfer };

              const appTransferCommand = <cli.IAppTransferCommand>cmd;

              appTransferCommand.appName = arg2;
              appTransferCommand.email = arg3;
            }
            break;
        }
        break;

      case "collaborator":
        switch (arg1) {
          case "add":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.collaboratorAdd };

              (<cli.ICollaboratorAddCommand>cmd).appName = arg2;
              (<cli.ICollaboratorAddCommand>cmd).email = arg3;
            }
            break;

          case "list":
          case "ls":
            if (arg2) {
              cmd = { type: cli.CommandType.collaboratorList };

              (<cli.ICollaboratorListCommand>cmd).appName = arg2;
              (<cli.ICollaboratorListCommand>cmd).format = argv["format"] as any;
            }
            break;

          case "remove":
          case "rm":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.collaboratorRemove };

              (<cli.ICollaboratorRemoveCommand>cmd).appName = arg2;
              (<cli.ICollaboratorAddCommand>cmd).email = arg3;
            }
            break;
        }
        break;

      case "debug":
        cmd = <cli.IDebugCommand>{
          type: cli.CommandType.debug,
          platform: arg1,
        };

        break;

      case "deployment":
        switch (arg1) {
          case "add":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.deploymentAdd };

              const deploymentAddCommand = <cli.IDeploymentAddCommand>cmd;

              deploymentAddCommand.appName = arg2;
              deploymentAddCommand.deploymentName = arg3;
            }
            break;

          case "clear":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.deploymentHistoryClear };

              const deploymentHistoryClearCommand = <cli.IDeploymentHistoryClearCommand>cmd;

              deploymentHistoryClearCommand.appName = arg2;
              deploymentHistoryClearCommand.deploymentName = arg3;
            }
            break;

          case "list":
          case "ls":
            if (arg2) {
              cmd = { type: cli.CommandType.deploymentList };

              const deploymentListCommand = <cli.IDeploymentListCommand>cmd;

              deploymentListCommand.appName = arg2;
              deploymentListCommand.format = argv["format"] as any;
              deploymentListCommand.displayKeys = argv["displayKeys"] as any;
            }
            break;

          case "remove":
          case "rm":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.deploymentRemove };

              const deploymentRemoveCommand = <cli.IDeploymentRemoveCommand>cmd;

              deploymentRemoveCommand.appName = arg2;
              deploymentRemoveCommand.deploymentName = arg3;
            }
            break;

          case "rename":
            if (arg2 && arg3 && arg4) {
              cmd = { type: cli.CommandType.deploymentRename };

              const deploymentRenameCommand = <cli.IDeploymentRenameCommand>cmd;

              deploymentRenameCommand.appName = arg2;
              deploymentRenameCommand.currentDeploymentName = arg3;
              deploymentRenameCommand.newDeploymentName = arg4;
            }
            break;

          case "errors":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.deploymentErrors };

              const deploymentErrorsCommand = <cli.IDeploymentErrorsCommand>cmd;

              deploymentErrorsCommand.appName = arg2;
              deploymentErrorsCommand.deploymentName = arg3;
              deploymentErrorsCommand.format = argv["format"] as any;
              deploymentErrorsCommand.limit = argv["limit"] as any;
            }
            break;

          case "history":
          case "h":
            if (arg2 && arg3) {
              cmd = { type: cli.CommandType.deploymentHistory };

              const deploymentHistoryCommand = <cli.IDeploymentHistoryCommand>cmd;

              deploymentHistoryCommand.appName = arg2;
              deploymentHistoryCommand.deploymentName = arg3;
              deploymentHistoryCommand.format = argv["format"] as any;
              deploymentHistoryCommand.displayAuthor = argv["displayAuthor"] as any;
            }
            break;

          case "auto-rollback":
            switch (arg2) {
              case "get":
                if (arg3 && arg4) {
                  cmd = { type: cli.CommandType.deploymentAutoRollbackGet };

                  const autoRollbackGetCommand = <cli.IDeploymentAutoRollbackGetCommand>cmd;

                  autoRollbackGetCommand.appName = arg3;
                  autoRollbackGetCommand.deploymentName = arg4;
                }
                break;

              case "enable":
                if (arg3 && arg4) {
                  cmd = { type: cli.CommandType.deploymentAutoRollbackEnable };

                  const autoRollbackEnableCommand = <cli.IDeploymentAutoRollbackEnableCommand>cmd;

                  autoRollbackEnableCommand.appName = arg3;
                  autoRollbackEnableCommand.deploymentName = arg4;
                  autoRollbackEnableCommand.errorRate = argv["errorRate"] as any;
                  autoRollbackEnableCommand.minDevices = argv["minDevices"] as any;
                }
                break;

              case "disable":
                if (arg3 && arg4) {
                  cmd = { type: cli.CommandType.deploymentAutoRollbackDisable };

                  const autoRollbackDisableCommand = <cli.IDeploymentAutoRollbackDisableCommand>cmd;

                  autoRollbackDisableCommand.appName = arg3;
                  autoRollbackDisableCommand.deploymentName = arg4;
                }
                break;
            }
            break;
        }
        break;

      case "login":
        cmd = { type: cli.CommandType.login };

        const loginCommand = <cli.ILoginCommand>cmd;

        //loginCommand.serverUrl = getServerUrl(arg1);
        loginCommand.accessKey = argv["accessKey"] as any;
        break;

      case "logout":
        cmd = { type: cli.CommandType.logout };
        break;

      case "org":
        switch (arg1) {
          case "list":
          case "ls":
            cmd = { type: cli.CommandType.orgList };
            (<cli.IOrgListCommand>cmd).format = argv["format"] as any;
            break;

          case "use":
            if (arg2) {
              cmd = { type: cli.CommandType.orgUse };
              (<cli.IOrgUseCommand>cmd).organization = arg2;
            }
            break;

          case "clear":
            cmd = { type: cli.CommandType.orgClear };
            break;
        }
        break;

      case "patch":
        if (arg1 && arg2) {
          cmd = { type: cli.CommandType.patch };

          const patchCommand = <cli.IPatchCommand>cmd;

          patchCommand.appName = arg1;
          patchCommand.deploymentName = arg2;
          patchCommand.label = argv["label"] as any;
          // Description must be set to null to indicate that it is not being patched.
          patchCommand.description = argv["description"] ? backslash(String(argv["description"])) : null;
          patchCommand.disabled = argv["disabled"] as any;
          patchCommand.mandatory = argv["mandatory"] as any;
          patchCommand.rollout = getRolloutValue(argv["rollout"] as any);
          patchCommand.appStoreVersion = argv["targetBinaryVersion"] as any;
        }
        break;

      case "promote":
        if (arg1 && arg2 && arg3) {
          cmd = { type: cli.CommandType.promote };

          const deploymentPromoteCommand = <cli.IPromoteCommand>cmd;

          deploymentPromoteCommand.appName = arg1;
          deploymentPromoteCommand.sourceDeploymentName = arg2;
          deploymentPromoteCommand.destDeploymentName = arg3;
          deploymentPromoteCommand.description = argv["description"] ? backslash(String(argv["description"])) : "";
          deploymentPromoteCommand.label = argv["label"] as any;
          deploymentPromoteCommand.disabled = argv["disabled"] as any;
          deploymentPromoteCommand.mandatory = argv["mandatory"] as any;
          deploymentPromoteCommand.noDuplicateReleaseError = argv["noDuplicateReleaseError"] as any;
          deploymentPromoteCommand.rollout = getRolloutValue(argv["rollout"] as any);
          deploymentPromoteCommand.appStoreVersion = argv["targetBinaryVersion"] as any;
          deploymentPromoteCommand.platform = argv["platform"] ? String(argv["platform"]) : undefined;
        }
        break;

      case "release":
        if (arg1 && arg2 && arg3) {
          cmd = { type: cli.CommandType.release };

          const releaseCommand = <cli.IReleaseCommand>cmd;

          releaseCommand.appName = arg1;
          releaseCommand.package = arg2;
          releaseCommand.appStoreVersion = arg3;
          releaseCommand.deploymentName = argv["deploymentName"] as any;
          releaseCommand.description = argv["description"] ? backslash(String(argv["description"])) : "";
          releaseCommand.disabled = argv["disabled"] as any;
          releaseCommand.mandatory = argv["mandatory"] as any;
          releaseCommand.noDuplicateReleaseError = argv["noDuplicateReleaseError"] as any;
          releaseCommand.rollout = getRolloutValue(argv["rollout"] as any);
          releaseCommand.privateKey = argv["privateKey"] as any;
        }
        break;

      case "bundle-react":
        if (arg1) {
          cmd = { type: cli.CommandType.bundleReact };
          const bundleReactCommand = <cli.IBundleReactCommand>cmd;
          bundleReactCommand.platform = arg1;
          bundleReactCommand.bundleName = argv["bundleName"] as any;
          bundleReactCommand.development = argv["development"] as any;
          bundleReactCommand.entryFile = argv["entryFile"] as any;
          bundleReactCommand.sourcemapOutput = argv["sourcemapOutput"] as any;
          bundleReactCommand.outputDir = argv["outputDir"] as any;
          bundleReactCommand.outputPath = argv["output"] as any;
          bundleReactCommand.privateKey = argv["privateKey"] as any;
          bundleReactCommand.useHermes = argv["useHermes"] as any;
          bundleReactCommand.extraHermesFlags = argv["extraHermesFlags"] as any;
          bundleReactCommand.podFile = argv["podFile"] as any;
        }
        break;

      case "release-expo":
        if (arg1) {
          cmd = { type: cli.CommandType.releaseExpo };

          const releaseExpoCommand = <cli.IReleaseExpoCommand>cmd;

          releaseExpoCommand.appName = arg1;
          releaseExpoCommand.deploymentName = argv["deploymentName"] as any;
          releaseExpoCommand.platform = argv["platform"] ? String(argv["platform"]) : undefined;
          releaseExpoCommand.runtimeVersion = argv["runtimeVersion"] ? String(argv["runtimeVersion"]) : undefined;
          releaseExpoCommand.exportDir = argv["exportDir"] ? String(argv["exportDir"]) : undefined;
          releaseExpoCommand.description = argv["description"] ? backslash(String(argv["description"])) : undefined;
          releaseExpoCommand.metadata = argv["metadata"] as any;
          releaseExpoCommand.rollout = getRolloutValue(argv["rollout"] as any);
        }
        break;

      case "release-react":
        if (arg1 && arg2) {
          cmd = { type: cli.CommandType.releaseReact };

          const releaseReactCommand = <cli.IReleaseReactCommand>cmd;

          releaseReactCommand.appName = arg1;
          releaseReactCommand.platform = arg2;

          releaseReactCommand.appStoreVersion = argv["targetBinaryVersion"] as any;
          releaseReactCommand.bundleName = argv["bundleName"] as any;
          releaseReactCommand.deploymentName = argv["deploymentName"] as any;
          releaseReactCommand.disabled = argv["disabled"] as any;
          releaseReactCommand.description = argv["description"] ? backslash(String(argv["description"])) : "";
          releaseReactCommand.development = argv["development"] as any;
          releaseReactCommand.entryFile = argv["entryFile"] as any;
          releaseReactCommand.gradleFile = argv["gradleFile"] as any;
          releaseReactCommand.mandatory = argv["mandatory"] as any;
          releaseReactCommand.noDuplicateReleaseError = argv["noDuplicateReleaseError"] as any;
          releaseReactCommand.plistFile = argv["plistFile"] as any;
          releaseReactCommand.plistFilePrefix = argv["plistFilePrefix"] as any;
          releaseReactCommand.rollout = getRolloutValue(argv["rollout"] as any);
          releaseReactCommand.sourcemapOutput = argv["sourcemapOutput"] as any;
          releaseReactCommand.outputDir = argv["outputDir"] as any;
          releaseReactCommand.privateKey = argv["privateKey"] as any;
          releaseReactCommand.useHermes = argv["useHermes"] as any;
          releaseReactCommand.extraHermesFlags = argv["extraHermesFlags"] as any;
          releaseReactCommand.podFile = argv["podFile"] as any;
        }
        break;

      case "rollback":
        if (arg1 && arg2) {
          cmd = { type: cli.CommandType.rollback };

          const rollbackCommand = <cli.IRollbackCommand>cmd;

          rollbackCommand.appName = arg1;
          rollbackCommand.deploymentName = arg2;
          rollbackCommand.targetRelease = argv["targetRelease"] as any;
          rollbackCommand.platform = argv["platform"] ? String(argv["platform"]) : undefined;
          rollbackCommand.runtimeVersion = argv["runtimeVersion"] ? String(argv["runtimeVersion"]) : undefined;
          rollbackCommand.toEmbedded = Boolean(argv["toEmbedded"]);
        }
        break;

      case "webhook":
        switch (arg1) {
          case "list":
          case "ls":
            cmd = { type: cli.CommandType.webhookList };
            (<cli.IWebhookListCommand>cmd).format = argv["format"] as any;
            break;

          case "add":
            if (arg2) {
              cmd = { type: cli.CommandType.webhookAdd };

              const webhookAddCommand = <cli.IWebhookAddCommand>cmd;

              webhookAddCommand.url = arg2;
              webhookAddCommand.name = argv["name"] as any;
              webhookAddCommand.events = argv["events"] as any;
              webhookAddCommand.secret = argv["secret"] as any;
              webhookAddCommand.disabled = argv["disabled"] as any;
            }
            break;

          case "update":
            if (arg2) {
              cmd = { type: cli.CommandType.webhookUpdate };

              const webhookUpdateCommand = <cli.IWebhookUpdateCommand>cmd;

              webhookUpdateCommand.id = arg2;
              webhookUpdateCommand.url = argv["url"] as any;
              webhookUpdateCommand.name = argv["name"] as any;
              webhookUpdateCommand.events = argv["events"] as any;
              webhookUpdateCommand.secret = argv["secret"] as any;
              // --disabled is the other way of saying --no-enabled; the check above rejects both at once.
              const disabledFlag: any = argv["disabled"];
              webhookUpdateCommand.enabled = disabledFlag === null || disabledFlag === undefined ? (argv["enabled"] as any) : !disabledFlag;
            }
            break;

          case "remove":
          case "rm":
            if (arg2) {
              cmd = { type: cli.CommandType.webhookRemove };
              (<cli.IWebhookRemoveCommand>cmd).id = arg2;
            }
            break;
        }
        break;

      case "session":
        switch (arg1) {
          case "list":
          case "ls":
            cmd = { type: cli.CommandType.sessionList };

            (<cli.ISessionListCommand>cmd).format = argv["format"] as any;
            break;

          case "remove":
          case "rm":
            if (arg2) {
              cmd = { type: cli.CommandType.sessionRemove };

              (<cli.ISessionRemoveCommand>cmd).machineName = arg2;
            }
            break;
        }
        break;

      case "whoami":
        cmd = { type: cli.CommandType.whoami };
        break;
    }

    // --org applies to every command, so it is read once here rather than in each case above.
    if (cmd && argv["org"]) {
      cmd.org = String(argv["org"]);
    }

    return cmd;
  }
}

function isValidRollout(args: any): boolean {
  const rollout: string = args["rollout"];
  if (rollout && !ROLLOUT_PERCENTAGE_REGEX.test(rollout)) {
    return false;
  }

  return true;
}

function checkValidReleaseOptions(args: any): boolean {
  return isValidRollout(args) && !!args["deploymentName"];
}

function getRolloutValue(input: string): number {
  return input ? parseInt(input.replace("%", "")) : null;
}

function isDefined(object: any): boolean {
  return object !== undefined && object !== null;
}

function parseDurationMilliseconds(durationString: string): number {
  return Math.floor(parse(durationString));
}
