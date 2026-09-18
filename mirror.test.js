// Tests for the trace mirror config (mirror.js): where the second target comes
// from, when it is refused, and how it is described.

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeMirror, resolveMirrorConfig } from "./mirror.js";

const PRIMARY = { publicKey: "pk-dev", baseUrl: "https://traces.dev.example" };
const ENV_KEYS = [
  "BENCHGEN_MIRROR_PUBLIC_KEY",
  "BENCHGEN_MIRROR_SECRET_KEY",
  "BENCHGEN_MIRROR_BASE_URL",
  "BENCHGEN_MIRROR_ENVIRONMENT",
];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("no mirror anywhere: quietly off", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig({}, { primary: PRIMARY });
    assert.equal(m.enabled, false);
    assert.equal(m.reason, "not configured");
    assert.equal(describeMirror(m), "off");
  });
});

test("config keys enable the mirror and inherit the primary baseUrl", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig(
      { mirror: { publicKey: "pk-prod", secretKey: "sk-prod" } },
      { primary: PRIMARY },
    );
    assert.equal(m.enabled, true);
    assert.equal(m.publicKey, "pk-prod");
    assert.equal(m.secretKey, "sk-prod");
    assert.equal(m.baseUrl, PRIMARY.baseUrl);
    assert.equal(m.environment, undefined);
    assert.equal(describeMirror(m), "https://traces.dev.example (pk-prod)");
  });
});

test("own baseUrl and environment are honoured and described", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig(
      {
        mirror: {
          publicKey: "pk-prod",
          secretKey: "sk-prod",
          baseUrl: "https://traces.benchgen.com/",
          environment: "dev",
        },
      },
      { primary: PRIMARY },
    );
    assert.equal(m.enabled, true);
    assert.equal(m.baseUrl, "https://traces.benchgen.com/");
    assert.equal(m.environment, "dev");
    assert.equal(describeMirror(m), "https://traces.benchgen.com/ (pk-prod, environment dev)");
  });
});

test("environment variables are the fallback, config wins over them", () => {
  withEnv(
    {
      BENCHGEN_MIRROR_PUBLIC_KEY: "pk-env",
      BENCHGEN_MIRROR_SECRET_KEY: "sk-env",
      BENCHGEN_MIRROR_BASE_URL: "https://traces.env.example",
      BENCHGEN_MIRROR_ENVIRONMENT: "dev",
    },
    () => {
      const fromEnv = resolveMirrorConfig({}, { primary: PRIMARY });
      assert.equal(fromEnv.enabled, true);
      assert.deepEqual(
        [fromEnv.publicKey, fromEnv.secretKey, fromEnv.baseUrl, fromEnv.environment],
        ["pk-env", "sk-env", "https://traces.env.example", "dev"],
      );
      const fromConfig = resolveMirrorConfig({ mirror: { publicKey: "pk-cfg" } }, { primary: PRIMARY });
      assert.equal(fromConfig.publicKey, "pk-cfg");
      assert.equal(fromConfig.secretKey, "sk-env");
    },
  );
});

test("half a key pair is refused with a reason", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig({ mirror: { publicKey: "pk-prod" } }, { primary: PRIMARY });
    assert.equal(m.enabled, false);
    assert.match(m.reason, /both publicKey and secretKey/);
    assert.equal(describeMirror(m), `off (${m.reason})`);
  });
});

test("mirror.enabled === false switches it off even with keys", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig(
      { mirror: { enabled: false, publicKey: "pk-prod", secretKey: "sk-prod" } },
      { primary: PRIMARY },
    );
    assert.equal(m.enabled, false);
    assert.match(m.reason, /disabled via config/);
  });
});

test("a mirror that is the primary project is refused (trailing slash ignored)", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig(
      { mirror: { publicKey: "pk-dev", secretKey: "sk-dev", baseUrl: `${PRIMARY.baseUrl}/` } },
      { primary: PRIMARY },
    );
    assert.equal(m.enabled, false);
    assert.match(m.reason, /primary project/);
    // Same key on a different endpoint is a different project: allowed.
    const other = resolveMirrorConfig(
      { mirror: { publicKey: "pk-dev", secretKey: "sk-dev", baseUrl: "https://traces.benchgen.com" } },
      { primary: PRIMARY },
    );
    assert.equal(other.enabled, true);
  });
});

test("no baseUrl at all is refused", () => {
  withEnv({}, () => {
    const m = resolveMirrorConfig({ mirror: { publicKey: "pk-prod", secretKey: "sk-prod" } }, {});
    assert.equal(m.enabled, false);
    assert.match(m.reason, /no baseUrl/);
  });
});
