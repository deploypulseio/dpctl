// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Q = require("q");
import superagent = require("superagent");
import * as recursiveFs from "recursive-fs";
import * as yazl from "yazl";
import slash = require("slash");
import { messageFromResponseText } from "./api-errors";

import Promise = Q.Promise;

import {
  AccessKey,
  AccessKeyRequest,
  Account,
  App,
  CodePushError,
  CollaboratorMap,
  Deployment,
  DeploymentError,
  DeploymentErrorsResult,
  DeploymentMetrics,
  Headers,
  Org,
  Package,
  PackageInfo,
  ServerAccessKey,
  Session,
} from "./types";

// Resolves to cli/package.json whether running from compiled output (bin/script/) or ts-node (script/)
const packageJson = require(
  path.resolve(__dirname, path.basename(path.dirname(__dirname)) === "bin" ? "../../package.json" : "../package.json")
);

interface JsonResponse {
  headers: Headers;
  body?: any;
}

interface PackageFile {
  isTemporary: boolean;
  path: string;
}

// Template tag that encodes each interpolated value as a single path segment. A value that is, or
// decodes to, "." or ".." is refused: URL parsing collapses dot segments even when percent-encoded,
// so the request would address the parent resource instead.
function urlEncode(strings: TemplateStringsArray, ...values: unknown[]): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const value = String(values[i]);
      if (isDotSegment(value)) {
        throw new Error(
          `The name "${value}" cannot be used in a request URL, so dpctl cannot address it. Contact support@deploypulse.io to rename or remove it.`
        );
      }
      result += encodeURIComponent(value);
    }
  }

  return result;
}

// Deletes a temporary package. A file that is already gone, or cannot be removed, must not turn a
// finished upload (or the error being reported) into a crash.
function removeQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {}
}

/**
 * How long `releaseExpo` keeps retrying while the server says it is busy (a 503, or a 429 that says when to
 * come back), and how long it waits between tries when the server does not say. A waiting time comes with
 * up to a fifth more at random, so many uploads turned away at once do not all return at once.
 */
const EXPO_BUSY_BUDGET_MS = 5 * 60 * 1000;
const EXPO_BUSY_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
const EXPO_BUSY_GIVE_UP_MESSAGE = "Server busy, try again later.";

/** Retry-After in milliseconds: delay-seconds or an HTTP date. Null when absent or unreadable. */
function retryAfterMs(value: unknown, now: number): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+$/.test(value.trim())) return parseInt(value.trim(), 10) * 1000;
  const date = Date.parse(value);
  return isNaN(date) ? null : Math.max(0, date - now);
}

function isDotSegment(value: string): boolean {
  const candidates = [value.trim()];
  try {
    candidates.push(decodeURIComponent(value).trim());
  } catch (e) {}
  return candidates.some((candidate) => candidate === "." || candidate === "..");
}

class AccountManager {
  public static AppPermission = {
    OWNER: "Owner",
    COLLABORATOR: "Collaborator",
  };
  public static SERVER_URL = "https://api.deploypulse.io";
  public static EXPO_BUSY_GIVE_UP_MESSAGE = EXPO_BUSY_GIVE_UP_MESSAGE;

  private static API_VERSION: number = 2;

  public static ERROR_GATEWAY_TIMEOUT = 504; // Used if there is a network error
  public static ERROR_INTERNAL_SERVER = 500;
  public static ERROR_NOT_FOUND = 404;
  public static ERROR_CONFLICT = 409; // Used if the resource already exists
  public static ERROR_UNAUTHORIZED = 401;

  private _accessKey: string;
  private _orgId: string | null = null;
  // Replaced in tests, so a retry schedule can run without the wait.
  private _clock = {
    now: (): number => Date.now(),
    sleep: (ms: number): Promise<void> => Promise<void>((resolve) => setTimeout(() => resolve(null), ms)),
  };
  private _serverUrl: string;
  private _customHeaders: Headers;

  constructor(accessKey: string, customHeaders?: Headers) {
    if (!accessKey) {
      throw new Error(
        "An access key must be specified. " +
        "Provide it explicitly with the DEPLOYPULSE_ACCESS_KEY environment variable " +
        "or use the dpctl login command."
      );
    }

    this._accessKey = accessKey;
    this._customHeaders = customHeaders;
    this._serverUrl = AccountManager.SERVER_URL;
  }

  public get accessKey(): string {
    return this._accessKey;
  }

