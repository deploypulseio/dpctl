// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as Q from "q";

import AccountManager = require("../script/management-sdk");
import { messageFromResponseText } from "../script/api-errors";

var request = require("superagent");

var manager: AccountManager;
describe("Management SDK", () => {
  beforeEach(() => {
    manager = new AccountManager(/*accessKey=*/ "dummyAccessKey", /*customHeaders=*/ null);
  });

  after(() => {
    // Prevent an exception that occurs due to how superagent-mock overwrites methods
    request.Request.prototype._callback = function () {};
  });

  it("methods reject the promise with status code info when an error occurs", (done: Mocha.Done) => {
    mockReturn("Text", 404);

    var methodsWithErrorHandling: any[] = [
      manager.addApp.bind(manager, "appName"),
      manager.getApp.bind(manager, "appName"),
      manager.renameApp.bind(manager, "appName", {}),
      manager.removeApp.bind(manager, "appName"),
      manager.transferApp.bind(manager, "appName", "email1"),

      manager.addDeployment.bind(manager, "appName", "deploymentName"),
      manager.getDeployment.bind(manager, "appName", "deploymentName"),
      manager.getDeployments.bind(manager, "appName"),
      manager.renameDeployment.bind(manager, "appName", "deploymentName", {
        name: "newDeploymentName",
      }),
      manager.removeDeployment.bind(manager, "appName", "deploymentName"),

      manager.addCollaborator.bind(manager, "appName", "email1"),
      manager.getCollaborators.bind(manager, "appName"),
      manager.removeCollaborator.bind(manager, "appName", "email1"),

      manager.patchRelease.bind(manager, "appName", "deploymentName", "label", {
        description: "newDescription",
      }),
      manager.promote.bind(manager, "appName", "deploymentName", "newDeploymentName", { description: "newDescription" }),
      manager.rollback.bind(manager, "appName", "deploymentName", "targetReleaseLabel"),
    ];

    var result = Q<void>(null);
    methodsWithErrorHandling.forEach(function (f) {
      result = result.then(() => {
        return testErrors(f);
      });
    });

    result.done(() => {
      done();
    });

    // Test that the proper error code and text is passed through on a server error
    function testErrors(method: any): Q.Promise<void> {
      return Q.Promise<void>((resolve: any, reject: any, notify: any) => {
        method().done(
          () => {
            assert.fail("Should have thrown an error");
            reject();
          },
          (error: any) => {
            assert.equal(error.message, "Text");
            assert(error.statusCode);
            resolve();
          }
        );
      });
    }
  });

  it("isAuthenticated handles successful auth", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ authenticated: true }), 200, {});
    manager.isAuthenticated().done((authenticated: boolean) => {
      assert(authenticated, "Should be authenticated");
      done();
    });
  });

  it("isAuthenticated handles unsuccessful auth", (done: Mocha.Done) => {
    mockReturn("Unauthorized", 401, {});
    manager.isAuthenticated().done((authenticated: boolean) => {
      assert(!authenticated, "Should not be authenticated");
      done();
    });
  });

  it("isAuthenticated handles unsuccessful auth with promise rejection", (done: Mocha.Done) => {
    mockReturn("Unauthorized", 401, {});

    // use optional parameter to ask for rejection of the promise if not authenticated
    manager.isAuthenticated(true).done(
      (authenticated: boolean) => {
        assert.fail("isAuthenticated should have rejected the promise");
        done();
      },
      (err) => {
        assert.equal(err.message, "Unauthorized", "Error message should be 'Unauthorized'");
        done();
      }
    );
  });

  it("isAuthenticated handles unexpected status codes", (done: Mocha.Done) => {
    mockReturn("Not Found", 404, {});
    manager.isAuthenticated().done(
      (authenticated: boolean) => {
        assert.fail("isAuthenticated should have rejected the promise");
        done();
      },
      (err) => {
        assert.equal(err.message, "Not Found", "Error message should be 'Not Found'");
        done();
      }
    );
  });

  it("addApp resolves with the app the server created", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ app: { id: "server-generated-id", name: "appName", platform: "ios" } }), 201, {
      location: "/appName",
    });
    manager.addApp("appName", "ios").done((app: any) => {
      assert.equal(app.name, "appName");
      assert.equal(app.platform, "ios");
      // Only the server's copy carries generated fields, so this fails if the posted object is resolved.
      assert.equal(app.id, "server-generated-id");
      done();
    }, rejectHandler);
  });

  it("addApp handles error response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ success: false }), 404, {});
    manager.addApp("appName").done(
      (obj) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("getApp handles JSON response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ app: {} }), 200, {});

    manager.getApp("appName").done((obj: any) => {
      assert.ok(obj);
      done();
    }, rejectHandler);
  });

  it("updateApp handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ apps: [] }), 200, {});

    manager.renameApp("appName", "newAppName").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("removeApp handles success response", (done: Mocha.Done) => {
    mockReturn("", 200, {});

    manager.removeApp("appName").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("transferApp handles successful response", (done: Mocha.Done) => {
    mockReturn("", 201);
    manager.transferApp("appName", "email1").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("addDeployment handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ deployment: { name: "name", key: "key" } }), 201, { location: "/deploymentName" });

    manager.addDeployment("appName", "deploymentName").done((obj: any) => {
      assert.ok(obj);
      done();
    }, rejectHandler);
  });

  it("getDeployment handles JSON response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ deployment: {} }), 200, {});

    manager.getDeployment("appName", "deploymentName").done((obj: any) => {
      assert.ok(obj);
      done();
    }, rejectHandler);
  });

  it("getDeployments handles JSON response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ deployments: [] }), 200, {});

    manager.getDeployments("appName").done((obj: any) => {
      assert.ok(obj);
      done();
    }, rejectHandler);
  });

  it("renameDeployment handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ apps: [] }), 200, {});

    manager.renameDeployment("appName", "deploymentName", "newDeploymentName").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("removeDeployment handles success response", (done: Mocha.Done) => {
    mockReturn("", 200, {});

    manager.removeDeployment("appName", "deploymentName").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("getDeploymentHistory handles success response with no packages", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ history: [] }), 200);

    manager.getDeploymentHistory("appName", "deploymentName").done((obj: any) => {
      assert.ok(obj);
      assert.equal(obj.length, 0);
      done();
    }, rejectHandler);
  });

  it("getDeploymentHistory handles success response with two packages", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ history: [{ label: "v1" }, { label: "v2" }] }), 200);

    manager.getDeploymentHistory("appName", "deploymentName").done((obj: any) => {
      assert.ok(obj);
      assert.equal(obj.length, 2);
      assert.equal(obj[0].label, "v1");
      assert.equal(obj[1].label, "v2");
      done();
    }, rejectHandler);
  });

  it("getDeploymentHistory handles error response", (done: Mocha.Done) => {
    mockReturn("", 404);

    manager.getDeploymentHistory("appName", "deploymentName").done(
      (obj: any) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("clearDeploymentHistory handles success response", (done: Mocha.Done) => {
    mockReturn("", 204);

    manager.clearDeploymentHistory("appName", "deploymentName").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("clearDeploymentHistory handles error response", (done: Mocha.Done) => {
    mockReturn("", 404);

    manager.clearDeploymentHistory("appName", "deploymentName").done(
      (obj: any) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("addCollaborator handles successful response", (done: Mocha.Done) => {
    mockReturn("", 201, { location: "/collaborators" });
    manager.addCollaborator("appName", "email1").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("addCollaborator handles error response", (done: Mocha.Done) => {
    mockReturn("", 404, {});
    manager.addCollaborator("appName", "email1").done(
      (obj) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("getCollaborators handles success response with no collaborators", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ collaborators: {} }), 200);

    manager.getCollaborators("appName").done((obj: any) => {
      assert.ok(obj);
      assert.equal(Object.keys(obj).length, 0);
      done();
    }, rejectHandler);
  });

  it("getCollaborators handles success response with multiple collaborators", (done: Mocha.Done) => {
    mockReturn(
      JSON.stringify({
        collaborators: {
          email1: { permission: "Owner", isCurrentAccount: true },
          email2: { permission: "Collaborator", isCurrentAccount: false },
        },
      }),
      200
    );

    manager.getCollaborators("appName").done((obj: any) => {
      assert.ok(obj);
      assert.equal(obj["email1"].permission, "Owner");
      assert.equal(obj["email2"].permission, "Collaborator");
      done();
    }, rejectHandler);
  });

  it("removeCollaborator handles success response", (done: Mocha.Done) => {
    mockReturn("", 200, {});

    manager.removeCollaborator("appName", "email1").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("patchRelease handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ package: { description: "newDescription" } }), 200);

    manager
      .patchRelease("appName", "deploymentName", "label", {
        description: "newDescription",
      })
      .done((obj: any) => {
        assert.ok(!obj);
        done();
      }, rejectHandler);
  });

  it("patchRelease handles error response", (done: Mocha.Done) => {
    mockReturn("", 400);

    manager.patchRelease("appName", "deploymentName", "label", {}).done(
      (obj: any) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("promote handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ package: { description: "newDescription" } }), 200);

    manager
      .promote("appName", "deploymentName", "newDeploymentName", {
        description: "newDescription",
      })
      .done((obj: any) => {
        assert.ok(!obj);
        done();
      }, rejectHandler);
  });

  it("promote handles error response", (done: Mocha.Done) => {
    mockReturn("", 400);

    manager
      .promote("appName", "deploymentName", "newDeploymentName", {
        rollout: 123,
      })
      .done(
        (obj: any) => {
          throw new Error("Call should not complete successfully");
        },
        (error: Error) => done()
      );
  });

  it("rollback handles success response", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ package: { label: "v1" } }), 200);

    manager.rollback("appName", "deploymentName", "v1").done((obj: any) => {
      assert.ok(!obj);
      done();
    }, rejectHandler);
  });

  it("rollback handles error response", (done: Mocha.Done) => {
    mockReturn("", 400);

    manager.rollback("appName", "deploymentName", "v1").done(
      (obj: any) => {
        throw new Error("Call should not complete successfully");
      },
      (error: Error) => done()
    );
  });

  it("sends x-org-id once an organization is set, and not before", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ apps: [] }), 200);
    manager.getApps().done(() => {
      assert.ok(!lastRequestHeaders["x-org-id"], "personal account requests must not carry the header");

      manager.setOrgId("org-id-acme");
      manager.getApps().done(() => {
        assert.strictEqual(lastRequestHeaders["x-org-id"], "org-id-acme");
        done();
      }, rejectHandler);
    }, rejectHandler);
  });

  it("unwraps the API's error envelope, and leaves anything else alone", () => {
    assert.strictEqual(messageFromResponseText('{"message":"This access key is read-only."}'), "This access key is read-only.");
    assert.strictEqual(messageFromResponseText("upstream connect error"), "upstream connect error");
    // Shapes that are JSON but carry no usable message stay as they were, rather than becoming
    // "undefined" or an empty error.
    assert.strictEqual(messageFromResponseText('{"error":"nope"}'), '{"error":"nope"}');
    assert.strictEqual(messageFromResponseText('{"message":""}'), '{"message":""}');
    assert.strictEqual(messageFromResponseText('{"message":123}'), '{"message":123}');
    assert.strictEqual(messageFromResponseText(""), "");
  });

  it("unwraps the envelope on the branch a real 4xx takes", () => {
    // superagent reports a 4xx as an error, so production rejects through getCodePushError, not
    // through the body-parsing branch below. superagent-mock cannot produce that combination (an
    // error AND a response body), so this reaches the method directly.
    const error: any = new Error("Forbidden");
    const response: any = { status: 403, text: '{"message":"This access key is read-only."}' };
    const built = (manager as any).getCodePushError(error, response);
    assert.strictEqual(built.message, "This access key is read-only.");
    assert.strictEqual(built.statusCode, 403);

    // No body at all: the transport error is still what gets reported.
    const offline: any = new Error("connect ECONNREFUSED");
    assert.strictEqual((manager as any).getCodePushError(offline, undefined).message, "connect ECONNREFUSED");
  });

  it("reports the server's message, not the JSON envelope it arrived in", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ message: "This access key is read-only." }), 403, {}, /*throwOnError=*/ false);
    manager.addApp("MyApp").then(
      () => done(new Error("Should have rejected")),
      (error: any) => {
        assert.strictEqual(error.message, "This access key is read-only.");
        assert.strictEqual(error.statusCode, 403);
        done();
      }
    );
  });

  it("passes a non-JSON error body through untouched", (done: Mocha.Done) => {
    mockReturn("upstream connect error", 502, {}, /*throwOnError=*/ false);
    manager.addApp("MyApp").then(
      () => done(new Error("Should have rejected")),
      (error: any) => {
        assert.strictEqual(error.message, "upstream connect error");
        done();
      }
    );
  });

  it("identifies itself as dpctl, so a login is not a nameless CLI row", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ apps: [] }), 200);
    manager.getApps().done(() => {
      const version = require("../package.json").version;
      assert.strictEqual(lastRequestHeaders["User-Agent"], `dpctl/${version}`);
      done();
    }, rejectHandler);
  });

  it("addAccessKey sends scopes and appIds when they are set", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ accessKey: { name: "k", friendlyName: "CI key", createdTime: 0, expires: 1 } }), 201);
    manager.addAccessKey("CI key", undefined, ["read"], ["app-a-id"]).done(() => {
      const body = typeof lastRequestBody === "string" ? JSON.parse(lastRequestBody) : lastRequestBody;
      assert.deepStrictEqual(body.scopes, ["read"]);
      assert.deepStrictEqual(body.appIds, ["app-a-id"]);
      done();
    }, rejectHandler);
  });

  it("addAccessKey leaves scopes and appIds out when they are not set", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ accessKey: { name: "k", friendlyName: "CI key", createdTime: 0, expires: 1 } }), 201);
    manager.addAccessKey("CI key").done(() => {
      const body = typeof lastRequestBody === "string" ? JSON.parse(lastRequestBody) : lastRequestBody;
      assert.ok(!("scopes" in body), "an unscoped key must not pin itself to full");
      assert.ok(!("appIds" in body), "an unscoped key must not pin itself to a list of apps");
      done();
    }, rejectHandler);
  });

  // The Expo routes are addressed by deployment key rather than app and deployment name, and they build
  // their requests directly instead of going through get/post, so what they send is worth pinning down.

  // The failure-report route is account-wide and paged, so the SDK walks the pages and keeps only the
  // deployment that was asked for.

  it("getDeploymentErrors follows the pages and keeps one deployment", (done: Mocha.Done) => {
    const requested = mockPages([
      { pages: 2, entries: [{ deploymentName: "Production", label: "v1" }, { deploymentName: "Staging", label: "v9" }] },
      { pages: 2, entries: [{ deploymentName: "Production", label: "v2" }] },
    ]);
    manager.getDeploymentErrors("MyApp", "Production").then((result) => {
      assert.deepStrictEqual(result.entries.map((entry) => entry.label), ["v1", "v2"]);
      assert.strictEqual(result.truncated, false);
      assert.deepStrictEqual(requested.map((url) => /[?&]page=(\d+)/.exec(url)[1]), ["1", "2"]);
      assert.ok(requested[0].indexOf("appId=MyApp") >= 0, requested[0]);
      done();
    }, rejectHandler);
  });

  it("getDeploymentErrors says when there are more pages than it will read", (done: Mocha.Done) => {
    const requested = mockPages(
      Array.from({ length: 51 }, (unused, index) => ({ pages: 99, entries: [{ deploymentName: "Production", label: `v${index}` }] }))
    );
    manager.getDeploymentErrors("MyApp", "Production").then((result) => {
      assert.strictEqual(requested.length, 50, "should stop after 50 pages");
      assert.strictEqual(result.truncated, true);
      done();
    }, rejectHandler);
  });

  it("the Expo routes live under /expo/v1 and are addressed by deployment key", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ releases: [] }), 200);
    manager.patchExpoRollout("key with spaces", 25).then(() => {
      assert.strictEqual(lastRequestUrl, "https://api.deploypulse.io/expo/v1/key%20with%20spaces/release");
      return manager.rollbackExpo("key with spaces", { toEmbedded: true });
    }).then(() => {
      assert.strictEqual(lastRequestUrl, "https://api.deploypulse.io/expo/v1/key%20with%20spaces/rollback");
      return manager.promoteExpo("key with spaces", "Production");
    }).then(() => {
      assert.strictEqual(lastRequestUrl, "https://api.deploypulse.io/expo/v1/key%20with%20spaces/promote");
      done();
    }, rejectHandler);
  });

  it("Expo requests carry the same credentials as every other route", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ releases: [] }), 200);
    manager.setOrgId("org-id-acme");
    manager.patchExpoRollout("dkey", 25).then(() => {
      assert.strictEqual(lastRequestHeaders["Authorization"], "Bearer dummyAccessKey");
      assert.strictEqual(lastRequestHeaders["x-org-id"], "org-id-acme");
      done();
    }, rejectHandler);
  });

  it("an Expo route error reports the server's message, not the raw body", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ message: "No release to roll back to on this channel." }), 409, {}, /*throwOnError=*/ false);
    manager.rollbackExpo("dkey").then(
      () => done(new Error("Should have rejected")),
      (error: any) => {
        assert.strictEqual(error.message, "No release to roll back to on this channel.");
        assert.strictEqual(error.statusCode, 409);
        done();
      }
    );
  });

  it("getAutoRollbackConfig reads autoRollbackConfig, the key the API actually sends", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ autoRollbackConfig: { enabled: true, threshold: 25 } }), 200);
    manager.getAutoRollbackConfig("appName", "Staging").done((config: any) => {
      assert.ok(config, "expected the config, not undefined");
      assert.strictEqual(config.enabled, true);
      assert.strictEqual(config.threshold, 25);
      done();
    }, rejectHandler);
  });
});

