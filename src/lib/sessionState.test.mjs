import test from "node:test";
import assert from "node:assert/strict";
import { deriveSessionView, endedReason, errorMessage } from "./sessionState.ts";

const LAB = "lab-a";
const OTHER = "lab-b";

function session(id, labId, status, extra = {}) {
  return { _id: id, labId, status, ...extra };
}

function view(sessions, overrides = {}) {
  return deriveSessionView({
    sessions,
    labId: LAB,
    requested: false,
    inFlight: false,
    pendingId: null,
    requestError: null,
    ...overrides,
  });
}

test("loading until sessions and the scenario are known", () => {
  assert.equal(view(undefined).phase, "loading");
  assert.equal(view([], { labId: null }).phase, "loading");
  assert.equal(view(undefined).shouldRequest, false);
});

test("first open with no session for this scenario requests one", () => {
  const result = view([session("s0", OTHER, "stopped")]);
  assert.equal(result.phase, "requesting");
  assert.equal(result.shouldRequest, true);
});

test("never requests twice in one open", () => {
  const result = view([], { requested: true });
  assert.equal(result.shouldRequest, false);
  assert.equal(result.phase, "idle");
});

test("a request in flight, or whose session has not appeared yet, reads as requesting", () => {
  assert.equal(view([], { requested: true, inFlight: true }).phase, "requesting");
  const old = session("s1", LAB, "stopped");
  const pending = view([old], { requested: true, pendingId: "s2" });
  assert.equal(pending.phase, "requesting");
  assert.equal(pending.shouldRequest, false);
  const arrived = view([session("s2", LAB, "requested"), old], { requested: true, pendingId: "s2" });
  assert.equal(arrived.phase, "live");
  assert.equal(arrived.live._id, "s2");
});

test("the newest session for this scenario wins whatever its status", () => {
  const sessions = [session("new", LAB, "running", { workspaceUrl: "http://ws" }), session("old", LAB, "stopped")];
  const result = view(sessions);
  assert.equal(result.phase, "live");
  assert.equal(result.latest._id, "new");
  assert.equal(result.usable, true);
  assert.equal(result.shouldRequest, false);
});

test("usable only once running with a workspace URL", () => {
  assert.equal(view([session("s", LAB, "starting")]).usable, false);
  assert.equal(view([session("s", LAB, "running")]).usable, false);
  assert.equal(view([session("s", LAB, "stopping", { workspaceUrl: "http://ws" })]).usable, false);
  assert.equal(view([session("s", LAB, "passed", { workspaceUrl: "http://ws" })]).usable, true);
});

for (const status of ["stopped", "errored", "expired"]) {
  test(`a ${status} session shows the ended state and is not re-requested`, () => {
    const result = view([session("s", LAB, status, { stopReason: "why" })]);
    assert.equal(result.phase, "ended");
    assert.equal(result.ended._id, "s");
    assert.equal(result.live, null);
    assert.equal(result.shouldRequest, false);
    assert.match(result.endedReason, /why/);
  });
}

test("after Stop the page does not request again (stopping → stopped)", () => {
  const stopping = view([session("s", LAB, "stopping")], { requested: true, pendingId: "s" });
  assert.equal(stopping.phase, "live");
  const stopped = view([session("s", LAB, "stopped")], { requested: true, pendingId: "s" });
  assert.equal(stopped.phase, "ended");
  assert.equal(stopped.shouldRequest, false);
});

test("an active session elsewhere blocks, and the request follows once it is stopped", () => {
  const blocked = view([session("x", OTHER, "running")]);
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.blocking._id, "x");
  assert.equal(blocked.shouldRequest, false);
  const freed = view([session("x", OTHER, "stopped")]);
  assert.equal(freed.shouldRequest, true);
});

test("a request error applies until a newer session appears", () => {
  const error = { message: "Session limit reached", latestId: null };
  const failed = view([], { requested: true, requestError: error });
  assert.equal(failed.phase, "request-error");
  assert.equal(failed.requestError, "Session limit reached");
  const later = view([session("s", LAB, "running")], { requested: true, requestError: error });
  assert.equal(later.phase, "live");
  assert.equal(later.requestError, null);
  const endedLater = view([session("s", LAB, "stopped")], { requested: true, requestError: error });
  assert.equal(endedLater.phase, "ended");
});

test("a live session outranks a blocking one and a stale error", () => {
  const result = view([session("s", LAB, "running"), session("x", OTHER, "running")], {
    requestError: { message: "boom", latestId: "s" },
  });
  assert.equal(result.phase, "live");
});

test("endedReason wording", () => {
  assert.equal(endedReason({ status: "expired", stopReason: "Session TTL expired" }), "This session expired: Session TTL expired");
  assert.equal(endedReason({ status: "errored", lastCheckSummary: "pod failed" }), "This session failed: pod failed");
  assert.equal(endedReason({ status: "stopped" }), "This session was stopped.");
});

test("errorMessage keeps the message of a Convex server error", () => {
  const convex = new Error(
    "[CONVEX M(sessions:request)] [Request ID: abc] Server Error\nUncaught Error: Session limit reached (3 active sessions)\n    at handler (../convex/sessions.ts:1:1)"
  );
  assert.equal(errorMessage(convex), "Session limit reached (3 active sessions)");
  assert.equal(errorMessage(new Error("plain")), "plain");
  assert.equal(errorMessage("text"), "text");
});