  /**
   * `isLogin` marks the call as `dpctl login` (X-DeployPulse-Login: 1); every other caller sends 0. The API
   * records a CLI login in Recent Logins only for a 1. A dpctl that sends no marker at all is an older one,
   * which the API records at most once a day per key, since it cannot tell a login from a release.
   */
  public isAuthenticated(throwIfUnauthorized?: boolean, isLogin?: boolean): Promise<boolean> {
    return Promise<any>((resolve, reject, notify) => {
      const request: superagent.Request<any> = superagent.get(`${this._serverUrl}${urlEncode`/authenticated`}`);
      this.attachCredentials(request);
      request.set("X-DeployPulse-Login", isLogin ? "1" : "0");

      request.end((err: any, res: superagent.Response) => {
        const status: number = this.getErrorStatus(err, res);
        if (err && status !== AccountManager.ERROR_UNAUTHORIZED) {
          reject(this.getCodePushError(err, res));
          return;
        }

        const authenticated: boolean = status === 200;

        if (!authenticated && throwIfUnauthorized) {
          reject(this.getCodePushError(err, res));
          return;
        }

        resolve(authenticated);
      });
    });
  }

  public addAccessKey(friendlyName: string, ttl?: number, scopes?: string[], appIds?: string[]): Promise<AccessKey> {
    if (!friendlyName) {
      throw new Error("A name must be specified when adding an access key.");
    }

    const accessKeyRequest: AccessKeyRequest = {
      createdBy: os.hostname(),
      friendlyName,
      ttl,
    };
    // Absent means full access to all apps.
    if (scopes && scopes.length) accessKeyRequest.scopes = scopes;
    if (appIds && appIds.length) accessKeyRequest.appIds = appIds;

    return this.post(urlEncode`/accessKeys/`, JSON.stringify(accessKeyRequest), /*expectResponseBody=*/ true).then(
      (response: JsonResponse) => {
        return {
          createdTime: response.body.accessKey.createdTime,
          expires: response.body.accessKey.expires,
          key: response.body.accessKey.name,
          name: response.body.accessKey.friendlyName,
        };
      }
    );
  }

  public getAccessKey(accessKeyName: string): Promise<AccessKey> {
    return this.get(urlEncode`/accessKeys/${accessKeyName}`).then((res: JsonResponse) => {
      return {
        createdTime: res.body.accessKey.createdTime,
        expires: res.body.accessKey.expires,
        name: res.body.accessKey.friendlyName,
      };
    });
  }

  // Everything the CLI sends is scoped to this organization while it is set.
  public setOrgId(orgId: string | null): void {
    this._orgId = orgId;
  }

  public getOrgs(): Promise<Org[]> {
    return this.get(urlEncode`/orgs`).then((res: JsonResponse) => res.body.orgs as Org[]);
  }

  // The Expo release endpoint sits beside the manifest routes, not under /apps, and is addressed by
  // deployment key, so callers look the key up first.
  //
  // A busy server (503, or 429 with Retry-After) is retried for up to EXPO_BUSY_BUDGET_MS, waiting as long
  // as Retry-After asks or backing off when it does not; `onBusy` is called before each wait. Past the budget
  // it rejects with EXPO_BUSY_GIVE_UP_MESSAGE. The upload is sent whole each time, which is safe: a busy
  // answer means nothing was released.
  public releaseExpo(
    deploymentKey: string,
    zipFilePath: string,
    platform: string,
    runtimeVersion: string,
    metadata?: object,
    rollout?: number,
    description?: string,
    uploadProgressCallback?: (progress: number) => void,
    appConfig?: object,
    onBusy?: (waitMs: number) => void
  ): Promise<void> {
    const started = this._clock.now();
    const attempt = (tries: number): Promise<void> =>
      this.releaseExpoOnce(deploymentKey, zipFilePath, platform, runtimeVersion, metadata, rollout, description, uploadProgressCallback, appConfig).then(
        (busy: ExpoBusy | null): Promise<void> => {
          if (!busy) return Q<void>(null);
          const backoff = EXPO_BUSY_BACKOFF_MS[Math.min(tries, EXPO_BUSY_BACKOFF_MS.length - 1)];
          const waitMs = busy.retryAfterMs ?? Math.round(backoff * (1 + Math.random() / 5));
          if (this._clock.now() + waitMs - started > EXPO_BUSY_BUDGET_MS) {
            throw <CodePushError>{ message: EXPO_BUSY_GIVE_UP_MESSAGE, statusCode: busy.statusCode };
          }
          if (onBusy) onBusy(waitMs);
          return this._clock.sleep(waitMs).then(() => attempt(tries + 1));
        }
      );
    return attempt(0);
  }

