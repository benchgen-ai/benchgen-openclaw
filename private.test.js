// Tests for the private data guard (private.js).

import { test } from "node:test";
import assert from "node:assert/strict";

import { privateAccessHit, resolvePrivateData } from "./private.js";

const PLATFORM = "agent:main:benchgen:direct:conv-42";
const TEAM_GROUP = "agent:main:telegram:group:-1003910747757";
const STRANGER_DM = "agent:main:telegram:direct:999";
const GUARD = { paths: ["/data/repos"], allowSessions: ["-1003910747757", "agent:main:main"] };

function withEnv(vars, fn) {
  const keys = ["BENCHGEN_PRIVATE_PATHS", "BENCHGEN_PRIVATE_ALLOW_SESSIONS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("no paths configured: the guard is off", () => {
  withEnv({}, () => {
    const guard = resolvePrivateData({});
    assert.deepEqual(guard, { paths: [], allowSessions: [] });
    assert.equal(privateAccessHit({ sessionKey: PLATFORM, params: { command: "cat /data/repos/x" } }, guard), null);
  });
});

test("platform chat is blocked from a private path, in exec and in file tools", () => {
  assert.equal(
    privateAccessHit({ sessionKey: PLATFORM, params: { command: "cat /data/repos/company/ops/weekly-focus.md" } }, GUARD),
    "/data/repos",
  );
  assert.equal(
    privateAccessHit({ sessionKey: PLATFORM, params: { path: "/data/repos/company/strategy/plan.md" } }, GUARD),
    "/data/repos",
  );
});

test("an allowed session (team group, main) reads the same path", () => {
  const params = { command: "cat /data/repos/company/ops/weekly-focus.md" };
  assert.equal(privateAccessHit({ sessionKey: TEAM_GROUP, params }, GUARD), null);
  assert.equal(privateAccessHit({ sessionKey: "agent:main:main", params }, GUARD), null);
});

test("deny by default: a stranger's Telegram DM and a missing session key are blocked", () => {
  const params = { command: "ls /data/repos" };
  assert.equal(privateAccessHit({ sessionKey: STRANGER_DM, params }, GUARD), "/data/repos");
  assert.equal(privateAccessHit({ sessionKey: undefined, params }, GUARD), "/data/repos");
});

test("calls that do not touch a private path pass everywhere", () => {
  assert.equal(privateAccessHit({ sessionKey: PLATFORM, params: { command: "ls /data/workspace/skills" } }, GUARD), null);
  assert.equal(privateAccessHit({ sessionKey: PLATFORM, params: undefined }, GUARD), null);
});

test("trivial spellings of the path still match", () => {
  for (const command of ["cat /data//repos/company/x", "cat /data/./repos/company/x", "cd /data/repos/ && ls"]) {
    assert.equal(privateAccessHit({ sessionKey: PLATFORM, params: { command } }, GUARD), "/data/repos", command);
  }
});

test("config wins over env, env is the fallback, trailing slashes are dropped", () => {
  withEnv(
    { BENCHGEN_PRIVATE_PATHS: "/data/repos/, /data/brain", BENCHGEN_PRIVATE_ALLOW_SESSIONS: "-100123, agent:main:main" },
    () => {
      assert.deepEqual(resolvePrivateData({}), {
        paths: ["/data/repos", "/data/brain"],
        allowSessions: ["-100123", "agent:main:main"],
      });
      assert.deepEqual(resolvePrivateData({ privateData: { paths: ["/srv/x/"], allowSessions: ["owner"] } }), {
        paths: ["/srv/x"],
        allowSessions: ["owner"],
      });
    },
  );
});
