/**
 * The environment to hand a build tool.
 *
 * `release-react` and `release-expo` shell out to Metro, the Expo CLI and the Hermes compiler, all of
 * which execute code from the app's own node_modules: Babel plugins, Metro transformers, Expo config
 * plugins. A child inherits process.env by default, so with `DEPLOYPULSE_ACCESS_KEY` set (the documented
 * way to authenticate in CI) any one of those transitive dependencies could read a full-access key and
 * publish an OTA update to every app in the account. Nothing in a bundler needs the credential.
 *
 * A key read from the session file was never in the environment, so this closes the whole path.
 */
export function envWithoutCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DEPLOYPULSE_ACCESS_KEY;
  return env;
}