  /** One upload. Resolves null once released, or with how long to wait when the server is busy. */
  private releaseExpoOnce(
    deploymentKey: string,
    zipFilePath: string,
    platform: string,
    runtimeVersion: string,
    metadata?: object,
    rollout?: number,
    description?: string,
    uploadProgressCallback?: (progress: number) => void,
    appConfig?: object
  ): Promise<ExpoBusy | null> {
    const url = this._serverUrl + urlEncode`/expo/v1/${deploymentKey}/release`;
    const releaseInfo = JSON.stringify({
      platform,
      runtimeVersion,
      ...(metadata ? { metadata } : {}),
      ...(rollout ? { rollout } : {}),
      ...(description ? { description } : {}),
    });

    return Promise<ExpoBusy | null>((resolve, reject) => {
      const request: superagent.Request<any> = superagent
        .post(url)
        .attach("bundle", fs.createReadStream(zipFilePath), "bundle.zip")
        .field("releaseInfo", releaseInfo);
      // The app's public config, served to devices as the manifest's extra.expoClient (Constants.expoConfig).
      // Its own field rather than a file in the zip: the server checks and stores it apart from the bundle.
      // An API from before 1.2.2 ignores the field.
      if (appConfig) request.field("appConfig", JSON.stringify(appConfig));

      this.attachCredentials(request);

      request
        .on("progress", (event: any) => {
          if (uploadProgressCallback && event && event.total > 0) {
            uploadProgressCallback((event.loaded / event.total) * 100);
          }
        })
        .end((err: any, res: superagent.Response) => {
          const status = res ? res.status : err && err.status;
          const header = (res && res.header) || (err && err.response && err.response.header) || {};
          const retryAfter = retryAfterMs(header["retry-after"], this._clock.now());
          if (status === 503 || (status === 429 && retryAfter !== null)) {
            resolve({ retryAfterMs: retryAfter, statusCode: status });
            return;
          }
          if (err && !res) {
            reject(this.getCodePushError(err, res));
            return;
          }
          if (!res.ok) {
            reject(expoRouteError(res));
            return;
          }
          resolve(null);
        });
    });
  }

  // Raises every rollout in progress on the channel. Keyed by deployment key, like releaseExpo.
  public patchExpoRollout(
    deploymentKey: string,
    rollout: number
  ): Promise<Array<{ id: string; platform: string; runtimeVersion: string; rollout: number }>> {
    const url = this._serverUrl + urlEncode`/expo/v1/${deploymentKey}/release`;

    return Promise<Array<{ id: string; platform: string; runtimeVersion: string; rollout: number }>>((resolve, reject) => {
      const request: superagent.Request<any> = superagent.patch(url).set("Content-Type", "application/json").send({ rollout });

      this.attachCredentials(request);

      request.end((err: any, res: superagent.Response) => {
        if (err && !res) {
          reject(this.getCodePushError(err, res));
          return;
        }
        if (!res.ok) {
          reject(expoRouteError(res));
          return;
        }
        resolve(res.body?.releases ?? []);
      });
    });
  }

  /**
   * Roll an Expo Updates channel back. Addressed by deployment key, like releaseExpo. Resolves to what was
   * rolled back, one entry per platform and runtime version, and what was skipped and why.
   */
  public rollbackExpo(
    deploymentKey: string,
    options: { platform?: string; runtimeVersion?: string; toEmbedded?: boolean } = {}
  ): Promise<{
    rollbacks: Array<{ platform: string; runtimeVersion: string; mode: string; releaseId: string }>;
    skipped: Array<{ platform: string; runtimeVersion: string; reason: string; failed?: boolean; busy?: boolean }>;
  }> {
    const url = this._serverUrl + urlEncode`/expo/v1/${deploymentKey}/rollback`;
    const body: Record<string, any> = {};
    if (options.platform) body.platform = options.platform;
    if (options.runtimeVersion) body.runtimeVersion = options.runtimeVersion;
    if (options.toEmbedded) body.toEmbedded = true;

    return Promise<{ rollbacks: any[]; skipped: any[] }>((resolve, reject) => {
      const request: superagent.Request<any> = superagent.post(url).set("Content-Type", "application/json").send(body);

      this.attachCredentials(request);

      request.end((err: any, res: superagent.Response) => {
        if (err && !res) {
          reject(this.getCodePushError(err, res));
          return;
        }
        if (!res.ok) {
          reject(expoRouteError(res));
          return;
        }
        resolve({ rollbacks: res.body?.rollbacks ?? [], skipped: res.body?.skipped ?? [] });
      });
    });
  }

