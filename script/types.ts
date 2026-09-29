// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export {
  AccessKeyRequest,
  Account,
  App,
  CollaboratorMap,
  CollaboratorProperties,
  Deployment,
  DeploymentMetrics,
  Package,
  PackageInfo,
  AccessKey as ServerAccessKey,
  UpdateMetrics,
} from "../script/types/rest-definitions";

export interface CodePushError {
  message: string;
  statusCode: number;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  role: string;
  isOwner: boolean;
}

export interface AccessKey {
  createdTime: number;
  expires: number;
  name: string;
  key?: string;
  scopes?: string[];
  appNames?: string[] | null;
}

/** A device's failure report for one release, as returned by GET /logs/errors. */
export interface DeploymentError {
  clientUniqueId: string;
  appName: string;
  deploymentName: string;
  label: string;
  lastSuccessfulLabel?: string | null;
  appVersion?: string | null;
  platform?: string | null;
  sdkVersion?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  failureCount: number;
  lastSeen: string;
}

export interface DeploymentErrorsResult {
  entries: DeploymentError[];
  truncated: boolean;
}

export interface Session {
  loggedInTime: number;
  machineName: string;
}

export type Headers = { [headerName: string]: string };