// Helper method that is used everywhere that an assert.fail() is needed in a promise handler
function rejectHandler(val: any): void {
  assert.fail();
}

// Wrapper for superagent-mock that abstracts away information not needed for SDK tests
let lastRequestBody: any;
let lastRequestHeaders: any;
let lastRequestUrl: string;

function mockPages(pageBodies: any[]): string[] {
  const requested: string[] = [];
  lastRequestBody = undefined;
  require("superagent-mock")(request, [
    {
      pattern: "https://api.deploypulse.io/(.*)",
      fixtures: function (match: any): any {
        requested.push(match[0]);
        const page = Number(/[?&]page=(\d+)/.exec(match[0])?.[1] || 1);
        return { text: JSON.stringify(pageBodies[page - 1]), status: 200, ok: true, header: {}, headers: {} };
      },
      callback: function (match: any, data: any): any {
        return data;
      },
    },
  ]);
  return requested;
}

function mockReturn(bodyText: string, statusCode: number, header = {}, throwOnError = true): void {
  lastRequestBody = undefined;
  lastRequestUrl = undefined;
  require("superagent-mock")(request, [
    {
      pattern: "https://api.deploypulse.io/(.*)",
      fixtures: function (match: any, params: any, headers: any): any {
        lastRequestBody = params;
        lastRequestHeaders = headers || {};
        lastRequestUrl = match[0];
        var isOk = statusCode >= 200 && statusCode < 300;
        if (!isOk && throwOnError) {
          var err: any = new Error(bodyText);
          err.status = statusCode;
          throw err;
        }
        return {
          text: bodyText,
          status: statusCode,
          ok: isOk,
          header: header,
          headers: {},
        };
      },
      callback: function (match: any, data: any): any {
        return data;
      },
    },
  ]);
}