  /**
   * Promote an Expo Updates channel's releases onto another channel of the same app. Addressed by the source
   * channel's deployment key, like the other Expo routes; the destination is named, and resolved server-side
   * inside the same app.
   */
  public promoteExpo(
    deploymentKey: string,
    to: string,
    options: { platform?: string; rollout?: number } = {}
  ): Promise<{
    promotions: Array<{ platform: string; runtimeVersion: string; label: string | null }>;
    skipped: Array<{ platform: string; runtimeVersion: string; reason: string; failed?: boolean; busy?: boolean }>;
  }> {
    const url = this._serverUrl + urlEncode`/expo/v1/${deploymentKey}/promote`;
    const body: Record<string, any> = { to };
    if (options.platform) body.platform = options.platform;
    if (options.rollout) body.rollout = options.rollout;

    return Promise<{ promotions: any[]; skipped: any[] }>((resolve, reject) => {
      const request: superagent.Request<any> = superagent.post(url).set("Content-Type", "application/json").send(body);

      this.attachCredentials(request);

      request.end((err: any, res: superagent.Response) => {
        if (err && !res) {
          reject(this.getCodePushError(err, res));
          return;
        }
        if (!res.ok) {
          reject(expoRouteError(res));
          return;
        }
        resolve({ promotions: res.body?.promotions ?? [], skipped: res.body?.skipped ?? [] });
      });
    });
  }
  public getDeploymentErrors(appName: string, deploymentName: string): Promise<DeploymentErrorsResult> {
    const PAGE_SIZE = 200;
    const MAX_PAGES = 50;
    const entries: DeploymentError[] = [];

    const fetchPage = (page: number): Promise<DeploymentErrorsResult> =>
      this.get(`/logs/errors?appId=${encodeURIComponent(appName)}&page=${page}&limit=${PAGE_SIZE}`).then(
        (res: JsonResponse): DeploymentErrorsResult | Promise<DeploymentErrorsResult> => {
          const body = res.body || {};
          (body.entries || []).forEach((entry: DeploymentError) => {
            if (entry.deploymentName === deploymentName) entries.push(entry);
          });
          const pages = Number(body.pages) || 1;
          if (page < pages && page < MAX_PAGES) return fetchPage(page + 1);
          return { entries, truncated: page < pages };
        }
      );

    return fetchPage(1);
  }

  public getWebhooks(): Promise<any[]> {
    return this.get(urlEncode`/webhooks`).then((res: JsonResponse) => res.body.webhooks);
  }

  public addWebhook(url: string, name?: string, events?: string[], secret?: string, enabled?: boolean): Promise<any> {
    const body: Record<string, any> = { url };
    if (name) body.name = name;
    if (events) body.events = events;
    if (secret) body.secret = secret;
    if (enabled !== undefined) body.enabled = enabled;
    return this.post(urlEncode`/webhooks`, JSON.stringify(body), /*expectResponseBody=*/ true).then(
      (res: JsonResponse) => res.body.webhook
    );
  }

  public updateWebhook(id: string, updates: Record<string, any>): Promise<void> {
    return this.patch(urlEncode`/webhooks/${id}`, JSON.stringify(updates), /*expectResponseBody=*/ false).then(() => null);
  }

  public removeWebhook(id: string): Promise<void> {
    return this.del(urlEncode`/webhooks/${id}`).then(() => null);
  }

  public getAccessKeys(): Promise<AccessKey[]> {
    return this.get(urlEncode`/accessKeys`).then((res: JsonResponse) => {
      const accessKeys: AccessKey[] = [];

      res.body.accessKeys.forEach((serverAccessKey: ServerAccessKey) => {
        !serverAccessKey.isSession &&
          accessKeys.push({
            createdTime: serverAccessKey.createdTime,
            expires: serverAccessKey.expires,
            name: serverAccessKey.friendlyName,
            scopes: serverAccessKey.scopes,
            appNames: serverAccessKey.appNames,
            // Only when the server sends it: an older server's keys stay without it, not "never used".
            ...("lastUsedAt" in serverAccessKey ? { lastUsedAt: serverAccessKey.lastUsedAt } : {}),
          });
      });

      return accessKeys;
    });
  }

