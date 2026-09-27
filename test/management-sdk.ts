// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as assert from "assert";
import * as Q from "q";

import AccountManager = require("../script/management-sdk");

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

function mockReturn(bodyText: string, statusCode: number, header = {}): void {
  lastRequestBody = undefined;
  require("superagent-mock")(request, [
    {
      pattern: "https://api.deploypulse.io/(.*)",
      fixtures: function (match: any, params: any): any {
        lastRequestBody = params;
        var isOk = statusCode >= 200 && statusCode < 300;
        if (!isOk) {
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
