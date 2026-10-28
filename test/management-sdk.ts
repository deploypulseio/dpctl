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

  it("reads the API's validation list as sentences instead of printing it raw", () => {
    assert.strictEqual(messageFromResponseText('[{"field":"name","message":"Field is invalid"}]'), "The name field is invalid.");
    assert.strictEqual(
      messageFromResponseText('[{"field":"name","message":"Field is invalid"},{"field":"appVersion","message":"Field is required"}]'),
      "The name field is invalid. The appVersion field is required."
    );
    // A message in other words keeps its own wording, after the field.
    assert.strictEqual(messageFromResponseText('[{"field":"rollout","message":"Must be 1 to 100"}]'), "rollout: Must be 1 to 100.");
    assert.strictEqual(messageFromResponseText('[{"message":"Something went wrong."}]'), "Something went wrong.");
    assert.strictEqual(messageFromResponseText('[{"field":"name","message":"a &amp; b is taken"}]'), "name: a & b is taken.");
    // Anything else that happens to be a JSON list is left as it was.
    assert.strictEqual(messageFromResponseText("[]"), "[]");
    assert.strictEqual(messageFromResponseText("[1,2]"), "[1,2]");
    assert.strictEqual(messageFromResponseText('[{"field":"name"}]'), '[{"field":"name"}]');
    assert.strictEqual(messageFromResponseText('[{"field":"name","message":"Field is invalid"},{"field":"x"}]'), '[{"field":"name","message":"Field is invalid"},{"field":"x"}]');
  });

  // FINC-D4: the Expo routes answer in plain text with user-supplied names HTML-escaped.
  it("prints HTML-escaped error text as the user typed it", () => {
    assert.strictEqual(
      messageFromResponseText("Nothing was rolled back on the &quot;QA &amp; Beta&quot; channel: it&#39;s &lt;busy&gt;."),
      'Nothing was rolled back on the "QA & Beta" channel: it\'s <busy>.'
    );
    assert.strictEqual(messageFromResponseText('{"message":"App &#x27;a&amp;b&#x27; not found"}'), "App 'a&b' not found");
    // One pass only, and unknown entities stay as written.
    assert.strictEqual(messageFromResponseText("a &amp;lt; b &nbsp; c &bogus;"), "a &lt; b &nbsp; c &bogus;");
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

  // AUTH12-L4: the API records a CLI login only for X-DeployPulse-Login: 1, so every other caller sends 0.
  it("isAuthenticated marks a login check with X-DeployPulse-Login: 1", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ authenticated: true }), 200, {});
    manager.isAuthenticated(false, true).done(() => {
      assert.strictEqual(lastRequestHeaders["X-DeployPulse-Login"], "1");
      done();
    }, rejectHandler);
  });

  it("isAuthenticated from any other command sends X-DeployPulse-Login: 0", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ authenticated: true }), 200, {});
    manager.isAuthenticated(true).done(() => {
      assert.strictEqual(lastRequestHeaders["X-DeployPulse-Login"], "0");
      done();
    }, rejectHandler);
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

  it("releaseExpo sends the app config as its own appConfig field, and no field without one", (done: Mocha.Done) => {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-sdk-zip-")), "bundle.zip");
    fs.writeFileSync(zip, "zip bytes");
    const fields: Array<[string, string]> = [];
    const originalField = request.Request.prototype.field;
    request.Request.prototype.field = function (name: string, value: string) {
      fields.push([name, value]);
      return originalField.apply(this, arguments);
    };
    const restore = () => {
      request.Request.prototype.field = originalField;
      fs.rmSync(path.dirname(zip), { recursive: true, force: true });
    };
    const appConfig = { name: "App", extra: { eas: { projectId: "p1" } } };
    mockReturn(JSON.stringify({ release: {} }), 201);
    manager
      .releaseExpo("dkey", zip, "ios", "1.0.0", undefined, undefined, undefined, undefined, appConfig)
      .then(() => {
        assert.deepStrictEqual(fields.find(([name]) => name === "appConfig"), ["appConfig", JSON.stringify(appConfig)]);
        fields.length = 0;
        return manager.releaseExpo("dkey", zip, "ios", "1.0.0");
      })
      .then(() => {
        assert.deepStrictEqual(fields.map(([name]) => name), ["releaseInfo"], "an older-style release sends no appConfig field");
        restore();
        done();
      }, (err: any) => {
        restore();
        rejectHandler(err);
      });
  });

  // 1.2.2: a busy server (503, or 429 with Retry-After) is retried for up to five minutes, then given up on
  // with "Server busy, try again later." The clock is faked, so the waits are recorded, not slept.
  describe("releaseExpo when the server is busy", () => {
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    let zip: string;
    let waits: number[];
    let now: number;

    beforeEach(() => {
      zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-sdk-busy-")), "bundle.zip");
      fs.writeFileSync(zip, "zip bytes");
      waits = [];
      now = Date.parse("2026-10-15T12:00:00Z");
      (manager as any)._clock = {
        now: () => now,
        sleep: (ms: number) => {
          waits.push(ms);
          now += ms;
          return Q<void>(null);
        },
      };
    });
    afterEach(() => fs.rmSync(path.dirname(zip), { recursive: true, force: true }));

    const release = (onBusy?: (ms: number) => void) =>
      manager.releaseExpo("dkey", zip, "ios", "1.0.0", undefined, undefined, undefined, undefined, undefined, onBusy);

    it("retries a 503 with backoff until the release goes through, telling the caller each time", () => {
      const sent = mockSequence([{ status: 503 }, { status: 503 }, { status: 201, text: JSON.stringify({ release: {} }) }]);
      const busy: number[] = [];
      return release((ms) => busy.push(ms)).then(() => {
        assert.strictEqual(sent.length, 3);
        assert.deepStrictEqual(busy, waits);
        assert.strictEqual(waits.length, 2);
        assert.ok(waits[0] >= 2000 && waits[0] <= 2400, `first wait ${waits[0]}`);
        assert.ok(waits[1] >= 4000 && waits[1] <= 4800, `second wait ${waits[1]}`);
      });
    });

    it("waits exactly as long as Retry-After asks, in seconds or as a date", () => {
      mockSequence([
        { status: 429, header: { "retry-after": "7" } },
        { status: 503, header: { "retry-after": new Date(Date.parse("2026-10-15T12:00:37Z")).toUTCString() } },
        { status: 201, text: "{}" },
      ]);
      return release().then(() => assert.deepStrictEqual(waits, [7000, 30000]));
    });

    it("a 429 without Retry-After is a rate limit, not a busy server: no retry", () => {
      const sent = mockSequence([{ status: 429, text: JSON.stringify({ message: "Too many releases." }) }, { status: 201, text: "{}" }]);
      return release().then(
        () => assert.fail("should have rejected"),
        (err: any) => {
          assert.strictEqual(sent.length, 1);
          assert.strictEqual(err.statusCode, 429);
          assert.deepStrictEqual(waits, []);
        }
      );
    });

    it("gives up with \"Server busy, try again later.\" once five minutes of waiting would pass", () => {
      // Busy 100 times, then a success. The budget runs out long before the 101st try; if the give-up check
      // were missing, the release would reach the success and resolve, failing this test instead of looping
      // forever (the mock repeats its last answer, and the fake clock never lets mocha's timeout fire).
      const sent = mockSequence([...Array.from({ length: 100 }, () => ({ status: 503 })), { status: 201, text: "{}" }]);
      return release().then(
        () => assert.fail("should have rejected"),
        (err: any) => {
          assert.strictEqual(err.message, "Server busy, try again later.");
          assert.strictEqual(err.statusCode, 503);
          const waited = waits.reduce((a, b) => a + b, 0);
          assert.ok(waited <= 5 * 60 * 1000, `waited ${waited}ms`);
          assert.ok(waited > 4 * 60 * 1000, `kept trying for most of the budget (${waited}ms)`);
          assert.strictEqual(sent.length, waits.length + 1);
        }
      );
    });

    it("a Retry-After past the budget gives up at once rather than waiting it out", () => {
      const sent = mockSequence([{ status: 503, header: { "retry-after": "600" } }, { status: 201, text: "{}" }]);
      return release().then(
        () => assert.fail("should have rejected"),
        (err: any) => {
          assert.strictEqual(err.message, "Server busy, try again later.");
          assert.strictEqual(sent.length, 1);
          assert.deepStrictEqual(waits, []);
        }
      );
    });

    it("other failures are not retried", () => {
      const sent = mockSequence([{ status: 500, text: JSON.stringify({ message: "boom" }) }, { status: 201, text: "{}" }]);
      return release().then(
        () => assert.fail("should have rejected"),
        (err: any) => {
          assert.strictEqual(sent.length, 1);
          assert.strictEqual(err.statusCode, 500);
        }
      );
    });
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

  // Every user-supplied name is one encoded path segment, so a "#", "?", "%" or "/" in it can never cut the
  // path short or address a different resource.
  const awkward = "a#b%c?d/e fé";
  const enc = encodeURIComponent(awkward);

  const pathCases: [string, (m: AccountManager) => any, string][] = [
    ["getAccessKey", (m) => m.getAccessKey(awkward), `/accessKeys/${enc}`],
    ["patchAccessKey", (m) => m.patchAccessKey(awkward, "new"), `/accessKeys/${enc}`],
    ["removeAccessKey", (m) => m.removeAccessKey(awkward), `/accessKeys/${enc}`],
    ["removeSession", (m) => m.removeSession(awkward), `/sessions/${enc}`],
    ["updateWebhook", (m) => m.updateWebhook(awkward, {}), `/webhooks/${enc}`],
    ["removeWebhook", (m) => m.removeWebhook(awkward), `/webhooks/${enc}`],
    ["getApp", (m) => m.getApp(awkward), `/apps/${enc}`],
    ["removeApp", (m) => m.removeApp(awkward), `/apps/${enc}`],
    ["renameApp", (m) => m.renameApp(awkward, "new"), `/apps/${enc}`],
    ["setAppPublicKey", (m) => m.setAppPublicKey(awkward, "key"), `/apps/${enc}`],
    ["transferApp", (m) => m.transferApp(awkward, awkward), `/apps/${enc}/transfer/${enc}`],
    ["getCollaborators", (m) => m.getCollaborators(awkward), `/apps/${enc}/collaborators`],
    ["addCollaborator", (m) => m.addCollaborator(awkward, awkward), `/apps/${enc}/collaborators/${enc}`],
    ["removeCollaborator", (m) => m.removeCollaborator(awkward, awkward), `/apps/${enc}/collaborators/${enc}`],
    ["addDeployment", (m) => m.addDeployment(awkward, "Staging"), `/apps/${enc}/deployments/`],
    ["getDeployments", (m) => m.getDeployments(awkward), `/apps/${enc}/deployments/`],
    ["clearDeploymentHistory", (m) => m.clearDeploymentHistory(awkward, awkward), `/apps/${enc}/deployments/${enc}/history`],
    ["getDeployment", (m) => m.getDeployment(awkward, awkward), `/apps/${enc}/deployments/${enc}`],
    ["renameDeployment", (m) => m.renameDeployment(awkward, awkward, "new"), `/apps/${enc}/deployments/${enc}`],
    ["removeDeployment", (m) => m.removeDeployment(awkward, awkward), `/apps/${enc}/deployments/${enc}`],
    ["getAutoRollbackConfig", (m) => m.getAutoRollbackConfig(awkward, awkward), `/apps/${enc}/deployments/${enc}/auto-rollback`],
    [
      "setAutoRollbackConfig",
      (m) => m.setAutoRollbackConfig(awkward, awkward, { enabled: true, errorRateThreshold: 5, minDevices: 10 }),
      `/apps/${enc}/deployments/${enc}/auto-rollback`,
    ],
    ["deleteAutoRollbackConfig", (m) => m.deleteAutoRollbackConfig(awkward, awkward), `/apps/${enc}/deployments/${enc}/auto-rollback`],
    ["getDeploymentMetrics", (m) => m.getDeploymentMetrics(awkward, awkward), `/apps/${enc}/deployments/${enc}/metrics`],
    ["getDeploymentHistory", (m) => m.getDeploymentHistory(awkward, awkward), `/apps/${enc}/deployments/${enc}/history`],
    ["patchRelease", (m) => m.patchRelease(awkward, awkward, "v1", {}), `/apps/${enc}/deployments/${enc}/release`],
    ["promote", (m) => m.promote(awkward, awkward, awkward, {}), `/apps/${enc}/deployments/${enc}/promote/${enc}`],
    ["rollback", (m) => m.rollback(awkward, awkward, awkward), `/apps/${enc}/deployments/${enc}/rollback/${enc}`],
    ["patchExpoRollout", (m) => m.patchExpoRollout(awkward, 25), `/expo/v1/${enc}/release`],
  ];

  it("encodes every name in the request path as exactly one segment", (done: Mocha.Done) => {
    assert.strictEqual(enc, "a%23b%25c%3Fd%2Fe%20f%C3%A9");
    const requested = mockCapture();
    let chain = Q<void>(null);
    pathCases.forEach(([method, call, expected]) => {
      chain = chain.then(() =>
        call(manager).then(() => {
          assert.strictEqual(requested.pop(), "https://api.deploypulse.io" + expected, method);
        })
      );
    });
    chain.done(() => done(), done);
  });

  it("removes Staging#2 itself, not Staging", (done: Mocha.Done) => {
    const requested = mockCapture();
    manager.removeDeployment("my#app", "Staging#2").done(() => {
      assert.deepStrictEqual(requested, ["https://api.deploypulse.io/apps/my%23app/deployments/Staging%232"]);
      done();
    }, done);
  });

  it("leaves plain names as they were", (done: Mocha.Done) => {
    const requested = mockCapture();
    manager
      .promote("MyApp", "Staging", "Production", {})
      .then(() => manager.getAccessKey("ci-key"))
      .done(() => {
        assert.deepStrictEqual(requested, [
          "https://api.deploypulse.io/apps/MyApp/deployments/Staging/promote/Production",
          "https://api.deploypulse.io/accessKeys/ci-key",
        ]);
        done();
      }, done);
  });

  it("refuses a name that is a dot segment before sending anything", (done: Mocha.Done) => {
    const requested = mockCapture();
    const refused = [".", "..", " .. ", "%2e", "%2E%2e"];
    let chain = Q<void>(null);
    refused.forEach((name) => {
      [
        (m: AccountManager) => m.removeDeployment("MyApp", name),
        (m: AccountManager) => m.renameDeployment("MyApp", name, "new"),
        (m: AccountManager) => m.removeApp(name),
        (m: AccountManager) => m.removeCollaborator("MyApp", name),
        (m: AccountManager) => m.rollback("MyApp", "Production", name),
        (m: AccountManager) => m.patchExpoRollout(name, 10),
        (m: AccountManager) => m.release("MyApp", name, "unused", "1.0.0", {}),
      ].forEach((call) => {
        chain = chain.then(() =>
          Q.fcall(() => call(manager)).then(
            () => assert.fail(`expected "${name}" to be refused`),
            (error: any) => {
              assert.ok(/cannot be used in a request URL/.test(error.message), error.message);
              assert.ok(/[Cc]ontact support/.test(error.message), error.message);
            }
          )
        );
      });
    });
    chain.done(() => {
      assert.deepStrictEqual(requested, []);
      done();
    }, done);
  });

  // FINC-D3: a key named "." or ".." cannot be addressed in the path, so it is revoked by id instead.
  it("removes an access key whose name is a dot segment by id", (done: Mocha.Done) => {
    const requested: string[] = [];
    require("superagent-mock")(request, [
      {
        pattern: "https://api.deploypulse.io/(.*)",
        fixtures: function (match: any): any {
          requested.push(match[0]);
          const body = {
            accessKeys: [
              { id: "sess-1", friendlyName: "..", isSession: true },
              { id: "key-id/1", friendlyName: "..", isSession: false },
              { id: "key-2", friendlyName: ".", isSession: false },
            ],
          };
          return { text: JSON.stringify(body), status: 200, ok: true, header: {}, headers: {} };
        },
        callback: (match: any, data: any): any => data,
      },
    ]);
    manager
      .removeAccessKey("..")
      .then(() => manager.removeAccessKey("."))
      .done(() => {
        assert.deepStrictEqual(requested, [
          "https://api.deploypulse.io/accessKeys",
          "https://api.deploypulse.io/accessKeys?id=key-id%2F1",
          "https://api.deploypulse.io/accessKeys",
          "https://api.deploypulse.io/accessKeys?id=key-2",
        ]);
        done();
      }, done);
  });

  // Sessions are the machine's hostname, with the login IPs alongside. Servers since 2026-10 send the
  // hostname as createdBy and the IP as createdByIp; older ones sent the IP as createdBy.
  it("groups sessions by machine name and collects their login IPs", (done: Mocha.Done) => {
    const later = Date.now() + 60 * 60 * 1000;
    mockReturn(
      JSON.stringify({
        accessKeys: [
          { isSession: true, expires: later, createdTime: 1, createdBy: "mbp.local", createdByIp: "203.0.113.7", machineName: "mbp.local" },
          { isSession: true, expires: later, createdTime: 5, createdBy: "mbp.local", createdByIp: "198.51.100.4", machineName: "mbp.local" },
          { isSession: true, expires: later, createdTime: 2, createdBy: "192.0.2.9", machineName: "ci-box" }, // an older server
          { isSession: true, expires: later, createdTime: 3, createdBy: "192.0.2.10" }, // a session with no machine name
          { isSession: false, expires: later, createdTime: 4, createdBy: "laptop" },
          { isSession: true, expires: 1, createdTime: 1, createdBy: "gone", machineName: "gone" }, // expired
        ],
      }),
      200
    );
    manager.getSessions().done((sessions) => {
      assert.deepStrictEqual(sessions, [
        { machineName: "mbp.local", loggedInTime: 5, ips: ["203.0.113.7", "198.51.100.4"] },
        { machineName: "ci-box", loggedInTime: 2, ips: ["192.0.2.9"] },
        { machineName: "192.0.2.10", loggedInTime: 3, ips: [] },
      ]);
      done();
    }, done);
  });

  it("refuses to remove a dot-segment access key that does not exist", (done: Mocha.Done) => {
    mockReturn(JSON.stringify({ accessKeys: [{ id: "k", friendlyName: "other", isSession: false }] }), 200);
    manager.removeAccessKey("..").done(
      () => done(new Error("expected a not-found error")),
      (error: any) => {
        assert.strictEqual(error.statusCode, 404);
        assert.ok(/does not exist/.test(error.message), error.message);
        done();
      }
    );
  });

  it("allows names that only contain dots", (done: Mocha.Done) => {
    const requested = mockCapture();
    manager
      .removeDeployment("MyApp", "...")
      .then(() => manager.removeDeployment("MyApp", ".a"))
      .then(() => manager.removeDeployment("MyApp", "a."))
      .done(() => {
        assert.deepStrictEqual(requested, [
          "https://api.deploypulse.io/apps/MyApp/deployments/...",
          "https://api.deploypulse.io/apps/MyApp/deployments/.a",
          "https://api.deploypulse.io/apps/MyApp/deployments/a.",
        ]);
        done();
      }, done);
  });

  describe("release when the package cannot be prepared", function () {
    // A release that never settles is the failure being guarded: node exits 0 with no output and CI
    // goes green with nothing released. A short timeout turns a hang into a test failure.
    this.timeout(5000);

    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const realCreateWriteStream = fs.createWriteStream;
    const startDir = process.cwd();
    let workDir: string;

    beforeEach(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpctl-release-"));
    });

    afterEach(() => {
      process.chdir(startDir);
      fs.createWriteStream = realCreateWriteStream;
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    function expectRejection(promise: Q.Promise<void>, pattern: RegExp, requested: string[], done: Mocha.Done): void {
      promise.done(
        () => done(new Error("release resolved, but the package was never built")),
        (error: any) => {
          try {
            assert.match(error.message, pattern);
            assert.deepStrictEqual(requested, [], "nothing should be uploaded");
            done();
          } catch (e) {
            done(e);
          }
        }
      );
    }

    // Every temp zip lands in a directory that does not exist, as a full disk or a read-only working
    // directory would make it fail.
    function failZipWrites(): void {
      fs.createWriteStream = (name: string, ...rest: any[]) => realCreateWriteStream(path.join(workDir, "missing", name), ...rest);
    }

    it("rejects when the zip of a directory cannot be written", (done: Mocha.Done) => {
      const bundleDir = path.join(workDir, "bundle");
      fs.mkdirSync(bundleDir);
      fs.writeFileSync(path.join(bundleDir, "index.bundle"), "console.log(1);");
      const requested = mockCapture();
      failZipWrites();

      expectRejection(
        manager.release("MyApp", "Staging", bundleDir, "1.0.0", {}),
        /^Could not prepare the release package from ".*bundle": ENOENT/,
        requested,
        done
      );
    });

    it("rejects when the signed zip of a single file cannot be written", (done: Mocha.Done) => {
      const bundleFile = path.join(workDir, "index.bundle");
      fs.writeFileSync(bundleFile, "console.log(1);");
      const requested = mockCapture();
      failZipWrites();

      expectRejection(
        manager.release("MyApp", "Staging", bundleFile, "1.0.0", {}, undefined, "header.payload.signature"),
        /^Could not prepare the release package from ".*index\.bundle": ENOENT/,
        requested,
        done
      );
    });

    it("rejects when the package path does not exist", (done: Mocha.Done) => {
      const requested = mockCapture();

      expectRejection(
        manager.release("MyApp", "Staging", path.join(workDir, "nope"), "1.0.0", {}),
        /^Could not prepare the release package from ".*nope": ENOENT/,
        requested,
        done
      );
    });

    it("rejects when a file in the directory cannot be read into the zip", (done: Mocha.Done) => {
      // A dangling symlink is listed by the directory walk but fails yazl's stat, which yazl reports
      // on the ZipFile rather than its output stream.
      const bundleDir = path.join(workDir, "bundle");
      fs.mkdirSync(bundleDir);
      fs.symlinkSync(path.join(workDir, "gone"), path.join(bundleDir, "index.bundle"));
      const requested = mockCapture();
      process.chdir(workDir);

      expectRejection(
        manager.release("MyApp", "Staging", bundleDir, "1.0.0", {}),
        /^Could not prepare the release package from ".*bundle": ENOENT/,
        requested,
        (error?: any) => {
          if (!error) {
            assert.deepStrictEqual(
              fs.readdirSync(workDir).filter((name: string) => name.endsWith(".zip")),
              [],
              "the partial temp zip should be removed"
            );
          }
          done(error);
        }
      );
    });
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

function mockCapture(): string[] {
  const requested: string[] = [];
  const body = { accessKey: { friendlyName: "k" }, app: {}, deployment: {}, deployments: [], collaborators: {}, history: [] };
  require("superagent-mock")(request, [
    {
      pattern: "https://api.deploypulse.io/(.*)",
      fixtures: function (match: any): any {
        requested.push(match[0]);
        return { text: JSON.stringify(body), status: 200, ok: true, header: {}, headers: {} };
      },
      callback: function (match: any, data: any): any {
        return data;
      },
    },
  ]);
  return requested;
}

/** Answers each request with the next response in `responses`; returns the URLs requested. */
function mockSequence(responses: Array<{ status: number; text?: string; header?: Record<string, string> }>): string[] {
  const requested: string[] = [];
  require("superagent-mock")(request, [
    {
      pattern: "https://api.deploypulse.io/(.*)",
      fixtures: function (match: any): any {
        requested.push(match[0]);
        const next = responses[Math.min(requested.length, responses.length) - 1];
        return { text: next.text ?? "", status: next.status, ok: next.status >= 200 && next.status < 300, header: next.header ?? {}, headers: {} };
      },
      callback: function (match: any, data: any): any {
        return data;
      },
    },
  ]);
  return requested;
}