  public getSessions(): Promise<Session[]> {
    return this.get(urlEncode`/accessKeys`).then((res: JsonResponse) => {
      // A machine name might be associated with multiple session keys,
      // but we should only return one per machine name.
      const sessionMap: { [machineName: string]: Session } = {};
      const now: number = new Date().getTime();
      // The machine is its hostname: machineName, which servers since 2026-10 also send as createdBy.
      // Older servers sent the login IP as createdBy, so that is the IP when createdByIp is absent.
      // `session rm` takes this name, and DELETE /sessions/:machine matches the hostname or the IP.
      res.body.accessKeys.forEach((serverAccessKey: ServerAccessKey) => {
        if (serverAccessKey.isSession && serverAccessKey.expires > now) {
          const machineName: string = serverAccessKey.machineName || serverAccessKey.createdBy;
          const ip: string | null =
            serverAccessKey.createdByIp ?? (serverAccessKey.createdBy !== machineName ? serverAccessKey.createdBy : null);
          const session: Session = sessionMap[machineName] ?? { loggedInTime: serverAccessKey.createdTime, machineName, ips: [] };
          session.loggedInTime = Math.max(session.loggedInTime ?? 0, serverAccessKey.createdTime ?? 0);
          if (ip && !session.ips.includes(ip)) session.ips.push(ip);
          sessionMap[machineName] = session;
        }
      });

      const sessions: Session[] = Object.keys(sessionMap).map((machineName: string) => sessionMap[machineName]);

      return sessions;
    });
  }

  public patchAccessKey(oldName: string, newName?: string, ttl?: number): Promise<AccessKey> {
    const accessKeyRequest: AccessKeyRequest = {
      friendlyName: newName,
      ttl,
    };

    return this.patch(urlEncode`/accessKeys/${oldName}`, JSON.stringify(accessKeyRequest)).then((res: JsonResponse) => {
      return {
        createdTime: res.body.accessKey.createdTime,
        expires: res.body.accessKey.expires,
        name: res.body.accessKey.friendlyName,
      };
    });
  }

  public removeAccessKey(name: string): Promise<void> {
    if (!isDotSegment(name)) {
      return this.del(urlEncode`/accessKeys/${name}`).then(() => null);
    }
    // A "." or ".." name cannot travel in the path, so look the key up and revoke it by id, which goes in
    // the query string as written.
    return this.get(urlEncode`/accessKeys`).then((res: JsonResponse) => {
      const key = (res.body.accessKeys || []).find((k: ServerAccessKey & { id?: string }) => !k.isSession && k.friendlyName === name);
      if (!key || !key.id) {
        throw <CodePushError>{ message: `Access key "${name}" does not exist.`, statusCode: AccountManager.ERROR_NOT_FOUND };
      }
      return this.del(`/accessKeys?id=${encodeURIComponent(key.id)}`).then(() => null);
    });
  }

  public removeSession(machineName: string): Promise<void> {
    return this.del(urlEncode`/sessions/${machineName}`).then(() => null);
  }

  // Account
  public getAccountInfo(): Promise<Account> {
    return this.get(urlEncode`/account`).then((res: JsonResponse) => res.body.account);
  }

  // Apps
  public getApps(): Promise<App[]> {
    return this.get(urlEncode`/apps`).then((res: JsonResponse) => res.body.apps);
  }

  public getApp(appName: string): Promise<App> {
    return this.get(urlEncode`/apps/${appName}`).then((res: JsonResponse) => res.body.app);
  }

  public addApp(appName: string, platform?: string): Promise<App> {
    const app: App = { name: appName, ...(platform ? { platform } : {}) };
    // Resolve with the server's app, not the one sent: only its copy carries generated fields.
    return this.post(urlEncode`/apps/`, JSON.stringify(app), /*expectResponseBody=*/ true).then(
      (res: JsonResponse) => res.body.app as App
    );
  }

  public removeApp(appName: string): Promise<void> {
    return this.del(urlEncode`/apps/${appName}`).then(() => null);
  }

  public renameApp(oldAppName: string, newAppName: string): Promise<void> {
    return this.patch(urlEncode`/apps/${oldAppName}`, JSON.stringify({ name: newAppName })).then(() => null);
  }

  public setAppPublicKey(appName: string, publicKey: string): Promise<void> {
    return this.patch(urlEncode`/apps/${appName}`, JSON.stringify({ signingKey: publicKey })).then(() => null);
  }

  public transferApp(appName: string, email: string): Promise<void> {
    return this.post(urlEncode`/apps/${appName}/transfer/${email}`, /*requestBody=*/ null, /*expectResponseBody=*/ false).then(
      () => null
    );
  }

  // Collaborators
  public getCollaborators(appName: string): Promise<CollaboratorMap> {
    return this.get(urlEncode`/apps/${appName}/collaborators`).then((res: JsonResponse) => res.body.collaborators);
  }

  public addCollaborator(appName: string, email: string): Promise<void> {
    return this.post(
      urlEncode`/apps/${appName}/collaborators/${email}`,
      /*requestBody=*/ null,
      /*expectResponseBody=*/ false
    ).then(() => null);
  }

  public removeCollaborator(appName: string, email: string): Promise<void> {
    return this.del(urlEncode`/apps/${appName}/collaborators/${email}`).then(() => null);
  }

  // Deployments
  public addDeployment(appName: string, deploymentName: string): Promise<Deployment> {
    const deployment = <Deployment>{ name: deploymentName };
    return this.post(urlEncode`/apps/${appName}/deployments/`, JSON.stringify(deployment), /*expectResponseBody=*/ true).then(
      (res: JsonResponse) => res.body.deployment
    );
  }

  public clearDeploymentHistory(appName: string, deploymentName: string): Promise<void> {
    return this.del(urlEncode`/apps/${appName}/deployments/${deploymentName}/history`).then(() => null);
  }

  public getDeployments(appName: string): Promise<Deployment[]> {
    return this.get(urlEncode`/apps/${appName}/deployments/`).then((res: JsonResponse) => res.body.deployments);
  }

  public getDeployment(appName: string, deploymentName: string): Promise<Deployment> {
    return this.get(urlEncode`/apps/${appName}/deployments/${deploymentName}`).then((res: JsonResponse) => res.body.deployment);
  }

  public renameDeployment(appName: string, oldDeploymentName: string, newDeploymentName: string): Promise<void> {
    return this.patch(
      urlEncode`/apps/${appName}/deployments/${oldDeploymentName}`,
      JSON.stringify({ name: newDeploymentName })
    ).then(() => null);
  }

  public removeDeployment(appName: string, deploymentName: string): Promise<void> {
    return this.del(urlEncode`/apps/${appName}/deployments/${deploymentName}`).then(() => null);
  }

  public getAutoRollbackConfig(appName: string, deploymentName: string): Promise<any> {
    return this.get(urlEncode`/apps/${appName}/deployments/${deploymentName}/auto-rollback`).then(
      (res: JsonResponse) => res.body.autoRollbackConfig
    );
  }

  public setAutoRollbackConfig(appName: string, deploymentName: string, config: { enabled: boolean; errorRateThreshold: number; minDevices: number }): Promise<any> {
    return this.put(urlEncode`/apps/${appName}/deployments/${deploymentName}/auto-rollback`, JSON.stringify(config)).then(
      (res: JsonResponse) => res.body.autoRollbackConfig
    );
  }

  public deleteAutoRollbackConfig(appName: string, deploymentName: string): Promise<void> {
    return this.del(urlEncode`/apps/${appName}/deployments/${deploymentName}/auto-rollback`).then(() => null);
  }

  public getDeploymentMetrics(appName: string, deploymentName: string): Promise<DeploymentMetrics> {
    return this.get(urlEncode`/apps/${appName}/deployments/${deploymentName}/metrics`).then(
      (res: JsonResponse) => res.body.metrics
    );
  }

  public getDeploymentHistory(appName: string, deploymentName: string): Promise<Package[]> {
    return this.get(urlEncode`/apps/${appName}/deployments/${deploymentName}/history`).then(
      (res: JsonResponse) => res.body.history
    );
  }

  public release(
    appName: string,
    deploymentName: string,
    filePath: string,
    targetBinaryVersion: string,
    updateMetadata: PackageInfo,
    uploadProgressCallback?: (progress: number) => void,
    signatureJwt?: string
  ): Promise<void> {
    return Promise<void>((resolve, reject, notify) => {
      updateMetadata.appVersion = targetBinaryVersion;
      const request: superagent.Request<any> = superagent.post(
        this._serverUrl + urlEncode`/apps/${appName}/deployments/${deploymentName}/release`
      );

      this.attachCredentials(request);

      // Q.fcall turns a synchronous throw (lstat of a missing path) into a rejection, and the catch
      // below hands any failure to build the package to the outer promise. Without it a failed zip
      // write left this promise pending forever, node exited 0 with no output, and CI went green
      // with nothing released.
      Q.fcall(() => this.packageFileFromPath(filePath, signatureJwt))
        .catch((error: any) => {
          throw new Error(`Could not prepare the release package from "${filePath}": ${(error && error.message) || error}`);
        })
        .then((packageFile: PackageFile) => {
          const file: any = fs.createReadStream(packageFile.path);
          request
            .attach("package", file)
            .field("packageInfo", JSON.stringify(updateMetadata));

          if (signatureJwt) {
            request.field("packageSignature", signatureJwt);
          }

          request
            .on("progress", (event: any) => {
              if (uploadProgressCallback && event && event.total > 0) {
                const currentProgress: number = (event.loaded / event.total) * 100;
                uploadProgressCallback(currentProgress);
              }
            })
            .end((err: any, res: superagent.Response) => {
              if (packageFile.isTemporary) {
                removeQuietly(packageFile.path);
              }

              if (err) {
                reject(this.getCodePushError(err, res));
                return;
              }

              if (res.ok) {
                resolve(<void>null);
              } else {
                let body;
                try {
                  body = JSON.parse(res.text);
                } catch (err) {}

                if (body) {
                  reject(<CodePushError>{
                    message: body.message,
                    statusCode: res && res.status,
                  });
                } else {
                  reject(<CodePushError>{
                    message: res.text,
                    statusCode: res && res.status,
                  });
                }
              }
            });
        })
        .catch((error: any) => reject(error))
        .done();
    });
  }

  public patchRelease(appName: string, deploymentName: string, label: string, updateMetadata: PackageInfo): Promise<void> {
    updateMetadata.label = label;
    const requestBody: string = JSON.stringify({ packageInfo: updateMetadata });
    return this.patch(
      urlEncode`/apps/${appName}/deployments/${deploymentName}/release`,
      requestBody,
      /*expectResponseBody=*/ false
    ).then(() => null);
  }

  public promote(
    appName: string,
    sourceDeploymentName: string,
    destinationDeploymentName: string,
    updateMetadata: PackageInfo
  ): Promise<void> {
    const requestBody: string = JSON.stringify({ packageInfo: updateMetadata });
    return this.post(
      urlEncode`/apps/${appName}/deployments/${sourceDeploymentName}/promote/${destinationDeploymentName}`,
      requestBody,
      /*expectResponseBody=*/ false
    ).then(() => null);
  }

  public rollback(appName: string, deploymentName: string, targetRelease?: string): Promise<void> {
    return this.post(
      urlEncode`/apps/${appName}/deployments/${deploymentName}/rollback/${targetRelease || ""}`,
      /*requestBody=*/ null,
      /*expectResponseBody=*/ false
    ).then(() => null);
  }

  private packageFileFromPath(filePath: string, signatureJwt?: string) {
    let getPackageFilePromise: Promise<PackageFile>;
    if (fs.lstatSync(filePath).isDirectory()) {
      getPackageFilePromise = Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
        const directoryPath: string = filePath;

        recursiveFs.readdirr(directoryPath, (error?: any, directories?: string[], files?: string[]) => {
          if (error) {
            reject(error);
            return;
          }

          const baseDirectoryPath = path.dirname(directoryPath);
          const fileName: string = this.generateRandomFilename(15) + ".zip";
          const zipFile = new yazl.ZipFile();
          const writeStream: fs.WriteStream = fs.createWriteStream(fileName);
          const fail = (error: Error): void => {
            removeQuietly(fileName);
            reject(error);
          };

          // yazl reports a file it cannot read on the ZipFile itself, and pipe() does not forward
          // source errors, so both ends need a handler or the promise never settles.
          zipFile.on("error", fail);
          zipFile.outputStream
            .pipe(writeStream)
            .on("error", fail)
            .on("close", (): void => {
              filePath = path.join(process.cwd(), fileName);

              resolve({ isTemporary: true, path: filePath });
            });

          for (let i = 0; i < files.length; ++i) {
            const file: string = files[i];
            // yazl does not like backslash (\) in the metadata path.
            const relativePath: string = slash(path.relative(baseDirectoryPath, file));

            zipFile.addFile(file, relativePath);
          }

          if (signatureJwt) {
            zipFile.addBuffer(Buffer.from(signatureJwt), "CodePush/.codepushrelease");
          }

          zipFile.end();
        });
      });
    } else if (signatureJwt) {
      // Single-file release with a signature: wrap the file + signature entry into a new zip.
      getPackageFilePromise = Promise<PackageFile>((resolve: (file: PackageFile) => void, reject: (reason: Error) => void): void => {
        const fileName: string = this.generateRandomFilename(15) + ".zip";
        const zipFile = new yazl.ZipFile();
        const writeStream: fs.WriteStream = fs.createWriteStream(fileName);
        const fail = (error: Error): void => {
          removeQuietly(fileName);
          reject(error);
        };

        zipFile.on("error", fail);
        zipFile.outputStream
          .pipe(writeStream)
          .on("error", fail)
          .on("close", (): void => {
            resolve({ isTemporary: true, path: path.join(process.cwd(), fileName) });
          });

        zipFile.addFile(filePath, path.basename(filePath));
        zipFile.addBuffer(Buffer.from(signatureJwt), "CodePush/.codepushrelease");
        zipFile.end();
      });
    } else {
      getPackageFilePromise = Q({ isTemporary: false, path: filePath });
    }
    return getPackageFilePromise;
  }

  private generateRandomFilename(length: number): string {
    let filename: string = "";
    const validChar: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (let i = 0; i < length; i++) {
      filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
    }

    return filename;
  }

  private get(endpoint: string, expectResponseBody: boolean = true): Promise<JsonResponse> {
    return this.makeApiRequest("get", endpoint, /*requestBody=*/ null, expectResponseBody, /*contentType=*/ null);
  }

  private post(
    endpoint: string,
    requestBody: string,
    expectResponseBody: boolean,
    contentType: string = "application/json;charset=UTF-8"
  ): Promise<JsonResponse> {
    return this.makeApiRequest("post", endpoint, requestBody, expectResponseBody, contentType);
  }

  private patch(
    endpoint: string,
    requestBody: string,
    expectResponseBody: boolean = false,
    contentType: string = "application/json;charset=UTF-8"
  ): Promise<JsonResponse> {
    return this.makeApiRequest("patch", endpoint, requestBody, expectResponseBody, contentType);
  }

  private put(
    endpoint: string,
    requestBody: string,
    expectResponseBody: boolean = true,
    contentType: string = "application/json;charset=UTF-8"
  ): Promise<JsonResponse> {
    return this.makeApiRequest("put", endpoint, requestBody, expectResponseBody, contentType);
  }

  private del(endpoint: string, expectResponseBody: boolean = false): Promise<JsonResponse> {
    return this.makeApiRequest("del", endpoint, /*requestBody=*/ null, expectResponseBody, /*contentType=*/ null);
  }

  private makeApiRequest(
    method: string,
    endpoint: string,
    requestBody: string,
    expectResponseBody: boolean,
    contentType: string
  ): Promise<JsonResponse> {
    return Promise<JsonResponse>((resolve, reject, notify) => {
      let request: superagent.Request<any> = (<any>superagent)[method](this._serverUrl + endpoint);

      this.attachCredentials(request);

      if (requestBody) {
        if (contentType) {
          request = request.set("Content-Type", contentType);
        }

        request = request.send(requestBody);
      }

      request.end((err: any, res: superagent.Response) => {
        if (err) {
          reject(this.getCodePushError(err, res));
          return;
        }
        let body;
        try {
          body = JSON.parse(res.text);
        } catch (err) {}

        if (res.ok) {
          if (expectResponseBody && !body) {
            reject(<CodePushError>{
              message: `Could not parse response: ${res.text}`,
              statusCode: AccountManager.ERROR_INTERNAL_SERVER,
            });
          } else {
            resolve(<JsonResponse>{
              headers: res.header,
              body: body,
            });
          }
        } else {
          reject(<CodePushError>{
            message: messageFromResponseText(res.text),
            statusCode: this.getErrorStatus(err, res),
          });
        }
      });
    });
  }

  private getCodePushError(error: any, response: superagent.Response): CodePushError {
    if (error.syscall === "getaddrinfo") {
      error.message = `Unable to connect to the CodePush server. Are you offline, or behind a firewall or proxy?\n(${error.message})`;
    }

    return {
      message: this.getErrorMessage(error, response),
      statusCode: this.getErrorStatus(error, response),
    };
  }

  private getErrorStatus(error: any, response: superagent.Response): number {
    return (error && error.status) || (response && response.status) || AccountManager.ERROR_GATEWAY_TIMEOUT;
  }

  private getErrorMessage(error: Error, response: superagent.Response): string {
    const text = response && response.text;
    return text ? messageFromResponseText(text) : error.message;
  }

  private attachCredentials(request: superagent.Request<any>): void {
    if (this._customHeaders) {
      for (const headerName in this._customHeaders) {
        request.set(headerName, this._customHeaders[headerName]);
      }
    }

    request.set("Accept", `application/vnd.code-push.v${AccountManager.API_VERSION}+json`);
    request.set("Authorization", `Bearer ${this._accessKey}`);
    request.set("X-CodePush-SDK-Version", packageJson.version);
    // Node's superagent sends no User-Agent of its own. Without this the server has only the version
    // header to go on, and a login shows up as a nameless CLI in Recent Logins.
    request.set("User-Agent", `dpctl/${packageJson.version}`);
    if (this._orgId) {
      request.set("x-org-id", this._orgId);
    }
  }
}

interface ExpoBusy {
  retryAfterMs: number | null;
  statusCode: number;
}

function expoRouteError(res: superagent.Response): CodePushError {
  return <CodePushError>{ message: messageFromResponseText(res.text), statusCode: res.status };
}

export = AccountManager;
